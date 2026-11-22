import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { QualificationStats, AnchorScore } from "./master-stats.js";
export const digest = (text: string | Buffer) =>
  createHash("sha256").update(text).digest("hex");
export const jsonText = (data: unknown) => JSON.stringify(data, null, 2) + "\n";
export const checkout = () =>
  path.resolve(process.env.FLAG_CARRIERS_LEAGUE_REPO || ".");
export function git(
  args: string[],
  input?: string,
  env?: NodeJS.ProcessEnv,
): string {
  return execFileSync("git", args, {
    cwd: checkout(),
    input,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
  });
}
export const branchName = () =>
  process.env.FLAG_CARRIERS_MASTER_BRANCH || "main";
export const remoteName = () =>
  process.env.FLAG_CARRIERS_MASTER_REMOTE || "origin";
export function fetchMasterHead() {
  const branch = branchName(),
    remote = remoteName();
  git(["check-ref-format", "refs/heads/" + branch]);
  const url = git(["remote", "get-url", remote]).trim();
  // This repository is public; HTTPS fetches also work on hosts with connector-only pushes.
  const fetchRemote =
    /^git@github\.com:SpencerWoo\/bot_flag_carriers(?:\.git)?$/i.test(url)
      ? "https://github.com/SpencerWoo/bot_flag_carriers.git"
      : remote;
  git([
    "fetch",
    "--no-tags",
    fetchRemote,
    "+refs/heads/" + branch + ":refs/league/observed/" + branch,
  ]);
  return git(["rev-parse", "refs/league/observed/" + branch]).trim();
}
export interface MasterRecord {
  generation: number;
  hash: string;
  policyPath: string;
  parent: string | null;
  qualification: string | null;
  promotedAt: string | null;
  theory: string;
  agent: string;
  stats?: QualificationStats;
  anchor?: AnchorScore;
  sourceGeneration?: string;
  engineHash?: string;
}
export interface Snapshot extends MasterRecord {
  source: string;
  head: string;
}
export function readAt(head: string | null, file: string): string {
  if (
    !/^[\w./-]+$/.test(file) ||
    path.isAbsolute(file) ||
    file.split("/").includes("..")
  )
    throw Error("Invalid league path");
  return head
    ? git(["show", head + ":" + file])
    : fs.readFileSync(path.join(checkout(), file), "utf8");
}
export function readMaster(head: string | null): Snapshot {
  const master: MasterRecord = JSON.parse(readAt(head, "league/master.json"));
  const source = readAt(head, master.policyPath);
  if (digest(source) !== master.hash)
    throw Error("Master manifest policy digest mismatch");
  return { ...master, head: head ?? git(["rev-parse", "HEAD"]).trim(), source };
}
export function currentMaster(options: { sync?: boolean } = {}): Snapshot {
  return readMaster(options.sync ? fetchMasterHead() : null);
}
export function historyAt(head: string | null): MasterRecord[] {
  return JSON.parse(readAt(head, "league/history.json"));
}
export interface Publication {
  id: string;
  branch: string;
  expectedHead: string;
  expectedMasterHash: string;
  tree: string;
  commit: string;
  message: string;
  files: { path: string; mode: "100644"; type: "blob"; content: string }[];
}
export function prepareTree(
  master: Snapshot,
  record: MasterRecord,
  source: string,
  extraFiles: Record<string, string>,
): Publication {
  if (
    record.parent !== master.hash ||
    record.generation !== master.generation + 1 ||
    digest(source) !== record.hash
  )
    throw Error("Publication lineage mismatch");
  const history = historyAt(master.head);
  if (history.at(-1)?.hash !== master.hash)
    throw Error("Master history inconsistent");
  const files = Object.entries({
    ...extraFiles,
    [record.policyPath]: source,
    "league/master.json": jsonText(record),
    "league/history.json": jsonText([...history, record]),
  }).map(([file, content]) => ({
    path: file,
    mode: "100644" as const,
    type: "blob" as const,
    content,
  }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flag-publish-"));
  try {
    const env = { GIT_INDEX_FILE: path.join(dir, "index") };
    git(["read-tree", master.head], undefined, env);
    for (const f of files) {
      const sha = git(["hash-object", "-w", "--stdin"], f.content).trim();
      git(
        ["update-index", "--add", "--cacheinfo", f.mode, sha, f.path],
        undefined,
        env,
      );
    }
    const tree = git(["write-tree"], undefined, env).trim();
    const message = "Promote Flag Carriers Master to G" + record.generation;
    const commit = git([
      "-c",
      "user.name=Flag Carriers League",
      "-c",
      "user.email=league@users.noreply.github.com",
      "commit-tree",
      tree,
      "-p",
      master.head,
      "-m",
      message,
    ]).trim();
    return {
      id: record.qualification!,
      branch: branchName(),
      expectedHead: master.head,
      expectedMasterHash: master.hash,
      tree,
      commit,
      message,
      files,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
export function publishTree(p: Publication) {
  if (branchName() !== p.branch)
    throw Error("Publication branch differs from configured Master branch");
  if (
    git(["rev-parse", p.commit + "^"]).trim() !== p.expectedHead ||
    git(["rev-parse", p.commit + "^{tree}"]).trim() !== p.tree
  )
    throw Error("Prepared Git commit mismatch");
  git([
    "push",
    "--force-with-lease=refs/heads/" + p.branch + ":" + p.expectedHead,
    remoteName(),
    p.commit + ":refs/heads/" + p.branch,
  ]);
}
