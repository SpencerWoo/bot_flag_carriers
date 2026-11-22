import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const vendor = fs.existsSync(path.join(here, "../vendor/rules-core.cjs"))
  ? "../vendor/rules-core.cjs"
  : "../../vendor/rules-core.cjs";
const { RBOARD, rLegal, rTargets } = require(vendor);
export const board = (mode: number): any => RBOARD[mode];
export const moves = rLegal as (
  b: any,
  occ: any,
  flags: any,
  pos: string,
  p: Piece,
  drop: boolean,
) => { to: string; attack: boolean }[];
export const targets = rTargets as (
  b: any,
  occ: any,
  flags: any,
  pos: string,
) => string[];
export type Seat = "R" | "B" | "Y" | "G";
export const ARMY: Record<string, number> = {
  "10": 1,
  "9": 1,
  "7": 2,
  "6": 3,
  "5": 3,
  "4": 3,
  "2": 4,
  "1": 1,
  C: 2,
};
export interface Piece {
  id: string;
  owner: Seat;
  rank: string | null;
  pos: string;
  flags: Seat[];
  revealed?: boolean;
}
export interface Action {
  type: string;
  seat: Seat;
  pieceId?: string;
  to?: string;
  target?: string;
  dropFlags?: boolean;
  rank?: string;
  [key: string]: any;
}
export interface Game {
  id: string;
  mode: number;
  status: string;
  turn: Seat;
  pieces: Piece[];
  groundFlags: Record<string, Seat[]>;
  actions: Record<string, any>;
  mySeats: Seat[];
  graveyard: Record<Seat, string[]>;
  promo: Record<Seat, number>;
  out: Partial<Record<Seat, string>>;
  [key: string]: any;
}
export function rng(seed: number) {
  let a = seed | 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function shuffle<T>(items: T[], random: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
export function duel(att: string, def: string): number {
  if (att === def) return 0;
  if (att === "C") return -1;
  if (def === "C") return 1;
  if (att === "1" && def === "10") return 1;
  return Number(att) > Number(def) ? 1 : -1;
}
export function actionKey(a: Action) {
  return JSON.stringify([
    a.type,
    a.seat,
    a.pieceId,
    a.to,
    a.target,
    !!a.dropFlags,
    a.rank,
  ]);
}
export function legalActions(g: Game): Action[] {
  if (g.promoWait && g.mySeats.includes(g.promoWait.seat))
    return [...new Set<string>(g.graveyard[g.promoWait.seat as Seat])].map(
      (rank) => ({ type: "recruit", seat: g.promoWait.seat, rank }),
    );
  if (g.status !== "playing" || g.promoWait || !g.mySeats.includes(g.turn))
    return [];
  const out: Action[] = [];
  for (const [pieceId, a] of Object.entries(g.actions || {})) {
    for (const to of a.moves || [])
      out.push({ type: "move", seat: g.turn, pieceId, to });
    for (const to of a.dropMoves || [])
      out.push({ type: "move", seat: g.turn, pieceId, to, dropFlags: true });
    for (const target of a.fires || [])
      out.push({ type: "fire", seat: g.turn, pieceId, target });
  }
  return out;
}
const distanceCache = new Map<string, Record<string, number>>();
export function distances(mode: number, to: string): Record<string, number> {
  const key = mode + ":" + to,
    cached = distanceCache.get(key);
  if (cached) return cached;
  const b = board(mode),
    d: Record<string, number> = { [to]: 0 },
    q = [to];
  for (let i = 0; i < q.length; i++)
    for (const n of b.nb(q[i]))
      if (!(n in d)) {
        d[n] = d[q[i]] + 1;
        q.push(n);
      }
  distanceCache.set(key, d);
  return d;
}
