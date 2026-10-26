'use strict';
// Motor de simulacao (paper): a cada tick avalia as regras contra o preco real e registra cada decisao.
// Nada aqui envia ordem real. Taxa e deslizamento sao simulados.

const FEE = 0.005;            // 0,5% por operacao simulada
const DEFAULT_MAX_IMPACT = 1.5; // % de impacto de preco acima do qual a ordem e bloqueada

function money(n) { return '$' + (Math.abs(n) >= 100 ? n.toFixed(2) : n >= 1 ? n.toFixed(2) : n.toPrecision(3)); }

exports.newState = function (budget, startPrice, startWithPosition) {
  const s = { cash: budget, qty: 0, cost: 0, peak: 0, realized: 0, fills: [], log: [], rs: {}, prev: null, liqBase: 0, deploy: null, startedAt: Date.now(), lastTick: 0, last: null };
  if (startWithPosition && startPrice) {
    // Posicao inicial simulada, para estrategias de venda.
    const usd = Math.min(startWithPosition, budget);
    s.cash -= usd; s.qty = usd / startPrice; s.cost = usd; s.peak = startPrice;
  }
  return s;
};

exports.equity = function (st, price) { return st.cash + st.qty * price; };

function log(st, price, rule, text, kind) {
  st.log.unshift({ t: Date.now(), price: price, rule: rule, text: text, kind: kind || 'info' });
  if (st.log.length > 150) st.log.length = 150;
}

// "Juiz": estima a causa de uma queda. Heuristica simples (liquidez + mercado geral), sem IA.
exports.judge = function (st, snap, ctx) {
  const ratio = st.liqBase > 0 ? snap.liquidity / st.liqBase : 1;
  const pull = ratio < 0.7 ? Math.min(1, (0.7 - ratio) * 2 + 0.3) : 0.05;
  const mkt = ctx.marketH24 !== null && ctx.marketH24 < 0 ? Math.min(1, -ctx.marketH24 / 20) : 0.05;
  const tok = 0.4;
  const sum = pull + mkt + tok;
  return { market_drawdown: mkt / sum, token_specific_dump: tok / sum, liquidity_pull: pull / sum };
};

function priceImpactPct(usd, liq) { return liq > 0 ? usd / liq * 100 : 100; }

function buy(st, snap, usd, rule, params) {
  usd = Math.min(usd, st.cash);
  if (usd < 1) return 'blocked: no balance';
  const impact = priceImpactPct(usd, snap.liquidity), ceiling = params.maxImpactPct || DEFAULT_MAX_IMPACT;
  if (impact > ceiling) return 'blocked: price impact ' + impact.toFixed(2) + '% is above the ' + ceiling + '% limit';
  const fill = snap.price * (1 + impact / 100), fee = usd * FEE, qty = (usd - fee) / fill;
  st.cash -= usd; st.qty += qty; st.cost += usd; st.peak = Math.max(st.peak, snap.price);
  st.fills.unshift({ t: Date.now(), side: 'buy', usd: usd, qty: qty, price: fill, fee: fee, rule: rule });
  return 'bought ' + money(usd) + ' at ' + money(fill);
}

function sell(st, snap, pct, rule) {
  if (st.qty <= 0) return 'blocked: no position';
  const q = st.qty * Math.min(100, pct) / 100, notional = q * snap.price;
  const impact = priceImpactPct(notional, snap.liquidity), fill = snap.price * (1 - Math.min(impact, 50) / 100);
  const gross = q * fill, fee = gross * FEE, share = q / st.qty, costPart = st.cost * share;
  st.cash += gross - fee; st.realized += gross - fee - costPart; st.cost -= costPart; st.qty -= q;
  if (st.qty * snap.price < 0.5) { st.cash += st.qty * snap.price; st.qty = 0; st.cost = 0; st.peak = 0; }
  st.fills.unshift({ t: Date.now(), side: 'sell', usd: gross, qty: q, price: fill, fee: fee, rule: rule });
  return 'sold ' + Math.round(share * 100) + '% (' + money(gross) + ') at ' + money(fill);
}

