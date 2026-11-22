import test from "node:test";
import assert from "node:assert/strict";
import { initial, step, simActions, view } from "../src/simulator.js";
import { checkTransition } from "../src/parity.js";
import { decide, newMemory, DEFAULT } from "../src/strategy.js";
import { match } from "../src/evaluate.js";
import { rng, type Piece } from "../src/core.js";
test("combat reveals without IDs map back to the attacked destination", () => {
  const g = initial(4, 1);
  g.pieces = [
    { id: "att", owner: "R", rank: "6", pos: "5,5", flags: [] },
    { id: "def", owner: "B", rank: "4", pos: "3,5", flags: [] },
    ...g.pieces.filter((p) => p.owner === "Y" || p.owner === "G"),
    { id: "bb", owner: "B", rank: "2", pos: "1,8", flags: [] },
  ];
  const before = view(g, "R");
  before.actions = simActions(g);
  const action = {
    type: "move",
    seat: "R" as const,
    pieceId: "att",
    to: "3,5",
  };
  step(g, action);
  const after = view(g, "R");
  delete after.lastAction.combat.att.id;
  delete after.lastAction.combat.def.id;
  assert.deepEqual(checkTransition(before, action, after), {
    checked: true,
    errors: [],
  });
});
test("seeded matches finish on both boards and reproduce outcomes", () => {
  for (const mode of [3, 4]) {
    const a = match(mode, 42, 0, DEFAULT),
      b = match(mode, 42, 0, DEFAULT);
    assert(a.finished);
    assert.deepEqual({ ...a, ms: 0 }, { ...b, ms: 0 });
  }
});
test("checkpoint roundtrip preserves decisions and continuation", () => {
  const g = initial(3, 12);
  const mem = newMemory();
  const v = view(g, "R");
  const a = decide(v, mem, DEFAULT, rng(8))!;
  const copy = JSON.parse(JSON.stringify(g));
  step(g, a);
  step(copy, a);
  assert.deepEqual(g, copy);
  assert.deepEqual(
    decide(view(g, g.turn), newMemory(), DEFAULT, rng(9)),
    decide(view(copy, copy.turn), newMemory(), DEFAULT, rng(9)),
  );
});
test("policy never selects an action absent from server-supplied legal actions", () => {
  const g = initial(4, 3),
    v = view(g, "R");
  const first = Object.keys(v.actions)[0],
    target = v.actions[first].moves[0];
  v.actions = { [first]: { moves: [target], fires: [] } };
  const a = decide(v, newMemory());
  assert.equal(a?.pieceId, first);
  assert.equal(a?.to, target);
});
test("artillery victim ranks use the website fire reveal format", () => {
  const g = initial(4, 1);
  g.pieces = [
    { id: "gun", owner: "R", rank: "C", pos: "6,4", flags: [] },
    { id: "victim", owner: "B", rank: "9", pos: "RING", flags: [] },
    { id: "r", owner: "R", rank: "5", pos: "4,3", flags: [] },
    { id: "bb", owner: "B", rank: "2", pos: "1,8", flags: [] },
    ...g.pieces.filter((p) => p.owner === "Y" || p.owner === "G"),
  ];
  const before = view(g, "R"),
    action = {
      type: "fire",
      seat: "R" as const,
      pieceId: "gun",
      target: "RING",
    };
  step(g, action);
  const after = view(g, "R");
  delete after.lastAction.combat;
  after.lastAction.victim = { owner: "B", rank: "9" };
  assert.deepEqual(checkTransition(before, action, after), {
    checked: true,
    errors: [],
  });
});
