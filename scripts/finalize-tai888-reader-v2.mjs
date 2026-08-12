import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const write = (file, content) => {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
};
const remove = file => fs.rmSync(path.join(root, file), { force: true, recursive: true });

function replaceRequired(file, from, to, label = from.slice(0, 80)) {
  const source = read(file);
  if (source.includes(to)) return;
  if (!source.includes(from)) throw new Error(`${file}: missing patch anchor ${label}`);
  write(file, source.replace(from, to));
}

function replaceRegexRequired(file, expression, replacement, label) {
  const source = read(file);
  if (!expression.test(source)) throw new Error(`${file}: missing regex patch anchor ${label}`);
  expression.lastIndex = 0;
  write(file, source.replace(expression, replacement));
}

function replaceEverywhere(file, from, to) {
  if (!fs.existsSync(path.join(root, file))) return;
  const source = read(file);
  const next = source.split(from).join(to);
  if (next !== source) write(file, next);
}

const VERSION = '9.4.0';
const READER_VERSION = '2.0.0';

// Canonical Tai888 host everywhere. Reader never falls back to the retired hostname.
for (const file of [
  '.env.example', 'README.md', 'lib/tai888-source.js',
  'scripts/tai888-source-test.mjs', 'app/api/credit-lines/route.js',
  'reader/manifest.json', 'reader/background.js', 'reader/popup.js',
  'reader/popup.html', 'reader/README.md',
]) {
  replaceEverywhere(file, 'https://xg1.tai888.in', 'https://www1.tai888.in');
  replaceEverywhere(file, 'xg1.tai888.in', 'www1.tai888.in');
}
replaceRequired(
  'lib/tai888-source.js',
  "const DEFAULT_BASE_URL = 'https://www1.tai888.in';",
  "const DEFAULT_BASE_URL = 'https://www1.tai888.in';",
  'canonical Tai888 default',
);

// Keep metadata and dependency/test registry aligned.
{
  const file = 'package.json';
  const pkg = JSON.parse(read(file));
  pkg.version = VERSION;
  pkg.dependencies = { ...(pkg.dependencies || {}), '@vercel/functions': '^3.7.6', 'decimal.js': '^10.6.0' };
  const permanentTests = [
    'node scripts/tai888-reader-dom-v2-test.mjs',
    'node scripts/tai888-reader-parser-v2-test.mjs',
    'node scripts/reader-auth-v2-test.mjs',
    'node scripts/reader-store-v2-test.mjs',
    'node scripts/market-freshness-v1-test.mjs',
    'node scripts/market-verification-v1-test.mjs',
    'node scripts/release-security-audit-v9-4.mjs',
  ];
  const existing = String(pkg.scripts?.test || '').split(' && ').filter(Boolean);
  pkg.scripts = pkg.scripts || {};
  pkg.scripts.test = [...new Set([...existing, ...permanentTests])].join(' && ');
  write(file, `${JSON.stringify(pkg, null, 2)}\n`);
}

// The production site is private by default. Existing TAI888_PASSWORD is the safe server-only fallback.
{
  const file = 'lib/security.js';
  let source = read(file);
  if (!source.includes('function applicationPassword()')) {
    source = source.replace(
      "globalThis.__MLB_EV_RATE_BUCKETS__ = buckets;\n",
      "globalThis.__MLB_EV_RATE_BUCKETS__ = buckets;\n\nfunction applicationPassword() {\n  return String(process.env.APP_PASSWORD || process.env.TAI888_PASSWORD || '');\n}\n",
    );
  }
  source = source.replace(
    "return Boolean(String(process.env.APP_PASSWORD || '').trim());",
    "return Boolean(applicationPassword().trim());",
  );
  source = source.replace(
    "const expected = String(process.env.APP_PASSWORD || '');",
    "const expected = applicationPassword();",
  );
  source = source.split("String(process.env.SESSION_SECRET || process.env.APP_PASSWORD || '')")
    .join("String(process.env.SESSION_SECRET || process.env.APP_PASSWORD || process.env.TAI888_PASSWORD || '')");
  write(file, source);
}

