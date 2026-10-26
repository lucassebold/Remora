'use strict';
// Server: API + static files + engine loop. Browsing is open; strategies and orders require a wallet sign-in (auth.js).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const market = require('./market');
const risk = require('./risk');
const rules = require('./rules');
const engine = require('./engine');
const compiler = require('./compiler');
const store = require('./store');
const orders = require('./orders');
const jup = require('./jupiter');
const auth = require('./auth');

const PORT = Number(process.env.PORT) || 3000;
// Local: only this computer (there is no login). On Railway the platform must reach the app, so it listens on all interfaces.
const ON_RAILWAY = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);
const HOST = process.env.HOST || (ON_RAILWAY ? '0.0.0.0' : '127.0.0.1');
const TICK_MS = Number(process.env.TICK_MS) || 15000;
const PUB = path.join(__dirname, '..', 'public');
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise(function (resolve, reject) {
    let d = '';
    req.on('data', function (c) { d += c; if (d.length > 100000) { reject(new Error('Request body too large')); req.destroy(); } });
    req.on('end', function () { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(new Error('Invalid JSON')); } });
  });
}
function view(s) {
  return { id: s.id, name: s.name, mint: s.mint, symbol: s.symbol, status: s.status, mode: s.live ? 'live' : 'paper', live: !!s.live, wallet: s.wallet || null, orders: (s.state.orders || []).slice(0, 15), params: s.params, createdAt: s.createdAt,
    rules: s.rules.map(function (r) { return Object.assign({}, r, { text: rules.describe(r), state: s.state.rs[r.id] || { status: 'armed', fired: 0 } }); }),
    summary: engine.summary(s), log: s.state.log.slice(0, 60), fills: s.state.fills.slice(0, 40), judge: s.state.lastJudge || null,
    lastTick: s.state.lastTick, last: s.state.last };
}

// ---- who is calling? The wallet address inside a valid sign-in token (see auth.js) ----
function callerAddress(req) {
  const m = String(req.headers.authorization || '').match(/^Bearer (.+)$/);
  return m ? auth.verifyToken(m[1]) : null;
}
function clientIp(req) {
  const f = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return f || (req.socket && req.socket.remoteAddress) || 'unknown';
}
// Tiny in-memory rate limiter (per IP and action): protects the AI quota and the public RPC.
const hits = {};
function limited(req, name, max, windowMs) {
  const k = name + '|' + clientIp(req), t = Date.now();
  const a = (hits[k] || []).filter(function (x) { return t - x < windowMs; });
  a.push(t); hits[k] = a;
  if (Object.keys(hits).length > 5000) Object.keys(hits).forEach(function (key) { const h = hits[key]; if (!h.length || t - h[h.length - 1] > 3600000) delete hits[key]; });
  return a.length > max;
}
function tooMany(res) { return send(res, 429, { error: 'Too many requests. Please wait a few minutes and try again.' }); }
// Returns { s, addr } for a strategy owned by the caller, or answers the request itself and returns null.
function mine(req, res, id) {
  const addr = callerAddress(req);
  if (!addr) { send(res, 401, { error: 'Sign in with your wallet to continue', code: 'auth' }); return null; }
  const s = store.get(id);
  if (!s || s.owner !== addr) { send(res, 404, { error: 'Strategy not found' }); return null; } // 404 also for other people's strategies
  return { s: s, addr: addr };
}

let marketH24 = null;
async function updateMarket() {
  try {
    const list = await market.trending();
    const v = list.map(function (t) { return t.change.h24; }).filter(function (x) { return isFinite(x); }).sort(function (a, b) { return a - b; });
    marketH24 = v.length ? v[Math.floor(v.length / 2)] : null;
  } catch (e) { /* mantem o ultimo valor */ }
}

let ticking = false;
async function tickAll() {
  if (ticking) return;
  ticking = true;
  try {
    const act = store.all().filter(function (s) { return s.status === 'active'; });
    if (!act.length) return;
    await updateMarket();
    const mints = act.map(function (s) { return s.mint; }).filter(function (m, i, a) { return a.indexOf(m) === i; });
    const snaps = await market.snapshots(mints);
    act.forEach(function (s) {
      const snap = snaps[s.mint];
      if (snap && snap.price > 0) engine.tick(s, snap, { marketH24: marketH24 });
      else s.state.log.unshift({ t: Date.now(), price: 0, rule: '-', text: 'no price this tick (data source unavailable)', kind: 'block' });
    });
    store.save();
  } catch (e) { console.error('tick:', e.message); } finally { ticking = false; }
}

