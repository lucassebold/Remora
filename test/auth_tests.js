'use strict';
// Wallet sign-in tests (no network): real ed25519 keys, real signatures.
const assert = require('assert');
const crypto = require('crypto');
const auth = require('../src/auth');

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58encode(buf) {
  const digits = [0];
  for (let i = 0; i < buf.length; i++) {
    let carry = buf[i];
    for (let j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = '';
  for (let k = 0; k < buf.length && buf[k] === 0; k++) out += '1';
  for (let q = digits.length - 1; q >= 0; q--) out += ALPHABET[digits[q]];
  return out;
}
function wallet() {
  const kp = crypto.generateKeyPairSync('ed25519');
  const raw = kp.publicKey.export({ type: 'spki', format: 'der' }).slice(-32);
  return { address: b58encode(raw), sign: function (msg) { return crypto.sign(null, Buffer.from(msg, 'utf8'), kp.privateKey).toString('base64'); } };
}

const out = [];
function t(name, fn) { out.push({ name: name, fn: fn }); }

t('login: a valid signature gives a session that resolves to the wallet address', function () {
  const w = wallet();
  assert.strictEqual(auth.b58decode(w.address).length, 32);
  const c = auth.challenge(w.address);
  const r = auth.login(w.address, c.message, w.sign(c.message));
  assert.strictEqual(auth.verifyToken(r.token), w.address);
});

t('login: rejects wrong signer, other address, tampered message and expired challenge', function () {
  const a = wallet(), b = wallet();
  const c = auth.challenge(a.address, 1e12);
  assert.throws(function () { auth.login(a.address, c.message, b.sign(c.message), 1e12 + 1000); }, /does not match/);   // signed by someone else
  assert.throws(function () { auth.login(b.address, c.message, b.sign(c.message), 1e12 + 1000); }, /different wallet/); // challenge for another wallet
  const forged = c.message.replace('Nonce: ', 'Nonce: 0');
  assert.throws(function () { auth.login(a.address, forged, a.sign(forged), 1e12 + 1000); }, /Invalid sign-in request/); // not issued by this server
  assert.throws(function () { auth.login(a.address, c.message, a.sign(c.message), 1e12 + 6 * 60000); }, /expired/);   // older than 5 min
  const own = 'Sign in to Cardume\nAddress: ' + a.address + '\nIssued: ' + 1e12 + '\nNonce: x\nTag: y'; // made-up challenge
  assert.throws(function () { auth.login(a.address, own, a.sign(own), 1e12 + 1000); }, /Invalid sign-in request/);
});

t('session token: tampering and expiry are rejected', function () {
  const w = wallet(), c = auth.challenge(w.address, 5e11);
  const r = auth.login(w.address, c.message, w.sign(c.message), 5e11 + 1000);
  assert.strictEqual(auth.verifyToken(r.token, 5e11 + 2000), w.address);
  assert.strictEqual(auth.verifyToken(r.token, r.expiresAt + 1), null);             // expired
  const parts = r.token.split('.');
  const other = wallet().address;
  const forgedPayload = Buffer.from(JSON.stringify({ a: other, exp: r.expiresAt })).toString('base64').replace(/=+$/, '');
  assert.strictEqual(auth.verifyToken(forgedPayload + '.' + parts[1]), null);        // someone else's address with our signature part
  assert.strictEqual(auth.verifyToken(''), null); assert.strictEqual(auth.verifyToken('abc'), null); assert.strictEqual(auth.verifyToken(null), null);
});

t('challenge: invalid addresses are refused', function () {
  assert.throws(function () { auth.challenge('not-an-address'); });
  assert.throws(function () { auth.challenge('1'.repeat(44)); });
});

exports.run = async function () {
  let passed = 0;
  for (let i = 0; i < out.length; i++) {
    try { await out[i].fn(); passed++; console.log('ok   ' + out[i].name); }
    catch (e) { process.exitCode = 1; console.log('FALHA ' + out[i].name + '\n     ' + e.message); }
  }
  return passed;
};
