'use strict';
// App UI: plain JS, no build. Pages: home, token, strategies, strategy, wallet, how it works.
const BRAND = 'Cardume';
const $ = function (s, el) { return (el || document).querySelector(s); };
const view = $('#view');
let timers = [];      // intervals of the current page (cleared on every navigation)
let chartObj = null;
document.title = BRAND + ' - AI strategy bots for Solana';

const SPARK = '<svg class="spark" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 2l2 6 6 2-6 2-2 6-2-6-6-2 6-2z" fill="currentColor"/><path d="M19 13l1 3 3 1-3 1-1 3-1-3-3-1 3-1z" fill="currentColor" opacity=".7"/></svg>';
const EXAMPLES = [
  'Buy $50 every hour under $0.40. If it drops 25% from the peak, sell everything.',
  'Buy the dip: $20 whenever it falls 20% in a day. Take profit at +50% and +100%.',
  'Sell 25% whenever volume spikes 5x, at most once an hour.'
];

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function price(n) { n = Number(n); if (!isFinite(n) || n === 0) return '$0'; return '$' + (n >= 1 ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : n.toPrecision(3)); }
function usd(n) { n = Number(n) || 0; const a = Math.abs(n); const s = a >= 1e9 ? (a / 1e9).toFixed(2) + 'B' : a >= 1e6 ? (a / 1e6).toFixed(2) + 'M' : a >= 1e3 ? (a / 1e3).toFixed(1) + 'K' : a.toFixed(2); return (n < 0 ? '-$' : '$') + s; }
function pct(n) { n = Number(n) || 0; return '<span class="' + (n >= 0 ? 'up' : 'down') + '">' + (n >= 0 ? '+' : '') + n.toFixed(2) + '%</span>'; }
function ago(t) { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? s + 's' : s < 3600 ? Math.round(s / 60) + 'min' : s < 86400 ? Math.round(s / 3600) + 'h' : Math.round(s / 86400) + 'd'; }
function hhmm(t) { return new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' }); }
function short(m) { return m.slice(0, 4) + '...' + m.slice(-4); }
function store(k, v) { try { if (v === undefined) return sessionStorage.getItem(k); if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) { /* storage blocked */ } return null; }

async function api(path, opts) {
  const r = await fetch(path, opts);
  let j = null; try { j = await r.json(); } catch (e) { /* no body */ }
  if (!r.ok) throw new Error((j && j.error) || 'Error ' + r.status);
  return j;
}
function post(path, body) { return api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); }
function toast(msg, err) { const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(function () { t.hidden = true; }, 4500); }
function every(fn, ms) { timers.push(setInterval(fn, ms)); }

function tokRow(t, on) {
  return '<a class="tok' + (on ? ' on' : '') + '" href="#/t/' + esc(t.mint) + '">' +
    (t.icon ? '<img src="' + esc(t.icon) + '" alt="" loading="lazy">' : '<div class="ph"></div>') +
    '<div class="n"><b>' + esc(t.symbol) + '</b><span>' + price(t.price) + '</span></div>' +
    '<div class="r"><div>' + usd(t.marketCap) + ' <span class="muted">MC</span></div>' + pct(t.change.h24) + '</div></a>';
}

/* ---------- search ---------- */
const sIn = $('#searchInput'), sOut = $('#searchResults');
let sTimer = null;
sIn.addEventListener('input', function () {
  clearTimeout(sTimer);
  const q = sIn.value.trim();
  if (q.length < 2) { sOut.hidden = true; return; }
  sTimer = setTimeout(async function () {
    try {
      const r = await api('/api/search?q=' + encodeURIComponent(q));
      sOut.innerHTML = r.length ? r.map(function (t) { return '<a href="#/t/' + esc(t.mint) + '"><span><b>' + esc(t.symbol) + '</b> <span class="muted">' + esc(t.name) + '</span></span><span>' + price(t.price) + '</span></a>'; }).join('') : '<a>No results</a>';
      sOut.hidden = false;
    } catch (e) { sOut.hidden = true; }
  }, 300);
});
$('#searchForm').addEventListener('submit', function (e) { e.preventDefault(); const a = sOut.querySelector('a[href]'); if (a) location.hash = a.getAttribute('href'); });
document.addEventListener('click', function (e) { if (!e.target.closest('.search')) sOut.hidden = true; else if (e.target.closest('.results a')) { sOut.hidden = true; sIn.value = ''; } });

/* ---------- wallet (connect = read only; we never ask for a signature here) ---------- */
const WALLETS = [
  { id: 'phantom', name: 'Phantom', get: function () { const p = window.phantom && window.phantom.solana; return p && p.isPhantom ? p : null; }, url: 'https://phantom.com/download' },
  { id: 'solflare', name: 'Solflare', get: function () { return window.solflare && window.solflare.isSolflare ? window.solflare : null; }, url: 'https://www.solflare.com/download/' },
  { id: 'backpack', name: 'Backpack', get: function () { return window.backpack && window.backpack.isBackpack ? window.backpack : null; }, url: 'https://backpack.app/download' }
];
const W = { id: null, provider: null, address: null };
function walletLabel() {
  const b = $('#walletBtn');
  b.textContent = W.address ? short(W.address) : 'Connect wallet';
  b.classList.toggle('on', !!W.address);
}
function setWallet(id, provider, address) {
  W.id = id; W.provider = provider; W.address = address;
  try { if (id) localStorage.setItem('cardume_wallet', id); else localStorage.removeItem('cardume_wallet'); } catch (e) { /* storage blocked */ }
  if (provider && provider.on && !provider.__cardume) {
    provider.__cardume = true;
    provider.on('disconnect', function () { setWallet(null, null, null); if (location.hash === '#/wallet') route(); });
    provider.on('accountChanged', function (pk) { if (pk) { W.address = pk.toString(); walletLabel(); if (location.hash === '#/wallet') route(); } else { setWallet(null, null, null); if (location.hash === '#/wallet') route(); } });
  }
  walletLabel();
}
async function connectWallet(id) {
  const w = WALLETS.filter(function (x) { return x.id === id; })[0], p = w && w.get();
  if (!p) throw new Error(w.name + ' is not installed in this browser');
  const r = await p.connect(); // opens the wallet window; the user approves the connection (nothing is signed)
  const pk = (r && r.publicKey) || p.publicKey;
  if (!pk) throw new Error('The wallet did not return an address');
  setWallet(id, p, pk.toString());
}
async function disconnectWallet() { try { if (W.provider && W.provider.disconnect) await W.provider.disconnect(); } catch (e) { /* already disconnected */ } setWallet(null, null, null); }
// Silently reconnects if the user already approved this site before (opens no window).
async function autoConnect() {
  let id = null; try { id = localStorage.getItem('cardume_wallet'); } catch (e) { /* no storage */ }
  const w = WALLETS.filter(function (x) { return x.id === id; })[0], p = w && w.get();
  if (!p) return;
  try { const r = await p.connect({ onlyIfTrusted: true }); const pk = (r && r.publicKey) || p.publicKey; if (pk) setWallet(id, p, pk.toString()); } catch (e) { /* not authorized yet */ }
}
$('#walletBtn').addEventListener('click', function () { location.hash = '#/wallet'; });

