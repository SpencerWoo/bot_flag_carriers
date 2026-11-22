import { match } from "./evaluate.js";
process.on("message", (job: any) => {
  try {
    const { mode, seed, slot, weights, champion, index, deadline, league } =
      job;
    const candidate = match(
      mode,
      seed,
      slot,
      weights,
      champion,
      2400,
      false,
      deadline,
      league,
    );
    const baseline = match(
      mode,
      seed,
      slot,
      champion,
      champion,
      2400,
      false,
      deadline,
      league,
    );
    process.send?.({
      index,
      candidate,
      champion: baseline,
      delta: Number(candidate.win) - Number(baseline.win),
    });
  } catch (e: any) {
    process.send?.({ error: e.message });
  }
});
