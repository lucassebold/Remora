'use strict';
// Diagnostico da IA: node src/aicheck.js   (com GEMINI_API_KEY definida na mesma janela)
const compiler = require('./compiler');
const http = require('./http');

(async function () {
  if (!compiler.available()) { console.log('Nenhuma chave de IA definida. Defina GEMINI_API_KEY e rode de novo.'); return; }
  console.log('Provedor:', compiler.provider());
  if (compiler.provider() === 'gemini') {
    try { console.log('Modelos que serao tentados, em ordem:\n  ' + (await compiler.geminiFlashList({ 'x-goog-api-key': process.env.GEMINI_API_KEY })).slice(0, 8).join('\n  ')); }
    catch (e) { console.log('Nao consegui listar os modelos:', e.message); }
  }
  const t0 = Date.now();
  const frase = 'Vá comprando aos poucos enquanto o preço estiver baixo e saia se começar a despencar';
  try {
    const out = await compiler.compile(frase, { symbol: 'TESTE', price: 0.04, liquidity: 500000 });
    console.log('\nResultado em ' + ((Date.now() - t0) / 1000).toFixed(1) + 's, modo: ' + out.mode + (out.note ? '\nAviso: ' + out.note : ''));
    (out.assumptions || []).forEach(function (a) { console.log('Assumiu: ' + a); });
    out.rules.forEach(function (r) { console.log(' - ' + r.id + ': ' + JSON.stringify(r.when) + ' se ' + JSON.stringify(r.if) + ' entao ' + JSON.stringify(r.then)); });
  } catch (e) { console.log('\nFalhou em ' + ((Date.now() - t0) / 1000).toFixed(1) + 's:', e.message); }
  void http;
})();