async function pageWallet() {
  const installed = WALLETS.filter(function (w) { return w.get(); });
  if (!W.address) {
    view.innerHTML = '<div class="wrap" style="max-width:560px"><div class="sec-title">Wallet</div><div class="card"><b>Connect your wallet</b>' +
      '<p class="muted">Connecting only shows your address and balance. ' + BRAND + ' <b>never asks you to sign</b> when you connect, cannot move your funds and never sees your private key. You can disconnect at any time.</p>' +
      '<div class="wlist">' + WALLETS.map(function (w) {
        const ok = !!w.get();
        return ok ? '<button class="wopt" data-w="' + w.id + '"><b>' + w.name + '</b><span class="up">Connect</span></button>'
          : '<a class="wopt off" href="' + w.url + '" target="_blank" rel="noopener"><b>' + w.name + '</b><span class="muted">not installed · download</span></a>';
      }).join('') + '</div>' + (installed.length ? '' : '<div class="note">No Solana wallet detected. Install a browser extension (for example Phantom), refresh the page and come back.</div>') + '</div></div>';
    view.querySelectorAll('[data-w]').forEach(function (b) { b.onclick = async function () {
      b.disabled = true;
      try { await connectWallet(b.dataset.w); toast('Wallet connected'); route(); } catch (e) { toast(e.code === 4001 || /reject|denied|User/i.test(e.message) ? 'Connection rejected in the wallet' : e.message, true); b.disabled = false; }
    }; });
    return;
  }
  view.innerHTML = '<div class="wrap" style="max-width:760px"><div class="row" style="margin:20px 0 6px"><div><h2 style="margin:0">Wallet connected</h2><div class="muted">' + esc(WALLETS.filter(function (w) { return w.id === W.id; }).map(function (w) { return w.name; })[0] || '') + '</div></div>' +
    '<div><button class="btn" id="wr">Refresh</button> <button class="btn danger" id="wd">Disconnect</button></div></div>' +
    '<div class="card"><span class="muted">Address</span><div class="mono addr">' + esc(W.address) + '</div></div><div id="wb" class="empty">Reading balance from the network...</div></div>';
  $('#wd').onclick = async function () { await disconnectWallet(); toast('Wallet disconnected'); route(); };
  async function load() {
    try {
      const d = await api('/api/wallet/' + W.address);
      $('#wb').className = '';
      $('#wb').innerHTML = '<div class="stats" style="grid-template-columns:repeat(3,1fr)"><div class="stat"><span>Estimated total</span><b>' + usd(d.totalUsd) + '</b></div><div class="stat"><span>SOL</span><b>' + d.sol.toFixed(4) + '</b></div><div class="stat"><span>SOL value</span><b>' + usd(d.solValue) + '</b></div></div>' +
        (d.partial ? '<div class="note" style="margin-bottom:8px">Partial reading: the public network limited some requests. Click Refresh in a moment.</div>' : '') +
        '<div class="sec-title">Tokens</div>' + (d.tokens.length ? '<div class="card" style="padding:0">' + d.tokens.map(function (t) {
          return '<a class="tok" href="#/t/' + esc(t.mint) + '">' + (t.icon ? '<img src="' + esc(t.icon) + '" alt="" loading="lazy">' : '<div class="ph"></div>') + '<div class="n"><b>' + esc(t.symbol || short(t.mint)) + '</b><span>' + t.amount.toLocaleString('en-US', { maximumFractionDigits: 4 }) + '</span></div><div class="r">' + (t.value ? usd(t.value) : '<span class="muted">no price</span>') + '</div></a>'; }).join('') + '</div>' : '<div class="empty">No tokens in this wallet.</div>') +
        (d.hidden ? '<div class="note">And ' + d.hidden + ' more token(s) not shown.</div>' : '');
    } catch (e) { $('#wb').className = 'empty'; $('#wb').textContent = 'Could not read the balance: ' + e.message; }
  }
  $('#wr').onclick = load; load();
}