// Reader authentication: exact origins, independent token, no secret storage in the extension.
write('lib/reader-auth-v2.js', `const encoder = new TextEncoder();
const TOKEN_VERSION = 'reader-v2';
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 90;

function pairingSecret() {
  return String(process.env.READER_PAIR_SECRET || process.env.TAI888_PASSWORD || '');
}
function b64urlEncode(value) { return Buffer.from(String(value), 'utf8').toString('base64url'); }
function b64urlDecode(value) { return Buffer.from(String(value), 'base64url').toString('utf8'); }
async function sha256(value) { return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(String(value)))); }
async function hmac(value) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(pairingSecret()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Buffer.from(await crypto.subtle.sign('HMAC', key, encoder.encode(String(value)))).toString('base64url');
}
function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

export function readerPairingConfigured() { return Boolean(pairingSecret()); }
export async function readerPairPasswordMatches(candidate) {
  const expected = pairingSecret();
  if (!expected || typeof candidate !== 'string' || candidate.length > 300) return false;
  return constantTimeEqual(await sha256(candidate), await sha256(expected));
}
export async function createReaderToken({ deviceId, deviceName = '', ttlSeconds = DEFAULT_TTL_SECONDS } = {}) {
  if (!readerPairingConfigured()) throw new Error('Reader pairing secret is not configured');
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    v: TOKEN_VERSION,
    aud: 'mlb-positive-ev-reader',
    deviceId: String(deviceId || '').slice(0, 100),
    deviceName: String(deviceName || '').slice(0, 100),
    iat: now,
    exp: now + Math.max(3600, Math.min(Number(ttlSeconds) || DEFAULT_TTL_SECONDS, DEFAULT_TTL_SECONDS)),
  };
  if (!/^[a-zA-Z0-9._:-]{8,100}$/.test(payload.deviceId)) throw new Error('Reader device id is invalid');
  const body = b64urlEncode(JSON.stringify(payload));
  return \`${TOKEN_VERSION}.\${body}.\${await hmac(\`${TOKEN_VERSION}.\${body}\`)}\`;
}
export async function verifyReaderToken(token) {
  if (!readerPairingConfigured() || !token) return null;
  const [version, body, signature] = String(token).split('.');
  if (version !== TOKEN_VERSION || !body || !signature) return null;
  const expected = await hmac(\`${version}.\${body}\`);
  if (!constantTimeEqual(signature, expected)) return null;
  let payload;
  try { payload = JSON.parse(b64urlDecode(body)); } catch { return null; }
  if (payload?.v !== TOKEN_VERSION || payload?.aud !== 'mlb-positive-ev-reader') return null;
  if (!/^[a-zA-Z0-9._:-]{8,100}$/.test(String(payload.deviceId || ''))) return null;
  if (!Number.isInteger(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) return null;
  return payload;
}
export function bearerToken(request) {
  const match = (request.headers.get('authorization') || '').match(/^Bearer\\s+(.+)$/i);
  return match ? match[1].trim() : '';
}
export function readerOriginAllowed(request) {
  const origin = request.headers.get('origin') || '';
  if (!origin) return true;
  return /^chrome-extension:\\/\\/[a-p]{32}$/i.test(origin)
    || origin === 'https://mlb-positive-ev.vercel.app';
}
export function readerCorsHeaders(request) {
  const origin = request.headers.get('origin') || '';
  const allowed = readerOriginAllowed(request);
  return {
    'Access-Control-Allow-Origin': allowed && origin ? origin : 'null',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type,X-Reader-Version,X-Device-Id',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Origin',
  };
}
`);

// Reader latest-board storage. Runtime Cache is mandatory on Vercel; memory is only a local-test fallback.
write('lib/reader-store-v2.js', `const CACHE_PREFIX = 'mlb-ev:tai888-reader:v2';
const DEFAULT_TTL_SECONDS = 60 * 60 * 12;
const FRESH_SECONDS = 180;
const MAX_SNAPSHOT_BYTES = 1_500_000;
const memory = globalThis.__MLB_EV_READER_STORE_V2__ || new Map();
globalThis.__MLB_EV_READER_STORE_V2__ = memory;

async function runtimeCache() {
  if (process.env.READER_STORE_MEMORY_ONLY === 'true') return null;
  try { return (await import('@vercel/functions')).getCache(); } catch { return null; }
}
function keyFor(date) { return date ? \`${CACHE_PREFIX}:date:\${date}\` : \`${CACHE_PREFIX}:latest\`; }
async function remoteGet(key) {
  const cache = await runtimeCache();
  if (!cache) return null;
  try { return await cache.get(key); } catch { return null; }
}
async function remoteSet(key, value, ttl = DEFAULT_TTL_SECONDS) {
  const cache = await runtimeCache();
  if (!cache) return false;
  try {
    await cache.set(key, value, {
      ttl,
      tags: ['tai888-reader', \`tai888-reader-\${value?.boardDate || 'unknown'}\`],
      name: 'Tai888 Reader latest board',
    });
    return true;
  } catch { return false; }
}
export async function storeReaderSnapshot(snapshot, ttl = DEFAULT_TTL_SECONDS) {
  if (!snapshot || typeof snapshot !== 'object') throw new Error('Reader snapshot is invalid');
  const bytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
  if (bytes > MAX_SNAPSHOT_BYTES) throw new Error('Reader snapshot exceeds safe storage size');
  const latestKey = keyFor();
  const dateKey = keyFor(snapshot.boardDate);
  memory.set(latestKey, snapshot);
  if (snapshot.boardDate) memory.set(dateKey, snapshot);
  const stored = await Promise.all([
    remoteSet(latestKey, snapshot, ttl),
    snapshot.boardDate ? remoteSet(dateKey, snapshot, ttl) : Promise.resolve(false),
  ]);
  return { runtimeCache: stored.some(Boolean), memory: true, bytes };
}
export async function refreshReaderSnapshot(previous, { observedAt, receivedAt, readerVersion } = {}) {
  if (!previous) return null;
  const next = {
    ...previous,
    observedAt: observedAt || previous.observedAt,
    receivedAt: receivedAt || new Date().toISOString(),
    readerVersion: readerVersion || previous.readerVersion,
  };
  await storeReaderSnapshot(next);
  return next;
}
export async function loadReaderSnapshot(date = '') {
  const dateKey = date ? keyFor(date) : '';
  if (dateKey) {
    const remoteDate = await remoteGet(dateKey);
    if (remoteDate) return remoteDate;
    const memoryDate = memory.get(dateKey);
    if (memoryDate) return memoryDate;
  }
  const remoteLatest = await remoteGet(keyFor());
  if (remoteLatest) return remoteLatest;
  return memory.get(keyFor()) || null;
}
export function readerSnapshotStatus(snapshot, now = Date.now()) {
  if (!snapshot) return { available: false, fresh: false, stale: false, ageSeconds: null, state: 'missing', message: '尚未收到 Tai888 Reader 盤口' };
  const timestamp = Date.parse(snapshot.receivedAt || snapshot.observedAt || '');
  const ageSeconds = Number.isFinite(timestamp) ? Math.max(0, Math.floor((now - timestamp) / 1000)) : Number.POSITIVE_INFINITY;
  const fresh = ageSeconds <= Number(snapshot.freshnessTtlSeconds || FRESH_SECONDS);
  return {
    available: true,
    fresh,
    stale: !fresh,
    ageSeconds: Number.isFinite(ageSeconds) ? ageSeconds : null,
    state: fresh ? 'fresh' : 'stale',
    message: fresh
      ? \`Tai888 Reader 已同步 \${snapshot.matchedGameCount || snapshot.games?.length || 0} 場\`
      : 'Tai888 Reader 盤口已過期，請確認電腦、Chrome 與 Tai888 頁面仍保持開啟',
  };
}
export const READER_STORE_VERSION = 'TAI888-RUNTIME-CACHE-v2.0.1';
export const READER_FRESH_SECONDS = FRESH_SECONDS;
`);

