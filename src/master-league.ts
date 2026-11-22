import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { refereeFingerprint } from "./master-fingerprint.js";
import { LeaguePool, type LeaguePairJob } from "./league-pool.js";
import { stopping } from "./control.js";
import {
  currentMaster,
  digest,
  fetchMasterHead,
  historyAt,
  jsonText,
  prepareTree,
  publishTree,
  readAt,
  readMaster,
  type MasterRecord,
  type Snapshot,
} from "./master-git.js";
import {
  adjudicate,
  anchorScore,
  schedule,
  HOLDOUT_PAIRS,
  ANCHOR_PAIRS,
  isScore,
  type PairScore,
  type AnchorScore,
} from "./master-stats.js";
import {
  freeze,
  get,
  local,
  list,
  queue,
  update,
  pin,
  put,
  refereeLock,
  type QueueEntry,
} from "./master-store.js";
import { leaderboard, trialsTable } from "./master-board.js";
import { execFileSync } from "node:child_process";
export { currentMaster } from "./master-git.js";
export {
  enqueueCandidate,
  hasPendingCandidates,
  queue,
} from "./master-store.js";

export interface QualificationOptions {
  id?: string;
  workers?: number;
  pool?: Pick<LeaguePool, "pair" | "size">;
  deadline?: number;
  signal?: AbortSignal;
  publish?: "git" | "prepare";
}
type Status =
  | "idle"
  | "incomplete"
  | "rejected"
  | "prepared"
  | "promoted"
  | "stale"
  | "failed";
