import fs from "node:fs";
import path from "node:path";
import { LeaguePool } from "./league-pool.js";
import {
  currentMaster,
  enqueueCandidate,
  queue,
  runQualification,
  type QualificationOutcome,
} from "./master-league.js";
import { pin, get, type QueueEntry } from "./master-store.js";
import { SOLO_AGENT } from "./research-runner.js";
import type { QualificationStats } from "./master-stats.js";
import { schedule } from "./master-stats.js";
import { runResearchers, type ResearchProposal } from "./research.js";
import { root } from "./storage.js";
import { lock, stopping } from "./control.js";
import { play } from "./live.js";
const notice = (event: unknown) => console.log(JSON.stringify(event));
export async function screenProposal(
  proposal: ResearchProposal,
  parentSource: string,
  pool: LeaguePool,
  deadline: number,
  signal?: AbortSignal,
) {
  const master = pin(parentSource),
    candidate = pin(proposal.source);
  const fixed = ["runner", "aggressive"].map((name) =>
    path.resolve("league/policies", name + ".mjs"),
  );
  const rows: {
    index: number;
    mode: number;
    wins: number;
    losses: number;
    plies: number;
  }[] = [];
  if (candidate === master)
    return { qualified: false, summary: "Identical to the current Master." };
  for (const total of [12, 48]) {
    for (let base = rows.length; base < total; base += pool.size) {
      const batch = await Promise.all(
        Array.from(
          { length: Math.min(pool.size, total - base) },
          async (_, j) => {
            const index = base + j;
            const scenario = schedule(
              index,
              "development-v1-" + proposal.parent + "-" + proposal.iteration,
            );
            const pair = await pool.pair(
              {
                ...scenario,
                challenger: candidate,
                master,
                fillers: index % 4 < 2 ? fixed : [...fixed].reverse(),
              },
              { priority: "development", deadline, signal },
            );
            if (!pair.complete)
              throw Error("Development scenario hit its game limit");
            return {
              index,
              mode: scenario.mode,
              wins: pair.candidateWins,
              losses: pair.masterWins,
              plies: pair.games.reduce((n, g) => n + g.plies, 0),
            };
          },
        ),
      );
      rows.push(...batch);
    }
    const tally = (list: typeof rows) => {
      const wins = list.reduce((n, x) => n + x.wins, 0),
        losses = list.reduce((n, x) => n + x.losses, 0);
      return {
        wins,
        masterWins: losses,
        games: list.length * 2,
        edge: (wins - losses) / (list.length * 2),
      };
    };
    const overall = tally(rows),
      three = tally(rows.filter((r) => r.mode === 3)),
      four = tally(rows.filter((r) => r.mode === 4));
    const summary = `${overall.wins} challenger wins and ${overall.masterWins} Master wins in ${overall.games} games. Three-player edge ${(three.edge * 100).toFixed(1)} pp, four-player ${(four.edge * 100).toFixed(1)} pp.`;
    const qualified = overall.edge >= 0.03;
    const early = total === 12 && overall.edge < -0.15;
    const checkpoint = path.join(
      path.dirname(proposal.file),
      "development.json",
    );
    fs.writeFileSync(
      checkpoint,
      JSON.stringify({ total, overall, three, four, rows }, null, 2) + "\n",
      { mode: 0o600 },
    );
    if (early || total === 48)
      return { qualified: !early && qualified, summary };
  }
  throw Error("Incomplete development screen");
}
export interface LeagueOptions {
  minutes: number;
  liveGames: number;
  iterations?: number;
  session: string;
  workers?: number;
  prepare?: boolean;
  developmentOnly?: boolean;
}
export async function runLeague(options: LeagueOptions) {
  if (
    !Number.isFinite(options.minutes) ||
    options.minutes <= 0 ||
    options.minutes > 24 * 60
  )
    throw Error("Choose a session length between zero and 1440 minutes");
  if (
    !Number.isInteger(options.liveGames) ||
    options.liveGames < 0 ||
    options.liveGames > 4
  )
    throw Error("Choose 0 to 4 live games");
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(options.session))
    throw Error("Invalid research session name");
  const release = lock("master-session");
  const pool = new LeaguePool(options.workers);
  const controller = new AbortController();
  const deadline = Date.now() + options.minutes * 60000,
    developmentOnly = options.developmentOnly === true;
  const researchDeadline =
    deadline -
    (options.liveGames && !developmentOnly
      ? Math.min(1800000, options.minutes * 15000)
      : 0);
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const timer = setTimeout(stop, Math.max(0, researchDeadline - Date.now()));
  const results: QualificationOutcome[] = [],
    live: unknown[] = [];
  function feedback(entry: QueueEntry) {
    const stats = entry.run
      ? get<QualificationStats | null>(
          "runs/" + entry.run + "/result.json",
          null,
        )
      : null;
    if (!stats) return "Formal status: " + entry.state + ".";
    const pp = (n: number) => (n * 100).toFixed(1) + " pp";
    return (
      "Formal status: " +
      entry.state +
      ". In " +
      stats.overall.games +
      " fresh games the overall edge was " +
      pp(stats.overall.edge) +
      " (lower bound " +
      pp(stats.overall.lower) +
      "), three-player " +
      pp(stats.three.edge) +
      " and four-player " +
      pp(stats.four.edge) +
      "."
    );
  }
  async function drainSoloQueue() {
    while (!developmentOnly && !controller.signal.aborted && !stopping) {
      const next = queue().find(
        (e) =>
          e.agent === SOLO_AGENT &&
          ["queued", "running", "prepared"].includes(e.state),
      );
      if (!next) return;
      const result = await runQualification({
        id: next.id,
        pool,
        workers: pool.size,
        deadline: researchDeadline,
        signal: controller.signal,
        publish: options.prepare ? "prepare" : "git",
      });
      results.push(result);
      notice({ event: "qualification", ...result });
      if (result.status === "incomplete" || result.status === "prepared") {
        stop();
        return;
      }
    }
  }
  try {
    await drainSoloQueue();
    const snapshot = () => currentMaster({ sync: true });
    const research = await runResearchers({
      repo: process.cwd(),
      directory: path.join(root, "research", options.session),
      master: snapshot,
      deadline: researchDeadline,
      maxIterations: options.iterations,
      signal: controller.signal,
      screen: async (p, time, signal) => {
        const latest = snapshot();
        if (latest.hash !== p.parent)
          return {
            qualified: false,
            summary:
              "Master advanced before screening. Research the new generation.",
          };
        return screenProposal(p, latest.source, pool, time, signal);
      },
      submit: async (p) => {
        const sub = enqueueCandidate({
          source: p.source,
          theory: p.theory,
          agent: p.agent,
          parent: p.parent,
        });
        if (developmentOnly) return;
        await drainSoloQueue();
        const entry = queue().find((e) => e.id === sub.id)!;
        return { feedback: feedback(entry) };
      },
      notice,
    });
    clearTimeout(timer);
    if (!developmentOnly && !stopping && Date.now() < deadline - 60000) {
      for (
        let i = 0;
        i < options.liveGames && Date.now() < deadline - 60000 && !stopping;
        i++
      ) {
        const master = snapshot();
        const result = await play({
          master,
          kind: "offline",
          mode: i % 2 === 0 ? 3 : 4,
          minutes: (deadline - Date.now()) / 60000,
        });
        live.push(result);
        if (!result.finished) break;
      }
    }
    return {
      session: options.session,
      research,
      qualification: results,
      live,
    };
  } finally {
    clearTimeout(timer);
    stop();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await pool.close();
    release();
  }
}