async function api(req, res, u) {
  const p = u.pathname, q = u.searchParams, m = req.method;
  let x;
  if (m === 'GET' && p === '/api/health') return send(res, 200, { ok: true, compiler: compiler.available(), provider: compiler.provider(), tickMs: TICK_MS, limits: orders.limits(), auth: true });
  if (m === 'POST' && p === '/api/auth/challenge') {
    if (limited(req, 'auth', 30, 60000)) return tooMany(res);
    const b = await readBody(req);
    if (!MINT_RE.test(b.address || '')) return send(res, 400, { error: 'Invalid wallet address' });
    try { return send(res, 200, auth.challenge(b.address)); } catch (e) { return send(res, 400, { error: 'Invalid wallet address' }); }
  }
  if (m === 'POST' && p === '/api/auth/verify') {
    if (limited(req, 'auth', 30, 60000)) return tooMany(res);
    const b = await readBody(req);
    try { return send(res, 200, auth.login(String(b.address || ''), String(b.message || ''), String(b.signature || ''))); }
    catch (e) { return send(res, 401, { error: e.message }); }
  }
  if (m === 'GET' && p === '/api/trending') return send(res, 200, await market.trending());
  if (m === 'GET' && p === '/api/search') {
    const t = (q.get('q') || '').trim();
    if (!t) return send(res, 200, []);
    if (MINT_RE.test(t)) { const s = await market.snapshots([t]); return send(res, 200, s[t] ? [s[t]] : []); }
    return send(res, 200, await market.search(t));
  }
  if (m === 'GET' && (x = p.match(/^\/api\/token\/(\w+)$/))) {
    if (!MINT_RE.test(x[1])) return send(res, 400, { error: 'Invalid token address' });
    const s = await market.snapshots([x[1]]);
    if (!s[x[1]]) return send(res, 404, { error: 'Token not found' });
    const chain = await market.onchain(x[1]);
    return send(res, 200, { snap: s[x[1]], chain: chain, risk: risk.score(s[x[1]], chain) });
  }
  if (m === 'GET' && (x = p.match(/^\/api\/wallet\/(\w+)$/))) {
    if (!MINT_RE.test(x[1])) return send(res, 400, { error: 'Invalid wallet address' });
    if (limited(req, 'wallet', 60, 60000)) return tooMany(res);
    return send(res, 200, await market.wallet(x[1]));
  }
  if (m === 'GET' && p === '/api/bars') {
    if (!/^\w{32,44}$/.test(q.get('pair') || '')) return send(res, 400, { error: 'invalid pair' });
    return send(res, 200, await market.candles(q.get('pair'), q.get('res')));
  }
  if (m === 'GET' && p === '/api/presets') {
    const price = Number(q.get('price')) || 0;
    return send(res, 200, rules.presets().map(function (pr) {
      const v = {};
      pr.fields.forEach(function (f) {
        const o = Number(q.get(f.key));
        v[f.key] = o > 0 ? o : price ? Number((price * f.mult).toPrecision(4)) : 0;
      });
      return { id: pr.id, name: pr.name, about: pr.about, params: pr.params, fields: pr.fields, values: v, rules: pr.build(v).map(function (r) { return Object.assign({}, r, { text: rules.describe(r) }); }) };
    }));
  }
  if (m === 'POST' && p === '/api/compile') {
    if (limited(req, 'compile', 20, 10 * 60000)) return tooMany(res); // protects the AI quota; browsing stays open without sign-in
    const b = await readBody(req);
    if (!MINT_RE.test(b.mint || '')) return send(res, 400, { error: 'Invalid token' });
    const s = await market.snapshots([b.mint]);
    try {
      const out = await compiler.compile(b.text || '', s[b.mint]);
      if (out.note) console.warn('[ai] ' + out.note);
      return send(res, 200, { name: out.name, mode: out.mode, assumptions: out.assumptions || [], rules: out.rules.map(function (r) { return Object.assign({}, r, { text: rules.describe(r) }); }) });
    } catch (e) { return send(res, 422, { error: e.message }); }
  }
  if (m === 'GET' && p === '/api/strategies') {
    const addr = callerAddress(req);
    if (!addr) return send(res, 401, { error: 'Sign in with your wallet to see your strategies', code: 'auth' });
    return send(res, 200, store.all().filter(function (s) { return s.owner === addr; }).map(view));
  }
  if (m === 'POST' && p === '/api/strategies') {
    const addr = callerAddress(req);
    if (!addr) return send(res, 401, { error: 'Sign in with your wallet to start a strategy', code: 'auth' });
    const b = await readBody(req);
    if (!MINT_RE.test(b.mint || '')) return send(res, 400, { error: 'Invalid token' });
    const v = rules.validate(b.rules);
    if (!v.ok) return send(res, 422, { error: v.errors.join('; ') });
    const snap = (await market.snapshots([b.mint]))[b.mint];
    if (!snap || !(snap.price > 0)) return send(res, 404, { error: 'No price for this token right now' });
    const pr = b.params || {};
    const isLive = b.live === true;
    const params = { budget: Math.min(Math.max(Number(pr.budget) || 1000, isLive ? 1 : 10), 1000000), maxPerTrade: Math.max(Number(pr.maxPerTrade) || 200, isLive ? 0.05 : 1), maxLoss: Math.max(Number(pr.maxLoss) || 0, 0), maxImpactPct: 1.5, startWithPosition: Number(pr.startWithPosition) || 0 };
    const live = b.live === true;
    if (live) {
      const lim = orders.limits();
      if (b.wallet && b.wallet !== addr) return send(res, 403, { error: 'Live strategies must use the wallet you signed in with' });
      if (lim.maxBudgetUsd && params.budget > lim.maxBudgetUsd) return send(res, 422, { error: 'The maximum live budget is $' + lim.maxBudgetUsd + ' (LIVE_MAX_BUDGET_USD)' });
      if (lim.maxOrderUsd && params.maxPerTrade > lim.maxOrderUsd) return send(res, 422, { error: 'The maximum live order size is $' + lim.maxOrderUsd + ' (LIVE_MAX_USD_PER_ORDER)' });
      if (!params.maxLoss) return send(res, 422, { error: 'Live strategies need a max loss greater than zero' });
      params.startWithPosition = 0;
    }
    const s = { id: crypto.randomBytes(4).toString('hex'), name: String(b.name || 'Strategy').slice(0, 60), mint: b.mint, symbol: snap.symbol, status: 'active', owner: addr, live: live, wallet: live ? addr : null, params: params, rules: v.rules, createdAt: Date.now(), state: engine.newState(params.budget, snap.price, params.startWithPosition) };
    store.add(s);
    engine.tick(s, snap, { marketH24: marketH24 });
    store.save();
    return send(res, 201, view(s));
  }
  if (m === 'POST' && (x = p.match(/^\/api\/strategies\/(\w+)\/manual$/))) {
    const own = mine(req, res, x[1]); if (!own) return;
    const st = own.s;
    const b = await readBody(req);
    try { orders.manual(st, own.addr, b.side, b.pct); store.save(); return send(res, 200, view(st)); }
    catch (e) { return send(res, 422, { error: e.message }); }
  }
  if (m === 'POST' && (x = p.match(/^\/api\/strategies\/(\w+)\/orders\/(\w+)\/(prepare|submitted|decline)$/))) {
    const own = mine(req, res, x[1]); if (!own) return;
    const st = own.s;
    const b = await readBody(req);
    try {
      if (x[3] === 'prepare') return send(res, 200, await orders.prepare(st, x[2], own.addr, { market: market, jup: jup }));
      if (x[3] === 'decline') { orders.decline(st, x[2], own.addr); store.save(); return send(res, 200, view(st)); }
      orders.submitted(st, x[2], own.addr, b.signature, { market: market }, function () { store.save(); });
      store.save(); return send(res, 200, view(st));
    } catch (e) { store.save(); return send(res, e.expose ? 422 : 502, { error: e.message }); }
  }
  if ((x = p.match(/^\/api\/strategies\/(\w+)(?:\/(pause|resume))?$/))) {
    const own = mine(req, res, x[1]); if (!own) return;
    const s = own.s;
    if (m === 'GET') return send(res, 200, view(s));
    if (m === 'DELETE') { store.remove(s.id); return send(res, 200, { ok: true }); }
    if (m === 'POST' && x[2]) { s.status = x[2] === 'pause' ? 'paused' : 'active'; store.save(); return send(res, 200, view(s)); }
  }
  return send(res, 404, { error: 'Route not found' });
}

