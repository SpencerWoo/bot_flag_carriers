import fs from "node:fs/promises";
import vm from "node:vm";
import { createHash } from "node:crypto";
import ts from "typescript";
import { board, rng, type Action, type Game } from "./core.js";
import {
  DEFAULT,
  decide,
  newMemory,
  observe,
  validateWeights,
  type Weights,
} from "./strategy.js";

export interface ArenaActor {
  choose(view: Game): Action | null;
  setup?(view: Game): string;
  observe?(view: Game): void;
}
export interface ArenaPolicy {
  hash: string;
  create(seed: number, options?: { timeoutMs?: number }): ArenaActor;
}
export const G0_SOURCE = "export default ({ baseline }) => baseline();\n";
const digest = (source: string) =>
  createHash("sha256").update(source).digest("hex");
function baseline(
  random: () => number,
  overrides: Partial<Weights> = {},
): ArenaActor {
  const weights = validateWeights({ ...DEFAULT, ...overrides }),
    memory = newMemory();
  return {
    choose: (v) => decide(v, memory, weights, random, Infinity),
    setup: () => weights.carrier,
    observe: (v) => observe(v, memory),
  };
}
interface Layout {
  V: string;
  seats: string[];
  recruit: Record<string, string>;
  flagStart: Record<string, string>;
  adj: Record<string, string[]>;
  rays: Record<string, string[][]>;
  lake: string[];
  castle: string[];
  camp: Record<string, string | null>;
}
let boardJson: string;
function topology() {
  if (boardJson) return boardJson;
  const layouts: Record<number, Layout> = {};
  for (const mode of [3, 4]) {
    const b = board(mode),
      nodes = [...b.all(), "RING", b.V],
      all = new Set<string>(nodes);
    const adj: Record<string, string[]> = {},
      rays: Record<string, string[][]> = {},
      camp: Record<string, string | null> = {};
    for (const n of nodes) {
      adj[n] = b.nb(n);
      rays[n] = b.rays(n);
      camp[n] = b.camp(n);
      for (const line of rays[n]) for (const x of line) all.add(x);
    }
    layouts[mode] = {
      V: b.V,
      seats: b.seats,
      recruit: b.recruit,
      flagStart: b.flagStart,
      adj,
      rays,
      camp,
      lake: [...all].filter((n) => b.lake(n)),
      castle: [...all].filter((n) => b.castle(n)),
    };
  }
  boardJson = JSON.stringify(layouts);
  return boardJson;
}
// Candidate code receives only realm-local JS values. The private bridge takes
// and returns primitives; no host prototype, raw game, FS handle or timer is supplied.
// The calling worker remains responsible for process limits and a wall-clock timeout.
const contextSetup = `
const runtime = ((host, geometry) => {
  const layouts = JSON.parse(geometry);
  const boards = {},
    distanceCache = new Map(),
    builtins = new WeakMap();
  const freeze = (o) => {
    if (o && typeof o === "object" && !Object.isFrozen(o)) {
      Object.freeze(o);
      for (const key of Object.keys(o)) freeze(o[key]);
    }
    return o;
  };
  for (const [mode, b] of Object.entries(layouts)) {
    const empty = Object.freeze([]);
    freeze(b);
    const lakes = new Set(b.lake),
      castles = new Set(b.castle);
    boards[mode] = Object.freeze({
      V: b.V,
      seats: b.seats,
      recruit: b.recruit,
      flagStart: b.flagStart,
      nb: (n) => b.adj[n] || empty,
      rays: (n) => b.rays[n] || empty,
      lake: (n) => lakes.has(n),
      castle: (n) => castles.has(n),
      camp: (n) => b.camp[n] ?? null,
      all: () => Object.keys(b.adj),
    });
  }
  let active = null;
  const random = () => host("random");
  Math.random = random;
  Object.freeze(Math);
  const call = (op, id, v) => {
    const resp = host(op, id, v === active ? undefined : JSON.stringify(v));
    return resp === undefined ? undefined : JSON.parse(resp);
  };
  const api = Object.freeze({
    random,
    board: (m) => boards[m],
    distances: (mode, to) => {
      const key = mode + ":" + to;
      if (!distanceCache.has(key)) {
        const b = boards[mode],
          d = { [to]: 0 },
          q = [to];
        for (let i = 0; i < q.length; i++)
          for (const n of b.nb(q[i]))
            if (!(n in d)) {
              d[n] = d[q[i]] + 1;
              q.push(n);
            }
        distanceCache.set(key, freeze(d));
      }
      return distanceCache.get(key);
    },
    legalActions: (v) => {
      if (v.promoWait && v.mySeats.includes(v.promoWait.seat))
        return [...new Set(v.graveyard[v.promoWait.seat])].map((rank) => ({
          type: "recruit",
          seat: v.promoWait.seat,
          rank,
        }));
      const out = [];
      if (v.promoWait || v.status !== "playing" || !v.mySeats.includes(v.turn))
        return out;
      for (const [pieceId, m] of Object.entries(v.actions)) {
        for (const to of m.moves || [])
          out.push({ type: "move", seat: v.turn, pieceId, to });
        for (const to of m.dropMoves || [])
          out.push({
            type: "move",
            seat: v.turn,
            pieceId,
            to,
            dropFlags: true,
          });
        for (const target of m.fires || [])
          out.push({ type: "fire", seat: v.turn, pieceId, target });
      }
      return out;
    },
    baseline: (weights = {}) => {
      const id = host("new", 0, JSON.stringify(weights));
      const instance = Object.freeze({
        choose: (v) => call("choose", id, v),
        setup: (v) => call("setup", id, v),
        observe: (v) => call("observe", id, v),
      });
      builtins.set(instance, id);
      return instance;
    },
  });
  return {
    api,
    builtin: (actor) => builtins.get(actor),
    invoke: (player, method, text) => {
      active = freeze(JSON.parse(text));
      try {
        return JSON.stringify(player[method](active));
      } finally {
        active = null;
      }
    },
  };
})(bridge, geometry);
delete globalThis.bridge;
delete globalThis.geometry;
globalThis.Date = undefined;
globalThis.performance = undefined;
globalThis.console = undefined;
`;
export async function loadArenaPolicy(path?: string): Promise<ArenaPolicy> {
  const source = path ? await fs.readFile(path, "utf8") : G0_SOURCE;
  return compileArenaPolicy(source);
}
const builtinHash = digest(G0_SOURCE);
export function compileArenaPolicy(source: string): ArenaPolicy {
  if (Buffer.byteLength(source) > 128 * 1024)
    throw Error("Policy exceeds 128 KiB");
  const hash = digest(source);
  if (hash === builtinHash)
    return { hash, create: (seed) => baseline(rng(seed)) };
  // Transform standard module syntax to a self-contained CommonJS body. External
  // imports are rejected at admission. No module loader exists in the realm.
  const parsed = ts.createSourceFile(
    "policy.mjs",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const walk = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) ||
      ts.isImportEqualsDeclaration(node) ||
      (ts.isExportDeclaration(node) && node.moduleSpecifier) ||
      node.kind === ts.SyntaxKind.ImportKeyword
    )
      throw Error("Policies must be self-contained");
    ts.forEachChild(node, walk);
  };
  walk(parsed);
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      allowJs: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
    fileName: "policy.js",
  }).outputText;
  const script = new vm.Script(
    `"use strict";${contextSetup}
  const actor=(()=>{const exports=Object.create(null); ${compiled}
  return exports.default(runtime.api);})();
  if(!actor||typeof actor.choose!=='function')throw new Error('Policy must implement choose(view)');
  const methods={builtin:runtime.builtin(actor)};for(const name of ['choose','observe','setup']){if(typeof actor[name]==='function')methods[name]=(text)=>runtime.invoke(actor,name,text);}Object.freeze(methods);
  `,
    { filename: "policy-" + hash.slice(0, 12) + ".mjs" },
  );
  return {
    hash,
    create(seed: number, options?: { timeoutMs?: number }) {
      const random = rng(seed),
        baselines: ArenaActor[] = [];
      let current: Game | undefined;
      const bridge = (op: string, index: number, arg?: string) => {
        try {
          if (op === "random") return random();
          if (op === "new") {
            if (baselines.length >= 64) throw Error("Too many baselines");
            baselines.push(baseline(random, JSON.parse(arg || "{}")));
            return baselines.length - 1;
          }
          if (
            !["choose", "observe", "setup"].includes(op) ||
            !Number.isInteger(index) ||
            !baselines[index]
          )
            throw Error("Unknown policy helper");
          const v = arg === undefined ? current : JSON.parse(arg);
          if (!v) throw Error("Expected player view");
          const method = baselines[index][op as keyof ArenaActor]!;
          return JSON.stringify(method(v));
        } catch {
          throw "Invalid baseline invocation";
        }
      };
      Object.setPrototypeOf(bridge, null);
      Object.freeze(bridge);
      const context = vm.createContext(
        { bridge, geometry: topology() },
        { codeGeneration: { strings: false, wasm: false } },
      );
      const methods = script.runInContext(context, { timeout: 1500 }) as Record<
        string,
        (text: string) => string | undefined
      > & { builtin?: number };
      if (typeof methods.builtin === "number")
        return baselines[methods.builtin];
      const timeoutMs = options?.timeoutMs;
      const timed =
        timeoutMs === undefined
          ? undefined
          : new vm.Script("methods[_arenaMethod](_arenaInput)");
      function invoke(name: string, v: Game) {
        current = v;
        try {
          const packed = JSON.stringify(v);
          let result: string | undefined;
          if (timed) {
            context._arenaMethod = name;
            context._arenaInput = packed;
            result = timed.runInContext(context, { timeout: timeoutMs });
          } else result = methods[name](packed);
          return result === undefined ? undefined : JSON.parse(result);
        } finally {
          current = undefined;
        }
      }
      return {
        choose: (v) => invoke("choose", v) ?? null,
        setup: methods.setup ? (v) => invoke("setup", v) : undefined,
        observe: methods.observe
          ? (v) => {
              invoke("observe", v);
            }
          : undefined,
      };
    },
  };
}