// ---------- modo real (com aprovacao): a regra cria uma ORDEM PENDENTE; so vira operacao depois que a pessoa assina ----------
const ORDER_TTL_MS = 3 * 60000;
exports.ORDER_TTL_MS = ORDER_TTL_MS;
const OPEN = ['pending', 'prepared', 'sent'];
const LIVE_MIN_USD = Number(process.env.LIVE_MIN_USD) || 0.05; // menor ordem real aceita (permite testar com centavos)

function place(strat, st, snap, side, amount, rule, now) {
  if (!strat.live) return side === 'buy' ? buy(st, snap, amount, rule, strat.params) : sell(st, snap, amount, rule);
  st.orders = st.orders || [];
  if (st.orders.some(function (o) { return OPEN.indexOf(o.status) >= 0; })) return 'blocked: an order is already waiting for approval or confirmation';
  const o = { id: Math.random().toString(36).slice(2, 10), side: side, rule: rule, price: snap.price, createdAt: now, expiresAt: now + ORDER_TTL_MS, status: 'pending' };
  if (side === 'buy') {
    const usd = Math.min(amount, st.cash);
    if (usd < LIVE_MIN_USD) return 'blocked: not enough budget left in this strategy';
    const impact = priceImpactPct(usd, snap.liquidity), ceiling = strat.params.maxImpactPct || DEFAULT_MAX_IMPACT;
    if (impact > ceiling) return 'blocked: price impact ' + impact.toFixed(2) + '% is above the ' + ceiling + '% limit';
    o.usd = usd;
  } else {
    if (st.qty <= 0) return 'blocked: no position';
    o.pct = Math.min(100, amount);
  }
  st.orders.unshift(o);
  if (st.orders.length > 40) st.orders.length = 40;
  return 'pending order: ' + (side === 'buy' ? 'buy ' + money(o.usd) : 'sell ' + Math.round(o.pct) + '%') + ' (waiting for your approval in your wallet)';
}

// Ordem pedida pela pessoa (ex.: "vender tudo agora"): passa pelo mesmo caminho de aprovacao das regras.
exports.manualOrder = function (strat, side, amount, now) {
  const st = strat.state;
  if (!strat.live) throw new Error('This strategy is paper trading only');
  if (!st.last || !(st.last.price > 0)) throw new Error('No price yet. Wait for the next price update.');
  const res = place(strat, st, { price: st.last.price, liquidity: st.last.liquidity }, side, amount, 'manual', now);
  if (/^blocked/.test(res)) throw new Error(res.replace(/^blocked: /, ''));
  log(st, st.last.price, 'manual', res, 'order');
  return res;
};

// Ordens que ninguem aprovou a tempo expiram: o preco mudou e a decisao ficou velha.
exports.expireOrders = function (strat, now) {
  (strat.state.orders || []).forEach(function (o) {
    if ((o.status === 'pending' || o.status === 'prepared') && now > o.expiresAt) {
      o.status = 'expired';
      log(strat.state, strat.state.last ? strat.state.last.price : 0, o.rule, 'order expired: not approved within ' + Math.round(ORDER_TTL_MS / 60000) + ' min', 'block');
    }
  });
};

// Registra no livro da estrategia uma ordem confirmada na rede. info: { tokens, usd, signature }.
exports.applyFill = function (strat, order, info, now) {
  const st = strat.state;
  if (order.side === 'buy') {
    st.cash -= info.usd; st.qty += info.tokens; st.cost += info.usd; st.peak = Math.max(st.peak, order.price);
  } else {
    const share = st.qty > 0 ? Math.min(1, info.tokens / st.qty) : 1, costPart = st.cost * share;
    st.cash += info.usd; st.realized += info.usd - costPart; st.cost -= costPart; st.qty -= info.tokens;
    if (st.qty * order.price < 0.01 || st.qty < 0) { st.qty = 0; st.cost = 0; st.peak = 0; }
  }
  st.fills.unshift({ t: now, side: order.side, usd: info.usd, qty: info.tokens, price: info.tokens > 0 ? info.usd / info.tokens : order.price, fee: 0, rule: order.rule, sig: info.signature || null });
  order.status = 'filled'; order.signature = info.signature || order.signature || null;
  log(st, order.price, order.rule, 'confirmed on-chain: ' + (order.side === 'buy' ? 'bought ' : 'sold ') + money(info.usd) + ' (values estimated from the quote)', 'fill');
};

