import assert from 'node:assert/strict';
import { appPasswordConfigured, checkRateLimit, cleanText, createSessionToken, passwordMatches, positiveInteger, readJsonBody, requestIsAuthenticated, sessionSecretConfigured, siteAuthConfigured, validDateString, validateSameOrigin, verifySessionToken } from '../lib/security.js';
import { marketIsOpen, validateMarketPair } from '../lib/markets.js';

process.env.APP_PASSWORD = 'test-password';
process.env.SESSION_SECRET = 'test-session-secret-with-sufficient-entropy';

assert.equal(await passwordMatches('test-password'), true);
assert.equal(await passwordMatches('wrong-password'), false);
const token = await createSessionToken(60);
assert.equal(await verifySessionToken(token), true);
assert.equal(await verifySessionToken(`${token}x`), false);
assert.equal(siteAuthConfigured(), true);
assert.equal(sessionSecretConfigured(), true);

delete process.env.SESSION_SECRET;
process.env.TAI888_PASSWORD = 'must-not-be-a-session-secret';
assert.equal(sessionSecretConfigured(), false);
assert.equal(siteAuthConfigured(), false);
assert.equal(await requestIsAuthenticated(new Request('https://example.com')), false);
process.env.SESSION_SECRET = 'test-session-secret-with-sufficient-entropy';

delete process.env.APP_PASSWORD;
process.env.TAI888_PASSWORD = 'must-not-be-a-site-password';
assert.equal(appPasswordConfigured(), false);
process.env.APP_PASSWORD = 'test-password';

assert.equal(validDateString('2026-08-08'), true);
assert.equal(validDateString('2026-02-30'), false);
assert.equal(positiveInteger('123'), 123);
assert.equal(positiveInteger('-1'), null);
assert.equal(cleanText('abc\u0000def', 20), 'abcdef');

const same = new Request('https://example.com/api/test', { method: 'POST', headers: { origin: 'https://example.com', 'sec-fetch-site': 'same-origin' } });
const cross = new Request('https://example.com/api/test', { method: 'POST', headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } });
assert.equal(validateSameOrigin(same), true);
assert.equal(validateSameOrigin(cross), false);

const jsonRequest = new Request('https://example.com/api/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: true }) });
assert.deepEqual(await readJsonBody(jsonRequest, 1024), { ok: true });
await assert.rejects(() => readJsonBody(new Request('https://example.com', { method: 'POST', body: 'x'.repeat(50) }), 10), /資料過大/);

const rateRequest = new Request('https://example.com/api/test', { headers: { 'x-forwarded-for': '203.0.113.9' } });
assert.equal(checkRateLimit(rateRequest, { id: 'unit', limit: 1, windowMs: 60000 }).allowed, true);
assert.equal(checkRateLimit(rateRequest, { id: 'unit', limit: 1, windowMs: 60000 }).allowed, false);

assert.equal(marketIsOpen([{ pick: '' }, { pick: '' }]), false);
assert.equal(marketIsOpen([{ pick: '大8平' }, { pick: '小8平' }]), true);
assert.deepEqual(validateMarketPair('上半讓分', [{ pick: '', water: .95 }, { pick: '', water: .95 }]), []);
assert.ok(validateMarketPair('全場大小', [{ pick: '大8平', water: .95 }, { pick: '', water: .95 }]).length > 0);

console.log('Security and input validation tests passed');
