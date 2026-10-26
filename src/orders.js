'use strict';
// Ciclo de uma ordem real: pendente -> preparada (cotacao + transacao) -> enviada (assinada pela carteira) -> confirmada.
// O servidor NUNCA assina: ele so monta a transacao. Quem assina e a carteira da pessoa, no navegador.
const engine = require('./engine');

const SOL = 'So11111111111111111111111111111111111111112';
// SOL que sempre sobra na carteira para taxas: taxa de rede (~0,000005) + prioridade (ate 0,0002) + aluguel da conta do token (~0,002, recuperavel).
const SOL_RESERVE = Number(process.env.LIVE_SOL_RESERVE) || 0.004;
const SIGN_WINDOW_MS = 90000;       // tempo para assinar depois de revisar (a transacao so e valida por ~1-2 min)
const DEFAULT_SLIPPAGE_BPS = 100;  // 1%
const DEFAULT_MAX_DEVIATION = 3;   // % de diferenca (cotacao x mercado) a partir da qual mostramos aviso e pedimos confirmacao
const HARD_MAX_DEVIATION = 50;      // acima disso bloqueia sempre (quase certamente erro de dados)

// Token que se move rapido muda de preco entre a cotacao e a assinatura: com tolerancia apertada a transacao falharia na rede.
function slippageFor(snap, base) {
  const c = snap.change || {}, m5 = Math.abs(c.m5 || 0), h1 = Math.abs(c.h1 || 0);
  if (m5 >= 15 || h1 >= 40) return Math.max(base, 500);
  if (m5 >= 5 || h1 >= 15) return Math.max(base, 300);
  return base;
}
exports.slippageFor = slippageFor;

// DEX cuja rota falhou na simulacao: evitados nas proximas cotacoes por 10 min (a Jupiter escolhe outra rota).
const BAD_DEX_TTL_MS = 10 * 60000;
const badDex = {};
function markBadDex(label) { badDex[label] = now() + BAD_DEX_TTL_MS; }
function activeBadDexes() { const t = now(); return Object.keys(badDex).filter(function (k) { return badDex[k] > t; }); }
function routeLabels(quote) {
  const out = [];
  (quote.routePlan || []).forEach(function (r) { const l = r.swapInfo && r.swapInfo.label; if (l && out.indexOf(l) < 0) out.push(l); });
  return out;
}
exports.resetBadDexes = function () { Object.keys(badDex).forEach(function (k) { delete badDex[k]; }); };

function fail(msg) { const e = new Error(msg); e.expose = true; return e; }
function now() { return Date.now(); }

exports.limits = function () {
  return {
    // No default caps: they only apply if you set these variables (null = no cap).
    maxOrderUsd: Number(process.env.LIVE_MAX_USD_PER_ORDER) > 0 ? Number(process.env.LIVE_MAX_USD_PER_ORDER) : null,
    maxBudgetUsd: Number(process.env.LIVE_MAX_BUDGET_USD) > 0 ? Number(process.env.LIVE_MAX_BUDGET_USD) : null
  };
};

function find(strat, id) {
  const o = (strat.state.orders || []).filter(function (x) { return x.id === id; })[0];
  if (!o) throw fail('Order not found');
  return o;
}

function checkOwner(strat, wallet) {
  if (!strat.live) throw fail('This strategy is paper trading only');
  if (!wallet || wallet !== strat.wallet) throw fail('Connect this strategy\'s wallet (' + strat.wallet.slice(0, 4) + '...' + strat.wallet.slice(-4) + ')');
}

