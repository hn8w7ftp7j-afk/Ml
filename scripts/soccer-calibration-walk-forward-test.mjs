import assert from 'node:assert/strict';
import { buildSoccerCalibrationWalkForward, SOCCER_CALIBRATION_WALK_FORWARD_FOLDS } from '../lib/soccer/calibration-walk-forward.js';
import { SOCCER_MODEL_VERSION, predictScoreModel, scoreDistribution, soccerScoreLogProbability } from '../lib/soccer/score-model.js';
import { HALF_TIME_MODEL_VERSION, predictHalfTimeDistribution } from '../lib/soccer/half-time-model.js';
import { SOCCER_CALIBRATION_METHOD, SOCCER_CALIBRATION_RESEARCH_VERSION,
  soccerCalibrationHash, fitSoccerCalibrationResearch } from '../lib/soccer/calibration-research.js';
import { compactSoccerCalibrationWalkForwardReport } from './soccer-calibration-walk-forward-build.mjs';

const generatedAt = '2026-11-05T00:00:00.000Z', fold = SOCCER_CALIBRATION_WALK_FORWARD_FOLDS[0];
const hash = value => soccerCalibrationHash(value);
const source = (league, eventId, year, kind) => ({ provider: 'ESPN',
  url: `https://site.api.espn.com/apis/site/v2/sports/soccer/${league === 'epl' ? 'eng.1' : 'uefa.champions'}/${kind}?${kind === 'summary' ? `event=${eventId}` : `dates=${year}&limit=1000`}`,
  fetchedAt: '2026-10-18T22:00:00.000Z', contentHash: hash([league, eventId, year, kind]) });
function row(eventId, date, goals = [2, 2], ht = [1, 1], league = 'epl') {
  const year = date.slice(0, 4);
  return { league, eventId: String(eventId), startTime: `${date}T15:00:00.000Z`, homeId: '301', awayId: '302',
    neutralSite: false, period: 'REGULATION_FT', homeGoals: goals[0], awayGoals: goals[1],
    source: source(league, String(eventId), year, 'scoreboard'), halfTime: ht ? { home: ht[0], away: ht[1], verified: true,
      source: source(league, String(eventId), year, 'summary'), evidence: { fixture: true } } : null };
}
const fixture = [row(1, '2022-06-10'), row(2, '2022-12-31'), row(3, '2023-06-10'), row(4, '2023-08-10', [4, 2], [2, 1]),
  row(5, '2023-12-31'), row(6, '2024-06-10', [1, 0], [0, 0]), row(7, '2024-08-10', [0, 1], null),
  row(8, '2025-06-10', [2, 1], [1, 0]), row(9, '2026-06-10', [3, 2], [1, 1])];
const histories = rows => ({ fullTimeHistory: { rows: rows.map(value => ({ ...value, halfTime: null })),
  excluded: [{ eventId: '90', startTime: '2024-03-01T00:00:00.000Z', reason: 'REGULATION_SCORE_UNVERIFIED' }] },
  halfTimeHistory: { rows: rows.filter(value => value.halfTime),
    excluded: rows.filter(value => !value.halfTime).map(value => ({ league: value.league, eventId: value.eventId, reason: 'HALF_TIME_SOURCE_MISSING' })) } });
const options = rows => ({ league: 'epl', ...histories(structuredClone(rows)), generatedAt, folds: [fold],
  hyperparameters: { fullTime: { halfLifeDays: 730, penalty: .002 }, halfTime: { halfLifeDays: 730 } } });
