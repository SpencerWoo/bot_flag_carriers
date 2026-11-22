import { board, duel, type Game, type Piece } from "./core.js";

interface Approach {
  from: string;
  adjacent: boolean;
  cavalry: string[];
  scouts: string[][];
  shots: string[][];
}
const indices = new Map<number, Map<string, Approach[]>>();
// For each destination list only origins that can reach it, plus the intermediate
// squares to check. Geometry is computed once for each board, occupancy per move.
function index(mode: number) {
  const cached = indices.get(mode);
  if (cached) return cached;
  const b = board(mode),
    destinations = new Map<string, Approach[]>();
  for (const from of [...b.all(), "RING", b.V]) {
    if (b.lake(from)) continue;
    const byTarget = new Map<string, Approach>();
    const at = (to: string) => {
      let e = byTarget.get(to);
      if (!e) {
        e = { from, adjacent: false, cavalry: [], scouts: [], shots: [] };
        byTarget.set(to, e);
      }
      return e;
    };
    for (const mid of b.nb(from)) {
      at(mid).adjacent = true;
      if (mid === "RING" || mid === b.V) continue;
      for (const to of b.nb(mid))
        if (to !== from && to !== b.V) at(to).cavalry.push(mid);
    }
    for (const ray of b.rays(from) as string[][]) {
      const via: string[] = [];
      if (from !== "RING" && from !== b.V)
        for (const n of ray) {
          if (b.castle(n)) {
            at("RING").scouts.push([...via]);
            break;
          }
          if (b.lake(n)) break;
          at(n).scouts.push([...via]);
          via.push(n);
        }
      if (ray.length >= 3 && !b.castle(ray[0]) && !b.castle(ray[1]))
        at(b.castle(ray[2]) ? "RING" : ray[2]).shots.push([ray[0], ray[1]]);
    }
    for (const [dest, e] of byTarget) {
      const bucket = destinations.get(dest) ?? [];
      bucket.push(e);
      destinations.set(dest, bucket);
    }
  }
  indices.set(mode, destinations);
  return destinations;
}
export function riskAtDestinations(
  g: Game,
  occ: Record<string, Piece>,
  rankDistribution: (p: Piece) => [string, number][],
) {
  const approaches = index(g.mode);
  const cached = new Map<string, Map<string, number>>();
  const clear = (n: string) => !occ[n] && !(g.groundFlags[n] || []).length;
  return function risk(dest: string, defender: string) {
    let values = cached.get(dest);
    if (!values) {
      values = new Map();
      cached.set(dest, values);
    }
    const prior = values.get(defender);
    if (prior !== undefined) return prior;
    let max = 0;
    const victim = occ[dest];
    for (const e of approaches.get(dest) || []) {
      const p = occ[e.from];
      if (!p || p.owner === g.turn || g.out[p.owner] || p === victim) continue;
      const entry = !victim || victim.owner !== p.owner;
      const ordinary = entry && e.adjacent;
      const cavalry = entry && !p.flags.length && e.cavalry.some(clear);
      const scout =
        entry && !p.flags.length && e.scouts.some((path) => path.every(clear));
      const fire = e.shots.filter((path) => path.every(clear)).length;
      if (!ordinary && !cavalry && !scout && !fire) continue;
      let chance = 0;
      for (const [rank, prob] of rankDistribution(p)) {
        if (
          (ordinary || (rank === "2" && scout) || (rank === "6" && cavalry)) &&
          duel(rank, defender) >= 0
        )
          chance += prob;
        if (rank === "C" && fire) chance += prob * fire;
      }
      if (chance > max) max = chance;
    }
    values.set(defender, max);
    return max;
  };
}
