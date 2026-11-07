import assert from 'node:assert/strict';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';
import { fixtureCapture, resultFor } from './helpers/soccer-forward-fixture.mjs';
import { soccerDate } from '../lib/soccer/contracts.js';
import { buildSoccerMarketDirections } from '../lib/soccer/market-directions.js';
import { soccerForwardAnalysisRevision, soccerForwardHash, validateSoccerForwardCapture,
  SOCCER_FORWARD_POLICY, SOCCER_FORWARD_VERSION } from '../lib/soccer/forward-validation.js';

// Engineering fixtures only: actual PostgreSQL schema/store/collector/report
// code, a local source transport, and an explicitly simulated execution clock.
// No Production credentials, HTTP providers, wagers, or acceptance registrations.
const fixture = await soccerSqlFixture(), { db } = fixture;
const previous = [process.env.DATABASE_URL, process.env.DATABASE_V2_URL], originalFetch = globalThis.fetch;
process.env.DATABASE_URL = 'postgres://fixture.invalid/forward-collector'; delete process.env.DATABASE_V2_URL;
globalThis.fetch = async () => { throw Error('Collector fixture must not fetch external providers'); };
try {
  const service = await import('../lib/soccer/forward-validation-service.js');
  const { ensureSoccerJournal } = await import('../lib/soccer/journal.js');
  const { collectSoccerForwardResults, collectSoccerForwardBacklog } = await import('../lib/soccer/forward-result-collector.js');
  const { continueSoccerForwardScan, SoccerForwardScanError } = await import('../lib/soccer/forward-validation-scan.js');
  const query = async (sql, params = []) => (await db.query(sql, params)).rows;
  await ensureSoccerJournal(); for (const sql of service.SOCCER_FORWARD_SCHEMA) await query(sql);
  const activation = Date.now() - 20 * 86400000;
  await query(`INSERT INTO sports_soccer_forward_protocol_v1(protocol_version,policy_hash,policy,activated_at)
    VALUES($1,$2,$3::jsonb,$4::timestamptz)`, [SOCCER_FORWARD_VERSION,soccerForwardHash(SOCCER_FORWARD_POLICY),JSON.stringify(SOCCER_FORWARD_POLICY),new Date(activation).toISOString()]);
  const protocol = await service.ensureSoccerForwardProtocol(), prepared = Date.now(), kickoff = prepared + 3500;
  const iso = value => new Date(value).toISOString(), snapshots = new Map();
  async function save(id, { league = 'epl', marker = 0, corrupt = false, startTime = iso(kickoff), padding = '' } = {}) {
    const p = fixtureCapture({ id, league }).snapshot;
    p.runStartedAt = p.observedAt = p.analysisCutoff = iso(prepared);
    p.date = p.evidence.game.date = Number.isFinite(Date.parse(startTime)) ? soccerDate(startTime) : soccerDate(kickoff); p.evidence.game.startTime = startTime;
    for (const source of [p.evidence.source, p.evidence.game.source, p.evidence.scheduleSource]) source.fetchedAt = iso(prepared);
    p.inputVersions.evidenceFetchedAt = iso(prepared); p.inputVersions.scheduleSourceVersion = { ...p.evidence.scheduleSource };
    Object.assign(p.readerIdentityEvidence, { date: p.date, verifiedAt: iso(prepared) });
    p.marker = marker; p.padding = padding;
    const reader = { revision: soccerForwardHash('collector-original-reader'), observationId: soccerForwardHash('collector-original-observation'),
      observedAt: iso(prepared), firstFetchedAt: iso(prepared), receivedAt: iso(prepared), persistedAt: iso(prepared),
      sourceHost: 'www.tai888.in', pageUrl: 'https://www.tai888.in/newapp/' };
    p.directions = buildSoccerMarketDirections({ game: p.evidence.game, reader, now: prepared,
      matchedGames: [{ officialGameId: p.gameId, league: league.toUpperCase(), boardDate: p.date, prestart: true, matchStatus: 'MATCHED',
        markets: [{ period: 'FT', kind: 'TOTAL', unit: 'GOALS', line: '2.5', overWater: .95, underWater: .9,
          periodEvidence: { sectionTitle: league === 'epl' ? '英格蘭超級聯賽' : '歐洲冠軍聯賽', tableHeaders: ['全場'],
            marketHeader: '全場大小', period: 'FT', status: 'EXPLICIT' } }] }] });
    const revision = corrupt ? soccerForwardHash('intentionally-mismatched-original') : soccerForwardAnalysisRevision(p);
    await query(`INSERT INTO sports_soccer_analysis_v1(league,game_id,analysis_hash,observed_at,payload)
      VALUES($1,$2,$3,$4::timestamptz,$5::jsonb)`, [league, p.gameId, revision, p.observedAt, JSON.stringify(p)]);
    await service.captureSoccerForwardSnapshot(p, revision);
    snapshots.set(`${league}|${p.gameId}`, p);
    return p;
  }
  const originals = [];
  for (let i = 0; i < 8; i++) originals.push(await save('100', { marker: i }));
  await save('101'); // provider unavailable
  await save('102', { corrupt: true });
  await save('103', { padding: 'large-original-fixture'.repeat(500) });
  await save('106'); // mismatching verified-looking result
  await save('107', { startTime: 'corrupt-start-time' });
  await save('108', { startTime: iso(kickoff + 3600000) }); // upcoming, never queried
  await save('100', { league: 'ucl' }); // same provider ID cannot alias EPL
  await save('109', { startTime: iso(kickoff - 9 * 86400000) }); // old incomplete receipt must not age out
  assert.ok(Date.now() < kickoff, 'all synthetic DB receipts must actually predate kickoff');
  const before = await query(`SELECT league,game_id,analysis_hash,payload FROM sports_soccer_analysis_v1 ORDER BY league,game_id,analysis_hash`);
  const receiptsBefore = await query(`SELECT * FROM sports_soccer_forward_captures_v1 ORDER BY capture_sequence`);
  await new Promise(resolve => setTimeout(resolve, Math.max(0, kickoff + 10 - Date.now())));
  const scope = { league: 'epl', date: originals[0].date };
  const initial = await service.loadSoccerForwardEvidence(scope), first = initial.captures.find(c => c.gameId === originals[0].gameId && c.period === 'REGULATION_FT');
  assert.equal(validateSoccerForwardCapture(first, protocol).ok, true);
  let sourceCalls = [];
  const fetchResult = async context => {
    sourceCalls.push(context);
    const p = snapshots.get(`${context.league}|${context.gameId}`), value = resultFor({ league: p.league, gameId: p.gameId, date: p.date, snapshot: p });
    const at = iso(Date.now()); value.observedAt = at; value.sources = value.sources.map(source => ({ ...source, fetchedAt: at }));
    return value;
  };
  // Reproduce the old all-originals-before-first-check failure without a slow
  // host/network dependency. The same original payload transfer cost is charged
  // per revision in both paths; the game contains 8 valid reanalyses.
  let clock = Date.now();
  await assert.rejects(() => continueSoccerForwardScan(scope, { purpose: 'evaluate', timeBudgetMs: 8000, now: () => clock,
    query: async (sql, params = []) => {
      const rows = await query(sql, params);
      if (sql.startsWith('SELECT a.analysis_hash,a.payload')) clock += rows.length * 2000;
      return rows;
    }, fetchResult }), error => error instanceof SoccerForwardScanError && /尚未讀完/.test(error.publicMessage));
  assert.equal((await query('SELECT count(*)::int AS n FROM sports_soccer_forward_result_checks_v1'))[0].n, 0);
  assert.equal(sourceCalls.length, 0, 'the old full-game hydrate never reached a source/check append');
  // Under the same budget the new path commits a receipt immediately. Its next
  // invocation selects untouched receipts instead of restarting that game.
  const collected = [];
  const limited = async (options = {}) => {
    clock = Date.now();
    const result = await collectSoccerForwardResults(scope, { timeBudgetMs: 8000, receiptLimit: 12, now: () => clock,
      query: async (sql, params = []) => {
        const rows = await query(sql, params);
        if (sql.startsWith('SELECT payload FROM sports_soccer_analysis_v1')) clock += 2000;
        if (sql.startsWith('INSERT INTO sports_soccer_forward_result_checks_v1')) clock += 1000;
        return rows;
      }, fetchResult, ...options });
    collected.push(result); return result;
  };
  const a = await limited();
  assert.equal(a.budgetExhausted, true); assert.ok(a.checkedCaptureReceipts > 0 && a.checkedCaptureReceipts < 24);
  assert.ok(a.evaluatedCaptureReceipts > 0); assert.equal(a.complete, false); assert.equal(a.formalEligible, false);
  assert.equal(a.sampleCountScope, 'PHYSICAL_ORIGINAL_CAPTURE_RECEIPTS_NOT_CANONICAL_GAMES');
  const checkedFirst = (await query('SELECT capture_id FROM sports_soccer_forward_result_checks_v1')).map(row => row.capture_id);
  const b = await limited();
  const checkedSecond = (await query('SELECT capture_id FROM sports_soccer_forward_result_checks_v1')).map(row => row.capture_id);
  assert.ok(b.checkedCaptureReceipts > 0); assert.ok(checkedSecond.length > checkedFirst.length);
  assert.equal(new Set(checkedSecond).size, checkedSecond.length, 'due receipts advance durably with no same-hour repeat');
  while (true) {
    const n = (await query(`SELECT count(*)::int AS n FROM sports_soccer_forward_result_checks_v1 k
      JOIN sports_soccer_forward_captures_v1 c ON c.capture_id=k.capture_id WHERE c.game_id='soccer:epl:100' AND c.league='epl'`))[0].n;
    if (n >= 24) break;
    await limited({ receiptLimit: Math.min(3, 24 - n) });
  }
  const validChecks = await query(`SELECT k.payload FROM sports_soccer_forward_result_checks_v1 k
    JOIN sports_soccer_forward_captures_v1 c ON c.capture_id=k.capture_id WHERE c.game_id='soccer:epl:100' AND c.league='epl'`);
  assert.equal(validChecks.filter(row => row.payload.status === 'EVALUATED').length, 16);
  assert.equal(validChecks.filter(row => row.payload.reason === 'FORWARD_PERSONNEL_MODEL_UNVERIFIED').length, 8);
  assert.ok(validChecks.filter(row => row.payload.status === 'EVALUATED').every(row => row.payload.evaluation.marketReturnValidation?.diagnosticVersion));
  const failed = await limited({ receiptLimit: 3, fetchResult: async () => { throw Error('synthetic source outage'); } });
  assert.equal(failed.pendingCaptureReceipts, 3); assert.equal(failed.reasons.FORWARD_RESULT_SOURCE_UNAVAILABLE, 2);
  const corruptCalls = sourceCalls.length, corrupt = await limited({ receiptLimit: 3 });
  assert.equal(corrupt.reasons.FORWARD_ORIGINAL_REVISION_MISMATCH, 3); assert.equal(sourceCalls.length, corruptCalls);
  const tooLarge = await limited({ receiptLimit: 3, capturePayloadBytes: 1 });
  assert.equal(tooLarge.reasons.FORWARD_ORIGINAL_PAYLOAD_BYTE_BUDGET, 3); assert.equal(tooLarge.loadedUniqueOriginals, 0);
  const mismatch = await limited({ receiptLimit: 3, fetchResult: async context => ({ ...await fetchResult(context), gameId: 'soccer:epl:999' }) });
  assert.equal(mismatch.reasons.FORWARD_RESULT_SCOPE_MISMATCH, 2); assert.equal(mismatch.evaluatedCaptureReceipts, 0);
  const badDate = await limited({ receiptLimit: 3 });
  // Invalid JSON dates cannot crash the SQL queue through a timestamptz cast.
  assert.equal(badDate.pendingCaptureReceipts, 3, 'corrupt dates rotate through explicit pending diagnostics');
  const idle = await limited(); assert.equal(idle.checkedCaptureReceipts, 0); assert.equal(idle.sourceRequests, 0);
  assert.ok(sourceCalls.every(row => row.league === 'epl' && row.gameId !== 'soccer:epl:108'));
  const ucl = await collectSoccerForwardResults({ league: 'ucl', date: originals[0].date }, { query, fetchResult });
  assert.equal(ucl.checkedCaptureReceipts, 3); assert.equal(ucl.evaluatedCaptureReceipts, 2); assert.equal(ucl.sourceRequests, 1);
  assert.ok(sourceCalls.at(-1).league === 'ucl');
  // A fresh complete report, not receipt counters, chooses the first valid
  // prediction once per model/period. Later reanalysis checks cannot inflate it.
  const report = await continueSoccerForwardScan(scope, { query, gameLimit: 25, timeBudgetMs: 25000, now: () => Date.now() + 60000 });
  assert.equal(report.report.complete, true); assert.equal(report.report.evaluatedGameModelPeriods, 2);
  assert.equal(report.report.formalEligible, false); assert.equal(report.report.marketReturnValidation.S, null);
  assert.ok(report.report.groups.some(group => group.laterReanalysesNotSelected >= 7));
  assert.deepEqual(await query(`SELECT league,game_id,analysis_hash,payload FROM sports_soccer_analysis_v1 ORDER BY league,game_id,analysis_hash`), before);
  assert.deepEqual(await query(`SELECT * FROM sports_soccer_forward_captures_v1 ORDER BY capture_sequence`), receiptsBefore);
  const oneOriginalBytes = Number((await query(`SELECT octet_length(payload::text)::bigint AS n
    FROM sports_soccer_analysis_v1 WHERE league='epl' AND game_id='soccer:epl:100' ORDER BY payload->>'marker' LIMIT 1`))[0].n);
  const bytes = await collectSoccerForwardResults(scope, { query, fetchResult, receiptLimit: 25, capturePayloadBytes: oneOriginalBytes,
    now: () => Date.now() + SOCCER_FORWARD_POLICY.resultCheckDedupWindowMs + 1000 });
  assert.equal(bytes.originalPayloadBudgetExhausted, true);
  assert.ok(bytes.checkedCaptureReceipts > 0 && bytes.loadedOriginalPayloadBytes <= oneOriginalBytes,
    'one call bounds total retained original bytes, not merely each individual read');
  // Existing append-only pending diagnostics eventually re-enter the fair
  // queue. Upcoming games remain skipped even when recent checks are due.
  const beforeRetryCalls = sourceCalls.length;
  const retry = await collectSoccerForwardResults(scope, { query, fetchResult, receiptLimit: 25,
    now: () => Date.now() + SOCCER_FORWARD_POLICY.resultCheckDedupWindowMs + 1000 });
  assert.ok(retry.checkedCaptureReceipts > 0); assert.equal(retry.formalEligible, false);
  assert.ok(sourceCalls.slice(beforeRetryCalls).every(context => context.gameId !== 'soccer:epl:100'),
    'successful original baseline receipts retain the six-hour source recheck interval');
  const backlog = await collectSoccerForwardBacklog({ query, fetchResult, receiptLimit: 25 });
  assert.deepEqual(backlog.requestedScope,{league:null,from:soccerDate(activation),through:soccerDate()});
  assert.equal(backlog.reasons.FORWARD_FIRST_CAPTURE_NOT_PREGAME,3,
    'activation-to-today queue still checks an older-than-seven-days receipt, without admitting its late capture');
  const correctedAt=Date.now()+SOCCER_FORWARD_POLICY.settledResultRecheckIntervalMs+1000;
  await collectSoccerForwardResults(scope,{query,receiptLimit:25,now:()=>correctedAt,fetchResult:async context=>{
    const result=await fetchResult(context);
    if(context.gameId==='soccer:epl:100'){
      result.fullTime={home:3,away:0,period:'REGULATION_FT'};
      result.halfTime={home:2,away:0,period:'REGULATION_HT',verified:true};
      result.resultHash=soccerForwardHash('synthetic-corrected-original-result');
    }
    return result;
  }});
  const correctedReport=await service.readSoccerForwardValidation(scope,{query,now:()=>correctedAt});
  assert.ok(correctedReport.conflictingResultCaptures>=2);
  assert.equal(correctedReport.groups.flatMap(group=>group.observations).filter(row=>row.gameId==='soccer:epl:100').length,0);
  assert.ok(correctedReport.groups.some(group=>group.pendingReasons.FORWARD_CONFLICTING_RESULT_EVIDENCE>=1));
  assert.equal(correctedReport.formalEligible,false);
  for (const options of [{ receiptLimit: 0 }, { timeBudgetMs: 0 }, { receiptLimit: 26 }, { capturePayloadBytes: 0 }])
    await assert.rejects(() => collectSoccerForwardResults(scope, options), /COLLECTOR_BUDGET/);
  console.log('PASS real PostgreSQL per-capture result collection: reproducible old whole-game timeout, durable partial progress, fair retries, exact original revision admission, byte/time/count bounds, provider/scope failures, immutable originals, league isolation, and unchanged full-history canonical sample selection.');
} finally {
  if (previous[0] === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous[0];
  if (previous[1] === undefined) delete process.env.DATABASE_V2_URL; else process.env.DATABASE_V2_URL = previous[1];
  globalThis.fetch = originalFetch; await fixture.close();
}