const server = http.createServer(function (req, res) {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname.indexOf('/api/') === 0) {
    api(req, res, u).catch(function (e) { console.error(u.pathname, e.message); if (!res.headersSent) send(res, 502, { error: e.message }); });
    return;
  }
  let f = path.normalize(path.join(PUB, u.pathname === '/' ? 'index.html' : u.pathname));
  if (f.indexOf(PUB) !== 0) { res.writeHead(403); return res.end(); }
  fs.readFile(f, function (err, buf) {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
    res.end(buf);
  });
});

store.load();
// Strategies saved before sign-in existed: live ones belong to their wallet; old paper ones have no owner and stay hidden.
store.all().forEach(function (s) { if (!s.owner && s.wallet) s.owner = s.wallet; });
server.listen(PORT, HOST, function () {
  console.log('Cardume at http://' + HOST + ':' + PORT + '  (paper trading by default; live orders need your wallet approval)');
  console.log('AI strategy builder: ' + (compiler.available() ? 'on (' + compiler.provider() + ')' : 'off (set GEMINI_API_KEY to enable)'));
  if (auth.ephemeralSecret) console.log('Note: SESSION_SECRET is not set, so everyone is signed out whenever the server restarts. Set a long random SESSION_SECRET.');
  setInterval(tickAll, TICK_MS);
  tickAll();
});
process.on('SIGINT', function () { store.flush(); process.exit(0); });
