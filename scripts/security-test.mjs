import assert from 'node:assert/strict';
import fs from 'node:fs';
import { appPasswordConfigured, checkRateLimit, cleanText, createSessionToken, passwordMatches, positiveInteger, readJsonBody, requestIsAuthenticated, sessionSecretConfigured, siteAuthConfigured, validDateString, validateSameOrigin, verifySessionToken } from '../lib/security.js';
import { marketIsOpen, validateMarketPair } from '../lib/markets.js';

process.env.APP_PASSWORD = 'test-password';
process.env.SESSION_SECRET = 'test-session-secret-with-sufficient-entropy';

const loginPage = fs.readFileSync(new URL('../app/login/page.js', import.meta.url), 'utf8');
const authRoute = fs.readFileSync(new URL('../app/api/auth/route.js', import.meta.url), 'utf8');
assert.match(loginPage, /維持登入 7 天/, '登入頁必須顯示實際的7天session期限');
assert.doesNotMatch(loginPage, /維持登入 30 天/, '登入頁不得保留舊的30天session說明');
assert.match(authRoute, /const maxAge = 60 \* 60 \* 24 \* 7;/, '伺服器實際session期限必須與登入頁7天說明一致');

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
assert.deepEqual(validateMarketPair('上半讓分', []), []);
assert.deepEqual(
  validateMarketPair('上半讓分', [{ pick: '', water: .95 }, { pick: '', water: .95 }]),
  ['已開盤市場的方向＋盤口不可空白'],
  '零筆才是未開盤；一旦供應商送入空白列，必須明確 BLOCKED 而不可冒充未開盤',
);
assert.ok(validateMarketPair('全場大小', [{ pick: '大8平', water: .95 }, { pick: '', water: .95 }]).length > 0);

console.log('Security and input validation tests passed');