const fitCalls = [];
const deps = { fitFullTime: (rows, settings) => {
  fitCalls.push({ kind: 'FT', rows: structuredClone(rows), settings });
  assert.ok(rows.every(row => Date.parse(row.startTime) + 86400000 < Date.parse(settings.cutoff)));
  return { version: SOCCER_MODEL_VERSION, league: settings.league, period: 'REGULATION_FT', cutoff: settings.cutoff,
    trainedThrough: rows.at(-1)?.startTime, trainingCount: rows.length, trainingHash: hash(rows), intercept: 0, homeEffect: Math.log(2), rho: -.05,
    coefficients: { 301: { attack: 0, defence: 0 }, 302: { attack: 0, defence: 0 } }, fit: { converged: true } };
}, fitHalfTime: (rows, settings) => {
  fitCalls.push({ kind: 'HT', rows: structuredClone(rows), settings });
  return { version: HALF_TIME_MODEL_VERSION, league: settings.league, period: 'REGULATION_HT', cutoff: settings.cutoff,
    trainedThrough: rows.at(-1)?.startTime, trainingCount: rows.length, trainingHash: hash(rows), shares: { home: .4, away: .4 }, excluded: [], excludedCount: 0 };
} };
const input = options(fixture), snapshot = structuredClone(input), report = buildSoccerCalibrationWalkForward(input, deps);
assert.deepEqual(input, snapshot, 'input/source observations remain immutable');
assert.deepEqual(report, buildSoccerCalibrationWalkForward(input, deps), 'fixed inputs reproduce exactly');
assert.equal(report.accepted, false); assert.equal(report.historicalPitVerified, false); assert.equal(report.untouchedTestVerified, false);
assert.equal(report.W, null); assert.equal(report.R, null); assert.equal(report.S, null);
assert.equal(report.status, 'RESEARCH_ONLY'); assert.deepEqual(report.method, SOCCER_CALIBRATION_METHOD);
const result = report.folds[0];
assert.equal(result.training.acceptedFullTimeGames, 1);
assert.deepEqual(result.training.resultLagBoundaryExcludedGameIds, ['soccer:epl:2']);
assert.equal(result.calibration.populationGames, 3); assert.equal(result.calibration.usedGames, 2);
assert.equal(result.calibration.excludedReasons.WALK_FORWARD_CALIBRATION_LABEL_INSIDE_RESULT_LAG, 1);
assert.deepEqual(result.calibration.parameters.fullTimeRateScales, { home: 1.5, away: 2 });
assert.deepEqual(result.calibration.parameters.halfTimeGoalShares, { home: .5, away: .5 });
assert.equal(result.test.populationGames, 2); assert.equal(result.test.periods.FT.before.games, 2);
assert.equal(result.test.periods.HT.before.games, 1); assert.equal(result.test.periods.HT.paired.games, 1);
assert.equal(result.test.periods.HT.beforeFailures.HALF_TIME_SOURCE_MISSING, 1);
assert.equal(result.sourceExcluded.test.length, 1, 'source-excluded normal-regulation population remains visible');
assert.ok(report.limitations.some(value => value.includes('2024') && value.includes('2025')));
assert.equal(report.coverage.originalSourceDocumentHashesRecomputed, false);
assert.equal(report.coverage.acceptedFullTimeGames, fixture.length);

// Numerical equivalence to the existing method, on precisely the same cohort.
const model = deps.fitFullTime(fixture.slice(0, 1).map(value => ({ ...value, halfTime: undefined })), { league: 'epl', cutoff: fold.baseBefore });
const halfTimeModel = deps.fitHalfTime(fixture.slice(0, 1), { league: 'epl', cutoff: fold.baseBefore });
const calRows = fixture.filter(value => ['3', '4'].includes(value.eventId));
const datasetBody = { type: 'SOURCE_RECOMPUTED_CALIBRATION_ROWS', version: SOCCER_CALIBRATION_RESEARCH_VERSION,
  league: 'epl', from: '2023-01-01', through: '2023-12-31', checkedAt: '2026-10-19T00:00:00.000Z', rows: calRows, excluded: [] };
const existing = fitSoccerCalibrationResearch({ dataset: { ...datasetBody, contentHash: hash(datasetBody) }, model, halfTimeModel,
  modelCreatedAt: '2023-01-01T00:00:00.000Z', halfTimeModelCreatedAt: '2023-01-01T00:00:00.000Z', createdAt: generatedAt });
assert.deepEqual(existing.parameters, result.calibration.parameters);
const first = result.test.ledger[0], original = predictScoreModel(model, fixture[5]);
const calibrated = scoreDistribution(original.homeRate * 1.5, original.awayRate * 2, original.rho, original.tolerance);
assert.deepEqual(first.after.FT.distribution.outcomes, calibrated.outcomes);
assert.equal(first.after.FT.metrics.scoreLogLoss, -soccerScoreLogProbability(1, 0, calibrated.homeRate, calibrated.awayRate, calibrated.rho));
assert.deepEqual(first.after.HT.distribution.outcomes, predictHalfTimeDistribution(calibrated, { ...halfTimeModel, shares: { home: .5, away: .5 } }, fixture[5]).outcomes);
assert.ok(first.after.FT.distribution.tailMass <= 1.1e-12);
for (const period of ['FT', 'HT']) for (const key of ['scoreLogLoss', 'logLoss', 'brier']) {
  const paired = result.test.periods[period].paired;
  assert.ok(Math.abs(paired.differenceAfterMinusBefore[key] - (paired.after[key] - paired.before[key])) < 1e-12);
}

