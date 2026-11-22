// Extracted from the public Flag Carriers rules.js; see SOURCES.md.
const Board3 = require('./board3.cjs');
const RBOARD = (() => {
  // 4 players: squares "c,r" (c 0..14 = A..O, r 1..15), the bunker ring "RING", the centre "7,8" (H8)
  const LAKES4 = new Set(['6,11', '7,11', '8,11', '4,7', '4,8', '4,9', '6,5', '7,5', '8,5', '10,7', '10,8', '10,9']);
  const onBoard = (c, r) => (c >= 3 && c <= 11 && r >= 4 && r <= 12) || (c >= 4 && c <= 10 && ((r >= 1 && r <= 3) || (r >= 13 && r <= 15))) ||
    (r >= 5 && r <= 11 && ((c >= 0 && c <= 2) || (c >= 12 && c <= 14)));
  const inFoot = (c, r) => c >= 6 && c <= 8 && r >= 7 && r <= 9;
  const key = (c, r) => c + ',' + r;
  const parse = (k) => { const [c, r] = k.split(',').map(Number); return { c, r }; };
  const DIR = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const RN = [];
  for (let c = 6; c <= 8; c++) { RN.push(key(c, 6)); RN.push(key(c, 10)); }
  for (let r = 7; r <= 9; r++) { RN.push(key(5, r)); RN.push(key(9, r)); }
  const V4 = '7,8';
  const four = {
    mode: 4, V: V4,
    lake: (n) => LAKES4.has(n),
    castle: (n) => n === 'RING' || (n.includes(',') && inFoot(parse(n).c, parse(n).r)),
    nb(n) {
      if (n === 'RING') return RN.concat([V4]);
      if (n === V4) return ['RING'];
      const { c, r } = parse(n), out = [];
      for (const [dx, dy] of DIR) {
        const nc = c + dx, nr = r + dy;
        if (!onBoard(nc, nr)) continue;
        if (inFoot(nc, nr)) { if (!out.includes('RING')) out.push('RING'); continue; }
        if (!LAKES4.has(key(nc, nr))) out.push(key(nc, nr));
      }
      return out;
    },
    rays(n) {
      if (n === 'RING' || n === V4) return [];
      const { c, r } = parse(n), out = [];
      for (const [dx, dy] of DIR) {
        const ray = []; let cc = c, rr = r;
        for (;;) { cc += dx; rr += dy; if (!onBoard(cc, rr)) break; ray.push(key(cc, rr)); if (inFoot(cc, rr)) break; }
        if (ray.length) out.push(ray);
      }
      return out;
    },
    // drawing: 100 units per square, A1 at the bottom left (the same picture as the game board)
    poly(n) {
      if (n === 'RING') return [[600, 600], [900, 600], [900, 900], [600, 900]];
      const { c, r } = parse(n), x = c * 100, y = (15 - r) * 100;
      return [[x, y], [x + 100, y], [x + 100, y + 100], [x, y + 100]];
    },
    spot(n) { if (n === 'RING') return [750, 650]; const { c, r } = parse(n); return [c * 100 + 50, (15 - r) * 100 + 50]; },
    ringPath: 'M600,600H900V900H600Z M700,700V800H800V700Z',
    all() { const out = []; for (let c = 0; c < 15; c++) for (let r = 1; r <= 15; r++) if (onBoard(c, r) && !inFoot(c, r)) out.push(key(c, r)); return out; },
    camp(n) { if (!n.includes(',')) return null; const { c, r } = parse(n); return r <= 3 ? 'R' : r >= 13 ? 'Y' : c <= 2 ? 'B' : c >= 12 ? 'G' : null; },
    recruit: { R: '7,2', Y: '7,14', B: '1,8', G: '13,8' },
    flagStart: { R: '7,1', Y: '7,15', B: '0,8', G: '14,8' },
    seats: ['R', 'B', 'Y', 'G']
  };
  // 3 players: the spaces of public/board3.js (drawn with y pointing down)
  const three = {
    mode: 3, V: 'CENTER',
    N: () => Board3.NODES,
    lake(n) { const x = this.N()[n]; return !!x && x.kind === 'lake'; },
    castle: (n) => n === 'RING' || n === 'CENTER',
    nb(n) { return this.N()[n] ? this.N()[n].nb.slice() : []; },
    rays(n) { return Board3.rays(n); },
    pt: (q) => [q[0] * 100, -q[1] * 100],
    poly(n) { return this.N()[n].poly.map(this.pt); },
    spot(n) { return n === 'RING' ? [0, -110] : this.pt(this.N()[n].center); },
    all() { return Object.keys(this.N()).filter((k) => k !== 'RING' && k !== 'CENTER'); },
    camp(n) { const x = this.N()[n]; return x ? x.camp || null : null; },
    get recruit() { const o = {}; for (const s of Board3.SEATS) o[s] = Board3.SEAT_INFO[s].recruit; return o; },
    get flagStart() { const o = {}; for (const s of Board3.SEATS) o[s] = Board3.SEAT_INFO[s].flagStart; return o; },
    get seats() { return Board3.SEATS; }
  };
  return { 4: four, 3: three };
})();

// the moves of a piece (same rules as legalMoves in server/game.js)
function rLegal(B, occ, gfl, pos, piece, drop) {
  const carrying = (piece.flags || []).length > 0 && !drop;
  const res = [];
  const add = (n, attack) => { if (!res.some((x) => x.to === n)) res.push({ to: n, attack }); };
  const consider = (n) => { const o = occ[n]; if (!o) { add(n, false); return true; } if (o.owner !== piece.owner) add(n, true); return false; };
  const hasG = (n) => (gfl[n] || []).length > 0;
  if (piece.rank === '2' && !carrying && pos !== 'RING' && pos !== B.V) { // Scout
    for (const ray of B.rays(pos)) for (const n of ray) {
      if (B.castle(n)) { consider('RING'); break; }
      if (B.lake(n)) break;
      if (!consider(n)) break;
      if (hasG(n)) break;
    }
    return res;
  }
  if (piece.rank === '6' && !carrying) { // Cavalier
    for (const n1 of B.nb(pos)) {
      if (!consider(n1)) continue;
      if (n1 === B.V || n1 === 'RING' || hasG(n1)) continue;
      for (const n2 of B.nb(n1)) { if (n2 === pos || n2 === B.V) continue; consider(n2); }
    }
    return res;
  }
  for (const n of B.nb(pos)) consider(n);
  return res;
}
// the targets of an Artillery piece (same rules as cannonTargets in server/game.js)
function rTargets(B, occ, gfl, pos) {
  if (pos === 'RING' || pos === B.V) return [];
  const me = occ[pos], out = [];
  for (const ray of B.rays(pos)) {
    let ok = true;
    for (let k = 0; k < 2; k++) { const cur = ray[k]; if (!cur || B.castle(cur) || occ[cur] || (gfl[cur] || []).length) { ok = false; break; } }
    if (!ok) continue;
    const t = ray[2]; if (!t || t === pos) continue;
    let target;
    if (B.castle(t)) { if (t === B.V) continue; target = 'RING'; } else { target = t; if (B.lake(target)) continue; }
    if (occ[target] && occ[target].owner !== me.owner) out.push(target);
  }
  return out;
}


module.exports = { RBOARD, rLegal, rTargets };
