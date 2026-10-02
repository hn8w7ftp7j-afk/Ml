import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { NextResponse } from 'next/server.js';
import { requireApiAuth, checkRateLimit, rateLimitResponse, createSessionToken } from '../lib/security.js';
import { HISTORY_EXPORT_HEADERS, historyExportHeaders, parseHistoryExportLeague } from '../lib/history-export-options.js';
import { parseHistorySnapshotIds, exportHistorySnapshot } from '../lib/pit-history-export.js';
import { buildAnalysisPitSnapshotRecord } from '../lib/analysis-pit-snapshot-store-v1.js';
import { ANALYSIS_DIRECTION_SLOTS, buildAnalysisDirectionHistory, validateAnalysisDirectionRecord } from '../lib/analysis-direction-history-v1.js';
import { SETTLEMENT_RULE_VERSION } from '../lib/taiwan-settlement-v9.js';
import { MODEL_EV_FORMULA_VERSION, ROBUST_EV_VERSION } from '../lib/analysis-v11.js';
import { DIRECTION_SLOT_CONTRACT_VERSION } from '../lib/direction-slots-v1.js';

// Local fixtures only: execute each real route body with a SQL boundary stub,
// keeping its actual auth, serialization, envelope and identity validation.
process.env.APP_PASSWORD = 'history-export-local-test';
process.env.SESSION_SECRET = 'history-export-local-secret-abcdefghijklmnopqrstuvwxyz';
const token = await createSessionToken();
const until = '2026-10-01T00:00:00.000Z';
const dataAsOf = '2026-09-01T08:00:00.000Z';
const createdAt = '2026-09-01T08:02:00.000Z';
const hash = character => character.repeat(64);
const versions = { modelVersion: 'export-fixture-model', rulesVersion: 'export-fixture-rules', dataVersion: 'export-fixture-data',
  scoreFormulaVersion: 'export-fixture-score', settlementRuleVersion: SETTLEMENT_RULE_VERSION, uncertaintySetVersion: 'export-fixture-uncertainty',
  modelEvFormulaVersion: MODEL_EV_FORMULA_VERSION, robustEvVersion: ROBUST_EV_VERSION, directionSlotContractVersion: DIRECTION_SLOT_CONTRACT_VERSION };
