'use strict';
// Dados de mercado publicos e gratuitos: DexScreener (preco), GeckoTerminal (candles), RPC Solana (autoridades).
const http = require('./http');

const DEX = 'https://api.dexscreener.com';
const GECKO = 'https://api.geckoterminal.com/api/v2/networks/solana';
const RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';

function num(x) { const n = Number(x); return isFinite(n) ? n : 0; }

// Converte um par do DexScreener no formato interno.
function toSnapshot(p) {
  const tx = p.txns || {}, v = p.volume || {}, c = p.priceChange || {};
  return {
    mint: p.baseToken.address,
    symbol: (p.baseToken.symbol || '?').trim(),
    name: (p.baseToken.name || '').trim(),
    pair: p.pairAddress,
    dex: p.dexId,
    price: num(p.priceUsd),
    liquidity: num(p.liquidity && p.liquidity.usd),
    marketCap: num(p.marketCap || p.fdv),
    change: { m5: num(c.m5), h1: num(c.h1), h6: num(c.h6), h24: num(c.h24) },
    volume: { m5: num(v.m5), h1: num(v.h1), h6: num(v.h6), h24: num(v.h24) },
    buys24: num(tx.h24 && tx.h24.buys),
    sells24: num(tx.h24 && tx.h24.sells),
    createdAt: p.pairCreatedAt || 0,
    icon: (p.info && p.info.imageUrl) || null,
    pumpfun: /pump$/.test(p.baseToken.address),
    t: Date.now()
  };
}

// Para cada mint, escolhe o par com mais liquidez.
function bestPairs(pairs) {
  const best = {};
  (pairs || []).forEach(function (p) {
    if (p.chainId !== 'solana' || !p.baseToken) return;
    const k = p.baseToken.address, liq = num(p.liquidity && p.liquidity.usd);
    if (!best[k] || liq > num(best[k].liquidity && best[k].liquidity.usd)) best[k] = p;
  });
  return Object.keys(best).map(function (k) { return toSnapshot(best[k]); });
}

exports.snapshots = async function (mints) {
  const out = {};
  for (let i = 0; i < mints.length; i += 30) {
    const chunk = mints.slice(i, i + 30);
    const pairs = await http.getJson(DEX + '/tokens/v1/solana/' + chunk.join(','));
    bestPairs(pairs).forEach(function (s) { out[s.mint] = s; });
  }
  return out;
};

exports.search = async function (q) {
  const r = await http.getJson(DEX + '/latest/dex/search?q=' + encodeURIComponent(q));
  return bestPairs(r.pairs).sort(function (a, b) { return b.liquidity - a.liquidity; }).slice(0, 12);
};

let trendCache = { t: 0, list: [] };
exports.trending = async function () {
  if (Date.now() - trendCache.t < 60000) return trendCache.list;
  const boosts = await http.getJson(DEX + '/token-boosts/top/v1');
  const mints = [];
  boosts.forEach(function (b) { if (b.chainId === 'solana' && mints.indexOf(b.tokenAddress) < 0) mints.push(b.tokenAddress); });
  const snaps = await exports.snapshots(mints.slice(0, 30));
  const list = mints.map(function (m) { return snaps[m]; }).filter(Boolean).slice(0, 24);
  trendCache = { t: Date.now(), list: list };
  return list;
};

// res: 1m, 5m, 15m, 1h, 4h, D
const RES = { '1m': ['minute', 1], '5m': ['minute', 5], '15m': ['minute', 15], '1h': ['hour', 1], '4h': ['hour', 4], 'D': ['day', 1] };
exports.candles = async function (pair, res) {
  const r = RES[res] || RES['15m'];
  const j = await http.getJson(GECKO + '/pools/' + pair + '/ohlcv/' + r[0] + '?aggregate=' + r[1] + '&limit=300');
  const list = (j.data && j.data.attributes && j.data.attributes.ohlcv_list) || [];
  return list.map(function (c) { return { time: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] }; })
    .sort(function (a, b) { return a.time - b.time; });
};

function rpc(method, params) {
  return http.postJson(RPC, { jsonrpc: '2.0', id: 1, method: method, params: params }).then(function (r) {
    if (r.error) throw new Error(r.error.message || 'erro RPC');
    return r.result;
  });
}

