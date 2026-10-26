'use strict';
// Testes do modo real (com aprovacao). Sem rede e sem dinheiro: tudo com dados simulados.
const assert = require('assert');
const rules = require('../src/rules');
const engine = require('../src/engine');
const orders = require('../src/orders');

const MIN = 60000;
const SOLM = 'So11111111111111111111111111111111111111112';
const W = 'W'.repeat(44);
const MINT = 'M'.repeat(44);
const BUY_RULE = [{ id: 'b', when: { type: 'interval', minutes: 1 }, if: [], then: [{ type: 'buy', usd: 20 }] }];

function snap(price, extra) {
  return Object.assign({ price: price, liquidity: 500000, change: { m5: 0, h1: 0, h6: 0, h24: 0 }, volume: { m5: 0, h1: 100, h6: 0, h24: 0 } }, extra || {});
}
function makeLive(ruleList, params) {
  const v = rules.validate(ruleList);
  assert.ok(v.ok, (v.errors || []).join('; '));
  const p = Object.assign({ budget: 1000, maxPerTrade: 500, maxLoss: 0 }, params || {});
  return { status: 'active', live: true, wallet: W, mint: MINT, params: p, rules: v.rules, state: engine.newState(p.budget, 1, 0) };
}

const out = [];
function t(name, fn) { out.push({ name: name, fn: fn }); }

t('modo real: a regra cria ordem pendente e NAO altera o livro', function () {
  const s = makeLive(BUY_RULE);
  engine.tick(s, snap(1), {}, 1e12);
  assert.strictEqual(s.state.orders.length, 1);
  assert.strictEqual(s.state.orders[0].status, 'pending');
  assert.strictEqual(s.state.fills.length, 0);
  assert.strictEqual(s.state.cash, 1000);
  assert.strictEqual(s.state.qty, 0);
});

t('modo real: so uma ordem aberta por vez e expira se ninguem aprovar', function () {
  const s = makeLive(BUY_RULE);
  engine.tick(s, snap(1), {}, 1e12);
  engine.tick(s, snap(1), {}, 1e12 + 2 * MIN);   // a regra dispara de novo, mas ja ha uma ordem aberta
  assert.strictEqual(s.state.orders.length, 1);
  assert.ok(/already waiting/.test(s.state.log[0].text));
  engine.tick(s, snap(1), {}, 1e12 + 4 * MIN);   // passou o prazo de 3 min
  assert.strictEqual(s.state.orders[s.state.orders.length - 1].status, 'expired');
  engine.tick(s, snap(1), {}, 1e12 + 6 * MIN);   // agora pode criar outra
  assert.strictEqual(s.state.orders[0].status, 'pending');
});

t('modo real: applyFill atualiza o livro (compra e venda com lucro)', function () {
  const s = makeLive(BUY_RULE);
  engine.tick(s, snap(1), {}, 1e12);
  const o = s.state.orders[0];
  engine.applyFill(s, o, { tokens: 20, usd: 20, signature: 'sig' }, 1e12 + 1);
  assert.strictEqual(o.status, 'filled');
  assert.strictEqual(s.state.cash, 980); assert.strictEqual(s.state.qty, 20); assert.strictEqual(s.state.cost, 20);
  engine.applyFill(s, { side: 'sell', price: 2, rule: 'x' }, { tokens: 10, usd: 25, signature: 's2' }, 1e12 + 2);
  assert.strictEqual(s.state.qty, 10); assert.strictEqual(s.state.realized, 15); assert.strictEqual(s.state.cash, 1005);
});

t('modo real: venda sem posicao e bloqueada', function () {
  const s = makeLive([{ id: 's', when: { type: 'interval', minutes: 1 }, if: [], then: [{ type: 'sell', pct: 50 }] }]);
  engine.tick(s, snap(1), {}, 1e12);
  assert.strictEqual((s.state.orders || []).length, 0);
  assert.ok(/no position/.test(s.state.log[0].text));
});

