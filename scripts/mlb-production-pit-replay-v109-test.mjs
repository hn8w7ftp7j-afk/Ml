import assert from 'node:assert/strict';
import { replayProductionPitSnapshotV109, validateProductionPitSnapshotV109 } from '../lib/mlb-production-pit-replay-v109.js';
import { MODEL_VERSION } from '../lib/analysis-v11.js';
import { DATA_VERSION } from '../lib/snapshot-v9.js';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const snapshotAsOf = '2026-08-23T18:00:00.000Z';
const team = {
  hitting: { games: 100, gamesPlayed: 100, runsPerGame: 4.5, ops: 0.73, status: 'CONFIRMED' },
  recentHitting: { games: 12, gamesPlayed: 12, runsPerGame: 4.4, status: 'CONFIRMED' },
  pitching: { inningsPitched: 900, era: 4.2, whip: 1.28, kPer9: 8.7, bbPer9: 3.1, hrPer9: 1.1, status: 'CONFIRMED' },
  recentPitching: { inningsPitched: 90, era: 4.1, whip: 1.27, kPer9: 8.8, bbPer9: 3.0, hrPer9: 1.0, status: 'CONFIRMED' },
  starter: { inningsPitched: 120, gamesStarted: 22, expectedInnings: 5.45, era: 3.8, whip: 1.2, kPer9: 9, bbPer9: 2.8, hrPer9: 1, status: 'CONFIRMED', throws: 'R', throwsStatus: 'CONFIRMED' },
  bullpen: { pureRelief: true, qualityFactor: 1, status: 'CONFIRMED' },
  lineup: { official: true, offensiveIndex: 1, players: [] },
  scoring: { games: 100, varianceRuns: 7 },
  advanced: {},
};
const context = {
  modelVersion: MODEL_VERSION,
  leagueId: 'MLB', analysisMode: 'EXPERIMENTAL_SHADOW', betEligible: false, executable: false,
  fetchedAt: snapshotAsOf,
  game: { leagueId: 'MLB', gamePk: 777001, gameDate: '2026-08-23T23:00:00.000Z', away: '洋基', home: '紅襪', scheduledInnings: 9 },
  league: { runsPerTeamGame: 4.4, ops: 0.72, era: 4.25, whip: 1.30, kPer9: 8.6, bbPer9: 3.2, hrPer9: 1.15 },
  away: structuredClone(team), home: structuredClone(team),
  park: { runFactor: 1, factorStatus: 'CONFIRMED' }, weather: { meanRunFactor: 1, status: 'CONFIRMED', roofConfirmed: true },
  sourceStatuses: { lineups: 'CONFIRMED' }, dataGateV10: { passedForShadowScore: true, modelErrorMarginEV: 0.008 },
  featureProvenance: [{ featureName: 'core', observedAt: snapshotAsOf, sourceProvider: 'ISOLATED_TEST_FIXTURE' }],
};
const input = {
  dataVersion: DATA_VERSION,
  snapshotAsOf,
  context,
  markets: [
    { market: '全場大小', pick: '大8平', water: 0.95, lineAsOf: snapshotAsOf, sourceType: 'ACTUAL_TW_CREDIT', provider: 'TAI888_READER_AUTO', executable: true },
    { market: '全場大小', pick: '小8平', water: 0.95, lineAsOf: snapshotAsOf, sourceType: 'ACTUAL_TW_CREDIT', provider: 'TAI888_READER_AUTO', executable: true },
  ],
  actual: { awayRuns: 5, homeRuns: 4 },
};
assert.equal(validateProductionPitSnapshotV109(input).ok, true);
const inputBeforeReplay = JSON.stringify(input);
const result = replayProductionPitSnapshotV109(input);
assert.equal(JSON.stringify(input), inputBeforeReplay, 'successful replay preserves all original frozen inputs');
assert.equal(result.ok, true);
assert.equal(result.results.length, 2);
assert.ok(result.results.every(row => Number.isFinite(row.rawWeightedEv)));
assert.ok(result.results.every(row => Number.isFinite(row.realizedNetReturn)));
assert.equal(result.modelVersion, MODEL_VERSION);
assert.equal(result.dataVersion, DATA_VERSION);

for (const value of [null, undefined, '', '  ', false, true, [], {}, NaN, Infinity]) {
  const missingWater = structuredClone(input);
  missingWater.markets[0].water = value;
  assert.ok(validateProductionPitSnapshotV109(missingWater).errors.includes('MARKET_INCOMPLETE'),
    'missing/coerced numerics cannot become a real zero-valued market');
}
for (const actual of [
  { awayRuns: null, homeRuns: 4 },
  { awayRuns: '', homeRuns: 4 },
  { awayRuns: false, homeRuns: 4 },
  { awayRuns: 0.5, homeRuns: 4 },
]) {
  const missingScores = replayProductionPitSnapshotV109({ ...input, actual });
  assert.equal(missingScores.ok, true);
  assert.ok(missingScores.results.every(row => row.realizedNetReturn === null),
    'missing or invalid actual scores must remain unscored rather than fabricate realized return');
}
const realZeroScores = replayProductionPitSnapshotV109({ ...input, actual: { awayRuns: 0, homeRuns: 0 } });
assert.ok(realZeroScores.results.every(row => Number.isFinite(row.realizedNetReturn)), 'real zero runs are valid observations');
const unsetSettings = replayProductionPitSnapshotV109({ ...input, settings: { rebateRate: null, candidateThreshold: '', strongestThreshold: undefined } });
assert.deepEqual(unsetSettings.results, result.results, 'absent settings retain the existing declared defaults instead of becoming zero');