// Autoridades do mint e concentracao das maiores contas (melhor esforco; a RPC publica tem limite).
// Leituras usadas pelas ordens reais.
const decimalsCache = {};
exports.decimals = async function (mint) {
  if (decimalsCache[mint] !== undefined) return decimalsCache[mint];
  const acc = await rpc('getAccountInfo', [mint, { encoding: 'jsonParsed' }]);
  const info = acc && acc.value && acc.value.data && acc.value.data.parsed && acc.value.data.parsed.info;
  if (!info || typeof info.decimals !== 'number') throw new Error('Nao consegui ler os decimais do token');
  decimalsCache[mint] = info.decimals;
  return info.decimals;
};
exports.solBalance = async function (addr) { const r = await rpc('getBalance', [addr]); return num(r.value) / 1e9; };
// Saldo de um token na carteira: { ui, raw } (soma de todas as contas daquele token).
exports.tokenBalance = async function (owner, mint) {
  const r = await rpc('getTokenAccountsByOwner', [owner, { mint: mint }, { encoding: 'jsonParsed' }]);
  let ui = 0, raw = BigInt(0);
  (r.value || []).forEach(function (a) {
    const ta = a.account.data.parsed.info.tokenAmount;
    ui += num(ta.uiAmount); raw += BigInt(ta.amount || '0');
  });
  return { ui: ui, raw: raw.toString() };
};
// Estado de uma transacao enviada: null (ainda nao vista) ou { err, confirmationStatus }.
exports.sigStatus = async function (sig) {
  const r = await rpc('getSignatureStatuses', [[sig], { searchTransactionHistory: true }]);
  return (r.value && r.value[0]) || null;
};

// Saldo publico de uma carteira (somente leitura): SOL + tokens, com preco e valor em USD.
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];
const walletCache = {};
exports.wallet = async function (addr) {
  const hit = walletCache[addr];
  if (hit && Date.now() - hit.t < 15000) return hit.v;
  const bal = await rpc('getBalance', [addr]);
  const sol = num(bal.value) / 1e9;
  const found = {};
  let partial = false;
  for (let i = 0; i < TOKEN_PROGRAMS.length; i++) {
    try {
      const r = await rpc('getTokenAccountsByOwner', [addr, { programId: TOKEN_PROGRAMS[i] }, { encoding: 'jsonParsed' }]);
      (r.value || []).forEach(function (a) {
        const info = a.account && a.account.data && a.account.data.parsed && a.account.data.parsed.info;
        const amt = info && num(info.tokenAmount && info.tokenAmount.uiAmount);
        if (info && amt > 0) found[info.mint] = (found[info.mint] || 0) + amt;
      });
    } catch (e) { partial = true; } // a RPC publica limita chamadas: mostra o que deu para ler
  }
  const mints = Object.keys(found);
  const shown = mints.slice(0, 29);
  let snaps = {};
  try { snaps = await exports.snapshots([SOL_MINT].concat(shown)); } catch (e) { partial = true; }
  const solUsd = snaps[SOL_MINT] ? snaps[SOL_MINT].price : 0;
  const tokens = shown.map(function (m) {
    const s = snaps[m];
    return { mint: m, symbol: s ? s.symbol : null, icon: s ? s.icon : null, amount: found[m], price: s ? s.price : 0, value: s ? s.price * found[m] : 0 };
  }).sort(function (a, b) { return b.value - a.value; });
  const v = { address: addr, sol: sol, solUsd: solUsd, solValue: sol * solUsd, tokens: tokens, hidden: Math.max(0, mints.length - shown.length), partial: partial,
    totalUsd: sol * solUsd + tokens.reduce(function (s, t) { return s + t.value; }, 0) };
  walletCache[addr] = { t: Date.now(), v: v };
  return v;
};

const chainCache = {};
exports.onchain = async function (mint) {
  const hit = chainCache[mint];
  if (hit && Date.now() - hit.t < 10 * 60000) return hit.v;
  const out = { mintAuthority: null, freezeAuthority: null, top10Pct: null, ok: false };
  try {
    const acc = await rpc('getAccountInfo', [mint, { encoding: 'jsonParsed' }]);
    const info = acc && acc.value && acc.value.data && acc.value.data.parsed && acc.value.data.parsed.info;
    if (info) { out.mintAuthority = info.mintAuthority || null; out.freezeAuthority = info.freezeAuthority || null; out.ok = true; }
    // Em sequencia: a RPC publica limita chamadas simultaneas. Se falhar aqui, as autoridades acima continuam validas.
    const sup = await rpc('getTokenSupply', [mint]);
    const big = await rpc('getTokenLargestAccounts', [mint]);
    const total = num(sup.value.uiAmount);
    if (total > 0) {
      const top = big.value.slice(0, 10).reduce(function (s, a) { return s + num(a.uiAmount); }, 0);
      out.top10Pct = top / total * 100;
    }
  } catch (e) { out.error = e.message; }
  // So guarda no cache quando completo; resposta parcial expira em 1 min para tentar de novo.
  chainCache[mint] = { t: out.top10Pct !== null ? Date.now() : Date.now() - 9 * 60000, v: out };
  return out;
};
