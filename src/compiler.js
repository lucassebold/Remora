'use strict';
// Frase -> regras. A IA so escreve JSON; tudo passa por rules.validate() antes de existir.
const http = require('./http');
const rules = require('./rules');

const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';

// Provedor: AI_PROVIDER=gemini|anthropic, ou automatico pela chave que existir. Sem chave: modo simples.
function provider() {
  const want = (process.env.AI_PROVIDER || '').toLowerCase();
  if (want === 'gemini' && process.env.GEMINI_API_KEY) return 'gemini';
  if (want === 'anthropic' && process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (!want && process.env.GEMINI_API_KEY) return 'gemini';
  if (!want && process.env.ANTHROPIC_API_KEY) return 'anthropic';
  return null;
}
exports.provider = provider;
exports.available = function () { return !!provider(); };

function systemPrompt() {
  const S = rules.SPEC;
  function fmt(t) { return Object.keys(t).map(function (k) { return k + '{' + Object.keys(t[k]).map(function (f) { return f + ':' + t[k][f]; }).join(', ') + '}'; }).join('\n'); }
  return [
    'You turn trading requests into JSON rules for a strategy engine. You NEVER trade; you only write rules.',
    'The user may write in any language. ALWAYS write the output in English (names and assumptions).',
    'Reply with ONLY one JSON object: {"name": string, "assumptions": [string], "rules": [ {id, name, priority, once?, when:{type,...}, if:[{type,...}], then:[{type,...}]} ]}.',
    'Requests are often vague. Do NOT refuse because numbers are missing: pick sensible defaults and list each one in "assumptions" (short English sentences, e.g. "gradually = $50 every 30 min", "low price = below the current price", "crashes = 25% drop from the peak").',
    'Useful defaults when a number is missing: recurring buy $50 every 30 min; "low price" = price_max equal to the token\'s current price; "crashes/dumps" = drawdown_from_peak 25 with sell 100; "take profit" = sell 25% at +50% and 25% at +100% over average cost; "volume" = volume_spike 5x.',
    'Use only the types below, with exactly these fields. Values in USD. "pos" = number greater than 0, "num" = number (negative = drop).',
    'TRIGGERS (when):\n' + fmt(S.triggers),
    'CONDITIONS (if):\n' + fmt(S.conditions),
    'ACTIONS (then):\n' + fmt(S.actions),
    'Rules: id in lowercase letters/numbers/_ up to 24 chars; lower priority runs first; once=true fires a single time; at most 8 rules.',
    '"rule" in conditions/actions references the id of another rule. drawdown_from_peak only applies while a position is open.',
    'Only reply {"error":"short reason"} if the request has nothing to do with buying/selling the token or cannot be expressed with these blocks even when assuming values.'
  ].join('\n\n');
}

/* ---------- modo simples (sem IA): reconhece padroes de frase em portugues e ingles ---------- */
function norm(s) { return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/,(\d)/g, '.$1'); }
function n(x) { return parseFloat(x); }