// Monta a cotacao e a transacao. deps: { market, jup } (injetados para teste).
exports.prepare = async function (strat, orderId, wallet, deps) {
  checkOwner(strat, wallet);
  const o = find(strat, orderId);
  if (o.status !== 'pending' && o.status !== 'prepared') throw fail('This order is already ' + o.status);
  if (now() > o.expiresAt) { engine.expireOrders(strat, now()); throw fail('This order has expired. Wait for the rule to fire again.'); }

  const maxDev = strat.params.maxDeviationPct || DEFAULT_MAX_DEVIATION;
  const snaps = await deps.market.snapshots([SOL, strat.mint]);
  const solUsd = snaps[SOL] && snaps[SOL].price, snap = snaps[strat.mint];
  if (!(solUsd > 0) || !snap || !(snap.price > 0)) throw fail('No market price right now. Try again in a moment.');
  const dec = await deps.market.decimals(strat.mint);
  const slip = slippageFor(snap, strat.params.slippageBps || DEFAULT_SLIPPAGE_BPS);

  // Plano da ordem (o que pagar e receber), calculado uma vez; a cotacao pode ser refeita com outra rota.
  let plan;
  if (o.side === 'buy') {
    const lamports = Math.floor(o.usd / solUsd * 1e9);
    const bal = await deps.market.solBalance(wallet);
    if (bal < lamports / 1e9 + SOL_RESERVE) throw fail('Not enough SOL: you have ' + bal.toFixed(4) + ' SOL and this order needs ~' + (lamports / 1e9).toFixed(4) + ' + ' + SOL_RESERVE + ' for fees');
    plan = { inMint: SOL, outMint: strat.mint, amountRaw: String(lamports) };
  } else {
    const wb = await deps.market.tokenBalance(wallet, strat.mint);
    let qty = Math.min(strat.state.qty * o.pct / 100, wb.ui);
    if (!(qty > 0)) throw fail('You do not hold any ' + snap.symbol + ' in this wallet to sell');
    const raw = (o.pct >= 99.9 && qty >= wb.ui * 0.999) ? wb.raw : BigInt(Math.floor(qty * Math.pow(10, dec))).toString();
    if (raw === wb.raw) qty = wb.ui;
    plan = { inMint: strat.mint, outMint: SOL, amountRaw: raw, qty: qty };
  }

  function evaluate(quote) {
    let tokens, usd, dev, inLabel, outLabel;
    if (o.side === 'buy') {
      tokens = Number(quote.outAmount) / Math.pow(10, dec);
      if (!(tokens > 0)) throw fail('The quote returned no tokens');
      usd = o.usd;
      dev = (usd / tokens / snap.price - 1) * 100;        // pagar mais caro que o mercado = positivo
      inLabel = (Number(plan.amountRaw) / 1e9).toFixed(4) + ' SOL (~$' + usd.toFixed(2) + ')'; outLabel = '~' + tokens.toLocaleString('en-US', { maximumFractionDigits: 4 }) + ' ' + snap.symbol;
    } else {
      usd = Number(quote.outAmount) / 1e9 * solUsd; tokens = plan.qty;
      if (!(usd > 0)) throw fail('The quote returned no SOL');
      dev = (1 - usd / tokens / snap.price) * 100;        // receber menos que o mercado = positivo
      inLabel = tokens.toLocaleString('en-US', { maximumFractionDigits: 4 }) + ' ' + snap.symbol; outLabel = '~' + (Number(quote.outAmount) / 1e9).toFixed(4) + ' SOL (~$' + usd.toFixed(2) + ')';
    }
    return { tokens: tokens, usd: usd, dev: dev, inLabel: inLabel, outLabel: outLabel };
  }

  // Cotacao + transacao. Se a SIMULACAO da rota falhar (ex.: um DEX com problema), evita aqueles DEX e tenta outra rota.
  const exclude = activeBadDexes();
  let quote, ev, swap, lastSim = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { quote = await deps.jup.quote(plan.inMint, plan.outMint, plan.amountRaw, slip, { excludeDexes: exclude }); }
    catch (e) { throw fail(lastSim ? 'Could not find a route that simulates without errors. ' + lastSim : 'Could not get a Jupiter quote right now: ' + e.message); }
    ev = evaluate(quote);
    // Acima do limite de conforto a pessoa decide (aviso + confirmacao); so bloqueia de vez se parecer erro de dados.
    if (ev.dev > HARD_MAX_DEVIATION) throw fail('Blocked: the quote is ' + ev.dev.toFixed(1) + '% worse than the market price, which looks like a data error. Try again in a moment.');
    swap = await deps.jup.swap(quote, wallet);
    if (!swap.swapTransaction) throw fail('Jupiter did not return a transaction');
    if (!swap.simulationError) break;
    lastSim = 'The transaction simulation failed (' + JSON.stringify(swap.simulationError).slice(0, 120) + '). Nothing was sent.';
    const labels = routeLabels(quote);
    if (!labels.length) throw fail(lastSim);
    labels.forEach(function (l) { markBadDex(l); if (exclude.indexOf(l) < 0) exclude.push(l); });
    swap = null;
  }
  if (!swap) throw fail(lastSim || 'The transaction simulation failed. Nothing was sent.');
  const tokens = ev.tokens, usd = ev.usd, dev = ev.dev, inLabel = ev.inLabel, outLabel = ev.outLabel;
  const warning = dev > maxDev ? { deviationPct: dev, limitPct: maxDev } : null;

  o.status = 'prepared';
  o.expiresAt = now() + SIGN_WINDOW_MS; // a transacao tem vida curta: a pessoa tem este tempo para assinar
  o.prepared = { tokens: tokens, usd: usd, deviationPct: dev, at: now() };
  const summary = { side: o.side, symbol: snap.symbol, pay: inLabel, receive: outLabel, minReceive: quote.otherAmountThreshold, slippageBps: slip, widened: slip > (strat.params.slippageBps || DEFAULT_SLIPPAGE_BPS), deviationPct: dev, impactPct: Number(quote.priceImpactPct) * 100, route: routeLabels(quote).join(' > '), rerouted: exclude.length > activeBadDexes().length || lastSim !== null, expiresAt: o.expiresAt, warning: warning };
  return { tx: swap.swapTransaction, summary: summary };
};

