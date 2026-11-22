// Publish an already qualified Master through the user's existing Codex GitHub app.
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { git, readMaster, type Publication } from "./master-git.js";
import { researchEnvironment } from "./research-runner.js";

const repository = "SpencerWoo/bot_flag_carriers";
const publicRemote = "https://github.com/" + repository + ".git";
const sha = (x: unknown): x is string =>
  typeof x === "string" && /^[a-f0-9]{40}$/.test(x);

type WriteTool =
  "github.create_tree" | "github.create_commit" | "github.update_ref";
type Client = (tool: WriteTool, args: Record<string, unknown>) => Promise<any>;
type VerifyCommit = (
  commit: string,
) => Promise<{ tree: string; parents: string[] }>;

export function verifyPlan(p: Publication) {
  if (
    p.branch !== "main" ||
    !sha(p.expectedHead) ||
    !sha(p.tree) ||
    !sha(p.commit) ||
    !/^g\d+-\d+-[a-f0-9]{12}$/.test(p.id) ||
    !Array.isArray(p.files) ||
    p.files.length !== 6
  )
    throw Error("Invalid Master publication plan");
  if (
    git(["rev-parse", p.commit + "^"]).trim() !== p.expectedHead ||
    git(["rev-parse", p.commit + "^{tree}"]).trim() !== p.tree
  )
    throw Error("Prepared Git parent or tree mismatch");
  const before = readMaster(p.expectedHead),
    after = readMaster(p.commit);
  if (
    before.hash !== p.expectedMasterHash ||
    after.parent !== before.hash ||
    after.generation !== before.generation + 1 ||
    after.qualification !== p.id ||
    after.policyPath !== "league/policies/" + after.hash + ".mjs" ||
    !/^[a-f0-9]{64}$/.test(after.engineHash ?? "") ||
    p.message !== "Promote Flag Carriers Master to G" + after.generation
  )
    throw Error("Prepared Master lineage mismatch");
  const allowed = new Set([
    after.policyPath,
    "league/master.json",
    "league/history.json",
    "league/leaderboard.md",
    "league/anchors/" + after.engineHash + "-g0.json",
    "league/qualifications/" + p.id + ".json",
  ]);
  // Reject extra changed files in the prepared commit as well as extra request entries.
  const changed = git([
    "diff-tree",
    "--no-commit-id",
    "--name-only",
    "-r",
    p.expectedHead,
    p.commit,
  ])
    .trim()
    .split("\n");
  if (changed.some((file) => !allowed.has(file)))
    throw Error("Unexpected file in prepared tree");
  for (const f of p.files) {
    if (
      !allowed.delete(f.path) ||
      f.mode !== "100644" ||
      f.type !== "blob" ||
      typeof f.content !== "string" ||
      git(["show", p.commit + ":" + f.path]) !== f.content
    )
      throw Error("Unexpected file or content in Master publication");
  }
  return git(["rev-parse", p.expectedHead + "^{tree}"]).trim();
}

export async function publishConnected(
  plan: Publication,
  baseTree: string,
  call: Client,
  verify: VerifyCommit,
  readHead: () => string,
) {
  if (
    plan.branch !== "main" ||
    !sha(baseTree) ||
    !sha(plan.expectedHead) ||
    !sha(plan.tree)
  )
    throw Error("Invalid Master target");
  if (readHead() !== plan.expectedHead)
    throw Error("Master head changed before publication");
  const fixed = { repository_full_name: repository };
  const tree = await call("github.create_tree", {
    ...fixed,
    base_tree_sha: baseTree,
    tree_elements: plan.files,
  });
  if ((tree.sha ?? tree.tree_sha ?? tree.tree?.sha) !== plan.tree)
    throw Error("Connected publisher returned a different tree");
  const created = await call("github.create_commit", {
    ...fixed,
    tree_sha: plan.tree,
    parent_sha: plan.expectedHead,
    message: plan.message,
  });
  const commit = created.sha ?? created.commit_sha ?? created.commit?.sha;
  if (!sha(commit))
    throw Error("Connected publisher did not return a commit SHA");
  const checked = await verify(commit);
  if (
    checked.tree !== plan.tree ||
    checked.parents.length !== 1 ||
    checked.parents[0] !== plan.expectedHead
  )
    throw Error("Connected commit has different content or ancestry");
  // This expected SHA guards the race after our first read. The new commit has exactly this parent.
  await call("github.update_ref", {
    ...fixed,
    branch_name: "main",
    sha: commit,
    expected_sha: plan.expectedHead,
    force: false,
  });
  if (readHead() !== commit)
    throw Error("GitHub has not confirmed the promoted Master head");
  return commit;
}

