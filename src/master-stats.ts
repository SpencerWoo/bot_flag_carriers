import { createHash } from "node:crypto";
export const HOLDOUT_PAIRS = 1200;
export const ANCHOR_PAIRS = 120;
export const EDGE = 0.03;

export interface PairScore {
  index: number;
  mode: 3 | 4;
  candidateWins: number;
  masterWins: number;
  draws: number;
  complete: boolean;
}
export function schedule(index: number, key: string) {
  const mode: 3 | 4 = index % 2 === 0 ? 3 : 4;
  const seats: [number, number][] = [];
  for (let a = 0; a < mode; a++)
    for (let b = a + 1; b < mode; b++) seats.push([a, b]);
  const boardIndex = Math.floor(index / 2);
  const seed = createHash("sha256")
    .update(key + ":" + index)
    .digest()
    .readUInt32LE(0);
  return { mode, seed, slots: seats[boardIndex % seats.length], boardIndex };
}
function summarize(rows: PairScore[]) {
  const count = rows.length;
  const challenger = rows.reduce((n, r) => n + r.candidateWins, 0);
  const master = rows.reduce((n, r) => n + r.masterWins, 0);
  const draws = rows.reduce((n, r) => n + r.draws, 0);
  const games = count * 2;
  return {
    pairs: count,
    games,
    challenger,
    master,
    other: games - challenger - master - draws,
    draws,
    candidateRate: games ? challenger / games : 0,
    masterRate: games ? master / games : 0,
    edge: games ? (challenger - master) / games : 0,
  };
}
// For independent bounded seed-pair outcomes X_i the factors are positive.
// Under H0: average E[X_i] <= m, the arithmetic mean of their expectations
// is at most one. Independence and AM-GM bound each product's expectation
// by one even with different board/seat strata. A prespecified mixture is
// also an e-value. Reject at 1/alpha by Markov's inequality.
const fractions = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.15, 0.25, 0.4, 0.6, 0.8, 0.95,
];
export function logMixtureE(histogram: number[], m: number) {
  const logs = fractions.map((t) =>
    histogram.reduce(
      (sum, n, i) =>
        n ? sum + n * Math.log1p((t * ((i - 2) / 2 - m)) / (1 + m)) : sum,
      0,
    ),
  );
  const max = Math.max(...logs);
  return (
    max +
    Math.log(logs.reduce((n, v) => n + Math.exp(v - max), 0) / logs.length)
  );
}
function lowerBound(histogram: number[], alpha: number) {
  let lo = -1,
    hi = 1;
  for (let i = 0; i < 48; i++) {
    const m = (lo + hi) / 2;
    if (logMixtureE(histogram, m) >= -Math.log(alpha)) lo = m;
    else hi = m;
  }
  return lo;
}
function interval(rows: PairScore[], alpha: number) {
  const stats = summarize(rows),
    counts = [0, 0, 0, 0, 0];
  for (const r of rows) counts[2 + r.candidateWins - r.masterWins]++;
  return {
    ...stats,
    lower: lowerBound(counts, alpha),
    upper: -lowerBound([...counts].reverse(), alpha),
  };
}
export function adjudicate(rows: PairScore[], attempt: number) {
  if (!Number.isSafeInteger(attempt) || attempt < 1)
    throw Error("Invalid generation attempt");
  const alpha = 0.05 / (attempt * (attempt + 1));
  const overall = interval(rows, alpha),
    three = interval(
      rows.filter((r) => r.mode === 3),
      alpha,
    ),
    four = interval(
      rows.filter((r) => r.mode === 4),
      alpha,
    );
  const complete =
    rows.length === HOLDOUT_PAIRS &&
    three.pairs === 600 &&
    four.pairs === 600 &&
    new Set(rows.map((r) => r.index)).size === HOLDOUT_PAIRS &&
    rows.every(
      (r) =>
        r.complete &&
        isScore(r) &&
        r.index < HOLDOUT_PAIRS &&
        r.mode === (r.index % 2 ? 4 : 3),
    );
  const passed =
    complete &&
    overall.edge >= EDGE &&
    overall.lower > 0 &&
    three.upper >= 0 &&
    four.upper >= 0;
  return {
    complete,
    passed,
    attempt,
    alpha,
    overall,
    three,
    four,
    method:
      "One-sided fixed-grid mixture e-value bound for independent paired seed averages, with generation-wise alpha spending",
  };
}
export function isScore(r: PairScore): boolean {
  return (
    Number.isInteger(r.index) &&
    r.index >= 0 &&
    (r.mode === 3 || r.mode === 4) &&
    [r.candidateWins, r.masterWins, r.draws].every(
      (n) => Number.isInteger(n) && n >= 0,
    ) &&
    r.candidateWins + r.masterWins + r.draws <= 2
  );
}
export function anchorScore(rows: PairScore[]) {
  if (
    rows.length !== ANCHOR_PAIRS ||
    !rows.every((r) => r.complete && isScore(r))
  )
    throw Error("Fixed-anchor tournament incomplete");
  return {
    overall: summarize(rows),
    three: summarize(rows.filter((r) => r.mode === 3)),
    four: summarize(rows.filter((r) => r.mode === 4)),
  };
}
export type QualificationStats = ReturnType<typeof adjudicate>;
export type AnchorScore = ReturnType<typeof anchorScore>;
