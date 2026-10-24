import assert from 'node:assert/strict';
import { buildNbaPersonnelComparison, validNbaPersonnelComparison, summarizeNbaPersonnelComparisons } from '../lib/nba/personnel-comparison.js';

const gameId = 'nba:espn:game:401900001';
const game = { id: gameId, sourceId: '401900001', startTime: '2026-10-24T07:00:00Z',
  home: { id: 'nba:espn:team:5' }, away: { id: 'nba:espn:team:18' } };
const teams = [game.home.id, game.away.id];
const observedAt = '2026-10-24T06:00:00Z';
const evidence = {
  league: 'NBA', gameId, startTime: game.startTime, capturedAt: observedAt, status: 'ready',
  sources: [{ provider: 'ESPN', url: `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${game.sourceId}`,
    hash: 'b'.repeat(64), status: 'ready', fetchedAt: observedAt, publishedAt: null },
    { provider: 'ESPN', url: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries',
      hash: 'd'.repeat(64), status: 'ready', fetchedAt: observedAt, publishedAt: null }],
  lineups: teams.map((teamId, teamIndex) => ({ teamId, status: 'provider_reported',
    players: Array.from({ length: 5 }, (_, i) => ({ playerId: `nba:espn:player:${100 + teamIndex * 5 + i}`, teamId, confirmedMinutes: null })) })),
  injuries: [{ gameId, teamId: teams[0], status: 'provider_reported', officialReportVerified: false }],
  coverage: { injuries: 'provider_latest_reports_not_official', rotation: 'unknown', minutes: 'unknown' },
  persistence: { persisted: true, revision: 'c'.repeat(64), capturedAt: observedAt },
  modelInputEnabled: false,
};
const input = () => ({ league: 'NBA', status: 'ready', gameId, game, date: '2026-10-24',
  modelVersion: 'synthetic-baseline-v1', quoteHash: 'a'.repeat(64), generatedAt: '2026-10-24T06:01:00Z',
  source: { quoteObservedAt: observedAt }, prediction: { home: 110, away: 108, total: 218 },
  quotes: { fullTotal: { line: '220平', overWater: .94, underWater: .94 } },
  marketAnalyses: { fullTotal: { status: 'ready', sides: { over: { expectedNet: .05, robustExpectedNet: .01 }, under: { expectedNet: -.06, robustExpectedNet: -.08 } } } },
  personnelEvidence: structuredClone(evidence),
});
const baseline = input(), before = structuredClone(baseline);
const comparison = buildNbaPersonnelComparison(baseline);
assert.deepEqual(baseline, before, 'input audit cannot mutate baseline predictions, quotes or W/R');
assert.equal(comparison.input.injuryReportsObserved, true);
assert.equal(comparison.input.reportedLineupsObserved, true);
assert.equal(comparison.pairedPredictionAvailable, false);
assert.equal(comparison.adjustedPrediction, null);
assert.equal(comparison.pairedMetrics, null);
assert.equal(comparison.promotionEligible, false);
assert.ok(comparison.missingInputs.includes('MINUTE_PROJECTION_MODEL_NOT_VALIDATED'));
assert.ok(!comparison.missingInputs.includes('CONFIRMED_FUTURE_MINUTES_MISSING'), 'future minutes are forecasts, not pregame facts');
assert.deepEqual(buildNbaPersonnelComparison({ ...baseline, generatedAt: '2026-10-24T06:02:00Z' }), comparison,
  'processing timestamps must not rewrite the fixed input manifest');
assert.deepEqual(buildNbaPersonnelComparison({ ...baseline, personnelEvidence: { ...baseline.personnelEvidence, sources: [...baseline.personnelEvidence.sources].reverse() } }).input.sourcePins,
  comparison.input.sourcePins, 'source pins have deterministic ordering; raw observation hash preserves the original evidence');

