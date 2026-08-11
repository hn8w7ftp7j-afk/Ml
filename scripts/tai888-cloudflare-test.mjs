import assert from 'node:assert/strict';
import { isCloudflareChallengeForTest } from '../lib/tai888-source.js';

assert.equal(isCloudflareChallengeForTest(403, { server: 'cloudflare' }, '<title>Just a moment...</title>'), true);
assert.equal(isCloudflareChallengeForTest(403, { server: 'nginx' }, '<html>Forbidden</html>'), false);
assert.equal(isCloudflareChallengeForTest(200, { server: 'cloudflare' }, '<title>Just a moment...</title>'), false);
console.log(JSON.stringify({ ok: true, cloudflareBlockedState: true }, null, 2));
