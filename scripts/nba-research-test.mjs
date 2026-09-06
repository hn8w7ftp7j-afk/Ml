import assert from 'node:assert/strict';
import { analyzeNbaHistory } from '../lib/nba/research.js';

let checks = 0;
function check(name, test) {
  test();
  checks += 1;
  console.log(`PASS ${name}`);
}

function game(id, day, homeScore, awayScore, extra = {}) {
  return {
    id: `nba:espn:game:${id}`, sourceId: String(id), league: 'NBA',
    startTime: `2025-01-${String(day).padStart(2, '0')}T00:00:00Z`,
    taipeiDate: `2025-01-${String(day).padStart(2, '0')}`,
    season: { year: 2025, type: 'regular', label: '2024–25' },
    seasonType: 'regular', status: 'final', completed: true,
    home: { id: 'nba:espn:team:5', score: homeScore },
    away: { id: 'nba:espn:team:6', score: awayScore },
    ...extra,
  };
}

check('known historical arithmetic and explicit warmup', () => {
  const report = analyzeNbaHistory([game(1, 1, 100, 90), game(2, 2, 110, 80), game(3, 3, 120, 100)]);
  assert.equal(report.status, 'ready');
  assert.equal(report.counts.warmupGames, 1);
  assert.equal(report.counts.warmupTeamScores, 2);
  assert.equal(report.validation.scoreSamples, 4);
  assert.equal(report.validation.mae, 12.5);
  assert.equal(report.validation.rmse, Math.sqrt(162.5));
  assert.equal(report.validation.bias, -7.5);
  assert.equal(report.summary.totalScoreMean, 200);
  assert.equal(report.validation.residualIntervals, null);
  assert.equal(report.method.pointInTimeReplay, false);
  assert.equal(report.summary.pace, null);
});

check('null, numeric strings and NaN are never silently treated as scores', () => {
  for (const invalid of [null, undefined, '100', NaN, Infinity, -1, 100.5]) {
    const report = analyzeNbaHistory([game(1, 1, invalid, 90), game(2, 2, 110, 80)]);
    assert.equal(report.summary.games, 1);
    assert.equal(report.validation.scoreSamples, 0);
    assert.equal(report.counts.excluded, 1);
    assert.ok(report.qa.issues.some((issue) => issue.code === 'MISSING_FINAL_SCORE'));
  }
});

check('cross-league, cross-provider, source ID and identical-team conflicts block', () => {
  const mismatches = [
    { league: 'MLB' },
    { sourceId: '99' },
    { id: 'mlb:espn:game:1' },
    { away: { id: 'nba:espn:team:5', score: 90 } },
    { away: { id: 'nba:nba:team:6', score: 90 } },
    { home: { id: '5', score: 100 } },
  ];
  for (const extra of mismatches) {
    const report = analyzeNbaHistory([game(1, 1, 100, 90, extra)]);
    assert.equal(report.qa.status, 'BLOCK');
    assert.equal(report.validation, null);
    assert.equal(report.summary, null);
  }
});

check('conflicting duplicate observations block independent of their array order', () => {
  const first = game(1, 1, 100, 90);
  const conflicting = game(1, 1, 101, 90);
  const result = analyzeNbaHistory([first, conflicting]);
  assert.equal(result.status, 'blocked');
  assert.ok(result.qa.issues.some((issue) => issue.code === 'DUPLICATE_GAME_CONFLICT'));
  assert.deepEqual(result, analyzeNbaHistory([conflicting, first]));
  assert.deepEqual(analyzeNbaHistory([first, first, conflicting]), analyzeNbaHistory([conflicting, first, first]));
  const identityChange = { ...first, away: { id: 'nba:espn:team:7', score: 90 } };
  assert.equal(analyzeNbaHistory([first, identityChange]).status, 'blocked');
});

check('exact duplicate is counted once without mutating cache input', () => {
  const first = Object.freeze(game(1, 1, 100, 90));
  const second = Object.freeze(game(2, 2, 110, 80));
  const source = Object.freeze([second, first, first]);
  const result = analyzeNbaHistory(source);
  assert.equal(result.counts.included, 2);
  assert.equal(result.counts.duplicatesIgnored, 1);
  assert.equal(source[0], second);
});

check('same Taipei day never trains same-day observations or residuals', () => {
  const result = analyzeNbaHistory([
    game(1, 1, 100, 90),
    game(2, 1, 120, 110, { startTime: '2025-01-01T10:00:00Z' }),
    game(3, 2, 110, 100),
  ]);
  assert.equal(result.counts.warmupGames, 2);
  assert.equal(result.validation.scoreSamples, 2);
  assert.equal(result.validation.mae, 0);
});

