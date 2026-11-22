import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

const checkout = path.resolve(process.argv[2] ?? ".");
const moduleUrl = (name) =>
  pathToFileURL(path.join(checkout, "src", name)).href;
const { initial, view, step } = await import(moduleUrl("simulator.ts"));
const { rng } = await import(moduleUrl("core.ts"));
const { DEFAULT, decide, newMemory } = await import(moduleUrl("strategy.ts"));

const roster = [
  DEFAULT,
  { ...DEFAULT, risk: 3, flag: 8 },
  { ...DEFAULT, capture: 8, risk: 5 },
];

function play(index, firstSeed) {
  const mode = 3 + (index % 2);
  const seed = firstSeed + index;
  const game = initial(mode, seed);
  const players = new Map();
  for (const [slot, seat] of game.mySeats.entries()) {
    players.set(seat, {
      weights:
        slot === index % mode ? DEFAULT : roster[(seed + slot) % roster.length],
      memory: newMemory(),
      random: rng(seed * 31 + slot),
    });
  }

  const actions = createHash("sha256");
  let plies = 0;
  while (game.status === "playing") {
    if (plies === 2400)
      throw new Error(`Game at seed ${seed} exceeded the reference ply limit`);
    const seat = game.promoWait?.seat ?? game.turn;
    const { memory, weights, random } = players.get(seat);
    const action = decide(view(game, seat), memory, weights, random);
    if (!action)
      throw new Error(`No action for ${seat} at seed ${seed}, ply ${plies}`);
    actions.update(JSON.stringify(action) + "\n");
    step(game, action);
    plies++;
  }
  // Field order and the newline after every action are part of the published fingerprint.
  return { trace: actions.digest("hex"), plies, winner: game.winner };
}

for (let index = 0; index < 4; index++) play(index, 99000);
const start = performance.now();
const cpu = process.cpuUsage();
const games = Array.from({ length: 24 }, (_, index) => play(index, 12700));
const elapsedMs = performance.now() - start;
const { user, system } = process.cpuUsage(cpu);
console.log(
  JSON.stringify(
    {
      checkout,
      node: process.version,
      elapsedMs,
      cpuMs: (user + system) / 1000,
      plies: games.reduce((sum, game) => sum + game.plies, 0),
      hash: createHash("sha256").update(JSON.stringify(games)).digest("hex"),
      outcomes: games.map(({ winner, plies }, index) => ({
        seed: 12700 + index,
        mode: 3 + (index % 2),
        winner: winner ?? null,
        plies,
      })),
    },
    null,
    2,
  ),
);