t('modo real: aceita ordem de centavos ($0,05) e recusa abaixo do piso ($0,02)', function () {
  const small = [{ id: 'b', when: { type: 'interval', minutes: 1 }, if: [], then: [{ type: 'buy', usd: 0.05 }] }];
  const s = makeLive(small, { budget: 5, maxPerTrade: 0.05 });
  engine.tick(s, snap(1), {}, 1e12);
  assert.strictEqual(s.state.orders.length, 1); assert.strictEqual(s.state.orders[0].usd, 0.05);
  const tiny = [{ id: 'b', when: { type: 'interval', minutes: 1 }, if: [], then: [{ type: 'buy', usd: 0.02 }] }];
  const s2 = makeLive(tiny, { budget: 5, maxPerTrade: 0.02 });
  engine.tick(s2, snap(1), {}, 1e12);
  assert.strictEqual((s2.state.orders || []).length, 0);
});

t('modo real: "vender tudo agora" cria ordem pendente de venda (so com posicao)', function () {
  const s = makeLive(BUY_RULE, { budget: 100, maxPerTrade: 20 });
  engine.tick(s, snap(1), {}, 1e12);
  s.state.orders[0].status = 'declined';
  assert.throws(function () { engine.manualOrder(s, 'sell', 100, 1e12 + 1); }, /no position/);
  s.state.qty = 0.5; s.state.cost = 0.5;
  engine.manualOrder(s, 'sell', 100, 1e12 + 2);
  assert.strictEqual(s.state.orders[0].side, 'sell'); assert.strictEqual(s.state.orders[0].status, 'pending'); assert.strictEqual(s.state.orders[0].rule, 'manual');
  assert.throws(function () { engine.manualOrder(s, 'sell', 100, 1e12 + 3); }, /already waiting/);
  engine.applyFill(s, s.state.orders[0], { tokens: 0.5, usd: 0.6, signature: 'x' }, 1e12 + 4);
  assert.strictEqual(s.state.qty, 0);   // posicao pequena zerada sem sobrar "poeira" no livro
});

function strat() {
  const s = makeLive(BUY_RULE, { budget: 100, maxPerTrade: 20 });
  engine.tick(s, snap(1), {}, Date.now()); // cria a ordem pendente de $20
  return s;
}
function deps(o) {
  o = o || {};
  return {
    market: {
      snapshots: async function () { const r = {}; r[SOLM] = { price: 100 }; r[MINT] = { price: 1, symbol: 'TKN' }; return r; },
      decimals: async function () { return 6; },
      solBalance: async function () { return o.sol === undefined ? 5 : o.sol; },
      tokenBalance: async function () { const h = o.held === undefined ? 20 : o.held; return { ui: h, raw: String(h * 1e6) }; },
      sigStatus: async function () { return o.status === undefined ? { confirmationStatus: 'confirmed', err: null } : o.status; }
    },
    jup: {
      quote: async function () { return { outAmount: o.out || String(o.side === 'sell' ? 0.2 * 1e9 : 20 * 1e6), otherAmountThreshold: '1', priceImpactPct: '0.001', routePlan: [{ swapInfo: { label: 'Raydium' } }] }; },
      swap: async function () { return o.simErr ? { swapTransaction: 'AAA', simulationError: { err: 'x' } } : { swapTransaction: 'dHg=' }; }
    },
    every: 0, tries: 3, sleep: function () { return Promise.resolve(); }
  };
}
async function rejects(fn, re) {
  let m = '';
  try { await fn(); } catch (e) { m = e.message; }
  assert.ok(re.test(m), 'esperava ' + re + ' e veio: ' + m);
}
const SIG = '5' + 'a'.repeat(86);

