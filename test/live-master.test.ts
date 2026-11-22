import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "fc-pinned-live-"));
process.env.FLAG_CARRIERS_DATA = data;
const { LiveMaster } = await import("../src/live-master.js");
const { initial, view } = await import("../src/simulator.js");
const { arenaPlayerView, compileArenaPolicy } =
  await import("../src/arena-match.js");
const { actionKey } = await import("../src/core.js");

const source = `export default ({legalActions,random}) => {
 let seen=0,choices=0;
 return {observe(){seen++},choose(v){const actions=legalActions(v);const roll=Math.floor(random()*100000);
    return actions[(roll+seen*13+(++choices)*7)%actions.length];}};
}`;
const pin = (generation: number, code: string) => ({
  generation,
  hash: createHash("sha256").update(code).digest("hex"),
  source: code,
});
const tapeFile = (id: string) => path.join(data, "live-policy", id + ".jsonl");
const pinFile = (id: string) => path.join(data, "live-policy", id + ".json");
test.after(() => {
  fs.rmSync(data, { recursive: true, force: true });
});

test("resuming a live game restores the original policy, private memory and RNG across a promotion", async () => {
  const id = "pin-replay",
    first = pin(2, source);
  const latest = pin(
    3,
    "export default ({legalActions})=>({choose(v){return legalActions(v)[0]}})",
  );
  const board = view(initial(3, 98), "R");
  board.id = id;
  board.moveCount = 4;
  let live = await LiveMaster.open(id, ["R"], first);
  try {
    const seed = live.pin.seeds.R!;
    const oracle = compileArenaPolicy(source).create(seed),
      firstView = arenaPlayerView(board, "R");
    oracle.observe?.(firstView);
    const expected = oracle.choose(firstView)!;
    await live.observe(board);
    const firstChoice = await live.choose(board);
    assert(firstChoice);
    assert.equal(actionKey(firstChoice), actionKey(expected));
    const logged = fs.readFileSync(tapeFile(id), "utf8");
    assert.deepEqual(
      logged
        .trim()
        .split("\n")
        .map((x) => JSON.parse(x).kind),
      ["observe", "choose"],
    );
    live.close();
    live = await LiveMaster.open(id, ["R"], latest);
    assert.equal(live.pin.generation, 2);
    assert.equal(live.pin.hash, first.hash);
    assert.equal(live.pin.seeds.R, seed);
    const repeated = await live.choose(board);
    assert(repeated);
    assert.equal(actionKey(repeated), actionKey(expected));
    assert.equal(
      fs.readFileSync(tapeFile(id), "utf8"),
      logged,
      "a repeated observation must not advance RNG or append a decision",
    );
    const other = { ...board, turn: "B" as const, moveCount: 5, ver: 5 },
      next = { ...board, turn: "R" as const, moveCount: 6, ver: 6 };
    await live.observe(other);
    oracle.observe?.(arenaPlayerView(other, "R"));
    await live.observe(board); // late server event: an old move must not overwrite history
    oracle.observe?.(arenaPlayerView(next, "R"));
    const expectedNext = oracle.choose(arenaPlayerView(next, "R"))!;
    const actualNext = await live.choose(next);
    assert(actualNext);
    assert.equal(actionKey(actualNext), actionKey(expectedNext));
    assert.equal(
      await live.choose(board),
      null,
      "a legal action from an old board must not be submitted after a newer event",
    );
    const records = fs
      .readFileSync(tapeFile(id), "utf8")
      .trim()
      .split("\n")
      .map((x) => JSON.parse(x));
    assert.deepEqual(
      records.map((x) => [x.kind, x.view.moveCount]),
      [
        ["observe", 4],
        ["choose", 4],
        ["observe", 5],
        ["observe", 6],
        ["choose", 6],
      ],
    );
    const fresh = await LiveMaster.open("pin-new-game", ["R"], latest);
    try {
      assert.equal(fresh.pin.generation, 3);
      assert.equal(fresh.pin.hash, latest.hash);
    } finally {
      fresh.close();
    }
  } finally {
    live.close();
  }
});

test("a modified saved policy cannot be executed when a game resumes", async () => {
  const id = "invalid-pin",
    specified = pin(1, source),
    live = await LiveMaster.open(id, ["R"], specified);
  live.close();
  const state = JSON.parse(fs.readFileSync(pinFile(id), "utf8"));
  state.source += "\n// not the tested artifact";
  fs.writeFileSync(pinFile(id), JSON.stringify(state));
  await assert.rejects(
    () => LiveMaster.open(id, ["R"], specified),
    /digest mismatch/,
  );
});

test("a failed first pin leaves the game available for the verified artifact", async () => {
  const id = "first-pin",
    correct = pin(1, source),
    bad = { ...correct, hash: "0".repeat(64) };
  await assert.rejects(
    () => LiveMaster.open(id, ["R"], bad),
    /digest mismatch/,
  );
  assert.equal(fs.existsSync(pinFile(id)), false);
  const live = await LiveMaster.open(id, ["R"], correct);
  try {
    assert.equal(live.pin.hash, correct.hash);
  } finally {
    live.close();
  }
});

test("resume discards a torn final write and rejects corruption in committed journal records", async () => {
  const id = "journal-tail",
    master = pin(2, source),
    g = view(initial(3, 123), "R");
  let live = await LiveMaster.open(id, ["R"], master);
  try {
    const choice = await live.choose(g);
    assert(choice);
    live.close();
    const committed = fs.readFileSync(tapeFile(id), "utf8");
    fs.appendFileSync(tapeFile(id), '{"kind":"choose"');
    live = await LiveMaster.open(id, ["R"], master);
    assert.equal(fs.readFileSync(tapeFile(id), "utf8"), committed);
    const resumed = await live.choose(g);
    assert(resumed);
    assert.equal(actionKey(choice), actionKey(resumed));
    live.close();
    // Corruption followed by a newline is a committed record and cannot be silently dropped.
    fs.appendFileSync(tapeFile(id), "broken-committed-record\n");
    await assert.rejects(() => LiveMaster.open(id, ["R"], master));
  } finally {
    live.close();
  }
});
