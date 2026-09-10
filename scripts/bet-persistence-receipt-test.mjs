import assert from 'node:assert/strict';
import { register } from 'node:module';
import {
  cloudBetIntentMatches,
  confirmCloudBetPersistence,
  findMatchingPersistedCloudBet,
  insertVerifiedCloudBetAtomically,
  sanitizeCloudBet,
} from '../lib/cloud-bet-store.js';
import { createSessionToken } from '../lib/security.js';

// All database and upstream I/O in this test is injected. No external writes.
const fixture = sanitizeCloudBet({
  id: 'persisted-1', league: 'MLB', date: '2099-08-16', gamePk: 123,
  market: '全場大小', pick: '小9+60', water: 0.94, stake: 10000,
  placedAt: '2099-08-16T12:00:00.000Z', gameDate: '2099-08-16T13:00:00.000Z',
  status: 'OPEN', readerEvidenceStatus: 'SERVER_VERIFIED_CAPTURED_READER',
  pitEvidenceVerified: true, pitPredictionStatus: 'IMMUTABLE_PIT_VERIFIED',
});
const candidate = { ...fixture, id: undefined, readerRevision: 'old-reader-revision', pitSnapshotId: 'older-pit' };
assert.equal(cloudBetIntentMatches(candidate, fixture), true);
assert.equal(cloudBetIntentMatches({ ...candidate, pick: '小 9 +60' }, fixture), true);
for (const changed of [
  { water: 0.94000000001 }, { stake: 10001 }, { pick: '小9+70' },
  { market: '上半大小' }, { league: 'NPB' }, { date: '2099-08-17' },
  { gamePk: 124 }, { league: undefined }, { stake: null },
]) assert.equal(cloudBetIntentMatches({ ...candidate, ...changed }, fixture), false);

let readSql = '';
const existing = await findMatchingPersistedCloudBet(candidate, {
  database: async strings => { readSql = strings.join('?'); return [{ payload: fixture }]; },
});
assert.equal(existing.id, fixture.id);
assert.match(readSql, /WHERE position_key = \?[\s\S]*AND status <> 'CANCELLED'/);
assert.doesNotMatch(readSql, /\b(?:INSERT|UPDATE|DELETE)\b/);
for (const changed of [
  { status: 'CANCELLED' }, { pitEvidenceVerified: false },
  { pitPredictionStatus: 'EXCLUDED_UNVERIFIABLE_LEGACY' },
  { readerEvidenceStatus: 'EXCLUDED_UNVERIFIABLE_LEGACY' }, { stake: 20000 },
]) {
  assert.equal(await findMatchingPersistedCloudBet(candidate, {
    database: async () => [{ payload: { ...fixture, ...changed } }],
  }), null, 'only a matching trusted active stored row may recover a retry');
}

const idempotent = { created: false, idempotent: true, betId: fixture.id };
const receipt = await confirmCloudBetPersistence(candidate, idempotent, {
  listBets: async () => [], // target may be outside the bounded ledger page
  readByIds: async ids => { assert.deepEqual(ids, [fixture.id]); return [fixture]; },
});
assert.deepEqual(receipt.persistence, { status: 'CONFIRMED', betId: fixture.id, readBack: true });
assert.equal(receipt.bets[0].id, fixture.id);
assert.equal(receipt.idempotent, true);
for (const rows of [
  [], [{ ...fixture, id: 'another-bet' }], [{ ...fixture, status: 'CANCELLED' }],
  [{ ...fixture, pitEvidenceVerified: false }], [{ ...fixture, stake: 20000 }],
]) {
  await assert.rejects(() => confirmCloudBetPersistence(candidate, idempotent, {
    listBets: async () => [fixture], readByIds: async () => rows,
  }), error => error.code === 'BET_PERSISTENCE_NOT_CONFIRMED' && error.status === 503);
}
const replaced = await confirmCloudBetPersistence(candidate, idempotent, {
  listBets: async () => [{ ...fixture, status: 'OPEN' }],
  readByIds: async () => [{ ...fixture, status: 'SETTLED' }],
});
assert.equal(replaced.bets.length, 1);
assert.equal(replaced.bets[0].status, 'SETTLED', 'latest targeted DB read overrides an earlier list response');