// Estado da condicao do trigger no instante atual (true/false).
function triggerState(w, st, snap, rs, now) {
  switch (w.type) {
    case 'interval': return !rs.nextDue || now >= rs.nextDue;
    case 'price_change': return w.pct < 0 ? snap.change[w.window === '24h' ? 'h24' : w.window === '6h' ? 'h6' : w.window === '1h' ? 'h1' : 'm5'] <= w.pct
      : snap.change[w.window === '24h' ? 'h24' : w.window === '6h' ? 'h6' : w.window === '1h' ? 'h1' : 'm5'] >= w.pct;
    case 'drawdown_from_peak': return st.qty > 0 && st.peak > 0 && (1 - snap.price / st.peak) * 100 >= w.pct;
    case 'price_cross': {
      let level = w.price;
      if (level === undefined) { if (st.qty <= 0) return false; level = (st.cost / st.qty) * (1 + w.from_avg_cost_pct / 100); }
      if (st.prev === null) return false;
      return w.direction === 'above' ? st.prev < level && snap.price >= level : st.prev > level && snap.price <= level;
    }
    case 'volume_spike': return snap.volume.h1 > 0 && (snap.volume.m5 * 12) / snap.volume.h1 >= w.multiple;
  }
  return false;
}

function checkCondition(c, st, snap, rs, ctx, now, rules) {
  switch (c.type) {
    case 'price_max': return snap.price <= c.price ? null : 'price ' + money(snap.price) + ' is above the ' + money(c.price) + ' cap';
    case 'price_min': return snap.price >= c.price ? null : 'price is below the ' + money(c.price) + ' minimum';
    case 'cooldown': return !rs.last || now - rs.last >= c.minutes * 60000 ? null : 'cooling down (' + c.minutes + ' min cooldown)';
    case 'max_fires': return rs.fired < c.count ? null : 'limit of ' + c.count + ' fires reached';
    case 'position': { const v = st.qty * snap.price; return (c.op === '>' ? v > c.usd : v <= c.usd) ? null : 'position ' + money(v) + ' does not meet ' + c.op + ' ' + money(c.usd); }
    case 'budget_left': return st.cash >= c.usd ? null : 'balance ' + money(st.cash) + ' is below ' + money(c.usd);
    case 'rule_state': return (st.rs[c.rule] && st.rs[c.rule].status) === c.state ? null : 'rule ' + c.rule + ' is not ' + c.state;
    case 'liquidity_min': return snap.liquidity >= c.usd ? null : 'liquidity ' + money(snap.liquidity) + ' is below ' + money(c.usd);
    case 'jev': {
      const j = exports.judge(st, snap, ctx);
      st.lastJudge = { t: now, probs: j };
      return j[c.label] >= c.min ? null : 'judge: ' + c.label + ' ' + j[c.label].toFixed(2) + ' < ' + c.min;
    }
  }
  return 'unknown condition';
}

function runAction(a, st, snap, rule, strat, now) {
  switch (a.type) {
    case 'buy': return place(strat, st, snap, 'buy', Math.min(a.usd, strat.params.maxPerTrade || a.usd), rule.id, now);
    case 'sell': return place(strat, st, snap, 'sell', a.pct, rule.id, now);
    case 'exit_all': return place(strat, st, snap, 'sell', 100, rule.id, now);
    case 'disable_rule': if (st.rs[a.rule]) st.rs[a.rule].status = 'disabled'; return 'disabled ' + a.rule;
    case 'pause_rule': if (st.rs[a.rule] && st.rs[a.rule].status === 'armed') st.rs[a.rule].status = 'paused'; return 'paused ' + a.rule;
    case 'resume_rule': if (st.rs[a.rule] && st.rs[a.rule].status === 'paused') st.rs[a.rule].status = 'armed'; return 'resumed ' + a.rule;
    case 'deploy_remaining': st.deploy = { clipsLeft: 4, next: now }; return 'started deploying the remaining balance in 4 clips (1 every 5 min)';
    case 'notify': return 'notice: ' + (a.message || rule.name);
  }
  return '';
}

