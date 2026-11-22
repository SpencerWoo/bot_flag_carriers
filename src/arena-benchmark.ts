import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { compileArenaPolicy, G0_SOURCE, playArenaPair } from "./arena-match.js";

export interface BenchmarkOptions {
  pairs?: number;
  mode?: number;
  seed?: number;
}
// This fixed-policy serial run isolates referee throughput. For experiments on
// strategy strength use the shared league pool and the promotion protocol.
export function runArenaBenchmark({
  pairs = 12,
  mode,
  seed = 12700,
}: BenchmarkOptions = {}) {
  if (
    !Number.isSafeInteger(pairs) ||
    pairs < 1 ||
    pairs > 100000 ||
    !Number.isSafeInteger(seed) ||
    seed < 0 ||
    (mode !== undefined && ![3, 4].includes(mode))
  )
    throw Error("Invalid benchmark scenarios");
  const master = compileArenaPolicy(G0_SOURCE);
  for (const board of [3, 4])
    playArenaPair({ challenger: master, master, mode: board, seed: 9841 });
  const start = performance.now(),
    initial = process.cpuUsage(),
    digest = createHash("sha256");
  let plies = 0,
    games = 0,
    finished = 0;
  for (let i = 0; i < pairs; i++) {
    const result = playArenaPair({
      mode: mode ?? 3 + (i % 2),
      seed: seed + i,
      challenger: master,
      master,
      trace: true,
    });
    for (const game of result.games) {
      plies += game.plies;
      games++;
      finished += Number(game.complete);
      digest.update(
        JSON.stringify([
          result.mode,
          result.seed,
          game.challengerSeat,
          game.masterSeat,
          game.winner,
          game.reason,
          game.actions,
        ]) + "\n",
      );
    }
  }
  const seconds = (performance.now() - start) / 1000,
    cpu = process.cpuUsage(initial),
    cpuSeconds = (cpu.user + cpu.system) / 1e6;
  return {
    seed,
    pairs,
    mode: mode ?? "mixed",
    games,
    finished,
    plies,
    seconds,
    cpuSeconds,
    gamesPerSecond: games / seconds,
    pliesPerSecond: plies / seconds,
    pliesPerCpuSecond: plies / cpuSeconds,
    traceSha256: digest.digest("hex"),
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  console.log(
    JSON.stringify(
      runArenaBenchmark({
        pairs: process.argv[2] ? Number(process.argv[2]) : 12,
      }),
      null,
      2,
    ),
  );
}
