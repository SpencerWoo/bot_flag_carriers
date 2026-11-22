import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  generatePolicy,
  privateJson,
  jsonOr,
  SOLO_AGENT,
  researchFocus,
  RESEARCH_EFFORT,
  RESEARCH_MODEL,
  type ModelJob,
  type ResearchMaster,
  type ResearchProposal,
} from "./research-runner.js";

type MaybePromise<T> = T | Promise<T>;
export type { ResearchMaster, ResearchProposal } from "./research-runner.js";
export interface ResearchScreen {
  qualified: boolean;
  summary: string;
}
export interface ResearchersOptions {
  repo: string;
  directory: string;
  deadline: number;
  master: () => MaybePromise<ResearchMaster>;
  screen: (
    proposal: ResearchProposal,
    deadline: number,
    signal?: AbortSignal,
  ) => Promise<ResearchScreen>;
  submit: (proposal: ResearchProposal) => MaybePromise<unknown>;
  notice?: (event: {
    type: string;
    agent: string;
    iteration: number;
    [key: string]: unknown;
  }) => void;
  maxIterations?: number;
  agentTimeoutMs?: number;
  signal?: AbortSignal;
  generate?: (job: ModelJob) => Promise<{ source: string; theory: string }>;
}
type Stage =
  | "generating"
  | "generated"
  | "screening"
  | "qualified"
  | "submitted"
  | "rejected"
  | "stale"
  | "failed";
interface Attempt {
  agent: string;
  iteration: number;
  parent: string;
  generation: number;
  head: string;
  stage: Stage;
  model: string;
  effort: string;
  theory?: string;
  summary?: string;
  hash?: string;
}
export interface ResearchSlotSummary {
  agent: string;
  attempts: number;
  submitted: number;
  failures: number;
}

function pastAttempts(directory: string): Attempt[] {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
    .map((e) =>
      jsonOr<Attempt | null>(path.join(directory, e.name, "state.json"), null),
    )
    .filter((a): a is Attempt => a !== null)
    .sort((a, b) => a.iteration - b.iteration);
}
const isFinal = (s: Stage) =>
  ["submitted", "rejected", "stale", "failed"].includes(s);
const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const digest = (source: string) =>
  createHash("sha256").update(source).digest("hex");