exports.localCompile = function (text, token) {
  const t = norm(text), out = [];
  const sellWord = /\b(vend\w*|sell|saia|sair|exit)\b/.test(t);
  const buyWord = '(?:compr\\w*|buy)';

  // 1) Compra recorrente: "compre $50 a cada 30 min abaixo de $0.40", "buy $100 every hour"
  const dca = t.match(new RegExp(buyWord + '\\s*\\$?\\s*(\\d+(?:\\.\\d+)?)[^.]*?(?:a cada|every|por)\\s*(\\d+(?:\\.\\d+)?)?\\s*(min\\w*|hora\\w*|hour\\w*|h\\b)'));
  if (dca) {
    const mins = Math.max(1, Math.round((n(dca[2]) || 1) * (/^(hora|hour|h)/.test(dca[3]) ? 60 : 1)));
    const conds = [];
    const cap = t.match(/(?:abaixo de|abaixo do|menos de|ate|under|below)\s*\$?\s*(\d+(?:\.\d+)?)/);
    if (cap) conds.push({ type: 'price_max', price: n(cap[1]) });
    else if (/abaixo do preco atual|abaixo do preco de hoje|below (?:the )?current price/.test(t) && token) conds.push({ type: 'price_max', price: token.price });
    conds.push({ type: 'budget_left', usd: Math.max(1, n(dca[1])) });
    out.push({ id: 'dca', name: 'Recurring buy', priority: 1, when: { type: 'interval', minutes: mins }, if: conds, then: [{ type: 'buy', usd: n(dca[1]) }] });
  }

  // 2) Compra na queda: "se cair 20% em 24h compre $200"
  const dip = t.match(new RegExp('(?:se|quando|if|when)\\s+(?:o preco\\s+|price\\s+)?(?:cair|cai|caiu|drop\\w*|fall\\w*)\\s*(\\d+(?:\\.\\d+)?)\\s*%([^.]*?)' + buyWord + '\\s*\\$?\\s*(\\d+(?:\\.\\d+)?)'));
  // Tambem na ordem inversa: "compre $200 se cair 20% em 24h"
  const dip2 = t.match(new RegExp(buyWord + '\\s*\\$?\\s*(\\d+(?:\\.\\d+)?)([^.]*?)(?:se|quando|if|when)\\s+(?:o preco\\s+|price\\s+)?(?:cair|cai|caiu|drop\\w*|fall\\w*)\\s*(\\d+(?:\\.\\d+)?)\\s*%'));
  const pct = dip && !/pico|peak|topo/.test(dip[2]) ? [dip[1], dip[3]] : dip2 && !/pico|peak|topo|a cada|every/.test(dip2[2]) ? [dip2[3], dip2[1]] : null;
  if (pct) {
    out.push({ id: 'dip', name: 'Buy the ' + pct[0] + '% dip', priority: 2, when: { type: 'price_change', pct: -n(pct[0]), window: '24h' }, if: [{ type: 'cooldown', minutes: 240 }, { type: 'budget_left', usd: 1 }], then: [{ type: 'buy', usd: n(pct[1]) }] });
  }

  // 3) Stop desde o pico: "venda tudo se cair 25% do pico", "stop de 30%", "trailing 25%"
  const stop = t.match(/(?:cair|cai|caiu|queda|drop\w*|fall\w*)\s*(?:de\s*)?(\d+(?:\.\d+)?)\s*%[^.]*?(?:pico|topo|maxima|peak|high)/)
    || t.match(/(?:stop|trailing)(?:\s*loss)?(?:\s*de)?\s*(\d+(?:\.\d+)?)\s*%/);
  if (stop) out.push({ id: 'stop', name: stop[1] + '% trailing stop', priority: 5, when: { type: 'drawdown_from_peak', pct: n(stop[1]) }, if: [], then: [{ type: 'sell', pct: 100 }] });

  // 4) Realizar lucro: "venda 25% em +50% e 25% em +100%"
  if (sellWord) {
    const re = /(\d+(?:\.\d+)?)\s*%\s*(?:em|a|quando|at|when)\s*\+\s*(\d+(?:\.\d+)?)\s*%/g;
    let m, i = 0;
    while ((m = re.exec(t)) && i < 4) { i++; out.push({ id: 'tp' + i, name: 'Sell ' + m[1] + '% at +' + m[2] + '%', priority: 3, once: true, when: { type: 'price_cross', direction: 'above', from_avg_cost_pct: n(m[2]) }, if: [], then: [{ type: 'sell', pct: n(m[1]) }] }); }
  }

  // 5) Pico de volume: "venda 25% quando o volume passar de 5x"
  const vol = t.match(/volume[^.]*?(\d+(?:\.\d+)?)\s*(?:x|vezes)/);
  if (vol && sellWord) {
    const pc = t.match(/(?:vend\w*|sell)\s*(\d+(?:\.\d+)?)\s*%/);
    out.push({ id: 'spike', name: 'Sell on a volume spike', priority: 4, when: { type: 'volume_spike', multiple: n(vol[1]) }, if: [{ type: 'cooldown', minutes: 60 }, { type: 'position', op: '>', usd: 0 }], then: [{ type: 'sell', pct: pc ? n(pc[1]) : 25 }] });
  }

  if (!out.length) {
    const e = new Error('Could not turn that into rules. Try adding amounts and conditions, for example: "Buy $50 every 30 min under $0.40. Sell everything if it falls 25% from the peak."');
    e.details = []; throw e;
  }
  const check = rules.validate(out);
  if (!check.ok) { const e = new Error('Could not turn that into valid rules: ' + check.errors.join('; ')); throw e; }
  return { name: 'Strategy from your description', rules: check.rules, mode: 'simple' };
};

