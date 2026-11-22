import { installSignals } from "./control.js";
installSignals();
import fs from "node:fs";
import { exportResults } from "./export.js";
import { validate } from "./validate.js";
import { Client } from "./api.js";
import { DEFAULT } from "./strategy.js";
import { evaluate, learn, match } from "./evaluate.js";
import { play } from "./live.js";
import { runArenaBenchmark } from "./arena-benchmark.js";
import { report } from "./report.js";
import { read, save } from "./storage.js";
import { runLeague } from "./league-session.js";
import { masterCommand } from "./master-league.js";
import { initial, step } from "./simulator.js";
const [command = "help", ...args] = process.argv.slice(2);
const option = (key: string, fallback: string) => {
  const i = args.indexOf("--" + key);
  return i < 0 ? fallback : (args[i + 1] ?? fallback);
};
const num = (key: string, fallback: number) => {
  const n = Number(option(key, String(fallback)));
  if ((!Number.isFinite(n) && n !== fallback) || n < 0)
    throw Error("Invalid --" + key);
  return n;
};
try {
  if (command === "auth") {
    const c = new Client();
    const me = args.includes("--check") ? await c.me() : await c.login();
    if (!me.user) throw Error("Not signed in");
    console.log(
      JSON.stringify({ authenticated: true, nickname: me.user.nickname }),
    );
  } else if (command === "match")
    console.log(
      JSON.stringify(
        match(
          num("mode", 4),
          num("seed", 1),
          num("slot", 0),
          read<any>("champion.json", { weights: DEFAULT }).weights,
          DEFAULT,
          num("max-plies", 2400),
          true,
        ),
        null,
        2,
      ),
    );
  else if (command === "evaluate") {
    const weights = JSON.parse(
      fs.readFileSync(option("candidate", "candidate.json"), "utf8"),
    );
    const r = await evaluate(
      weights.weights || weights,
      num("games", 600),
      num("seed", 100000),
    );
    console.log(JSON.stringify({ ...r, pairs: undefined }, null, 2));
  } else if (command === "benchmark") {
    console.log(
      JSON.stringify(runArenaBenchmark({ pairs: num("pairs", 12) }), null, 2),
    );
  } else if (command === "master" || command === "leaderboard") {
    const result = await masterCommand(
      command === "leaderboard" ? ["leaderboard", ...args] : args,
    );
    console.log(
      typeof result === "string" ? result : JSON.stringify(result, null, 2),
    );
  } else if (command === "learn" || command === "research") {
    const developmentOnly = command === "research";
    const result = await runLeague({
      minutes: num("minutes", 120),
      iterations: args.includes("--rounds") ? num("rounds", 1) : undefined,
      liveGames: num("live-games", developmentOnly ? 0 : 4),
      session: option("session", "default"),
      workers: args.includes("--workers") ? num("workers", 1) : undefined,
      prepare: args.includes("--prepare"),
      developmentOnly,
    });
    console.log(JSON.stringify(result, null, 2));
  } else if (command === "tune")
    console.log(
      JSON.stringify(
        await learn(
          num("minutes", 120),
          num("live-games", 4),
          num("rounds", Infinity),
        ),
        null,
        2,
      ),
    );
  else if (command === "live") {
    const kind = option("kind", "offline");
    if (!["test", "offline", "friendly"].includes(kind))
      throw Error("Kind must be test, offline or friendly");
    await play({
      mode: num("mode", 4),
      kind: kind as any,
      id: option("id", "") || undefined,
      minutes: num("minutes", 120),
      maxActions: num("max-actions", Infinity),
    });
  } else if (command === "export") console.log(JSON.stringify(exportResults()));
  else if (command === "validate")
    console.log(JSON.stringify(validate(), null, 2));
  else if (command === "report") console.log(report());
  else if (command === "replay") {
    const r = read<any>("last-replay.json", null);
    if (!r) throw Error("Run match first");
    const g = initial(r.mode, r.seed, r.carriers);
    for (const a of r.actions) step(g, a);
    console.log(
      JSON.stringify({
        winner: g.winner,
        moveCount: g.moveCount,
        status: g.status,
        recorded: r.result,
      }),
    );
  } else if (command === "init") {
    if (!read("champion.json", null))
      save("champion.json", { version: 0, weights: DEFAULT });
    console.log("Initialized champion V0");
  } else
    console.log(
      "Commands: learn [--session NAME --minutes 120 --rounds N --live-games 0..4 --prepare] | research [--session NAME --rounds N] | master status|submit|queue|qualify|publish | leaderboard | benchmark [--pairs 12] | init | auth [--check] | match [--mode 3|4 --seed N] | replay | evaluate --candidate FILE [--games 600 --seed N] | tune [--minutes 120 --rounds N] | live [--kind offline|test|friendly --mode 3|4 --id ID --minutes 120] | validate | export | report",
    );
} catch (e: any) {
  console.error(e.message);
  process.exitCode = 1;
}