// Formal market freshness is enforced again inside analyze/reprice, independent of UI state.
write('lib/market-freshness-v1.js', `export const ACTUAL_LINE_FRESHNESS_MS = 5 * 60 * 1000;
export const ALLOWED_FUTURE_SKEW_MS = 90 * 1000;

export function applyMarketFreshness(row, now = Date.now()) {
  const result = { ...(row || {}) };
  const actual = result.sourceType === 'ACTUAL_TW_CREDIT';
  if (!actual) {
    return {
      ...result,
      executable: result.executable === true,
      lineFresh: true,
      lineAgeSeconds: null,
      executionStatus: result.executable === true ? 'REFERENCE_ONLY' : 'NON_EXECUTABLE',
    };
  }
  const timestamp = Date.parse(result.lineAsOf || '');
  if (!Number.isFinite(timestamp)) {
    return { ...result, executable: false, lineFresh: false, lineAgeSeconds: null, executionStatus: 'UNCONFIRMED_LINE_TIME' };
  }
  const ageMs = now - timestamp;
  const fresh = ageMs >= -ALLOWED_FUTURE_SKEW_MS && ageMs <= ACTUAL_LINE_FRESHNESS_MS;
  return {
    ...result,
    executable: result.executable !== false && fresh,
    lineFresh: fresh,
    lineAgeSeconds: Math.max(0, Math.floor(ageMs / 1000)),
    executionStatus: fresh ? (result.executable === false ? 'UNCONFIRMED' : 'EXECUTABLE') : ageMs < 0 ? 'FUTURE_TIMESTAMP_REJECTED' : 'EXPIRED',
  };
}
`);

// Two truly independent, exact same-contract sources are only a qualification gate for 8.5.
write('lib/market-verification-v1.js', `import { parseTaiwanLine } from './markets.js';

const normalize = value => String(value || '').toLowerCase().replace(/[^a-z0-9\\u4e00-\\u9fff]/g, '');
const providerGroup = row => {
  const provider = String(row?.provider || row?.sourceLabel || '').toUpperCase();
  if (provider.includes('TAI888')) return 'TAI888';
  if (provider.includes('THE_ODDS_API')) return 'THE_ODDS_API';
  if (provider.includes('JBOT')) return 'JBOT';
  return provider || '';
};
function signature(row) {
  const parsed = parseTaiwanLine(row?.pick);
  if (!parsed.valid) return '';
  const side = parsed.isTotal
    ? (parsed.isOver ? 'over' : 'under')
    : \`${parsed.isGiving ? 'giving' : 'receiving'}:\${normalize(parsed.team)}\`;
  return \`${row.market}|\${side}|\${parsed.lineText}|\${parsed.modifier || ''}\`;
}
function source(row, contractKey) {
  const provider = String(row?.provider || row?.sourceLabel || '').slice(0, 80);
  const independentGroup = providerGroup(row);
  const observedAt = String(row?.lineAsOf || '').slice(0, 40);
  if (!provider || !independentGroup || !Number.isFinite(Date.parse(observedAt))) return null;
  return { provider, independentGroup, observedAt, contractKey };
}
export function applyIndependentMarketVerification(actualMarkets, referenceMarkets, toleranceMs = 30 * 60 * 1000) {
  const references = Array.isArray(referenceMarkets) ? referenceMarkets : [];
  return (Array.isArray(actualMarkets) ? actualMarkets : []).map(row => {
    if (row?.sourceType !== 'ACTUAL_TW_CREDIT') return row;
    const contractKey = signature(row);
    if (!contractKey) return { ...row, marketVerification: null };
    const actualSource = source(row, contractKey);
    const match = references.find(reference => {
      if (!['REFERENCE', 'INTERNATIONAL'].includes(reference?.sourceType)) return false;
      if (signature(reference) !== contractKey) return false;
      const left = Date.parse(row.lineAsOf || '');
      const right = Date.parse(reference.lineAsOf || '');
      return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= toleranceMs;
    });
    const referenceSource = match ? source(match, contractKey) : null;
    const sources = [actualSource, referenceSource].filter(Boolean);
    const groups = new Set(sources.map(item => item.independentGroup));
    return {
      ...row,
      marketVerification: {
        verified: sources.length >= 2 && groups.size >= 2,
        sources,
        policyStatus: sources.length >= 2 && groups.size >= 2 ? 'TWO_INDEPENDENT_EXACT_CONTRACTS' : 'EXACT_SECOND_SOURCE_NOT_FOUND',
      },
    };
  });
}
`);