/** One researcher retains its history across proposals and Master generations. */
export async function runResearchers(options: ResearchersOptions) {
  if (!Number.isFinite(options.deadline))
    throw Error("Researchers need a finite deadline");
  if (
    options.maxIterations !== undefined &&
    (!Number.isInteger(options.maxIterations) || options.maxIterations < 0)
  )
    throw Error("maxIterations must be a nonnegative integer");
  if (
    options.agentTimeoutMs !== undefined &&
    (!Number.isFinite(options.agentTimeoutMs) || options.agentTimeoutMs <= 0)
  )
    throw Error("agentTimeoutMs must be positive");
  const repo = path.resolve(options.repo),
    directory = path.resolve(options.directory);
  const active = () =>
    Date.now() < options.deadline && !options.signal?.aborted;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lease = path.join(directory, "coordinator.pid");
  const acquire = () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.writeFileSync(lease, String(process.pid), {
          flag: "wx",
          mode: 0o600,
        });
        return;
      } catch (error: any) {
        if (error.code !== "EEXIST") throw error;
      }
      const existing = Number(fs.readFileSync(lease, "utf8"));
      if (!Number.isSafeInteger(existing) || existing < 1)
        throw Error("Invalid researcher coordinator lease");
      try {
        process.kill(existing, 0);
      } catch (error: any) {
        if (error.code === "ESRCH") {
          fs.unlinkSync(lease);
          continue;
        }
        throw error;
      }
      throw Error("Research coordinator already active for this session");
    }
    throw Error("Could not acquire research session lease");
  };
  acquire();
  const stopController = new AbortController();
  const abort = () => stopController.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, Math.max(1, options.deadline - Date.now()));
  async function slot(
    agent: string,
    focus: string,
  ): Promise<ResearchSlotSummary> {
    const own = path.join(directory, agent),
      worktree = path.join(own, "worktree");
    fs.mkdirSync(own, { recursive: true, mode: 0o700 });
    const totals = { agent, attempts: 0, submitted: 0, failures: 0 };
    let consecutiveFailures = 0;
    while (
      active() &&
      !stopController.signal.aborted &&
      totals.attempts < (options.maxIterations ?? Infinity)
    ) {
      const previous = pastAttempts(own);
      const last = previous.at(-1);
      const resumed = last && !isFinal(last.stage) ? last : undefined;
      const iteration = resumed?.iteration ?? (last?.iteration ?? 0) + 1;
      const folder = path.join(own, String(iteration)),
        manifest = path.join(folder, "state.json");
      const master = await options.master();
      const state: Attempt = resumed ?? {
        agent,
        iteration,
        parent: master.hash,
        generation: master.generation,
        head: master.head,
        stage: "generating",
        model: RESEARCH_MODEL,
        effort: RESEARCH_EFFORT,
      };
      const record = (stage: Stage, changes: Partial<Attempt> = {}) => {
        Object.assign(state, changes, { stage });
        privateJson(manifest, state);
        options.notice?.({
          type: stage,
          agent,
          iteration,
          parent: state.parent,
          generation: state.generation,
          theory: state.theory,
          summary: state.summary,
          file: path.join(folder, "candidate.mjs"),
        });
      };
      totals.attempts++;
      try {
        if (state.parent !== master.hash) {
          record("stale", {
            summary:
              "Master advanced. Form a revised proposal on the new parent.",
          });
          continue;
        }
        const file = path.join(folder, "candidate.mjs");
        if (!state.hash || !fs.existsSync(file)) {
          record("generating");
          const recent = previous
            .filter((attempt) => isFinal(attempt.stage))
            .slice(-4);
          const notes = recent
            .map(
              (a) =>
                `G${a.generation} ${a.stage} — ${a.theory ?? ""} — ${a.summary ?? ""}`,
            )
            .join("\n")
            .slice(-5000);
          const latestCandidate = recent.findLast((attempt) => attempt.hash);
          const saved = latestCandidate
            ? path.join(own, String(latestCandidate.iteration), "candidate.mjs")
            : null;
          const previousSource =
            saved && fs.existsSync(saved) ? fs.readFileSync(saved, "utf8") : "";
          const feedback =
            notes +
            (previousSource && previousSource.length <= 18000
              ? "\nYour last tested source:\n" + previousSource
              : "");
          const answer = await (options.generate ?? generatePolicy)({
            repo,
            folder,
            worktree,
            agent,
            focus,
            master,
            feedback,
            deadline: Math.min(
              options.deadline,
              Date.now() + (options.agentTimeoutMs ?? 15 * 60000),
            ),
            signal: stopController.signal,
          });
          fs.writeFileSync(file, answer.source, { mode: 0o600 });
          fs.copyFileSync(file, path.join(worktree, "candidate.mjs"));
          record("generated", {
            theory: answer.theory,
            hash: digest(answer.source),
          });
        }
        if (!active() || stopController.signal.aborted) break;
        const source = fs.readFileSync(file, "utf8");
        if (digest(source) !== state.hash)
          throw Error("Saved research artifact hash changed");
        if ((await options.master()).hash !== state.parent) {
          record("stale", {
            summary:
              "Master advanced before screening. Reassess this theory on the latest policy.",
          });
          continue;
        }
        const proposal: ResearchProposal = {
          agent,
          iteration,
          parent: state.parent,
          generation: state.generation,
          theory: state.theory!,
          source,
          file,
        };
        if (state.stage !== "qualified") {
          record("screening");
          const result = await options.screen(
            proposal,
            options.deadline,
            stopController.signal,
          );
          if (!active() || stopController.signal.aborted) break;
          record(result.qualified ? "qualified" : "rejected", {
            summary: result.summary.slice(0, 4000),
          });
          if (!result.qualified) {
            consecutiveFailures = 0;
            continue;
          }
        }
        // Enqueue is idempotent by content hash if restart occurs just after acceptance.
        const receipt = await options.submit(proposal);
        const feedback =
          receipt &&
          typeof receipt === "object" &&
          "feedback" in receipt &&
          typeof receipt.feedback === "string"
            ? receipt.feedback
            : "";
        record(
          "submitted",
          feedback
            ? {
                summary: [state.summary, feedback]
                  .filter(Boolean)
                  .join(" ")
                  .slice(0, 4000),
              }
            : {},
        );
        totals.submitted++;
        consecutiveFailures = 0;
      } catch (e: any) {
        if (!active() || stopController.signal.aborted) break;
        record(state.stage === "qualified" ? "qualified" : "failed", {
          summary: String(e?.message ?? e).slice(0, 1000),
        });
        totals.failures++;
        if (++consecutiveFailures >= 3) break;
        await wait(
          Math.min(
            Math.max(0, options.deadline - Date.now()),
            1000 * consecutiveFailures,
          ),
        );
      }
    }
    return totals;
  }
  try {
    return [await slot(SOLO_AGENT, researchFocus)];
  } finally {
    if (fs.readFileSync(lease, "utf8") === String(process.pid))
      fs.unlinkSync(lease);
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}
