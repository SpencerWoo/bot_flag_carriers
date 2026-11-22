// The persistent referee receives only staged policy files and one pair's deal.
import { loadArenaPolicy, playArenaPair } from "./arena-match.js";
import { refereeFingerprint } from "./master-fingerprint.js";
import type { LeaguePairJob } from "./league-pool.js";
const cache = new Map<string, ReturnType<typeof loadArenaPolicy>>();
function definition(file: string) {
  let policy = cache.get(file);
  if (!policy) {
    policy = loadArenaPolicy(file);
    cache.set(file, policy);
  }
  return policy;
}
const fingerprint = refereeFingerprint();
process.on(
  "message",
  async ({
    job,
    fingerprint: expected,
  }: {
    job: LeaguePairJob;
    fingerprint: string;
  }) => {
    try {
      if (expected !== fingerprint)
        throw Error("Referee fingerprint changed since session startup");
      const [challenger, master, ...fillers] = await Promise.all(
        [job.challenger, job.master, ...(job.fillers ?? [])].map(definition),
      );
      const result = await playArenaPair({
        ...job,
        challenger,
        master,
        fillers,
      });
      process.send?.({ result });
    } catch (error) {
      process.send?.({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
);