let rows = [];
let prestart = true;
const database = async (strings, ...values) => {
  const query = strings.join('?');
  if (/WITH insertion_clock/.test(query)) {
    const bet = JSON.parse(values[7]);
    const conflict = rows.some(row => row.status !== 'CANCELLED' && row.positionIdentity === bet.positionIdentity);
    if (prestart && !conflict) {
      rows.push(bet);
      return [{ created: true, id: bet.id, prestart }];
    }
    return [{ created: false, id: null, prestart }];
  }
  assert.match(query, /SELECT payload[\s\S]*WHERE position_key/);
  return rows.filter(row => row.status !== 'CANCELLED' && row.positionIdentity === values[0])
    .map(payload => ({ payload }));
};
const concurrent = await Promise.all([
  insertVerifiedCloudBetAtomically(fixture, { database }),
  insertVerifiedCloudBetAtomically({ ...fixture, id: 'attempt-2' }, { database }),
]);
assert.equal(rows.length, 1);
assert.equal(concurrent.filter(item => item.created).length, 1);
assert.equal(concurrent.filter(item => item.idempotent).length, 1);
assert.deepEqual(concurrent.map(item => item.betId), [fixture.id, fixture.id]);
prestart = false;
assert.deepEqual(await insertVerifiedCloudBetAtomically({ ...fixture, id: 'poststart-retry' }, { database }), idempotent);
await assert.rejects(() => insertVerifiedCloudBetAtomically({ ...fixture, id: 'poststart-new', stake: 20000 }, { database }),
  error => error.code === 'BET_ALREADY_STARTED');
prestart = true;
await assert.rejects(() => insertVerifiedCloudBetAtomically({ ...fixture, id: 'changed-stake', stake: 20000 }, { database }),
  error => error.code === 'BET_POSITION_ALREADY_OPEN');
rows[0].status = 'CANCELLED';
const rebet = await insertVerifiedCloudBetAtomically({ ...fixture, id: 'rebet-2' }, { database });
assert.deepEqual(rebet, { created: true, betId: 'rebet-2' });
assert.equal(rows.length, 2);
assert.equal(rows.filter(row => row.status !== 'CANCELLED').length, 1);

