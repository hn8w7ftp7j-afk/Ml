import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const manifest = JSON.parse(fs.readFileSync('reader/manifest.json', 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.name, 'Tai888 Reader');
assert.equal(manifest.version, '2.1.10');
assert.equal(manifest.version_name, '2.1.10 INTEGRATED-PARTIAL-SAFE');
assert.deepEqual(
  [...manifest.permissions].sort(),
  ['alarms', 'storage', 'webNavigation'].sort(),
);
for (const forbidden of ['tabs', 'cookies', 'downloads', 'history', 'scripting', 'webRequest', 'webRequestBlocking', 'management', 'nativeMessaging']) {
  assert.equal(manifest.permissions.includes(forbidden), false, `forbidden permission: ${forbidden}`);
}
assert.equal(manifest.host_permissions.includes('<all_urls>'), false);
assert.deepEqual(
  [...manifest.host_permissions].sort(),
  ['https://*.tai888.in/*', 'https://tai888.in/*', 'https://mlb-positive-ev.vercel.app/*'].sort(),
);
assert.deepEqual(
  manifest.content_scripts[0].js,
  ['capture-policy.js', 'league-registry.js', 'row-normalizer.js', 'tai888-content.js'],
);
assert.equal(manifest.content_scripts[0].all_frames, true);
assert.equal(manifest.content_scripts[0].match_origin_as_fallback, true);

const background = fs.readFileSync('reader/background.js', 'utf8');
assert.equal(fs.existsSync('reader/board-selector.js'), true);
assert.match(background, /const VERSION = '2\.1\.10'/);
assert.match(background, /selectAuthoritativeBoard/);
assert.doesNotMatch(background, /captures\.flatMap|tables:\s*captures\.flatMap/);
assert.match(background, /lastSuccessfulPayloadHashes/);
assert.match(background, /delayInMinutes: \.5/);
assert.match(background, /periodInMinutes: 1/);
assert.match(background, /function request/);
assert.doesNotMatch(background, /chrome\.cookies|document\.cookie|localStorage|sessionStorage/i);
// Pairing password is sent once in a POST body, but every storage write must use an explicit allow-list without password keys.
assert.match(background, /password: String\(password \|\| ''\)/);
const storageSetBodies = [...background.matchAll(/chrome\.storage\.local\.set\(\{([\s\S]*?)\}\)/g)].map(match => match[1]);
assert.ok(storageSetBodies.length >= 4);
for (const body of storageSetBodies) {
  assert.doesNotMatch(body, /\b(password|readerPassword|tai888Password)\b/i);
}
assert.match(background, /readerToken/);
assert.match(background, /X-Device-Id/);
assert.doesNotMatch(background, /document\.title|(?:document\.)?location\.href/);
assert.match(background, /function safeUrl/);
assert.match(background, /function sanitizeCapture/);
assert.doesNotMatch(background, /frameUrl:\s*frame\.url/);
assert.doesNotMatch(background, /capture:\s*response\?\.capture\?\.diagnostics/);
assert.doesNotMatch(background, /error:\s*response\?\.error/);
assert.match(background, /remove\(\['readerStatus', 'pairError'\]\)/);

assert.doesNotMatch(background, /pageTitle|unexpectedPrivateValue/);
assert.match(background, /pageUrl: safeUrl\(input\.pageUrl\)/);
assert.match(background, /frameUrl: safeUrl\(input\.frameUrl\)/);
assert.match(background, /LEAGUES\.includes\(input\.league\) \? input\.league : null/);

const content = fs.readFileSync('reader/tai888-content.js', 'utf8');
assert.doesNotMatch(content, /input\[type=["']password|document\.cookie|localStorage|sessionStorage|fetch\(/i);
assert.match(content, /standardLeague|normalizeRowRecords/i);
assert.doesNotMatch(content, /document\.title|(?:document\.)?location\.href/);
assert.match(content, /document\.location\.origin/);
assert.match(content, /document\.location\.pathname/);
assert.match(content, /\^#\\\/BS/);
assert.match(content, /getComputedStyle\(node, '::before'\)/);
assert.match(content, /getComputedStyle\(node, '::after'\)/);
assert.equal(content.includes('\\\\f023'), true);
assert.match(content, /aria-disabled/);
assert.doesNotMatch(content, /TAI888_BOARD_MUTATED[^\n]*pageUrl/);

const browserParser = fs.readFileSync('reader/parser.js', 'utf8');
assert.match(browserParser, /export function sanitizeTai888PageUrl/);
assert.match(browserParser, /pageUrl = sanitizeTai888PageUrl\(capture\?\.pageUrl\)/);
assert.doesNotMatch(browserParser, /pageTitle\s*:/);
assert.doesNotMatch(browserParser, /frameUrl\s*:/);

const serverParser = fs.readFileSync('lib/tai888-reader-parser-v2.js', 'utf8');
assert.match(serverParser, /export function sanitizeTai888PageUrl/);
assert.match(serverParser, /pageUrl: sanitizeTai888PageUrl\(envelope\.pageUrl \|\| payload\.pageUrl\)/);
assert.doesNotMatch(serverParser, /pageTitle:\s*clean/);
assert.doesNotMatch(serverParser, /pageUrl:\s*clean/);
assert.match(serverParser, /!Object\.hasOwn\(snapshot \|\| \{\}, 'pageTitle'\)/);
assert.match(serverParser, /!Object\.hasOwn\(snapshot \|\| \{\}, 'frameUrl'\)/);

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
assert.match(ingest, /readerSnapshotIsComplete|部分解析/);
assert.match(ingest, /allRequiredWritesSucceeded|Runtime Cache/);

console.log('Reader 2.0.3 static security audit: minimal permissions, single-frame board selection, no credential storage, signed device token and strict origins PASS');
