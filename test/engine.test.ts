import test from "node:test";
import assert from "node:assert/strict";
import {
  board,
  moves,
  targets,
  duel,
  rng,
  type Piece,
  type Seat,
} from "../src/core.js";
import { initial, simActions, step, view } from "../src/simulator.js";
import { decide, newMemory, observe, belief } from "../src/strategy.js";
import { bounds, match } from "../src/evaluate.js";
import { checkGeometry, checkTransition } from "../src/parity.js";
const p = (
  id: string,
  owner: Seat,
  rank: string,
  pos: string,
  flags: Seat[] = [],
): Piece => ({ id, owner, rank, pos, flags });
function sparse(pieces: Piece[], mode = 4) {
  const g = initial(mode, 1);
  g.pieces = pieces;
  return g;
}
test("both boards start with complete armies and open reinforcement squares", () => {
  for (const mode of [3, 4]) {
    const g = initial(mode, 31),
      b = board(mode);
    assert.equal(g.pieces.length, mode * 20);
    assert.equal(new Set(g.pieces.map((p) => p.pos)).size, mode * 20);
    for (const s of g.mySeats) {
      assert(!g.pieces.some((p) => p.pos === b.recruit[s]));
      assert.equal(g.pieces.find((p) => p.pos === b.flagStart[s])?.flags[0], s);
    }
  }
});
test("duels include asymmetric spy and artillery rules", () => {
  assert.equal(duel("1", "10"), 1);
  assert.equal(duel("10", "1"), 1);
  assert.equal(duel("C", "1"), -1);
  assert.equal(duel("1", "C"), 1);
  assert.equal(duel("7", "7"), 0);
});
test("carrying scouts lose range; dropping restores it", () => {
  const b = board(4),
    q = p("x", "R", "2", "4,3", ["R"]),
    occ = { [q.pos]: q };
  assert(moves(b, occ, {}, q.pos, q, true).some((m) => m.to === "4,6"));
  assert(!moves(b, occ, {}, q.pos, q, false).some((m) => m.to === "4,6"));
});
test("cavalier can turn but cannot cross an occupied square", () => {
  const b = board(4),
    q = p("x", "R", "6", "5,3"),
    occ: any = { [q.pos]: q };
  assert(moves(b, occ, {}, q.pos, q, false).some((m) => m.to === "6,4"));
  occ["5,4"] = p("block", "R", "5", "5,4");
  occ["6,3"] = p("block2", "R", "5", "6,3");
  assert(!moves(b, occ, {}, q.pos, q, false).some((m) => m.to === "6,4"));
});
test("artillery fires exactly three squares and may cross lakes", () => {
  const b = board(4),
    q = p("x", "R", "C", "4,6"),
    v = p("v", "B", "10", "4,9"),
    occ: any = { [q.pos]: q, [v.pos]: v };
  assert.deepEqual(targets(b, occ, {}, q.pos), []);
  v.pos = "7,6";
  delete occ["4,9"];
  occ[v.pos] = v;
  assert(targets(b, occ, {}, q.pos).includes("7,6"));
  occ["5,6"] = p("z", "Y", "2", "5,6");
  assert(!targets(b, occ, {}, q.pos).includes("7,6"));
});
test("flag ownership determines winner even on an enemy carrier", () => {
  const g = sparse([
    p("x", "R", "10", "RING", ["B"]),
    p("b", "B", "5", "1,8"),
    p("y", "Y", "5", "7,14"),
    p("g", "G", "5", "13,8"),
  ]);
  step(g, { type: "move", seat: "R", pieceId: "x", to: "7,8" });
  assert.equal(g.winner, "B");
});
test("equal carriers drop flags on their original squares", () => {
  const g = sparse([
    p("x", "R", "7", "5,4", ["R"]),
    p("b", "B", "7", "5,5", ["B"]),
    p("r", "R", "2", "4,3"),
    p("y", "Y", "5", "7,14"),
    p("g", "G", "5", "13,8"),
  ]);
  step(g, { type: "move", seat: "R", pieceId: "x", to: "5,5" });
  assert.deepEqual(g.groundFlags["5,4"], ["R"]);
  assert.deepEqual(g.groundFlags["5,5"], ["B"]);
});
test("a carrier exchanges flags and drops its previous flag at source", () => {
  const g = sparse([
    p("x", "R", "10", "5,4", ["R"]),
    p("b", "B", "7", "5,5", ["B"]),
    p("bb", "B", "2", "1,8"),
    p("y", "Y", "5", "7,14"),
    p("g", "G", "5", "13,8"),
  ]);
  step(g, { type: "move", seat: "R", pieceId: "x", to: "5,5" });
  assert.deepEqual(g.pieces.find((p) => p.id === "x")?.flags, ["B"]);
  assert.deepEqual(g.groundFlags["5,4"], ["R"]);
});
test("sixth combat point interrupts for reinforcement", () => {
  const g = sparse([
    p("x", "R", "10", "5,4"),
    p("b", "B", "7", "5,5"),
    p("bb", "B", "2", "1,8"),
    p("y", "Y", "5", "7,14"),
    p("g", "G", "5", "13,8"),
  ]);
  g.promo.R = 5;
  g.graveyard.R = ["6"];
  step(g, { type: "move", seat: "R", pieceId: "x", to: "5,5" });
  assert.equal(g.promoWait?.seat, "R");
  step(g, { type: "recruit", seat: "R", rank: "6" });
  assert(
    g.pieces.some((p) => p.owner === "R" && p.pos === "7,2" && p.rank === "6"),
  );
  assert.equal(g.promo.R, 0);
});
test("occupied reinforcement square loses reinforcement", () => {
  const g = sparse([
    p("x", "R", "10", "5,4"),
    p("r", "R", "4", "7,2"),
    p("b", "B", "7", "5,5"),
    p("bb", "B", "2", "1,8"),
    p("y", "Y", "5", "7,14"),
    p("g", "G", "5", "13,8"),
  ]);
  g.promo.R = 5;
  g.graveyard.R = ["6"];
  step(g, { type: "move", seat: "R", pieceId: "x", to: "5,5" });
  assert.equal(g.promoWait, null);
  assert.equal(g.promo.R, 0);
});
test("rank knowledge persists without a server version field", () => {
  const g = view(initial(3, 1), "R");
  delete g.ver;
  const m = newMemory();
  observe(g, m);
  const e = g.pieces.find((p) => p.owner === "B")!;
  e.rank = "9";
  g.moveCount++;
  observe(g, m);
  e.rank = null;
  g.moveCount++;
  observe(g, m);
  assert.deepEqual(belief(g, e, m), [["9", 1]]);
});
test("hidden ranks and simulator internals do not reach opponents", () => {
  const g = initial(4, 3),
    v = view(g, "R");
  assert(v.pieces.filter((p) => p.owner !== "R").every((p) => p.rank === null));
  assert.equal(v.flagsLast, undefined);
  assert.equal(v.histories, undefined);
  assert.equal(v.seed, undefined);
});
test("geometry agrees with local actions before repetition restrictions", () => {
  for (const mode of [3, 4]) {
    const g = initial(mode, 3);
    assert.deepEqual(checkGeometry(view(g, "R")), []);
  }
});
test("three repeated edge crossings block the fourth crossing", () => {
  const g = sparse([
    p("x", "R", "5", "5,3"),
    p("b", "B", "2", "1,8"),
    p("y", "Y", "5", "7,14"),
    p("g", "G", "5", "13,8"),
  ]);
  g.histories.R = { piece: "x", edges: { "5,3|5,4": 3 } };
  assert(!simActions(g).x?.moves.includes("5,4"));
});
test("no capture limit ends in a draw", () => {
  const g = sparse([
    p("x", "R", "5", "5,3"),
    p("b", "B", "2", "1,8"),
    p("y", "Y", "5", "7,14"),
    p("g", "G", "5", "13,8"),
  ]);
  g.movesSinceCapture = 299;
  step(g, { type: "move", seat: "R", pieceId: "x", to: "5,4" });
  assert.equal(g.status, "finished");
  assert.equal(g.winner, null);
});
test("paired bounds require evidence and reject identical policies", () => {
  assert(bounds(Array(600).fill(1)).lower > 0);
  assert(bounds(Array(600).fill(0)).lower < 0);
  assert(bounds(Array(300).fill(-1)).upper < 0);
});
test("seeded random generator is reproducible", () => {
  const a = rng(3),
    b = rng(3);
  assert.deepEqual(
    Array.from({ length: 10 }, () => a()),
    Array.from({ length: 10 }, () => b()),
  );
});
test("turn buffer preserves reserve, timeout eliminates the acting seat", async () => {
  const { enableClock, elapse } = await import("../src/simulator.js");
  const g = initial(3, 1);
  enableClock(g, 1000, 10000);
  elapse(g, 10000);
  assert.equal(g.clock.left.R, 1000);
  elapse(g, 1000);
  assert.equal(g.out.R, "timeout");
  assert.equal(g.turn, "B");
});
test("reinforcement wait pauses clocks and expires after thirty seconds", async () => {
  const { enableClock, elapse } = await import("../src/simulator.js");
  const g = initial(3, 1);
  enableClock(g);
  g.promoWait = { seat: "R", remainingMs: 30000 };
  g.nextTurn = "B";
  elapse(g, 30000);
  assert.equal(g.promoWait, null);
  assert.equal(g.clock.left.R, 600000);
});
test("chase repetitions are blocked except immediate retreat", () => {
  const g = sparse([
    p("x", "R", "5", "5,3"),
    p("b", "B", "5", "5,5"),
    p("y", "Y", "5", "7,14"),
    p("g", "G", "5", "13,8"),
  ]);
  g.chases.R = { piece: "x", target: "b", seen: ["5,4|5,5"] };
  g.histories.R = { piece: "x", edges: {}, previous: "5,2" };
  assert(!simActions(g).x.moves.includes("5,4"));
  g.histories.R.previous = "5,4";
  g.ver++;
  assert(simActions(g).x.moves.includes("5,4"));
});
test("artillery can shoot across a lake into the bunker ring", () => {
  const b = board(4),
    q = p("x", "R", "C", "6,4"),
    v = p("v", "B", "10", "RING"),
    occ: any = { [q.pos]: q, [v.pos]: v };
  assert(b.lake("6,5"));
  assert(targets(b, occ, {}, q.pos).includes("RING"));
});
test("candidate inputs reject unknown fields and invalid numeric weights", async () => {
  const { validateWeights, DEFAULT } = await import("../src/strategy.js");
  assert.throws(
    () => validateWeights({ ...DEFAULT, password: "must-not-publish" }),
    /Unknown candidate field/,
  );
  assert.throws(
    () => validateWeights({ ...DEFAULT, risk: NaN }),
    /Invalid candidate weight/,
  );
  assert.throws(
    () => validateWeights({ ...DEFAULT, carrier: "999" }),
    /Invalid carrier/,
  );
});
