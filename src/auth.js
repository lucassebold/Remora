'use strict';
// Wallet sign-in without a database.
//  1. The server issues a challenge message (stamped with address, time and a random nonce, authenticated with an HMAC).
//  2. The user signs it in their wallet (free, moves no funds). We verify the ed25519 signature.
//  3. We return a session token = payload + HMAC. It is checked statelessly, so nothing is stored.
const crypto = require('crypto');

const CHALLENGE_TTL_MS = 5 * 60000;
const SESSION_TTL_MS = Number(process.env.SESSION_HOURS || 12) * 3600000;
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

let SECRET = process.env.SESSION_SECRET;
exports.ephemeralSecret = false;
if (!SECRET || SECRET.length < 16) {
  // Without SESSION_SECRET we still work, but everyone is signed out whenever the server restarts.
  SECRET = crypto.randomBytes(32).toString('hex');
  exports.ephemeralSecret = true;
}

function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function hmac(s) { return b64url(crypto.createHmac('sha256', SECRET).update(s).digest()); }
function safeEqual(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }

function b58decode(s) {
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    const v = ALPHABET.indexOf(s[i]);
    if (v < 0) throw new Error('invalid address');
    let carry = v;
    for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 0xff; carry >>= 8; }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (let k = 0; k < s.length && s[k] === '1'; k++) bytes.push(0);
  return Buffer.from(bytes.reverse());
}
exports.b58decode = b58decode;

function pubKeyOf(address) {
  const raw = b58decode(address);
  if (raw.length !== 32) throw new Error('invalid address');
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: 'der', type: 'spki' });
}

exports.challenge = function (address, now) {
  pubKeyOf(address); // validates the address
  const issued = now || Date.now(), nonce = crypto.randomBytes(12).toString('hex');
  const body = 'Sign in to Cardume\n\nThis signature proves you own this wallet. It is free and cannot move your funds.\n\nAddress: ' + address + '\nIssued: ' + issued + '\nNonce: ' + nonce;
  return { message: body + '\nTag: ' + hmac('ch|' + address + '|' + issued + '|' + nonce) };
};

// Verifies the signed challenge and returns a session token.
exports.login = function (address, message, signatureB64, now) {
  now = now || Date.now();
  const line = function (k) { const m = String(message).match(new RegExp('^' + k + ': (.+)$', 'm')); return m ? m[1] : ''; };
  const a = line('Address'), issued = Number(line('Issued')), nonce = line('Nonce'), tag = line('Tag');
  if (a !== address) throw new Error('This sign-in request is for a different wallet');
  if (!safeEqual(tag, hmac('ch|' + address + '|' + issued + '|' + nonce))) throw new Error('Invalid sign-in request. Please try again.');
  if (!(issued > 0) || now - issued > CHALLENGE_TTL_MS || issued - now > 60000) throw new Error('The sign-in request expired. Please try again.');
  let ok = false;
  try { ok = crypto.verify(null, Buffer.from(message, 'utf8'), pubKeyOf(address), Buffer.from(String(signatureB64), 'base64')); } catch (e) { ok = false; }
  if (!ok) throw new Error('The signature does not match this wallet');
  const exp = now + SESSION_TTL_MS;
  const payload = b64url(JSON.stringify({ a: address, exp: exp }));
  return { token: payload + '.' + hmac('tk|' + payload), address: address, expiresAt: exp };
};

// Returns the wallet address of a valid session token, or null.
exports.verifyToken = function (token, now) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2 || !safeEqual(parts[1], hmac('tk|' + parts[0]))) return null;
  try {
    const p = JSON.parse(Buffer.from(parts[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return p && p.a && p.exp > (now || Date.now()) ? p.a : null;
  } catch (e) { return null; }
};
