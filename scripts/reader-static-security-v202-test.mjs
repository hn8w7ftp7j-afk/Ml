import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const manifest = JSON.parse(fs.readFileSync('reader/manifest.json', 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.name, 'Tai888 Reader');
assert.equal(manifest.version, '2.0.8');
assert.equal(manifest.version_name, '2.0.8 RENDERED LOCK FIX');
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
  ['capture-policy.js', 'row-normalizer.js', 'tai888-content.js'],
);
assert.equal(manifest.content_scripts[0].all_frames, true);
assert.equal(manifest.content_scripts[0].match_origin_as_fallback, true);

const background = fs.readFileSync('reader/background.js', 'utf8');
assert.equal(fs.existsSync('reader/board-selector.js'), true);
assert.match(background, /const READER_VERSION = '2\.0\.8'/);
assert.match(background, /selectAuthoritativeBoard/);
assert.doesNotMatch(background, /captures\.flatMap|tables:\s*captures\.flatMap/);
assert.match(background, /lastSuccessfulPayloadHash/);
assert.match(background, /delayInMinutes: 0\.5/);
assert.match(background, /periodInMinutes: 1/);
assert.match(background, /fetchWithTimeout/);
assert.match(background, /PAIR_TIMEOUT_MS = 20_000/);
assert.match(background, /INGEST_TIMEOUT_MS = 45_000/);
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
assert.match(background, /function sanitizeTai888PageUrl/);
assert.match(background, /function sanitizeCaptureMetadata/);
assert.match(background, /function sanitizeCaptureDiagnostics/);
assert.match(background, /const pageUrl = sanitizeTai888PageUrl\(input\.pageUrl\)/);
assert.match(background, /const frameUrl = sanitizeTai888PageUrl\(input\.frameUrl\)/);
assert.match(background, /frameUrl: sanitizeTai888PageUrl\(frame\.url\)/);
assert.doesNotMatch(background, /frameUrl:\s*frame\.url/);
assert.doesNotMatch(background, /capture:\s*response\?\.capture\?\.diagnostics/);
assert.doesNotMatch(background, /error:\s*response\?\.error/);
assert.match(background, /remove\(\['readerStatus', 'pairError'\]\)/);

const listeners = { addListener() {} };
const backgroundContext = {
  URL,
  globalThis: {},
  chrome: {
    runtime: { onInstalled: listeners, onStartup: listeners, onMessage: listeners },
    alarms: { onAlarm: listeners },
    tabs: { onUpdated: listeners },
  },
};
vm.createContext(backgroundContext);
vm.runInContext(
  `${background.replace(/^import\b[\s\S]*?;\s*/gm, '')}\n`
    + 'globalThis.__privacy = { sanitizeTai888PageUrl, sanitizeCaptureMetadata };',
  backgroundContext,
);
const privateCapture = {
  version: 'TAI888-DOM-CAPTURE-v2.0.8',
  sourceHost: 'www1.tai888.in',
  pageUrl: 'https://www1.tai888.in/newapp/?token=BACKGROUND_QUERY_SECRET#/BS?session=BACKGROUND_HASH_SECRET',
  frameUrl: 'https://www1.tai888.in/frame?token=BACKGROUND_FRAME_SECRET#private',
  pageTitle: 'BACKGROUND_TITLE_SECRET',
  observedAt: '2026-08-15T00:00:00Z',
  tables: [{ headers: [], rows: [] }],
  diagnostics: {
    expectedGameCount: 1,
    gameCount: 1,
    lastMutationAt: '2026-08-15T00:00:00Z',
    unexpectedPrivateValue: 'BACKGROUND_DIAGNOSTIC_SECRET',
  },
};
const safeCapture = backgroundContext.globalThis.__privacy.sanitizeCaptureMetadata(privateCapture);
assert.equal(safeCapture.pageUrl, 'https://www1.tai888.in/newapp/#/BS');
assert.equal(safeCapture.frameUrl, 'https://www1.tai888.in/frame');
const safeCaptureJson = JSON.stringify(safeCapture);
for (const secret of [
  'BACKGROUND_QUERY_SECRET', 'BACKGROUND_HASH_SECRET', 'BACKGROUND_FRAME_SECRET',
  'BACKGROUND_TITLE_SECRET', 'BACKGROUND_DIAGNOSTIC_SECRET',
]) {
  assert.equal(safeCaptureJson.includes(secret), false, `${secret} must not survive background allow-list`);
}

const content = fs.readFileSync('reader/tai888-content.js', 'utf8');
assert.doesNotMatch(content, /input\[type=["']password|document\.cookie|localStorage|sessionStorage|fetch\(/i);
assert.match(content, /standard MLB|標準 MLB|normalizeRowRecords/i);
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
