import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createHmac } from 'node:crypto';

// Intercept only this route's service import: tests never access a database or
// issue HTTP requests and therefore cannot consume a provider allowance.
const fake = 'data:text/javascript,' + encodeURIComponent(`
 export async function startReaderInventoryScan(scope) { return globalThis.__inventoryStart(scope); }
 export async function continueReaderInventoryScan(scope) { return globalThis.__inventoryContinue(scope); }
`);
const fakeRecovery = 'data:text/javascript,' + encodeURIComponent(`
 export function readerInventoryPublicId(cursor) { return globalThis.__publicId(cursor); }
 export async function listReaderInventoryScans(scope) { return globalThis.__inventoryList(scope); }
 export async function resumeReaderInventoryScan(scope) { return globalThis.__inventoryResume(scope); }
`);
register('./next-route-test-loader.mjs', import.meta.url);
register('data:text/javascript,' + encodeURIComponent(`
 export async function resolve(specifier, context, next) {
   if (specifier.endsWith('/lib/soccer/reader-inventory-scan.js') && context.parentURL.includes('/app/api/soccer/reader-inventory-scan/'))
     return { url: ${JSON.stringify(fake)}, shortCircuit: true };
   if (specifier.endsWith('/lib/soccer/reader-inventory-recovery.js') && context.parentURL.includes('/app/api/soccer/reader-inventory-scan/'))
     return { url: ${JSON.stringify(fakeRecovery)}, shortCircuit: true };
   return next(specifier, context);
 }
`), import.meta.url);
process.env.APP_PASSWORD = 'api-test-only';
process.env.SESSION_SECRET = 'api-test-session-secret-only';
globalThis.fetch = () => { throw Error('Unexpected network access'); };
const { createSessionToken } = await import('../lib/security.js');
const { POST } = await import('../app/api/soccer/reader-inventory-scan/route.js');
const cookie = `mlb_session=${await createSessionToken()}`;
const cursor = 'ab'.repeat(24), calls = [];
globalThis.__publicId = value => createHmac('sha256', process.env.SESSION_SECRET).update('soccer-reader-inventory-public-id-v1\0').update(value).digest('hex');
const report = scope => ({ version: 'SOCCER-READER-INVENTORY-SCAN-v1', cursor, league: scope.league, date: scope.date,
  status: 'RUNNING', totalCount: 523, verifiedCount: 0, observedCount: 523, reasonCodes: [],
  payload: { deviceId: 'sensitive-device' }, rawBody: 'sensitive-raw', identityVerified: true, W: 42 });
