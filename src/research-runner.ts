// The model returns an artifact. Only the coordinator executes the arena or publishes.
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";

export const RESEARCH_MODEL = "gpt-6.2-astra";
export const RESEARCH_EFFORT = "ultra";
// Keep the winning researcher's history when upgrading an existing league.
export const SOLO_AGENT = "carrier";
export const researchFocus =
  "Find the largest remaining weakness in the current Master. Consider opening routes, flag delivery, public rank inference, and denying enemy wins. Choose a theory based on prior results.";

export interface ResearchMaster {
  generation: number;
  hash: string;
  head: string;
  source: string;
}

export interface ResearchProposal {
  agent: string;
  theory: string;
  source: string;
  file: string;
  parent: string;
  generation: number;
  iteration: number;
}

export function privateJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function jsonOr<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error: any) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

const policySchema = {
  type: "object",
  additionalProperties: false,
  properties: { theory: { type: "string" }, source: { type: "string" } },
  required: ["theory", "source"],
};

export function parseResearchProposal(raw: string) {
  if (Buffer.byteLength(raw) > 144 * 1024)
    throw Error("Research output exceeded size limit");
  const { theory, source } = JSON.parse(raw);
  if (typeof theory !== "string" || !theory.trim() || theory.length > 2000)
    throw Error("Expected a concise candidate theory");
  if (
    typeof source !== "string" ||
    !source.includes("export default") ||
    Buffer.byteLength(source) > 128 * 1024
  )
    throw Error(
      "Expected a self-contained default-exported policy under 128 KiB",
    );
  return { theory: theory.trim(), source: source.trimEnd() + "\n" };
}

export function prepareResearchTree(
  repo: string,
  worktree: string,
  master: ResearchMaster,
) {
  fs.mkdirSync(path.dirname(worktree), { recursive: true, mode: 0o700 });
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60000,
    }).trim();
  if (!fs.existsSync(path.join(worktree, ".git")))
    git(repo, "worktree", "add", "--quiet", "--detach", worktree, master.head);
  else if (git(worktree, "rev-parse", "HEAD") !== master.head)
    git(worktree, "checkout", "--detach", master.head);
}

