import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { evaluateSoccerCalibrationShadow, readSoccerCalibrationShadowReport } from '../lib/soccer/calibration-shadow-validation.js';
import { soccerCalibrationShadowFixture } from './helpers/soccer-calibration-shadow-fixture.mjs';

const f = soccerCalibrationShadowFixture(3), history = [], calls = [], outcomes = new Map();
const deps = {
  now: () => f.now,
  loadEvidence: async (_league, options = {}) => f.context(options.captureIds || null, options.limit || 100),
  listPending: async (_league, { limit, freezeId }) => { assert.equal(freezeId, f.freezeReceipt.freezeId); return f.records.slice(0, limit).map(record => record.captureReceipt.captureId); },
  readHistory: async (_league, { captureIds }) => history.filter(check => captureIds.includes(check.captureId)),
  archive: async value => { history.push({ ...structuredClone(value), checkedAt: new Date(f.now).toISOString() }); return { persisted: true }; },
  fetchJson: async url => {
    calls.push(url); const parsed = new URL(url), eventId = parsed.searchParams.get('event');
    const selected = f.records.find(record => record.prediction.game.sourceId === eventId) || f.records[0];
    if (parsed.pathname.endsWith('/summary')) return f.resultDocuments(selected, outcomes.get(selected.captureReceipt.captureId) || {}).summaries[0];
    const board = f.resultDocuments(f.records[0], outcomes.get(f.records[0].captureReceipt.captureId) || {}).scoreboard;
    board.data.events = f.records.flatMap(record => f.resultDocuments(record, outcomes.get(record.captureReceipt.captureId) || {}).scoreboard.data.events);
    board.source.contentHash = createHash('sha256').update(JSON.stringify(board.data)).digest('hex'); return board;
  },
  baseReport: async () => ({ captureGames: f.records.length, fullTimeCaptures: f.records.length, halfTimeCaptures: f.records.length, untouchedValidatedGames: 0 }),
  listCaptureIds: async (_league, { afterSequence }) => afterSequence === '0'
    ? { captureIds: f.records.slice(0, 2).map(record => record.captureReceipt.captureId), nextSequence: '2', completeWithinRequestedScope: false }
    : { captureIds: [f.records[2].captureReceipt.captureId], nextSequence: null, completeWithinRequestedScope: true },
};
const first = await evaluateSoccerCalibrationShadow({ league: 'epl', limit: 1 }, deps);
assert.equal(first.summary.validatedGames, 1, JSON.stringify(first.summary));
assert.equal(first.summary.persisted, true); assert.equal(first.summary.checkedGames, 1); assert.equal(first.summary.accepted, false);
assert.equal(first.report.completeWithinRequestedScope, false); assert.equal(calls.length, 2);
assert.ok(calls.every(url => url.startsWith('https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/')));
assert.equal((await evaluateSoccerCalibrationShadow({ league: 'epl', limit: 1 }, deps)).summary.validatedGames, 1);
let report = await readSoccerCalibrationShadowReport('epl', deps);
assert.equal(report.untouchedValidatedGames, 1); assert.equal(report.pendingValidationGames, 2);
assert.equal(report.validationCoverage.completeWithinRequestedScope, true); assert.equal(report.validationCoverage.readCaptures, 3);
assert.equal(report.validation.before.FT.games, 1); assert.equal(report.validation.after.HT.games, 1);
outcomes.set(f.records[0].captureReceipt.captureId, { homeScore: 2 });
const conflict = await evaluateSoccerCalibrationShadow({ league: 'epl', limit: 1 }, deps);
assert.equal(conflict.summary.validatedGames, 0); assert.equal(conflict.summary.quarantinedGames, 1);
report = await readSoccerCalibrationShadowReport('epl', deps);
assert.equal(report.untouchedValidatedGames, 0); assert.equal(report.quarantinedGames, 1); assert.equal(report.validation.before.FT.games, 0);
history.push({ captureId: f.records[1].captureReceipt.captureId, checkedAt: new Date(f.now).toISOString(), resultDocuments: f.resultDocuments(f.records[1], { extraPeriod: true }) });
assert.equal((await readSoccerCalibrationShadowReport('epl', deps)).quarantinedGames, 2, 'distinct actual-score and extra-period conflicts must union, not max');
const neutralHistory = [{ captureId: f.records[2].captureReceipt.captureId, checkedAt: new Date(f.now).toISOString(), resultDocuments: f.resultDocuments(f.records[2]) }];
const correctedNeutral = structuredClone(neutralHistory[0]);
correctedNeutral.resultDocuments.summaries[0].data.header.competitions[0].neutralSite = true;
correctedNeutral.resultDocuments.summaries[0].source.contentHash = createHash('sha256').update(JSON.stringify(correctedNeutral.resultDocuments.summaries[0].data)).digest('hex');
const neutralDeps = { ...deps, readHistory: async (_league, { captureIds }) => [...neutralHistory, correctedNeutral].filter(check => captureIds.includes(check.captureId)) };
assert.equal((await readSoccerCalibrationShadowReport('epl', neutralDeps)).untouchedValidatedGames, 0);
assert.equal((await readSoccerCalibrationShadowReport('epl', neutralDeps)).quarantinedGames, 1, 'later explicit normal-final neutral-site correction must invalidate the original context');
const badHash = structuredClone(correctedNeutral); badHash.resultDocuments.summaries[0].source.contentHash = '0'.repeat(64);
assert.equal((await readSoccerCalibrationShadowReport('epl', { ...deps,
  readHistory: async (_league, { captureIds }) => [...neutralHistory, badHash].filter(check => captureIds.includes(check.captureId)) })).untouchedValidatedGames, 1,
  'a corrupted document hash cannot manufacture contrary result evidence');
