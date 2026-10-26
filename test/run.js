'use strict';
// Testes do motor e da validacao, com precos ficticios. Rode: npm test
const assert = require('assert');
const rules = require('../src/rules');
const engine = require('../src/engine');

let passed = 0;
function t(name, fn) { try { fn(); passed++; console.log('ok   ' + name); } catch (e) { console.log('FALHA ' + name + '\n     ' + e.message); process.exitCode = 1; } }

function snap(price, extra) {
  return Object.assign({ price: price, liquidity: 500000, change: { m5: 0, h1: 0, h6: 0, h24: 0 }, volume: { m5: 0, h1: 100, h6: 0, h24: 0 } }, extra || {});
}
function make(ruleList, params) {
  const v = rules.validate(ruleList);
  assert.ok(v.ok, (v.errors || []).join('; '));
  const p = Object.assign({ budget: 1000, maxPerTrade: 500, maxLoss: 0 }, params || {});
  return { status: 'active', params: p, rules: v.rules, state: engine.newState(p.budget, 1, p.startWithPosition) };
}
const MIN = 60000;

t('validacao rejeita regra invalida', function () {
  assert.ok(!rules.validate([{ id: 'a', when: { type: 'interval' }, if: [], then: [{ type: 'buy', usd: 10 }] }]).ok);
  assert.ok(!rules.validate([{ id: 'a', when: { type: 'inventado', x: 1 }, if: [], then: [{ type: 'buy', usd: 10 }] }]).ok);
  assert.ok(!rules.validate([{ id: 'a', when: { type: 'interval', minutes: 5 }, if: [], then: [{ type: 'disable_rule', rule: 'nao_existe' }] }]).ok);
});

t('presets sao validos', function () {
  rules.presets().forEach(function (p) { assert.ok(rules.validate(p.build({ cap: 1.05 })).ok, p.id); });
});

t('interval compra respeitando o teto de preco', function () {
  const s = make([{ id: 'dca', when: { type: 'interval', minutes: 60 }, if: [{ type: 'price_max', price: 1.1 }], then: [{ type: 'buy', usd: 100 }] }]);
  let now = 1e12;
  engine.tick(s, snap(1), {}, now);            // dispara no primeiro tick
  engine.tick(s, snap(1), {}, now + 30 * MIN); // ainda nao venceu
  assert.strictEqual(s.state.fills.length, 1);
  engine.tick(s, snap(1.5), {}, now + 61 * MIN); // venceu, mas preco acima do teto: bloqueia
  assert.strictEqual(s.state.fills.length, 1);
  assert.ok(/blocked/.test(s.state.log[0].text));
  engine.tick(s, snap(1), {}, now + 122 * MIN);
  assert.strictEqual(s.state.fills.length, 2);
});

t('stop trailing vende tudo apos queda desde o pico', function () {
  const s = make([
    { id: 'in', priority: 1, once: true, when: { type: 'interval', minutes: 1 }, if: [], then: [{ type: 'buy', usd: 200 }] },
    { id: 'stop', priority: 2, when: { type: 'drawdown_from_peak', pct: 25 }, if: [], then: [{ type: 'sell', pct: 100 }] }
  ]);
  const now = 1e12;
  engine.tick(s, snap(1), {}, now);
  engine.tick(s, snap(2), {}, now + MIN);
  engine.tick(s, snap(1.6), {}, now + 2 * MIN);  // -20%: nao dispara
  assert.ok(s.state.qty > 0);
  engine.tick(s, snap(1.4), {}, now + 3 * MIN);  // -30%: dispara
  assert.strictEqual(s.state.qty, 0);
  assert.ok(s.state.realized > 0);
});

t('gatilho de borda: price_change nao repete a cada tick', function () {
  const s = make([{ id: 'dip', when: { type: 'price_change', pct: -20, window: '24h' }, if: [], then: [{ type: 'buy', usd: 50 }] }]);
  const drop = { change: { m5: 0, h1: 0, h6: 0, h24: -30 } };
  engine.tick(s, snap(1, drop), {}, 1e12);
  engine.tick(s, snap(1, drop), {}, 1e12 + MIN);
  engine.tick(s, snap(1, drop), {}, 1e12 + 2 * MIN);
  assert.strictEqual(s.state.fills.length, 1);
  engine.tick(s, snap(1), {}, 1e12 + 3 * MIN);   // recupera: rearma
  engine.tick(s, snap(1, drop), {}, 1e12 + 4 * MIN);
  assert.strictEqual(s.state.fills.length, 2);
});

t('juiz exige limiar e regra once vira completed', function () {
  const s = make([
    { id: 'dca', priority: 1, when: { type: 'interval', minutes: 60 }, if: [], then: [{ type: 'buy', usd: 10 }] },
    { id: 'crash', priority: 2, once: true, when: { type: 'price_change', pct: -50, window: '24h' }, if: [{ type: 'jev', label: 'market_drawdown', min: 0.6 }], then: [{ type: 'disable_rule', rule: 'dca' }, { type: 'deploy_remaining' }] }
  ]);
  const crash = { change: { m5: 0, h1: 0, h6: 0, h24: -60 } };
  engine.tick(s, snap(1, crash), { marketH24: 5 }, 1e12);          // mercado calmo: token especifico, bloqueia
  assert.strictEqual(s.state.rs.crash.status, 'armed');
  engine.tick(s, snap(1), { marketH24: -30 }, 1e12 + MIN);          // rearma
  engine.tick(s, snap(1, crash), { marketH24: -30 }, 1e12 + 2 * MIN); // mercado em queda: passa
  assert.strictEqual(s.state.rs.crash.status, 'completed');
  assert.strictEqual(s.state.rs.dca.status, 'disabled');
  assert.ok(s.state.deploy);
});