t('ordens reais: compra completa (preparar, assinar, confirmar, livro atualizado)', async function () {
  const s = strat(); const id = s.state.orders[0].id;
  const prep = await orders.prepare(s, id, W, deps());
  assert.strictEqual(prep.tx, 'dHg='); assert.strictEqual(s.state.orders[0].status, 'prepared');
  const done = new Promise(function (resolve) { orders.submitted(s, id, W, SIG, deps(), resolve); });
  assert.strictEqual(s.state.orders[0].status, 'sent');
  await done;
  assert.strictEqual(s.state.orders[0].status, 'filled');
  assert.strictEqual(s.state.qty, 20); assert.strictEqual(s.state.cash, 80);
});

t('ordens reais: assinatura que chega depois de expirar ainda e registrada (nao perde o rastro do dinheiro)', async function () {
  const s = strat(); const id = s.state.orders[0].id;
  await orders.prepare(s, id, W, deps());
  assert.ok(s.state.orders[0].expiresAt - Date.now() <= 90000 + 50);  // prazo para assinar = vida da transacao
  s.state.orders[0].expiresAt = Date.now() - 1000;                    // o prazo passou enquanto a carteira estava aberta
  engine.expireOrders(s, Date.now());
  assert.strictEqual(s.state.orders[0].status, 'expired');
  await new Promise(function (resolve) { orders.submitted(s, id, W, SIG, deps(), resolve); });
  assert.strictEqual(s.state.orders[0].status, 'filled');
  assert.strictEqual(s.state.qty, 20);
  // ordem que expirou SEM ser preparada continua nao aceitando assinatura
  const s2 = strat(); s2.state.orders[0].expiresAt = Date.now() - 1000; engine.expireOrders(s2, Date.now());
  await rejects(function () { return orders.submitted(s2, s2.state.orders[0].id, W, SIG, deps(), function () {}); }, /not ready/);
});

t('ordens reais: preco pior que o limite vira AVISO (a pessoa decide); erro de dados bloqueia', async function () {
  const s = strat(); const id = s.state.orders[0].id;
  const warned = await orders.prepare(s, id, W, deps({ out: String(Math.round(16.67 * 1e6)) })); // ~20% pior
  assert.ok(warned.summary.warning && warned.summary.warning.deviationPct > 15, 'deveria avisar');
  assert.strictEqual(warned.tx, 'dHg=');                                                         // a transacao e entregue mesmo assim
  assert.strictEqual((await orders.prepare(s, id, W, deps())).summary.warning, null);            // cotacao boa: sem aviso
  await rejects(function () { return orders.prepare(s, id, W, deps({ out: String(10 * 1e6) })); }, /data error/); // ~100% pior
});

t('ordens reais: token volatil recebe tolerancia (slippage) maior; calmo mantem 1%', async function () {
  const mk = function (change) { const d = deps(); d.market.snapshots = async function () { const r = {}; r[SOLM] = { price: 100 }; r[MINT] = { price: 1, symbol: 'TKN', change: change }; return r; }; return d; };
  let s = strat(); let p = await orders.prepare(s, s.state.orders[0].id, W, mk({ m5: 0.2, h1: 1 }));
  assert.strictEqual(p.summary.slippageBps, 100); assert.strictEqual(p.summary.widened, false);
  s = strat(); p = await orders.prepare(s, s.state.orders[0].id, W, mk({ m5: 7, h1: 10 }));
  assert.strictEqual(p.summary.slippageBps, 300); assert.strictEqual(p.summary.widened, true);
  s = strat(); p = await orders.prepare(s, s.state.orders[0].id, W, mk({ m5: 37, h1: 31 }));
  assert.strictEqual(p.summary.slippageBps, 500);
});

