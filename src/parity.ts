import { board, moves, targets, type Game, type Action } from "./core.js";
import { step, type SimState } from "./simulator.js";
export function checkGeometry(g: Game): string[] {
  if (g.status !== "playing" || g.promoWait || !g.mySeats.includes(g.turn))
    return [];
  const B = board(g.mode),
    occ = Object.fromEntries(g.pieces.map((p) => [p.pos, p])),
    errors: string[] = [];
  for (const p of g.pieces.filter((p) => p.owner === g.turn)) {
    if (!p.rank) {
      errors.push("Own rank missing");
      continue;
    }
    const a = g.actions[p.id] || { moves: [], fires: [], blocked: {} };
    for (const drop of p.flags.length ? [false, true] : [false]) {
      const blocks = drop ? a.dropBlocked || {} : a.blocked || {},
        actual = new Set<string>(drop ? a.dropMoves || [] : a.moves || []);
      const expected = new Set<string>(
        moves(B, occ, g.groundFlags, p.pos, p, drop)
          .map((x) => x.to)
          .filter((n) => !blocks[n]),
      );
      if (
        [...expected].some((n) => !actual.has(n)) ||
        [...actual].some((n) => !expected.has(n))
      )
        errors.push(`Movement geometry mismatch: ${p.id}, drop=${drop}`);
    }
    const expected =
        p.rank === "C" ? targets(B, occ, g.groundFlags, p.pos) : [],
      actual = a.fires || [];
    if (
      expected.length !== actual.length ||
      expected.some((n) => !actual.includes(n))
    )
      errors.push("Artillery geometry mismatch: " + p.id);
  }
  return errors;
}
export function checkTransition(
  before: Game,
  a: Action,
  after: Game,
): { checked: boolean; errors: string[] } {
  if (!["move", "fire", "recruit"].includes(a.type))
    return { checked: false, errors: [] };
  if (
    a.type !== "recruit" &&
    (after.lastAction?.pieceId !== a.pieceId ||
      after.lastAction?.moveCount !== before.moveCount + 1)
  )
    return { checked: false, errors: [] };
  const g = structuredClone(before) as SimState;
  for (const p of g.pieces)
    if (!p.rank)
      p.rank =
        after.lastAction?.combat && p.id === a.pieceId
          ? after.lastAction.combat.att.rank
          : after.lastAction?.combat && p.pos === (a.to || a.target)
            ? after.lastAction.combat.def.rank
            : after.lastAction?.victim && p.pos === a.target
              ? after.lastAction.victim.rank
              : "5";
  g.flagsLast = { R: "R", B: "B", Y: "Y", G: "G" };
  g.histories = {};
  g.chases = {};
  g.pending = [];
  g.nextTurn = g.turn;
  g.reveal = [];
  g.ver = before.moveCount;
  try {
    step(g, a);
  } catch (e: any) {
    return {
      checked: false,
      errors: ["Simulator rejected server action: " + e.message],
    };
  }
  const physical = (v: Game) =>
    JSON.stringify(
      v.pieces
        .map((p) => [p.id, p.owner, p.pos, p.flags])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
  const errors: string[] = [];
  // Reinforcement IDs are server-generated; compare only rank/owner/location for this action.
  if (a.type === "recruit") {
    const newPiece = after.pieces.find(
      (p) => !before.pieces.some((q) => q.id === p.id),
    );
    if (
      !newPiece ||
      newPiece.owner !== a.seat ||
      newPiece.rank !== a.rank ||
      newPiece.pos !== board(before.mode).recruit[a.seat]
    )
      errors.push("Reinforcement transition mismatch");
  } else if (physical(g) !== physical(after))
    errors.push("Piece or flag transition mismatch");
  const normalized = (o: any) =>
    JSON.stringify(
      Object.entries(o)
        .filter(([, v]) => !Array.isArray(v) || v.length)
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  if (normalized(g.groundFlags) !== normalized(after.groundFlags))
    errors.push("Ground flag transition mismatch");
  if (JSON.stringify(g.graveyard) !== JSON.stringify(after.graveyard))
    errors.push("Graveyard transition mismatch");
  return { checked: true, errors };
}
