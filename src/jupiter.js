'use strict';
// Jupiter (agregador de trocas): cotacao e montagem da transacao. NAO assina nem envia nada.
// Usa a API v1 (/swap/v1). A Jupiter esta migrando para a v2: se a v1 sair do ar, o ajuste e so neste arquivo.
// Sem chave a API aceita ~0,5 requisicao por segundo; com JUP_API_KEY (portal.jup.ag) o limite e maior.
const http = require('./http');

const BASE = process.env.JUP_BASE || 'https://api.jup.ag';
const MAX_PRIORITY = Number(process.env.JUP_MAX_PRIORITY_LAMPORTS) || 200000; // teto da taxa de prioridade (0,0002 SOL)

function headers() { return process.env.JUP_API_KEY ? { 'x-api-key': process.env.JUP_API_KEY } : {}; }
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

async function withRetry(fn) {
  try { return await fn(); }
  catch (e) {
    if (/HTTP 429/.test(e.message)) { await sleep(2300); return fn(); } // limite sem chave: espera e tenta uma vez
    throw e;
  }
}

// opts.excludeDexes: lista de nomes de DEX a evitar (usado quando a simulacao da rota escolhida falha).
exports.quote = function (inputMint, outputMint, amountRaw, slippageBps, opts) {
  let q = 'inputMint=' + inputMint + '&outputMint=' + outputMint + '&amount=' + amountRaw + '&slippageBps=' + slippageBps + '&restrictIntermediateTokens=true';
  if (opts && opts.excludeDexes && opts.excludeDexes.length) q += '&excludeDexes=' + encodeURIComponent(opts.excludeDexes.join(','));
  return withRetry(function () { return http.getJson(BASE + '/swap/v1/quote?' + q, headers()); });
};

exports.swap = function (quote, userPublicKey) {
  return withRetry(function () {
    return http.postJson(BASE + '/swap/v1/swap', {
      quoteResponse: quote, userPublicKey: userPublicKey, dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: MAX_PRIORITY, priorityLevel: 'high' } }
    }, headers(), 20000);
  });
};
