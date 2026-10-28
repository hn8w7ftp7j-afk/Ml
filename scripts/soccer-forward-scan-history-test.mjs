import assert from 'node:assert/strict';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';
import { fixtureCapture, resultFor } from './helpers/soccer-forward-fixture.mjs';
import { soccerDate } from '../lib/soccer/contracts.js';
import { buildSoccerMarketDirections } from '../lib/soccer/market-directions.js';
import { soccerForwardHash, soccerForwardAnalysisRevision, validateSoccerForwardCapture,
  canonicalSoccerForwardCaptures, evaluateSoccerForwardCapture, SOCCER_FORWARD_VERSION } from '../lib/soccer/forward-validation.js';
import { evaluateSoccerMarketReturnCapture } from '../lib/soccer/market-return-validation.js';
import { buildSoccerReturnErrorDatasetHydrated } from '../lib/soccer/return-error-model.js';

// Every forecast, clock shift, contract and result below is an engineering
// fixture in an isolated PostgreSQL engine, never production model evidence.
const fixture = await soccerSqlFixture(), { db } = fixture;
const oldDb = process.env.DATABASE_URL, oldDbV2 = process.env.DATABASE_V2_URL;
process.env.DATABASE_URL = 'postgres://fixture.invalid/scan-history'; delete process.env.DATABASE_V2_URL;
const iso = value => new Date(value).toISOString(), DAY = 86400000;
try {
  const service = await import('../lib/soccer/forward-validation-service.js');
  const { continueSoccerForwardScan, loadSoccerForwardScanGame } = await import('../lib/soccer/forward-validation-scan.js');
  const protocol = await service.ensureSoccerForwardProtocol(), base = Date.now();
  const query = async (sql, params = []) => (await db.query(sql, params)).rows;
  async function save({ id, league = 'epl', modelSeed = 'history-model', kickoff = base + 3600000, priced = false, marker = '' }) {
    const p = fixtureCapture({ id, league, modelSeed }).snapshot;
    p.runStartedAt = p.observedAt = p.analysisCutoff = iso(base);
    p.date = p.evidence.game.date = soccerDate(kickoff); p.evidence.game.startTime = iso(kickoff);
    p.fixtureContextMarker = marker;
    for (const source of [p.evidence.source, p.evidence.game.source, p.evidence.scheduleSource]) source.fetchedAt = iso(base);
    p.inputVersions.evidenceFetchedAt = iso(base); p.inputVersions.scheduleSourceVersion = { ...p.evidence.scheduleSource };
    if (priced) {
      p.directions = buildSoccerMarketDirections({ game: p.evidence.game, now: base,
        reader: { revision: soccerForwardHash('reader'), observationId: soccerForwardHash('observation'), observedAt: iso(base),
          firstFetchedAt: iso(base), receivedAt: iso(base), persistedAt: iso(base), sourceHost: 'www.tai888.in', pageUrl: 'https://www.tai888.in/newapp/' },
        matchedGames: [{ officialGameId: p.gameId, league: league.toUpperCase(), boardDate: p.date, matchStatus: 'MATCHED', prestart: true,
          markets: [{ period: 'FT', kind: 'TOTAL', unit: 'GOALS', line: '2.5', overWater: .95, underWater: .9, rawRows: ['大2.5 .95', '小 .9'],
            periodEvidence: { period: 'FT', status: 'EXPLICIT', sectionTitle: '英格蘭超級聯賽', tableHeaders: ['全場'], marketHeader: '全場大小' } }] }] });
    }
    const revision = soccerForwardAnalysisRevision(p);
    await query(`INSERT INTO sports_soccer_analysis_v1(league,game_id,analysis_hash,observed_at,payload)
      VALUES($1,$2,$3,$4::timestamptz,$5::jsonb)`, [league, p.gameId, revision, p.observedAt, JSON.stringify(p)]);
    const receipt = await service.captureSoccerForwardSnapshot(p, revision);
    const captures = receipt.captures.map(row => ({ ...row, league, gameId: p.gameId, date: p.date, revision, snapshot: p }));
    for (const capture of captures.filter(row => row.variant === 'BASELINE'))
      assert.equal(validateSoccerForwardCapture(capture, protocol, Date.now()).ok, true);
    return { snapshot: p, captures, ft: captures.find(row => row.period === 'REGULATION_FT' && row.variant === 'BASELINE') };
  }
  const trustedContract = record => ({ provider: 'TAI888', version: 'SYNTHETIC_SCAN_HISTORY_ONLY', status: 'SOURCE_TERMS_VERIFIED',
    evidenceRef: 'synthetic://history-fixture', verifiedAt: iso(base - 1000), league: record.league, period: record.period,
    kind: record.kind, line: record.line, type: 'CREDIT_BOUNDARY', scope: 'REGULATION_FT_WITH_STOPPAGE_NO_EXTRA_TIME_OR_PENALTIES',
    normalFinalOnly: true, abnormalStatusPolicy: 'MANUAL_REVIEW', bindingEvidenceRef: 'synthetic://account-binding',
    effectiveFrom: iso(base - 2000), effectiveUntil: iso(base + 20 * DAY),
    rebate: { rate: .01, basis: 'SETTLED_PRINCIPAL', appliesTo: { FULL_WIN: true, PARTIAL_WIN: true, PUSH: false, PARTIAL_LOSS: true, FULL_LOSS: true } } });
  const original = await save({ id: '100', priced: true }), after = Math.floor((base + 3 * 3600000) / 1000) * 1000 + 500;
  const result = resultFor(original.ft); result.observedAt = iso(after);
  result.sources.forEach(source => { source.fetchedAt = iso(after); });
  result.resultHash = soccerForwardHash('same-semantic-history-result');
  async function addCheck(label, calculatedAt, persistedAt, suppliedResult = result) {
    const evaluation = evaluateSoccerForwardCapture(original.ft, protocol, result, calculatedAt);
    assert.equal(evaluation.status, 'EVALUATED');
    evaluation.marketReturnValidation = evaluateSoccerMarketReturnCapture({ capture: original.ft, protocol, result,
      now: calculatedAt, resolveContract: trustedContract });
    assert.equal(evaluation.marketReturnValidation.status, 'OBSERVED');
    const checkId = label.startsWith('id:') ? label.slice(3) : soccerForwardHash(label);
    // Use the shipped legacy payload shape: there is no projection marker or
    // fabricated approval flag. Real checked_at is read from PostgreSQL below.
    await query(`INSERT INTO sports_soccer_forward_result_checks_v1(check_id,capture_id,checked_at,payload)
      VALUES($1,$2,$3::timestamptz,$4::jsonb)`, [checkId, original.ft.captureId, iso(persistedAt), JSON.stringify({
      version: SOCCER_FORWARD_VERSION, status: evaluation.status, reason: null, evaluation, resultEvidence: suppliedResult })]);
    return { checkId, evaluation, persistedAt, calculatedAt };
  }
  const firstDb = await addCheck('first-db-later-calculation', after + 30000, after + 1000);
  const earlier = await addCheck('earlier-valid-availability', after + 2000, after + 5000);
  const middle = await addCheck('middle-equivalent', after + 8000, after + 10000);
  const later = await addCheck('later-ui-proof', after + 15000, after + 20000);
  // Real PostgreSQL transport yields Date objects. Their default string drops
  // milliseconds; IDs deliberately oppose chronological order in these ties.
  const earliest = await addCheck(`id:${'f'.repeat(64)}`, after + 2000, after + 4999);
  const latest = await addCheck(`id:${'0'.repeat(64)}`, after + 15000, after + 20001);
  const scope = { league: 'epl', date: original.snapshot.date };
  const page = await continueSoccerForwardScan(scope, { query, timeBudgetMs: 25000 });
  const loaded = await loadSoccerForwardScanGame(page.report.scan.cursor, { league: 'epl', game_id: original.ft.gameId },
    { query, protocol, now: after + 60000, resultCheckRows: 1 });
  assert.equal(loaded.truncated, false); assert.equal(loaded.readCoverage.loadedResultCheckRows, 6);
  assert.deepEqual(new Set(loaded.checks.map(row => row.checkId)), new Set([earliest.checkId, latest.checkId]));
  assert.ok(!loaded.checks.some(row => [firstDb.checkId, middle.checkId, earlier.checkId, later.checkId].includes(row.checkId)));
  for (const row of loaded.checks) {
    const stored = (await query('SELECT checked_at,payload FROM sports_soccer_forward_result_checks_v1 WHERE check_id=$1', [row.checkId]))[0];
    assert.equal(row.checkedAt, iso(stored.checked_at));
    assert.deepEqual(row.resultEvidence, stored.payload.resultEvidence);
    assert.equal(row.resultEvidence.resultHash, result.resultHash);
    assert.equal(row.marketReturnEvidenceHash, stored.payload.evaluation.marketReturnValidation.evidenceHash);
  }
  const dataset = await buildSoccerReturnErrorDatasetHydrated(loaded, { now: after + 60000, resolveContract: trustedContract,
    hydrateCapture: async id => original.captures.find(row => row.captureId === id) });
  assert.equal(dataset.observedQuoteReturns, 2);
  assert.ok(dataset.observations.every(row => row.checkedAt === iso(after + 4999)
    && row.returnCalculatedAt === iso(after + 2000) && row.resultPersistedAt === iso(after + 4999)));
  assert.equal(dataset.R, null); assert.equal(dataset.accepted, false);
  console.log('PASS scanner history: legacy archived payloads preserve earliest max(calc, DB) availability and latest immutable UI proof with exact result/check identities');

  // A malformed historical proof must not displace the first usable archived
  // result. It has identical returns/outcome/terms but cannot be recomputed.
  const missing = await addCheck('earliest-missing-result-proof', after + 100, after + 200, null);
  const lateSource = await addCheck('source-not-available-at-claimed-check', after + 120, after + 220,
    { ...result, observedAt: iso(after + 10000), sources: result.sources.map(source => ({ ...source, fetchedAt: iso(after + 10000) })) });
  const mismatched = await addCheck('earliest-mismatched-result-proof', after + 150, after + 250,
    { ...result, resultHash: soccerForwardHash('does-not-match-sealed-return-result') });
  const secondPage = await continueSoccerForwardScan(scope, { query, timeBudgetMs: 25000 });
  const withMissing = await loadSoccerForwardScanGame(secondPage.report.scan.cursor, { league: 'epl', game_id: original.ft.gameId },
    { query, protocol, now: after + 60000, resultCheckRows: 1 });
  const validDataset = await buildSoccerReturnErrorDatasetHydrated(withMissing, { now: after + 60000, resolveContract: trustedContract,
    hydrateCapture: async id => original.captures.find(row => row.captureId === id) });
  assert.ok(validDataset.observations.every(row => row.checkedAt === iso(after + 4999)),
    `missing result ${missing.checkId} cannot erase the earliest valid result availability`);
  assert.equal(validDataset.observedQuoteReturns, 2);
  assert.ok(withMissing.checks.some(row => row.checkId === missing.checkId));
  assert.ok(withMissing.checks.some(row => row.checkId === mismatched.checkId), 'invalid and missing original proofs retain their own diagnostics');
  assert.ok(withMissing.checks.some(row => row.checkId === lateSource.checkId), 'a source available by scan time is still unusable before its own claimed check availability');
  const badSeal = structuredClone(earliest.evaluation); badSeal.marketReturnValidation.checkedAt = iso(after + 50);
  badSeal.marketReturnValidation.observations[0].distributionHash = 'e'.repeat(64);
  const badSealId = soccerForwardHash('invalid-market-seal');
  await query(`INSERT INTO sports_soccer_forward_result_checks_v1(check_id,capture_id,checked_at,payload)
    VALUES($1,$2,$3::timestamptz,$4::jsonb)`, [badSealId, original.ft.captureId, iso(after + 60), JSON.stringify({
    version: SOCCER_FORWARD_VERSION, status: 'EVALUATED', evaluation: badSeal, resultEvidence: result })]);
  const sealedPage = await continueSoccerForwardScan(scope, { query, timeBudgetMs: 25000 });
  const invalidSealEvidence = await loadSoccerForwardScanGame(sealedPage.report.scan.cursor, { league: 'epl', game_id: original.ft.gameId },
    { query, protocol, now: after + 60000, resultCheckRows: 1 });
  assert.ok(invalidSealEvidence.checks.some(row => row.checkId === earliest.checkId), 'invalid sealed data cannot displace the earliest usable proof');
  assert.ok(invalidSealEvidence.checks.some(row => row.checkId === badSealId), 'invalid sealed data remains available to quarantine downstream research');
  const quarantined = await buildSoccerReturnErrorDatasetHydrated(invalidSealEvidence, { now: after + 60000, resolveContract: trustedContract,
    hydrateCapture: async id => original.captures.find(row => row.captureId === id) });
  assert.equal(quarantined.observedQuoteReturns, 0); assert.equal(quarantined.quarantinedGames, 1);
  assert.ok(quarantined.excludedReasons.RETURN_ERROR_CHECK_HASH_INVALID);

  const oldContext = await save({ id: '200', modelSeed: 'before-reschedule-model', kickoff: base + 3 * DAY });
  const newContext = await save({ id: '200', modelSeed: 'after-reschedule-model', kickoff: base + 4 * DAY });
  const sameModelLater = await save({ id: '200', modelSeed: 'before-reschedule-model', kickoff: base + 4 * DAY, marker: 'later-valid-same-model' });
  const logicalNow = base + 5 * DAY, newResult = resultFor(newContext.ft);
  newResult.observedAt = iso(logicalNow - 1000); newResult.sources.forEach(source => { source.fetchedAt = newResult.observedAt; });
  newResult.resultHash = soccerForwardHash('real-rescheduled-context-fixture');
  const fetched = [], archived = [];
  const contextPage = await continueSoccerForwardScan({ league: 'epl', from: oldContext.snapshot.date, through: newContext.snapshot.date },
    { query, purpose: 'evaluate', now: () => logicalNow, timeBudgetMs: 25000, gameLimit: 5,
      fetchResult: async context => { fetched.push(context); return newResult; },
      archive: async (...args) => { archived.push({ capture: args[0], evaluation: args[1], result: args[2] }); return service.archiveSoccerForwardCheck(...args); } });
  assert.equal(fetched.length, 2, 'one actual fetch per exact original date/kickoff/team context, shared across FT and HT');
  assert.deepEqual(new Set(fetched.map(row => row.startTime)), new Set([oldContext.ft.snapshot.evidence.game.startTime, newContext.ft.snapshot.evidence.game.startTime]));
  assert.equal(contextPage.report.complete, true); assert.equal(contextPage.summary.evaluated, 2); assert.equal(contextPage.summary.pending, 2);
  assert.equal(contextPage.summary.reasons.FORWARD_RESULT_SCOPE_MISMATCH, 2);
  assert.equal(contextPage.report.evaluatedGameModelPeriods, 2);
  assert.ok(archived.filter(row => row.capture.revision === oldContext.ft.revision).every(row => row.evaluation.reason === 'FORWARD_RESULT_SCOPE_MISMATCH'));
  assert.ok(archived.filter(row => row.capture.revision === newContext.ft.revision).every(row => row.evaluation.status === 'EVALUATED'));
  assert.ok(!archived.some(row => row.capture.revision === sameModelLater.ft.revision), 'a favorable later same-model forecast cannot replace the first valid forecast');
  const contextLoaded = await loadSoccerForwardScanGame(contextPage.report.scan.cursor, { league: 'epl', game_id: oldContext.ft.gameId }, { query, protocol, now: logicalNow });
  const canonical = canonicalSoccerForwardCaptures(contextLoaded.captures, protocol, logicalNow);
  assert.equal(canonical.chosen.length, 4); assert.equal(canonical.superseded.length, 2);
  console.log('PASS scanner reschedule: exact original context fetch/cache, old context pending, new legitimate model evaluated, first same-model selection preserved');

  const deadlineA = await save({ id: '301', league: 'ucl', kickoff: base + 7 * DAY });
  await save({ id: '302', league: 'ucl', kickoff: base + 7 * DAY });
  let clock = base + 1000, committedGames = 0;
  const deadlineScope = { league: 'ucl', date: deadlineA.snapshot.date };
  const deadlineQuery = async (sql, params = []) => {
    const rows = await query(sql, params);
    if (sql.startsWith('UPDATE sports_soccer_forward_scans_v1 SET state=')) { committedGames++; clock += 100; }
    // Allow the next game to begin, then exhaust its deadline during SQL. The
    // already committed first game must still produce a response and cursor.
    if (committedGames === 1 && sql.startsWith('SELECT league,game_id,min(capture_sequence)')) clock += 25000;
    return rows;
  };
  const partial = await continueSoccerForwardScan(deadlineScope, { query: deadlineQuery, now: () => clock, gameLimit: 5, timeBudgetMs: 25000 });
  assert.equal(partial.report.complete, false); assert.equal(partial.report.scan.processedGames, 1);
  assert.equal(partial.report.scan.totalGames, 2); assert.ok(partial.report.scan.nextCursor);
  assert.equal(partial.summary.budgetExhausted, true); assert.equal(partial.report.returnErrorResearch.completeWithinRequestedScope, false);
  const resumed = await continueSoccerForwardScan(deadlineScope, { query, cursor: partial.report.scan.nextCursor, now: () => clock, timeBudgetMs: 25000 });
  assert.equal(resumed.report.complete, true); assert.equal(resumed.report.scan.processedGames, 2);
  assert.equal(resumed.report.capturedSnapshotPeriods, 6, 'durable first-game contribution is retained exactly once across a deadline continuation');
  console.log('PASS scanner deadline: completed game survives a later-game timeout, partial cursor resumes without losing or double-counting durable progress');
} finally {
  if (oldDb === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = oldDb;
  if (oldDbV2 === undefined) delete process.env.DATABASE_V2_URL; else process.env.DATABASE_V2_URL = oldDbV2;
  await fixture.close();
}
