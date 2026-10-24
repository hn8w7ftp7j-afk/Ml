import assert from 'node:assert/strict';
import crypto from 'node:crypto';

export function assertSourceBlob(source, expected, version) {
  const bytes = Buffer.from(source);
  const actual = crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  assert.equal(actual, expected, `Source changed from ${version}; stop and create a new labeled evaluation`);
  return actual;
}
