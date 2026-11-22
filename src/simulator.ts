import { arenaPlayerView } from "./arena-view.js";
import {
  ARMY,
  board,
  moves,
  targets,
  duel,
  shuffle,
  rng,
  actionKey,
  type Game,
  type Seat,
  type Piece,
  type Action,
} from "./core.js";
export interface SimState extends Game {
  flagsLast: Record<string, Seat>;
  histories: Record<
    string,
    { piece: string; edges: Record<string, number>; previous?: string }
  >;
  chases: Record<string, { piece: string; target: string; seen: string[] }>;
  pending: Seat[];
  nextTurn: Seat;
  reveal: string[];
  seed: number;
}
const seats = (mode: number): Seat[] =>
  mode === 3 ? ["R", "B", "Y"] : ["R", "B", "Y", "G"];
export function layout(mode: number, seat: Seat): string[] {
  const B = board(mode);
  return B.all().filter(
    (n: string) => B.camp(n) === seat && !B.lake(n) && n !== B.recruit[seat],
  );
}
export function initial(
  mode: number,
  seed: number,
  carriers: Partial<Record<Seat, string>> = {},
): SimState {
  const B = board(mode),
    random = rng(seed),
    ss = seats(mode),
    pieces: Piece[] = [];
  for (const s of ss) {
    const ranks = shuffle(
      Object.entries(ARMY).flatMap(([r, n]) => Array(n).fill(r)),
      random,
    );
    for (const [i, pos] of layout(mode, s).entries())
      pieces.push({ id: s + i, owner: s, rank: ranks[i], pos, flags: [] });
    const carrier = pieces.find(
        (p) => p.owner === s && p.pos === B.flagStart[s],
      )!,
      preferred = pieces.find(
        (p) => p.owner === s && p.rank === (carriers[s] || "10"),
      )!;
    [carrier.rank, preferred.rank] = [preferred.rank, carrier.rank];
    carrier.flags = [s];
  }
  return {
    id: "local-" + seed,
    mode,
    status: "playing",
    turn: ss[0],
    pieces,
    groundFlags: {},
    actions: {},
    mySeats: ss,
    graveyard: Object.fromEntries(ss.map((s) => [s, []])) as any,
    promo: Object.fromEntries(ss.map((s) => [s, 0])) as any,
    out: {},
    flagsLast: Object.fromEntries(ss.map((s) => [s, s])),
    histories: {},
    chases: {},
    pending: [],
    nextTurn: ss[1],
    reveal: [],
    seed,
    moveCount: 0,
    movesSinceCapture: 0,
    ver: 0,
    results: null,
    winner: null,
  };
}
const edge = (a: string, b: string) => [a, b].sort().join("|");
// Enumerate paths for the edge-based two-square restriction. Alternative cavalier routes are legal if any route passes.
function paths(
  g: SimState,
  p: Piece,
  to: string,
  drop: boolean,
  occupancy?: Record<string, Piece>,
): string[][] {
  const B = board(g.mode),
    occ = occupancy || Object.fromEntries(g.pieces.map((p) => [p.pos, p]));
  if (
    (!p.flags.length || drop) &&
    p.rank === "2" &&
    p.pos !== "RING" &&
    p.pos !== B.V
  ) {
    const out: string[][] = [];
    for (const ray of B.rays(p.pos)) {
      const path = [p.pos];
      for (const n of ray) {
        const x = B.castle(n) ? "RING" : n;
        path.push(x);
        if (x === to) {
          out.push(path);
          break;
        }
        if (
          B.lake(n) ||
          occ[x] ||
          (g.groundFlags[x] || []).length ||
          B.castle(n)
        )
          break;
      }
    }
    return out;
  }
  const out: string[][] = [];
  for (const n of B.nb(p.pos)) {
    if (n === to) out.push([p.pos, n]);
    if (
      p.rank === "6" &&
      (!p.flags.length || drop) &&
      !occ[n] &&
      !(g.groundFlags[n] || []).length &&
      n !== "RING" &&
      n !== B.V
    )
      for (const n2 of B.nb(n))
        if (n2 === to && n2 !== B.V) out.push([p.pos, n, n2]);
  }
  return out;
}
function permittedPath(
  g: SimState,
  p: Piece,
  to: string,
  drop: boolean,
  occupancy?: Record<string, Piece>,
): string[] | undefined {
  const h = g.histories[p.owner];
  return paths(g, p, to, drop, occupancy).find((path) =>
    path
      .slice(1)
      .every(
        (n, i) =>
          !h || h.piece !== p.id || (h.edges[edge(path[i], n)] || 0) < 3,
      ),
  );
}
const actionCache = new WeakMap<
  SimState,
  { version: number; seat: Seat; value: Record<string, any> }
