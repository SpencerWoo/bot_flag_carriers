import { createHash } from "node:crypto";
import fs from "node:fs";
import { read, records } from "./storage.js";
import type { MasterRecord } from "./master-git.js";

export function publicJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (e: any) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
}

type Mode = 3 | 4;
type Outcome = "W" | "L" | "D" | "unknown";
type Kind = "offline" | "friendly" | "test" | "unknown";
interface Receipt {
  mode: Mode;
  kind: Kind;
  outcome: Outcome;
  generation?: number;
  hash?: string;
}
interface Score {
  games: number;
  wins: number;
  losses: number;
  draws: number;
  unscored: number;
}
export interface LiveRow extends Score {
  master: string;
  kind: Kind;
  mode: Mode;
}
const zero = (): Score => ({
  games: 0,
  wins: 0,
  losses: 0,
  draws: 0,
  unscored: 0,
});
const blankBoards = () => ({ 3: zero(), 4: zero() });
const outcomeKey = {
  W: "wins",
  L: "losses",
  D: "draws",
  unknown: "unscored",
} as const;
const G0 = "3bd526b4cf8bf1c58938364dd4b1c5b6e978ac3ebae695d9d6cf338ba416e6ff";
// These two original website replays were inspected and recorded in results/README.md.
const original: Record<
  string,
  { mode: Mode; moveCount: number; outcome: Outcome }
> = {
  "4a9d514018a3c4bc130012d75d7a9327657418f2b6c46bcb070bd3e0663857a9": {
    mode: 3,
    moveCount: 40,
    outcome: "W",
  },
  bf1e01efa666c4348867dc3610452087cbeb5e70e6f3a939fc9f615d732422af: {
    mode: 4,
    moveCount: 150,
    outcome: "L",
  },
};
const receiptId = (gameId: string) =>
  createHash("sha256")
    .update("flag-carriers/receipt/1/" + gameId)
    .digest("hex");
function gameReceipt(g: any, key: string): Receipt {
  const snapshot = read<any>("checkpoint-" + g.id + ".json", {}),
    verified = original[key];
  const seat = g.seat ?? snapshot.mySeats?.[0] ?? (verified ? "R" : undefined);
  const raw = seat ? g.results?.[seat] : null;
  const outcome: Outcome =
    raw === "W" || raw === "L" || raw === "D" ? raw : "unknown";
  const kind: Kind =
    g.kind === "offline" || g.kind === "test" || g.kind === "friendly"
      ? g.kind
      : snapshot.offline
        ? "offline"
        : snapshot.testMode
          ? "test"
          : "unknown";
  if (
    Number.isSafeInteger(g.masterGeneration) &&
    g.masterGeneration >= 0 &&
    typeof g.masterHash === "string" &&
    /^[a-f0-9]{64}$/.test(g.masterHash)
  )
    return {
      mode: g.mode,
      kind,
      outcome,
      generation: g.masterGeneration,
      hash: g.masterHash,
    };
  if (
    g.masterGeneration === undefined &&
    g.masterHash === undefined &&
    verified &&
    verified.mode === g.mode &&
    verified.moveCount === g.moveCount &&
    verified.outcome === outcome
  )
    return { mode: g.mode, kind: "offline", outcome, generation: 0, hash: G0 };
  return { mode: g.mode, kind, outcome };
}