const captured = { ...baseline, personnelComparison: comparison };
assert.equal(validNbaPersonnelComparison(captured), true);
for (const mutate of [
  a => a.prediction.total++, a => a.quotes.fullTotal.line = '221平',
  a => a.modelVersion = 'different-v2', a => a.quoteHash = 'd'.repeat(64),
  a => a.personnelEvidence.injuries[0].status = 'unknown',
  a => a.personnelComparison.pairedPredictionAvailable = true,
  a => a.personnelComparison.adjustedPrediction = { total: a.prediction.total },
  a => a.personnelComparison.pairedMetrics = { improvement: 0 },
]) { const changed = structuredClone(captured); mutate(changed); assert.equal(validNbaPersonnelComparison(changed), false); }

for (const mutate of [
  e => e.gameId = 'nba:espn:game:999', e => e.startTime = '2026-10-24T08:00:00Z',
  e => e.capturedAt = game.startTime, e => e.sources[0].fetchedAt = '2026-10-24T05:54:59Z',
  e => e.sources[0].publishedAt = 'invalid', e => e.sources[0].publishedAt = '2026-10-24T06:01:00Z',
  e => e.sources[0].url = 'https://example.com/summary', e => e.sources[0].hash = null,
  e => e.sources[0].url = e.sources[0].url.replace('401900001', '401900002'),
  e => e.sources[0].url += '&event=401900002',
]) { const a = input(); mutate(a.personnelEvidence); const result = buildNbaPersonnelComparison(a);
  assert.equal(result.input.sourceEvidenceObserved, false); assert.equal(result.input.injuryReportsObserved, false); }
const empty = input(); empty.personnelEvidence.injuries = []; empty.personnelEvidence.coverage.injuries = 'no_matching_report_not_confirmed_health';
assert.equal(buildNbaPersonnelComparison(empty).input.injuryReportsObserved, false, 'no injury report cannot mean healthy');
const noInjurySource = input(); noInjurySource.personnelEvidence.sources.pop();
assert.equal(buildNbaPersonnelComparison(noInjurySource).input.injuryReportsObserved, false);
assert.equal(buildNbaPersonnelComparison(noInjurySource).input.reportedLineupsObserved, true);
const failedInjurySource = input(); failedInjurySource.personnelEvidence.sources[1].status = 'unavailable';
failedInjurySource.personnelEvidence.sources[1].hash = null;
assert.equal(buildNbaPersonnelComparison(failedInjurySource).input.injuryReportsObserved, false);
assert.equal(buildNbaPersonnelComparison(failedInjurySource).input.reportedLineupsObserved, true, 'failed injuries source cannot erase verified summary lineups');
for (const mutate of [
  e => e.lineups[0].players[1] = e.lineups[0].players[0],
  e => e.lineups[0].players[0].teamId = teams[1],
  e => e.lineups[0].players[0].playerId = 'unverified-player',
]) { const a = input(); mutate(a.personnelEvidence); assert.equal(buildNbaPersonnelComparison(a).input.reportedLineupsObserved, false); }
const missing = buildNbaPersonnelComparison({ ...baseline, personnelEvidence: null });
assert.equal(missing.input.snapshotRevision, null); assert.equal(missing.adjustedPrediction, null);
assert.equal(missing.status, 'NOT_RUN_INPUTS_AND_MODEL_MISSING');

const unit = { payload: captured, marketKey: 'fullTotal' };
const legacy = { payload: input(), marketKey: 'fullRunline' };
const summary = summarizeNbaPersonnelComparisons([unit, unit, legacy]);
assert.equal(summary.distinctGames, 1); assert.equal(summary.canonicalMarkets, 2);
assert.equal(summary.trackedMarkets, 1); assert.equal(summary.legacyMarkets, 1);
assert.equal(summary.pairedMarkets, 0); assert.equal(summary.notRunMarkets, 1);
const invalid = structuredClone(unit); invalid.payload.personnelComparison.adjustedPrediction = invalid.payload.prediction;
assert.equal(summarizeNbaPersonnelComparisons([invalid]).invalidMarkets, 1);
assert.equal(summarizeNbaPersonnelComparisons([invalid]).pairedMarkets, 0);
const bounded = summarizeNbaPersonnelComparisons([unit], { truncated: true });
assert.equal(bounded.canonicalMarkets, null); assert.equal(bounded.pairedMarkets, null);
console.log('NBA personnel comparison: frozen input/output pins, unchanged baseline, PIT/missing-source checks, no fabricated adjusted prediction, canonical counts and truncated inventory PASS');