// Reader public endpoints reject unrelated browser origins.
for (const file of ['app/api/reader/pair/route.js', 'app/api/reader/ingest/route.js', 'app/api/reader/status/route.js']) {
  let source = read(file);
  source = source.replace('readerCorsHeaders,\n', 'readerCorsHeaders,\n  readerOriginAllowed,\n');
  source = source.replace('readerCorsHeaders }', 'readerCorsHeaders, readerOriginAllowed }');
  source = source.replace('const headers = readerCorsHeaders(request);\n  try {', "const headers = readerCorsHeaders(request);\n  if (!readerOriginAllowed(request)) return NextResponse.json({ ok: false, error: '不允許的 Reader 請求來源' }, { status: 403, headers });\n  try {");
  source = source.replace('const headers = readerCorsHeaders(request);\n  const rate =', "const headers = readerCorsHeaders(request);\n  if (!readerOriginAllowed(request)) return NextResponse.json({ ok: false, error: '不允許的 Reader 請求來源' }, { status: 403, headers });\n  const rate =");
  write(file, source);
}

// Same-price heartbeat refreshes the shared snapshot without refetching three MLB schedules.
{
  const file = 'app/api/reader/ingest/route.js';
  let source = read(file);
  source = source.replace(
    "import { storeReaderSnapshot, readerSnapshotStatus } from '../../../../lib/reader-store-v2.js';",
    "import { loadReaderSnapshot, refreshReaderSnapshot, storeReaderSnapshot, readerSnapshotStatus } from '../../../../lib/reader-store-v2.js';",
  );
  const anchor = "    const receivedAt = new Date().toISOString();\n    const schedule = await scheduleWindow(boardDate);";
  const replacement = `    const receivedAt = new Date().toISOString();
    const payloadHash = cleanText(body.payloadHash, 80);
    const previous = await loadReaderSnapshot(boardDate);
    if (/^[a-f0-9]{64}$/i.test(payloadHash)
      && previous?.payloadHash === payloadHash
      && previous?.deviceId === token.deviceId
      && previous?.sourceHost === cleanText(body.sourceHost, 200).toLowerCase()) {
      const refreshed = await refreshReaderSnapshot(previous, {
        observedAt: cleanText(body.observedAt, 60),
        receivedAt,
        readerVersion: cleanText(body.readerVersion, 80),
      });
      return NextResponse.json({
        ok: true,
        heartbeat: true,
        message: \`Tai888 Reader 心跳正常｜盤口未變｜\${refreshed.matchedGameCount}/\${refreshed.rawGameCount} 場\`,
        boardDate: refreshed.boardDate,
        payloadHash: refreshed.payloadHash,
        rawGameCount: refreshed.rawGameCount,
        matchedGameCount: refreshed.matchedGameCount,
        scheduleGameCount: refreshed.scheduleGameCount,
        unmatched: refreshed.unmatched || [],
        receivedAt: refreshed.receivedAt,
        observedAt: refreshed.observedAt,
        runtimeCache: true,
        freshness: readerSnapshotStatus(refreshed),
      }, { headers });
    }
    const schedule = await scheduleWindow(boardDate);`;
  if (!source.includes(anchor)) throw new Error('reader ingest heartbeat anchor missing');
  source = source.replace(anchor, replacement);
  write(file, source);
}

// Reader extension: minimum host permissions, mutation dedupe, 60-second heartbeat.
{
  const file = 'reader/manifest.json';
  const manifest = JSON.parse(read(file));
  manifest.version = READER_VERSION;
  manifest.name = 'Tai888 Reader';
  manifest.description = '自動讀取使用者已登入瀏覽器中可見的 Tai888 MLB 盤口，安全同步到 MLB EV。';
  manifest.host_permissions = ['https://www1.tai888.in/*', 'https://mlb-positive-ev.vercel.app/*'];
  for (const script of manifest.content_scripts || []) {
    script.matches = ['https://www1.tai888.in/*'];
    script.all_frames = true;
    script.match_about_blank = true;
  }
  write(file, `${JSON.stringify(manifest, null, 2)}\n`);
}
{
  const file = 'reader/background.js';
  let source = read(file);
  source = source.replace(
    "return parsed.protocol === 'https:' && (parsed.hostname === 'tai888.in' || parsed.hostname.endsWith('.tai888.in'));",
    "return parsed.protocol === 'https:' && parsed.hostname === 'www1.tai888.in';",
  );
  source = source.replace(
    "chrome.tabs.query({ url: ['https://*.tai888.in/*', 'https://tai888.in/*'] })",
    "chrome.tabs.query({ url: ['https://www1.tai888.in/*'] })",
  );
  source = source.replace(
    "  const payloadHash = await sha256(canonicalReaderPayload(parsed));\n  parsed.payloadHash = payloadHash;\n  const response = await fetch",
    `  const payloadHash = await sha256(canonicalReaderPayload(parsed));
  parsed.payloadHash = payloadHash;
  const previousSync = await chrome.storage.local.get(['lastPayloadHash', 'lastSyncAt']);
  if (reason !== 'manual'
    && previousSync.lastPayloadHash === payloadHash
    && Date.now() - Number(previousSync.lastSyncAt || 0) < 45_000) {
    return { ok: true, skipped: true, message: '盤口未變，等待下一次心跳', payloadHash };
  }
  const response = await fetch`,
  );
  source = source.replace(
    "  await chrome.storage.local.set({ readerStatus: status, pairError: '' });",
    "  await chrome.storage.local.set({ readerStatus: status, pairError: '', lastPayloadHash: payloadHash, lastSyncAt: Date.now() });",
  );
  write(file, source);
}

