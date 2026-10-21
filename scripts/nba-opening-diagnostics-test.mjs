import assert from 'node:assert/strict';
import { nbaOpeningValidationDiagnostics, NBA_OPENING_DIAGNOSTICS_VERSION } from '../lib/nba/opening-diagnostics.js';
import { openingVariableAccepted } from '../lib/nba/opening-core.js';
import { openingTraining } from '../lib/nba/opening-training.js';
import { analyzeNbaOpening } from '../lib/nba/opening-model.js';
import { loadNbaAnalysis } from '../lib/nba/analysis-service.js';
import { defaultTraining } from '../lib/nba/analysis-training.js';
import { quarterTraining } from '../lib/nba/quarter-training.js';
import { ESPN_NBA_TEAMS } from '../lib/nba/identity.js';
import { mergeNbaAnalysisResults } from '../lib/nba/analysis-job-display.js';

const metrics = {
  samples: 1230, earlySamples: 140, probabilitySamples: 1230,
  modelMAE: 14, baselineMAE: 15, earlyModelMAE: 13, earlyBaselineMAE: 14,
  modelBrier: .24, baselineBrier: .25, modelLogLoss: .65, baselineLogLoss: .69,
};
const diagnostic = patch => nbaOpeningValidationDiagnostics({ market: 'fullTotal', metrics,
  acceptance: true, validationYear: 2026, ...patch });
assert.equal(diagnostic().status, 'PASS');
assert.equal(diagnostic().version, NBA_OPENING_DIAGNOSTICS_VERSION);
assert.equal(diagnostic().checks.find(row => row.id === 'modelMAE').delta, -1);
assert.equal(diagnostic().checks.find(row => row.id === 'samples').baseline, 1000);
assert.deepEqual(diagnostic().failureCodes, []);
for (const key of ['samples', 'earlySamples', 'modelMAE', 'baselineMAE', 'earlyModelMAE', 'earlyBaselineMAE', 'modelBrier', 'baselineBrier', 'modelLogLoss', 'baselineLogLoss']) {
  for (const bad of [undefined, null, NaN, Infinity, -1, '1']) {
    const changed = { ...metrics, [key]: bad }, result = diagnostic({ metrics: changed });
    assert.equal(result.status, 'FAIL', `${key}=${bad} cannot produce a valid diagnostic`);
    assert.equal(result.accepted, false);
    assert.equal(openingVariableAccepted(changed), false);
    assert.ok(result.failureCodes.length);
  }
}
const incomplete = { ...metrics }; delete incomplete.probabilitySamples;
assert.equal(diagnostic({ metrics: incomplete }).accepted, openingVariableAccepted(incomplete),
  'informational probability coverage must not invent a new production gate');
assert.equal(diagnostic({ metrics: incomplete }).probabilitySamples, null);
for (const patch of [{ league: 'EPL' }, { market: 'fullMargin' }, { market: 'MLB' }, { market: '__proto__' }, { market: 'constructor' }, { validationYear: null }, { acceptance: false }, { acceptance: 'true' }]) {
  assert.equal(diagnostic(patch).status, 'FAIL');
}
const worse = diagnostic({ metrics: { ...metrics, earlyModelMAE: 15 } });
assert.ok(worse.failedChecks.includes('earlyModelMAE'));
assert.equal(worse.checks.find(row => row.id === 'earlyModelMAE').delta, 1);

const date = '2026-10-22', now = Date.parse('2026-10-21T22:00:00Z'), observedAt = new Date(now).toISOString();
const team = id => ({ id: `nba:espn:team:${id}`, sourceId: String(id), abbreviation: ESPN_NBA_TEAMS[id], league: 'NBA' });
const game = { league: 'NBA', id: 'nba:espn:game:401999001', sourceId: '401999001', gamePk: 401999001,
  taipeiDate: date, season: { year: 2027, type: 'regular' }, seasonType: 'regular', home: team(18), away: team(20),
  neutralSite: false, startTime: '2026-10-21T23:00:00Z', status: 'scheduled', completed: false, timeConfirmed: true };
const fullTotal = { line: '235.5', overWater: .94, underWater: .94 };
const quotes = { fullTotal, fullRunline: { line: '3-50', lineSide: 'home', homeWater: .95, awayWater: .95 } };
const output = analyzeNbaOpening(game, quotes);
assert.equal(output.status, 'ready');
assert.equal(output.marketAnalyses.fullRunline.status, 'ready');
assert.equal(output.marketAnalyses.fullTotal.status, 'insufficient');
const totalDiagnostic = output.marketAnalyses.fullTotal.validationDiagnostics;
assert.equal(totalDiagnostic.status, 'FAIL');
assert.equal(totalDiagnostic.samples, openingTraining.validation.holdout.metrics.fullTotal.samples);
assert.equal(totalDiagnostic.probabilitySamples, openingTraining.validation.holdout.metrics.fullTotal.probabilitySamples);
assert.equal(totalDiagnostic.checks.find(check => check.id === 'modelMAE').status, 'PASS');
assert.ok(totalDiagnostic.failedChecks.includes('earlyModelMAE'));
assert.ok(totalDiagnostic.failedChecks.includes('modelBrier'));
assert.ok(totalDiagnostic.failedChecks.includes('modelLogLoss'));
assert.equal(output.marketAnalyses.fullTotal.sides, undefined, 'failed validation cannot manufacture W/R/S');
assert.equal(output.marketAnalyses.firstHalfTotal.validationDiagnostics.variable, 'halfTotal');
assert.equal(output.marketAnalyses.firstHalfTotal.status, 'unavailable', 'missing half quote stays unavailable');
assert.equal(output.marketAnalyses.fullRunline.validationDiagnostics.status, 'PASS');
assert.equal(output.executable, false);
assert.equal(output.promotionEligible, false);

