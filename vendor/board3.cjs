'use strict';
// =====================================================================
//  Board for 3 players (the Stratego 4 board for three).
//  Three camps of 7 x 3 at 120° around a triangular castle.
//
//  Each arm is seen by its own player looking at the castle:
//    column c = 0..6 from his left to his right,
//    row    r = 1 back row of the camp, 2 middle row, 3 front row,
//                4 first open row, 5 the row with the long lake (columns 2-4),
//                6 the row next to the castle (columns 1..5 only).
//  Square id: "<seat>:<c>:<r>", for example "R:3:5".
//  Between two arms (wedge i): one corner square "X<i>" (a pentagon that
//  continues row 5 of both arms) and one small lake "L<i>".
//  The castle: one ring space "RING" and the centre "CENTER".
//
//  Straight lines (Scouts, Cannons, Captains): LINES, lists of spaces.
//  A line may bend between two camps:
//    - rows 1-4 and row 6 (b6..f6) stay in their camp;
//    - row 5 of a camp ends on the corner square at each end (a corner square leads into both rows);
//    - columns c, d, e go to the castle ring;
//    - column b of a camp joins column f of the next camp (Rb1 … Rb6, Bf6 … Bf1),
//      and column a joins column g across the small lake (Ra1 … Ra5, lake, Bg5 … Bg1).
//  rays(node) gives, for each line through the node, the spaces met in each direction.
//  The castle ring touches the squares c6, d6 and e6 of each camp (9 squares).
//  This file works in Node (server) and in the browser (drawing).
// =====================================================================
(function (root) {
  const SEATS = ['R', 'B', 'Y'];            // turn order (clockwise on the screen)
  const ANGLE = { R: 270, Y: 30, B: 150 };  // direction of each arm from the castle (degrees, y up); Red at the bottom
  const CCW = ['R', 'Y', 'B'];              // arms in counter-clockwise order: wedge i lies between CCW[i] and CCW[i+1]
  const H = 3.5 / Math.sqrt(3);             // distance from the centre to the inner edge of row 5
  const CASTLE = 1.5 / Math.sqrt(3);        // distance from the centre to the castle wall: each wall is as long as c6..e6
  const RING = 'RING', CENTER = 'CENTER';
  const LETTERS = 'abcdefg';

  // ---- plane geometry (units: one square; x to the right, y up)
  function frame(seat) {
    const a = ANGLE[seat] * Math.PI / 180;
    return { r: [Math.cos(a), Math.sin(a)], t: [-Math.sin(a), Math.cos(a)] }; // t = the player's right
  }
  // point given in an arm's own coordinates: u across (-3.5 .. 3.5, + = right), v = distance from the centre
  function P(seat, u, v) { const f = frame(seat); return [u * f.t[0] + v * f.r[0], u * f.t[1] + v * f.r[1]]; }
  const vOfRow = (r) => H + 5 - r;          // inner edge of row r (row 5 → H, row 1 → H + 4) ; row 6: CASTLE .. H
  const mid = (a, b, s) => [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s];
  const add2 = (a, b) => [a[0] + b[0], a[1] + b[1]];
  const scale = (a, k) => [a[0] * k, a[1] * k];
  const norm = (a) => { const l = Math.hypot(a[0], a[1]); return [a[0] / l, a[1] / l]; };

  const id = (seat, c, r) => seat + ':' + c + ':' + r;

  function build() {
    const nodes = {};
    const add = (key, n) => { nodes[key] = Object.assign({ id: key, nb: [], lines: {} }, n); return nodes[key]; };
    const centroid = (poly) => poly.reduce((m, p) => [m[0] + p[0] / poly.length, m[1] + p[1] / poly.length], [0, 0]);

    // ---- the three arms
    for (const s of SEATS) {
      for (let r = 1; r <= 5; r++) for (let c = 0; c <= 6; c++) {
        const u0 = c - 3.5, v0 = vOfRow(r);
        const poly = [P(s, u0, v0), P(s, u0 + 1, v0), P(s, u0 + 1, v0 + 1), P(s, u0, v0 + 1)];
        add(id(s, c, r), { kind: r === 5 && c >= 2 && c <= 4 ? 'lake' : 'square', seat: s, c, r, camp: r <= 3 ? s : null, poly, center: P(s, c - 3, v0 + 0.5) });
      }
      // row 6, next to the castle: three plain squares (c = 2..4) and two cells that reach the wedge (c = 1, 5)
      for (let c = 2; c <= 4; c++) {
        const u0 = c - 3.5;
        const poly = [P(s, u0, CASTLE), P(s, u0 + 1, CASTLE), P(s, u0 + 1, H), P(s, u0, H)];
        add(id(s, c, 6), { kind: 'square', seat: s, c, r: 6, poly, center: P(s, c - 3, (CASTLE + H) / 2) });
      }
    }
    // ---- the wedges: corner square (pentagon), small lake, and the two side cells of row 6
    const ROW6_SIDE = {};
    for (let i = 0; i < 3; i++) {
      const a = CCW[i], b = CCW[(i + 1) % 3];  // a: its right side faces the wedge; b: its left side
      const Pw = P(a, 3.5, H);                  // the point where the two arms meet
      // corner square: continues row 5 of both arms
      const pent = [Pw, P(a, 3.5, H + 1), P(a, 4.5, H + 1), P(b, -4.5, H + 1), P(b, -3.5, H + 1)];
      add('X' + i, { kind: 'square', wedge: i, poly: pent, center: centroid([Pw, P(a, 3.5, H + 1), P(a, 4.5, H + 1), P(b, -4.5, H + 1), P(b, -3.5, H + 1), Pw]) });
      // small lake: a triangle with one curved side, pointing out of the board
      const A = P(a, 2.5, H), Bq = P(b, -2.5, H);
      const bis = norm(scale(Pw, -1));          // from Pw towards the centre
      const bulge = add2(Pw, scale(bis, 1.05)); // the curved side passes here
      const ctrl = add2(scale(bulge, 2), scale(mid(A, Bq, 0.5), -1));
      const curve = []; for (let k = 0; k <= 12; k++) { const t = k / 12; curve.push([(1 - t) * (1 - t) * A[0] + 2 * (1 - t) * t * ctrl[0] + t * t * Bq[0], (1 - t) * (1 - t) * A[1] + 2 * (1 - t) * t * ctrl[1] + t * t * Bq[1]]); }
      add('L' + i, { kind: 'lake', wedge: i, poly: [Pw].concat(curve), center: add2(Pw, scale(bis, 0.62)), curve: { A, B: Bq, ctrl, P: Pw } });
      // side cells of row 6 on each side of the bisector
      const tip = add2(Pw, scale(bis, 2 * H - 2 * CASTLE)); // corner of the castle
      const half = curve.slice(0, 7);                         // A .. bulge
      const halfB = curve.slice(6).reverse();                 // B .. bulge
      const polyA = [P(a, 1.5, H), A].concat(half.slice(1)).concat([tip, P(a, 1.5, CASTLE)]);
      const polyB = [P(b, -1.5, H), Bq].concat(halfB.slice(1)).concat([tip, P(b, -1.5, CASTLE)]);
      add(id(a, 5, 6), { kind: 'square', seat: a, c: 5, r: 6, poly: polyA, center: centroid([P(a, 1.5, H), A, bulge, tip, P(a, 1.5, CASTLE)]) });
      add(id(b, 1, 6), { kind: 'square', seat: b, c: 1, r: 6, poly: polyB, center: centroid([P(b, -1.5, H), Bq, bulge, tip, P(b, -1.5, CASTLE)]) });
      ROW6_SIDE[i] = { a, b };
    }
    // ---- the castle: a triangle (ring) with a small triangle in the middle (centre)
    const tri = (rad) => SEATS.map((s) => { const f = frame(s); return scale(f.r, -2 * rad); }); // corners point between the arms
    add(RING, { kind: 'ring', poly: tri(CASTLE), center: [0, 0] });
    add(CENTER, { kind: 'centre', poly: tri(0.34), center: [0, 0] });

    // ---- neighbours and straight lines
    const link = (x, y) => { if (!nodes[x] || !nodes[y]) return; if (!nodes[x].nb.includes(y)) nodes[x].nb.push(y); if (!nodes[y].nb.includes(x)) nodes[y].nb.push(x); };
    const line = (x, dir, y) => { if (nodes[x] && nodes[y]) nodes[x].lines[dir] = y; };
    const OPP = { in: 'out', out: 'in', left: 'right', right: 'left' };
    const pair = (x, dir, y) => { link(x, y); line(x, dir, y); line(y, OPP[dir], x); };
    for (const s of SEATS) {
      for (let r = 1; r <= 6; r++) for (let c = 0; c <= 6; c++) {
        const k = id(s, c, r); if (!nodes[k]) continue;
        if (nodes[id(s, c + 1, r)]) pair(k, 'right', id(s, c + 1, r));
        if (nodes[id(s, c, r + 1)]) pair(k, 'in', id(s, c, r + 1));
      }
      for (let c = 2; c <= 4; c++) { link(id(s, c, 6), RING); line(id(s, c, 6), 'in', RING); } // the ring: c6, d6, e6 only
    }
    for (let i = 0; i < 3; i++) {
      const { a, b } = ROW6_SIDE[i];
      link(id(a, 6, 5), 'X' + i); link('X' + i, id(b, 0, 5)); // the corner square joins the two lake rows
      link(id(a, 5, 6), id(b, 1, 6));                           // f6 of a camp touches b6 of the next one
      nodes['L' + i].nb.push(id(a, 6, 5), id(b, 0, 5), id(a, 5, 6), id(b, 1, 6)); // touching (not a move: it is a lake)
    }
    link(RING, CENTER);
    // lakes are never neighbours of anything one can move to
    for (const k in nodes) if (nodes[k].kind !== 'lake') nodes[k].nb = nodes[k].nb.filter((x) => nodes[x].kind !== 'lake');
    return nodes;
  }

  const NODES = build();

  // ---- straight lines (each one a list of spaces; `loop` = it goes all round)
  const LINES = [];
  const seq = (s, cells) => cells.map(([c, r]) => id(s, c, r));
  for (const s of SEATS) {
    for (let r = 1; r <= 4; r++) LINES.push({ cells: seq(s, [0, 1, 2, 3, 4, 5, 6].map((c) => [c, r])) });
    LINES.push({ cells: seq(s, [1, 2, 3, 4, 5].map((c) => [c, 6])) });
    for (let c = 2; c <= 4; c++) LINES.push({ cells: seq(s, [1, 2, 3, 4, 5, 6].map((r) => [c, r])).concat([RING]) });
  }
  for (let i = 0; i < 3; i++) {
    const s = CCW[i], before = 'X' + ((i + 2) % 3), after = 'X' + i; // corner on its left side, corner on its right side
    LINES.push({ cells: [before].concat(seq(s, [0, 1, 2, 3, 4, 5, 6].map((c) => [c, 5]))).concat([after]) });
  }
  for (let i = 0; i < 3; i++) {
    const a = CCW[i], b = CCW[(i + 1) % 3];
    // column f of a camp bends into column b of the next camp, column g into column a across the small lake
    LINES.push({ cells: seq(a, [1, 2, 3, 4, 5, 6].map((r) => [5, r])).concat(seq(b, [6, 5, 4, 3, 2, 1].map((r) => [1, r]))) });
    LINES.push({ cells: seq(a, [1, 2, 3, 4, 5].map((r) => [6, r])).concat(['L' + i]).concat(seq(b, [5, 4, 3, 2, 1].map((r) => [0, r]))) });
  }
  const RAYS = {};
  for (const L of LINES) {
    const n = L.cells.length;
    L.cells.forEach((node, i) => {
      const fwd = [], back = [];
      if (L.loop) { for (let k = 1; k < n; k++) { fwd.push(L.cells[(i + k) % n]); back.push(L.cells[(i - k + n) % n]); } }
      else { for (let k = i + 1; k < n; k++) fwd.push(L.cells[k]); for (let k = i - 1; k >= 0; k--) back.push(L.cells[k]); }
      (RAYS[node] = RAYS[node] || []).push(...[fwd, back].filter((r) => r.length));
    });
  }
  function rays(node) { return RAYS[node] || []; }
  function label(node) {
    if (node === RING) return 'bunker ring';
    if (node === CENTER) return 'bunker centre';
    const n = NODES[node]; if (!n) return node;
    if (n.wedge !== undefined && n.kind === 'lake') return 'barricade';
    if (n.wedge !== undefined && n.kind === 'square') return 'corner ' + CCW[n.wedge] + '/' + CCW[(n.wedge + 1) % 3];
    return n.seat + LETTERS[n.c] + n.r;
  }
  // the 21 squares of a camp seen by its owner: 3 rows (0 = front) x 7 columns (left to right)
  function layoutSquares(seat) {
    const out = [];
    for (let row = 0; row < 3; row++) for (let c = 0; c <= 6; c++) out.push(id(seat, c, 3 - row));
    return out;
  }
  const SEAT_INFO = {};
  for (const s of SEATS) SEAT_INFO[s] = { recruit: id(s, 3, 2), flagStart: id(s, 3, 1) };

  const api = { SEATS, CCW, ANGLE, H, CASTLE, RING, CENTER, NODES, LINES, P, frame, label, layoutSquares, SEAT_INFO, id, rays };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Board3 = api;
})(typeof window !== 'undefined' ? window : this);