export function liveSnapshot(
  previous: any = publicJson("results/summary.json", {}),
  history: MasterRecord[] = publicJson("league/history.json", []),
) {
  const receipts: Record<string, Receipt> = { ...previous.liveReceipts };
  const legacy = previous.unattributedLiveTotals ?? blankBoards();
  const byGame = new Map<string, any>();
  for (const g of records("live-results.jsonl"))
    if (
      g.finished &&
      typeof g.id === "string" &&
      /^[\w-]+$/.test(g.id) &&
      (g.mode === 3 || g.mode === 4)
    )
      byGame.set(g.id, g);
  if (
    previous.live &&
    !previous.liveReceipts &&
    !previous.unattributedLiveTotals
  ) {
    // Older exports had only board totals. Carry their unmatched counts forward.
    for (const mode of [3, 4] as const) {
      const old = previous.live[mode] ?? zero();
      legacy[mode] = {
        ...zero(),
        ...old,
        unscored: Math.max(0, old.games - old.wins - old.losses - old.draws),
      };
    }
    for (const [id, g] of byGame) {
      if (g.time && previous.updated && g.time > previous.updated) continue;
      const known = gameReceipt(g, receiptId(id)),
        s: Score = legacy[known.mode],
        key = outcomeKey[known.outcome];
      if (s[key] > 0) {
        s[key]--;
        s.games--;
      }
    }
  }
  for (const [id, g] of byGame) {
    const key = receiptId(id),
      r = gameReceipt(g, key),
      old = receipts[key];
    // An older local checkpoint may lack information from an already exported result.
    receipts[key] = old
      ? {
          ...old,
          ...r,
          kind: r.kind === "unknown" ? old.kind : r.kind,
          outcome: r.outcome === "unknown" ? old.outcome : r.outcome,
        }
      : r;
  }
  const totals = blankBoards(),
    table = new Map<string, LiveRow>();
  function row(master: string, kind: Kind, mode: Mode) {
    const key = [master, kind, mode].join("/");
    if (!table.has(key)) table.set(key, { master, kind, mode, ...zero() });
    return table.get(key)!;
  }
  const known = new Set(history.map((h) => h.generation + "/" + h.hash));
  for (const r of Object.values(receipts)) {
    const label = known.has(r.generation + "/" + r.hash)
      ? "G" + r.generation
      : "Unattributed";
    const s = row(label, r.kind, r.mode),
      k = outcomeKey[r.outcome];
    s[k]++;
    s.games++;
    totals[r.mode][k]++;
    totals[r.mode].games++;
  }
  for (const mode of [3, 4] as const) {
    const archived: Score = legacy[mode] ?? zero();
    if (!archived.games) continue;
    const s = row("Unattributed", "unknown", mode);
    for (const name of [
      "wins",
      "losses",
      "draws",
      "unscored",
      "games",
    ] as const) {
      const n = archived[name] ?? 0;
      s[name] += n;
      totals[mode][name] += n;
    }
  }
  for (const h of history)
    for (const mode of [3, 4] as const)
      row("G" + h.generation, "offline", mode);
  const order = (x: string) => (/^G\d+$/.test(x) ? Number(x.slice(1)) : -1);
  const rows = [...table.values()].sort(
    (a, b) =>
      order(b.master) - order(a.master) ||
      a.kind.localeCompare(b.kind) ||
      a.mode - b.mode,
  );
  return { receipts, unattributedLiveTotals: legacy, totals, rows };
}
export const liveHeadings = [
  "Master",
  "Game type",
  "Players",
  "Games",
  "Wins",
  "Losses",
  "Draws",
  "Unscored",
  "Win rate",
];
const kinds: Record<Kind, string> = {
  offline: "Site bots",
  friendly: "Friendly",
  test: "Test",
  unknown: "Unknown",
};
export function liveCells(r: LiveRow) {
  const scored = r.wins + r.losses + r.draws;
  return [
    r.master,
    kinds[r.kind],
    r.mode,
    r.games,
    r.wins,
    r.losses,
    r.draws,
    r.unscored,
    scored ? ((100 * r.wins) / scored).toFixed(1) + "%" : "—",
  ];
}
export function liveMarkdown(rows: LiveRow[]) {
  const line = (cells: (string | number)[]) => "| " + cells.join(" | ") + " |";
  return [
    "# Website results by Master generation",
    "",
    "These are completed games on Flag Carriers. Site bots are the opponents in its Offline mode. Win rates use games with a known outcome for the agent’s seat.",
    "",
    line(liveHeadings),
    line(liveHeadings.map(() => "---")),
    ...rows.map((r) => line(liveCells(r))),
    "",
    "G0 includes the two site games documented in the [initial validation](README.md). Later results are attributed by the recorded generation and policy hash.",
    "",
    "[Local self-play leaderboard](../league/leaderboard.md)",
    "",
  ].join("\n");
}