export function makeResearchPrompt(
  role: string,
  focus: string,
  master: ResearchMaster,
  feedback: string,
  repo: string,
) {
  const implementation = fs.readFileSync(
    path.join(repo, "src/strategy.ts"),
    "utf8",
  );
  const contract = fs.readFileSync(path.join(repo, "src/core.ts"), "utf8");
  return [
    "You are an independent Flag Carriers game policy researcher. Return ONLY the requested JSON object. Develop your own algorithmic hypothesis and executable policy. The host will run your policy in seeded self-play against the current Master, and feed the result back to you. Do not call tools, read files, access the network, or execute games yourself. You have all the information below.",
    "Your research slot is " +
      role +
      ". Suggested area: " +
      focus +
      ". You may pursue a different theory if evidence warrants it.",
    "Master generation " +
      master.generation +
      ", policy SHA-256 " +
      master.hash +
      ". Return a concise falsifiable theory and the complete source of a single self-contained JavaScript ESM (.mjs) module. No TypeScript, imports, external modules, I/O, Date, performance, global timers, unseeded randomness, game IDs, or simulation seeds. This is an online strategic board game. Use only player-visible observations. Avoid expensive per-move loops over hypothetical futures. Make a substantive focused change. Keep code readable.",
    "API: export default ({random,baseline,legalActions,board,distances}) => {const previous=baseline(); return {observe(view){previous.observe(view)},choose(view){return previous.choose(view)},setup(view){return previous.setup(view)}}}. baseline(optionalWeights) is the fixed V0 game policy below, not a pointer to a changing Master. Preserve improvements by starting from the supplied Master source. Return one legal action exactly as offered. choose(view) handles moves and reinforcements. setup(view) returns your carrier rank string, for example '10'. baseline can handle reinforcements, setup and fallback. board(mode) provides V (center node), nb(pos), rays(pos), lake(pos), castle(pos), recruit, flagStart, seats; distances(mode,to)[from] is shortest board distance. view.turn is active color R/B/Y/G. Pieces carry own or enemy flags. A flag reaching V awards victory to its OWNER. Default deployment uses Marshal flag carrier. Combat winner is higher rank except attacking spy (1) beats marshal (10), artillery (C) loses duels; victories also come through elimination. Official topology includes RING adjacent to V. Use strict JS and the complete source as a string.",
    "Master policy:\n" + master.source,
    "Existing exported types and action construction:\n" + contract,
    "Built-in baseline policy implementation:\n" + implementation,
    feedback
      ? "Feedback from earlier development attempts in this slot; do not repeat unsupported theories:\n" +
        feedback
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function researchEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "HOME",
    "CODEX_HOME",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "USER",
    "LOGNAME",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

export interface ModelJob {
  repo: string;
  folder: string;
  worktree: string;
  agent: string;
  focus: string;
  master: ResearchMaster;
  feedback: string;
  deadline: number;
  signal?: AbortSignal;
}
// A stopped coordinator can leave a model process alive. Adopt that exact process, identified
// by its unique CLI output path. A recycled PID with an unrelated command is never signalled.
function ownsModelProcess(pid: number, output: string): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    if (process.platform === "linux") {
      const argv = fs
        .readFileSync("/proc/" + pid + "/cmdline", "utf8")
        .split("\0");
      return argv.some(
        (s, i) => s === "--output-last-message" && argv[i + 1] === output,
      );
    }
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).includes("--output-last-message " + output + " ");
  } catch {
    return false;
  }
}
export async function generatePolicy(
  job: ModelJob,
): Promise<{ theory: string; source: string }> {
  const { folder, worktree } = job;
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const schemaFile = path.join(folder, "schema.json"),
    output = path.join(folder, "response.json"),
    logFile = path.join(folder, "model.jsonl");
  const owner = jsonOr<{ pid: number; output: string } | null>(
    path.join(folder, "owner.json"),
    null,
  );
  if (owner?.output === output && ownsModelProcess(owner.pid, output)) {
    while (ownsModelProcess(owner.pid, output)) {
      if (job.signal?.aborted || Date.now() >= job.deadline) {
        try {
          process.kill(-owner.pid, "SIGKILL");
        } catch {}
        throw Error("Adopted researcher stopped at its deadline");
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (fs.existsSync(output))
    return parseResearchProposal(fs.readFileSync(output, "utf8"));
  if (job.signal?.aborted || Date.now() >= job.deadline)
    throw Error("Research deadline reached");
  prepareResearchTree(job.repo, worktree, job.master);
  privateJson(schemaFile, policySchema);
  const prompt = makeResearchPrompt(
    job.agent,
    job.focus,
    job.master,
    job.feedback,
    job.repo,
  );
  const args = [
    "--ask-for-approval",
    "never",
    "exec",
    "--ignore-user-config",
    "--ignore-rules",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "--model",
    RESEARCH_MODEL,
    "-c",
    'model_reasoning_effort="' + RESEARCH_EFFORT + '"',
    "--disable",
    "apps",
    "--disable",
    "plugins",
    "--disable",
    "shell_tool",
    "--disable",
    "unified_exec",
    "--disable",
    "in_app_browser",
    "--disable",
    "shell_snapshot",
    "--disable",
    "multi_agent",
    "-c",
    'web_search="disabled"',
    "--json",
    "--output-schema",
    schemaFile,
    "--output-last-message",
    output,
    "-",
  ];
  const fd = fs.openSync(logFile, "w", 0o600);
  const child = spawn("codex", args, {
    cwd: worktree,
    env: researchEnvironment(),
    detached: true,
    stdio: ["pipe", fd, fd],
  });
  fs.closeSync(fd);
  if (child.pid)
    privateJson(path.join(folder, "owner.json"), {
      pid: child.pid,
      output,
      startedAt: Date.now(),
    });
  let expired = false;
  const stop = () => {
    expired = true;
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error: any) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  };
  const timer = setTimeout(stop, Math.max(1, job.deadline - Date.now()));
  job.signal?.addEventListener("abort", stop, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) =>
        code === 0
          ? resolve()
          : reject(
              Error(
                expired
                  ? "Researcher stopped at its deadline"
                  : `Codex exited with ${signal ?? code}; inspect ${logFile}`,
              ),
            ),
      );
      child.stdin!.on("error", () => {});
      child.stdin!.end(prompt);
    });
    return parseResearchProposal(fs.readFileSync(output, "utf8"));
  } finally {
    clearTimeout(timer);
    job.signal?.removeEventListener("abort", stop);
  }
}
