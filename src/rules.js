'use strict';
// Closed rule library: when (trigger) + if (conditions) + then (actions).
// Everything the AI generates goes through validate(); the engine only runs what is defined here.

const WINDOWS = ['5m', '1h', '6h', '24h'];
const LABELS = ['market_drawdown', 'token_specific_dump', 'liquidity_pull'];

// Fields: 'num' = number, 'pos' = number > 0, 'enum:a|b' = list, 'id' = id of another rule, 'str' = text. A trailing '?' means optional.
const TRIGGERS = {
  interval: { minutes: 'pos' },
  price_change: { pct: 'num', window: 'enum:' + WINDOWS.join('|') },
  drawdown_from_peak: { pct: 'pos' },
  price_cross: { direction: 'enum:above|below', price: 'pos?', from_avg_cost_pct: 'num?' },
  volume_spike: { multiple: 'pos' }
};
const CONDITIONS = {
  price_max: { price: 'pos' },
  price_min: { price: 'pos' },
  cooldown: { minutes: 'pos' },
  max_fires: { count: 'pos' },
  position: { op: 'enum:>|<=', usd: 'num' },
  budget_left: { usd: 'pos' },
  rule_state: { rule: 'id', state: 'enum:armed|completed|disabled|paused' },
  liquidity_min: { usd: 'pos' },
  jev: { label: 'enum:' + LABELS.join('|'), min: 'pos' }
};
const ACTIONS = {
  buy: { usd: 'pos' },
  sell: { pct: 'pos' },
  exit_all: {},
  disable_rule: { rule: 'id' },
  pause_rule: { rule: 'id' },
  resume_rule: { rule: 'id' },
  deploy_remaining: {},
  notify: { message: 'str?' }
};
exports.SPEC = { triggers: TRIGGERS, conditions: CONDITIONS, actions: ACTIONS, windows: WINDOWS, labels: LABELS };

function checkFields(kind, obj, spec, ids, errors, where) {
  if (!obj || typeof obj !== 'object') { errors.push(where + ': invalid format'); return null; }
  const table = spec[obj.type];
  if (!table) { errors.push(where + ': unknown ' + kind + ' "' + obj.type + '"'); return null; }
  const out = { type: obj.type };
  Object.keys(table).forEach(function (f) {
    const t = table[f], optional = /\?$/.test(t), type = t.replace('?', ''), v = obj[f];
    if (v === undefined || v === null) { if (!optional) errors.push(where + ': missing "' + f + '"'); return; }
    if (type === 'num' || type === 'pos') {
      if (typeof v !== 'number' || !isFinite(v) || (type === 'pos' && v <= 0)) errors.push(where + ': "' + f + '" must be a number' + (type === 'pos' ? ' greater than 0' : ''));
      else out[f] = v;
    } else if (type.indexOf('enum:') === 0) {
      if (type.slice(5).split('|').indexOf(String(v)) < 0) errors.push(where + ': invalid "' + f + '" (' + v + ')');
      else out[f] = String(v);
    } else if (type === 'id') {
      if (ids.indexOf(v) < 0) errors.push(where + ': "' + f + '" points to a rule that does not exist (' + v + ')');
      else out[f] = v;
    } else out[f] = String(v).slice(0, 140);
  });
  if (obj.type === 'price_cross' && out.price === undefined && out.from_avg_cost_pct === undefined) errors.push(where + ': price_cross needs "price" or "from_avg_cost_pct"');
  if (obj.type === 'jev' && out.min > 1) errors.push(where + ': jev.min must be between 0 and 1');
  return out;
}

exports.validate = function (rules) {
  const errors = [];
  if (!Array.isArray(rules) || !rules.length) return { ok: false, errors: ['A strategy needs at least 1 rule'] };
  if (rules.length > 12) return { ok: false, errors: ['At most 12 rules'] };
  const ids = rules.map(function (r) { return r && r.id; });
  const clean = rules.map(function (r, i) {
    const w = 'Rule ' + (i + 1);
    if (!r || !/^[a-z0-9_]{1,24}$/.test(r.id || '')) { errors.push(w + ': "id" must be 1-24 lowercase letters, numbers or _'); return null; }
    if (ids.indexOf(r.id) !== i) errors.push(w + ': duplicate id (' + r.id + ')');
    const out = { id: r.id, name: String(r.name || r.id).slice(0, 60), priority: typeof r.priority === 'number' ? r.priority : i + 1, once: !!r.once };
    out.when = checkFields('trigger', r.when, TRIGGERS, ids, errors, w + ' (when)');
    out.if = (Array.isArray(r.if) ? r.if : []).map(function (c, j) { return checkFields('condition', c, CONDITIONS, ids, errors, w + ' (if ' + (j + 1) + ')'); });
    out.then = (Array.isArray(r.then) ? r.then : []).map(function (a, j) { return checkFields('action', a, ACTIONS, ids, errors, w + ' (then ' + (j + 1) + ')'); });
    if (!out.then.length) errors.push(w + ': needs at least 1 action');
    return out;
  });
  return errors.length ? { ok: false, errors: errors } : { ok: true, rules: clean };
};

function dollars(n) { return '$' + n; }