// Infer Tai888 board year/month in Taiwan time, not runner UTC.
replaceRegexRequired(
  'reader/parser.js',
  /function parseDateTime\(cell, now = new Date\(\)\) \{[\s\S]*?\n\}\n\nexport function parseTai888Capture/,
  `function parseDateTime(cell, now = new Date()) {
  const text = cellLines(cell).join(' ');
  const date = text.match(/\\b(\\d{1,2})-(\\d{1,2})\\b/);
  const time = text.match(/\\b(\\d{1,2}):(\\d{2})\\b/);
  let boardDate = '';
  if (date) {
    const current = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Taipei', year: 'numeric', month: 'numeric', day: 'numeric',
    }).formatToParts(now).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
    let year = current.year;
    const month = Number(date[1]);
    if (current.month === 12 && month === 1) year += 1;
    else if (current.month === 1 && month === 12) year -= 1;
    boardDate = \`\${year}-\${String(month).padStart(2, '0')}-\${String(Number(date[2])).padStart(2, '0')}\`;
  }
  return { boardDate, time: time ? \`\${String(Number(time[1])).padStart(2, '0')}:\${time[2]}\` : '' };
}

export function parseTai888Capture`,
  'Taipei board date parser',
);

// Server parser accepts only the canonical site and preserves contract provenance.
{
  const file = 'lib/tai888-reader-parser-v2.js';
  let source = read(file);
  source = source.replace(
    "return host === 'tai888.in' || host.endsWith('.tai888.in');",
    "return host === 'www1.tai888.in';",
  );
  source = source.replace(
    "    rawText: clean(rawText, 300),\n    referenceSide,",
    "    rawText: clean(rawText, 300),\n    referenceSide,\n    sourceTemplateVersion: 'TAI888-DOM-TABLE-v2.0.0',\n    authorizationStatus: 'USER_AUTHENTICATED_VISIBLE_PAGE',",
  );
  write(file, source);
}

// Preserve source/reference/freshness fields through both full analysis and price-only repricing.
for (const file of ['app/api/analyze/route.js', 'app/api/reprice/route.js']) {
  let source = read(file);
  const importAnchor = file.includes('/analyze/')
    ? "import { MARKET_ORDER, marketIsOpen, validateMarketPair } from '../../../lib/markets.js';"
    : "import { MARKET_ORDER, marketIsOpen, validateMarketPair } from '../../../lib/markets.js';";
  source = source.replace(
    importAnchor,
    `${importAnchor}\nimport { applyMarketFreshness } from '../../../lib/market-freshness-v1.js';\nimport { applyIndependentMarketVerification } from '../../../lib/market-verification-v1.js';`,
  );
  write(file, source);
}
replaceRegexRequired(
  'app/api/analyze/route.js',
  /function sanitizeMarketRows\(rows, maximum = 16\) \{[\s\S]*?\n\}\n\nfunction cacheSet/,
  `function sanitizeMarketRows(rows, maximum = 16) {
  const now = Date.now();
  return (Array.isArray(rows) ? rows : []).slice(0, maximum).map(row => applyMarketFreshness({
    market: MARKET_ORDER.includes(row?.market) ? row.market : '', pick: cleanText(row?.pick, 120), water: optionalNumber(row?.water),
    waterEstimated: Boolean(row?.waterEstimated), waterMissing: row?.waterMissing === true,
    confidence: Math.max(0, Math.min(1, Number(row?.confidence) || 0)),
    sourceType: cleanText(row?.sourceType, 40) || (row?.waterEstimated ? 'ESTIMATED' : 'ACTUAL_TW_CREDIT'),
    sourceLabel: cleanText(row?.sourceLabel, 120), provider: cleanText(row?.provider, 80),
    lineAsOf: cleanText(row?.lineAsOf, 40), executable: row?.executable !== false, marketVerification: cleanVerification(row?.marketVerification),
    rawDecimalOdds: optionalNumber(row?.rawDecimalOdds), providerEventId: cleanText(row?.providerEventId, 120),
    referenceSide: cleanText(row?.referenceSide, 40), rawText: cleanText(row?.rawText, 300),
    sourceTemplateVersion: cleanText(row?.sourceTemplateVersion, 80), authorizationStatus: cleanText(row?.authorizationStatus, 80),
  }, now)).filter(row => row.market);
}

function cacheSet`,
  'analyze market sanitizer',
);
replaceRequired(
  'app/api/analyze/route.js',
  "    const markets = sanitizeMarketRows(body.markets, 12);\n    const previousMarkets = sanitizeMarketRows(body.previousMarkets, 24);",
  "    const suppliedMarkets = sanitizeMarketRows(body.markets, 12);\n    const verificationMarkets = sanitizeMarketRows(body.verificationMarkets, 16);\n    const markets = applyIndependentMarketVerification(suppliedMarkets, verificationMarkets);\n    const previousMarkets = sanitizeMarketRows(body.previousMarkets, 24);",
  'analyze market verification',
);
replaceRegexRequired(
  'app/api/reprice/route.js',
  /function sanitizeMarkets\(rows, maximum = 16\) \{[\s\S]*?\n\}\n\nexport async function POST/,
  `function sanitizeMarkets(rows, maximum = 16) {
  const now = Date.now();
  return (Array.isArray(rows) ? rows : []).slice(0, maximum).map(row => applyMarketFreshness({
    market: MARKET_ORDER.includes(row?.market) ? row.market : '', pick: cleanText(row?.pick, 120), water: optionalNumber(row?.water),
    waterEstimated: Boolean(row?.waterEstimated), waterMissing: row?.waterMissing === true,
    confidence: Math.max(0, Math.min(1, Number(row?.confidence) || 0)),
    sourceType: cleanText(row?.sourceType, 40) || (row?.waterEstimated ? 'ESTIMATED' : 'ACTUAL_TW_CREDIT'),
    sourceLabel: cleanText(row?.sourceLabel, 120), provider: cleanText(row?.provider, 80),
    lineAsOf: cleanText(row?.lineAsOf, 40), executable: row?.executable !== false, marketVerification: cleanVerification(row?.marketVerification),
    rawDecimalOdds: optionalNumber(row?.rawDecimalOdds), providerEventId: cleanText(row?.providerEventId, 120),
    referenceSide: cleanText(row?.referenceSide, 40), rawText: cleanText(row?.rawText, 300),
    sourceTemplateVersion: cleanText(row?.sourceTemplateVersion, 80), authorizationStatus: cleanText(row?.authorizationStatus, 80),
  }, now)).filter(row => row.market);
}

export async function POST`,
  'reprice market sanitizer',
);
replaceRequired(
  'app/api/reprice/route.js',
  "    const markets = sanitizeMarkets(body.markets, 12);\n    const previousMarkets = sanitizeMarkets(body.previousMarkets, 24);",
  "    const suppliedMarkets = sanitizeMarkets(body.markets, 12);\n    const verificationMarkets = sanitizeMarkets(body.verificationMarkets, 16);\n    const markets = applyIndependentMarketVerification(suppliedMarkets, verificationMarkets);\n    const previousMarkets = sanitizeMarkets(body.previousMarkets, 24);",
  'reprice market verification',
);

