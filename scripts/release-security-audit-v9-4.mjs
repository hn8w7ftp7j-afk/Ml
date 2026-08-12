import assert from 'node:assert/strict';
import fs from 'node:fs';

const manifest = JSON.parse(fs.readFileSync('reader/manifest.json', 'utf8'));
assert.equal(manifest.version, '2.0.0');
assert.deepEqual(
  [...manifest.host_permissions].sort(),
  ['https://mlb-positive-ev.vercel.app/*', 'https://www1.tai888.in/*'].sort(),
);
assert.equal((manifest.permissions || []).includes('cookies'), false);

const background = fs.readFileSync('reader/background.js', 'utf8');
assert.doesNotMatch(background, /chrome\.cookies|document\.cookie|localStorage.*password/i);
assert.match(background, /periodInMinutes: 1/);

const security = fs.readFileSync('lib/security.js', 'utf8');
assert.match(security, /TAI888_PASSWORD/);

const score = fs.readFileSync('lib/deterministic-score.js', 'utf8');
assert.match(score, /GENERAL_SINGLE_BET_MAX_8_9/);
assert.doesNotMatch(score, /openai|gpt/i);

const finalizer = fs.readFileSync('lib/deterministic-finalizer.js', 'utf8');
assert.match(finalizer, /noGptScoring: true/);

const settlement = fs.readFileSync('lib/taiwan-settlement-v9.js', 'utf8');
assert.match(settlement, /settledPrincipal/);
assert.match(settlement, /Decimal/);

const middleware = fs.readFileSync('middleware.js', 'utf8');
for (const route of ['/api/reader/pair', '/api/reader/ingest', '/api/reader/status']) assert.match(middleware, new RegExp(route.replaceAll('/', '\\/')));

console.log('release security/static audit v9.4: ok');