export interface QualificationOutcome {
  status: Status;
  id?: string;
  run?: string;
  generation?: number;
  planPath?: string;
  reason?: string;
  completed?: number;
}
interface Run {
  id: string;
  candidate: string;
  parent: string;
  generation: number;
  attempt: number;
  engine: string;
  seedKey: string;
  fillers: string[];
  created: string;
  refereeRevision: string;
}
const keyFor = (run: Run) => "runs/" + run.id;
const policyFile = (hash: string) => local("artifacts/" + hash + ".mjs");
const fixedKey = "flag-carriers-fixed-anchor-v1";
const moduleRoot = fileURLToPath(new URL(".", import.meta.url));
function engineDigest() {
  const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  return digest(
    refereeFingerprint() +
      fs.readFileSync(path.join(moduleRoot, "master-stats" + ext), "utf8") +
      fs.readFileSync(path.join(moduleRoot, "master-league" + ext), "utf8"),
  );
}
function keyArtifacts(master: Snapshot) {
  const src = (file: string) => readAt(master.head, file);
  const fixed = [
    src("league/policies/aggressive.mjs"),
    src("league/policies/runner.mjs"),
  ].map((s) => digest(fs.readFileSync(pin(s))));
  const g0 = historyAt(master.head)[0];
  const original = src(g0.policyPath);
  if (digest(original) !== g0.hash) throw Error("G0 policy hash mismatch");
  pin(original);
  pin(master.source);
  const historical = historyAt(master.head)
    .slice(0, -1)
    .slice(-3)
    .map((record) => {
      const s = src(record.policyPath);
      if (digest(s) !== record.hash)
        throw Error("Historical policy hash mismatch");
      pin(s);
      return record.hash;
    });
  return { fixed, g0, roster: [...fixed, ...historical] };
}
function newRun(
  sub: QueueEntry,
  master: Snapshot,
  engine: string,
  fillers: string[],
): Run {
  const records = list("attempts/" + master.hash).map((file) =>
    get<Run>("attempts/" + master.hash + "/" + file, null!),
  );
  const existing = records.find(
    (r) => r.candidate === sub.hash && r.engine === engine,
  );
  if (existing) return existing;
  const attempt = Math.max(0, ...records.map((r) => r.attempt)) + 1;
  const run = {
    id:
      "g" +
      master.generation +
      "-" +
      attempt +
      "-" +
      randomBytes(6).toString("hex"),
    parent: master.hash,
    candidate: sub.hash,
    generation: master.generation,
    refereeRevision: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: moduleRoot,
      encoding: "utf8",
    }).trim(),
    attempt,
    engine,
    seedKey: randomBytes(32).toString("hex"),
    fillers,
    created: new Date().toISOString(),
  };
  if (
    !freeze(
      "attempts/" +
        master.hash +
        "/" +
        String(attempt).padStart(8, "0") +
        ".json",
      run,
    )
  )
    throw Error("Referee attempt allocation collision");
  return run;
}
interface MatchOptions {
  folder: string;
  total: number;
  key: string;
  challenger: string;
  master: string;
  fillers: string[];
  pool: Pick<LeaguePool, "pair" | "size">;
  deadline: number;
  signal?: AbortSignal;
  workers: number;
}
async function tournament(
  o: MatchOptions,
): Promise<{ rows: PairScore[]; ended: boolean }> {
  const saved = new Map<number, PairScore>();
  for (const f of list(o.folder)) {
    const r = get<PairScore>(o.folder + "/" + f, null!);
    if (
      !isScore(r) ||
      r.index >= o.total ||
      schedule(r.index, o.key).mode !== r.mode
    )
      throw Error("Corrupt referee checkpoint");
    saved.set(r.index, r);
  }
  const missing = Array.from({ length: o.total }, (_, i) => i).filter(
    (i) => !saved.has(i),
  );
  let cursor = 0,
    halt = false;
  let error: Error | undefined;
  const interrupted = () =>
    stopping || o.signal?.aborted || Date.now() >= o.deadline;
  async function worker() {
    while (cursor < missing.length && !halt && !interrupted()) {
      const index = missing[cursor++],
        s = schedule(index, o.key);
      const fillers = Array.from({ length: s.mode - 2 }, (_, i) =>
        policyFile(o.fillers[(s.boardIndex + i) % o.fillers.length]),
      );
      const job: LeaguePairJob = {
        mode: s.mode,
        seed: s.seed,
        slots: s.slots,
        challenger: policyFile(o.challenger),
        master: policyFile(o.master),
        fillers,
      };
      try {
        const p = await o.pool.pair(job, {
          priority: "qualification",
          deadline: o.deadline,
          signal: o.signal,
        });
        const r = {
          index,
          mode: s.mode,
          candidateWins: p.candidateWins,
          masterWins: p.masterWins,
          draws: p.games.filter((g) => g.draw).length,
          complete: p.complete,
        };
        if (!isScore(r))
          throw Error("Referee worker returned an invalid result");
        if (!r.complete)
          throw Error("Unfinished match reached the arena game limit");
        freeze(o.folder + "/" + index + ".json", r);
        saved.set(index, r);
      } catch (e: any) {
        halt = true;
        if (!interrupted()) error = e;
      }
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(missing.length, o.workers, o.pool.size) },
      () => worker(),
    ),
  );
  if (error) throw error;
  return {
    rows: [...saved.values()].sort((a, b) => a.index - b.index),
    ended: saved.size === o.total,
  };
}
function outcome(
  status: Status,
  s: QueueEntry,
  r: Run,
  extra: Partial<QualificationOutcome> = {},
): QualificationOutcome {
  return { status, id: s.id, run: r.id, generation: r.generation, ...extra };
}
function stale(sub: QueueEntry, r: Run) {
  freeze(keyFor(r) + "/stale.json", {
    frozenAgainst: r.parent,
    time: new Date().toISOString(),
  });
  update(sub.id, { state: "queued" });
  return outcome("stale", sub, r, {
    reason: "Canonical Master advanced; requeued for new seeds and comparison",
  });
}
async function qualifyOne(
  sub: QueueEntry,
  master: Snapshot,
  opts: QualificationOptions,
  pool: Pick<LeaguePool, "pair" | "size">,
): Promise<QualificationOutcome> {
  const engine = engineDigest(),
    artifacts = keyArtifacts(master);
  const publicRecord =
    historyAt(master.head).find(
      (g) =>
        g.qualification && g.qualification === sub.run && g.hash === sub.hash,
    ) || (master.hash === sub.hash ? master : undefined);
  if (publicRecord) {
    update(sub.id, {
      state: "promoted",
      run: publicRecord.qualification ?? undefined,
    });
    return {
      id: sub.id,
      status: "promoted",
      run: publicRecord.qualification ?? undefined,
      generation: publicRecord.generation,
    };
  }
  if (
    !fs.existsSync(policyFile(sub.hash)) ||
    digest(fs.readFileSync(policyFile(sub.hash))) !== sub.hash
  )
    throw Error("Candidate artifact hash mismatch");
  const r = newRun(sub, master, engine, artifacts.roster);
  freeze(keyFor(r) + "/manifest.json", r);
  update(sub.id, { state: "running", run: r.id });
  const workers = opts.workers ?? pool.size;
  if (!Number.isInteger(workers) || workers < 1)
    throw Error("Invalid worker count");
  const shared = {
    deadline: opts.deadline ?? Date.now() + 7200000,
    signal: opts.signal,
    pool,
    workers,
  };
  const accepted = get<MasterRecord | null>(keyFor(r) + "/accepted.json", null);
  let record = accepted;
  const anchorRoot = "anchor-samples/" + engine;
  async function anchor(hash: string): Promise<AnchorScore | null> {
    const o = await tournament({
      ...shared,
      folder: anchorRoot + "/" + hash,
      total: ANCHOR_PAIRS,
      key: fixedKey,
      challenger: hash,
      master: artifacts.g0.hash,
      fillers: artifacts.fixed,
    });
    return o.ended ? anchorScore(o.rows) : null;
  }
  let g0Anchor: AnchorScore | null = null;
  try {
    if (!record) {
      const t = await tournament({
        ...shared,
        folder: keyFor(r) + "/pairs",
        total: HOLDOUT_PAIRS,
        key: r.seedKey,
        challenger: sub.hash,
        master: master.hash,
        fillers: r.fillers,
      });
      if (!t.ended)
        return outcome("incomplete", sub, r, { completed: t.rows.length });
      if (engineDigest() !== r.engine)
        throw Error(
          "Referee build changed during qualification; rerun on a stable build",
        );
      const stats = adjudicate(t.rows, r.attempt);
      freeze(keyFor(r) + "/result.json", stats);
      const actual = readMaster(fetchMasterHead());
      if (actual.hash !== r.parent) return stale(sub, r);
      if (!stats.passed) {
        update(sub.id, { state: "rejected", run: r.id });
        return outcome("rejected", sub, r, {
          completed: t.rows.length,
          reason: "Promotion threshold not met",
        });
      }
      g0Anchor = await anchor(artifacts.g0.hash);
      if (!g0Anchor)
        return outcome("incomplete", sub, r, {
          completed: t.rows.length,
          reason: "Measuring G0 fixed anchor",
        });
      const score = await anchor(sub.hash);
      if (!score)
        return outcome("incomplete", sub, r, {
          completed: t.rows.length,
          reason: "Measuring challenger fixed anchor",
        });
      record = {
        generation: master.generation + 1,
        hash: sub.hash,
        parent: master.hash,
        policyPath: "league/policies/" + sub.hash + ".mjs",
        qualification: r.id,
        promotedAt: new Date().toISOString(),
        theory: sub.theory,
        agent: sub.agent,
        sourceGeneration: sub.parent,
        engineHash: engine,
        stats,
        anchor: score,
      };
      freeze(keyFor(r) + "/accepted.json", record);
    }
  } catch (e: any) {
    if (stopping || opts.signal?.aborted || Date.now() >= shared.deadline)
      return outcome("incomplete", sub, r, {
        reason: "Deadline or stop signal",
      });
    // A rejected policy cannot promote or silently receive another fresh holdout.
    // Infrastructure failures retain the run and its already completed pairs for retry.
    if (
      /policy|illegal action|game limit|invalid result|timed out/i.test(
        e.message,
      ) &&
      !/(deadline|slot|worker exited)/i.test(e.message)
    ) {
      update(sub.id, { state: "failed", run: r.id, error: e.message });
      return outcome("failed", sub, r, { reason: e.message });
    }
    throw e;
  }
  if (!record) throw Error("Missing accepted record");
  if (engineDigest() !== r.engine)
    throw Error("Referee build changed before publication");
  const latest = readMaster(fetchMasterHead());
  if (latest.hash !== r.parent) return stale(sub, r);
  if (!g0Anchor) {
    g0Anchor = await anchor(artifacts.g0.hash);
    if (!g0Anchor)
      return outcome("incomplete", sub, r, {
        reason: "Measuring G0 fixed anchor",
      });
  }
  const records = [...historyAt(latest.head), record];
  const evidence = {
    ...r,
    pairedOutcomes: Array.from({ length: HOLDOUT_PAIRS }, (_, i) => {
      const pair = get<PairScore>(keyFor(r) + "/pairs/" + i + ".json", null!);
      return [pair.candidateWins, pair.masterWins, pair.draws].join("");
    }).join(" "),
    outcomeFormat:
      "Seed-index order; each triple counts candidate wins, Master wins and draws in its two legs. Other-seat wins are the remaining games.",
    stats: record.stats,
    anchor: record.anchor,
    anchorKey: fixedKey,
    policyPath: record.policyPath,
  };
  const plan = prepareTree(
    latest,
    record,
    fs.readFileSync(policyFile(sub.hash), "utf8"),
    {
      ["league/qualifications/" + r.id + ".json"]: jsonText(evidence),
      ["league/anchors/" + engine + "-g0.json"]: jsonText(g0Anchor),
      "league/leaderboard.md": leaderboard(records, {
        [artifacts.g0.hash]: g0Anchor,
      }),
    },
  );
  const planFile = keyFor(r) + "/publication.json";
  put(planFile, plan);
  update(sub.id, { state: "prepared", run: r.id });
  if (opts.publish === "prepare")
    return outcome("prepared", sub, r, { planPath: local(planFile) });
  try {
    publishTree(plan);
  } catch {
    const now = readMaster(fetchMasterHead());
    if (now.qualification === r.id) {
      update(sub.id, { state: "promoted", run: r.id });
      return outcome("promoted", sub, r, { generation: now.generation });
    }
    if (now.hash !== r.parent) return stale(sub, r);
    return outcome("prepared", sub, r, {
      planPath: local(planFile),
      reason:
        now.head !== latest.head
          ? "Branch head changed; rerun to prepare against latest head"
          : "Git push unavailable; submit this exact tree with expected-head guard or retry",
    });
  }
  const published = readMaster(fetchMasterHead());
  if (
    published.qualification !== r.id &&
    !historyAt(published.head).some((x) => x.qualification === r.id)
  )
    throw Error("Could not verify publication");
  update(sub.id, { state: "promoted", run: r.id });
  return outcome("promoted", sub, r, { generation: record.generation });
}
export async function runQualification(
  opts: QualificationOptions = {},
): Promise<QualificationOutcome> {
  const release = await refereeLock();
  let dedicated: LeaguePool | undefined;
  try {
    const entries = queue();
    const selected =
      opts.id === undefined ? undefined : entries.find((s) => s.id === opts.id);
    if (opts.id !== undefined && !selected)
      throw Error("Unknown Master submission ID");
    const active = entries.find(
      (s) => s.state === "running" || s.state === "prepared",
    );
    if (!active && selected && selected.state !== "queued")
      throw Error("Selected submission already " + selected.state);
    const next =
      active || selected || entries.find((s) => s.state === "queued");
    if (!next) return { status: "idle" };
    if (
      stopping ||
      opts.signal?.aborted ||
      Date.now() >= (opts.deadline ?? Infinity)
    )
      return { id: next.id, status: "incomplete" };
    const master = currentMaster({ sync: true });
    const pool = opts.pool || (dedicated = new LeaguePool(opts.workers));
    return await qualifyOne(next, master, opts, pool);
  } finally {
    try {
      await dedicated?.close();
    } finally {
      await release();
    }
  }
}
// Open trials report only progress. Holdout outcomes are released after the complete run.
function trialRows() {
  return queue().map((s) => {
    const folder = "runs/" + s.run;
    const stats = s.run
      ? get<ReturnType<typeof adjudicate> | null>(folder + "/result.json", null)
      : null;
    const manifest = s.run
      ? get<Run | null>(folder + "/manifest.json", null)
      : null;
    return {
      ...s,
      generation: manifest?.generation,
      completed: s.run ? list(folder + "/pairs").length : 0,
      edge: stats?.overall.edge,
    };
  });
}
export async function masterCommand(args: string[]) {
  const [command = "status"] = args;
  function val(name: string) {
    const i = args.indexOf("--" + name);
    return i < 0 ? undefined : args[i + 1];
  }
  if (command === "status") {
    const m = currentMaster({ sync: args.includes("--sync") });
    return {
      generation: m.generation,
      hash: m.hash,
      policyPath: m.policyPath,
      head: m.head,
      pending: queue().filter((e) =>
        ["running", "queued", "prepared"].includes(e.state),
      ).length,
    };
  }
  if (command === "queue") return trialRows();
  if (command === "leaderboard") {
    const head = args.includes("--sync") ? fetchMasterHead() : null;
    return readAt(head, "league/leaderboard.md") + trialsTable(trialRows());
  }
  if (command === "submit") {
    const file = val("candidate"),
      theory = val("theory");
    if (!file || !theory)
      throw Error("Use master submit --candidate FILE --theory TEXT");
    const { enqueueCandidate } = await import("./master-store.js");
    return enqueueCandidate({
      source: fs.readFileSync(file, "utf8"),
      parent: val("parent") || currentMaster({ sync: true }).hash,
      agent: val("agent") || "manual",
      theory,
    });
  }
  if (command === "qualify" || command === "publish") {
    const minutes = Number(val("minutes") ?? 120),
      workers = val("workers");
    if (!Number.isFinite(minutes) || minutes <= 0)
      throw Error("Invalid minutes");
    const id = val("id");
    if (args.includes("--id") && (!id || id.startsWith("--")))
      throw Error("Missing submission ID after --id");
    return runQualification({
      id,
      deadline: Date.now() + minutes * 60000,
      workers: workers ? Number(workers) : undefined,
      publish: args.includes("--prepare") ? "prepare" : "git",
    });
  }
  throw Error("Unknown master command");
}
