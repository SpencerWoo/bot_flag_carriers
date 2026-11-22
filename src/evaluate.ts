import { pairedJobs } from "./pool.js";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { lock, stopping } from "./control.js";
import { initial, step, view } from "./simulator.js";
import {
  decide,
  newMemory,
  DEFAULT,
  type Weights,
  validateWeights,
} from "./strategy.js";
import { rng, type Seat } from "./core.js";
import { append, save, read } from "./storage.js";
const sourceHash = createHash("sha256")
  .update(
    [
      "core",
      "simulator",
      "arena-view",
      "arena-threats",
      "strategy",
      "evaluate",
      "pool",
      "worker",
    ]
      .map((n) =>
        fs.readFileSync(
          new URL(
            "./" + n + (import.meta.url.endsWith(".ts") ? ".ts" : ".js"),
            import.meta.url,
          ),
        ),
      )
      .join("\n") +
      ["rules-core.cjs", "board3.cjs"]
        .map((n) =>
          fs.readFileSync(
            new URL(
              (import.meta.url.endsWith(".ts")
                ? "../vendor/"
                : "../../vendor/") + n,
              import.meta.url,
            ),
          ),
        )
        .join("\n"),
  )
  .digest("hex");
export interface MatchResult {
  mode: number;
  seed: number;
  seat: Seat;
  win: boolean;
  finished: boolean;
  winner: Seat | null;
  plies: number;
  reason: string;
  ms: number;
}
export function match(
  mode: number,
  seed: number,
  testSlot: number,
  weights: Weights,
  champion: Weights = DEFAULT,
  maxPlies = 2400,
  trace = false,
  deadline = Infinity,
  league: Weights[] = [],
): MatchResult {
  if (![3, 4].includes(mode)) throw Error("Mode must be 3 or 4");
  if (
    !Number.isInteger(seed) ||
    seed < 0 ||
    !Number.isInteger(testSlot) ||
    testSlot < 0
  )
    throw Error("Seed and slot must be nonnegative integers");
  const ss: Seat[] = mode === 3 ? ["R", "B", "Y"] : ["R", "B", "Y", "G"],
    seat = ss[testSlot % ss.length],
    background = [
      champion,
      ...league,
      { ...DEFAULT, risk: 3, flag: 8 },
      { ...DEFAULT, capture: 8, risk: 5 },
    ];
  const configs = Object.fromEntries(
    ss.map((s, i) => [
      s,
      s === seat ? weights : background[(seed + i) % background.length],
    ]),
  ) as Record<Seat, Weights>;
  const carriers = Object.fromEntries(ss.map((s) => [s, configs[s].carrier]));
  const g = initial(mode, seed, carriers),
    mem = Object.fromEntries(ss.map((s) => [s, newMemory()])),
    random = Object.fromEntries(ss.map((s, i) => [s, rng(seed * 31 + i)]));
  const start = performance.now();
  let plies = 0;
  const actions: any[] = [];
  while (
    !stopping &&
    Date.now() < deadline &&
    g.status === "playing" &&
    plies < maxPlies
  ) {
    const s: Seat = g.promoWait?.seat || g.turn;
    const v = view(g, s),
      a = decide(v, mem[s], configs[s], random[s]);
    if (!a) throw Error(`No action while playing: ${g.mode}/${g.seed}/${s}`);
    if (trace) actions.push(a);
    step(g, a);
    plies++;
  }
  const result = {
    mode,
    seed,
    seat,
    win: g.results?.[seat] === "W",
    finished: g.status === "finished",
    winner: g.winner,
    plies,
    reason: g.endReason || "ply limit",
    ms: performance.now() - start,
  };
  if (trace)
    save("last-replay.json", { mode, seed, carriers, actions, result });
  return result;
}
export function bounds(values: number[]) {
  const n = values.length,
    mean = n ? values.reduce((a, b) => a + b, 0) / n : 0;
  const radius = n ? Math.sqrt((2 * Math.log(20)) / n) : Infinity;
  return {
    n,
    mean,
    lower: Math.max(-1, mean - radius),
    upper: Math.min(1, mean + radius),
    method: "one-sided 95% Hoeffding bound for paired outcomes in [-1,1]",
  };
}
export async function evaluate(
  candidate: Weights,
  games = 600,
  seed = 100000,
  screen = false,
  deadline = Infinity,
) {
  candidate = validateWeights(candidate);
  if (!Number.isInteger(games) || games < 2)
    throw Error("At least two paired scenarios required");
  const champion = read<any>("champion.json", { version: 0, weights: DEFAULT }),
    pairs: any[] = [];
  const league: Weights[] = [1, 2, 3]
    .map(
      (i) =>
        read<any>(`champions/v${champion.version - i}.json`, null)?.weights,
    )
    .filter(Boolean);
  const evaluationId = Date.now() + "-" + seed;
  const start = Date.now();
  const jobs = Array.from({ length: games }, (_, i) => {
    const mode = i % 2 === 0 ? 3 : 4;
    return {
      index: i,
      mode,
      seed: seed + i,
      slot: Math.floor(i / 2) % mode,
      weights: candidate,
      champion: champion.weights,
      league,
    };
  });
  const completed = await pairedJobs(
    jobs,
    (pair, n) => {
      append("evaluation-progress.jsonl", {
        evaluationId,
        sourceHash,
        seed,
        candidate,
        pair,
      });
      if (n % 10 === 0)
        console.log(
          JSON.stringify({
            event: screen ? "screen" : "holdout",
            pairs: n,
            total: games,
            elapsedSeconds: (Date.now() - start) / 1000,
          }),
        );
    },
    deadline,
  );
  pairs.push(...completed);
  const overall = bounds(pairs.map((p) => p.delta)),
    byMode = Object.fromEntries(
      [3, 4].map((mode) => [
        mode,
        bounds(
          pairs.filter((p) => p.candidate.mode === mode).map((p) => p.delta),
        ),
      ]),
    );
  const complete =
    pairs.length === games &&
    pairs.every((p) => p.candidate.finished && p.champion.finished);
  const result = {
    sourceHash,
    runtime: process.version,
    league,
    id: evaluationId,
    seed,
    requestedPairs: games,
    completedPairs: pairs.length,
    championVersion: champion.version,
    candidate,
    complete,
    overall,
    byMode,
    candidateWinRate: pairs.length
      ? pairs.filter((p) => p.candidate.win).length / pairs.length
      : 0,
    championWinRate: pairs.length
      ? pairs.filter((p) => p.champion.win).length / pairs.length
      : 0,
    eligible:
      !screen &&
      games >= 600 &&
      complete &&
      overall.lower > 0 &&
      Object.values(byMode).every((x) => x.upper >= 0),
    screen,
    pairs,
    time: new Date().toISOString(),
  };
  save(`evaluations/${result.id}.json`, result);
  append("evaluations.jsonl", { ...result, pairs: undefined });
  return result;
}
export async function learn(
  minutes = 120,
  liveGames = 4,
  roundLimit = Infinity,
) {
  const release = lock("learning");
  try {
    return await learnLocked(minutes, liveGames, roundLimit);
  } finally {
    release();
  }
}
async function learnLocked(
  minutes: number,
  liveGames: number,
  roundLimit: number,
) {
  const start = Date.now(),
    deadline = start + minutes * 60000;
  const localDeadline =
    deadline -
    (liveGames > 0 ? Math.min(30 * 60000, minutes * 60000 * 0.25) : 0);
  let round = 0;
  if (!Number.isFinite(minutes) || minutes <= 0)
    throw Error("Positive minutes required");
  while (!stopping && Date.now() < localDeadline && round < roundLimit) {
    const champion = read<any>("champion.json", {
      version: 0,
      weights: DEFAULT,
    });
    if (!read("champion.json", null)) save("champion.json", champion);
    const random = rng((start + round) >>> 0),
      candidates: Weights[] = [];
    for (let i = 0; i < 6; i++) {
      const w = { ...champion.weights };
      for (const key of [
        "capture",
        "risk",
        "flag",
        "advance",
        "novelty",
        "artillery",
      ] as const)
        w[key] = Math.max(0.05, w[key] * Math.exp((random() - 0.5) * 1.2));
      if (random() < 0.3)
        w.carrier = ["10", "9", "7", "6"][Math.floor(random() * 4)];
      candidates.push(w);
    }
    let best: any = null;
    for (
      let i = 0;
      i < candidates.length && !stopping && Date.now() < localDeadline;
      i++
    ) {
      const r = await evaluate(
        candidates[i],
        12,
        (start % 10000000) + round * 1000,
        true,
        localDeadline,
      );
      if (r.complete && (!best || r.overall.mean > best.overall.mean)) best = r;
    }
    save("learning-checkpoint.json", {
      round,
      championVersion: champion.version,
      finalist: best?.candidate,
      deadline,
    });
    if (!best || stopping || Date.now() >= localDeadline) break;
    const holdout = await evaluate(
      best.candidate,
      600,
      100000000 + (start % 10000000) + round * 1000,
      false,
      localDeadline,
    );
    const gate = read<any>("parity-gate.json", { passed: false });
    // Public-client geometry checks do not establish full server parity.
    if (holdout.eligible && gate.fullParity === true && gate.passed) {
      const next = {
        version: champion.version + 1,
        weights: best.candidate,
        parent: champion.version,
        evaluation: holdout.id,
        time: new Date().toISOString(),
      };
      save(`champions/v${champion.version}.json`, champion);
      save("champion.json", next);
      append("promotions.jsonl", next);
    } else
      append("promotion-decisions.jsonl", {
        evaluation: holdout.id,
        statisticalPass: holdout.eligible,
        promoted: false,
        reason: !gate.fullParity
          ? "Full simulator parity has not been established"
          : "Promotion criteria not met",
      });
    round++;
    await new Promise((r) => setImmediate(r));
  }
  // Live checks use the validated server-action policy; at most the configured cap.
  if (!stopping && liveGames > 0 && Date.now() < deadline) {
    const { play } = await import("./live.js");
    for (
      let i = 0;
      i < liveGames && !stopping && Date.now() < deadline - 60000;
      i++
    ) {
      if (read<any>("parity-gate.json", {}).passed === false) break;
      const r = await play({
        mode: i % 2 === 0 ? 3 : 4,
        kind: "offline",
        minutes: Math.max(0, (deadline - Date.now()) / 60000),
      });
      if (!r.finished) break;
    }
  }
  return {
    rounds: round,
    elapsedSeconds: (Date.now() - start) / 1000,
    champion: read("champion.json", { version: 0, weights: DEFAULT }),
  };
}