for (const name of ['STATUS_FULL_TIME_AET', 'STATUS_FINAL_AET', 'STATUS_FULL_TIME_SHOOTOUT',
  'STATUS_FINAL_PENALTIES', 'STATUS_FINAL_PEN', 'STATUS_FULL_TIME_PENS', 'STATUS_FINAL_PSO']) {
  for (const period of [2, undefined]) {
    const extraStatus = structuredClone(neutralHistory[0]);
    const status = extraStatus.resultDocuments.summaries[0].data.header.competitions[0].status;
    status.type.name = name;
    if (period === undefined) delete status.period; else status.period = period;
    extraStatus.resultDocuments.summaries[0].source.contentHash = createHash('sha256')
      .update(JSON.stringify(extraStatus.resultDocuments.summaries[0].data)).digest('hex');
    const extraReport = await readSoccerCalibrationShadowReport('epl', { ...deps,
      readHistory: async (_league, { captureIds }) => [...neutralHistory, extraStatus].filter(check => captureIds.includes(check.captureId)) });
    assert.equal(extraReport.untouchedValidatedGames, 0, `${name} with period ${period} must remove the earlier normal-final result`);
    assert.equal(extraReport.quarantinedGames, 1, `${name} with period ${period} must quarantine the whole game`);
    assert.equal(extraReport.validation.before.FT.games, 0);
    assert.equal(extraReport.validation.after.HT.games, 0);
  }
}
for (const mutate of [
  documents => { documents.summaries[0].data.header.status = { period: 3, type: { name: 'STATUS_FULL_TIME', state: 'post', completed: true } }; },
  documents => { documents.summaries[0].data.status = { period: 3, type: { name: 'STATUS_FULL_TIME', state: 'post', completed: true } }; },
  documents => { documents.scoreboard.data.events[0].status.period = 3; },
  documents => { documents.scoreboard.data.events[0].competitions[0].status.period = 3; },
]) {
  const extraPeriod = structuredClone(neutralHistory[0]);
  mutate(extraPeriod.resultDocuments);
  for (const document of [extraPeriod.resultDocuments.scoreboard, ...extraPeriod.resultDocuments.summaries])
    document.source.contentHash = createHash('sha256').update(JSON.stringify(document.data)).digest('hex');
  const extraReport = await readSoccerCalibrationShadowReport('epl', { ...deps,
    readHistory: async (_league, { captureIds }) => [...neutralHistory, extraPeriod].filter(check => captureIds.includes(check.captureId)) });
  assert.equal(extraReport.untouchedValidatedGames, 0, 'any verified same-game endpoint period-3 evidence must remove the older normal-final result');
  assert.equal(extraReport.quarantinedGames, 1);
  assert.equal(extraReport.validation.before.FT.games, 0);
  assert.equal(extraReport.validation.after.HT.games, 0);
}
const otherGameExtra = structuredClone(neutralHistory[0]), otherEvent = structuredClone(otherGameExtra.resultDocuments.scoreboard.data.events[0]);
otherEvent.id = '999999999'; otherEvent.uid = `s:600~l:700~e:${otherEvent.id}`;
otherEvent.competitions[0].id = otherEvent.id; otherEvent.competitions[0].uid = `${otherEvent.uid}~c:${otherEvent.id}`;
otherEvent.status.period = 3;
otherGameExtra.resultDocuments.scoreboard.data.events.push(otherEvent);
otherGameExtra.resultDocuments.scoreboard.source.contentHash = createHash('sha256')
  .update(JSON.stringify(otherGameExtra.resultDocuments.scoreboard.data)).digest('hex');
