import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const data = fs.mkdtempSync(path.join(os.tmpdir(), "flag-carriers-test-"));
process.env.FLAG_CARRIERS_DATA = data;
const { Client, ApiError } = await import("../src/api.js");
const { save, read } = await import("../src/storage.js");
const { play } = await import("../src/live.js");
const { initial, view } = await import("../src/simulator.js");
const originalFetch = globalThis.fetch;
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
test.after(() => {
  globalThis.fetch = originalFetch;
  fs.rmSync(data, { recursive: true, force: true });
});
test("authentication errors do not echo a server credential message", async () => {
  process.env.FLAG_CARRIERS_EMAIL = "test@example.invalid";
  process.env.FLAG_CARRIERS_PASSWORD = "fake-test-secret";
  globalThis.fetch = async () => response({ error: "fake-test-secret" }, 401);
  await assert.rejects(
    () => new Client().login(),
    (e) => e instanceof ApiError && e.message === "Login rejected",
  );
  delete process.env.FLAG_CARRIERS_EMAIL;
  delete process.env.FLAG_CARRIERS_PASSWORD;
});
test("cookies are owner-only and outbound requests stay on the game origin", async () => {
  let requests = 0;
  globalThis.fetch = async (input, init) => {
    assert(
      String(input).startsWith("https://play.flag-carriers.workers.dev/api/"),
    );
    assert.equal(init?.redirect, "error");
    requests++;
    return new Response('{"user":{"nickname":"test"}}', {
      headers: { "set-cookie": "session=fake; HttpOnly; Secure" },
    });
  };
  await new Client().me();
  assert.equal(requests, 1);
  assert.equal(
    fs.statSync(path.join(data, "session.json")).mode & 0o777,
    0o600,
  );
  await assert.rejects(
    () => new Client().request("GET", "https://elsewhere.invalid/"),
    /Only game API/,
  );
});
test("a lost response with unchanged state is checkpointed and never retried", async () => {
  const g = view(initial(3, 1), "R");
  g.id = "abc";
  g.offline = true;
  g.ranked = false;
  g.teams = false;
  save("live.json", { id: "abc", kind: "offline" });
  save("pending.json", null);
  save("parity-gate.json", { passed: true });
  let submissions = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/me"))
      return response({ user: { nickname: "test" } });
    if (url.includes("/api/events")) return new Response("");
    if (url.endsWith("/action")) {
      submissions++;
      throw Error("connection lost");
    }
    if (url.endsWith("/api/games/abc")) return response(g);
    throw Error("Unexpected test request");
  };
  await assert.rejects(
    () => play({ id: "abc", minutes: 1, maxActions: 1 }),
    /Submission outcome uncertain/,
  );
  assert.equal(submissions, 1);
  assert(read<any>("pending.json", null)?.action);
  assert(!fs.existsSync(path.join(data, "live.lock")));
  await assert.rejects(
    () => play({ id: "abc", minutes: 1, maxActions: 1 }),
    /Uncertain previous submission/,
  );
  assert.equal(submissions, 1);
});
test("rate limiting stops live submissions after one rejection", async () => {
  const g = view(initial(3, 1), "R");
  g.id = "abc";
  g.offline = true;
  save("pending.json", null);
  save("parity-gate.json", { passed: true });
  let submissions = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/me"))
      return response({ user: { nickname: "test" } });
    if (url.includes("/api/events")) return new Response("");
    if (url.endsWith("/action")) {
      submissions++;
      return response({ error: "Rate limited" }, 429);
    }
    if (url.endsWith("/api/games/abc")) return response(g);
    throw Error("Unexpected test request");
  };
  await assert.rejects(
    () => play({ id: "abc", minutes: 1, maxActions: 1 }),
    (e) => e instanceof ApiError && e.status === 429,
  );
  assert.equal(submissions, 1);
  assert.equal(read("pending.json", "missing"), null);
});