// Reader snapshots use a high read allowance; expensive legacy server-login remains protected by auth and cache.
replaceEverywhere(
  'app/api/credit-lines/route.js',
  "{ id: 'tai888-credit-lines-v9-3', limit: 6, windowMs: 10 * 60 * 1000 }",
  "{ id: 'tai888-credit-lines-v9-4', limit: 180, windowMs: 10 * 60 * 1000 }",
);

// Non-executable/expired actual prices never appear as formal bets.
{
  const file = 'lib/deterministic-finalizer.js';
  let source = read(file);
  source = source.replace(
    "        : row.waterEstimated\n          ? '參考盤篩選評分｜非最終下注評分'\n          : resultTag(score, candidateThreshold, Number(settings.strongestThreshold || 8.5));",
    "        : !executable\n          ? row.executionStatus === 'EXPIRED' ? '盤口已過期｜不評分｜不下注' : '目前不可下注｜非正式評分'\n          : row.waterEstimated\n            ? '參考盤篩選評分｜非最終下注評分'\n            : resultTag(score, candidateThreshold, Number(settings.strongestThreshold || 8.5));",
  );
  write(file, source);
}

// Website continuously watches Reader, auto-starts on a new snapshot, and only reprices fresh prices.
{
  const file = 'app/page.js';
  let source = read(file);
  source = source.replace("const VERSION = '9.4.0';", `const VERSION = '${VERSION}';`);
  source = source.replace(
    "const formal = row.sourceType === 'ACTUAL_TW_CREDIT' && hasActualWater(row.water);",
    "const formal = row.sourceType === 'ACTUAL_TW_CREDIT' && hasActualWater(row.water) && row.executable !== false && row.lineFresh !== false;",
  );
  source = source.replace(
    "  const autoAnalyzeRef = useRef(false);",
    "  const autoAnalyzeHashRef = useRef('');\n  const lastFullAnalysisAtRef = useRef(0);",
  );
  source = source.replace(
    `  useEffect(() => {
    if (!readerStatus?.fresh || board.length || busy || autoAnalyzeRef.current) return;
    autoAnalyzeRef.current = true;
    const timer = window.setTimeout(() => oneClickAnalyze(), 600);
    return () => window.clearTimeout(timer);
  }, [readerStatus?.fresh, board.length, busy]);`,
    `  useEffect(() => {
    const refreshReader = () => requestJSON(\`/api/reader/status?date=\${encodeURIComponent(date)}&t=\${Date.now()}\`, {}, 20000)
      .then(setReaderStatus)
      .catch(cause => setReaderStatus(current => ({ ...(current || {}), fresh: false, message: String(cause?.message || cause) })));
    refreshReader();
    const timer = window.setInterval(refreshReader, 30000);
    return () => window.clearInterval(timer);
  }, [date]);
  useEffect(() => {
    const hash = readerStatus?.payloadHash || '';
    if (!readerStatus?.fresh || !hash || board.length || busy || autoAnalyzeHashRef.current === hash) return;
    autoAnalyzeHashRef.current = hash;
    const timer = window.setTimeout(() => oneClickAnalyze(), 600);
    return () => window.clearTimeout(timer);
  }, [readerStatus?.fresh, readerStatus?.payloadHash, board.length, busy]);`,
  );
  source = source.replace(
    `  useEffect(() => {
    if (!board.length) return;
    const timer = window.setInterval(() => pollReaderAndReprice(), 30000);
    return () => window.clearInterval(timer);
  }, [board, date, busy]);`,
    `  useEffect(() => {
    if (!board.length) return;
    const timer = window.setInterval(() => pollReaderAndReprice(), 30000);
    return () => window.clearInterval(timer);
  }, [board, date, busy]);
  useEffect(() => {
    if (!board.length) return;
    const timer = window.setInterval(() => {
      if (!busy && Date.now() - Number(lastFullAnalysisAtRef.current || 0) > 30 * 60 * 1000) oneClickAnalyze();
    }, 5 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [board.length, date, busy]);`,
  );
  source = source.replace(
    "            previousMarkets: [],\n            settings:",
    "            previousMarkets: [],\n            verificationMarkets: referenceMarkets,\n            settings:",
  );
  source = source.replace(
    "      setNotice(`完成 ${tasks.length} 場分析｜參考盤 ${referenceCount} 場｜實際信用盤 ${creditCount} 場${sourceWarnings.length ? `｜提醒：${sourceWarnings.join('；')}` : ''}`);",
    "      lastFullAnalysisAtRef.current = Date.now();\n      setNotice(`完成 ${tasks.length} 場分析｜參考盤 ${referenceCount} 場｜實際信用盤 ${creditCount} 場${sourceWarnings.length ? `｜提醒：${sourceWarnings.join('；')}` : ''}`);",
  );
  source = source.replace(
    "              previousMarkets: item.customMarkets || [],\n              settings:",
    "              previousMarkets: item.customMarkets || [],\n              verificationMarkets: item.referenceMarkets || [],\n              settings:",
  );
  source = source.replace(
    "      if (updated) setNotice(`Tai888盤口已自動更新：${updated}場沿用凍結比分分布快速重算${skipped ? '｜' + skipped + '場待下次完整分析' : ''}。`);",
    "      if (updated) setNotice(`Tai888盤口已自動更新：${updated}場沿用凍結比分分布快速重算${skipped ? '｜' + skipped + '場改走完整分析' : ''}。`);\n      if (skipped) window.setTimeout(() => oneClickAnalyze(), 600);",
  );
  source = source.replace(
    "body: JSON.stringify({ snapshot, markets, previousMarkets: previousActualMarkets, settings:",
    "body: JSON.stringify({ snapshot, markets, previousMarkets: previousActualMarkets, verificationMarkets: item.referenceMarkets || [], settings:",
  );
  source = source.replace(
    "body: JSON.stringify({ snapshot, markets, previousMarkets: item.customMarkets || [], settings:",
    "body: JSON.stringify({ snapshot, markets, previousMarkets: item.customMarkets || [], verificationMarkets: item.referenceMarkets || [], settings:",
  );
  write(file, source);
}