t('bloqueia compra com impacto de preco alto e respeita perda maxima', function () {
  const s = make([{ id: 'b', when: { type: 'interval', minutes: 1 }, if: [], then: [{ type: 'buy', usd: 500 }] }]);
  engine.tick(s, snap(1, { liquidity: 10000 }), {}, 1e12); // 500/10000 = 5% de impacto
  assert.strictEqual(s.state.fills.length, 0);
  const s2 = make([{ id: 'b', when: { type: 'interval', minutes: 1 }, if: [], then: [{ type: 'buy', usd: 500 }] }], { maxLoss: 100 });
  engine.tick(s2, snap(1), {}, 1e12);
  engine.tick(s2, snap(0.5), {}, 1e12 + 2 * MIN); // equity cai ~250
  assert.strictEqual(s2.status, 'paused');
});

t('modo simples entende frases e rejeita o que nao entende', function () {
  const c = require('../src/compiler');
  const tok = { price: 0.5 };
  const a = c.localCompile('Compre $50 a cada 30 min abaixo de $0.40. Venda tudo se cair 25% do pico.', tok);
  const ids = a.rules.map(function (r) { return r.id; });
  assert.deepStrictEqual(ids, ['dca', 'stop']);
  assert.strictEqual(a.rules[0].when.minutes, 30);
  assert.strictEqual(a.rules[0].if[0].price, 0.4);
  assert.strictEqual(a.rules[1].when.pct, 25);
  const b = c.localCompile('buy $100 every hour below the current price', tok);
  assert.strictEqual(b.rules[0].when.minutes, 60);
  assert.strictEqual(b.rules[0].if[0].price, 0.5);
  const d = c.localCompile('Compre $200 se cair 20% em 24h. Venda 25% em +50% e 25% em +100%.', tok);
  assert.deepStrictEqual(d.rules.map(function (r) { return r.id; }), ['dip', 'tp1', 'tp2']);
  const v = c.localCompile('venda 25% quando o volume passar de 5x', tok);
  assert.strictEqual(v.rules[0].when.multiple, 5);
  assert.throws(function () { c.localCompile('faca dinheiro rapido', tok); });
});

// Teste assincrono (Gemini simulado), em sequencia: cada chamada usa a resposta simulada do seu proprio passo.
(async function () {
  const http = require('../src/http');
  const c = require('../src/compiler');
  const real = http.postJson, realGet = http.getJson;
  http.getJson = function () { return Promise.reject(new Error('sem rede no teste')); }; // lista de modelos: nao chama o Google
  process.env.GEMINI_API_KEY = 'teste';
  process.env.GEMINI_RETRY_MS = '1';
  let reply;
  http.postJson = function () { return reply(); };
  const gem = function (obj) { return Promise.resolve({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] }); };
  const good = { name: 'Minha', rules: [{ id: 'a', name: 'A', priority: 1, when: { type: 'interval', minutes: 10 }, if: [], then: [{ type: 'buy', usd: 20 }] }] };
  const tok = { symbol: 'X', price: 1, liquidity: 1e5 };
  try {
    assert.strictEqual(c.provider(), 'gemini');
    reply = function () { return gem(good); };
    let o = await c.compile('qualquer coisa livre', tok);
    assert.strictEqual(o.mode, 'ai'); assert.strictEqual(o.rules[0].id, 'a');
    // IA devolve regra inventada: o validador barra e cai para o modo simples (frase conhecida)
    reply = function () { return gem({ name: 'x', rules: [{ id: 'z', when: { type: 'inventado' }, if: [], then: [{ type: 'buy', usd: 1 }] }] }); };
    o = await c.compile('compre $10 a cada 5 min', tok);
    assert.strictEqual(o.mode, 'simple'); assert.ok(/AI unavailable/.test(o.note));
    // Limite gratuito (429): idem
    reply = function () { return Promise.reject(new Error('HTTP 429 em generativelanguage.googleapis.com')); };
    o = await c.compile('compre $10 a cada 5 min', tok);
    assert.strictEqual(o.mode, 'simple');
    // Timeout: tenta outros modelos e depois cai no modo simples
    let tries = 0;
    reply = function () { tries++; return Promise.reject(new Error('Timeout em generativelanguage.googleapis.com')); };
    o = await c.compile('compre $10 a cada 5 min', tok);
    assert.strictEqual(o.mode, 'simple'); assert.strictEqual(tries, 2); // os 2 aliases de reserva
    // IA falha e o modo simples tambem nao entende: erro claro
    reply = function () { return Promise.reject(new Error('HTTP 500')); };
    let msg = '';
    try { await c.compile('faca dinheiro', tok); } catch (e) { msg = e.message; }
    assert.ok(/Could not turn that into rules/.test(msg), 'message: ' + msg);
    // 503 passageiro: tenta de novo no mesmo modelo e funciona
    let calls = 0;
    reply = function () { calls++; return calls === 1 ? Promise.reject(new Error('HTTP 503 em generativelanguage.googleapis.com')) : gem(good); };
    o = await c.compile('frase livre qualquer', tok);
    assert.strictEqual(o.mode, 'ai'); assert.strictEqual(calls, 2);
    passed++; console.log('ok   caminho da IA (Gemini simulado)');
  } catch (e) { process.exitCode = 1; console.log('FALHA caminho da IA\n     ' + e.message); }
  http.postJson = real; http.getJson = realGet; delete process.env.GEMINI_API_KEY; delete process.env.GEMINI_RETRY_MS;
  passed += await require('./live_tests').run();
  passed += await require('./auth_tests').run();
  console.log('\n' + passed + ' testes passaram');
})();