// Um tick: recebe o instantaneo de mercado e avanca a estrategia.
exports.tick = function (strat, snap, ctx, now) {
  const st = strat.state;
  now = now || Date.now();
  if (!st.liqBase) st.liqBase = snap.liquidity;
  strat.rules.forEach(function (r) { if (!st.rs[r.id]) st.rs[r.id] = { status: 'armed', fired: 0, last: 0, nextDue: 0, on: false }; });
  st.last = { price: snap.price, liquidity: snap.liquidity, change: snap.change, t: now };
  st.lastTick = now;
  if (st.qty > 0) st.peak = Math.max(st.peak, snap.price);

  exports.expireOrders(strat, now);
  if (strat.status !== 'active') { st.prev = snap.price; return; }

  const loss = strat.params.budget - exports.equity(st, snap.price);
  if (strat.params.maxLoss && loss >= strat.params.maxLoss) {
    strat.status = 'paused';
    log(st, snap.price, '-', 'Strategy paused: loss of ' + money(loss) + ' reached the ' + money(strat.params.maxLoss) + ' limit', 'block');
    st.prev = snap.price; return;
  }

  // Aporte parcelado (deploy_remaining).
  if (st.deploy && now >= st.deploy.next) {
    const clip = st.cash / st.deploy.clipsLeft;
    const res = place(strat, st, snap, 'buy', clip, 'deploy', now);
    log(st, snap.price, 'deploy', res, /^blocked/.test(res) ? 'block' : /pending order/.test(res) ? 'order' : 'fill');
    if (!/^blocked/.test(res)) { st.deploy.clipsLeft--; st.deploy.next = now + 5 * 60000; if (st.deploy.clipsLeft <= 0) st.deploy = null; }
    else st.deploy.next = now + 60000;
  }

  strat.rules.slice().sort(function (a, b) { return a.priority - b.priority; }).forEach(function (r) {
    const rs = st.rs[r.id];
    if (rs.status !== 'armed') return;
    const active = triggerState(r.when, st, snap, rs, now);
    const edge = r.when.type === 'interval' || r.when.type === 'price_cross' ? active : (active && !rs.on);
    if (r.when.type !== 'interval' && r.when.type !== 'price_cross') rs.on = active;
    if (!edge) return;
    if (r.when.type === 'interval') rs.nextDue = now + r.when.minutes * 60000;

    for (let i = 0; i < r.if.length; i++) {
      const why = checkCondition(r.if[i], st, snap, rs, ctx, now, strat.rules);
      if (why) { log(st, snap.price, r.id, 'blocked: ' + why, 'block'); return; }
    }
    const results = r.then.map(function (a) { return runAction(a, st, snap, r, strat, now); });
    const blocked = results.some(function (x) { return /^blocked/.test(x); });
    const joined = results.join(' | ');
    log(st, snap.price, r.id, joined, blocked ? 'block' : /pending order/.test(joined) ? 'order' : /bought|sold/.test(joined) ? 'fill' : 'info');
    if (!blocked) { rs.fired++; rs.last = now; if (r.once) rs.status = 'completed'; }
  });
  st.prev = snap.price;
};

exports.summary = function (strat) {
  const st = strat.state, price = st.last ? st.last.price : 0;
  const equity = exports.equity(st, price), pnl = equity - strat.params.budget;
  return {
    equity: equity, pnl: pnl, pnlPct: strat.params.budget ? pnl / strat.params.budget * 100 : 0,
    cash: st.cash, position: st.qty * price, qty: st.qty, avgCost: st.qty > 0 ? st.cost / st.qty : 0,
    realized: st.realized, fills: st.fills.length, price: price
  };
};
