import { createHash } from "node:crypto";
import { ARMY, board, type Action, type Seat } from "./core.js";
import { initial, step, type SimState } from "./simulator.js";
import { arenaPlayerView } from "./arena-view.js";
import { type ArenaActor, type ArenaPolicy } from "./arena-policy.js";
export {
  loadArenaPolicy,
  compileArenaPolicy,
  G0_SOURCE,
} from "./arena-policy.js";
export { arenaPlayerView } from "./arena-view.js";
export type { ArenaPolicy, ArenaActor } from "./arena-policy.js";

export interface PairSpec {
  mode: number;
  seed: number;
  challenger: ArenaPolicy;
  master: ArenaPolicy;
  slots?: readonly [number, number];
  fillers?: readonly ArenaPolicy[];
  maxPlies?: number;
  trace?: boolean;
}
export interface ArenaGameResult {
  winner: Seat | null;
  draw: boolean;
  complete: boolean;
  plies: number;
  reason: string;
  challengerSeat: Seat;
  masterSeat: Seat;
  actions?: Action[];
}
function streamSeed(seed: number, label: string) {
  return createHash("sha256")
    .update("flag-carriers-arena-v1/" + seed + "/" + label)
    .digest()
    .readUInt32BE();
}
function playLeg(
  spec: PairSpec,
  cSlot: number,
  mSlot: number,
): ArenaGameResult {
  const seats = board(spec.mode).seats as Seat[],
    actors = {} as Record<Seat, ArenaActor>,
    defaults = {} as Record<Seat, string>;
  let filler = 0;
  for (let i = 0; i < seats.length; i++) {
    const def =
      i === cSlot
        ? spec.challenger
        : i === mSlot
          ? spec.master
          : (spec.fillers?.[filler++] ?? spec.master);
    actors[seats[i]] = def.create(streamSeed(spec.seed, "seat-" + i));
    defaults[seats[i]] = "10";
  }
  const g: SimState = initial(
    spec.mode,
    streamSeed(spec.seed, "setup"),
    defaults,
  );
  // Each participant chooses its carrier from its own setup. Capture all
  // choices before swapping anything so seat order cannot leak an opening.
  const choices = seats.map(
    (s) =>
      actors[s].setup?.(arenaPlayerView({ ...g, status: "setup" }, s)) ?? "10",
  );
  for (const [i, s] of seats.entries()) {
    const rank = choices[i];
    if (typeof rank !== "string" || !Object.hasOwn(ARMY, rank))
      throw Error("Policy requested an invalid carrier");
    const carrier = g.pieces.find((p) => p.owner === s && p.flags.includes(s))!,
      chosen = g.pieces.find((p) => p.owner === s && p.rank === rank)!;
    [carrier.rank, chosen.rank] = [chosen.rank, carrier.rank];
  }
  const trace = spec.trace ? ([] as Action[]) : undefined;
  let plies = 0;
  while (g.status === "playing" && plies < (spec.maxPlies ?? 2400)) {
    const acting: Seat = g.promoWait?.seat ?? g.turn;
    const actor = actors[acting];
    // Every seat can remember public combat reveals between its turns.
    for (const s of seats)
      if (s !== acting && actors[s].observe)
        actors[s].observe!(arenaPlayerView(g, s));
    const v = arenaPlayerView(g, acting);
    actor.observe?.(v);
    const a = actor.choose(v);
    if (
      !a ||
      a.seat !== acting ||
      !["move", "fire", "recruit"].includes(a.type) ||
      (a.type === "recruit" && !g.promoWait)
    )
      throw Error("Policy submitted an illegal action");
    // Construct a fresh ordinary action. Extraneous properties must never alter
    // the referee’s interpretation (for example, a flag-drop on a fire action).
    const action: Action =
      a.type === "move"
        ? {
            type: "move",
            seat: acting,
            pieceId: a.pieceId,
            to: a.to,
            dropFlags: a.dropFlags === true,
          }
        : a.type === "fire"
          ? { type: "fire", seat: acting, pieceId: a.pieceId, target: a.target }
          : { type: "recruit", seat: acting, rank: a.rank };
    step(g, action);
    trace?.push(action);
    plies++;
  }
  return {
    winner: g.winner,
    draw: g.status === "finished" && !g.winner,
    complete: g.status === "finished",
    plies,
    reason: g.endReason ?? "ply limit",
    challengerSeat: seats[cSlot],
    masterSeat: seats[mSlot],
    ...(trace ? { actions: trace } : {}),
  };
}
export function playArenaPair(spec: PairSpec) {
  if (
    ![3, 4].includes(spec.mode) ||
    !Number.isSafeInteger(spec.seed) ||
    spec.seed < 0
  )
    throw Error("Invalid board or scenario seed");
  const n = spec.mode,
    slots = spec.slots ?? [
      spec.seed % n,
      (spec.seed + 1 + (Math.floor(spec.seed / n) % (n - 1))) % n,
    ];
  if (
    slots.length !== 2 ||
    slots[0] === slots[1] ||
    slots.some((s) => !Number.isInteger(s) || s < 0 || s >= n)
  )
    throw Error("Invalid paired seat slots");
  if (
    spec.maxPlies !== undefined &&
    (!Number.isInteger(spec.maxPlies) || spec.maxPlies <= 0)
  )
    throw Error("Invalid game length limit");
  const games = [
    playLeg(spec, slots[0], slots[1]),
    playLeg(spec, slots[1], slots[0]),
  ];
  const candidateWins = games.filter(
      (g) => g.winner === g.challengerSeat,
    ).length,
    masterWins = games.filter((g) => g.winner === g.masterSeat).length;
  return {
    mode: spec.mode,
    seed: spec.seed,
    candidateWins,
    masterWins,
    delta: (candidateWins - masterWins) / 2,
    complete: games.every((g) => g.complete),
    games,
  };
}