globalThis.__inventoryStart = async scope => { calls.push(['start', scope]); return report(scope); };
globalThis.__inventoryContinue = async scope => { calls.push(['continue', scope]); return report(scope); };
const entry = scope => ({ cursor, scanId: globalThis.__publicId(cursor), startedAt: '2026-11-06T12:00:00.123456Z', report: report(scope) });
globalThis.__inventoryList = async scope => ({ entries: [entry(scope)], complete: true });
globalThis.__inventoryResume = async scope => scope.scanId === globalThis.__publicId(cursor) ? entry(scope) : null;
let ip = 0;
async function request(body, { url = 'http://localhost/api/soccer/reader-inventory-scan', headers = {}, auth = true } = {}) {
  const h = { 'content-type': 'application/json', origin: 'http://localhost', 'x-forwarded-for': `test-${++ip}`, ...headers };
  if (auth) h.cookie = cookie;
  return POST(new Request(url, { method: 'POST', headers: h, body, ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) }));
}
async function expectStatus(body, status, options) {
  const response = await request(body, options);
  assert.equal(response.status, status);
  assert.match(response.headers.get('cache-control'), /no-store/);
  return response;
}
const valid = JSON.stringify({ action: 'start', league: 'ucl', date: '2026-10-21', cursor });
await expectStatus(valid, 401, { auth: false });
await expectStatus(valid, 403, { headers: { origin: 'https://elsewhere.test' } });
let response = await expectStatus(valid, 400, { url: `http://localhost/api/soccer/reader-inventory-scan?cursor=${cursor}` });
assert(!JSON.stringify(await response.json()).includes(cursor));
const invalid = [
  '{}', 'null', '[]', '{"action":"start","league":"ucl","date":"2026-02-30"}',
  '{"action":"start","league":"nba","date":"2026-10-21"}',
  '{"action":"run","league":"ucl","date":"2026-10-21"}',
  '{"action":"start","league":"ucl","date":"2026-10-21"}',
  '{"action":"start","league":"ucl","date":"2026-10-21","cursor":"abc"}',
  '{"action":"continue","league":"ucl","date":"2026-10-21"}',
  '{"action":"continue","league":"ucl","date":"2026-10-21","cursor":"abc"}',
  '{"action":"start","league":"ucl","date":"2026-10-21","payload":"bad"}',
  '{"action":"start","action":"start","league":"ucl","date":"2026-10-21"}',
  '{"action":"start","\\u0061ction":"start","league":"ucl","date":"2026-10-21"}',
  '{"action":"start","league":"ucl","date":"2026-10-21","extra":{}}',
];
for (const body of invalid) await expectStatus(body, 400);
await expectStatus(valid, 400, { headers: { 'content-type': 'text/plain' } });
await expectStatus(valid, 400, { headers: { 'content-length': 'nonsense' } });
await expectStatus(valid, 413, { headers: { 'content-length': '2049' } });
await expectStatus('x'.repeat(2049), 413);
const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1200)); controller.enqueue(new Uint8Array(1000)); controller.close(); } });
await expectStatus(stream, 413, { headers: { 'content-length': '1' } });
await expectStatus('字'.repeat(683), 413); // bytes, not JavaScript characters
const invalidUtf8 = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([0xff])); controller.close(); } });
await expectStatus(invalidUtf8, 400);
const stalled = new ReadableStream({ pull() { return new Promise(() => {}); } });
await expectStatus(stalled, 408);
assert.equal(calls.length, 0);
response = await expectStatus(valid, 200);
let result = await response.json();
assert.equal(result.ok, true); assert.equal(result.report.cursor, cursor);
assert.equal(result.report.identityVerified, false); assert.equal(result.report.W, null);
assert(!JSON.stringify(result).includes('sensitive-'));
assert.deepEqual(calls.at(-1), ['start', { league: 'ucl', date: '2026-10-21', cursor }]);
await expectStatus(valid, 200); // A retry uses the identical idempotency token.
assert.deepEqual(calls.at(-1), ['start', { league: 'ucl', date: '2026-10-21', cursor }]);
response = await expectStatus(JSON.stringify({ action: 'continue', league: 'ucl', date: '2026-10-21', cursor }), 200);
result = await response.json(); assert.equal(result.report.cursor, cursor);
assert.deepEqual(calls.at(-1), ['continue', { league: 'ucl', date: '2026-10-21', cursor }]);
// Read outages remain retryable HTTP failures; a subsequent request retains the
// exact continuation scope and cannot become a new manifest implicitly.
const continueBody=JSON.stringify({action:'continue',league:'ucl',date:'2026-10-21',cursor});
let outageCalls=0;
globalThis.__inventoryContinue=async scope=>{
  calls.push(['continue',scope]);
  if(!outageCalls++)throw Object.assign(Error('sensitive-source-read-outage'),{status:503,retryable:true});
  return {...report(scope),status:'COMPLETE',totalCount:2,observedCount:2,verifiedCount:2};
};
response=await expectStatus(continueBody,503);result=await response.json();
assert.equal(result.ok,false);assert.equal(result.report,undefined);
assert(!JSON.stringify(result).includes('sensitive-source-read-outage'));
response=await expectStatus(continueBody,200);result=await response.json();
assert.equal(result.report.status,'COMPLETE');assert.equal(result.report.verifiedCount,2);
assert.deepEqual(calls.slice(-2),Array.from({length:2},()=>['continue',{league:'ucl',date:'2026-10-21',cursor}]));
const list = JSON.stringify({ action: 'list', league: 'ucl', date: '2026-10-21' });
response = await expectStatus(list, 200); result = await response.json();
assert.equal(result.complete, true); assert.equal(result.reports.length, 1); assert.deepEqual(result.reasonCodes, []);
assert(!JSON.stringify(result).includes(cursor)); assert(!JSON.stringify(result).includes('sensitive-'));
const scanId = result.reports[0].scanId;
response = await expectStatus(JSON.stringify({ action: 'resume', league: 'ucl', date: '2026-10-21', scanId }), 200);
result = await response.json(); assert.equal(result.report.scanId, scanId); assert(!JSON.stringify(result).includes(cursor));
await expectStatus(JSON.stringify({ action: 'resume', league: 'ucl', date: '2026-10-21', scanId: '0'.repeat(64) }), 404);
await expectStatus(JSON.stringify({ action: 'list', league: 'ucl', date: '2026-10-21', cursor }), 400);
globalThis.__inventoryList = async () => ({ entries: [], complete: false });
response = await expectStatus(list, 200); result = await response.json();
assert.equal(result.complete, false); assert.deepEqual(result.reasonCodes, ['READER_MANIFEST_LIST_TRUNCATED']);
globalThis.__inventoryStart = async scope => ({ ...report(scope), cursor: null, status: 'PARTIAL', totalCount: null,
  observedCount: null, verifiedCount: 0, reasonCodes: ['READER_MANIFEST_SCOPE_BUDGET'] });
response = await expectStatus(valid, 200); result = await response.json();
assert.equal(result.report.cursor, null); assert.equal(result.report.observedCount, null);
assert.deepEqual(result.report.reasonCodes, ['READER_MANIFEST_SCOPE_BUDGET']);
assert.equal(result.report.scopeDescription, 'NOT_STARTED_SCOPE_LIMIT');
globalThis.__inventoryContinue = globalThis.__inventoryStart;
response = await expectStatus(JSON.stringify({ action: 'continue', league: 'ucl', date: '2026-10-21', cursor }), 503);
assert(!(await response.text()).includes(cursor));
globalThis.__inventoryStart = async () => { throw Error(`private-key ${cursor} sensitive-raw`); };
response = await expectStatus(valid, 503); const error = await response.text();
assert(!error.includes(cursor)); assert(!error.includes('private-key')); assert(!error.includes('sensitive-raw'));
globalThis.__inventoryStart = async scope => ({ ...report(scope), reasonCodes: ['sensitive-device'] });
response = await expectStatus(valid, 503); assert(!(await response.text()).includes('sensitive-device'));
// 40 calls per minute are allowed to support large manifests.
for (let n = 0; n < 40; n++) await expectStatus('{}', 400, { headers: { 'x-forwarded-for': 'rate-limit-client' } });
await expectStatus('{}', 429, { headers: { 'x-forwarded-for': 'rate-limit-client' } });
console.log('soccer reader inventory API tests passed');
