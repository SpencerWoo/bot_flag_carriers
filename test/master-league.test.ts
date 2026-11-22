import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  schedule,
  adjudicate,
  HOLDOUT_PAIRS,
  ANCHOR_PAIRS,
  type PairScore,
} from "../src/master-stats.js";
import {
  enqueueCandidate,
  currentMaster,
  runQualification,
  hasPendingCandidates,
  queue,
  type QualificationOptions,
} from "../src/master-league.js";
import {
  git,
  digest,
  fetchMasterHead,
  readAt,
  publishTree,
  type Publication,
} from "../src/master-git.js";
const repo = fileURLToPath(new URL("../", import.meta.url));
type Pool = NonNullable<QualificationOptions["pool"]>;
function fixture(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "master-referee-test-")),
    remote = path.join(dir, "remote.git"),
    home = path.join(dir, "checkout");
  const envs = [
    "FLAG_CARRIERS_LEAGUE_REPO",
    "FLAG_CARRIERS_LEAGUE_DATA",
    "FLAG_CARRIERS_MASTER_REMOTE",
    "FLAG_CARRIERS_MASTER_BRANCH",
  ];
  const old = envs.map((k) => process.env[k]);
  for (const k of envs) delete process.env[k];
  t.after(() => {
    for (const [i, k] of envs.entries())
      if (old[i] === undefined) delete process.env[k];
      else process.env[k] = old[i];
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const command = (args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  command(["init", "--bare", "-b", "main", remote]);
  command(["clone", remote, home]);
  process.env.FLAG_CARRIERS_LEAGUE_REPO = home;
  process.env.FLAG_CARRIERS_LEAGUE_DATA = path.join(dir, "private");
  for (const filename of [
    "league/master.json",
    "league/history.json",
    "policies/master-g0.mjs",
    "league/policies/runner.mjs",
    "league/policies/aggressive.mjs",
  ]) {
    fs.mkdirSync(path.dirname(path.join(home, filename)), { recursive: true });
    fs.copyFileSync(path.join(repo, filename), path.join(home, filename));
  }
  git(["add", "."]);
  git([
    "-c",
    "user.name=Test",
    "-c",
    "user.email=bot@example.invalid",
    "commit",
    "-qm",
    "Master G0",
  ]);
  git(["push", "origin", "main"]);
  return { dir, home, remote };
}
function fakePool(cw: number, mw: number, onPair?: () => void): Pool {
  return {
    size: 1,
    async pair(job) {
      onPair?.();
      return {
        mode: job.mode,
        seed: job.seed,
        candidateWins: cw,
        masterWins: mw,
        complete: true,
        delta: (cw - mw) / 2,
        games: [0, 1].map((i) => ({
          winner: (i < cw ? "R" : i < cw + mw ? "B" : "Y") as "R" | "B" | "Y",
          draw: false,
          complete: true,
          plies: 1,
          reason: "fixture",
          challengerSeat: "R" as const,
          masterSeat: "B" as const,
        })),
      };
    },
  };
}
const candidateSource = (tag: string) =>
  "// " + tag + "\nexport default ({baseline}) => baseline();\n";
function submit(tag: string) {
  return enqueueCandidate({
    source: candidateSource(tag),
    theory: "Theory " + tag,
    agent: "fixture",
    parent: currentMaster({ sync: true }).hash,
  });
}
test("qualification uses both board sizes equally and balances every seat pair", () => {
  const seen = new Map<string, number>();
  for (let i = 0; i < HOLDOUT_PAIRS; i++) {
    const s = schedule(i, "frozen"),
      k = s.mode + "/" + s.slots.join(",");
    seen.set(k, (seen.get(k) ?? 0) + 1);
    assert.deepEqual(s, schedule(i, "frozen"));
  }
  assert.equal(seen.size, 9);
  for (const [s, n] of seen) assert.equal(n, s.startsWith("3") ? 200 : 100);
  assert.notEqual(schedule(7, "a").seed, schedule(7, "b").seed);
});
test("scoring counts neutral wins/draws, unfinished pairs, board regressions and repeated looks", () => {
  const rows: PairScore[] = Array.from({ length: 1200 }, (_, index) => ({
    index,
    mode: index % 2 ? 4 : 3,
    candidateWins: 1,
    masterWins: 0,
    draws: 1,
    complete: true,
  }));
  const pass = adjudicate(rows, 1);
  assert(pass.passed);
  assert.equal(pass.overall.games, 2400);
  assert.equal(pass.overall.draws, 1200);
  assert(adjudicate(rows, 2).alpha < pass.alpha);
  assert(!adjudicate(rows.slice(0, -1), 1).passed);
  assert(
    !adjudicate(
      rows.map((r, i) => ({ ...r, index: i === 2 ? 0 : i })),
      1,
    ).passed,
  );
  assert(
    !adjudicate(
      rows.map((r) => ({
        ...r,
        candidateWins: r.mode === 3 ? 2 : 0,
        masterWins: r.mode === 3 ? 0 : 1,
        draws: 0,
      })),
      1,
    ).passed,
  );
  assert(
    !adjudicate(
      rows.map((r, i) => ({ ...r, masterWins: i < 1170 ? 1 : 0, draws: 0 })),
      1,
    ).passed,
  );
});
test("private qualification resumes identical seeds, rejects a failed hypothesis and deduplicates submissions", async (t) => {
  fixture(t);
  const first = submit("A");
  assert.equal(submit("A").id, first.id);
  let count = 0;
  const controller = new AbortController();
  const partial = await runQualification({
    signal: controller.signal,
    pool: fakePool(0, 0, () => {
      if (++count === 8) controller.abort();
    }),
  });
  assert.equal(partial.status, "incomplete");
  assert.equal(partial.completed, 8);
  let remaining = 0;
  const finished = await runQualification({
    pool: fakePool(0, 0, () => {
      remaining++;
    }),
  });
  assert.equal(finished.status, "rejected");
  assert.equal(remaining, 1192);
  assert.equal(finished.run, partial.run);
  assert(!hasPendingCandidates());
  submit("B");
  const again = await runQualification({ pool: fakePool(0, 0) });
  assert.match(again.run!, /^g0-2-/);
  assert.equal(currentMaster({ sync: true }).generation, 0);
});
test("publication checks its exact head and atomically advances manifest, policy, evidence, board and anchors", async (t) => {
  const { home, dir } = fixture(t);
  const start = currentMaster({ sync: true });
  submit("win");
  let calls = 0;
  const ready = await runQualification({
    pool: fakePool(2, 0, () => {
      calls++;
    }),
    publish: "prepare",
  });
  assert.equal(ready.status, "prepared");
  assert.equal(calls, HOLDOUT_PAIRS + 2 * ANCHOR_PAIRS);
  assert.equal(currentMaster({ sync: true }).generation, 0);
  const old: Publication = JSON.parse(fs.readFileSync(ready.planPath!, "utf8"));
  fs.writeFileSync(path.join(home, "extra"), "concurrent edit");
  git(["add", "extra"]);
  git([
    "-c",
    "user.name=Test",
    "-c",
    "user.email=bot@example.invalid",
    "commit",
    "-qm",
    "other work",
  ]);
  git(["push", "origin", "main"]);
  assert.throws(() => publishTree(old));
  assert.equal(currentMaster({ sync: true }).generation, 0);
  const published = await runQualification({
    pool: fakePool(2, 0, () => assert.fail("should reuse completed pairs")),
  });
  assert.equal(published.status, "promoted");
  const master = currentMaster({ sync: true });
  assert.equal(master.generation, 1);
  assert.equal(master.parent, start.hash);
  assert.equal(digest(master.source), master.hash);
  assert.equal(master.qualification, ready.run);
  assert.equal(readAt(master.head, "extra"), "concurrent edit");
  assert.match(readAt(master.head, "league/leaderboard.md"), /G1/);
  assert.equal(
    JSON.parse(readAt(master.head, "league/history.json")).length,
    2,
  );
  assert.equal(
    JSON.parse(
      readAt(master.head, "league/qualifications/" + ready.run + ".json"),
    ).stats.overall.games,
    2400,
  );
  assert(!JSON.stringify(old.files).includes(path.join(dir, "private")));
  assert.equal(
    (await runQualification({ pool: fakePool(0, 0) })).status,
    "idle",
  );
});
test("a challenger queued on an older Master qualifies against the published successor", async (t) => {
  fixture(t);
  const original = currentMaster({ sync: true });
  submit("first");
  const second = submit("second");
  await runQualification({ pool: fakePool(2, 0) });
  const next = currentMaster({ sync: true });
  const p = await runQualification({ pool: fakePool(0, 0) });
  assert.equal(p.id, second.id);
  assert.match(p.run!, /^g1-1-/);
  const r = JSON.parse(
    fs.readFileSync(
      path.join(
        process.env.FLAG_CARRIERS_LEAGUE_DATA!,
        "runs",
        p.run!,
        "manifest.json",
      ),
      "utf8",
    ),
  );
  assert.equal(r.parent, next.hash);
  assert.notEqual(r.parent, original.hash);
  assert.equal(queue().filter((s) => s.state === "promoted").length, 1);
});
test("fixed-grid paired bounds can certify a consistent 3pp edge", () => {
  const rows: PairScore[] = Array.from({ length: 1200 }, (_, i) => ({
    mode: i % 2 ? 4 : 3,
    index: i,
    candidateWins: i < 72 ? 1 : 0,
    masterWins: 0,
    draws: 0,
    complete: true,
  }));
  const r = adjudicate(rows, 1);
  assert.equal(r.overall.edge, 0.03);
  assert(r.overall.lower > 0);
  assert(r.passed);
  const tied = adjudicate(
    rows.map((r) => ({ ...r, candidateWins: 0 })),
    1,
  );
  assert(tied.overall.lower <= 0 && tied.overall.upper >= 0);
});
test("mixture e-value is calibrated under independent heterogeneous null strata", async () => {
  const { logMixtureE } = await import("../src/master-stats.js");
  const ps = [0.1, 0.9, 0.2, 0.8, 0.3, 0.7, 0.4, 0.6];
  let expected = 0;
  for (let outcome = 0; outcome < 2 ** ps.length; outcome++) {
    let probability = 1;
    const counts = [0, 0, 0, 0, 0];
    ps.forEach((p, i) => {
      const won = (outcome >> i) & 1;
      probability *= won ? p : 1 - p;
      counts[won ? 4 : 0]++;
    });
    expected += probability * Math.exp(logMixtureE(counts, 0));
  }
  assert(expected <= 1 + 1e-12 && expected > 0);
});
test("explicit submission choice only changes the unstarted FIFO and retains attempt allocation", async (t) => {
  fixture(t);
  const first = submit("earliest"),
    second = submit("later");
  const controller = new AbortController();
  await assert.rejects(
    runQualification({ id: "unknown", pool: fakePool(0, 0) }),
    /Unknown Master submission/,
  );
  const started = await runQualification({
    id: second.id,
    signal: controller.signal,
    pool: fakePool(0, 0, () => controller.abort()),
  });
  assert.equal(started.id, second.id);
  assert.equal(started.completed, 1);
  assert.match(started.run!, /^g0-1-/);
  const finished = await runQualification({
    id: first.id,
    pool: fakePool(0, 0),
  });
  assert.equal(finished.id, second.id);
  assert.equal(finished.run, started.run);
  assert.equal(finished.status, "rejected");
  const fifo = await runQualification({ pool: fakePool(0, 0) });
  assert.equal(fifo.id, first.id);
  assert.match(fifo.run!, /^g0-2-/);
});
