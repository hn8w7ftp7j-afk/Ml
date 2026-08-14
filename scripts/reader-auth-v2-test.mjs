import assert from 'node:assert/strict';
delete process.env.READER_PAIR_SECRET;
process.env.TAI888_PASSWORD = 'must-not-be-a-reader-secret';
const {
  createReaderToken,
  verifyReaderToken,
  readerPairingConfigured,
  readerPairPasswordMatches,
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
assert.equal(await verifyReaderToken(`${token}x`), null);
console.log('reader auth v2: ok');
