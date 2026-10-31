import assert from 'node:assert/strict';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';
import { fixtureCapture, resultFor } from './helpers/soccer-forward-fixture.mjs';
import { soccerDate } from '../lib/soccer/contracts.js';
import { buildSoccerMarketDirections } from '../lib/soccer/market-directions.js';
import { evaluateSoccerQuote } from '../lib/soccer/market-payoff.js';
import { soccerForwardAnalysisRevision, soccerForwardHash } from '../lib/soccer/forward-validation.js';

// Engineering fixtures in the shipped PostgreSQL stores and durable scanner.
// No fixture contract, approved artifact or actual account settlement is added.
const fixture = await soccerSqlFixture(), { db } = fixture;
const savedEnv = Object.fromEntries(['DATABASE_URL', 'DATABASE_V2_URL'].map(key => [key, process.env[key]]));
process.env.DATABASE_URL = 'postgres://fixture.invalid/retrospective-payoff-scan';
delete process.env.DATABASE_V2_URL;
const iso = value => new Date(value).toISOString();
const close = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-11,
  `${label}: ${actual} != ${expected}`);
const sumRealized = report => report.groups.reduce((sum, row) => sum + row.hypotheticalRealizedNetReturnSum, 0);
function noPromotion(value) {
  for (const row of [value, ...(value.groups || [])]) {
    for (const key of ['accountSettlementVerified', 'historicalContractVerified', 'verifiedAtOriginalCutoff',
      'formalEligible', 'calibrationEligible', 'promotionEligible', 'executable']) assert.equal(row[key], false, key);
    for (const key of ['W', 'R', 'S', 'empiricalErrorMargin']) assert.equal(row[key], null, key);
  }
}
try {
  const service = await import('../lib/soccer/forward-validation-service.js');
  const { continueSoccerForwardScan } = await import('../lib/soccer/forward-validation-scan.js');
  await service.ensureSoccerForwardProtocol();
  const query = async (sql, params = []) => (await db.query(sql, params)).rows;
  const base = Date.now(), kickoff = base + 3600000, after = base + 3 * 3600000;
  // Only this isolated fixture's database receipt clock is controlled. The
  // immutable-history triggers and the shipped archive/readback remain active.
  await query(`ALTER TABLE sports_soccer_forward_result_checks_v1 ALTER COLUMN checked_at
    SET DEFAULT '${iso(after + 1000)}'::timestamptz`);
  const byGame = new Map();
  async function save(id, priced) {
    const snapshot = fixtureCapture({ id, league: 'epl', modelSeed: 'shared-retrospective-fixture-model' }).snapshot;
    snapshot.runStartedAt = snapshot.observedAt = snapshot.analysisCutoff = iso(base);
    snapshot.date = snapshot.evidence.game.date = soccerDate(kickoff);
    snapshot.evidence.game.startTime = iso(kickoff);
    for (const source of [snapshot.evidence.source, snapshot.evidence.game.source, snapshot.evidence.scheduleSource]) source.fetchedAt = iso(base);
    snapshot.inputVersions.evidenceFetchedAt = iso(base);
    snapshot.inputVersions.scheduleSourceVersion = { ...snapshot.evidence.scheduleSource };
    snapshot.directions = priced ? buildSoccerMarketDirections({ game: snapshot.evidence.game, now: base,
      reader: { revision: soccerForwardHash(['reader', id]), observationId: soccerForwardHash(['observation', id]),
        observedAt: iso(base), firstFetchedAt: iso(base), receivedAt: iso(base), persistedAt: iso(base),
        sourceHost: 'www.tai888.in', pageUrl: 'https://www.tai888.in/newapp/' },
      matchedGames: [{ officialGameId: snapshot.gameId, league: 'EPL', boardDate: snapshot.date,
        matchStatus: 'MATCHED', prestart: true, markets: [{ period: 'FT', kind: 'TOTAL', unit: 'GOALS',
          line: '2.5', overWater: .95, underWater: .9, rawRows: ['大2.5 .95', '小 .9'],
          periodEvidence: { period: 'FT', status: 'EXPLICIT', sectionTitle: '英格蘭超級聯賽',
            tableHeaders: ['全場'], marketHeader: '全場大小' } }] }] }) : [];
    const revision = soccerForwardAnalysisRevision(snapshot);
    await query(`INSERT INTO sports_soccer_analysis_v1(league,game_id,analysis_hash,observed_at,payload)
      VALUES('epl',$1,$2,$3::timestamptz,$4::jsonb)`, [snapshot.gameId, revision, snapshot.observedAt, JSON.stringify(snapshot)]);
    const receipt = await service.captureSoccerForwardSnapshot(snapshot, revision);
    const ft = { ...receipt.captures.find(row => row.period === 'REGULATION_FT' && row.variant === 'BASELINE'),
      league: 'epl', gameId: snapshot.gameId, date: snapshot.date, revision, snapshot };
    const result = resultFor(ft);
    result.observedAt = iso(after); result.sources.forEach(source => { source.fetchedAt = iso(after); });
    result.resultHash = soccerForwardHash(['retrospective-fixture-result', snapshot.gameId]);
    byGame.set(snapshot.gameId, { snapshot, result });
    return snapshot;
  }
  const priced = [await save('100', true), await save('200', true)];
  await save('300', false);
  const scope = { league: 'epl', date: priced[0].date };
  const options = { query, purpose: 'evaluate', now: () => after + 1000, timeBudgetMs: 25000,
    gameLimit: 1, fetchResult: async context => structuredClone(byGame.get(context.gameId).result) };

  // Compute the reference with the actual existing payoff engine, without
  // supplying a registered contract to the scanner's formal return path.
  let expectedRealized = 0, expectedLower = 0, expectedUpper = 0;
  for (const snapshot of priced) for (const quote of snapshot.directions.flatMap(direction => direction.quotes)) {
    const raw = { period: quote.period, kind: quote.kind, direction: quote.side.toUpperCase(),
      sourceLine: quote.line, lineSide: quote.lineSide ?? null, water: quote.water, waterFormat: 'PROFIT_PER_UNIT' };
    const contract = { type: 'CREDIT_BOUNDARY', period: quote.period,
      labelMapping: { home: '主隊', away: '客隊' }, rebate: { rate: .01, basis: 'SETTLED_PRINCIPAL' },
      provenance: { status: 'ASSUMPTION', note: 'Explicit retrospective engineering fixture' } };
    const actual = evaluateSoccerQuote({ quote: raw, contract,
      distribution: { period: 'REGULATION_FT', retainedMass: 1, tailMass: 0,
        cells: [{ home: 2, away: 1, probability: 1 }] } });
    const forecast = evaluateSoccerQuote({ quote: raw, contract, distribution: snapshot.prediction });
    assert.equal(actual.ok, true); assert.equal(forecast.ok, true);
    close(actual.netEV, quote.side === 'over' ? .96 : -.99, 'confirmed fractional rebate arithmetic');
    expectedRealized += actual.netEV; expectedLower += forecast.evBounds.net.lower; expectedUpper += forecast.evBounds.net.upper;
  }

  const first = await continueSoccerForwardScan(scope, options);
  assert.equal(first.report.scan.processedGames, 1); assert.equal(first.report.complete, false);
  assert.equal(first.report.retrospectivePayoffReplay.completeWithinRequestedScope, false);
  assert.equal(first.report.retrospectivePayoffReplay.replayedQuoteObservations, 2);
  assert.equal(first.report.marketReturnValidation.observedQuoteReturns, 0);
  assert.ok(first.report.marketReturnValidation.pendingReasons.SOCCER_SOURCE_CONTRACT_UNVERIFIED);
  noPromotion(first.report.retrospectivePayoffReplay);
  const second = await continueSoccerForwardScan(scope, { ...options, cursor: first.report.scan.nextCursor });
  assert.equal(second.report.scan.processedGames, 2); assert.equal(second.report.complete, false);
  assert.equal(second.report.retrospectivePayoffReplay.replayedQuoteObservations, 4);
  const final = await continueSoccerForwardScan(scope, { ...options, cursor: second.report.scan.nextCursor });
  const replay = final.report.retrospectivePayoffReplay;
  assert.equal(final.report.complete, true); assert.equal(final.report.scan.processedGames, 3);
  assert.equal(replay.completeWithinRequestedScope, true);
  assert.equal(replay.selectedQuoteObservations, 4); assert.equal(replay.replayedQuoteObservations, 4);
  assert.equal(replay.uniqueReplayedGames, 2); assert.ok(replay.unpricedPredictionPeriods >= 1);
  assert.equal(replay.pendingQuoteObservations, 0); assert.equal(replay.quarantinedQuoteObservations, 0);
  assert.equal(final.report.marketReturnValidation.observedQuoteReturns, 0);
  noPromotion(replay);
  close(sumRealized(replay), expectedRealized, 'all-game hypothetical realized returns');
  close(replay.groups.reduce((sum, row) => sum + row.predictedNetReturnSum.lower, 0), expectedLower, 'all-game predicted lower returns');
  close(replay.groups.reduce((sum, row) => sum + row.predictedNetReturnSum.upper, 0), expectedUpper, 'all-game predicted upper returns');
  assert.ok(replay.groups.every(row => row.games === 2 && row.quotes === 2));
  const again = await continueSoccerForwardScan(scope, { ...options, cursor: final.report.scan.cursor });
  assert.deepEqual(again.report.retrospectivePayoffReplay, replay, 'terminal cursor cannot double-count replay observations');

  // A cursor made by the previous deployment has already committed games
  // without replay statistics. Its suffix cannot claim full-scope replay QA.
  const legacy = await continueSoccerForwardScan(scope, options);
  const stored = (await query('SELECT state FROM sports_soccer_forward_scans_v1 WHERE cursor=$1', [legacy.report.scan.cursor]))[0].state;
  delete stored.report.retrospectivePayoffReplay;
  await query('UPDATE sports_soccer_forward_scans_v1 SET state=$2::jsonb WHERE cursor=$1', [legacy.report.scan.cursor, JSON.stringify(stored)]);
  const resumedLegacy = await continueSoccerForwardScan(scope, { ...options, gameLimit: 5, cursor: legacy.report.scan.nextCursor });
  assert.equal(resumedLegacy.report.complete, true);
  assert.equal(resumedLegacy.report.retrospectivePayoffReplay.completeWithinRequestedScope, false,
    'missing committed prefix is never inferred from a valid later contribution');
  noPromotion(resumedLegacy.report.retrospectivePayoffReplay);
  console.log('PASS shipped durable soccer scan: original quoted snapshots → source-checked results → assumed-rule replay sums, disjoint whole-game aggregation, partial/resume/idempotence, unpriced coverage and explicit legacy-prefix gap; formal returns remain unapproved');
} finally {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await fixture.close();
}