const changedTest = structuredClone(fixture); changedTest[5].homeGoals = 9; changedTest[5].halfTime.home = 3;
const changedReport = buildSoccerCalibrationWalkForward(options(changedTest), deps);
assert.deepEqual(changedReport.folds[0].training, result.training, 'test outcomes cannot change fitted baseline');
assert.deepEqual(changedReport.folds[0].calibration, result.calibration, 'test outcomes cannot change calibration parameters');
assert.notEqual(changedReport.folds[0].test.periods.FT.before.scoreLogLoss, result.test.periods.FT.before.scoreLogLoss);
const repeated = options([...fixture, structuredClone(fixture[5])]);
assert.equal(buildSoccerCalibrationWalkForward(repeated, deps).folds[0].test.periods.FT.before.games, 2, 'duplicate source row is never another game weight');
const conflict = options([...fixture, { ...fixture[5], homeGoals: 9 }]);
assert.throws(() => buildSoccerCalibrationWalkForward(conflict, deps), /REVISION_CONFLICT/);
const identityConflict = options(fixture); identityConflict.halfTimeHistory.rows[0].awayId = '303';
assert.throws(() => buildSoccerCalibrationWalkForward(identityConflict, deps), /GAME_OR_FT_CONFLICT/);
const foreign = options(fixture); foreign.fullTimeHistory.rows[0].league = 'ucl';
assert.throws(() => buildSoccerCalibrationWalkForward(foreign, deps), /FULL_TIME_ROW_INVALID/);
const poisonedSource = options(fixture); poisonedSource.fullTimeHistory.rows[0].source.url = 'https://example.com/scoreboard';
assert.throws(() => buildSoccerCalibrationWalkForward(poisonedSource, deps), /FULL_TIME_ROW_INVALID/);
const futureSource = options(fixture); futureSource.fullTimeHistory.rows[0].source.fetchedAt = '2027-01-01T00:00:00.000Z';
assert.throws(() => buildSoccerCalibrationWalkForward(futureSource, deps), /FULL_TIME_ROW_INVALID/);
const wrongHTSource = options(fixture); wrongHTSource.halfTimeHistory.rows[0].halfTime.source.url = wrongHTSource.halfTimeHistory.rows[1].halfTime.source.url;
assert.throws(() => buildSoccerCalibrationWalkForward(wrongHTSource, deps), /HALF_TIME_ROW_INVALID/);
const halfTimeConflict = options(fixture); halfTimeConflict.halfTimeHistory.rows.push({ ...halfTimeConflict.halfTimeHistory.rows[0], halfTime: { ...halfTimeConflict.halfTimeHistory.rows[0].halfTime, home: 0 } });
assert.throws(() => buildSoccerCalibrationWalkForward(halfTimeConflict, deps), /HALF_TIME_REVISION_CONFLICT/);
const unseen = structuredClone(fixture); unseen[5].homeId = '999';
const unseenReport = buildSoccerCalibrationWalkForward(options(unseen), deps);
assert.equal(unseenReport.folds[0].test.populationGames, 2);
assert.equal(unseenReport.folds[0].test.periods.FT.beforeFailures.SOCCER_TEAM_NOT_TRAINED, 1);
const uclRows = fixture.map(value => row(value.eventId, value.startTime.slice(0, 10), [value.homeGoals, value.awayGoals],
  value.halfTime ? [value.halfTime.home, value.halfTime.away] : null, 'ucl'));
const ucl = buildSoccerCalibrationWalkForward({ ...options(uclRows), league: 'ucl' }, deps);
assert.equal(ucl.league, 'ucl');
assert.ok(ucl.folds[0].test.ledger.every(value => value.gameId.startsWith('soccer:ucl:')));
assert.notEqual(ucl.folds[0].training.fullTime.trainingHash, result.training.fullTime.trainingHash);
assert.throws(() => buildSoccerCalibrationWalkForward({ ...input, folds: [fold, { ...fold, id: 'overlapping-test' }] }, deps), /SPLIT_INVALID/);
assert.throws(() => buildSoccerCalibrationWalkForward({ ...input, folds: [{ ...fold, calibrationBefore: fold.baseBefore }] }, deps), /SPLIT_INVALID/);
assert.throws(() => buildSoccerCalibrationWalkForward({ ...input, generatedAt: '2024-01-01T00:00:00Z' }, deps), /SPLIT_INVALID/);