t('ordens reais: se a simulacao da rota falha, tenta outra rota evitando aquele DEX', async function () {
  orders.resetBadDexes();
  const s = strat(); const id = s.state.orders[0].id;
  const seen = [];
  const d = deps();
  d.jup.quote = async function (i, o, amt, slip, opts) {
    seen.push((opts && opts.excludeDexes || []).slice());
    const bad = !opts || !opts.excludeDexes || opts.excludeDexes.indexOf('DexRuim') < 0;
    return { outAmount: String(20 * 1e6), otherAmountThreshold: '1', priceImpactPct: '0.001', routePlan: [{ swapInfo: { label: bad ? 'DexRuim' : 'DexBom' } }] };
  };
  d.jup.swap = async function (q) { return q.routePlan[0].swapInfo.label === 'DexRuim' ? { swapTransaction: 'AAA', simulationError: { error: 'custom program error: 0x1' } } : { swapTransaction: 'dHg=' }; };
  const p = await orders.prepare(s, id, W, d);
  assert.strictEqual(p.tx, 'dHg=');
  assert.strictEqual(p.summary.route, 'DexBom'); assert.strictEqual(p.summary.rerouted, true);
  assert.deepStrictEqual(seen[0], []); assert.deepStrictEqual(seen[1], ['DexRuim']);
  // a proxima ordem ja evita o DEX ruim de cara (sem repetir a falha)
  const s2 = strat(); seen.length = 0;
  await orders.prepare(s2, s2.state.orders[0].id, W, d);
  assert.deepStrictEqual(seen[0], ['DexRuim']); assert.strictEqual(seen.length, 1);
  orders.resetBadDexes();
});

t('ordens reais: bloqueios (carteira errada, preco ruim, SOL baixo, simulacao falhou)', async function () {
  orders.resetBadDexes();
  const s = strat(); const id = s.state.orders[0].id;
  await rejects(function () { return orders.prepare(s, id, 'X'.repeat(44), deps()); }, /Connect this strategy/);

  await rejects(function () { return orders.prepare(s, id, W, deps({ sol: 0.05 })); }, /Not enough SOL/);
  await rejects(function () { return orders.prepare(s, id, W, deps({ simErr: true })); }, /transaction simulation failed/);
  assert.strictEqual(s.state.orders[0].status, 'pending');   // nada ficou "preparado" por engano
  await rejects(function () { return orders.submitted(s, id, W, SIG, deps(), function () {}); }, /not ready/);
  orders.decline(s, id, W); assert.strictEqual(s.state.orders[0].status, 'declined');
});

t('ordens reais: transacao que falha ou nao confirma nao altera o livro', async function () {
  let s = strat(); let id = s.state.orders[0].id;
  await orders.prepare(s, id, W, deps());
  await new Promise(function (resolve) { orders.submitted(s, id, W, SIG, deps({ status: { err: { InstructionError: [0, 'x'] } } }), resolve); });
  assert.strictEqual(s.state.orders[0].status, 'failed'); assert.strictEqual(s.state.qty, 0); assert.strictEqual(s.state.cash, 100);
  s = strat(); id = s.state.orders[0].id;
  await orders.prepare(s, id, W, deps());
  await new Promise(function (resolve) { orders.submitted(s, id, W, SIG, deps({ status: null }), resolve); });
  assert.strictEqual(s.state.orders[0].status, 'unconfirmed'); assert.strictEqual(s.state.qty, 0);
});

t('ordens reais: venda limitada pelo saldo real da carteira', async function () {
  const s = strat(); s.state.orders[0].status = 'declined';
  s.state.qty = 20; s.state.cost = 20; s.state.cash = 80;
  s.rules = [{ id: 'sl', name: 'sl', priority: 1, when: { type: 'interval', minutes: 1 }, if: [], then: [{ type: 'sell', pct: 100 }] }]; s.state.rs = {};
  engine.tick(s, snap(1), {}, Date.now() + 5 * MIN);
  const so = s.state.orders[0]; assert.strictEqual(so.side, 'sell');
  const sp = await orders.prepare(s, so.id, W, deps({ side: 'sell', held: 18 }));
  assert.strictEqual(so.prepared.tokens, 18);
  assert.ok(sp.summary.receive.indexOf('SOL') > 0);
});

exports.run = async function () {
  let passed = 0;
  for (let i = 0; i < out.length; i++) {
    try { await out[i].fn(); passed++; console.log('ok   ' + out[i].name); }
    catch (e) { process.exitCode = 1; console.log('FALHA ' + out[i].name + '\n     ' + e.message); }
  }
  return passed;
};