const totalsOnly = analyzeNbaOpening(game, { fullTotal });
assert.equal(totalsOnly.status, 'insufficient');
assert.equal(totalsOnly.issues[0].code, 'NBA_OPENING_NO_VALIDATED_QUOTE');
assert.deepEqual(totalsOnly.marketAnalyses.fullTotal.validationDiagnostics, totalDiagnostic);
assert.deepEqual(totalsOnly.prediction, output.prediction, 'retain raw prediction metadata without releasing market valuations');
assert.deepEqual(totalsOnly.openingAnalysis, output.openingAnalysis);
assert.equal(totalsOnly.assessment, null);
assert.deepEqual(totalsOnly.quotes.fullTotal, fullTotal);
assert.ok(Object.values(totalsOnly.marketAnalyses).every(market => !market.sides));
const invalid = structuredClone(openingTraining);
invalid.acceptance.fullTotal.accepted = true;
invalid.validation.holdout.metrics.fullTotal.modelMAE = NaN;
assert.equal(analyzeNbaOpening(game, { fullTotal }, { trainingData: invalid }).marketAnalyses.fullTotal.validationDiagnostics.status, 'FAIL');
assert.equal(analyzeNbaOpening({ ...game, league: 'EPL' }, quotes).status, 'blocked');

// Run the actual service and result merge with real fixed NBA training, while
// replacing only external I/O. A failed opening validation is not a 0/50 error.
let saves = 0;
const reader = { league: 'NBA', boardDate: date, observedAt, pageActivityAt: observedAt, gameCount: 1,
  games: [{ ...quotes, league: 'NBA', boardDate: date, boardTime: '07:00', captureKey: 'opening-diagnostics-test',
    marketStatus: 'open', away: game.away, home: game.home }] };
const schedule = { league: 'NBA', status: 'ready', qa: { status: 'WARNING' }, sources: [{ status: 'ready' }], data: { games: [game] } };
const options = { now, analyzeOpeningTotals:null, loadSchedule: async () => schedule,
  loadTraining: async () => ({ status: 'ready', trainingData: defaultTraining, halfTraining: quarterTraining }),
  saveCapture: async () => { saves++; return { persisted: true }; } };
const serviceReader = structuredClone(reader); delete serviceReader.games[0].fullRunline;
const query = { date, id: game.sourceId, observedAt };
const service = await loadNbaAnalysis(query, { ...options, loadReader: async () => serviceReader });
assert.equal(service.status, 'insufficient');
assert.equal(service.modelVersion, 'nba-regular-cross-season-v1');
assert.equal(service.scope, 'NBA_regular_cross_season_market_diagnostics');
assert.equal(service.issues[0].code, 'NBA_OPENING_NO_VALIDATED_QUOTE');
assert.deepEqual(service.marketAnalyses.fullTotal.validationDiagnostics, totalDiagnostic);
assert.equal(service.assessment, null);
assert.equal(saves, 0, 'diagnostic-only output must not enter the ready forecast ledger');
const rows = mergeNbaAnalysisResults({ league: 'NBA', date, results: [{ ok: false,
  task: { game, nbaQuery: query }, payload: service }] }, [], date);
assert.equal(rows[0].result.marketAnalyses.fullTotal.validationDiagnostics.market, 'fullTotal');
assert.equal(rows[0].jobState, 'insufficient');

const sourceFailure = await loadNbaAnalysis(query, { ...options, loadReader: async () => serviceReader,
  loadTraining: async () => ({ status: 'blocked', issues: [{ code: 'FIXTURE_HISTORY_CONFLICT', message: 'history conflict' }] }) });
assert.equal(sourceFailure.status, 'blocked');
assert.equal(sourceFailure.issues[0].code, 'FIXTURE_HISTORY_CONFLICT');
assert.equal(sourceFailure.openingAnalysis, undefined, 'a source fault must never be replaced by warmup diagnostics');
const foreign = await loadNbaAnalysis(query, { ...options, loadReader: async () => serviceReader,
  loadSchedule: async () => ({ ...schedule, league: 'EPL' }) });
assert.equal(foreign.status, 'blocked');
assert.equal(foreign.issues[0].code, 'NBA_ANALYSIS_SCHEDULE_UNVERIFIED');
assert.equal(foreign.openingAnalysis, undefined);
const reversed = await loadNbaAnalysis(query, { ...options, loadReader: async () => serviceReader,
  loadSchedule: async () => ({ ...schedule, data: { games: [{ ...game, home: game.away, away: game.home }] } }) });
assert.equal(reversed.status, 'blocked');
assert.equal(reversed.issues[0].code, 'NBA_ANALYSIS_GAME_UNVERIFIED');
assert.equal(reversed.openingAnalysis, undefined, 'wrong team identity cannot fall back to diagnostic model output');

console.log('PASS NBA opening diagnostics: exact gate explanations, missing/invalid metrics, screenshot 235.5 case, totals-only service/merge preservation, no fabricated W/R/S and source/league isolation');
