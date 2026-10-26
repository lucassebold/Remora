'use strict';
// Persistencia simples em arquivo JSON (sem banco).
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'state.json');
let data = { strategies: [] };
let timer = null;

exports.load = function () {
  try { data = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { data = { strategies: [] }; }
  if (!Array.isArray(data.strategies)) data.strategies = [];
};
exports.all = function () { return data.strategies; };
exports.get = function (id) { return data.strategies.filter(function (s) { return s.id === id; })[0]; };
exports.add = function (s) { data.strategies.unshift(s); exports.save(); };
exports.remove = function (id) { data.strategies = data.strategies.filter(function (s) { return s.id !== id; }); exports.save(); };

// Grava no maximo 1x por segundo, de forma atomica.
exports.save = function () {
  if (timer) return;
  timer = setTimeout(function () {
    timer = null;
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE + '.tmp', JSON.stringify(data));
      fs.renameSync(FILE + '.tmp', FILE);
    } catch (e) { console.error('Falha ao salvar:', e.message); }
  }, 1000);
};
exports.flush = function () { if (timer) { clearTimeout(timer); timer = null; } try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(data)); } catch (e) {} };