// Current production smoke: private site, deterministic engine, public Reader status, security headers.
write('scripts/smoke.mjs', `import assert from 'node:assert/strict';

const BASE = String(process.env.SMOKE_URL || 'https://mlb-positive-ev.vercel.app').replace(/\\/$/, '');
const EXPECTED_SHA = process.env.GITHUB_SHA || '';
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function response(url, options = {}, timeout = 30000) {
  return fetch(url, { ...options, redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(timeout) });
}
async function json(url, options = {}, timeout = 30000) {
  const result = await response(url, options, timeout);
  const text = await result.text();
  let value;
  try { value = JSON.parse(text); } catch { throw new Error(\`non-JSON \${result.status}: \${text.slice(0, 500)}\`); }
  return { result, value };
}
async function waitForDeployment() {
  let last = '';
  for (let index = 0; index < 60; index += 1) {
    try {
      const { result, value } = await json(\`\${BASE}/api/health?t=\${Date.now()}\`);
      last = JSON.stringify(value);
      const shaReady = !EXPECTED_SHA || !value.commit || value.commit === EXPECTED_SHA;
      if (result.ok && value.ok && value.version === '${VERSION}' && value.deterministicScoring === true
        && value.gptScoringEnabled === false && value.authConfigured === true
        && value.readerPairingConfigured === true && shaReady) return value;
    } catch (error) { last = String(error?.message || error); }
    await sleep(10000);
  }
  throw new Error(\`production not ready: \${last}\`);
}

const health = await waitForDeployment();
assert.equal(health.version, '${VERSION}');
assert.equal(health.deterministicScoring, true);
assert.equal(health.gptScoringEnabled, false);
assert.equal(health.authConfigured, true);
assert.equal(health.readerPairingConfigured, true);
assert.ok(health.scoreFormulaVersion);
assert.ok(health.settlementRuleVersion);

const home = await response(\`\${BASE}/?smoke=\${Date.now()}\`);
assert.ok([302, 307, 308].includes(home.status));
assert.match(home.headers.get('location') || '', /\\/login/);
assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
assert.equal(home.headers.get('x-frame-options'), 'DENY');
assert.ok(home.headers.get('content-security-policy'));

const protectedApi = await response(\`\${BASE}/api/mlb?date=2026-08-12\`);
assert.equal(protectedApi.status, 401);

const reader = await json(\`\${BASE}/api/reader/status?t=\${Date.now()}\`, {
  headers: { Origin: BASE },
});
assert.equal(reader.result.status, 200);
assert.equal(reader.value.ok, true);
assert.equal(reader.value.pairingConfigured, true);
assert.ok(reader.value.storeVersion);
assert.equal(Object.prototype.hasOwnProperty.call(reader.value, 'games'), false);

const corsOrigin = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const preflight = await response(\`\${BASE}/api/reader/ingest\`, { method: 'OPTIONS', headers: { Origin: corsOrigin } });
assert.equal(preflight.status, 204);
assert.equal(preflight.headers.get('access-control-allow-origin'), corsOrigin);

const wrongPair = await json(\`\${BASE}/api/reader/pair\`, {
  method: 'POST',
  headers: { Origin: corsOrigin, 'Content-Type': 'application/json' },
  body: JSON.stringify({ deviceId: 'smoke-device-123456', deviceName: 'smoke', password: 'definitely-wrong-password' }),
});
assert.equal(wrongPair.result.status, 401);
assert.equal(wrongPair.value.ok, false);

console.log(JSON.stringify({ ok: true, version: health.version, commit: health.commit, auth: true, readerStatus: reader.value.state }, null, 2));
`);