for (const change of [
  value => { delete value.context.modelVersion; },
  value => { value.context.modelVersion = 'ARCHIVED_MODEL_NOT_INSTALLED'; },
  value => { value.modelVersion = 'CONFLICTING_OLD_MODEL'; },
  value => { delete value.dataVersion; },
  value => { value.dataVersion = 'ARCHIVED_DATA_SCHEMA'; },
  value => { value.context.rulesVersion = 'OTHER_RULES_VERSION'; },
  value => { value.context.modelConfig = { engine: 'ARCHIVED_ENGINE_NOT_INSTALLED' }; },
]) {
  const legacy = structuredClone(input);
  change(legacy);
  legacy.distributionSnapshot = { claimed: 'unverified old PMF is not an archived replay engine' };
  const original = JSON.stringify(legacy);
  const rejected = replayProductionPitSnapshotV109(legacy);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.status, 'PIT_SNAPSHOT_UNRECONSTRUCTABLE');
  assert.equal(rejected.compatibility.archivedEngineAvailable, false);
  assert.equal(rejected.results, undefined, 'old context must never be recomputed by the current engine and labelled exact');
  assert.equal(JSON.stringify(legacy), original, 'replay never rewrites original snapshot versions, context or results');
}

for (const [name, change, expected] of [
  ['missing provenance', value => { delete value.context.featureProvenance; }, 'FEATURE_PROVENANCE_MISSING'],
  ['empty provenance', value => { value.context.featureProvenance = []; }, 'FEATURE_PROVENANCE_MISSING'],
  ['date range is not observation time', value => { value.context.featureProvenance[0] = { featureName: 'core', asOf: '2026-08-22', sourceProvider: 'ISOLATED_TEST_FIXTURE' }; }, 'FEATURE_TIME_MISSING:core'],
  ['late source fetch despite earlier range', value => { value.context.featureProvenance[0].fetchedAt = '2026-08-23T19:00:00.000Z'; }, 'FEATURE_FROM_FUTURE:core'],
  ['unidentified source', value => { delete value.context.featureProvenance[0].sourceProvider; }, 'FEATURE_SOURCE_MISSING:core'],
  ['explicit ineligible historical source', value => { value.context.featureProvenance[0].historicalReplayEligible = false; }, 'FEATURE_NOT_HISTORICAL_REPLAY_ELIGIBLE:core'],
  ['later context', value => { value.context.fetchedAt = '2026-08-23T19:00:00.000Z'; }, 'CONTEXT_FROM_FUTURE'],
  ['later market', value => { value.markets[0].lineAsOf = '2026-08-23T19:00:00.000Z'; }, 'LINE_FROM_FUTURE'],
]) {
  const value = structuredClone(input);
  change(value);
  const original = JSON.stringify(value);
  const rejected = replayProductionPitSnapshotV109(value);
  assert.equal(rejected.status, 'PIT_SNAPSHOT_REJECTED', name);
  assert.ok(rejected.errors.includes(expected), name);
  assert.equal(JSON.stringify(value), original, name);
}
const leaked = structuredClone(input);
leaked.context.featureProvenance[0].observedAt = '2026-08-24T00:00:00.000Z';
assert.match(validateProductionPitSnapshotV109(leaked).errors.join('|'), /FEATURE_FROM_FUTURE/);
const contemporaneous = structuredClone(input);
contemporaneous.context.featureProvenance[0].qualityFlags = ['CURRENT_SNAPSHOT_NOT_HISTORICAL_ARCHIVE'];
assert.equal(validateProductionPitSnapshotV109(contemporaneous).ok, true,
  'a provider lacking a historical endpoint does not invalidate a contemporaneous stored receipt on its own');
assert.equal(result.compatibility.archiveVerification, 'SOURCE_TIMES_ONLY_ORIGINAL_ARCHIVE_NOT_INDEPENDENTLY_VERIFIED');

const temp = await mkdtemp(join(tmpdir(), 'pit-replay-preserve-'));
try {
  const sourcePath = join(temp, 'original.ndjson');
  const aliasPath = join(temp, 'original-alias.ndjson');
  const separatePath = join(temp, 'new-replay.ndjson');
  const original = `${JSON.stringify({ context: { game: { gamePk: 1 } } })}\n`;
  await writeFile(sourcePath, original);
  await symlink(sourcePath, aliasPath);
  for (const destination of [sourcePath, aliasPath]) {
    const run = spawnSync(process.execPath, ['scripts/mlb-production-pit-replay-v109.mjs', sourcePath, destination], { encoding: 'utf8' });
    assert.notEqual(run.status, 0, 'same-file or alias output must be refused');
    assert.equal(await readFile(sourcePath, 'utf8'), original, 'the CLI must never truncate original snapshots');
  }
  const run = spawnSync(process.execPath, ['scripts/mlb-production-pit-replay-v109.mjs', sourcePath, separatePath], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(await readFile(separatePath, 'utf8')).status, 'PIT_SNAPSHOT_UNRECONSTRUCTABLE');
  assert.equal(await readFile(sourcePath, 'utf8'), original);
} finally {
  await rm(temp, { recursive: true, force: true });
}

console.log('Version-verified MLB PIT replay: missing-score rejection, provenance/cutoff checks, legacy-version rejection and immutable CLI source preservation PASS');