// "Vender agora" / compra manual: cria uma ordem pendente que segue o mesmo caminho de aprovacao.
exports.manual = function (strat, wallet, side, amount) {
  checkOwner(strat, wallet);
  if (side !== 'sell') throw fail('Only manual sells are supported for now');
  try { return engine.manualOrder(strat, side, Math.min(100, Math.max(1, Number(amount) || 100)), now()); }
  catch (e) { throw fail(e.message); }
};

exports.decline = function (strat, orderId, wallet) {
  checkOwner(strat, wallet);
  const o = find(strat, orderId);
  if (o.status !== 'pending' && o.status !== 'prepared') throw fail('This order is already ' + o.status);
  o.status = 'declined';
  strat.state.log.unshift({ t: now(), price: o.price, rule: o.rule, text: 'order declined by you', kind: 'block' });
  return o;
};

// A pessoa assinou e a carteira enviou. Guardamos a assinatura e confirmamos na rede em segundo plano.
exports.submitted = function (strat, orderId, wallet, signature, deps, onChange) {
  checkOwner(strat, wallet);
  const o = find(strat, orderId);
  const late = o.status === 'expired' && !!o.prepared; // expirou enquanto a carteira estava aberta: registra mesmo assim
  if (o.status !== 'prepared' && !late) throw fail('Order is not ready to be registered (' + o.status + ')');
  if (!/^[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(signature || '')) throw fail('Invalid signature');
  o.status = 'sent'; o.signature = signature; o.sentAt = now();
  strat.state.log.unshift({ t: now(), price: o.price, rule: o.rule, text: 'order sent to the network, waiting for confirmation', kind: 'order' });
  watch(strat, o, deps, onChange);
  return o;
};

// Confirma na rede (verifica a cada 3 s por ate 90 s). Se confirmar sem erro, atualiza o livro da estrategia.
async function watch(strat, o, deps, onChange) {
  const sleep = deps.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  const tries = deps.tries || 30, every = deps.every === undefined ? 3000 : deps.every;
  for (let i = 0; i < tries; i++) {
    await sleep(every);
    let st = null;
    try { st = await deps.market.sigStatus(o.signature); } catch (e) { continue; }
    if (!st) continue;
    if (st.err) {
      o.status = 'failed';
      strat.state.log.unshift({ t: now(), price: o.price, rule: o.rule, text: 'the transaction failed on-chain (no funds moved other than network fees)', kind: 'block' });
      return onChange && onChange();
    }
    if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') {
      engine.applyFill(strat, o, { tokens: o.prepared.tokens, usd: o.prepared.usd, signature: o.signature }, now());
      return onChange && onChange();
    }
  }
  o.status = 'unconfirmed';
  strat.state.log.unshift({ t: now(), price: o.price, rule: o.rule, text: 'could not confirm the transaction within 90 s: check your wallet or the explorer (solscan.io/tx/' + o.signature.slice(0, 8) + '...)', kind: 'block' });
  if (onChange) onChange();
}
exports.watch = watch;
