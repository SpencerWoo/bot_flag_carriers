import { lock, stopping } from "./control.js";
import { Client, ApiError } from "./api.js";
import { type Weights, validateWeights } from "./strategy.js";
import { LiveMaster, type LivePin } from "./live-master.js";
import { digest } from "./master-git.js";
import { append, save, read } from "./storage.js";
import { checkGeometry, checkTransition } from "./parity.js";
import { type Game, type Action } from "./core.js";
const fingerprint = (g: Game) =>
  JSON.stringify([
    g.status,
    g.moveCount,
    g.turn,
    g.promoWait,
    g.lastRecruit,
    g.ready,
    g.pieces.map((p) => [p.id, p.pos, p.flags]),
  ]);
export interface LiveOptions {
  mode?: number;
  kind?: "test" | "offline" | "friendly";
  id?: string;
  minutes?: number;
  maxActions?: number;
  weights?: Weights;
  master?: LivePin;
}
export async function play(options: LiveOptions = {}) {
  const release = lock("live");
  try {
    return await playLocked(options);
  } finally {
    release();
  }
}
async function playLocked(options: LiveOptions) {
  if (
    options.minutes !== undefined &&
    (!Number.isFinite(options.minutes) || options.minutes <= 0)
  )
    throw Error("Positive minutes required");
  const parity = read<any>("parity-gate.json", {});
  if (parity.passed === false)
    throw Error(
      "Parity validation is paused; run validate after correcting the recorded failure",
    );
  const client = new Client();
  const me = await client.me();
  if (!me.user)
    throw Error("Session expired; run auth with environment credentials");
  const previous = read<any>("live.json", null);
  let id = options.id || previous?.id;
  if (!id) {
    const created = await client.create(
      options.mode || 4,
      options.kind || "offline",
    );
    id = created.id;
    save("live.json", { id, kind: options.kind || "offline" });
  }
  let g: Game = await client.game(id);
  const pending = read<any>("pending.json", null);
  if (pending && pending.id !== id)
    throw Error(
      "Another game has an uncertain submission; resolve its checkpoint before switching games",
    );
  if (pending && pending.id === id && pending.fingerprint === fingerprint(g))
    throw Error(
      "Uncertain previous submission: server state is unchanged. Inspect pending.json before clearing; no action was retried.",
    );
  save("pending.json", null);
  const end = Date.now() + 60000 * (options.minutes ?? 120);
  const source = options.weights
    ? `export default ({baseline})=>baseline(${JSON.stringify(validateWeights(options.weights))});`
    : undefined;
  const player = await LiveMaster.open(
    id,
    g.mySeats,
    source ? { generation: 0, hash: digest(source), source } : options.master,
  );
  let streamError: unknown;
  let count = 0,
    errors = 0,
    geometryChecks = 0,
    transitionChecks = 0,
    eventView: Game | undefined;
  const controller = new AbortController();
  void client
    .events(
      id,
      (v) => {
        if (v.id === id && Array.isArray(v.pieces)) {
          void player.observe(v).catch((e) => {
            streamError = e;
          });
          eventView = v;
        }
      },
      controller.signal,
    )
    .catch(() => {});
  console.log(
    JSON.stringify({
      event: "live-start",
      id,
      url: `https://play.flag-carriers.workers.dev/#/game/${id}`,
      mode: g.mode,
      status: g.status,
    }),
  );
  const transact = async (a: Action) => {
    const before = g;
    save("pending.json", {
      id,
      fingerprint: fingerprint(g),
      action: a,
      time: new Date().toISOString(),
    });
    let next: Game;
    try {
      next = await client.act(id, a);
    } catch (e) {
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
        save("pending.json", null);
        errors++;
        if (errors >= 3 || [401, 403, 429].includes(e.status)) throw e;
        g = await client.game(id);
        append("live-errors.jsonl", { id, error: e.message, status: e.status });
        return;
      }
      // Do not repeat a mutation when the response might have been lost.
      g = await client.game(id);
      if (fingerprint(g) === fingerprint(before))
        throw Error(
          "Submission outcome uncertain; checkpoint retained without retry",
        );
      next = g;
    }
    save("pending.json", null);
    const checked = checkTransition(before, a, next);
    if (checked.errors.length) {
      save("parity-failure.json", {
        before,
        action: a,
        after: next,
        errors: checked.errors,
      });
      save("parity-gate.json", { passed: false, reason: checked.errors });
      throw Error(checked.errors.join("; "));
    }
    if (checked.checked) transitionChecks++;
    append("live-traces.jsonl", {
      id,
      time: new Date().toISOString(),
      before,
      action: a,
      after: next,
    });
    g = next;
    count++;
    errors = 0;
    save("checkpoint-" + id + ".json", g);
    if (count % 10 === 0)
      console.log(
        JSON.stringify({
          event: "progress",
          id,
          actions: count,
          moveCount: g.moveCount,
          status: g.status,
        }),
      );
  };
  try {
    while (
      !stopping &&
      g.status !== "finished" &&
      Date.now() < end &&
      count < (options.maxActions ?? Infinity)
    ) {
      if (g.ranked || g.teams)
        throw Error("Ranked and team modes are disabled");
      if (g.status === "setup") {
        const s = g.mySeats.find((s) => !g.ready[s]);
        if (s) {
          const a = await player.setup(g, s);
          await transact(a || { type: "ready", seat: s, value: true });
          continue;
        }
      }
      const geometry = checkGeometry(g);
      if (geometry.length) {
        save("parity-failure.json", { game: g, errors: geometry });
        save("parity-gate.json", { passed: false, reason: geometry });
        throw Error(geometry.join("; "));
      }
      if (g.mySeats.includes(g.turn)) geometryChecks++;
      if (streamError) throw streamError;
      const start = performance.now();
      await player.observe(g);
      const a = await player.choose(g);
      const elapsed = performance.now() - start;
      if (a) {
        append("latency.jsonl", { id, ms: elapsed });
        await transact(a);
        continue;
      }
      await new Promise((r) => setTimeout(r, g.offline ? 250 : 1500));
      // Always refresh: streaming can be absent or omit transient combat reveals.
      const next = await client.game(id);
      if (eventView && eventView.moveCount > next.moveCount) g = eventView;
      else g = next;
      eventView = undefined;
    }
  } finally {
    controller.abort();
    player.close();
    save("checkpoint-" + id + ".json", g);
  }
  const summary = {
    id,
    masterGeneration: player.pin.generation,
    masterHash: player.pin.hash,
    seat: g.mySeats[0],
    kind: g.testMode ? "test" : g.offline ? "offline" : "friendly",
    mode: g.mode,
    status: g.status,
    results: g.results,
    moveCount: g.moveCount,
    actions: count,
    geometryChecks,
    transitionChecks,
    finished: g.status === "finished",
    time: new Date().toISOString(),
  };
  append("live-results.jsonl", summary);
  const gate = read<any>("parity-gate.json", { passed: true, coverage: {} });
  gate.coverage ??= {};
  gate.coverage[g.mode] = {
    geometry: (gate.coverage[g.mode]?.geometry || 0) + geometryChecks,
    transitions: (gate.coverage[g.mode]?.transitions || 0) + transitionChecks,
  };
  gate.fullParity ??= false;
  gate.testMode = "admin-only";
  save("parity-gate.json", gate);
  if (g.status === "finished") {
    save("live.json", null);
    console.log(JSON.stringify({ event: "finished", ...summary }));
  } else {
    save("live.json", {
      id,
      kind: options.kind || previous?.kind || "offline",
    });
    console.log(JSON.stringify({ event: "checkpoint", ...summary }));
  }
  return summary;
}
