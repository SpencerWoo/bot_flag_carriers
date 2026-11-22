import type { MasterRecord } from "./master-git.js";
import type { AnchorScore } from "./master-stats.js";
function cell(s: string) {
  return s
    .replace(/[\r\n]+/g, " ")
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
const pct = (x: number) => (x * 100).toFixed(1) + "%";
export function leaderboard(
  history: MasterRecord[],
  anchors: Record<string, AnchorScore> = {},
): string {
  const rows = [
    "# Flag Carriers Master leaderboard",
    "",
    "Each row records the local free-for-all qualification against the preceding Master. Fixed-anchor win rates use the same G0 opponent, fillers and 120 paired seeds across generations. The two live board sizes have separate results in [the website results by Master generation](../results/live-by-master.md).",
    "",
    "| Generation | Agent and theory | Parent | Master vs predecessor | Advantage (lower bound) | 3P / 4P edge | Seed pairs | Fixed-anchor win rate | Evidence |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const g of [...history].reverse()) {
    const s = g.stats,
      a = g.anchor || anchors[g.hash];
    rows.push(
      "| " +
        [
          "G" + g.generation,
          cell(g.agent + " · " + g.theory),
          g.parent ? "\u0060" + g.parent.slice(0, 12) + "\u0060" : "—",
          s
            ? pct(s.overall.candidateRate) + " vs " + pct(s.overall.masterRate)
            : "—",
          s
            ? (s.overall.edge * 100).toFixed(1) +
              " pp (" +
              (s.overall.lower * 100).toFixed(1) +
              " pp)"
            : "—",
          s
            ? (s.three.edge * 100).toFixed(1) +
              " / " +
              (s.four.edge * 100).toFixed(1) +
              " pp"
            : "—",
          s ? s.overall.pairs : "—",
          a ? pct(a.overall.candidateRate) : "Pending",
          g.qualification
            ? "[Qualification](qualifications/" + g.qualification + ".json)"
            : "[Initial results](../results/README.md)",
        ].join(" | ") +
        " |",
    );
  }
  return rows.join("\n") + "\n";
}

interface TrialRow {
  agent: string;
  hash: string;
  theory: string;
  state: string;
  generation?: number;
  completed: number;
  edge?: number;
}
export function trialsTable(trials: TrialRow[]): string {
  if (!trials.length) return "";
  const header = [
    "",
    "## Local research queue",
    "",
    "| Agent / candidate | Theory | Tested against | State | Pairs | Completed edge |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  return (
    [
      ...header,
      ...trials.map(
        (t) =>
          "| " +
          [
            cell(t.agent) + " · " + t.hash.slice(0, 12),
            cell(t.theory),
            t.generation === undefined ? "Pending" : "G" + t.generation,
            t.state,
            t.completed,
            t.edge === undefined ? "—" : (100 * t.edge).toFixed(1) + " pp",
          ].join(" | ") +
          " |",
      ),
    ].join("\n") + "\n"
  );
}
