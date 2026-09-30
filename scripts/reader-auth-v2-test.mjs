import assert from 'node:assert/strict';
import { register } from 'node:module';
register('./next-route-test-loader.mjs', import.meta.url);
delete process.env.READER_PAIR_SECRET;
process.env.TAI888_PASSWORD = 'must-not-be-a-reader-secret';
const {
  createReaderToken,
  verifyReaderToken,
  readerPairingConfigured,
  readerPairPasswordMatches,
  READER_TOKEN_TTL_SECONDS,
} = await import('../lib/reader-auth-v2.js');
assert.equal(readerPairingConfigured(), false);
assert.equal(await readerPairPasswordMatches('must-not-be-a-reader-secret'), false);
await assert.rejects(() => createReaderToken({ deviceId: 'device-12345678' }), /not configured/i);

process.env.READER_PAIR_SECRET = 'reader-test-secret-123';
assert.equal(readerPairingConfigured(), true);
assert.equal(await readerPairPasswordMatches('reader-test-secret-123'), true);
assert.equal(await readerPairPasswordMatches('wrong'), false);
const token = await createReaderToken({ deviceId: 'device-12345678', deviceName: 'test' });
const verified = await verifyReaderToken(token);
assert.equal(verified.deviceId, 'device-12345678');
assert.equal(verified.exp - verified.iat, READER_TOKEN_TTL_SECONDS);
assert.equal(await verifyReaderToken(`${token}x`), null);
const { POST } = await import('../app/api/reader/pair/route.js');
const pairedResponse = await POST(new Request('https://mlb-positive-ev.vercel.app/api/reader/pair', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Reader-Version': '2.1.24',
    Origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'X-Forwarded-For': '192.0.2.202',
  },
  body: JSON.stringify({ password: process.env.READER_PAIR_SECRET, deviceId: 'paired-device-12345678' }),
}));
assert.equal(pairedResponse.status, 200);
const paired = await pairedResponse.json();
const identity = await verifyReaderToken(paired.token);
assert.ok(identity);
assert.equal(paired.expiresInSeconds, identity.exp - identity.iat,
  '配對回應期限必須與簽章 token 的實際期限一致');
console.log('reader auth v2: ok');