const otherGameReport = await readSoccerCalibrationShadowReport('epl', { ...deps,
  readHistory: async (_league, { captureIds }) => [...neutralHistory, otherGameExtra].filter(check => captureIds.includes(check.captureId)) });
assert.equal(otherGameReport.untouchedValidatedGames, 1, 'an unrelated board event with extra periods must not quarantine this game');
assert.equal(otherGameReport.quarantinedGames, 0);
console.log('PASS fixed server URLs → complete normal-final documents → trusted freeze/capture replay → immutable save/readback; GET pages actual histories, deduplicates games and removes every score/scope conflict from paired metrics');

const pendingHistory = [], pendingDeps = { ...deps,
  readHistory: async (_league, { captureIds }) => pendingHistory.filter(check => captureIds.includes(check.captureId)),
  archive: async value => { pendingHistory.push({ ...structuredClone(value), checkedAt: new Date(f.now).toISOString() }); return { persisted: true }; },
  fetchJson: async url => { const docs = f.resultDocuments(f.records[0], { live: true }); return url.includes('/summary?') ? docs.summaries[0] : docs.scoreboard; } };
const pending = await evaluateSoccerCalibrationShadow({ league: 'epl', limit: 1 }, pendingDeps);
assert.equal(pending.summary.pendingGames, 1); assert.equal(pending.summary.validatedGames, 0); assert.equal(pending.summary.status, 'PENDING');
assert.equal((await readSoccerCalibrationShadowReport('epl', pendingDeps)).untouchedValidatedGames, 0);
const noFreeze = await evaluateSoccerCalibrationShadow({ league: 'epl' }, { ...deps, loadEvidence: async () => ({ ...f.context(), freezeReceipt: null }) });
assert.equal(noFreeze.summary.checkedGames, 0); assert.equal(noFreeze.summary.status, 'NO_PENDING_CAPTURES');
await assert.rejects(() => evaluateSoccerCalibrationShadow({ league: 'nba' }, deps), /SCOPE_INVALID/);
await assert.rejects(() => evaluateSoccerCalibrationShadow({ league: 'epl', limit: 4 }, deps), /SCOPE_INVALID/);
await assert.rejects(() => evaluateSoccerCalibrationShadow({ league: 'epl', limit: 1 }, { ...deps, archive: async () => { throw Error('database failed'); } }), /database failed/);
await assert.rejects(() => readSoccerCalibrationShadowReport('epl', { ...deps, readHistory: async () => { throw Error('database failed'); } }), /database failed/);
for (const captureGames of [2, 4]) await assert.rejects(() => readSoccerCalibrationShadowReport('epl', { ...deps, baseReport: async () => ({ captureGames }) }), /COUNT_CHANGED_DURING_READ/);
const futureSource = structuredClone(pendingHistory[0]); futureSource.resultDocuments.scoreboard.source.fetchedAt = '2026-11-04T00:00:00.000Z';
await assert.rejects(() => readSoccerCalibrationShadowReport('epl', { ...deps, readHistory: async () => [futureSource] }), /RECEIPT_TIME_INVALID/);
const futureReceipt = { ...pendingHistory[0], checkedAt: '2026-11-04T00:00:00.000Z' };
await assert.rejects(() => readSoccerCalibrationShadowReport('epl', { ...deps, readHistory: async () => [futureReceipt] }), /RECEIPT_TIME_INVALID/);
let limitedNow = f.now;
const bounded = await readSoccerCalibrationShadowReport('epl', { ...deps, now: () => limitedNow,
  loadEvidence: async (...args) => { const value = await deps.loadEvidence(...args); limitedNow += 20000; return value; } });
assert.equal(bounded.validationCoverage.completeWithinRequestedScope, false);
assert.equal(bounded.validationCoverage.readCaptures, 2); assert.equal(bounded.validationStatus, 'PARTIAL_HISTORY_READ');
console.log('PASS unfinished games stay PENDING; absent freeze, DB failure, count races and future source/receipt times remain unavailable rather than fabricated zero or PASS');
