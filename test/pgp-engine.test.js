// node test/pgp-engine.test.js
//
// The classic PGP engine (src/onlykey-lib/pgp-engine.js) end to end, the way
// the Encrypt and Decrypt pages drive it: modes, key fields, events and the
// callback - with openpgp doing the PGP and a fake OnlyKey doing the private
// RSA maths on the key's own secrets, in the slots the device uses.
const assert = require('assert');
const EventEmitter = require('events');
const openpgp = require('node-onlykey-lib/crypto/pgp');
const createPgpEngine = require('../src/onlykey-lib/pgp-engine.js');

const big = (b) => BigInt('0x' + (Buffer.from(b).toString('hex') || '0'));
const bytes = (n, len) => Uint8Array.from(Buffer.from(n.toString(16).padStart(len * 2, '0'), 'hex'));
function modpow(b, e, m) { let r = 1n; b %= m; for (; e > 0n; e >>= 1n) { if (e & 1n) r = r * b % m; b = b * b % m; } return r; }
const DIGEST_INFO = { 32: '3031300d060960864801650304020105000420', 64: '3051300d060960864801650304020305000440' };

function rsa(packet) {
  const { n } = packet.publicParams; const { d } = packet.privateParams; const k = n.length;
  return {
    decrypt(c) { const em = bytes(modpow(big(c), big(d), big(n)), k); return em.subarray(em.indexOf(0, 2) + 1); },
    sign(h) {
      const t = Buffer.concat([Buffer.from(DIGEST_INFO[h.length], 'hex'), Buffer.from(h)]);
      return bytes(modpow(big(Buffer.concat([Buffer.from([0, 1]), Buffer.alloc(k - t.length - 3, 0xff), Buffer.from([0]), t])), big(d), big(n)), k);
    },
  };
}

(async () => {
  const me = await openpgp.generateKey({ type: 'rsa', rsaBits: 2048, userIDs: [{ name: 'Me', email: 'me@example.com' }], format: 'object' });
  const them = await openpgp.generateKey({ type: 'rsa', rsaBits: 2048, userIDs: [{ name: 'Them', email: 'them@example.com' }], format: 'object' });

  // A device per person: the primary signs (slot 2), the subkey decrypts (slot 1).
  const slots = [];
  function device(key) {
    const s = rsa(key.privateKey.keyPacket); const dcr = rsa(key.privateKey.subkeys[0].keyPacket);
    const ok = new EventEmitter();
    ok.sign = async (slot, h) => { slots.push(['sign', slot]); ok.emit('challenge', { digits: [1, 2, 3] }); return s.sign(h); };
    ok.decrypt = async (slot, c) => { slots.push(['decrypt', slot]); return dcr.decrypt(c); };
    return ok;
  }
  let current = device(me);
  const app = new EventEmitter();
  const okLib = { okcrypto: async () => current };
  const window = { document: { getElementById: () => null } };
  const getKey = async (x) => ({ me: me.publicKey.armor(), them: them.publicKey.armor() })[x] || false;
  const engine = () => createPgpEngine({ app, okLib, getKey, window });

  function run(e, method, args) {
    const events = [];
    for (const name of ['working', 'status', 'error', 'done']) e.on(name, (m) => events.push([name, m]));
    return new Promise((resolve) => {
      e[method](...args, (err, data) => resolve({ err, data, events }));
      e.on('error', () => resolve({ err: 'error', events }));
    });
  }

  // Encrypt and Sign: to "them", signed by me on the device.
  const enc = engine(); enc._$mode('Encrypt and Sign');
  const r1 = await run(enc, 'startEncryption', ['them', 'me', 'hello device', null]);
  assert.ifError(r1.err);
  assert.ok(r1.data.includes('BEGIN PGP MESSAGE'));
  assert.ok(r1.events.some(([n, m]) => n === 'status' && m === 'Encrypting and signing message ...'));
  assert.ok(r1.events.some(([n, m]) => n === 'status' && /press 1-2-3 if it asks for a challenge code/.test(m)));
  assert.deepStrictEqual(slots.pop(), ['sign', 2], 'RSA signing key -> slot 2');
  assert.equal(enc._$status(), 'finished');

  // Decrypt and Verify, as "them": their device decrypts in slot 1; my signature verifies.
  current = device(them);
  const dec = engine(); dec._$mode('Decrypt and Verify');
  const r2 = await run(dec, 'startDecryption', ['me', 'them', r1.data, null]);
  assert.ifError(r2.err);
  assert.equal(r2.data, 'hello device');
  assert.deepStrictEqual(slots.pop(), ['decrypt', 1], 'RSA decryption key -> slot 1');
  const done = r2.events.filter(([n]) => n === 'status').pop()[1];
  assert.equal(done, 'Done :) Signed by me (Key ID: ' + me.publicKey.getFingerprint().toUpperCase().slice(-16) + '), Click here to copy message');

  // Sign Only: a signed armored PGP MESSAGE, as the old engine produced.
  current = device(me);
  const sig = engine(); sig._$mode('Sign Only');
  const r3 = await run(sig, 'startEncryption', ['', 'me', 'just signed', null]);
  assert.ifError(r3.err);
  const msg = await openpgp.readMessage({ armoredMessage: r3.data });
  const v = await openpgp.verify({ message: msg, verificationKeys: me.publicKey });
  await v.signatures[0].verified;

  // A message not for your key is named before the device is asked.
  current = device(me);
  const wrong = engine(); wrong._$mode('Decrypt Only');
  const before = slots.length;
  const r4 = await run(wrong, 'startDecryption', ['', 'me', r1.data, null]);
  assert.ok(r4.events.some(([n, m]) => n === 'error' && m === 'Your PublicKey is Not found in message'));
  assert.equal(slots.length, before, 'the device was not asked');

  console.log('pgp-engine: all assertions passed');
})().catch((e) => { console.error(e); process.exit(1); });
