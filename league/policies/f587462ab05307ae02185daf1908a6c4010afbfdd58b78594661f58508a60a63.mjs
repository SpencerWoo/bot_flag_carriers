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
    if (!actions.length || actions[0].type === 'recruit') return fallback();
    const me = g.turn;
    const b = board(g.mode);
    const centerDist = distances(g.mode, b.V);
    const gates = new Set(b.nb(b.V));
    const occ = new Map(g.pieces.map(p => [p.pos, p]));
    const byId = new Map(g.pieces.map(p => [p.id, p]));
    const moves = actions.filter(a => a.type === 'move' && !a.dropFlags);
    const holder = g.pieces.find(p => p.flags.includes(me));
    const liveForeign = flag => flag !== me && !g.out[flag];
    const carrier = holder?.owner === me && !holder.flags.some(liveForeign) ? holder : null;
    const carrierMoves = moves.filter(a => a.pieceId === carrier?.id);
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
      let counts = Object.entries(left).filter(([, n]) => n > 0);
      if (!counts.length) counts = Object.entries(army);
      const total = counts.reduce((sum, [, n]) => sum + n, 0);
      unknown.set(seat, counts.map(([r, n]) => [r, n / total]));
    }
    function chance(p, test) {
      const rank = rankOf(p);
      if (rank) return Number(test(rank));
      return unknown.get(p.owner).reduce((sum, [r, prob]) => sum + (test(r) ? prob : 0), 0);
    }
    const foreignFlag = pos => (occ.get(pos)?.flags || []).some(liveForeign) || (g.groundFlags[pos] || []).some(liveForeign);
    for (const a of moves) {
      if (a.to !== b.V || foreignFlag(b.V)) continue;
      const p = byId.get(a.pieceId);
      const defender = occ.get(b.V);
      if (!p.flags.includes(me) && !defender?.flags.includes(me) && !g.groundFlags[b.V]?.includes(me)) continue;
      if (p.flags.some(liveForeign)) continue;
      if (!defender || g.out[defender.owner] || chance(defender, r => duel(p.rank, r) > 0) > 0) return a;
    }

    function interception(targets, minChance, winsOnly = false) {
      let best = null;
      let bestScore = -Infinity;
      for (const a of actions) {
        const pos = a.target || a.to;
        if (a.dropFlags || !targets.has(pos) || pos === b.V) continue;
        const p = byId.get(a.pieceId);
        const victim = occ.get(pos);
        const fire = a.type === 'fire';
        const win = fire ? 1 : chance(victim, r => duel(p.rank, r) > 0);
        const trade = fire || winsOnly ? 0 : chance(victim, r => duel(p.rank, r) === 0);
        if (win + trade < minChance) continue;
        const score = targets.get(pos) * (win + trade) * 100 + 5 * win + (fire ? 4 : 0) - (p.id === carrier?.id ? 15 * (1 - win) : 0);
        if (score > bestScore) { bestScore = score; best = a; }
      }
      return best;
    }
    const rivals = enemies.filter(p => p.flags.includes(p.owner));
    const imminent = new Map(rivals.filter(p => gates.has(p.pos)).map(p => [p.pos, 1]));
    if (imminent.size) {
      const stop = interception(imminent, 0.01);
      if (stop) return stop;
    }

    const rayTarget = ray => b.castle(ray[2]) ? 'RING' : ray[2];
    function lineOpen(ray, vacated, departed) {
      for (let i = 0; i < 2; i++) {
        const n = ray[i];
        if (b.castle(n) || g.groundFlags[n]?.length || (occ.has(n) && n !== vacated && n !== departed)) return false;
      }
      return true;
    }
    const shotLines = new Map();
    const hazards = new Map();
    function mark(pos, enemy, prob) {
      if (!prob) return;
      if (!hazards.has(pos)) hazards.set(pos, new Map());
      const sources = hazards.get(pos);
      sources.set(enemy.pos, Math.max(sources.get(enemy.pos) || 0, prob));
    }
    const runningRank = carrier?.rank || '10';
    for (const e of enemies) {
      const contact = chance(e, r => duel(r, runningRank) >= 0);
      for (const n of b.nb(e.pos)) mark(n, e, contact);
      const gun = chance(e, r => r === 'C');
      if (!gun) continue;
      for (const ray of b.rays(e.pos)) {
        if (ray.length < 3) continue;
        const target = rayTarget(ray);
        if (!carrier) {
          if (!shotLines.has(target)) shotLines.set(target, []);
          shotLines.get(target).push({ e, ray, gun });
        }
        if (lineOpen(ray, carrier?.pos)) mark(target, e, gun);
      }
    }
    const risk = new Map();
    for (const [pos, sources] of hazards) {
      let safe = 1;
      for (const prob of sources.values()) safe *= 1 - prob;
      risk.set(pos, 1 - safe);
    }

    function planRecovery() {
      if (holder?.owner === me) return null;
      const flag = holder?.pos ?? Object.keys(g.groundFlags).find(pos => g.groundFlags[pos]?.includes(me));
      if (flag === undefined || foreignFlag(flag)) return null;
      const toFlag = distances(g.mode, flag);
      const flagDefender = occ.get(flag);
      const winAt = (p, q) => !q || g.out[q.owner] ? 1 : q.owner === me ? 0 : chance(q, r => duel(p.rank, r) > 0);
      function survival(p, dest, vacated) {
        const threats = new Map();
        for (const n of b.nb(dest)) {
          const e = occ.get(n);
          if (e && e.owner !== me && !g.out[e.owner]) threats.set(e.id, chance(e, r => duel(r, p.rank) >= 0));
        }
        for (const { e, ray, gun } of shotLines.get(dest) || []) {
          if (lineOpen(ray, vacated)) threats.set(e.id, Math.max(threats.get(e.id) || 0, gun));
        }
        let safe = 1;
        for (const prob of threats.values()) safe *= 1 - prob;
        return safe;
      }
      const pickupByRank = new Map();
      let best = null;
      let bestScore = 0;
      for (const a of actions) {
        if (a.type !== 'move' || foreignFlag(a.to) || (a.to === b.V && a.to !== flag)) continue;
        const p = byId.get(a.pieceId);
        const shedding = p.flags.some(liveForeign);
        if (!!a.dropFlags !== shedding || (shedding && (a.to !== flag || gates.has(p.pos)))) continue;
        const left = toFlag[a.to];
        if (!(left < toFlag[p.pos])) continue;
        const landing = winAt(p, occ.get(a.to));
        if (landing <= 0) continue;
        const direct = a.to === flag;
        const safe = a.to === b.V ? 1 : survival(p, a.to, p.pos);
        let pickup = 1;
        if (!direct) {
          if (!pickupByRank.has(p.rank)) pickupByRank.set(p.rank, winAt(p, flagDefender) * survival(p, flag));
          pickup = pickupByRank.get(p.rank);
        }
        // A strong piece one turn away can be preferable to an immediate pickup that cannot survive.
        const success = landing * safe * pickup;
        const strength = p.rank === 'C' ? 0 : Number(p.rank);
        const onward = 1 + 0.025 * strength * Math.min(1, (centerDist[flag] - 1) / 2);
        const repeats = visits.get(visitKey(p.id, a.to)) || 0;
        const score = success * onward / ((1 + left) ** 1.4 * (1 + 0.12 * repeats));
        if (score > bestScore) {
          bestScore = score;
          best = { action: a, success, direct, eta: 1 + left + centerDist[flag] };
        }
      }
      if (holder && (!best?.direct || best.success < 0.55)) {
        const shot = actions.find(a => a.type === 'fire' && a.target === flag);
        if (shot) return { action: shot, success: 0, direct: false, eta: Infinity };
      }
      return bestScore >= 0.015 ? best : null;
    }
    const recovery = carrier ? null : planRecovery();
    if (recovery?.direct && recovery.eta <= 2 && recovery.success >= 0.65) return recovery.action;
    const runner = carrier || (holder?.owner === me ? holder : null);
    const ownDist = runner ? centerDist[runner.pos] : Infinity;
    const canAdvance = runner && moves.some(a => a.pieceId === runner.id && centerDist[a.to] < ownDist && !foreignFlag(a.to) && (risk.get(a.to) || 0) < 0.48);
    const ownETA = runner ? ownDist + (canAdvance ? 0 : 1) : recovery?.success >= 0.65 ? recovery.eta : Infinity;
    const approaching = rivals.filter(p => centerDist[p.pos] >= 2 && centerDist[p.pos] <= 4 && centerDist[p.pos] <= ownETA);
    approaching.sort((p, q) => centerDist[p.pos] - centerDist[q.pos]);
    const guarding = new Set();
    if (approaching.length && !imminent.size) {
      const targets = new Map(approaching.map(p => [p.pos, 1 / centerDist[p.pos]]));
      const capture = interception(targets, 0.95, true);
      if (capture) return capture;
      const leader = approaching[0];
      const leadDist = centerDist[leader.pos];
      const entrances = [...gates].filter(pos => distances(g.mode, pos)[leader.pos] === leadDist - 1);
      const guards = g.pieces.filter(p => p.owner === me && !p.flags.length && (p.rank === 'C' || p.rank === '1'));
      function attacks(p, from, target, departed) {
        if (p.rank === '1') return b.nb(from).includes(target) && chance(leader, r => duel('1', r) >= 0) >= 0.95;
        return b.rays(from).some(ray => ray.length >= 3 && rayTarget(ray) === target && lineOpen(ray, p.pos, departed));
      }
      function covers(p, from) {
        return entrances.length > 0 && entrances.every(gate => attacks(p, from, gate, leader.pos));
      }
      for (const p of guards) if (covers(p, p.pos)) guarding.add(p.id);
      if (!guarding.size && entrances.length) {
        let deploy = null;
        let bestScore = -Infinity;
        for (const p of guards) {
          const options = moves.filter(a => a.pieceId === p.id && a.to !== b.V && !gates.has(a.to) && !foreignFlag(a.to) && !g.groundFlags[a.to]?.includes(me));
          if (!options.length) continue;
          const canStage = leadDist >= 3 && ownETA > leadDist;
          const posts = new Map();
          const isPost = pos => {
            if (!posts.has(pos)) posts.set(pos, pos !== b.V && !gates.has(pos) && (pos === 'RING' || !b.lake(pos)) && covers(p, pos));
            return posts.get(pos);
          };
          for (const a of options) {
            const victim = occ.get(a.to);
            if (victim && !g.out[victim.owner] && chance(victim, r => duel(p.rank, r) > 0) < 0.95) continue;
            const ready = isPost(a.to);
            const repeats = visits.get(visitKey(p.id, a.to)) || 0;
            if (!ready && (!canStage || repeats || !b.nb(a.to).some(n => !occ.has(n) && !g.groundFlags[n]?.length && isPost(n)))) continue;
            let exposure = 0;
            for (const n of b.nb(a.to)) {
              const q = occ.get(n);
              if (q && q.owner !== me && !g.out[q.owner]) exposure = Math.max(exposure, chance(q, r => duel(r, p.rank) >= 0));
            }
            if (exposure > 0.65 && (!ready || leadDist > 2)) continue;
            const pressure = attacks(p, a.to, leader.pos) ? 1 : 0;
            const inWay = carrier && b.nb(carrier.pos).includes(a.to) && centerDist[a.to] < ownDist;
            const score = (ready ? 50 : 20) + 8 * pressure - 19 * exposure - 4 * Number(!!inWay) - 2 * Math.log1p(repeats) + (victim ? 2 : 0);
            if (score > bestScore) { bestScore = score; deploy = a; }
          }
        }
        if (deploy) return deploy;
      }
    }
    if (!carrier) return recovery?.action || fallback();

    const mobile = new Set(moves.map(a => a.pieceId));
    const costs = new Map();
    const failure = p => p && !g.out[p.owner] ? chance(p, r => duel(carrier.rank, r) <= 0) : 0;
    function entry(pos) {
      if (costs.has(pos)) return costs.get(pos);
      let cost = 1 + (pos === b.V ? 0 : 13 * (risk.get(pos) || 0));
      const p = occ.get(pos);
      if (p?.owner === me) cost += (mobile.has(p.id) ? 1.4 : 3) + (guarding.has(p.id) ? 3 : 0);
      else cost += 23 * failure(p);
      if (foreignFlag(pos)) cost += 9;
      cost += 0.65 * Math.log1p(visits.get(visitKey(carrier.id, pos)) || 0);
      costs.set(pos, cost);
      return cost;
    }
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
    for (const n of b.nb(carrier.pos)) if (occ.get(n)?.owner === me) firstSteps.set(n, null);
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
      const loss = failure(occupant);
      const danger = risk.get(first) || 0;
      if (loss < 0.4 && danger < Math.max(0.48, risk.get(carrier.pos) || 0) && !foreignFlag(first)) return step;
      if (gates.has(first) && !occupant && foreignFlag(first)) {
        const pickup = moves.find(a => a.to === first && !byId.get(a.pieceId).flags.length);
        if (pickup) return pickup;
      }
      const threats = new Map(hazards.get(first));
      if (loss >= 0.4) threats.set(first, loss);
      const priority = new Map([...threats].filter(([, prob]) => prob >= 0.25));
      return (priority.size && interception(priority, 0.55)) || fallback();
    }
    const route = new Map();
    for (let pos = first; pos !== undefined; pos = next.get(pos)) route.set(pos, route.size);
    let clear = null;
    let bestScore = -Infinity;
    for (const a of moves) {
      const p = byId.get(a.pieceId);
      const index = route.get(p.pos);
      if (index === undefined || route.has(a.to) || a.to === b.V) continue;
      if (p.flags.includes(me) || (p.flags.length && !gates.has(p.pos))) continue;
      const victim = occ.get(a.to);
      const win = victim && !g.out[victim.owner] ? chance(victim, r => duel(p.rank, r) > 0) : 1;
      if (win < 0.6) continue;
      const exposed = b.nb(a.to).some(n => { const q = occ.get(n); return q && q.owner !== me && !g.out[q.owner]; });
      const value = p.rank === 'C' ? 4 : Number(p.rank);
      const progress = (centerDist[p.pos] ?? 0) - (centerDist[a.to] ?? 0);
      const repeats = visits.get(visitKey(p.id, a.to)) || 0;
      const score = -3 * index + Math.min(2, progress) - (exposed ? value * 0.55 : 0) + (victim ? 3 * win : 0) - 1.5 * Math.log1p(repeats) - (guarding.has(p.id) ? 4 : 0);
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