// Permanent release tests.
write('scripts/market-freshness-v1-test.mjs', `import assert from 'node:assert/strict';
import { applyMarketFreshness } from '../lib/market-freshness-v1.js';
const now = Date.parse('2026-08-12T00:00:00Z');
const fresh = applyMarketFreshness({ sourceType: 'ACTUAL_TW_CREDIT', lineAsOf: '2026-08-11T23:58:00Z', executable: true }, now);
assert.equal(fresh.executable, true);
assert.equal(fresh.executionStatus, 'EXECUTABLE');
const expired = applyMarketFreshness({ sourceType: 'ACTUAL_TW_CREDIT', lineAsOf: '2026-08-11T23:50:00Z', executable: true }, now);
assert.equal(expired.executable, false);
assert.equal(expired.executionStatus, 'EXPIRED');
const missing = applyMarketFreshness({ sourceType: 'ACTUAL_TW_CREDIT', executable: true }, now);
assert.equal(missing.executable, false);
const reference = applyMarketFreshness({ sourceType: 'INTERNATIONAL', executable: false }, now);
assert.equal(reference.lineFresh, true);
console.log('market freshness v1: ok');
`);
write('scripts/market-verification-v1-test.mjs', `import assert from 'node:assert/strict';
import { applyIndependentMarketVerification } from '../lib/market-verification-v1.js';
const actual = [{ market: '全場大小', pick: '大8+50', water: .94, sourceType: 'ACTUAL_TW_CREDIT', provider: 'TAI888_READER_AUTO', lineAsOf: '2026-08-12T00:00:00Z' }];
const reference = [{ market: '全場大小', pick: '大8+50', water: .95, sourceType: 'INTERNATIONAL', provider: 'THE_ODDS_API_CONSENSUS', lineAsOf: '2026-08-12T00:10:00Z' }];
const verified = applyIndependentMarketVerification(actual, reference);
assert.equal(verified[0].marketVerification.verified, true);
assert.equal(new Set(verified[0].marketVerification.sources.map(row => row.independentGroup)).size, 2);
const different = applyIndependentMarketVerification(actual, [{ ...reference[0], pick: '大8.5' }]);
assert.equal(different[0].marketVerification.verified, false);
console.log('market verification v1: ok');
`);
write('scripts/release-security-audit-v9-4.mjs', `import assert from 'node:assert/strict';
import fs from 'node:fs';
const manifest = JSON.parse(fs.readFileSync('reader/manifest.json', 'utf8'));
assert.equal(manifest.version, '${READER_VERSION}');
assert.deepEqual(manifest.host_permissions.sort(), ['https://mlb-positive-ev.vercel.app/*', 'https://www1.tai888.in/*'].sort());
assert.equal((manifest.permissions || []).includes('cookies'), false);
const background = fs.readFileSync('reader/background.js', 'utf8');
assert.doesNotMatch(background, /chrome\\.cookies|document\\.cookie|localStorage.*password/i);
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
console.log('release security/static audit v9.4: ok');
`);

// README, install package and release audit.
write('reader/INSTALL.md', `# Tai888 Reader 2.0.0｜安裝與長期使用

1. 解壓縮 ZIP，Chrome 開啟 \`chrome://extensions\`。
2. 開啟開發人員模式，移除舊版 1.x，載入內含 \`manifest.json\` 的 \`Tai888-Reader\` 資料夾。
3. 確認版本 2.0.0，回到 \`https://www1.tai888.in\` 的 MLB 讓分／大小頁。
4. 點 Reader，第一次輸入 Reader 配對密碼；未另設 \`READER_PAIR_SECRET\` 時沿用 Vercel 的 \`TAI888_PASSWORD\`。
5. 電腦、Chrome 與 Tai888 MLB 頁面保持開啟且不要睡眠；頁面變動與每 60 秒心跳會自動同步。

Reader 只讀目前可見 MLB 盤口，不讀 Cookie、Session、餘額或下注按鈕，不繞過 Cloudflare。
`);
write('docs/RELEASE_AUDIT_v9.4.0.md', `# MLB EV v9.4.0 / Tai888 Reader 2.0.0 release audit

- Tai888: canonical host www1.tai888.in; exact host permission; visible DOM only; no login automation, Cookie, Session, CAPTCHA or bet action.
- Markets: full-game runline/total and first-five runline/total; actual water separated from tail; source side/raw text/parser version retained.
- Freshness: Reader snapshot 180 seconds; formal actual line 5 minutes; stale/non-executable prices cannot enter the bet list.
- Repricing: price-only change reuses the frozen distribution; open website polls Reader; full model refresh every 30 minutes while open.
- Settlement: Decimal per-leg ledger; rebate only on settled principal; push receives no rebate.
- Score: deterministic dual-EV bottleneck; no GPT numeric scoring; 8.9 maximum; 8.5 requires two independent exact-contract sources, otherwise 8.4 cap.
- QA: pair mirror, distribution coverage, EV double calculation, robust <= weighted, input/distribution fingerprints, minimum-water and integer-hole audit.
- Security: private site using APP_PASSWORD or server-only TAI888_PASSWORD fallback; Reader bearer token; strict Reader origins; API auth/rate/body limits; CSP/HSTS/noindex/no secret response.
- Persistence: latest Reader board uses Vercel Runtime Cache. Long-term bet/performance history remains browser-local until a server DATABASE_URL is provisioned; no claim of cross-device permanent history is made in this release.
`);
write('DEPLOYMENT_VERSION', 'v9.4.0-tai888-reader-v2-production\n');

// Package workflow emits a directly usable inner ZIP with ASCII install filename.
{
  const file = '.github/workflows/package-reader-v2.yml';
  let source = read(file);
  source = source.replace(/cat > stage\/Tai888-Reader\/[^\s]+ <<'TXT'/, "cat > stage/Tai888-Reader/INSTALL.txt <<'TXT'");
  write(file, source);
}

// Remove one-off development helpers; permanent QA and package workflow remain.
for (const file of [
  '.github/workflows/reader-env-diagnostic.yml',
  '.github/workflows/apply-tai888-reader-v2.yml',
  'scripts/apply-tai888-reader-v2.mjs',
]) remove(file);

console.log('Hardened Tai888 Reader v2 / MLB EV v9.4.0 finalization patch applied.');
