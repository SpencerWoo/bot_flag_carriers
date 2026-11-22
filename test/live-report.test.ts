import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("generation reporting matches both policy pins, retains exported history, and counts every website game once", async () => {
  const original = process.cwd(),
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), "flag-master-report-"));
  const oldData = process.env.FLAG_CARRIERS_DATA,
    oldLeague = process.env.FLAG_CARRIERS_LEAGUE_REPO;
  try {
    process.chdir(temporary);
    process.env.FLAG_CARRIERS_DATA = path.join(temporary, "private");
    process.env.FLAG_CARRIERS_LEAGUE_REPO = temporary;
    const { append, root } = await import("../src/storage.js"),
      { exportResults } = await import("../src/export.js"),
      { report } = await import("../src/report.js");
    const g0 =
        "3bd526b4cf8bf1c58938364dd4b1c5b6e978ac3ebae695d9d6cf338ba416e6ff",
      g1 = "a".repeat(64);
    fs.mkdirSync("league");
    fs.writeFileSync(
      "league/history.json",
      JSON.stringify([
        { generation: 0, hash: g0, agent: "seed", theory: "V0" },
        { generation: 1, hash: g1, agent: "x", theory: "Open the middle" },
      ]),
    );
    fs.mkdirSync("results");
    const historic = {
      id: "prior-eval",
      candidateWinRate: 0.31,
      championWinRate: 0.28,
      overall: { mean: 0.03, lower: -0.07 },
    };
    fs.writeFileSync(
      "results/summary.json",
      JSON.stringify({
        evaluations: [historic],
        validation: { passed: true },
        decisionLatencyP95Ms: 15,
      }),
    );
    const live = (id: string, extra: object) =>
      append("live-results.jsonl", {
        id,
        mode: 3,
        finished: true,
        kind: "offline",
        seat: "R",
        results: { R: "W" },
        ...extra,
      });
    live("new-live-id", { masterGeneration: 1, masterHash: g1 });
    live("new-live-id", { masterGeneration: 1, masterHash: g1 });
    live("wrong-pin", { masterGeneration: 0, masterHash: g1 });
    live("unrecognized-old-game", { moveCount: 40 });
    live("unscored-game", {
      mode: 4,
      results: {},
      masterGeneration: 1,
      masterHash: g1,
    });
    live("unfinished", {
      finished: false,
      masterGeneration: 1,
      masterHash: g1,
    });
    exportResults();
    const snapshot = () =>
      JSON.parse(fs.readFileSync("results/summary.json", "utf8"));
    const markdown = fs.readFileSync("results/live-by-master.md", "utf8");
    assert.equal(snapshot().live[3].wins, 3);
    assert.equal(snapshot().live[4].losses, 0);
    assert.equal(snapshot().live[4].unscored, 1);
    assert.equal(Object.keys(snapshot().liveReceipts).length, 4);
    assert.match(markdown, /G1 \| Site bots \| 3 \| 1 \| 1/);
    assert.match(markdown, /Unattributed \| Site bots \| 3 \| 2 \| 2/);
    const first = snapshot();
    fs.rmSync(path.join(root, "live-results.jsonl"));
    exportResults();
    assert.deepEqual(snapshot().live, first.live);
    assert.deepEqual(snapshot().liveReceipts, first.liveReceipts);
    assert.deepEqual(snapshot().evaluations, [historic]);
    assert.equal(snapshot().decisionLatencyP95Ms, 15);
    const html = fs.readFileSync(report(), "utf8");
    assert.match(html, /Current Master <strong>G1/);
    assert.match(html, /Candidate queue/);
    assert.match(html, /Website results/);
    assert(!html.includes("automatic promotion blocked"));
    for (const text of [markdown, JSON.stringify(snapshot()), html])
      assert(!text.includes("new-live-id"));
  } finally {
    process.chdir(original);
    if (oldData === undefined) delete process.env.FLAG_CARRIERS_DATA;
    else process.env.FLAG_CARRIERS_DATA = oldData;
    if (oldLeague === undefined) delete process.env.FLAG_CARRIERS_LEAGUE_REPO;
    else process.env.FLAG_CARRIERS_LEAGUE_REPO = oldLeague;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