>();
export function simActions(
  g: SimState,
  seat: Seat = g.turn,
): Record<string, any> {
  if (g.status !== "playing" || g.promoWait) return {};
  const cached = actionCache.get(g);
  if (cached && cached.version === g.ver && cached.seat === seat)
    return cached.value;
  const B = board(g.mode),
    occ = Object.fromEntries(g.pieces.map((p) => [p.pos, p])),
    out: Record<string, any> = {};
  for (const p of g.pieces.filter((p) => p.owner === seat)) {
    const a: any = { moves: [], fires: [], blocked: {} };
    for (const drop of p.flags.length ? [false, true] : [false]) {
      const key = drop ? "dropMoves" : "moves";
      a[key] = [];
      if (drop) a.dropBlocked = {};
      for (const m of moves(B, occ, g.groundFlags, p.pos, p, drop)) {
        // Edge histories only restrict the same piece on successive turns.
        const path =
            g.histories[seat]?.piece !== p.id ||
            permittedPath(g, p, m.to, drop, occ),
          ch = g.chases[seat],
          t = ch && g.pieces.find((q) => q.id === ch.target);
        const chaseBlocked =
          ch?.piece === p.id &&
          t &&
          ch.seen.includes(m.to + "|" + t.pos) &&
          g.histories[seat]?.previous !== m.to;
        if (path && !chaseBlocked) a[key].push(m.to);
        else
          (drop ? a.dropBlocked : a.blocked)[m.to] = path
            ? "More-squares rule violation"
            : "2-square rule violation";
      }
    }
    if (p.rank === "C") a.fires = targets(B, occ, g.groundFlags, p.pos);
    if (a.moves.length || a.fires.length || (a.dropMoves || []).length)
      out[p.id] = a;
  }
  actionCache.set(g, { version: g.ver, seat, value: out });
  return out;
}
export function view(g: SimState, seat: Seat): Game {
  return arenaPlayerView(g, seat);
}
function drop(g: SimState, pos: string, flags: Seat[]) {
  if (flags.length) (g.groundFlags[pos] ??= []).push(...flags);
}
function remove(g: SimState, p: Piece) {
  drop(g, p.pos, p.flags);
  g.graveyard[p.owner].push(p.rank!);
  g.pieces = g.pieces.filter((q) => q.id !== p.id);
  g.movesSinceCapture = 0;
}
function recruit(g: SimState, s: Seat) {
  const B = board(g.mode);
  if (
    g.graveyard[s].length &&
    !g.pieces.some((p) => p.pos === B.recruit[s]) &&
    !g.out[s]
  )
    g.pending.push(s);
}
function point(g: SimState, s: Seat) {
  g.promo[s]++;
  if (g.promo[s] >= 6) {
    g.promo[s] = 0;
    recruit(g, s);
  }
}
function collect(g: SimState, p: Piece, from: string) {
  const ground = g.groundFlags[p.pos] || [];
  if (!ground.length) return;
  const f = ground.shift()!;
  if (p.flags.length) drop(g, from, p.flags);
  p.flags = [f];
  if (!ground.length) delete g.groundFlags[p.pos];
  if (f !== p.owner && g.flagsLast[f] === f && !g.out[f]) recruit(g, p.owner);
  g.flagsLast[f] = p.owner;
}
function result(g: SimState, winner: Seat | null, reason: string) {
  g.status = "finished";
  g.winner = winner;
  g.endReason = reason;
  g.results = Object.fromEntries(
    seats(g.mode).map((s) => [
      s,
      winner ? (s === winner ? "W" : "L") : g.out[s] ? "L" : "D",
    ]),
  );
  g.promoWait = null;
}
function finish(g: SimState) {
  const B = board(g.mode),
    center = g.pieces.find((p) => p.pos === B.V),
    f = center?.flags.find((f) => !g.out[f]);
  if (f) {
    result(g, f, "flag");
    return;
  }
  for (const s of seats(g.mode))
    if (!g.out[s] && !g.pieces.some((p) => p.owner === s))
      g.out[s] = "no pieces";
  const active = seats(g.mode).filter((s) => !g.out[s]);
  if (active.length === 1) {
    result(g, active[0], "last army");
    return;
  }
  if (!active.length) {
    result(g, null, "no armies");
    return;
  }
  if (g.movesSinceCapture >= 300) {
    result(g, null, "no capture");
    return;
  }
  while (g.pending.length) {
    const s = g.pending.shift()!;
    if (
      !g.out[s] &&
      g.graveyard[s].length &&
      !g.pieces.some((p) => p.pos === B.recruit[s])
    ) {
      g.promoWait = {
        seat: s,
        deadline: Infinity,
        remainingMs: 30000,
        reason: "local",
      };
      return;
    }
  }
  g.promoWait = null;
  const order = seats(g.mode);
  let i = order.indexOf(g.nextTurn);
  for (let n = 0; n < order.length; n++, i = (i + 1) % order.length) {
    const s = order[i];
    if (g.out[s]) continue;
    g.turn = s;
    if (Object.keys(simActions(g, s)).length) return;
    g.out[s] = "no legal moves";
  }
  const last = order.filter((s) => !g.out[s]);
  result(g, last.length === 1 ? last[0] : null, "no legal moves");
}
export function step(g: SimState, a: Action): void {
  if (g.status !== "playing") throw Error("Game finished");
  if (a.type === "recruit") {
    if (g.promoWait?.seat !== a.seat) throw Error("Not reinforcement seat");
    const idx = g.graveyard[a.seat].indexOf(a.rank!);
    if (idx < 0) throw Error("Unavailable reinforcement");
    g.graveyard[a.seat].splice(idx, 1);
    const id = a.seat + "recruit" + g.ver;
    g.pieces.push({
      id,
      owner: a.seat,
      rank: a.rank!,
      pos: board(g.mode).recruit[a.seat],
      flags: [],
    });
    g.reveal = [id];
    g.promoWait = null;
    g.ver++;
    finish(g);
    return;
  }
  if (a.seat !== g.turn || g.promoWait) throw Error("Not turn");
  const p = g.pieces.find((p) => p.id === a.pieceId);
  if (!p) throw Error("Missing piece");
  const acts = simActions(g)[p.id];
  if (
    !acts ||
    (a.type === "fire"
      ? !acts.fires.includes(a.target)
      : !(a.dropFlags ? acts.dropMoves : acts.moves)?.includes(a.to))
  )
    throw Error("Illegal action " + actionKey(a));
  g.reveal = [];
  if (g.clock) g.clock.turnElapsed = 0;
  g.movesSinceCapture++;
  const from = p.pos,
    oldFlags = [...p.flags];
  g.nextTurn = seats(g.mode)[
    (seats(g.mode).indexOf(g.turn) + 1) % seats(g.mode).length
  ];
  const path =
    a.type === "move" ? permittedPath(g, p, a.to!, !!a.dropFlags)! : [];
  if (a.dropFlags) {
    drop(g, from, p.flags);
    p.flags = [];
  }
  const victim = g.pieces.find((q) => q.pos === (a.to || a.target));
  let combat: any;
  if (a.type === "fire") {
    combat = {
      att: { id: p.id, rank: p.rank },
      def: { id: victim!.id, rank: victim!.rank },
    };
    remove(g, victim!);
    remove(g, p);
    point(g, a.seat);
    delete g.histories[a.seat];
    delete g.chases[a.seat];
  } else {
    const h = g.histories[a.seat];
    const edges: Record<string, number> = {};
    for (let i = 1; i < path.length; i++) {
      const e = edge(path[i - 1], path[i]);
      edges[e] = (h?.piece === p.id ? h.edges[e] || 0 : 0) + 1;
    }
    g.histories[a.seat] = { piece: p.id, edges, previous: from } as any;
    if (victim) {
      combat = {
        att: { id: p.id, rank: p.rank },
        def: { id: victim.id, rank: victim.rank },
      };
      const r = duel(p.rank!, victim.rank!);
      if (r >= 0) remove(g, victim);
      if (r <= 0) remove(g, p);
      if (r > 0) point(g, p.owner);
      if (r < 0) point(g, victim.owner);
      g.reveal = [p.id, victim.id];
    }
    if (g.pieces.includes(p)) {
      p.pos = a.to!;
      collect(g, p, from);
      if (
        !oldFlags.length &&
        ((p.rank === "2" && path.length > 3) ||
          (p.rank === "6" && path.length === 3))
      )
        g.reveal = [...g.reveal, p.id];
      const occ = Object.fromEntries(g.pieces.map((q) => [q.pos, q]));
      const threatened = moves(
        board(g.mode),
        occ,
        g.groundFlags,
        p.pos,
        p,
        false,
      )
        .map((x) => occ[x.to])
        .filter((q) => q && q.owner !== p.owner && !g.out[q.owner]);
      const ch = g.chases[p.owner];
      if (threatened.length === 1) {
        const t = threatened[0],
          key = p.pos + "|" + t.pos;
        g.chases[p.owner] =
          ch?.piece === p.id && ch.target === t.id
            ? { ...ch, seen: [...ch.seen, key] }
            : { piece: p.id, target: t.id, seen: [from + "|" + t.pos, key] };
      } else delete g.chases[p.owner];
    }
    for (const [s, ch] of Object.entries(g.chases))
      if (ch.target === p.id && ch.piece !== p.id) {
        /* target's movement continues the chase; another piece ends it below */
      } else if (g.pieces.find((q) => q.id === ch.target)?.owner === a.seat)
        delete g.chases[s];
  }
  g.lastAction = {
    type: a.type,
    seat: a.seat,
    pieceId: p.id,
    from,
    to: a.to || a.target,
    combat,
    moveCount: ++g.moveCount,
  };
  g.ver++;
  finish(g);
}