// Describes a rule in plain English (used by the UI and the decision log).
exports.describe = function (r) {
  const w = r.when;
  const when = ({
    interval: function () { return 'every ' + w.minutes + ' min'; },
    price_change: function () { return 'price ' + (w.pct < 0 ? 'drops ' : 'rises ') + Math.abs(w.pct) + '% in ' + w.window; },
    drawdown_from_peak: function () { return 'price falls ' + w.pct + '% from its peak'; },
    price_cross: function () { return 'price crosses ' + (w.direction === 'above' ? 'above ' : 'below ') + (w.price !== undefined ? dollars(w.price) : (w.from_avg_cost_pct > 0 ? '+' : '') + w.from_avg_cost_pct + '% of average cost'); },
    volume_spike: function () { return '5m volume hits ' + w.multiple + 'x the hourly pace'; }
  })[w.type]();
  const cond = r.if.map(function (c) {
    return ({
      price_max: 'price <= ' + dollars(c.price), price_min: 'price >= ' + dollars(c.price),
      cooldown: 'wait ' + c.minutes + ' min between fires', max_fires: 'at most ' + c.count + ' fires',
      position: 'position ' + c.op + ' ' + dollars(c.usd), budget_left: 'balance >= ' + dollars(c.usd),
      rule_state: 'rule ' + c.rule + ' is ' + c.state, liquidity_min: 'liquidity >= ' + dollars(c.usd),
      jev: 'judge: ' + c.label + ' >= ' + c.min
    })[c.type];
  });
  const then = r.then.map(function (a) {
    return ({
      buy: 'buy ' + dollars(a.usd), sell: 'sell ' + a.pct + '%', exit_all: 'sell everything',
      disable_rule: 'disable ' + a.rule, pause_rule: 'pause ' + a.rule, resume_rule: 'resume ' + a.rule,
      deploy_remaining: 'deploy the remaining balance', notify: 'notify me'
    })[a.type];
  });
  return { when: when, if: cond, then: then };
};

// Ready-made templates. Values in USD.
exports.presets = function () {
  return [
    {
      id: 'accumulate_dip', name: 'Accumulate and go all-in on a crash',
      about: 'Buys a little every hour under a price cap. If the price halves in a day and the judge reads it as a market-wide drop, it deploys the rest and protects the position with a stop.',
      params: { budget: 1000, maxPerTrade: 200, maxLoss: 400 },
      fields: [{ key: 'cap', label: 'Price cap (USD)', from: 'price', mult: 1.05 }],
      build: function (v) {
        return [
          { id: 'dca', name: 'Hourly buy under the cap', priority: 1, when: { type: 'interval', minutes: 60 }, if: [{ type: 'price_max', price: v.cap }, { type: 'budget_left', usd: 10 }], then: [{ type: 'buy', usd: 100 }] },
          { id: 'crash', name: 'Down 50% in a day: deploy the rest', priority: 5, once: true, when: { type: 'price_change', pct: -50, window: '24h' }, if: [{ type: 'liquidity_min', usd: 20000 }, { type: 'jev', label: 'market_drawdown', min: 0.6 }], then: [{ type: 'disable_rule', rule: 'dca' }, { type: 'deploy_remaining' }, { type: 'notify', message: 'Crash detected' }] },
          { id: 'trail', name: '25% trailing stop after the crash', priority: 8, when: { type: 'drawdown_from_peak', pct: 25 }, if: [{ type: 'rule_state', rule: 'crash', state: 'completed' }], then: [{ type: 'sell', pct: 100 }] }
        ];
      }
    },
    {
      id: 'buy_dip_sell_rip', name: 'Buy the dip, sell the rip',
      about: 'Buys when the price drops 20% in 24h, sells a quarter at +50% and another quarter at +100% over average cost, and protects the rest with a 30% trailing stop.',
      params: { budget: 1000, maxPerTrade: 250, maxLoss: 400 },
      fields: [],
      build: function () {
        return [
          { id: 'dip', name: 'Buy the 20% dip', priority: 1, when: { type: 'price_change', pct: -20, window: '24h' }, if: [{ type: 'cooldown', minutes: 240 }, { type: 'budget_left', usd: 10 }], then: [{ type: 'buy', usd: 200 }] },
          { id: 'tp1', name: 'Sell 25% at +50%', priority: 2, once: true, when: { type: 'price_cross', direction: 'above', from_avg_cost_pct: 50 }, if: [], then: [{ type: 'sell', pct: 25 }] },
          { id: 'tp2', name: 'Sell 25% at +100%', priority: 3, once: true, when: { type: 'price_cross', direction: 'above', from_avg_cost_pct: 100 }, if: [], then: [{ type: 'sell', pct: 25 }] },
          { id: 'stop', name: '30% trailing stop', priority: 4, when: { type: 'drawdown_from_peak', pct: 30 }, if: [], then: [{ type: 'sell', pct: 100 }] }
        ];
      }
    },
    {
      id: 'sell_volume_spikes', name: 'Sell into volume spikes',
      about: 'For positions you already hold: sells 25% when 5-minute volume runs above 5x the last hour\'s pace. At most once an hour.',
      params: { budget: 1000, maxPerTrade: 250, maxLoss: 400, startWithPosition: 500 },
      fields: [],
      build: function () {
        return [
          { id: 'spike', name: 'Sell 25% on a volume spike', priority: 1, when: { type: 'volume_spike', multiple: 5 }, if: [{ type: 'cooldown', minutes: 60 }, { type: 'position', op: '>', usd: 0 }], then: [{ type: 'sell', pct: 25 }] }
        ];
      }
    }
  ];
};
