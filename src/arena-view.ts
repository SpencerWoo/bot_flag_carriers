import type { Game, Seat, Piece } from "./core.js";
import { simActions, type SimState } from "./simulator.js";

function cloneFlags<T extends string>(flags: Record<string, T[]>) {
  return Object.fromEntries(Object.entries(flags).map(([p, f]) => [p, [...f]]));
}
function copyAction(a: any) {
  if (!a) return null;
  const out: any = {
    type: a.type,
    seat: a.seat,
    from: a.from,
    to: a.to,
    pieceId: a.pieceId,
    moveCount: a.moveCount,
    dropped: a.dropped,
    scoutRun: a.scoutRun,
    captainTurn: a.captainTurn,
  };
  if (a.combat) {
    const participant = (q: any) => ({
      id: q.id,
      rank: q.rank,
      owner: q.owner,
    });
    out.combat = {
      att: participant(a.combat.att),
      def: participant(a.combat.def),
      result: a.combat.result,
      points: a.combat.points,
    };
  }
  if (a.victim) out.victim = { owner: a.victim.owner, rank: a.victim.rank };
  if (a.left) out.left = [...a.left];
  if (a.picked) out.picked = [...a.picked];
  return out;
}
function copyLegal(raw: Record<string, any>) {
  const result: Record<string, any> = {};
  for (const [id, a] of Object.entries(raw)) {
    result[id] = {
      moves: [...(a.moves || [])],
      fires: [...(a.fires || [])],
      blocked: { ...a.blocked },
    };
    if (a.dropMoves) {
      result[id].dropMoves = [...a.dropMoves];
      result[id].dropBlocked = { ...a.dropBlocked };
    }
  }
  return result;
}
// Explicit allowlist used for both the server and the local referee. New server or
// engine fields are private by default. This object can be mutated without affecting play.
export function arenaPlayerView(raw: Game, seat: Seat): Game {
  const local = "histories" in raw && "reveal" in raw;
  const mine = raw.mySeats.includes(seat);
  const actionOwner =
    raw.turn === seat && mine && !raw.promoWait && raw.status === "playing";
  const pieces: Piece[] = raw.pieces.map((p) => ({
    id: p.id,
    owner: p.owner,
    pos: p.pos,
    rank:
      (p.owner === seat && mine) ||
      (local ? raw.reveal.includes(p.id) : p.revealed)
        ? p.rank
        : null,
    flags: [...p.flags],
  }));
  return {
    id: "match",
    mode: raw.mode,
    status: raw.status,
    turn: raw.turn,
    ver: raw.ver,
    moveCount: raw.moveCount ?? 0,
    pieces,
    mySeats: mine ? [seat] : [],
    actions: actionOwner
      ? copyLegal(local ? simActions(raw as SimState, seat) : raw.actions || {})
      : {},
    groundFlags: cloneFlags(raw.groundFlags),
    graveyard: cloneFlags(raw.graveyard) as Game["graveyard"],
    promo: { ...raw.promo },
    out: { ...raw.out },
    movesSinceCapture: raw.movesSinceCapture ?? 0,
    lastAction: copyAction(raw.lastAction),
    lastRecruit: raw.lastRecruit
      ? {
          seat: raw.lastRecruit.seat,
          rank: raw.lastRecruit.rank,
          to: raw.lastRecruit.to,
          turnNumber: raw.lastRecruit.turnNumber,
        }
      : null,
    promoWait: raw.promoWait
      ? { seat: raw.promoWait.seat, reason: raw.promoWait.reason }
      : null,
    winner: raw.winner ?? null,
    results: raw.results ? { ...raw.results } : null,
  };
}
