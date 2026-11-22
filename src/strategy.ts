import { riskAtDestinations } from "./arena-threats.js";
import {
  ARMY,
  board,
  distances,
  duel,
  legalActions,
  moves,
  targets,
  type Game,
  type Piece,
  type Action,
  type Seat,
} from "./core.js";
export interface Weights {
  capture: number;
  risk: number;
  flag: number;
  advance: number;
  novelty: number;
  artillery: number;
  carrier: string;
}
export const DEFAULT: Weights = {
  capture: 5,
  risk: 7,
  flag: 5,
  advance: 0.6,
  novelty: 1.8,
  artillery: 1,
  carrier: "10",
};
export function validateWeights(value: unknown): Weights {
  if (!value || typeof value !== "object")
    throw Error("Candidate must be an object");
  const w = value as Weights;
  const keys = [
    "capture",
    "risk",
    "flag",
    "advance",
    "novelty",
    "artillery",
    "carrier",
  ];
  if (Object.keys(value).some((k) => !keys.includes(k)))
    throw Error("Unknown candidate field");
  for (const key of [
    "capture",
    "risk",
    "flag",
    "advance",
    "novelty",
    "artillery",
  ] as const)
    if (
      typeof w[key] !== "number" ||
      !Number.isFinite(w[key]) ||
      w[key] <= 0 ||
      w[key] > 1000
    )
      throw Error("Invalid candidate weight: " + key);
  if (!Object.hasOwn(ARMY, w.carrier)) throw Error("Invalid carrier rank");
  return { ...w };
}
export interface Memory {
  known: Record<string, string>;
  positions: Record<string, string>;
  visits: Record<string, number>;
  lastVersion: number | string;
  lastMoveCount?: number;
}
export const newMemory = (): Memory => ({
  known: {},
  positions: {},
  visits: {},
  lastVersion: -1,
});
const value = (r: string) => (r === "C" ? 4 : r === "1" ? 3 : Number(r) + 1);
export function observe(g: Game, m: Memory) {
  if (g.moveCount < (m.lastMoveCount ?? -1)) return;
  m.lastMoveCount = g.moveCount;
  const version =
    g.ver ??
    JSON.stringify([g.moveCount, g.lastRecruit, g.status, g.promoWait]);
  if (m.lastVersion === version) return;
  const a = g.lastAction;
  if (a?.combat) {
    if (a.pieceId) m.known[a.pieceId] = a.combat.att.rank;
    const defender = Object.entries(m.positions).find(
      ([id, pos]) => id !== a.pieceId && pos === a.to,
    )?.[0];
    if (defender) m.known[defender] = a.combat.def.rank;
  }
  for (const p of g.pieces) {
    if (p.rank) m.known[p.id] = p.rank;
    if (m.positions[p.id] !== p.pos) {
      const k = p.id + "@" + p.pos;
      m.visits[k] = (m.visits[k] || 0) + 1;
    }
    m.positions[p.id] = p.pos;
  }
  // A reveal may be visible only in the last combat after the piece disappears.
  if (a?.combat) {
    for (const q of [a.combat.att, a.combat.def])
      if (q?.id && q.rank) m.known[q.id] = q.rank;
  }
  m.lastVersion = version;
}
export function belief(g: Game, p: Piece, m: Memory): [string, number][] {
  const k = p.rank || m.known[p.id];
  if (k) return [[k, 1]];
  const left = { ...ARMY };
  for (const r of g.graveyard[p.owner] || []) left[r]--;
  for (const q of g.pieces)
    if (q.owner === p.owner && q.id !== p.id) {
      const r = q.rank || m.known[q.id];
      if (r) left[r]--;
    }
  const total = Object.values(left).reduce((n, v) => n + Math.max(0, v), 0);
  return total
    ? Object.entries(left)
        .filter(([, n]) => n > 0)
        .map(([r, n]) => [r, n / total])
    : Object.entries(ARMY).map(([r, n]) => [r, n / 20]);
}
export function decide(
  g: Game,
  m: Memory,
  w: Weights = DEFAULT,
  random = () => 0.5,
  timeBudgetMs = 2000,
): Action | null {
  const deadline = Number.isFinite(timeBudgetMs)
    ? performance.now() + timeBudgetMs
    : Infinity;
  observe(g, m);
  const actions = legalActions(g);
  if (!actions.length) return null;
  if (actions[0].type === "recruit")
    return actions.sort((a, b) => value(b.rank!) - value(a.rank!))[0];
  const B = board(g.mode),
    d = distances(g.mode, B.V),
    occ = Object.fromEntries(g.pieces.map((p) => [p.pos, p]));
  const me = g.turn,
    ownFlag = g.pieces.find((p) => p.flags.includes(me)),
    groundOwn = Object.entries(g.groundFlags).find(([, f]) =>
      f.includes(me),
    )?.[0];
  const goal = ownFlag?.pos || groundOwn || B.flagStart[me],
    toFlag = distances(g.mode, goal);
  // Every unidentified piece of an army has the same remaining rank distribution.
  const unknown = new Map<Seat, [string, number][]>();
  const known = new Map<string, [string, number][]>();
  const ranks = (p: Piece): [string, number][] => {
    const rank = p.rank || m.known[p.id];
    if (rank) {
      let dist = known.get(rank);
      if (!dist) {
        dist = [[rank, 1]];
        known.set(rank, dist);
      }
      return dist;
    }
    let dist = unknown.get(p.owner);
    if (!dist) {
      dist = belief(g, p, m);
      unknown.set(p.owner, dist);
    }
    return dist;
  };
  const byId = Object.fromEntries(g.pieces.map((p) => [p.id, p]));
  const danger = riskAtDestinations(g, occ, ranks);
  let best = actions[0],
    bestScore = -Infinity;
  for (const a of actions) {
    if (deadline !== Infinity && performance.now() > deadline) break;
    const p = byId[a.pieceId!];
    const dest = a.to || a.target!;
    const victim = occ[dest];
    let s = random() * 0.02;
    if (a.type === "fire") {
      s =
        w.artillery *
          (victim
            ? ranks(victim).reduce((n, [r, prob]) => n + value(r) * prob, 0)
            : 0) *
          w.capture -
        value("C");
      if (victim?.flags.includes(victim.owner)) s += 12;
    } else {
      let survival = 1;
      if (victim) {
        survival = 0;
        for (const [rank, prob] of ranks(victim)) {
          const r = duel(p.rank!, rank);
          s +=
            prob *
            w.capture *
            (r > 0
              ? value(rank)
              : r < 0
                ? -value(p.rank!)
                : value(rank) - value(p.rank!));
          if (r > 0) survival += prob;
        }
        if (victim.flags.includes(me)) s += survival * 30;
      }
      const carries = p.flags.includes(me) && !a.dropFlags;
      if (dest === B.V) {
        const flags = victim?.flags.length
          ? victim.flags
          : g.groundFlags[dest]?.length
            ? g.groundFlags[dest]
            : a.dropFlags
              ? []
              : p.flags;
        if (flags?.includes(me)) s += survival * 1e6;
        else if (flags?.some((f) => f !== me && !g.out[f])) s -= 1e6;
      }
      if (carries)
        s += w.flag * ((d[p.pos] ?? 30) - (d[dest] ?? 30)) * survival;
      else if (ownFlag?.owner !== me || groundOwn)
        s += w.flag * 0.5 * ((toFlag[p.pos] ?? 30) - (toFlag[dest] ?? 30));
      else
        s +=
          w.advance *
          ((d[p.pos] ?? 30) - (d[dest] ?? 30)) *
          (value(p.rank!) > 5 ? 1 : 0.5);
      if (a.dropFlags && p.flags.includes(me)) s -= w.flag * 2;
      if (g.groundFlags[dest]?.includes(me)) s += w.flag * 2;
      const maxRisk = danger(dest, p.rank!);
      s -=
        survival * maxRisk * w.risk * (value(p.rank!) / 5 + (carries ? 3 : 0));
      if (dest === B.recruit[me]) s -= g.promo[me] >= 4 ? 5 : 0.3;
      s -= w.novelty * Math.log1p(m.visits[p.id + "@" + dest] || 0);
      if (p.pos === "RING" && !carries) s += 0.2;
    }
    if (s > bestScore) {
      best = a;
      bestScore = s;
    }
  }
  return best;
}
export function setupSwap(
  g: Game,
  seat: Seat,
  w: Weights = DEFAULT,
): Action | null {
  const B = board(g.mode),
    carrier = g.pieces.find(
      (p) => p.owner === seat && p.pos === B.flagStart[seat],
    );
  if (carrier?.rank === w.carrier) return null;
  const p = g.pieces.find((p) => p.owner === seat && p.rank === w.carrier);
  return p && carrier ? { type: "swap", seat, a: p.id, b: carrier.id } : null;
}
