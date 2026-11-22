import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { initial, simActions } from "../src/simulator.js";
import {
  arenaPlayerView,
  compileArenaPolicy,
  G0_SOURCE,
  playArenaPair,
} from "../src/arena-match.js";
import { board, legalActions } from "../src/core.js";
const g0 = compileArenaPolicy(G0_SOURCE);

test("local views and RNGs prevent disclosure or mutation of referee state", () => {
  const g = initial(4, 423);
  const v = arenaPlayerView(g, "R");
  assert(!JSON.stringify(v).includes("local-423"));
  assert(v.pieces.filter((p) => p.owner !== "R").every((p) => p.rank === null));
  assert.equal(v.seed, undefined);
  assert.deepEqual(v.mySeats, ["R"]);
  assert.equal(v.chases, undefined);
  assert.equal(v.histories, undefined);
  const id = Object.keys(v.actions)[0],
    before = [...simActions(g)[id].moves];
  v.actions[id].moves.length = 0;
  assert.deepEqual(simActions(g)[id].moves, before);
  v.pieces[0].pos = "RING";
  assert.notEqual(g.pieces[0].pos, "RING");
});
test("live projections hide test-mode enemy ranks unless publicly revealed and remove server metadata", () => {
  const local = initial(4, 1),
    g: any = {
      ...local,
      id: "live-id",
      mySeats: ["R", "B", "Y", "G"],
      seats: { R: "person" },
      chat: ["private"],
    };
  delete g.histories;
  delete g.reveal;
  const enemy = g.pieces.find((p: any) => p.owner === "B");
  enemy.revealed = true;
  const v = arenaPlayerView(g, "R");
  assert.equal(v.pieces.find((p) => p.id === enemy.id)?.rank, enemy.rank);
  assert(
    v.pieces
      .filter((p) => p.owner !== "R" && p.id !== enemy.id)
      .every((p) => p.rank === null),
  );
  assert(!JSON.stringify(v).includes("private"));
  assert(!JSON.stringify(v).includes("live-id"));
});
test("policy modules run in fresh realms and share only public observations and seeded helpers", () => {
  const p = compileArenaPolicy(
    `let calls=0;export default ({legalActions,random,board,distances})=>({choose(v){calls++;if(typeof process!=='undefined'||typeof require!=='undefined'||Date!==undefined||calls!==1||board(v.mode).nb(board(v.mode).V)[0]!=='RING')throw Error('unexpected environment');return legalActions(v)[Math.floor(random()*legalActions(v).length)]}})`,
  );
  const v = arenaPlayerView(initial(3, 17), "R");
  assert.deepEqual(p.create(81).choose(v), p.create(81).choose(v));
  assert.throws(
    () => compileArenaPolicy('import x from "node:fs";export default () => x;'),
    /self-contained/,
  );
});
test("one game per seat orientation, identical policies produce zero edge, fixed seed replays", () => {
  const spec = {
    challenger: g0,
    master: g0,
    mode: 3,
    seed: 818,
    slots: [0, 2] as const,
    trace: true,
  };
  const pair = playArenaPair(spec);
  assert(pair.complete);
  assert.equal(pair.delta, 0);
  assert.deepEqual(
    pair.games.map((g) => [g.challengerSeat, g.masterSeat]),
    [
      ["R", "Y"],
      ["Y", "R"],
    ],
  );
  assert.deepEqual(pair.games[0].actions, pair.games[1].actions);
  assert.deepEqual(playArenaPair(spec), pair);
});
test("stalled and illegal choices cannot win a qualification pair", () => {
  const stuck = compileArenaPolicy(
    "export default () => ({choose(){for(;;){}}})",
  );
  const g = arenaPlayerView(initial(3, 1), "R");
  assert.throws(
    () => stuck.create(1, { timeoutMs: 25 }).choose(g),
    /timed out/,
  );
  assert.throws(
    () =>
      playArenaPair({
        mode: 3,
        seed: 0,
        slots: [0, 1],
        challenger: compileArenaPolicy(
          'export default ()=>({choose:()=>({type:"move",seat:"B"})})',
        ),
        master: g0,
      }),
    /illegal/,
  );
  const capped = playArenaPair({
    mode: 4,
    seed: 3,
    challenger: g0,
    master: g0,
    maxPlies: 1,
  });
  assert.equal(capped.complete, false);
  assert(capped.games.every((g) => !g.draw));
});
test("public events arrive between turns, with isolated private memory", () => {
  const seen = new Set<string>();
  const p = {
    hash: "test",
    create: () => ({
      observe(g: any) {
        const me = g.mySeats[0];
        if (g.turn !== me && g.lastAction) seen.add(me);
      },
      choose(g: any) {
        return legalActions(g)[0];
      },
    }),
  };
  playArenaPair({
    mode: 3,
    seed: 1,
    slots: [0, 1],
    challenger: p,
    master: p,
    fillers: [p],
    maxPlies: 8,
  });
  assert.equal(seen.size, 3);
});

test("optimized referee and V0 reproduce both original board trajectories", async () => {
  const { rng } = await import("../src/core.js"),
    { view, step } = await import("../src/simulator.js");
  const { decide, DEFAULT, newMemory } = await import("../src/strategy.js");
  const hashes = [
    "e580ce5c08225358f909364c59a50a3915a690496dd42289d6f674d9de3cca9e",
    "2f19164bcda4bcdd57e29a4ad526fc334255bf8ce73a3414f2d888862109f510",
  ];
  for (const [index, expected] of hashes.entries()) {
    const mode = index + 3,
      seed = 12700 + index,
      g = initial(mode, seed);
    const variants = [
      DEFAULT,
      { ...DEFAULT, risk: 3, flag: 8 },
      { ...DEFAULT, capture: 8, risk: 5 },
    ];
    const players = new Map(
      g.mySeats.map((s, slot) => [
        s,
        {
          weights: slot === index ? DEFAULT : variants[(seed + slot) % 3],
          memory: newMemory(),
          random: rng(seed * 31 + slot),
        },
      ]),
    );
    const transcript = createHash("sha256");
    let plies = 0;
    while (g.status === "playing" && plies < 2400) {
      const seat = g.promoWait?.seat ?? g.turn,
        actor = players.get(seat)!;
      const action = decide(
        view(g, seat),
        actor.memory,
        actor.weights,
        actor.random,
        Infinity,
      )!;
      transcript.update(JSON.stringify(action) + "\n");
      step(g, action);
      plies++;
    }
    assert.equal(g.status, "finished");
    assert.equal(transcript.digest("hex"), expected);
  }
});
