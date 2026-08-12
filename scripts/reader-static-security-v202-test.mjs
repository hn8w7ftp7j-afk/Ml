import assert from 'node:assert/strict';
import fs from 'node:fs';

const manifest = JSON.parse(fs.readFileSync('reader/manifest.json', 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.name, 'Tai888 Reader');
assert.equal(manifest.version, '2.0.2');
assert.deepEqual(
  [...manifest.permissions].sort(),
  ['alarms', 'storage', 'webNavigation'].sort(),
);
for (const forbidden of ['cookies', 'downloads', 'history', 'scripting', 'webRequest', 'webRequestBlocking', 'management', 'nativeMessaging']) {
  assert.equal(manifest.permissions.includes(forbidden), false, `forbidden permission: ${forbidden}`);
}
assert.equal(manifest.host_permissions.includes('<all_urls>'), false);
assert.deepEqual(
  [...manifest.host_permissions].sort(),
  ['https://*.tai888.in/*', 'https://tai888.in/*', 'https://mlb-positive-ev.vercel.app/*'].sort(),
);
assert.deepEqual(
  manifest.content_scripts[0].js,
  ['capture-policy.js', 'row-normalizer.js', 'tai888-content.js'],
);
assert.equal(manifest.content_scripts[0].all_frames, true);
assert.equal(manifest.content_scripts[0].match_origin_as_fallback, true);

const background = fs.readFileSync('reader/background.js', 'utf8');
assert.match(background, /const READER_VERSION = '2\.0\.2'/);
assert.match(background, /delayInMinutes: 0\.5/);
assert.match(background, /periodInMinutes: 1/);
assert.match(background, /fetchWithTimeout/);
assert.match(background, /PAIR_TIMEOUT_MS = 20_000/);
assert.match(background, /INGEST_TIMEOUT_MS = 45_000/);
assert.doesNotMatch(background, /chrome\.cookies|document\.cookie|localStorage|sessionStorage/i);
assert.doesNotMatch(background, /password\s*:/i, 'The request property is allowed but secrets must never be persisted');
assert.doesNotMatch(background, /set\([^)]*password|readerPassword|tai888Password/i);
assert.match(background, /readerToken/);
assert.match(background, /X-Device-Id/);

const content = fs.readFileSync('reader/tai888-content.js', 'utf8');
assert.doesNotMatch(content, /input\[type=["']password|document\.cookie|localStorage|sessionStorage|fetch\(/i);
assert.match(content, /standard MLB|標準 MLB|normalizeRowRecords/i);

const auth = fs.readFileSync('lib/reader-auth-v2.js', 'utf8');
assert.match(auth, /aud: 'mlb-positive-ev-reader'/);
assert.match(auth, /readerOriginAllowed/);
assert.match(auth, /chrome-extension/);
assert.doesNotMatch(auth, /process\.env\.SESSION_SECRET\s*\|\|\s*process\.env\.APP_PASSWORD/);

const pair = fs.readFileSync('app/api/reader/pair/route.js', 'utf8');
const ingest = fs.readFileSync('app/api/reader/ingest/route.js', 'utf8');
const status = fs.readFileSync('app/api/reader/status/route.js', 'utf8');
for (const source of [pair, ingest, status]) {
  assert.match(source, /readerOriginAllowed/);
  assert.match(source, /403/);
}
assert.match(ingest, /X-Device-Id|x-device-id/i);
assert.match(ingest, /部分解析/);
assert.match(ingest, /Runtime Cache/);

console.log('Reader 2.0.2 static security audit: minimal permissions, no credential access, signed device token and strict origins PASS');