function connector() {
  const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
    cwd: tmpdir(),
    env: researchEnvironment(),
    stdio: ["pipe", "pipe", "ignore"],
  });
  let pending:
      | { id: number; resolve: (v: any) => void; reject: (e: Error) => void }
      | undefined,
    sequence = 0;
  let closed = false;
  const close = () => {
    closed = true;
    pending?.reject(Error("Codex GitHub connector closed"));
    pending = undefined;
    child.kill("SIGKILL");
  };
  child.on("error", close);
  child.on("exit", close);
  child.stdin.on("error", close);
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let data;
    try {
      data = JSON.parse(line);
    } catch {
      close();
      return;
    }
    if (data.method && data.id !== undefined) {
      // Respect any permission request by leaving publication pending for the caller.
      close();
      return;
    }
    if (pending && data.id === pending.id) {
      const waiting = pending;
      pending = undefined;
      if (data.error)
        waiting.reject(Error("Codex rejected GitHub connector request"));
      else waiting.resolve(data.result);
    }
  });
  const rpc = (method: string, params: object): Promise<any> => {
    if (closed || pending)
      return Promise.reject(Error("GitHub connector unavailable"));
    return new Promise((resolve, reject) => {
      pending = { id: ++sequence, resolve, reject };
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: sequence, method, params }) + "\n",
      );
    });
  };
  const deadline = setTimeout(close, 75000);
  const start = async (): Promise<Client> => {
    await rpc("initialize", {
      clientInfo: { name: "flag-carriers-master", version: "1" },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write('{"jsonrpc":"2.0","method":"initialized"}\n');
    const result = await rpc("thread/start", {
      cwd: tmpdir(),
      sandbox: "read-only",
      approvalPolicy: "never",
      ephemeral: true,
      model: "gpt-6.2-astra",
    });
    const threadId = result.thread.id;
    return async (tool, args) => {
      const reply = await rpc("mcpServer/tool/call", {
        threadId,
        server: "codex_apps",
        tool,
        arguments: args,
      });
      if (reply.isError) throw Error("GitHub declined " + tool);
      return reply.structuredContent ?? JSON.parse(reply.content[0].text);
    };
  };
  return {
    start,
    close: () => {
      clearTimeout(deadline);
      close();
      lines.close();
    },
  };
}

function remoteHead() {
  return execFileSync(
    "git",
    ["ls-remote", "--exit-code", publicRemote, "refs/heads/main"],
    {
      env: { ...researchEnvironment(), GIT_TERMINAL_PROMPT: "0" },
      encoding: "utf8",
      timeout: 12000,
      stdio: ["ignore", "pipe", "ignore"],
    },
  ).split(/\s+/)[0];
}

async function verifyRemote(commit: string) {
  // Read the unattached Git object before advancing the branch. New commits may take
  // a moment to propagate across the public REST frontends.
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(
      "https://api.github.com/repos/" + repository + "/git/commits/" + commit,
      {
        signal: AbortSignal.timeout(6000),
        redirect: "error",
        cache: "no-store",
        headers: { "User-Agent": "flag-carriers-master" },
      },
    );
    if (response.ok) {
      const body = await response.json();
      if (body.sha !== commit || !Array.isArray(body.parents)) break;
      return {
        tree: body.tree?.sha,
        parents: body.parents.map((p: { sha: string }) => p.sha),
      };
    }
    if (response.status !== 404) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw Error("Could not verify the connected commit on GitHub");
}

async function main() {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024)
      throw Error("Master publication exceeds size limit");
    chunks.push(chunk);
  }
  const plan: Publication = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const base = verifyPlan(plan);
  const client = connector();
  try {
    console.log(
      await publishConnected(
        plan,
        base,
        await client.start(),
        verifyRemote,
        remoteHead,
      ),
    );
  } finally {
    client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((e) => {
    console.error(String(e.message).slice(0, 250));
    process.exitCode = 1;
  });
