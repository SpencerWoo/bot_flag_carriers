import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LeaguePool } from "../src/league-pool.js";

test(
  "a reproducible initialization timeout is bounded and releases the referee slot",
  { timeout: 45000 },
  async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "flags-timeout-test-"),
    );
    const pool = new LeaguePool(1);
    try {
      const slow = path.join(directory, "slow.mjs"),
        master = path.resolve("policies/master-g0.mjs");
      fs.writeFileSync(slow, "export default () => { while (true) {} };\n");
      const scenario = { mode: 3 as const, seed: 217, master };
      const options = {
        priority: "development" as const,
        deadline: Date.now() + 40000,
      };
      await assert.rejects(
        pool.pair({ ...scenario, challenger: slow }, options),
        /Script execution timed out/,
      );
      const pair = await pool.pair(
        { ...scenario, challenger: master },
        options,
      );
      assert.equal(pair.complete, true);
    } finally {
      await pool.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);
