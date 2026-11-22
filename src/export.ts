import fs from "node:fs";
import path from "node:path";
import { read, records } from "./storage.js";
import { DEFAULT } from "./strategy.js";
import { liveSnapshot, liveMarkdown, publicJson } from "./live-report.js";
export function exportResults() {
  const previous = publicJson<any>("results/summary.json", {});
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
  const fresh = records("evaluations.jsonl").map((e) => ({
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
  const allEvaluations = new Map(
    (previous.evaluations ?? []).map((e: any) => [e.id, e] as const),
  );
  for (const e of fresh) allEvaluations.set(e.id, e);
  const evaluations = [...allEvaluations.values()];
  const live = liveSnapshot(previous);
  const parity = read<any>("parity-gate.json", previous.validation ?? {});
  const latency = records("latency.jsonl")
    .map((x) => x.ms)
    .sort((a, b) => a - b);
  const summary = {
    updated: new Date().toISOString(),
    championVersion: champion.version,

    live: live.totals,
    liveReceipts: live.receipts,
    unattributedLiveTotals: live.unattributedLiveTotals,
    validation: {
      passed: parity.passed,
      fullParity: parity.fullParity,
      coverage: parity.coverage,
      reason: parity.reason,
    },
    decisionLatencyP95Ms: latency.length
      ? latency[Math.floor((latency.length - 1) * 0.95)]
      : (previous.decisionLatencyP95Ms ?? null),
    evaluations,
  };
  write("results/summary.json", summary);
  fs.writeFileSync("results/live-by-master.md", liveMarkdown(live.rows));
  return {
    liveByMaster: "results/live-by-master.md",
    champion: "strategies/champion.json",
    results: "results/summary.json",
  };
}
