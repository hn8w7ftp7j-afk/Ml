import assert from 'node:assert/strict';
import fs from 'node:fs';
import { betIdentity, betPositionIdentity } from '../lib/bet-ledger.js';
import {
  cloudBetMutationOutcomeUncertain,
  confirmCloudBetMutation,
  findConfirmedRecordedBet,
  requireCancelledBet,
  requireCloudLedgerResponse,
} from '../lib/cloud-ledger-receipt.js';

const candidate = {
  league: 'MLB', date: '2026-09-10', gamePk: 900001,
  market: '全場大小', pick: '大8平', water: 0.95, stake: 100,
};
const stored = {
  ...candidate, id: 'durable-record-1', status: 'OPEN',
  readerEvidenceStatus: 'SERVER_VERIFIED_CAPTURED_READER',
  pitEvidenceVerified: true, pitPredictionStatus: 'IMMUTABLE_PIT_VERIFIED',
};
const ledger = { ok: true, bets: [stored] };
const created = { ...ledger, created: true, betId: stored.id };
const replayed = { ...created, created: false, idempotent: true };
let readCount = 0;
const receipt = await confirmCloudBetMutation(created, candidate, async () => { readCount += 1; return ledger; });
assert.equal(readCount, 1, 'success requires an independent ledger GET');
assert.equal(receipt.bet.id, stored.id);
assert.equal((await confirmCloudBetMutation(replayed, candidate, async () => ledger)).idempotent, true);
assert.throws(() => requireCloudLedgerResponse({ ok: true }), { code: 'LEDGER_RESPONSE_INVALID' });
assert.throws(() => requireCloudLedgerResponse({ ok: false, bets: [] }), { code: 'LEDGER_RESPONSE_INVALID' });
await assert.rejects(confirmCloudBetMutation({ ...created, bets: [] }, candidate, async () => ledger), { code: 'LEDGER_READBACK_MISSING' });
await assert.rejects(confirmCloudBetMutation(created, candidate, async () => ({ ok: true, bets: [] })), { code: 'LEDGER_READBACK_MISSING' });
for (const changed of [{ stake: 200 }, { water: 0.93 }, { pick: '大9平' }, { league: 'NPB' }, { gamePk: 900002 }, { status: 'CANCELLED' }]) {
  await assert.rejects(confirmCloudBetMutation(created, candidate, async () => ({ ok: true, bets: [{ ...stored, ...changed }] })), { code: 'LEDGER_READBACK_CONFLICT' });
}
await assert.rejects(confirmCloudBetMutation(created, candidate, async () => ({ ok: true, bets: [{ ...stored, pitEvidenceVerified: false }] })), { code: 'LEDGER_READBACK_UNVERIFIED' });
assert.equal(findConfirmedRecordedBet(ledger, candidate)?.id, stored.id);
assert.equal(findConfirmedRecordedBet({ ok: true, bets: [{ ...stored, stake: 200 }] }, candidate), null);
assert.equal(findConfirmedRecordedBet({ ok: true, bets: [stored, { ...stored, id: 'duplicate' }] }, candidate), null);
assert.throws(() => requireCancelledBet(ledger, stored.id), { code: 'LEDGER_CANCEL_UNCONFIRMED' });
requireCancelledBet({ ok: true, bets: [{ ...stored, status: 'CANCELLED' }] }, stored.id);
assert.equal(cloudBetMutationOutcomeUncertain({ status: 409, code: 'PIT_EVIDENCE_REQUIRED' }), false);
assert.equal(cloudBetMutationOutcomeUncertain({ status: 503 }), true);
assert.equal(cloudBetMutationOutcomeUncertain(new TypeError('Failed to fetch')), true);

