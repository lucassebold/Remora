'use strict';
// Cliente HTTP minimo (sem dependencias; funciona no Node 12).
const https = require('https');

function request(method, url, body, headers, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const u = new URL(url);
    const payload = body ? JSON.stringify(body) : null;
    const h = Object.assign({ accept: 'application/json', 'user-agent': 'cardume/0.1' }, headers || {});
    if (payload) { h['content-type'] = 'application/json'; h['content-length'] = Buffer.byteLength(payload); }
    const req = https.request({ method: method, hostname: u.hostname, path: u.pathname + u.search, headers: h }, function (res) {
      let data = '';
      res.on('data', function (c) { data += c; });
      res.on('end', function () {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let why = '';
          try { const j = JSON.parse(data); why = ': ' + String((j.error && (j.error.message || j.error)) || '').slice(0, 140); } catch (e) { /* sem corpo JSON */ }
          return reject(new Error('HTTP ' + res.statusCode + ' em ' + u.hostname + (why === ': ' ? '' : why)));
        }
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Resposta invalida de ' + u.hostname)); }
      });
    });
    req.setTimeout(timeoutMs || 12000, function () { req.destroy(new Error('Timeout em ' + u.hostname)); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

exports.getJson = function (url, headers) { return request('GET', url, null, headers); };
exports.postJson = function (url, body, headers, timeoutMs) { return request('POST', url, body, headers, timeoutMs); };