/* ---------- provedores de IA: cada um devolve o texto bruto; a validacao e comum ---------- */
async function askAnthropic(system, user) {
  const r = await http.postJson('https://api.anthropic.com/v1/messages', {
    model: ANTHROPIC_MODEL, max_tokens: 2000, system: system, messages: [{ role: 'user', content: user }]
  }, { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, 60000);
  return (r.content || []).map(function (b) { return b.text || ''; }).join('');
}

// Modelo do Gemini: GEMINI_MODEL, senao o alias "flash mais recente". Se estiver sobrecarregado (503), sem cota (429)
// ou nao existir (404), tenta os outros modelos "flash" que a sua chave enxerga (com os "lite" por ultimo).
// Ordem de preferencia: "lite" estavel, "lite" preview, "flash" estavel, "flash" preview. O lite e o mais rapido e
// basta para virar frase em JSON; modelos que "pensam" antes de responder estouram o tempo.
let flashList = null;
async function geminiFlashList(headers) {
  if (flashList) return flashList;
  const list = await http.getJson(GEMINI + '/models?pageSize=200', headers);
  const names = (list.models || []).filter(function (m) {
    return (m.supportedGenerationMethods || []).indexOf('generateContent') >= 0 && /flash/.test(m.name) && !/image|tts|live|audio|embed|exp|robotics|computer|thinking/.test(m.name);
  }).map(function (m) { return m.name.replace(/^models\//, ''); });
  function group(pred) { return names.filter(pred).sort().reverse(); }
  flashList = group(function (x) { return /lite/.test(x) && !/preview/.test(x); })
    .concat(group(function (x) { return /lite/.test(x) && /preview/.test(x); }))
    .concat(group(function (x) { return !/lite/.test(x) && !/preview/.test(x); }))
    .concat(group(function (x) { return !/lite/.test(x) && /preview/.test(x); }));
  return flashList;
}
exports.geminiFlashList = geminiFlashList;
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
async function askGemini(system, user) {
  const headers = { 'x-goog-api-key': process.env.GEMINI_API_KEY };
  const retryMs = process.env.GEMINI_RETRY_MS !== undefined ? Number(process.env.GEMINI_RETRY_MS) : 1500;
  const body = { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.2, maxOutputTokens: 4096 } };
  // GEMINI_MODEL fixa um modelo; senao usa a lista da sua chave (ou os aliases "latest" se a lista falhar).
  const queue = [], tried = [];
  if (process.env.GEMINI_MODEL) queue.push(process.env.GEMINI_MODEL);
  try { (await geminiFlashList(headers)).forEach(function (m) { queue.push(m); }); } catch (e) { queue.push('gemini-flash-lite-latest', 'gemini-flash-latest'); }
  let r, lastErr;
  while (queue.length && tried.length < 3) {
    const model = queue.shift();
    if (tried.indexOf(model) >= 0) continue;
    tried.push(model);
    for (let attempt = 0; attempt < 2 && !r; attempt++) {
      try { r = await http.postJson(GEMINI + '/models/' + model + ':generateContent', body, headers, 20000); }
      catch (e) {
        lastErr = e;
        if (/HTTP 503/.test(e.message) && attempt === 0) { await sleep(retryMs); continue; } // sobrecarga passageira: tenta de novo
        break;
      }
    }
    if (r) break;
    if (!/Timeout|HTTP (503|429|404|500)/.test(lastErr.message)) throw lastErr;
  }
  if (!r) {
    const m = lastErr.message;
    if (/HTTP 429/.test(m)) throw new Error('Gemini free quota reached');
    if (/HTTP 503/.test(m)) throw new Error('Gemini is overloaded (tried ' + tried.length + ' model(s): ' + tried.join(', ') + ')');
    if (/Timeout/.test(m)) throw new Error('Gemini took too long (tried: ' + tried.join(', ') + ')');
    throw lastErr;
  }
  const c = r.candidates && r.candidates[0];
  if (!c || !c.content) throw new Error('Gemini returned no answer (' + ((c && c.finishReason) || (r.promptFeedback && r.promptFeedback.blockReason) || 'empty') + ')');
  return c.content.parts.map(function (p) { return p.text || ''; }).join('');
}

async function aiCompile(text, token) {
  const ctx = token ? 'Token: ' + token.symbol + ', current price $' + token.price + ', liquidity $' + Math.round(token.liquidity) + '.' : '';
  const user = (ctx + '\nRequest: ' + String(text).slice(0, 600)).trim();
  const raw = provider() === 'gemini' ? await askGemini(systemPrompt(), user) : await askAnthropic(systemPrompt(), user);
  return parseAi(raw);
}

// If the AI fails (invalid key, quota, network, bad answer) we silently fall back to the pattern parser so the user
// still gets rules. The reason is kept in out.note for the server log only; it is never shown in the UI.
let aiOffUntil = 0;
const AI_OFF_MS = 10 * 60000;
exports.compile = async function (text, token) {
  if (!exports.available() || Date.now() < aiOffUntil) return exports.localCompile(text, token);
  try { return await aiCompile(text, token); }
  catch (e) {
    if (/API key not valid|HTTP 40[13]/.test(e.message)) aiOffUntil = Date.now() + AI_OFF_MS; // invalid key: stop retrying for a while
    try { const out = exports.localCompile(text, token); out.note = 'AI unavailable (' + e.message + '); used the pattern parser'; return out; }
    catch (e2) { throw new Error(e2.message); }
  }
};
exports.resetAi = function () { aiOffUntil = 0; };

function parseAi(raw) {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('The AI did not return valid rules');
  let obj;
  try { obj = JSON.parse(m[0]); } catch (e) { throw new Error('The AI returned invalid JSON'); }
  if (obj.error) throw new Error('Could not build that: ' + obj.error);
  const v = rules.validate(obj.rules);
  if (!v.ok) { const e = new Error('The AI generated invalid rules: ' + v.errors.join('; ')); e.details = v.errors; throw e; }
  const assumptions = (Array.isArray(obj.assumptions) ? obj.assumptions : []).slice(0, 8).map(function (a) { return String(a).slice(0, 140); });
  return { name: String(obj.name || 'Strategy').slice(0, 60), rules: v.rules, mode: 'ai', assumptions: assumptions };
};
