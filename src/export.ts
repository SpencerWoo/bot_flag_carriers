import fs from "node:fs";
import path from "node:path";
import { read, records } from "./storage.js";
import { DEFAULT } from "./strategy.js";
export function exportResults() {
  const current = read<any>("champion.json", { version: 0, weights: DEFAULT });
  const champion = {
    version: current.version,
    weights: current.weights,
    parent: current.parent,
    evaluation: current.evaluation,
    time: current.time,
  };
  const write = (name: string, data: unknown) => {
    fs.mkdirSync(path.dirname(name), { recursive: true });
    fs.writeFileSync(name, JSON.stringify(data, null, 2) + "\n");
  };
  write("strategies/champion.json", champion);
  for (let v = 0; v < current.version; v++) {
    const c = read<any>(`champions/v${v}.json`, null);
    if (c)
      write(`strategies/champions/v${v}.json`, {
        version: c.version,
        weights: c.weights,
        parent: c.parent,
        evaluation: c.evaluation,
        time: c.time,
      });
  }
  const evaluations = records("evaluations.jsonl").map((e) => ({
    id: e.id,
    sourceHash: e.sourceHash,
    runtime: e.runtime,
    seed: e.seed,
    requestedPairs: e.requestedPairs,
    completedPairs: e.completedPairs,
    championVersion: e.championVersion,
    candidate: e.candidate,
    complete: e.complete,
    overall: e.overall,
    byMode: e.byMode,
    candidateWinRate: e.candidateWinRate,
    championWinRate: e.championWinRate,
    eligible: e.eligible,
    screen: e.screen,
    time: e.time,
  }));
  const games = new Map(
    records("live-results.jsonl")
      .filter((g) => g.finished)
      .map((g) => [g.id, g]),
  );
  const live = Object.fromEntries(
    [3, 4].map((mode) => {
      const selected = [...games.values()].filter((g) => g.mode === mode);
      let wins = 0,
        draws = 0;
      for (const g of selected) {
        const snapshot = read<any>(`checkpoint-${g.id}.json`, {}),
          seat = snapshot.mySeats?.[0];
        if (g.results?.[seat] === "W") wins++;
        if (g.results?.[seat] === "D") draws++;
      }
      return [
        mode,
        {
          games: selected.length,
          wins,
          draws,
          losses: selected.length - wins - draws,
        },
      ];
    }),
  );
  const parity = read<any>("parity-gate.json", {});
  const latency = records("latency.jsonl")
    .map((x) => x.ms)
    .sort((a, b) => a - b);
  const summary = {
    updated: new Date().toISOString(),
    championVersion: champion.version,

    live,
    validation: {
      passed: parity.passed,
      fullParity: parity.fullParity,
      coverage: parity.coverage,
      reason: parity.reason,
    },
    decisionLatencyP95Ms: latency.length
      ? latency[Math.floor((latency.length - 1) * 0.95)]
      : null,
    evaluations,
  };
  write("results/summary.json", summary);
  return {
    champion: "strategies/champion.json",
    results: "results/summary.json",
  };
}