// Optional deterministic clock advancement; fast training matches default to no clock.
export function enableClock(g: SimState, reserveMs = 600000, bufferMs = 10000) {
  g.clock = {
    left: Object.fromEntries(seats(g.mode).map((s) => [s, reserveMs])),
    bufferMs,
    turnElapsed: 0,
  };
}
export function elapse(g: SimState, ms: number) {
  if (!Number.isFinite(ms) || ms < 0) throw Error("Invalid elapsed time");
  if (g.status !== "playing") return;
  if (g.promoWait) {
    g.promoWait.remainingMs -= ms;
    if (g.promoWait.remainingMs <= 0) {
      g.promoWait = null;
      g.ver++;
      finish(g);
    }
    return;
  }
  if (!g.clock) return;
  const before = g.clock.turnElapsed || 0;
  g.clock.turnElapsed = before + ms;
  const spent =
    Math.max(0, g.clock.turnElapsed - g.clock.bufferMs) -
    Math.max(0, before - g.clock.bufferMs);
  g.clock.left[g.turn] = Math.max(0, g.clock.left[g.turn] - spent);
  if (g.clock.left[g.turn] === 0) {
    g.out[g.turn] = "timeout";
    g.nextTurn = seats(g.mode)[
      (seats(g.mode).indexOf(g.turn) + 1) % seats(g.mode).length
    ];
    g.clock.turnElapsed = 0;
    g.ver++;
    finish(g);
  }
}
