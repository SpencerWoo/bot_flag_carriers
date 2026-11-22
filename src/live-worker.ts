import { compileArenaPolicy, type ArenaActor } from "./arena-policy.js";
import type { Game, Seat } from "./core.js";
const players = new Map<Seat, ArenaActor>();
process.on("message", (message: any) => {
  try {
    if (message.kind === "init") {
      const policy = compileArenaPolicy(message.source);
      if (policy.hash !== message.hash)
        throw Error("Live Master hash mismatch");
      for (const [seat, seed] of Object.entries(message.seeds))
        players.set(seat as Seat, policy.create(seed as number));
      process.send?.({ ok: true });
      return;
    }
    const actor = players.get(message.seat);
    if (!actor) throw Error("Unknown live seat");
    const v = message.view as Game;
    const result =
      message.kind === "choose"
        ? actor.choose(v)
        : message.kind === "setup"
          ? (actor.setup?.(v) ?? "10")
          : actor.observe?.(v);
    process.send?.({ ok: true, result });
  } catch (e) {
    process.send?.({ error: e instanceof Error ? e.message : String(e) });
  }
});