const snapshots = [], directions = [];
for (const [index, leagueId] of ['MLB', 'NPB', 'KBO', 'CPBL'].entries()) {
  const game = { leagueId, gamePk: 100001 + index, gameNumber: 1, awayTeamId: 101, homeTeamId: 102,
    gameDate: '2026-09-01T10:00:00.000Z', officialDate: '2026-09-01', away: 'Away', home: 'Home' };
  const context = { leagueId, game, fetchedAt: dataAsOf,
    featureProvenance: [{ featureName: 'fixture', fetchedAt: dataAsOf, sourceProvider: 'LOCAL_FIXTURE' }] };
  const analysis = { leagueId, analysisType: 'FULL', inputHash: hash('a'), coreFingerprint: hash('b'), priceFingerprint: hash('c'),
    calculationFingerprint: hash('d'), auxiliaryFingerprint: hash('e'), distributionId: `${leagueId}:fixture-distribution`,
    distributionHash: hash('f'), dataAsOf, analysisAsOf: '2026-09-01T08:01:00.000Z', lineAsOf: dataAsOf, results: [] };
  const distributionSnapshot = { distributionId: analysis.distributionId, distributionHash: analysis.distributionHash,
    gamePk: game.gamePk, scenarios: [{ id: 'fixture', weight: 1, cells: [{ awayRuns: 1, homeRuns: 1, probability: 1 }] }] };
  const record = buildAnalysisPitSnapshotRecord({ league: leagueId, game, frozenContext: context, analysis, versions, distributionSnapshot });
  const row = Object.fromEntries(Object.entries(record).map(([key, value]) => [key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`), value]));
  snapshots.push({ ...row, external_game_id: String(game.gamePk), created_at: createdAt, model_version: versions.modelVersion });
  const picks = ['Home讓1', 'Away受讓1', '大8.5', '小8.5', 'Home讓0.5', 'Away受讓0.5', '大4.5', '小4.5'];
  const directionSlots = ANALYSIS_DIRECTION_SLOTS.map((slot, slotIndex) => ({ ...slot, status: 'CALCULATED',
    pick: picks[slotIndex], water: 0.95, modelEV: 0.02, robustEV: 0.01,
    robustVariants: [{ id: 'fixture-conservative', value: 0.01 }], qaStatus: 'PASS', score: 7.5, sourceType: 'FIXTURE' }));
  for (const direction of buildAnalysisDirectionHistory({ snapshotRecord: record, analysis: { ...analysis, directionSlots } }).records) {
    directions.push({ direction_result_id: direction.directionResultId, league_id: leagueId, record_hash: direction.recordHash,
      record_payload: direction, created_at: createdAt, result_snapshot: { fixture: true, league: leagueId },
      settlement_status: 'SETTLED', result_saved_at: createdAt });
  }
}
const kboSnapshot = snapshots.find(row => row.league_id === 'KBO');
const inventory = [...snapshots.filter(row => row.league_id !== 'KBO'), ...Array.from({ length: 502 }, (_, index) => ({
  ...kboSnapshot, snapshot_id: `KBO:${200000 + index}:FULL:${hash('a')}`, external_game_id: String(200000 + index),
}))];
let calls = [], rateBlocked = false, databaseFailed = false, directionOverride = null;
const sql = async (parts, ...values) => {
  const statement = parts.join('?');
  calls.push({ statement, values });
  assert.doesNotMatch(statement, /\b(?:INSERT INTO|UPDATE|DELETE FROM|CREATE TABLE|ALTER TABLE)\b/i);
  assert.doesNotMatch(statement, /KBO|NPB|CPBL/, 'league filters must be bound values');
  if (databaseFailed) throw new Error('FIXTURE_DB_UNAVAILABLE');
  if (statement.includes('baseball_analysis_direction_results d')) {
    const [settlementUntil, cutoff, after, league, repeatedLeague, limit] = values;
    assert.equal(settlementUntil, until); assert.equal(cutoff, until); assert.equal(league, repeatedLeague);
    assert.match(statement, /\(\?::text IS NULL OR d\.league_id=\?\)/);
    return (directionOverride || directions).filter(row => (!league || row.league_id === league) && row.direction_result_id > after
      && row.created_at <= cutoff).sort((a, b) => a.direction_result_id.localeCompare(b.direction_result_id)).slice(0, limit);
  }
  const totals = statement.includes('GROUP BY league_id');
  const [cutoff, afterOrLeague, leagueOrRepeated, repeatedLeague] = values;
  const league = totals ? afterOrLeague : leagueOrRepeated;
  assert.equal(cutoff, until); assert.equal(league, totals ? leagueOrRepeated : repeatedLeague);
  assert.match(statement, /\(\?::text IS NULL OR league_id=\?\)/);
  const matching = inventory.filter(row => (!league || row.league_id === league) && row.created_at <= cutoff);
  if (totals) return [...new Set(matching.map(row => row.league_id))].sort().map(leagueId => ({
    league_id: leagueId, snapshots: String(matching.filter(row => row.league_id === leagueId).length),
  }));
  assert.match(statement, /ORDER BY snapshot_id LIMIT 501/);
  return matching.filter(row => row.snapshot_id > afterOrLeague).sort((a, b) => a.snapshot_id.localeCompare(b.snapshot_id)).slice(0, 501);
};
const boundaries = { NextResponse, neon: () => sql, durableDatabaseUrl: () => 'fixture-only', requireApiAuth,
  checkRateLimit: (...args) => rateBlocked ? { allowed: false, retryAfter: 60 } : checkRateLimit(...args), rateLimitResponse,
  HISTORY_EXPORT_HEADERS, historyExportHeaders, parseHistoryExportLeague, gzipSync, createHash,
  parseHistorySnapshotIds, validateAnalysisDirectionRecord,
  exportHistorySnapshot: scope => exportHistorySnapshot(scope, { readSnapshotRows: async (snapshotId, league) => {
    calls.push({ snapshotId, league });
    return snapshots.filter(row => row.snapshot_id === snapshotId && row.league_id === league);
  }, hydrateContext: async context => context }),
};
const route = (name, overrides = {}) => {
  const source = readFileSync(new URL(`../app/api/${name}/route.js`, import.meta.url), 'utf8');
  const body = source.replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
  const services = { ...boundaries, ...overrides };
  return new Function(...Object.keys(services), `${body};return GET;`)(...Object.values(services));
};
const handlers = Object.fromEntries(['history-inventory', 'history-directions-export', 'pit-history-export'].map(name => [name, route(name)]));
const request = (name, params, authenticated = true) => new Request(`http://localhost/api/${name}?${new URLSearchParams(params)}`, {
  headers: authenticated ? { cookie: `mlb_session=${token}`, 'x-forwarded-for': '198.51.100.44' } : {},
});
const decode = envelope => {
  const raw = gunzipSync(Buffer.from(envelope.payload, 'base64'));
  assert.equal(createHash('sha256').update(raw).digest('hex'), envelope.sha256);
  if (envelope.rawBytes != null) assert.equal(envelope.rawBytes, raw.length);
  return JSON.parse(raw);
};
const queries = {
  'history-inventory': { league: 'KBO', until },
  'history-directions-export': { league: 'KBO', until, limit: '2' },
  'pit-history-export': { snapshotIds: kboSnapshot.snapshot_id },
};
for (const [name, handler] of Object.entries(handlers)) {
  calls = [];
  const unauthenticated = await handler(request(name, { ...queries[name], download: '1' }, false));
  assert.equal(unauthenticated.status, 401); assert.equal(calls.length, 0);
  assert.equal(unauthenticated.headers.get('content-disposition'), null);
  rateBlocked = true;
  assert.equal((await handler(request(name, { ...queries[name], download: '1' }))).status, 429);
  assert.equal(calls.length, 0); rateBlocked = false;
  const ordinary = await handler(request(name, queries[name]));
  const download = await handler(request(name, { ...queries[name], download: '1' }));
  assert.equal(ordinary.status, 200); assert.equal(download.status, 200);
  assert.equal(ordinary.headers.get('content-disposition'), null);
  assert.equal(download.headers.get('content-disposition'), `attachment; filename="${name}.json"`);
  assert.equal(download.headers.get('cache-control'), 'private, no-store');
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  assert.match(download.headers.get('content-type'), /^application\/json/);
  const ordinaryText = await ordinary.text(), downloadText = await download.text();
  assert.equal(downloadText, ordinaryText, 'download only changes headers, never the JSON payload');
  const envelope = JSON.parse(downloadText), body = envelope.payload ? decode(envelope) : envelope;
  assert.equal(body.productionWrites, false);
  if (name === 'history-inventory') {
    assert.equal(body.rows.length, 500); assert.equal(body.nextAfter, body.rows[499].snapshot_id);
    assert.ok(body.rows.every(row => row.league_id === 'KBO'));
    assert.deepEqual(body.totals, [{ league_id: 'KBO', snapshots: '502' }]);
    assert.deepEqual(calls[0].values, [until, '', 'KBO', 'KBO']);
    assert.deepEqual(calls[1].values, [until, 'KBO', 'KBO']);
    const next = await handler(request(name, { ...queries[name], after: body.nextAfter }));
    const nextBody = await next.json();
    assert.equal(nextBody.rows.length, 2); assert.equal(nextBody.totals, null); assert.equal(nextBody.nextAfter, null);
    assert.ok(nextBody.rows.every(row => row.snapshot_id > body.nextAfter && row.league_id === 'KBO'));
  } else if (name === 'history-directions-export') {
    assert.equal(body.records.length, 2); assert.ok(body.records.every(row => row.ok && row.record.leagueId === 'KBO'));
    assert.equal(body.nextAfter, body.records[1].record.directionResultId);
    assert.deepEqual(calls[0].values, [until, until, '', 'KBO', 'KBO', 3]);
    const next = decode(await (await handler(request(name, { ...queries[name], after: body.nextAfter }))).json());
    assert.equal(next.records.length, 2);
    assert.ok(next.records.every(row => row.record.directionResultId > body.nextAfter && row.record.leagueId === 'KBO'));
  } else {
    assert.equal(body.results.length, 1); assert.equal(body.results[0].ok, true);
    assert.equal(body.results[0].bundle.leagueId, 'KBO'); assert.equal(body.results[0].integrityVerified, true);
    assert.equal(body.results[0].productionReuseAllowed, false); assert.equal(body.results[0].persistenceAllowed, false);
  }
}
for (const name of ['history-inventory', 'history-directions-export']) {
  for (const league of ['', 'kbo', 'NBA', '__proto__', "KBO';DROP TABLE x;--"]) {
    calls = [];
    const response = await handlers[name](request(name, { ...queries[name], league, download: '1' }));
    assert.equal(response.status, 400); assert.equal(calls.length, 0); assert.equal(response.headers.get('content-disposition'), null);
  }
  calls = [];
  const repeated = request(name, queries[name]);
  const duplicate = new Request(`${repeated.url}&league=MLB`, { headers: repeated.headers });
  assert.equal((await handlers[name](duplicate)).status, 400); assert.equal(calls.length, 0);
  for (const league of ['MLB', 'NPB', 'KBO', 'CPBL']) {
    assert.equal((await handlers[name](request(name, { ...queries[name], league }))).status, 200);
  }
  const all = await handlers[name](request(name, { until, ...(name === 'history-directions-export' ? { limit: '500' } : {}) }));
  const allEnvelope = await all.json(), allBody = allEnvelope.payload ? decode(allEnvelope) : allEnvelope;
  assert.equal(new Set(name === 'history-inventory' ? allBody.totals.map(row => row.league_id)
    : allBody.records.map(row => row.record.leagueId)).size, 4, 'omitted league preserves all-league behavior');
  databaseFailed = true;
  const failed = await handlers[name](request(name, queries[name]));
  assert.equal(failed.status, 503); assert.equal(failed.headers.get('content-disposition'), null);
  databaseFailed = false;
}
for (const [name, query] of [
  ['history-inventory', { after: snapshots[0].snapshot_id }],
  ['history-inventory', { after: 'bad' }],
  ['history-directions-export', { after: 'bad' }],
  ['history-directions-export', { limit: '0' }],
  ['history-directions-export', { limit: '501' }],
  ['pit-history-export', { snapshotIds: 'bad' }],
  ['pit-history-export', { snapshotIds: `${kboSnapshot.snapshot_id},${kboSnapshot.snapshot_id}` }],
]) {
  calls = [];
  assert.equal((await handlers[name](request(name, { ...queries[name], ...query }))).status, 400);
  assert.equal(calls.length, 0);
}
directionOverride = [{ ...directions.find(row => row.league_id === 'MLB'), league_id: 'KBO' }];
const corrupt = decode(await (await handlers['history-directions-export'](request('history-directions-export', queries['history-directions-export']))).json());
assert.equal(corrupt.records[0].ok, false); assert.equal(corrupt.records[0].code, 'DIRECTION_INTEGRITY_FAILED');
directionOverride = null;
const oversized = route('pit-history-export', { exportHistorySnapshot: async () => ({ fixture: randomBytes(2_200_000).toString('base64') }) });
const tooLarge = await oversized(request('pit-history-export', { ...queries['pit-history-export'], download: '1' }));
assert.equal(tooLarge.status, 413); assert.equal(tooLarge.headers.get('content-disposition'), null);
console.log('PASS: authenticated read-only history downloads, exact body/hash parity, league filters/totals, cursor bounds, identity isolation, rate limit and export size bound');