/* ---------- router ---------- */
function route() {
  timers.forEach(clearInterval); timers = [];
  if (chartObj) { chartObj.remove(); chartObj = null; }
  const h = location.hash.replace(/^#/, '') || '/';
  document.querySelectorAll('[data-nav]').forEach(function (a) {
    const n = a.dataset.nav;
    a.classList.toggle('on', (n === 'home' && (h === '/' || h.indexOf('/t/') === 0)) || (n === 'strategies' && (h === '/strategies' || h.indexOf('/s/') === 0)) || (n === 'how' && h === '/how-it-works'));
  });
  window.scrollTo(0, 0);
  let m;
  if ((m = h.match(/^\/t\/(\w+)$/))) return pageToken(m[1]);
  if ((m = h.match(/^\/s\/(\w+)$/))) return pageStrategy(m[1]);
  if (h === '/strategies') return pageStrategies();
  if (h === '/wallet') return pageWallet();
  if (h === '/how-it-works') return pageHow();
  return pageHome();
}
window.addEventListener('hashchange', route);

/* ---------- home ---------- */
async function pageHome() {
  store('pendingPhrase', null);
  view.innerHTML = '<div class="hero"><span class="aibadge">' + SPARK + ' Solana · AI strategy bots</span><h1>Describe it.<br>AI builds the rules.</h1>' +
    '<p>Write your trading strategy in plain English. <b>AI turns it into rules you can read</b>, you test them on live prices, and trade from your own wallet, approving every order.</p>' +
    '<form id="aif" class="aibox">' + SPARK + '<input id="aiin" placeholder="Buy $50 every hour under $0.40. If it drops 25% from the peak, sell everything." autocomplete="off"><button class="btn primary">Build with AI</button></form>' +
    '<div class="chips" id="chips">' + EXAMPLES.map(function (x, i) { return '<button type="button" class="chip" data-i="' + i + '">' + esc(x) + '</button>'; }).join('') + '</div>' +
    '<div class="trust"><span>Non-custodial</span><span>Routed by Jupiter</span><span>Rules written by AI</span><span>You approve every order</span></div></div>' +
    '<div class="wrap"><div id="pickhint" class="pickhint" hidden></div>' +
    '<div class="sec-title">Or open a token directly</div>' +
    '<form id="hf" class="bigsearch"><input id="hi" placeholder="Token address (mint) or name" autocomplete="off"><button class="btn">Open</button></form>' +
    '<div class="steps">' +
    '<div class="step"><b>01 · Describe</b><br><span class="muted">Say what you want in plain English, or pick a template.</span></div>' +
    '<div class="step"><b>02 · Review</b><br><span class="muted">Read the rules as when / if / then and set your limits.</span></div>' +
    '<div class="step"><b>03 · Test</b><br><span class="muted">Paper trade on live prices and watch every decision.</span></div>' +
    '<div class="step"><b>04 · Go live</b><br><span class="muted">Sign each order in your own wallet. <a class="up" href="#/how-it-works">How it works</a></span></div></div>' +
    '<div class="sec-title" id="trendtitle">Trending now</div><div id="trend" class="card" style="padding:0"><div class="empty">Loading...</div></div></div>';
  $('#chips').addEventListener('click', function (e) { const b = e.target.closest('.chip'); if (!b) return; $('#aiin').value = EXAMPLES[Number(b.dataset.i)]; $('#aiin').focus(); });
  $('#aif').addEventListener('submit', function (e) {
    e.preventDefault();
    const text = $('#aiin').value.trim();
    if (text.length < 8) return toast('Describe your strategy in a few words', true);
    const mint = text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
    store('pendingPhrase', text);
    if (mint) { location.hash = '#/t/' + mint[0]; return; }
    const hint = $('#pickhint');
    hint.hidden = false;
    hint.innerHTML = SPARK + ' <b>Got it.</b> Now pick the token to run it on, and AI will build the rules for it: <span class="muted">' + esc(text.length > 90 ? text.slice(0, 90) + '...' : text) + '</span>';
    hint.scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('#trend').classList.add('attn'); $('#hi').focus();
  });
  $('#hf').addEventListener('submit', async function (e) {
    e.preventDefault();
    const q = $('#hi').value.trim(); if (!q) return;
    try { const r = await api('/api/search?q=' + encodeURIComponent(q)); if (r[0]) location.hash = '#/t/' + r[0].mint; else toast('No token found', true); } catch (er) { toast(er.message, true); }
  });
  try { const t = await api('/api/trending'); $('#trend').innerHTML = t.length ? t.map(function (x) { return tokRow(x); }).join('') : '<div class="empty">No data right now</div>'; }
  catch (e) { $('#trend').innerHTML = '<div class="empty">Could not load: ' + esc(e.message) + '</div>'; }
}

/* ---------- token ---------- */
async function pageToken(mint) {
  view.innerHTML = '<div class="tokpage"><div class="col left" id="tl"></div><div class="col" id="tc"><div class="empty" style="margin:20px">Loading token...</div></div><div class="col right" id="tr"></div></div>';
  api('/api/trending').then(function (t) { $('#tl').innerHTML = t.map(function (x) { return tokRow(x, x.mint === mint); }).join(''); }).catch(function () {});
  let d;
  try { d = await api('/api/token/' + mint); } catch (e) { $('#tc').innerHTML = '<div class="empty" style="margin:20px">' + esc(e.message) + '</div>'; return; }
  const s = d.snap, r = d.risk;
  const rc = r.label === 'high' ? 'high' : r.label === 'moderate' ? 'mid' : 'low';
  $('#tc').innerHTML =
    '<div class="thead"><div class="name">' + (s.icon ? '<img class="ph" src="' + esc(s.icon) + '" alt="">' : '<div class="ph"></div>') + '<div><b>' + esc(s.symbol) + '</b><br><span class="muted">' + esc(s.name) + '</span></div></div>' +
    '<div class="stat"><span>Price</span><b id="pp">' + price(s.price) + '</b></div><div class="stat"><span>24h</span><b>' + pct(s.change.h24) + '</b></div>' +
    '<div class="stat"><span>Market cap</span><b>' + usd(s.marketCap) + '</b></div><div class="stat"><span>Liquidity</span><b>' + usd(s.liquidity) + '</b></div>' +
    '<div class="stat"><span>Volume 24h</span><b>' + usd(s.volume.h24) + '</b></div><div class="stat"><span>Risk</span><b><span class="badge ' + rc + '">' + r.score + ' · ' + esc(r.label) + '</span></b></div></div>' +
    '<div class="tfs" id="tfs">' + ['1m', '5m', '15m', '1h', '4h', 'D'].map(function (x) { return '<button data-r="' + x + '"' + (x === '15m' ? ' class="on"' : '') + '>' + x + '</button>'; }).join('') + '</div>' +
    '<div id="chart"></div>' +
    '<div class="tabs" id="tabs"><button data-t="risk" class="on">Risk</button><button data-t="mine">My strategies</button></div><div class="tabbody" id="tb"></div>';

  drawChart(s.pair, '15m');
  $('#tfs').addEventListener('click', function (e) { const b = e.target.closest('button'); if (!b) return; document.querySelectorAll('#tfs button').forEach(function (x) { x.classList.toggle('on', x === b); }); drawChart(s.pair, b.dataset.r); });

  const chain = d.chain;
  function tabRisk() {
    $('#tb').innerHTML = '<div class="card"><b>Score ' + r.score + '/100 (' + esc(r.label) + ')</b><div class="note">Automatic estimate from public data. Not financial advice.</div>' +
      (r.reasons.length ? r.reasons.map(function (x) { return '<div class="kv"><span>' + esc(x.text) + '</span><b>+' + x.points + '</b></div>'; }).join('') : '<div class="kv"><span>No warning signs in the available data</span></div>') + '</div>' +
      '<div class="card"><b>Token security</b>' +
      (chain.ok ? '<div class="kv"><span>Mint authority</span><b>' + (chain.mintAuthority ? '<span class="down">active</span>' : '<span class="up">revoked</span>') + '</b></div>' +
        '<div class="kv"><span>Freeze authority</span><b>' + (chain.freezeAuthority ? '<span class="down">active</span>' : '<span class="up">revoked</span>') + '</b></div>' +
        '<div class="kv"><span>Top 10 accounts</span><b>' + (chain.top10Pct == null ? 'unavailable' : chain.top10Pct.toFixed(1) + '%') + '</b></div><div class="note">Top 10 may include liquidity pool accounts.</div>'
        : '<div class="note">Could not read the network right now (' + esc(chain.error || 'RPC unavailable') + ').</div>') + '</div>';
  }
  async function tabMine() {
    $('#tb').innerHTML = '<div class="empty">Loading...</div>';
    const all = await api('/api/strategies'); const mine = all.filter(function (x) { return x.mint === mint; });
    $('#tb').innerHTML = mine.length ? '<div class="cards">' + mine.map(stratCard).join('') + '</div>' : '<div class="empty">You have no strategies for this token yet.</div>';
  }
  tabRisk();
  $('#tabs').addEventListener('click', function (e) { const b = e.target.closest('button'); if (!b) return; document.querySelectorAll('#tabs button').forEach(function (x) { x.classList.toggle('on', x === b); }); b.dataset.t === 'risk' ? tabRisk() : tabMine().catch(function (er) { toast(er.message, true); }); });

  $('#tr').innerHTML =
    '<div class="card" id="builder"><div class="empty">Loading...</div></div>' +
    '<div class="card"><b>About</b>' +
    [['5m change', pct(s.change.m5)], ['1h', pct(s.change.h1)], ['6h', pct(s.change.h6)], ['24h', pct(s.change.h24)], ['Buys / sells 24h', s.buys24 + ' / ' + s.sells24], ['Volume 1h', usd(s.volume.h1)], ['Market', esc(s.dex) + (s.pumpfun ? ' · pump.fun' : '')], ['Created', s.createdAt ? ago(s.createdAt) + ' ago' : '-'], ['Contract', '<span class="mono">' + short(s.mint) + '</span>']]
      .map(function (k) { return '<div class="kv"><span>' + k[0] + '</span><b>' + k[1] + '</b></div>'; }).join('') + '</div>';
  buildPanel(s);
  every(async function () { try { const x = await api('/api/token/' + mint); $('#pp').innerHTML = price(x.snap.price); } catch (e) { /* try again next time */ } }, 20000);
}

async function drawChart(pair, res) {
  const el = $('#chart'); if (!el) return;
  if (!window.LightweightCharts) { el.innerHTML = '<div class="empty">Chart library unavailable</div>'; return; }
  if (chartObj) { chartObj.remove(); chartObj = null; }
  el.innerHTML = '';
  chartObj = LightweightCharts.createChart(el, { height: 400, layout: { background: { color: '#07090c' }, textColor: '#8a94a3' }, grid: { vertLines: { color: '#10151c' }, horzLines: { color: '#10151c' } }, timeScale: { timeVisible: true, borderColor: '#1a2029' }, rightPriceScale: { borderColor: '#1a2029' } });
  const series = chartObj.addCandlestickSeries({ upColor: '#22c55e', downColor: '#ef4444', borderVisible: false, wickUpColor: '#22c55e', wickDownColor: '#ef4444', priceFormat: { type: 'price', precision: 8, minMove: 0.00000001 } });
  try { const c = await api('/api/bars?pair=' + pair + '&res=' + res); series.setData(c.map(function (x) { return { time: x.time, open: x.open, high: x.high, low: x.low, close: x.close }; })); chartObj.timeScale().fitContent(); }
  catch (e) { el.innerHTML = '<div class="empty">Candles unavailable right now: ' + esc(e.message) + '</div>'; }
}

/* strategy builder: AI first, templates second */
async function buildPanel(s) {
  const box = $('#builder');
  let presets, sel = null, draft = null;
  let lim = { maxOrderUsd: null, maxBudgetUsd: null };
  try { presets = await api('/api/presets?price=' + s.price); const health = await api('/api/health'); if (health.limits) lim = health.limits; } catch (e) { box.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; return; }

  function renderDraft() {
    const p = draft.params;
    const caps = (lim.maxOrderUsd ? ' Max ' + usd(lim.maxOrderUsd) + ' per order.' : '') + (lim.maxBudgetUsd ? ' Max ' + usd(lim.maxBudgetUsd) + ' budget.' : '');
    $('#draft').innerHTML = '<div class="sec-title" style="margin-top:14px">Rules · ' + esc(draft.name) + '</div>' +
      (draft.about ? '<div class="srcnote">Template: ' + esc(draft.about) + '</div>' : '') +
      (draft.source ? '<div class="srcnote">' + (draft.source === 'ai' ? SPARK + ' Generated by AI' : 'Built from your description') + '. Review the rules before you start.</div>' : '') +
      (draft.assumptions && draft.assumptions.length ? '<div class="card"><b>Assumed for you:</b><ul style="margin:6px 0 0;padding-left:18px">' + draft.assumptions.map(function (a) { return '<li>' + esc(a) + '</li>'; }).join('') + '</ul><div class="note">Your description did not include these values. Check that they make sense.</div></div>' : '') +
      draft.rules.map(ruleHtml).join('') +
      (draft.fields && draft.fields.length ? draft.fields.map(function (f) { return '<label class="field"><span>' + esc(f.label) + '</span><input data-f="' + f.key + '" value="' + esc(draft.values[f.key]) + '"></label>'; }).join('') : '') +
      '<div class="grid3"><label class="field"><span>Budget $</span><input id="pb" value="' + p.budget + '"></label><label class="field"><span>Max per order $</span><input id="pm" value="' + p.maxPerTrade + '"></label><label class="field"><span>Max loss $</span><input id="pl" value="' + p.maxLoss + '"></label></div>' +
      '<div class="note">Rules can never go beyond these limits. Paper trading uses a simulated 0.5% fee per order.</div>' +
      (W.address ? '<label class="livebox"><input type="checkbox" id="live"><span><b>Trade with real money</b><br><span class="muted">Uses wallet ' + short(W.address) + '. Every order waits for your review and your signature in the wallet.' + caps + '</span></span></label>'
        : '<div class="note" style="margin-top:8px">Want to trade for real? Connect your wallet (button at the top).</div>') +
      '<button class="btn primary" id="go" style="width:100%;margin-top:10px">Start paper trading</button>';
    $('#go').onclick = start;
    const lv = $('#live');
    if (lv) lv.onchange = function () {
      const go = $('#go');
      if (lv.checked) {
        if (lim.maxBudgetUsd) $('#pb').value = Math.min(Number($('#pb').value) || lim.maxBudgetUsd, lim.maxBudgetUsd);
        if (lim.maxOrderUsd) $('#pm').value = Math.min(Number($('#pm').value) || lim.maxOrderUsd, lim.maxOrderUsd);
        if (!(Number($('#pl').value) > 0)) $('#pl').value = Math.max(0.5, Number((Number($('#pb').value) * 0.2).toFixed(2)));
      }
      go.textContent = lv.checked ? 'Start live (you approve every order)' : 'Start paper trading';
      go.classList.toggle('real', lv.checked);
    };
    document.querySelectorAll('[data-f]').forEach(function (i) { i.onchange = async function () {
      const v = Number(i.value); if (!(v > 0)) return;
      const q = '/api/presets?price=' + s.price + '&' + i.dataset.f + '=' + v;
      const fresh = (await api(q)).filter(function (x) { return x.id === sel; })[0];
      draft.rules = fresh.rules; draft.values[i.dataset.f] = v; renderDraft();
    }; });
  }
  async function start() {
    const live = !!($('#live') && $('#live').checked);
    if (live && !confirm('You are about to trade with REAL MONEY from wallet ' + short(W.address) + '.\n\nEvery order only goes out after you review it and sign in your wallet, and you can decline it. Memecoins can lose all of their value.\n\nContinue?')) return;
    const btn = $('#go'); btn.disabled = true;
    try {
      const body = { mint: s.mint, name: draft.name + ' - ' + s.symbol, rules: draft.rules.map(function (r) { const c = Object.assign({}, r); delete c.text; return c; }), params: { budget: Number($('#pb').value), maxPerTrade: Number($('#pm').value), maxLoss: Number($('#pl').value), startWithPosition: draft.params.startWithPosition || 0 } };
      if (live) { body.live = true; body.wallet = W.address; }
      const out = await post('/api/strategies', body);
      toast(live ? 'Live strategy started. You approve every order.' : 'Paper strategy started'); location.hash = '#/s/' + out.id;
    } catch (e) { toast(e.message, true); btn.disabled = false; }
  }

  box.innerHTML =
    '<div class="aihead">' + SPARK + '<div><b>Describe it. AI builds the rules.</b><div class="note">Write your strategy in plain English, or pick a template. You review the rules before anything runs.</div></div></div>' +
    '<div class="aichat">' +
      '<textarea id="phrase" class="aitext" placeholder="' + esc(EXAMPLES[0]) + '"></textarea>' +
      '<div class="aibar"><div class="tpls" id="tpls"><span class="tplabel">Templates</span>' +
        presets.map(function (p) { return '<button type="button" class="chip tpl" data-p="' + p.id + '" title="' + esc(p.about) + '">' + esc(p.name) + '</button>'; }).join('') + '</div>' +
        '<button class="btn primary aibtn" id="gen">' + SPARK + ' Generate</button></div>' +
    '</div>' +
    '<div id="draft"></div>';
  // Templates live inside the chat box as options; picking one shows only its rules below.
  box.querySelectorAll('.tpl').forEach(function (b) { b.onclick = function () {
    box.querySelectorAll('.tpl').forEach(function (x) { x.classList.toggle('on', x === b); });
    const p = presets.filter(function (x) { return x.id === b.dataset.p; })[0]; sel = p.id;
    draft = { name: p.name, rules: p.rules, params: p.params, fields: p.fields, values: p.values, source: null, about: p.about }; renderDraft();
    $('#draft').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }; });
  $('#gen').onclick = async function () {
    const text = $('#phrase').value.trim(); if (text.length < 8) return toast('Describe your strategy in a few more words', true);
    const b = $('#gen'); b.disabled = true; b.innerHTML = SPARK + ' Building your rules...';
    try {
      const out = await post('/api/compile', { mint: s.mint, text: text }); sel = null; box.querySelectorAll('.tpl').forEach(function (x) { x.classList.remove('on'); });
      draft = { name: out.name, rules: out.rules, params: { budget: 1000, maxPerTrade: 200, maxLoss: 400 }, fields: [], values: {}, assumptions: out.assumptions || [], source: out.mode === 'ai' ? 'ai' : 'text' };
      renderDraft(); $('#draft').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e) { toast(e.message, true); } finally { b.disabled = false; b.innerHTML = SPARK + ' Generate rules with AI'; }
  };
  // Coming from the home page with a description: generate right away.
  const pending = store('pendingPhrase');
  if (pending) { store('pendingPhrase', null); $('#phrase').value = pending; $('#gen').click(); }
}

function ruleHtml(r) {
  const st = r.state ? '<span class="state ' + esc(r.state.status) + '">' + esc(r.state.status) + (r.state.fired ? ' · ' + r.state.fired + 'x' : '') + '</span>' : (r.once ? '<span class="state">once</span>' : '');
  return '<div class="rule"><div class="head"><b>' + esc(r.name) + '</b>' + st + '</div>' +
    '<div class="line"><em>when</em><span>' + esc(r.text.when) + '</span></div>' +
    (r.text.if.length ? '<div class="line"><em>if</em><span>' + r.text.if.map(esc).join(' and ') + '</span></div>' : '') +
    '<div class="line"><em>then</em><span>' + r.text.then.map(esc).join(', ') + '</span></div></div>';
}

/* ---------- strategies ---------- */
function stratCard(s) {
  const m = s.summary, pend = s.live && openOrder(s);
  return '<a class="scard" href="#/s/' + s.id + '"><div class="row"><h3>' + esc(s.name) + '</h3><span class="state ' + (s.status === 'active' ? 'armed' : 'paused') + '">' + (s.status === 'active' ? 'active' : 'paused') + '</span></div>' +
    '<div class="muted">' + esc(s.symbol) + ' · ' + price(m.price) + ' · ' + (s.live ? 'LIVE' : 'paper') + (pend ? ' · <span style="color:var(--amber)">order waiting</span>' : '') + '</div>' +
    '<div class="row" style="margin-top:10px"><div><span class="muted">Result</span><br><b class="' + (m.pnl >= 0 ? 'up' : 'down') + '">' + (m.pnl >= 0 ? '+' : '') + usd(m.pnl) + ' (' + m.pnlPct.toFixed(2) + '%)</b></div>' +
    '<div><span class="muted">Orders</span><br><b>' + m.fills + '</b></div><div><span class="muted">Position</span><br><b>' + usd(m.position) + '</b></div></div></a>';
}
async function pageStrategies() {
  view.innerHTML = '<div class="wrap"><div class="sec-title">My strategies</div><div id="sl" class="empty">Loading...</div></div>';
  async function load() {
    try { const l = await api('/api/strategies'); $('#sl').className = ''; $('#sl').innerHTML = l.length ? '<div class="cards">' + l.map(stratCard).join('') + '</div>' : '<div class="empty">No strategies yet. <a href="#/" class="up">Describe one and let AI build it.</a></div>'; }
    catch (e) { $('#sl').innerHTML = esc(e.message); }
  }
  load(); every(load, 8000);
}

/* ---------- live orders: review and sign in the wallet ---------- */
const OPEN_ORDER = ['pending', 'prepared'];
function openOrder(s) { return (s.orders || []).filter(function (o) { return OPEN_ORDER.indexOf(o.status) >= 0; })[0]; }
function orderText(o) { return o.side === 'buy' ? 'Buy ' + usd(o.usd) : 'Sell ' + Math.round(o.pct) + '% of the position'; }
const ORDER_STATUS = { pending: 'waiting for approval', prepared: 'ready to sign', sent: 'sent, confirming', filled: 'confirmed', failed: 'failed on-chain', unconfirmed: 'not confirmed', declined: 'declined', expired: 'expired' };

function pendingCard(s) {
  const o = s.live && openOrder(s);
  if (!o) return '';
  const left = Math.max(0, Math.round((o.expiresAt - Date.now()) / 1000));
  return '<div class="card pendcard"><div class="row"><div><b>Order waiting for your approval</b><br><span>' + esc(orderText(o)) + ' · rule <span class="mono">' + esc(o.rule) + '</span> · price then ' + price(o.price) + '</span><br><span class="note">Expires in ' + left + 's. Nothing leaves your wallet without your signature.</span></div>' +
    '<div><button class="btn primary" id="rv">Review and sign</button> <button class="btn" id="dc">Decline</button></div></div></div>';
}

async function reviewOrder(s, o) {
  if (!W.address) return toast('Connect wallet ' + short(s.wallet) + ' at the top of the page', true);
  if (W.address !== s.wallet) return toast('You connected a different wallet. Connect ' + short(s.wallet) + ' to approve.', true);
  toast('Building the transaction and checking the price...');
  let prep;
  try { prep = await post('/api/strategies/' + s.id + '/orders/' + o.id + '/prepare', { wallet: W.address }); } catch (e) { return toast(e.message, true); }
  $('#toast').hidden = true;
  showOrderModal(s, o, prep);
}

function showOrderModal(s, o, prep) {
  const m = prep.summary, ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = '<div class="modal"><h3 style="margin:0 0 4px">' + (m.side === 'buy' ? 'Buy ' : 'Sell ') + esc(m.symbol) + '</h3><div class="note" style="margin-bottom:10px">Check the details before you sign. Your wallet shows the transaction one more time.</div>' +
    '<div class="kv"><span>You pay</span><b>' + esc(m.pay) + '</b></div><div class="kv"><span>You receive (estimated)</span><b>' + esc(m.receive) + '</b></div>' +
    '<div class="kv"><span>Difference from market price</span><b class="' + (m.deviationPct > 1.5 ? 'down' : '') + '">' + m.deviationPct.toFixed(2) + '%</b></div>' +
    '<div class="kv"><span>Price impact</span><b>' + (isFinite(m.impactPct) ? m.impactPct.toFixed(2) : '?') + '%</b></div><div class="kv"><span>Slippage tolerance</span><b>' + (m.slippageBps / 100) + '%</b></div>' + (m.widened ? '<div class="note" style="padding:6px 0">This token is moving fast, so the tolerance was widened to keep the order from failing. In the worst case you receive up to ' + (m.slippageBps / 100) + '% less than estimated.</div>' : '') +
    '<div class="kv"><span>Route</span><b>' + esc(m.route || 'Jupiter') + '</b></div>' + (m.rerouted ? '<div class="note" style="padding:6px 0">The first route failed its simulation, so an alternative route that simulates cleanly was used.</div>' : '') + '<div class="kv"><span>Time left to sign</span><b id="mt" class="up"></b></div>' +
    (m.warning ? '<div class="warnbox"><b>Heads up: price is ' + m.warning.deviationPct.toFixed(1) + '% worse than the market</b><br>This is common for tokens moving fast or with thin liquidity. You can continue, but you will ' + (m.side === 'buy' ? 'pay more' : 'receive less') + ' than the price shown on charts.' +
      '<label class="ack"><input type="checkbox" id="ack"> I understand and want to continue</label></div>' : '') +
    '<div class="row" style="margin-top:14px"><button class="btn" id="mc">Close</button><div><button class="btn danger" id="md">Decline order</button> <button class="btn primary" id="ms">Sign in wallet</button></div></div></div>';
  document.body.appendChild(ov);
  // Countdown: after the deadline the transaction is no longer valid, so the sign button is locked.
  const tick = setInterval(function () {
    const left = Math.max(0, Math.round((m.expiresAt - Date.now()) / 1000)), el = $('#mt', ov), sb = $('#ms', ov);
    if (!el) return clearInterval(tick);
    el.textContent = left > 0 ? left + 's' : 'expired';
    el.className = left > 15 ? 'up' : 'down';
    if (left <= 0 && sb && !sb.disabled) { sb.disabled = true; sb.textContent = 'Expired: close and review again'; }
  }, 1000);
  function close() { clearInterval(tick); ov.remove(); }
  // With a price warning, signing unlocks only after the person ticks the box.
  const ack = $('#ack', ov);
  if (ack) { $('#ms', ov).disabled = true; ack.onchange = function () { const sb = $('#ms', ov); if (sb && sb.textContent === 'Sign in wallet') sb.disabled = !ack.checked; }; }
  $('#mc', ov).onclick = close;
  $('#md', ov).onclick = async function () { try { await post('/api/strategies/' + s.id + '/orders/' + o.id + '/decline', { wallet: W.address }); toast('Order declined'); } catch (e) { toast(e.message, true); } close(); route(); };
  $('#ms', ov).onclick = async function () {
    const btn = $('#ms', ov); btn.disabled = true; btn.textContent = 'Waiting for the wallet...';
    try {
      if (!window.solanaWeb3) throw new Error('Transaction library did not load');
      // Renew the authorization before signing (opens the wallet only if needed) and check it is the strategy account.
      const c0 = await W.provider.connect();
      const pk0 = ((c0 && c0.publicKey) || W.provider.publicKey).toString();
      if (pk0 !== s.wallet) { setWallet(W.id, W.provider, pk0); throw new Error('Your wallet is on account ' + short(pk0) + ', but this strategy uses ' + short(s.wallet) + '. Switch accounts in the wallet and review the order again.'); }
      const tx = solanaWeb3.VersionedTransaction.deserialize(Uint8Array.from(atob(prep.tx), function (c) { return c.charCodeAt(0); }));
      const r = await W.provider.signAndSendTransaction(tx);
      const signature = typeof r === 'string' ? r : r.signature;
      await post('/api/strategies/' + s.id + '/orders/' + o.id + '/submitted', { wallet: W.address, signature: signature });
      toast('Order sent. Waiting for network confirmation...'); close(); route();
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Sign in wallet';
      toast(e.code === 4100 || /not been authorized|unauthorized/i.test(e.message) ? 'The wallet has not authorized this site for the account. Click "Connect wallet" at the top, approve the connection and review the order again.'
        : e.code === 4001 || /reject|denied|declin/i.test(e.message) ? 'You declined in the wallet. The order stays valid until it expires.' : e.message, true);
    }
  };
}

async function pageStrategy(id) {
  view.innerHTML = '<div class="wrap"><div id="sd" class="empty" style="margin-top:20px">Loading...</div></div>';
  async function load() {
    let s; try { s = await api('/api/strategies/' + id); } catch (e) { $('#sd').innerHTML = esc(e.message); return; }
    const m = s.summary, nextIn = s.lastTick ? Math.max(0, 15 - Math.round((Date.now() - s.lastTick) / 1000)) : null;
    const j = s.judge && s.judge.probs;
    $('#sd').className = '';
    $('#sd').innerHTML =
      '<div class="row" style="margin:20px 0 4px"><div><h2 style="margin:0">' + esc(s.name) + ' ' + (s.live ? '<span class="pill real">LIVE · MANUAL APPROVAL</span>' : '<span class="pill paper">PAPER</span>') + '</h2><a class="muted" href="#/t/' + esc(s.mint) + '">' + esc(s.symbol) + ' · ' + price(m.price) + '</a></div>' +
      '<div>' + (s.live && s.summary.qty > 0 && !openOrder(s) ? '<button class="btn" id="sa">Sell everything now</button> ' : '') + '<button class="btn" id="tg">' + (s.status === 'active' ? 'Pause' : 'Resume') + '</button> <button class="btn danger" id="rm">Delete</button></div></div>' +
      pendingCard(s) +
      '<div class="stats"><div class="stat"><span>Equity</span><b>' + usd(m.equity) + ' / ' + usd(s.params.budget) + '</b></div>' +
      '<div class="stat"><span>Result</span><b class="' + (m.pnl >= 0 ? 'up' : 'down') + '">' + (m.pnl >= 0 ? '+' : '') + usd(m.pnl) + ' (' + m.pnlPct.toFixed(2) + '%)</b></div>' +
      '<div class="stat"><span>Position</span><b>' + usd(m.position) + '</b></div><div class="stat"><span>Free balance</span><b>' + usd(m.cash) + '</b></div>' +
      '<div class="stat"><span>Orders</span><b>' + m.fills + (s.status === 'active' && nextIn !== null ? ' · next check ~' + nextIn + 's' : '') + '</b></div></div>' +
      '<div class="two"><div><div class="sec-title">Rules · in priority order</div>' + s.rules.slice().sort(function (a, b) { return a.priority - b.priority; }).map(ruleHtml).join('') +
      (j ? '<div class="card"><b>Latest judgment</b> <span class="note">(built-in check: liquidity + the wider market)</span>' + Object.keys(j).map(function (k) { return '<div style="margin-top:8px"><div class="row"><span class="mono">' + k + '</span><b>' + j[k].toFixed(2) + '</b></div><div class="bar"><i style="width:' + Math.round(j[k] * 100) + '%"></i></div></div>'; }).join('') + '</div>' : '') + '</div>' +
      '<div><div class="sec-title">Decisions</div><div class="log">' + (s.log.length ? s.log.map(function (l) { return '<div class="it"><span class="dot ' + esc(l.kind) + '"></span><div><span class="muted mono">' + hhmm(l.t) + (l.price ? ' @ ' + price(l.price) : '') + '</span> <b class="mono">' + esc(l.rule) + '</b><br>' + esc(l.text) + '</div></div>'; }).join('') : '<div class="empty">No decisions yet. The engine checks your rules every 15 seconds.</div>') + '</div>' +
      (s.live && s.orders.length ? '<div class="sec-title">Live orders</div><table><tr><th>Time</th><th>Order</th><th>Status</th><th>Network</th></tr>' + s.orders.map(function (o) { return '<tr><td>' + hhmm(o.createdAt) + '</td><td>' + esc(orderText(o)) + '</td><td>' + esc(ORDER_STATUS[o.status] || o.status) + '</td><td>' + (o.signature ? '<a class="up" target="_blank" rel="noopener" href="https://solscan.io/tx/' + esc(o.signature) + '">view</a>' : '-') + '</td></tr>'; }).join('') + '</table>' : '') +
      (s.fills.length ? '<div class="sec-title">' + (s.live ? 'Confirmed trades (values estimated from the quote)' : 'Paper orders') + '</div><table><tr><th>Time</th><th>Side</th><th>Value</th><th>Price</th><th>Rule</th></tr>' + s.fills.map(function (f) { return '<tr><td>' + hhmm(f.t) + '</td><td class="' + (f.side === 'buy' ? 'up' : 'down') + '">' + (f.side === 'buy' ? 'buy' : 'sell') + '</td><td>' + usd(f.usd) + '</td><td>' + price(f.price) + '</td><td class="mono">' + esc(f.rule) + '</td></tr>'; }).join('') + '</table>' : '') + '</div></div>';
    if ($('#sa')) $('#sa').onclick = async function () {
      if (!confirm('Create an order to sell your whole position now? You will still review and sign it in your wallet.')) return;
      try { await post('/api/strategies/' + id + '/manual', { wallet: W.address || s.wallet, side: 'sell', pct: 100 }); toast('Sell order created. Click Review and sign.'); load(); } catch (e) { toast(e.message, true); }
    };
    const po = s.live && openOrder(s);
    if (po) {
      $('#rv').onclick = function () { reviewOrder(s, po); };
      $('#dc').onclick = async function () { try { await post('/api/strategies/' + id + '/orders/' + po.id + '/decline', { wallet: W.address || s.wallet }); toast('Order declined'); load(); } catch (e) { toast(e.message, true); } };
    }
    $('#tg').onclick = async function () { try { await post('/api/strategies/' + id + '/' + (s.status === 'active' ? 'pause' : 'resume')); load(); } catch (e) { toast(e.message, true); } };
    $('#rm').onclick = async function () { if (!confirm('Delete this strategy and its history?')) return; try { await api('/api/strategies/' + id, { method: 'DELETE' }); location.hash = '#/strategies'; } catch (e) { toast(e.message, true); } };
  }
  load(); every(load, 5000);
}

/* ---------- how it works ---------- */
function pageHow() {
  const L = function (name, text) { return '<div class="kv"><b class="mono">' + name + '</b><span>' + text + '</span></div>'; };
  view.innerHTML = '<div class="wrap how">' +
    '<div class="howhead"><span class="aibadge">' + SPARK + ' How it works</span><h1>From a sentence to a running strategy.</h1>' +
    '<p>' + BRAND + ' lets you describe a trading idea in plain English, turns it into rules you can read, tests it on live prices, and trades from your own wallet. You stay in control of every order.</p>' +
    '<div class="row" style="justify-content:flex-start;gap:10px"><a class="btn primary" href="#/">' + SPARK + ' Build a strategy</a><a class="btn" href="#/strategies">My strategies</a></div></div>' +

    '<div class="sec-title">The four steps</div><div class="howgrid">' +
    '<div class="card"><span class="num">1</span><h3>Describe</h3><p class="muted">Tell the AI what you want, for example: <i>Buy $50 every hour under $0.40. If it drops 25% from the peak, sell everything.</i> Missing details are filled with sensible defaults, and the AI tells you exactly what it assumed. Prefer not to write? Start from a template.</p></div>' +
    '<div class="card"><span class="num">2</span><h3>Review</h3><p class="muted">The AI never trades. It only writes rules from a fixed library, shown as <b>when / if / then</b>. You read them, then set your budget, the maximum per order and the maximum loss. Rules can never go beyond those limits.</p></div>' +
    '<div class="card"><span class="num">3</span><h3>Paper trade</h3><p class="muted">Every strategy can run on paper first, against live prices. Each check records what fired, what was blocked and why, so you can argue with the log instead of guessing.</p></div>' +
    '<div class="card"><span class="num">4</span><h3>Go live</h3><p class="muted">Connect your wallet and switch a strategy to live. When a rule fires, you get an order to review. You see the amounts and the price check, then sign in your own wallet. No signature, no trade.</p></div></div>' +

    '<div class="sec-title">Who does what</div><div class="card">' +
    '<div class="kv"><b>' + SPARK + ' AI</b><span>Understands your description and writes the rules (once, when you build the strategy). It cannot place orders.</span></div>' +
    '<div class="kv"><b>Rule engine</b><span>Checks your rules against live prices every 15 seconds and runs them exactly as written. Always inside your limits.</span></div>' +
    '<div class="kv"><b>Built-in judge</b><span>A simple check used by the <span class="mono">jev</span> condition: it compares liquidity and the wider market to tell a market-wide drop from a token-specific one.</span></div>' +
    '<div class="kv"><b>You</b><span>Approve the rules, set the limits, and sign every live order in your wallet.</span></div></div>' +

    '<div class="sec-title">The rule library</div><div class="howgrid three">' +
    '<div class="card"><h3>When</h3><p class="note">Something happens on the clock or in the market.</p>' +
    L('interval', 'every N minutes') + L('price_change', 'price moves X% in a window') + L('drawdown_from_peak', 'falls X% from its peak') + L('price_cross', 'crosses a price or a % of cost') + L('volume_spike', 'volume jumps vs the hourly pace') + '</div>' +
    '<div class="card"><h3>If</h3><p class="note">Guards that must all hold.</p>' +
    L('price_max / price_min', 'price bounds') + L('cooldown', 'wait between fires') + L('max_fires', 'limit how often') + L('position', 'size of your position') + L('budget_left', 'balance available') + L('rule_state', 'another rule is done or off') + L('liquidity_min', 'enough liquidity') + L('jev', 'the built-in judge agrees') + '</div>' +
    '<div class="card"><h3>Then</h3><p class="note">What to do.</p>' +
    L('buy', 'buy a USD amount') + L('sell', 'sell a % of the position') + L('exit_all', 'sell everything') + L('deploy_remaining', 'put the rest in, in clips') + L('pause / resume / disable', 'steer other rules') + L('notify', 'log a notice') + '</div></div>' +

    '<div class="sec-title">Your wallet, your control</div><div class="card"><ul class="howlist">' +
    '<li><b>Non-custodial.</b> Connecting a wallet only shares your address and balance. ' + BRAND + ' never sees your private key and cannot move funds on its own.</li>' +
    '<li><b>You sign every live order.</b> A rule creates an order that waits for you: 3 minutes to open it, then 90 seconds to sign before the transaction expires.</li>' +
    '<li><b>One order at a time.</b> A new order is only created when the previous one is finished, declined or expired.</li>' +
    '<li><b>A hard stop.</b> If a strategy loses more than your max loss, it pauses itself.</li></ul></div>' +

    '<div class="sec-title">Checks on every live order</div><div class="card"><ul class="howlist">' +
    '<li><b>Quote and route</b> from Jupiter, the Solana swap aggregator.</li>' +
    '<li><b>Simulation before sending.</b> If a route fails its simulation, another route is tried automatically. If none works, nothing is sent.</li>' +
    '<li><b>Price check.</b> The quote is compared with the market price. If it is worse than 3%, you see a warning and must confirm. Above 50% it is blocked as a likely data error.</li>' +
    '<li><b>Smart slippage.</b> Fast-moving tokens get a wider tolerance so the order does not fail on-chain. You always see the number.</li>' +
    '<li><b>SOL for fees.</b> The order is stopped if your wallet would be left without enough SOL for network fees.</li></ul></div>' +

    '<div class="sec-title">Costs</div><div class="card"><ul class="howlist">' +
    '<li><b>Network fees</b> and a small priority fee on every transaction (usually a fraction of a cent).</li>' +
    '<li><b>Token account rent.</b> The first time you hold a token, Solana creates an account for it. This costs about 0.002 SOL and can be recovered by closing the empty account later.</li>' +
    '<li><b>Swap costs.</b> The pools you trade against charge their own fees and spread, shown in the price check.</li>' +
    '<li>' + BRAND + ' itself does not add a fee to your orders.</li></ul></div>' +

    '<div class="sec-title">Good to know</div><div class="card"><ul class="howlist">' +
    '<li>Memecoins are volatile and can lose all of their value. Rules automate your decisions, they do not make them profitable.</li>' +
    '<li>The tab must stay open to approve orders. Strategies check prices while the app is running.</li>' +
    '<li>Confirmed values are estimated from the quote, and paper results are simulations.</li>' +
    '<li>Risk scores and AI-written rules are aids, not advice. Always read the rules before you start.</li></ul></div>' +

    '<div class="cta"><h2>Ready to try it?</h2><p class="muted">Describe a strategy and let AI build the rules.</p><a class="btn primary" href="#/">' + SPARK + ' Build with AI</a></div></div>';
}

// Notice at the top when a live strategy has an order waiting for approval.
async function checkPending() {
  try {
    const list = await api('/api/strategies');
    const n = list.filter(function (s) { return s.live && openOrder(s); }).length;
    const b = $('#pendBadge');
    b.hidden = n === 0; b.textContent = n + (n === 1 ? ' order waiting' : ' orders waiting');
  } catch (e) { /* try again next cycle */ }
}
setInterval(checkPending, 10000); checkPending();

// Injected wallets can show up a moment after the page loads.
window.addEventListener('load', function () { setTimeout(function () { autoConnect().then(function () { if (location.hash === '#/wallet') route(); }); }, 300); });
route();