// Execute the actual page handler with controlled I/O. This catches publishing
// state before GET, loss of the mutation lock, and failure recovery regressions.
const page = fs.readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
const recordSource = page.slice(page.indexOf('  async function recordBet('), page.indexOf('  async function cancelBet('));
function harness(requestJSON, recovery = async () => undefined) {
  const state = { bets: [], notice: '', error: '', busy: false };
  const env = {
    isHistoricalIdentityConflict: () => false,
    bettingEnabled: true, activeLeague: { label: 'MLB' },
    getBetState: () => ({ latest: null, cancelled: null }),
    cloudLedgerStatus: { state: 'ready' }, cloudSyncBusyRef: { current: false },
    cloudLedgerBusy: false, betMutationBusyRef: { current: false },
    evaluateBetAction: () => ({ recordable: true }), liveReaderAuthority: {},
    betIdentity, betPositionIdentity, date: candidate.date, league: candidate.league,
    readerCaptureForBet: () => ({ payloadHash: 'a'.repeat(64), rawBoardHash: 'b'.repeat(64), revision: `${candidate.date}:${'a'.repeat(64)}` }),
    uid: () => 'client-candidate', settings: { unitValue: candidate.stake, rebateRate: 0.015 },
    teamNameZh: value => value, modelEvValue: () => 0.01, robustEvValue: () => 0.01,
    calibrationFeatureTimes: () => ({}), markAppOperationBusy: value => { state.operationBusy = value; },
    cloudLedgerGenerationRef: { current: 0 }, cloudSyncRetryAtRef: { current: 0 },
    betsRef: { current: [] }, creditRevisionRef: { current: '' },
    setCloudLedgerBusy: value => { state.busy = value; },
    setError: value => { state.error = value; }, setNotice: value => { state.notice = value; },
    setBets: value => { state.bets = value; }, setCalibrationStatus: () => {},
    setCloudLedgerStatus: value => { state.ledgerStatus = value; },
    reportCloudLedgerFailure: value => { state.failure = value; },
    translateTeamText: value => value,
    requestJSON, confirmCloudBetMutation, findConfirmedRecordedBet,
    cloudBetMutationOutcomeUncertain, probeCloudLedgerRecovery: recovery,
  };
  const handler = new Function(...Object.keys(env), `return (${recordSource});`)(...Object.values(env));
  return { state, env, run: () => handler({ game: { gamePk: candidate.gamePk, away: 'Away', home: 'Home', gameDate: '2027-09-10T18:00:00Z' } }, candidate) };
}

let releaseGet;
const delayedGet = new Promise(resolve => { releaseGet = resolve; });
const requests = [];
const success = harness(async (_url, options) => {
  requests.push(options?.method || 'GET');
  return options?.method === 'POST' ? created : delayedGet;
});
const pending = success.run();
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(requests, ['POST', 'GET']);
assert.deepEqual(success.state.bets, [], 'POST alone must not publish a recorded state');
assert.equal(success.state.busy, true);
assert.equal(success.env.betMutationBusyRef.current, true, 'GET readback stays inside the mutation lock');
await success.run();
assert.deepEqual(requests, ['POST', 'GET'], 'a second tap cannot submit while readback is pending');
releaseGet(ledger);
await pending;
assert.equal(success.state.bets[0].id, stored.id);
assert.equal(success.state.busy, false);
assert.equal(success.env.betMutationBusyRef.current, false);
assert.match(success.state.notice, /已寫入並回讀/);

let reconciles = 0;
const rejected = harness(async () => { throw Object.assign(new Error('PIT成交盤缺少有效伺服器簽章'), { status: 409, code: 'PIT_EVIDENCE_REQUIRED' }); }, async () => { reconciles += 1; return { ok: true, bets: [] }; });
await rejected.run();
assert.equal(reconciles, 1);
assert.deepEqual(rejected.state.bets, []);
assert.match(rejected.state.error, /伺服器簽章/);
assert.equal(rejected.state.notice, '');
assert.equal(rejected.state.busy, false);

const disconnected = harness(async () => { throw new TypeError('Failed to fetch'); }, async () => ledger);
await disconnected.run();
assert.match(disconnected.state.notice, /確認紀錄存在/);
assert.equal(disconnected.state.error, '');
const unresolved = harness(async () => { throw new TypeError('Failed to fetch'); }, async () => ({ ok: true, bets: [] }));
await unresolved.run();
assert.match(unresolved.state.error, /可重試/);
assert.equal(unresolved.state.notice, '');
const mismatch = harness(async (_url, options) => options?.method === 'POST' ? created : { ok: true, bets: [] });
await mismatch.run();
assert.deepEqual(mismatch.state.bets, []);
assert.match(mismatch.state.error, /尚未確認/);

const cancelSource = page.slice(page.indexOf('  async function cancelBet('), page.indexOf('  function selectLeague('));
let releaseCancelGet;
const cancelGet = new Promise(resolve => { releaseCancelGet = resolve; });
const cancelledLedger = { ok: true, bets: [{ ...stored, status: 'CANCELLED' }] };
const cancellation = harness(async (_url, options) => options?.method === 'POST' ? cancelledLedger : cancelGet);
cancellation.state.bets = [stored];
const cancelEnv = { ...cancellation.env, window: { confirm: () => true }, waterText: value => String(value), requireCancelledBet, requireCloudLedgerResponse };
const cancelHandler = new Function(...Object.keys(cancelEnv), `return (${cancelSource});`)(...Object.values(cancelEnv));
const cancellationPending = cancelHandler(stored);
await new Promise(resolve => setImmediate(resolve));
assert.equal(cancellation.state.bets[0].status, 'OPEN', 'cancellation keeps the prior record until GET confirms');
assert.equal(cancellation.env.betMutationBusyRef.current, true);
releaseCancelGet(cancelledLedger);
await cancellationPending;
assert.equal(cancellation.state.bets[0].status, 'CANCELLED');
assert.equal(cancellation.env.betMutationBusyRef.current, false);
assert.match(cancellation.state.notice, /已取消下注/);

