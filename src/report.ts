import fs from "node:fs";
import path from "node:path";
import { records, read, root } from "./storage.js";
import {
  publicJson,
  liveSnapshot,
  liveHeadings,
  liveCells,
} from "./live-report.js";
import { queue } from "./master-store.js";
import type { MasterRecord } from "./master-git.js";

const esc = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const rate = (n: number) => (100 * n).toFixed(1) + "%";
const points = (n: number) => (100 * n).toFixed(1) + " pp";
function table(headings: string[], rows: unknown[][]) {
  return (
    '<div class="scroll"><table><thead><tr>' +
    headings.map((h) => "<th>" + esc(h) + "</th>").join("") +
    "</tr></thead><tbody>" +
    rows
      .map(
        (row) =>
          "<tr>" +
          row.map((cell) => "<td>" + esc(cell) + "</td>").join("") +
          "</tr>",
      )
      .join("") +
    "</tbody></table></div>"
  );
}
export function report() {
  const previous = publicJson<any>("results/summary.json", {}),
    history = publicJson<MasterRecord[]>("league/history.json", []),
    master = history.at(-1);
  const live = liveSnapshot(previous, history),
    candidateQueue = queue(),
    gate = read<any>("parity-gate.json", previous.validation ?? {});
  const samples = records("latency.jsonl")
    .map((s) => s.ms)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const latency = samples.length
    ? samples[Math.floor((samples.length - 1) * 0.95)]
    : previous.decisionLatencyP95Ms;
  const priorEvaluations = new Map<string, any>(
    (previous.evaluations ?? []).map((e: any) => [e.id, e]),
  );
  for (const e of records("evaluations.jsonl")) priorEvaluations.set(e.id, e);
  const generations = [...history]
    .reverse()
    .map((g) => [
      "G" + g.generation,
      g.agent,
      g.theory,
      g.stats
        ? rate(g.stats.overall.candidateRate) +
          " / " +
          rate(g.stats.overall.masterRate)
        : "—",
      g.stats ? points(g.stats.overall.edge) : "—",
      g.stats ? points(g.stats.overall.lower) : "—",
      g.stats?.overall.pairs ?? "—",
      g.anchor ? rate(g.anchor.overall.candidateRate) : "—",
    ]);
  const queueRows = candidateQueue.map((c) => [
    c.agent,
    c.theory,
    c.hash.slice(0, 12),
    c.parent.slice(0, 12),
    c.state,
  ]);
  const validation = gate.fullParity
    ? "Full simulator parity verified."
    : gate.passed
      ? "Recorded website transitions agree with the simulator. Full parity is unverified."
      : gate.passed === false
        ? "Recorded website validation needs review."
        : "Website validation has no recorded result.";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Flag Carriers research report</title><style>body{font:16px Inter,system-ui,sans-serif;max-width:1160px;margin:40px auto;padding:0 20px;background:#111827;color:#e5e7eb}table{width:100%;border-collapse:collapse}.scroll{overflow:auto}td,th{padding:9px;border-bottom:1px solid #374151;text-align:left;vertical-align:top}th{font-size:.88rem;color:#cbd5e1}.status{padding:16px;background:#1f2937;border-radius:8px}h2{margin-top:36px}</style></head><body><h1>Flag Carriers research</h1><div class="status">${master ? "Current Master <strong>G" + master.generation + "</strong> · " + esc(master.hash.slice(0, 12)) : "Master history unavailable"}. ${esc(validation)}${Number.isFinite(latency) ? " Website decision latency at the 95th percentile was " + Number(latency).toFixed(1) + " ms." : ""}</div>
<h2>Master generations</h2>${generations.length ? table(["Master", "Researcher", "Theory", "Master / predecessor wins", "Advantage", "Lower bound", "Seed pairs", "Fixed-anchor wins"], generations) : "<p>No recorded generations.</p>"}
<h2>Candidate queue</h2>${queueRows.length ? table(["Researcher", "Theory", "Candidate hash", "Parent hash", "State"], queueRows) : "<p>No submitted candidates.</p>"}
<h2>Website results</h2>${table(liveHeadings, live.rows.map(liveCells))}
${
  priorEvaluations.size
    ? "<h2>Earlier weight evaluations</h2>" +
      table(
        [
          "Date",
          "Completed pairs",
          "Candidate win rate",
          "Baseline win rate",
          "Advantage",
          "Lower bound",
        ],
        [...priorEvaluations.values()].map((e) => [
          e.time,
          e.completedPairs,
          rate(e.candidateWinRate),
          rate(e.championWinRate),
          points(e.overall.mean),
          points(e.overall.lower),
        ]),
      )
    : ""
}
</body></html>`;
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, "report.html");
  fs.writeFileSync(file, html, { mode: 0o600 });
  return file;
}
