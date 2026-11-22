import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  canonicalPushUrl,
  prepareTree,
  readMaster,
  digest,
  type Publication,
} from "../src/master-git.js";
import { publishConnected, verifyPlan } from "../src/connected-publisher.js";

const head = "a".repeat(40),
  tree = "b".repeat(40),
  commit = "c".repeat(40),
  baseTree = "e".repeat(40);
const plan = {
  branch: "main",
  expectedHead: head,
  tree,
  files: [],
  message: "Promote Flag Carriers Master to G1",
} as unknown as Publication;

test("connected publication checks exact tree and parent, advances only main using a lease, and confirms the head", async () => {
  const writes: { name: string; args: any }[] = [];
  let remote = head;
  const result = await publishConnected(
    plan,
    baseTree,
    async (name, args) => {
      writes.push({ name, args });
      if (name === "github.create_tree") return { sha: tree };
      if (name === "github.create_commit") return { sha: commit };
      remote = commit;
      return {};
    },
    async (sha) => {
      assert.equal(sha, commit);
      return { parents: [head], tree };
    },
    () => remote,
  );
  assert.equal(result, commit);
  assert.equal(writes[0].args.base_tree_sha, baseTree);
  assert.equal(writes[1].args.parent_sha, head);
  assert.deepEqual(writes[2].args, {
    repository_full_name: "SpencerWoo/bot_flag_carriers",
    branch_name: "main",
    sha: commit,
    expected_sha: head,
    force: false,
  });
});
test("a stale head, wrong tree, unexpected parent, or connector denial never advances a ref", async () => {
  for (const fail of ["stale", "tree", "parent", "merge", "denied"]) {
    let updated = false;
    await assert.rejects(
      publishConnected(
        plan,
        baseTree,
        async (name) => {
          if (name === "github.create_tree")
            return { tree_sha: fail === "tree" ? baseTree : tree };
          if (name === "github.create_commit") {
            if (fail === "denied") throw Error("Denied");
            return { commit_sha: commit };
          }
          updated = true;
          return {};
        },
        async () => ({
          tree,
          parents:
            fail === "merge"
              ? [head, head]
              : [fail === "parent" ? baseTree : head],
        }),
        () => (fail === "stale" ? baseTree : head),
      ),
    );
    assert.equal(updated, false, fail);
  }
  for (const url of [
    "git@github.com:SpencerWoo/bot_flag_carriers.git",
    "https://github.com/SpencerWoo/bot_flag_carriers",
    "ssh://git@github.com/SpencerWoo/bot_flag_carriers.git",
  ])
    assert.equal(canonicalPushUrl(url), true);
  for (const url of [
    "git@github.com:SpencerWoo/other",
    "git@github.com.evil:SpencerWoo/bot_flag_carriers",
    "https://example.com/SpencerWoo/bot_flag_carriers",
    "https://github.com/SpencerWoo/bot_flag_carriers\nhttps://example.org",
  ])
    assert.equal(canonicalPushUrl(url), false);
});
test("only six prepared league files with verified local lineage may be sent to the GitHub app", () => {
  const dir = mkdtempSync(join(tmpdir(), "flag-connected-")),
    env = process.env.FLAG_CARRIERS_LEAGUE_REPO;
  try {
    process.env.FLAG_CARRIERS_LEAGUE_REPO = dir;
    const g = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    g("init", "-b", "main");
    g("config", "user.name", "test");
    g("config", "user.email", "test@example.com");
    mkdirSync(join(dir, "league"));
    mkdirSync(join(dir, "policies"));
    const old = "export default () => 0;",
      next = "export default () => 1;",
      hash = digest(next),
      engine = digest("engine"),
      id = "g0-1-123456789abc";
    const first = {
      generation: 0,
      hash: digest(old),
      policyPath: "policies/master-g0.mjs",
      parent: null,
      qualification: null,
      promotedAt: null,
      theory: "base",
      agent: "base",
    };
    writeFileSync(join(dir, first.policyPath), old);
    writeFileSync(join(dir, "league/master.json"), JSON.stringify(first));
    writeFileSync(join(dir, "league/history.json"), JSON.stringify([first]));
    g("add", "--all");
    g("commit", "-m", "base");
    const master = readMaster(g("rev-parse", "HEAD"));
    const promotion = prepareTree(
      master,
      {
        ...first,
        generation: 1,
        hash,
        policyPath: "league/policies/" + hash + ".mjs",
        parent: first.hash,
        qualification: id,
        engineHash: engine,
      },
      next,
      {
        ["league/qualifications/" + id + ".json"]: "{}",
        ["league/anchors/" + engine + "-g0.json"]: "{}",
        "league/leaderboard.md": "G1",
      },
    );
    assert.equal(verifyPlan(promotion), g("rev-parse", "HEAD^{tree}"));
    assert.throws(() =>
      verifyPlan({
        ...promotion,
        files: promotion.files.map((f, i) =>
          i ? f : { ...f, content: "unexpected" },
        ),
      }),
    );
    assert.throws(() =>
      verifyPlan({
        ...promotion,
        files: promotion.files.map((f, i) =>
          i ? f : { ...f, path: "src/cli.ts" },
        ),
      }),
    );
    assert.throws(() => verifyPlan({ ...promotion, branch: "other" }));
  } finally {
    if (env === undefined) delete process.env.FLAG_CARRIERS_LEAGUE_REPO;
    else process.env.FLAG_CARRIERS_LEAGUE_REPO = env;
    rmSync(dir, { recursive: true, force: true });
  }
});