const failed = buildSoccerCalibrationWalkForward(input, { ...deps, fitFullTime: () => { throw Error('SOCCER_TRAINING_INSUFFICIENT'); } });
assert.equal(failed.folds[0].test.populationGames, 2); assert.equal(failed.folds[0].test.periods.FT.before.games, 0);
assert.equal(failed.folds[0].test.periods.FT.beforeFailures.WALK_FORWARD_BASE_MODEL_UNAVAILABLE, 2);
assert.equal(failed.folds[0].fitFailures[0].reason, 'SOCCER_TRAINING_INSUFFICIENT');
const missingHTModel = buildSoccerCalibrationWalkForward(input, { ...deps, fitHalfTime: () => { throw Error('HALF_TIME_NO_EXPOSURE'); } });
assert.equal(missingHTModel.folds[0].test.periods.FT.before.games, 2, 'FT reference remains visible when HT fit fails');
assert.equal(missingHTModel.folds[0].test.periods.FT.after.games, 0, 'absent complete calibration fit does not produce calibrated values');

// A calibrated invalid DC distribution fails, rather than clipping scales/rho.
const excessive = structuredClone(fixture);
for (const value of excessive) if (['3', '4'].includes(value.eventId)) { value.homeGoals = 20; value.awayGoals = 10; value.halfTime.home = 10; value.halfTime.away = 5; }
const invalid = buildSoccerCalibrationWalkForward(options(excessive), { ...deps, fitFullTime: (rows, settings) => ({ ...deps.fitFullTime(rows, settings), rho: .15 }) });
assert.equal(invalid.folds[0].test.periods.FT.before.games, 2); assert.equal(invalid.folds[0].test.periods.FT.after.games, 0);
assert.equal(invalid.folds[0].test.periods.FT.afterFailures.SOCCER_DEPENDENCE_INVALID, 2);
assert.equal(invalid.folds[0].test.periods.FT.missingAnyArmGames, 2);

// Boundary HT share is supported with explicit infinite loss, never an epsilon.
const zeroHT = structuredClone(fixture);
for (const value of zeroHT) if (['3', '4'].includes(value.eventId)) value.halfTime = { ...value.halfTime, home: 0, away: 0 };
zeroHT[5].halfTime = { ...zeroHT[5].halfTime, home: 1 };
const boundary = buildSoccerCalibrationWalkForward(options(zeroHT), deps);
assert.equal(boundary.folds[0].test.periods.HT.after.scoreLogLoss, null);
assert.equal(boundary.folds[0].test.periods.HT.after.scoreLogLossState, 'POSITIVE_INFINITY');
assert.equal(boundary.folds[0].test.periods.HT.paired.differenceAfterMinusBefore.scoreLogLossState, 'POSITIVE_INFINITY');
assert.equal(boundary.folds[0].test.ledger[0].after.HT.metricStates.scoreLogLoss, 'POSITIVE_INFINITY');
assert.deepEqual(boundary, JSON.parse(JSON.stringify(boundary)), 'no silent JSON Infinity/NaN conversion');
const { contentHash, ...body } = report;
assert.equal(contentHash, hash(body));
assert.notEqual(contentHash, hash({ ...body, accepted: true }), 'mutating a sealed report changes its hash');
const compact = compactSoccerCalibrationWalkForwardReport({ ...report, leagues: { epl: report } });
assert.equal(compact.fullReportContentHash, report.contentHash);
assert.equal(compact.leagues.epl.folds[0].test.periods.HT.paired.games, result.test.periods.HT.paired.games);
assert.equal(compact.leagues.epl.folds[0].test.ledgerHash, hash(result.test.ledger));
assert.equal(compact.leagues.epl.folds[0].test.ledger, undefined);
assert.equal(compact.leagues.epl.folds[0].training.gameIdsHash, hash(result.training.gameIds));
assert.equal(compact.accepted, false);
console.log('SOCCER_CALIBRATION_WALK_FORWARD_TEST_PASS');
