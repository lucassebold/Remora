'use strict';
// Testes da lista "em alta" com o DexScreener simulado (sem rede). Rode: node test/market_tests.js
const assert = require('assert');
const http = require('../src/http');

const mint = function (c) { return 'T' + c + 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijk'.slice(0, 38); };
const A = mint('1'), B = mint('2'), C = mint('3'), D = mint('4'), E = mint('5');
const vol = { [A]: 100, [B]: 5000, [C]: 900, [D]: 99999, [E]: 700 };
const liq = { [A]: 50000, [B]: 20000, [C]: 80000, [D]: 200, [E]: 30000 };   // D: liquidez baixa demais
let down = false, calls = 0;

function pair(m) {
  return { chainId: 'solana', pairAddress: 'P' + m, dexId: 'raydium', baseToken: { address: m, symbol: 'S' + m.slice(1, 3), name: 'n' }, priceUsd: '0.01', liquidity: { usd: liq[m] }, txns: {}, volume: { h1: vol[m] }, priceChange: {} };
}
http.getJson = async function (url) {
  calls++;
  if (down) throw new Error('HTTP 429 em api.dexscreener.com');
  if (/token-boosts\/top/.test(url)) return [{ chainId: 'solana', tokenAddress: A }, { chainId: 'solana', tokenAddress: B }];
  if (/token-boosts\/latest/.test(url)) return [{ chainId: 'solana', tokenAddress: B }, { chainId: 'solana', tokenAddress: D }, { chainId: 'ethereum', tokenAddress: 'x' }];
  if (/token-profiles/.test(url)) return [{ chainId: 'solana', tokenAddress: C }, { chainId: 'solana', tokenAddress: E }];
  if (/tokens\/v1/.test(url)) return url.split('/').pop().split(',').map(pair);
  throw new Error('url inesperada ' + url);
};
const market = require('../src/market');

(async function () {
  const list = await market.trending();
  assert.deepStrictEqual(list.map(function (s) { return s.mint; }), [B, C, E, A], 'junta as 3 fontes, tira liquidez baixa e ordena por volume 1h');

  const before = calls;
  await market.trending(); await market.trending();
  assert.strictEqual(calls, before, 'leituras seguidas vem do cache');
  console.log('ok   lista em alta: fontes juntas, filtro de liquidez, ordem por volume, cache');

  // cache vencido + DexScreener fora: devolve a lista antiga em vez de erro
  await new Promise(function (r) { setTimeout(r, 10); });
  down = true;
  const realNow = Date.now; Date.now = function () { return realNow() + 31000; };
  try {
    const again = await market.trending();
    assert.deepStrictEqual(again.map(function (s) { return s.mint; }), [B, C, E, A]);
  } finally { Date.now = realNow; }
  console.log('ok   lista em alta: se a API cai, mostra a ultima lista boa');
})().catch(function (e) { console.log('FALHA ' + e.message); process.exitCode = 1; });