// Run the real route with injected persistence/evidence dependencies. Auth,
// request parsing, evidence rejection, and HTTP receipt serialization are real.
const routeUrl = new URL('../app/api/bets/route.js', import.meta.url).href;
const calls = [];
let recovered = null;
let verification = { readerVerified: true, pitVerified: true };
let mutation = { ...receipt, created: true, idempotent: false };
let confirmedRows = [fixture];
globalThis.__betReceiptRouteFixture = {
  cancelOpenCloudBet: async () => [], cloudBetStats: () => ({}), listCloudBets: async () => [fixture],
  listCloudBetsByIds: async ids => { calls.push('readByIds'); assert.deepEqual(ids, [fixture.id]); return confirmedRows; },
  mergeCloudBets: async () => [], settleOpenCloudBets: async () => [],
  recoverPersistedCloudBet: async value => { calls.push('recover'); assert.equal(value.id, undefined); return recovered; },
  upsertCloudBet: async () => { calls.push('write'); return mutation; },
  verifyCloudBetEvidenceV110: async () => { calls.push('verify'); return verification; },
};
register('data:text/javascript,' + encodeURIComponent(`
  const routeUrl = ${JSON.stringify(routeUrl)};
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === 'next/server') return nextResolve('next/server.js', context);
    if (context.parentURL === routeUrl && (specifier.endsWith('/lib/cloud-bet-store.js') || specifier.endsWith('/lib/bet-evidence-verification-v110.js'))) {
      return { url: 'test-bet-receipt:' + (specifier.includes('cloud-bet-store') ? 'store' : 'evidence'), shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }
  export async function load(url, context, nextLoad) {
    if (!url.startsWith('test-bet-receipt:')) return nextLoad(url, context);
    const names = url.endsWith(':store')
      ? ['cancelOpenCloudBet', 'cloudBetStats', 'listCloudBets', 'listCloudBetsByIds', 'mergeCloudBets', 'settleOpenCloudBets', 'upsertCloudBet', 'recoverPersistedCloudBet']
      : ['verifyCloudBetEvidenceV110'];
    return { format: 'module', shortCircuit: true,
      source: names.map(name => 'export const ' + name + ' = (...args) => globalThis.__betReceiptRouteFixture.' + name + '(...args);').join('\\n') };
  }
`), import.meta.url);
const oldPassword = process.env.APP_PASSWORD;
const oldSecret = process.env.SESSION_SECRET;
try {
  process.env.APP_PASSWORD = 'receipt-test-only';
  process.env.SESSION_SECRET = 'receipt-test-session-secret-abcdefghijklmnopqrstuvwxyz';
  const token = await createSessionToken();
  const { GET, POST } = await import(routeUrl);
  const request = (auth = true) => new Request('https://receipt.test/api/bets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://receipt.test',
      ...(auth ? { Cookie: `mlb_session=${encodeURIComponent(token)}` } : {}) },
    body: JSON.stringify({ action: 'upsert', bet: { ...candidate, id: 'untrusted-client-id' } }),
  });
  assert.equal((await POST(request(false))).status, 401);
  assert.deepEqual(calls, []);
  const getRequest = (id = fixture.id) => new Request(`https://receipt.test/api/bets?confirmBetId=${encodeURIComponent(id)}`, {
    headers: { Cookie: `mlb_session=${encodeURIComponent(token)}` },
  });
  confirmedRows = [{ ...fixture, status: 'CANCELLED' }];
  const cancelledRead = await GET(getRequest());
  assert.equal(cancelledRead.status, 200);
  assert.equal((await cancelledRead.json()).bets[0].status, 'CANCELLED');
  assert.deepEqual(calls.splice(0), ['readByIds']);
  confirmedRows = [];
  assert.deepEqual((await (await GET(getRequest())).json()).bets, [], 'stale list row cannot override missing targeted confirmation');
  calls.splice(0);
  assert.equal((await GET(getRequest(''))).status, 400);
  assert.equal((await GET(getRequest('a'.repeat(121)))).status, 400);
  confirmedRows = [fixture];
  const insertedResponse = await POST(request());
  assert.equal(insertedResponse.status, 200);
  const insertedBody = await insertedResponse.json();
  assert.equal(insertedBody.created, true);
  assert.equal(insertedBody.betId, fixture.id);
  assert.equal(insertedBody.persistence.readBack, true);
  assert.deepEqual(calls.splice(0), ['recover', 'verify', 'write']);

  recovered = receipt;
  verification = { readerVerified: false, pitVerified: false, pitError: 'stale after start' };
  const replayResponse = await POST(request());
  assert.equal(replayResponse.status, 200);
  assert.equal((await replayResponse.json()).idempotent, true);
  assert.deepEqual(calls.splice(0), ['recover'], 'already verified stored retry performs no write and does not depend on fresh Reader');

  recovered = null;
  const rejectedResponse = await POST(request());
  assert.equal(rejectedResponse.status, 409);
  assert.equal((await rejectedResponse.json()).code, 'PIT_EVIDENCE_REQUIRED');
  assert.deepEqual(calls.splice(0), ['recover', 'verify'], 'missing PIT must never reach persistence');
  verification = { readerVerified: true, pitVerified: true };
  globalThis.__betReceiptRouteFixture.upsertCloudBet = async () => {
    const error = new Error('readback missing'); error.code = 'BET_PERSISTENCE_NOT_CONFIRMED'; error.status = 503; throw error;
  };
  const unconfirmedResponse = await POST(request());
  assert.equal(unconfirmedResponse.status, 503);
  assert.equal((await unconfirmedResponse.json()).code, 'BET_PERSISTENCE_NOT_CONFIRMED');
} finally {
  delete globalThis.__betReceiptRouteFixture;
  if (oldPassword == null) delete process.env.APP_PASSWORD; else process.env.APP_PASSWORD = oldPassword;
  if (oldSecret == null) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = oldSecret;
}
console.log('Durable bet readback, trusted idempotent retry, concurrent duplicate suppression, cancel/rebet and authenticated API receipts PASS');