// Cancellation's POST list is bounded; an older record may only appear in the
// subsequent targeted GET. Confirm the exact ID there before publishing success.
const oldCancelRequests = [];
const oldCancellation = harness(async (url, options) => {
  oldCancelRequests.push({ url, method: options?.method || 'GET' });
  return options?.method === 'POST' ? { ok: true, bets: [] } : cancelledLedger;
});
oldCancellation.state.bets = [stored];
const oldCancelEnv = { ...oldCancellation.env, window: { confirm: () => true }, waterText: value => String(value), requireCancelledBet, requireCloudLedgerResponse };
const oldCancelHandler = new Function(...Object.keys(oldCancelEnv), `return (${cancelSource});`)(...Object.values(oldCancelEnv));
await oldCancelHandler(stored);
assert.deepEqual(oldCancelRequests, [
  { url: '/api/bets', method: 'POST' },
  { url: `/api/bets?confirmBetId=${encodeURIComponent(stored.id)}`, method: 'GET' },
]);
assert.equal(oldCancellation.state.bets[0].status, 'CANCELLED');
assert.match(oldCancellation.state.notice, /已取消下注/);
assert.equal(oldCancellation.state.error, '');

// Run the actual initial-load effect to verify malformed HTTP 200 cannot
// mark stale local records as a synchronized cloud ledger.
const effectStart = page.indexOf('  useEffect(() => {\n    let disposed = false;\n    const generation = ++cloudLedgerGenerationRef.current;');
const effectEnd = page.indexOf('  }, []);', effectStart);
assert.ok(effectStart >= 0 && effectEnd > effectStart);
const effectBody = page.slice(effectStart + '  useEffect(() => {'.length, effectEnd);
const initialState = { status: 'loading', failures: [] };
const initialEnv = {
  cloudLedgerGenerationRef: { current: 0 }, loadCompactStore: () => ({ bets: [], activeLeague: 'MLB', settings: {} }),
  migrateLegacyLocalBets: bets => bets, window: { location: { search: '' } }, LEAGUE_IDS: ['MLB'],
  setLeague: () => {}, setSettings: () => {}, betsRef: { current: [] }, setBets: () => {},
  setStorageReady: () => {}, cloudSyncBusyRef: { current: false }, setCloudLedgerBusy: () => {},
  cloudBetMigrationComplete: () => true, requestJSON: async () => ({ ok: true }),
  requireCloudLedgerResponse, betMutationBusyRef: { current: false },
  markCloudBetMigrationComplete: () => {}, setCalibrationStatus: () => {}, cloudSyncRetryAtRef: { current: 0 },
  setCloudLedgerStatus: value => { initialState.status = value.state; },
  reportCloudLedgerFailure: error => { initialState.failures.push(error.code); },
};
new Function(...Object.keys(initialEnv), effectBody)(...Object.values(initialEnv));
await new Promise(resolve => setImmediate(resolve));
assert.equal(initialState.status, 'loading', 'malformed data must never transition to ready');
assert.deepEqual(initialState.failures, ['LEDGER_RESPONSE_INVALID']);

// A detached mount/earlier read cannot overwrite a newer confirmed state.
let oldReadFinish;
const oldRead = new Promise(resolve => { oldReadFinish = resolve; });
let setBetsCalls = 0;
const staleEnv = { ...initialEnv, cloudLedgerGenerationRef: { current: 0 }, requestJSON: async () => oldRead,
  setBets: () => { setBetsCalls += 1; },
};
const cleanup = new Function(...Object.keys(staleEnv), effectBody)(...Object.values(staleEnv));
assert.equal(setBetsCalls, 1, 'initial cached snapshot is only shown while loading');
cleanup();
staleEnv.cloudLedgerGenerationRef.current += 1;
oldReadFinish(ledger);
await new Promise(resolve => setImmediate(resolve));
assert.equal(setBetsCalls, 1, 'late detached read must not replace a newer ledger');

console.log('Cloud ledger POST/GET durability, idempotent receipts, exact identity, failed PIT, disconnect recovery and initial-load state PASS');
