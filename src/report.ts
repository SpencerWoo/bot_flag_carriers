import fs from "node:fs";
import path from "node:path";
import { records, read, root } from "./storage.js";
import { DEFAULT } from "./strategy.js";
const esc = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function report() {
  const champion = read<any>("champion.json", { version: 0, weights: DEFAULT }),
    evals = records("evaluations.jsonl"),
    live = records("live-results.jsonl"),
    gate = read<any>("parity-gate.json", {}),
    latencies = records("latency.jsonl")
      .map((x) => x.ms)
      .sort((a, b) => a - b);
  const table = (heads: string[], rows: unknown[][]) =>
    "<table><thead><tr>" +
    heads.map((h) => "<th>" + esc(h) + "</th>").join("") +
    "</tr></thead><tbody>" +
    rows
      .map(
        (row) =>
          "<tr>" + row.map((c) => "<td>" + esc(c) + "</td>").join("") + "</tr>",
      )
      .join("") +
    "</tbody></table>";
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, "report.html");
  fs.writeFileSync(
    file,
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Flag Carriers learning report</title><style>body{font:16px system-ui;max-width:1100px;margin:40px auto;padding:0 20px;background:#111827;color:#e5e7eb}table{width:100%;border-collapse:collapse}td,th{padding:10px;border-bottom:1px solid #374151;text-align:left}pre{white-space:pre-wrap}.status{padding:16px;background:#1f2937;border-radius:8px}h2{margin-top:36px}</style><h1>Flag Carriers</h1><p>Updated ${esc(new Date().toISOString())}</p><div class="status">Champion V${champion.version}. Full simulator/server parity: ${gate.fullParity === true ? "verified" : "unverified; automatic promotion blocked"}. Decision latency p95: ${latencies.length ? latencies[Math.floor((latencies.length - 1) * 0.95)].toFixed(1) + " ms" : "no samples"}.</div><h2>Evaluations</h2>${table(
      [
        "Date",
        "Pairs",
        "Candidate wins",
        "Champion wins",
        "Improvement",
        "95% lower bound",
        "Complete",
      ],
      evals.map((e) => [
        e.time,
        e.completedPairs,
        (e.candidateWinRate * 100).toFixed(1) + "%",
        (e.championWinRate * 100).toFixed(1) + "%",
        (e.overall.mean * 100).toFixed(1) + " pp",
        (e.overall.lower * 100).toFixed(1) + " pp",
        e.complete,
      ]),
    )}<h2>Live games</h2>${table(
      [
        "Game",
        "Board",
        "Status",
        "Moves",
        "Geometry checks",
        "Transition checks",
        "Result",
      ],
      live.map((g) => [
        g.id,
        g.mode,
        g.status,
        g.moveCount,
        g.geometryChecks,
        g.transitionChecks,
        JSON.stringify(g.results),
      ]),
    )}<h2>Champion weights</h2><pre>${esc(JSON.stringify(champion.weights, null, 2))}</pre><h2>Promotion history</h2><pre>${esc(JSON.stringify(records("promotions.jsonl"), null, 2))}</pre></html>`,
    { mode: 0o600 },
  );
  return file;
}