check('Taipei rollover and absent timezone are rejected', () => {
  for (const extra of [
    { startTime: '2025-01-01T18:00:00Z' },
    { startTime: '2025-01-01T08:00:00' },
    { startTime: 'not-a-time' },
    { startTime: '2025-02-30T00:00:00Z', taipeiDate: '2025-03-02' },
  ]) assert.equal(analyzeNbaHistory([game(1, 1, 100, 90, extra)]).status, 'blocked');
  const rollover = game(1, 1, 100, 90, { startTime: '2025-01-01T18:00:00Z', taipeiDate: '2025-01-02' });
  assert.equal(analyzeNbaHistory([rollover]).summary.firstTaipeiDate, '2025-01-02');
});

check('unsorted provider arrays produce the identical canonical report', () => {
  const observations = [game(1, 1, 100, 90), game(2, 2, 110, 80), game(3, 3, 120, 100)];
  assert.deepEqual(analyzeNbaHistory(observations), analyzeNbaHistory([...observations].reverse()));
});

check('later observed score contributes its own error, never changes earlier errors', () => {
  const past = [game(1, 1, 100, 90), game(2, 2, 110, 80)];
  const prefix = analyzeNbaHistory(past).validation;
  const futureA = analyzeNbaHistory([...past, game(3, 3, 120, 100)]).validation;
  const futureB = analyzeNbaHistory([...past, game(3, 3, 1000, 1000)]).validation;
  const oldAbsoluteSum = prefix.mae * prefix.samples;
  assert.equal(futureA.mae * futureA.samples - (15 + 15), oldAbsoluteSum);
  assert.equal(futureB.mae * futureB.samples - (895 + 915), oldAbsoluteSum);
  const pending = game(4, 4, 9999, 9999, { status: 'scheduled', completed: false });
  assert.deepEqual(analyzeNbaHistory([...past, pending]).validation, prefix);
});

check('preseason, postseason and unknown types do not train regular-season history', () => {
  const special = (id, type) => game(id, 1, 999, 888, { seasonType: type, season: { year: 2025, type } });
  const regular = [game(1, 2, 100, 90), game(2, 3, 110, 80)];
  const mixed = [...regular, special(3, 'preseason'), special(4, 'postseason'), special(5, 'unknown')];
  assert.deepEqual(analyzeNbaHistory(mixed).validation, analyzeNbaHistory(regular).validation);
  assert.equal(analyzeNbaHistory(mixed).counts.included, 2);
  assert.equal(analyzeNbaHistory(mixed, { seasonType: 'preseason' }).summary.games, 1);
  assert.equal(analyzeNbaHistory(mixed, { seasonType: 'postseason' }).summary.games, 1);
  assert.equal(analyzeNbaHistory(mixed, { seasonType: 'unknown' }).status, 'blocked');
});

check('different seasons reset history and cannot share training errors', () => {
  const old = game(1, 1, 900, 800, { season: { year: 2024, type: 'regular' } });
  const newer = [game(2, 2, 100, 90), game(3, 3, 110, 80)];
  const result = analyzeNbaHistory([old, ...newer]);
  assert.equal(result.counts.seasons, 2);
  assert.equal(result.counts.warmupGames, 2);
  assert.deepEqual(result.validation, analyzeNbaHistory(newer).validation);
});

check('identity follows teams across home/away position, not display names', () => {
  const first = game(1, 1, 100, 90);
  const reversed = game(2, 2, 90, 100, {
    home: { id: first.away.id, score: 90, displayName: 'Renamed label' },
    away: { id: first.home.id, score: 100 },
  });
  assert.equal(analyzeNbaHistory([first, reversed]).validation.mae, 0);
});

check('historical interval reports exact empirical sample counts without calibrated claim', () => {
  const observations = Array.from({ length: 14 }, (_, index) => game(index + 1, index + 1, 100, 90));
  const intervals = analyzeNbaHistory(observations).validation.residualIntervals;
  assert.equal(intervals.nominalCoverage, 0.9);
  assert.equal(intervals.evaluatedSamples, 6);
  assert.equal(intervals.coveredSamples, 6);
  assert.equal(intervals.empiricalCoverage, 1);
  assert.equal(intervals.meanWidth, 0);
  assert.equal(intervals.calibrated, false);
  const outlier = analyzeNbaHistory([...observations, game(15, 15, 101, 91)]).validation.residualIntervals;
  assert.equal(outlier.evaluatedSamples, 8);
  assert.equal(outlier.coveredSamples, 6);
  assert.equal(outlier.empiricalCoverage, 0.75);
});

check('empty history has no invented statistics or fake success', () => {
  const report = analyzeNbaHistory([]);
  assert.equal(report.status, 'insufficient_data');
  assert.equal(report.summary, null);
  assert.equal(report.validation, null);
  assert.equal(analyzeNbaHistory(null).status, 'blocked');
});

console.log(`NBA retrospective research: ${checks} checks passed.`);
