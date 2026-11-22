export default ({ baseline, legalActions, board, distances }) => {
  const previous = baseline();
  const army = { '10': 1, '9': 1, '7': 2, '6': 3, '5': 3, '4': 3, '2': 4, '1': 1, C: 2 };
  const known = new Map();
  const lastPos = new Map();
  const visits = new Map();
  const visitKey = (id, pos) => id + '@' + pos;

  function remember(g) {
    const a = g.lastAction;
    if (a?.type === 'fire' && a.pieceId) known.set(a.pieceId, 'C');
    if (a?.combat) {
      if (a.pieceId && a.combat.att?.rank) known.set(a.pieceId, a.combat.att.rank);
      for (const q of [a.combat.att, a.combat.def]) {
        if (q?.id && q.rank) known.set(q.id, q.rank);
      }
      const survivor = g.pieces.find(p => p.pos === a.to && p.id !== a.pieceId);
      if (survivor && a.combat.def?.rank) known.set(survivor.id, a.combat.def.rank);
    }
    for (const p of g.pieces) {
      if (p.rank) known.set(p.id, p.rank);
      if (lastPos.get(p.id) === p.pos) continue;
      lastPos.set(p.id, p.pos);
      const key = visitKey(p.id, p.pos);
      visits.set(key, (visits.get(key) || 0) + 1);
    }
  }

  function duel(a, b) {
    if (a === b) return 0;
    if (a === 'C') return -1;
    if (b === 'C' || (a === '1' && b === '10')) return 1;
    return Number(a) > Number(b) ? 1 : -1;
  }

  function choose(g) {
    remember(g);
    const fallback = () => previous.choose(g);
    const actions = legalActions(g);
    const me = g.turn;
    const carrier = g.pieces.find(p => p.owner === me && p.rank === '10' && p.flags.length === 1 && p.flags[0] === me);
    if (!carrier || !actions.length || actions[0].type === 'recruit') return fallback();

    const b = board(g.mode);
    const occ = new Map(g.pieces.map(p => [p.pos, p]));
    const byId = new Map(g.pieces.map(p => [p.id, p]));
    const moves = actions.filter(a => a.type === 'move' && !a.dropFlags);
    const carrierMoves = moves.filter(a => a.pieceId === carrier.id);
    const enemies = g.pieces.filter(p => p.owner !== me && !g.out[p.owner]);
    const rankOf = p => p.rank || known.get(p.id) || (p.flags.includes(p.owner) ? '10' : null);
    const unknown = new Map();
    for (const seat of new Set(enemies.map(p => p.owner))) {
      const left = { ...army };
      for (const r of g.graveyard[seat] || []) left[r]--;
      for (const p of enemies) {
        const r = rankOf(p);
        if (p.owner === seat && r) left[r]--;
      }
      const counts = Object.entries(left).filter(([, n]) => n > 0);
      const total = counts.reduce((sum, [, n]) => sum + n, 0);
      unknown.set(seat, total ? counts.map(([r, n]) => [r, n / total]) : Object.entries(army).map(([r, n]) => [r, n / 20]));
    }
    function chance(p, test) {
      const rank = rankOf(p);
      if (rank) return Number(test(rank));
      return unknown.get(p.owner).reduce((sum, [r, prob]) => sum + (test(r) ? prob : 0), 0);
    }

    const finish = carrierMoves.find(a => a.to === b.V);
    const foreignFlag = pos => [...(occ.get(pos)?.flags || []), ...(g.groundFlags[pos] || [])].some(f => f !== me && !g.out[f]);
    if (finish && !foreignFlag(b.V)) {
      const defender = occ.get(b.V);
      if (!defender || chance(defender, r => duel('10', r) > 0) > 0) return finish;
    }

    // A shot or a trade can interrupt a rival's delivery or open the next square.
    function interception(targets, minChance) {
      let best = null;
      let bestScore = -Infinity;
      for (const a of actions) {
        const pos = a.target || a.to;
        if (a.dropFlags || !targets.has(pos) || pos === b.V) continue;
        const p = byId.get(a.pieceId);
        const victim = occ.get(pos);
        const fire = a.type === 'fire';
        const win = fire ? 1 : chance(victim, r => duel(p.rank, r) > 0);
        const trade = fire ? 0 : chance(victim, r => duel(p.rank, r) === 0);
        if (win + trade < minChance) continue;
        const score = targets.get(pos) * (win + trade) * 100 + 5 * win + (fire ? 4 : 0) - (p.id === carrier.id ? 15 * (1 - win) : 0);
        if (score > bestScore) { bestScore = score; best = a; }
      }
      return best;
    }
    const gates = new Set(b.nb(b.V));
    const imminent = new Map(enemies.filter(p => p.flags.includes(p.owner) && gates.has(p.pos)).map(p => [p.pos, 1]));
    if (imminent.size) {
      const stop = interception(imminent, 0.01);
      if (stop) return stop;
    }

    // Only spies, Marshals and gunfire can remove the Marshal after it advances.
    const hazards = new Map();
    function mark(pos, enemy, prob) {
      if (!prob) return;
      if (!hazards.has(pos)) hazards.set(pos, new Map());
      const sources = hazards.get(pos);
      sources.set(enemy.pos, Math.max(sources.get(enemy.pos) || 0, prob));
    }
    for (const e of enemies) {
      const contact = chance(e, r => r === '1' || r === '10');
      for (const n of b.nb(e.pos)) mark(n, e, contact);
      const gun = chance(e, r => r === 'C');
      if (!gun) continue;
      for (const ray of b.rays(e.pos)) {
        if (ray.length < 3) continue;
        const blocked = ray.slice(0, 2).some(n => b.castle(n) || (occ.has(n) && n !== carrier.pos) || g.groundFlags[n]?.length);
        if (!blocked) mark(b.castle(ray[2]) ? 'RING' : ray[2], e, gun);
      }
    }
    const risk = new Map();
    for (const [pos, sources] of hazards) {
      let safe = 1;
      for (const prob of sources.values()) safe *= 1 - prob;
      risk.set(pos, 1 - safe);
    }

    const mobile = new Set(moves.map(a => a.pieceId));
    const costs = new Map();
    function entry(pos) {
      if (costs.has(pos)) return costs.get(pos);
      let cost = 1 + (pos === b.V ? 0 : 13 * (risk.get(pos) || 0));
      const p = occ.get(pos);
      if (p?.owner === me) cost += mobile.has(p.id) ? 1.4 : 3;
      else if (p && !g.out[p.owner]) cost += 23 * chance(p, r => r === '10');
      if (foreignFlag(pos)) cost += 9;
      cost += 0.65 * Math.log1p(visits.get(visitKey(carrier.id, pos)) || 0);
      costs.set(pos, cost);
      return cost;
    }

    // One reverse shortest-path pass prices every possible first step on the same board.
    const remaining = new Map([[b.V, 0]]);
    const next = new Map();
    const queue = [b.V];
    const queued = new Set(queue);
    for (let i = 0; i < queue.length; i++) {
      const pos = queue[i];
      queued.delete(pos);
      const cost = remaining.get(pos) + entry(pos);
      for (const n of b.nb(pos)) {
        if (n === carrier.pos || (n !== 'RING' && b.lake(n)) || cost >= (remaining.get(n) ?? Infinity)) continue;
        remaining.set(n, cost);
        next.set(n, pos);
        if (!queued.has(n)) { queue.push(n); queued.add(n); }
      }
    }
    const firstSteps = new Map(carrierMoves.filter(a => a.to !== b.V).map(a => [a.to, a]));
    for (const n of b.nb(carrier.pos)) {
      if (occ.get(n)?.owner === me) firstSteps.set(n, null);
    }
    let first = null;
    let shortest = Infinity;
    for (const pos of firstSteps.keys()) {
      const cost = entry(pos) + (remaining.get(pos) ?? Infinity);
      if (cost < shortest) { shortest = cost; first = pos; }
    }
    if (first === null) return fallback();

    const step = firstSteps.get(first);
    const occupant = occ.get(first);
    if (step) {
      const trade = occupant && !g.out[occupant.owner] ? chance(occupant, r => r === '10') : 0;
      const danger = risk.get(first) || 0;
      if (trade < 0.4 && danger < Math.max(0.48, risk.get(carrier.pos) || 0) && !foreignFlag(first)) return step;
      const threats = new Map(hazards.get(first));
      if (trade >= 0.4) threats.set(first, trade);
      const priority = new Map([...threats].filter(([, prob]) => prob >= 0.25));
      return (priority.size && interception(priority, 0.55)) || fallback();
    }

    const route = new Map();
    for (let pos = first; pos !== undefined; pos = next.get(pos)) route.set(pos, route.size);
    const centerDist = distances(g.mode, b.V);
    let clear = null;
    let bestScore = -Infinity;
    for (const a of moves) {
      const p = byId.get(a.pieceId);
      const index = route.get(p.pos);
      if (index === undefined || route.has(a.to) || p.flags.length || a.to === b.V) continue;
      const victim = occ.get(a.to);
      const win = victim && !g.out[victim.owner] ? chance(victim, r => duel(p.rank, r) > 0) : 1;
      if (win < 0.6) continue;
      const exposed = b.nb(a.to).some(n => { const q = occ.get(n); return q && q.owner !== me && !g.out[q.owner]; });
      const value = p.rank === 'C' ? 4 : Number(p.rank);
      const progress = (centerDist[p.pos] ?? 0) - (centerDist[a.to] ?? 0);
      const repeats = visits.get(visitKey(p.id, a.to)) || 0;
      const score = -3 * index + Math.min(2, progress) - (exposed ? value * 0.55 : 0) + (victim ? 3 * win : 0) - 1.5 * Math.log1p(repeats);
      if (score > bestScore) { bestScore = score; clear = a; }
    }
    return clear || fallback();
  }

  return {
    observe(view) { previous.observe(view); remember(view); },
    choose,
    setup(view) { return previous.setup(view); }
  };
};
