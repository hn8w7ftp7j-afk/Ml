import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadOfficialNbaEvidence } from '../lib/nba/official.js';
import { NBA_FORWARD_VERSION, NBA_FORWARD_MARKETS, freezeNbaForwardSelection, nbaCaptureRevision,
  validNbaForwardCapture, canonicalNbaForwardCaptures, evaluateNbaForwardCapture, buildNbaForwardReport,
  nbaForwardContractHash } from '../lib/nba/forward-validation.js';
import { archiveNbaForwardEvaluation, listPendingNbaForwardCaptures, readNbaForwardValidation,
  normalizeNbaForwardScope, prepareNbaForwardSchema } from '../lib/nba/forward-store.js';
import { recordNbaForwardAttempt } from '../lib/nba/forward-store.js';
import { evaluatePendingNbaCaptures } from '../lib/nba/forward-service.js';

const raw = JSON.parse(fs.readFileSync(new URL('./fixtures/nba-official-0022500003.json', import.meta.url)));
const game = JSON.parse(fs.readFileSync(new URL('./fixtures/nba-onoff-401809234.json', import.meta.url))).game;
const now = Date.parse('2026-10-06T20:00:00Z'), start = Date.parse(game.startTime);
const official = await loadOfficialNbaEvidence(game, [], { now: () => now, fetchImpl: async url => new Response(`<script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: url.includes('/games?') ? raw.schedule : { game: raw.game } } })}</script>`) });
const result = { data: { game }, sources: [{ provider: 'ESPN', url: `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${game.sourceId}`,
  status: 'ready', hash: 'a'.repeat(64), fetchedAt: new Date(now).toISOString() }] };
const half = side => game[side].periodScores.slice(0, 2).reduce((sum, q) => sum + q.score, 0);
const fullTotal = game.away.score + game.home.score, fullMargin = game.home.score - game.away.score;
const halfTotal = half('away') + half('home'), halfMargin = half('home') - half('away');
const quotes = { fullTotal: { line: `${fullTotal}+35.5`, overWater: .94, underWater: .92 },
  fullRunline: { line: `${Math.abs(fullMargin)}+25`, lineSide: fullMargin >= 0 ? 'home' : 'away', homeWater: .94, awayWater: .92 },
  firstHalfTotal: { line: `${halfTotal}平`, overWater: .94, underWater: .92 },
  firstHalfRunline: { line: `${Math.abs(halfMargin)}平`, lineSide: halfMargin >= 0 ? 'home' : 'away', homeWater: .94, awayWater: .92 } };
const sideValue = (positive = true) => ({ expectedNet: positive ? 10 : -10, robustExpectedNet: positive ? 5 : -20,
  winProbability: positive ? .6 : .3, lossProbability: positive ? .3 : .6, pushProbability: .1,
  scoreEvidence: { version: 'nba-preseason-season-stress-v1', basis: 'minimum_prior_preseason_season_expected_net',
    seasons: [{ year: 2024, samples: 30, expectedNet: positive ? 5 : -20 }, { year: 2025, samples: 50, expectedNet: positive ? 6 : -15 }] } });
const marketAnalyses = Object.fromEntries(NBA_FORWARD_MARKETS.map(key => [key, { status: 'ready', quote: quotes[key],
  sides: Object.fromEntries((key.endsWith('Total') ? ['over', 'under'] : ['away', 'home']).map((side, i) => [side, sideValue(i === 0)])) }]));
function capture(patch = {}, at = start - 60000) {
  const payload = { status: 'ready', league: 'NBA', gameId: game.id, date: game.taipeiDate, modelVersion: 'fixture-model-v1', engineVersion: 'fixture-engine-v1',
    forwardCaptureVersion: 'nba-analysis-forward-v1', forwardCaptureHashVersion: 'canonical-json-sha256-v1', captureScope: 'SERVER_PREDICTION_AND_ORIGINAL_QUOTES',
    game: { ...game, status: 'scheduled', completed: false, timeConfirmed: true }, executable: false,
    observedAt: new Date(at - 1000).toISOString(), quoteHash: 'b'.repeat(64), quotes: structuredClone(quotes), marketAnalyses: structuredClone(marketAnalyses), ...patch };
  payload.forwardSelection = freezeNbaForwardSelection(payload);
  return { revision: nbaCaptureRevision(payload), capturedAt: new Date(at).toISOString(), payload };
}
const base = capture(), original = structuredClone(base);
assert.equal(validNbaForwardCapture(base), true);
const canonical = canonicalNbaForwardCaptures([base], { now });
assert.equal(canonical.length, 4);
const evaluations = canonical.map(c => evaluateNbaForwardCapture(c, result, official, now));
assert.equal(evaluations.every(e => e.status === 'EVALUATED'), true);
const full = evaluations.find(e => e.marketKey === 'fullTotal');
assert.equal(full.outcomes[0].result, 'PARTIAL_WIN');
assert.equal(full.outcomes[0].fraction, .355); assert.equal(full.outcomes[0].unitProfit, .339025);
assert.equal(full.outcomes[1].unitProfit, -.349675); assert.equal(full.unitStake, 1);
assert.equal(full.isActualBet, false); assert.equal(full.formalEligible, false); assert.equal(full.strictPointInTime, false);
assert.equal(full.outcomes[0].selection.selected, true); assert.equal(full.outcomes[1].selection.selected, false);
assert.equal(full.outcomes[0].brier, (.6 - 1) ** 2);
assert.deepEqual(base, original); assert.deepEqual(full.originalQuote, quotes.fullTotal);
assert.equal(evaluations.find(e => e.marketKey === 'firstHalfTotal').outcomes[0].result, 'PUSH');
assert.equal(evaluations.find(e => e.marketKey === 'fullRunline').outcomes.find(o => o.side === quotes.fullRunline.lineSide).fraction, .25);

// Latest per MARKET, not latest per game or best observed payout. An incomplete
// half head on the newest analysis cannot erase the preceding complete half.
const later = capture({ quotes: { ...quotes, fullTotal: { ...quotes.fullTotal, line: `${fullTotal + 10}平` } },
  marketAnalyses: { ...marketAnalyses, fullTotal: { ...marketAnalyses.fullTotal, quote: { ...quotes.fullTotal, line: `${fullTotal + 10}平` } },
    firstHalfTotal: { status: 'insufficient' } } }, start - 30000);
const last = canonicalNbaForwardCaptures([later, base, base], { now });
assert.equal(last.length, 4);
assert.equal(last.find(c => c.marketKey === 'fullTotal').revision, later.revision);
assert.equal(last.find(c => c.marketKey === 'firstHalfTotal').revision, base.revision);
assert.equal(evaluateNbaForwardCapture(last.find(c => c.marketKey === 'fullTotal'), result, official, now).outcomes[0].result, 'LOSS');
// Same millisecond is NOT the same capture time. PostgreSQL microseconds must
// decide latest; an inverse lexical revision order cannot reverse the winner.
const microLate = { ...capture({}, start - 30000), capturedAtExact: new Date(start - 30000).toISOString().replace('.000Z', '.123900Z') };
let microEarly;
for (let index = 0; index < 100; index++) {
  microEarly = { ...capture({ modelVersion: `micro-fixture-${index}` }, start - 30000),
    capturedAtExact: new Date(start - 30000).toISOString().replace('.000Z', '.123100Z') };
  if (microEarly.revision > microLate.revision) break;
}
assert.ok(microEarly.revision > microLate.revision);
const microCanonical = canonicalNbaForwardCaptures([microLate, microEarly], { now });
assert.ok(microCanonical.every(c => c.revision === microLate.revision));
assert.ok(microCanonical.every(c => c.capturedAtExact.endsWith('.123900Z')));
const microEvaluation = evaluateNbaForwardCapture(microCanonical.find(c => c.marketKey === 'fullTotal'), result, official, now);
assert.equal(microEvaluation.capturedAtExact, microLate.capturedAtExact);
const postgame = capture({}, start + 1), finalCapture = capture({ game: { ...base.payload.game, status: 'final', completed: true } });
assert.equal(canonicalNbaForwardCaptures([postgame, finalCapture], { now }).length, 0);
const corrupted = structuredClone(base); corrupted.payload.quotes.fullTotal.line = '300平';
assert.equal(validNbaForwardCapture(corrupted), false);
const futureObserved = capture({ observedAt: new Date(start + 1).toISOString() });
assert.equal(validNbaForwardCapture(futureObserved), false);
const reordered = JSON.parse(JSON.stringify(base, (_, value) => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).reverse()) : value));
assert.equal(validNbaForwardCapture(reordered), true);
assert.equal(nbaForwardContractHash({ ...reordered, marketKey: 'fullTotal' }), full.contractHash);
assert.equal(evaluateNbaForwardCapture({ ...reordered, marketKey: 'fullTotal' }, result, official, now).outcomes[0].selection.selected, true);
const old = structuredClone(base); delete old.payload.forwardCaptureHashVersion; delete old.payload.forwardSelection; old.revision = 'c'.repeat(64);
const legacy = evaluateNbaForwardCapture({ ...old, marketKey: 'fullTotal' }, result, official, now);
assert.equal(legacy.status, 'EVALUATED'); assert.equal(legacy.outcomes[0].selection.selected, false);
assert.equal(legacy.outcomes[0].selection.reason, 'missing_frozen_selection'); assert.equal(legacy.captureHashReproducible, false);
const noStress = capture({ marketAnalyses: { ...marketAnalyses, fullTotal: { ...marketAnalyses.fullTotal,
  sides: { over: { ...sideValue(), robustExpectedNet: null, scoreEvidence: null }, under: sideValue(false) } } } });
assert.equal(evaluateNbaForwardCapture({ ...noStress, marketKey: 'fullTotal' }, result, official, now).outcomes[0].selection.selected, false);
assert.equal(evaluateNbaForwardCapture(canonical[0], result, { ...official, status: 'blocked' }, now).status, 'PENDING');
assert.equal(evaluateNbaForwardCapture(canonical[0], result, null, now).reason, 'OFFICIAL_SCORE_CROSSCHECK_PENDING');
for (const mutate of [g => g.startTime = new Date(start + 1).toISOString(), g => g.away.id = g.home.id,
  g => g.home.periodScores[0].score++, g => g.statusText = 'Forfeit', g => g.home.periodScores.pop()]) {
  const bad = structuredClone(result); mutate(bad.data.game);
  assert.equal(evaluateNbaForwardCapture(canonical[0], bad, official, now).status, 'PENDING');
}
assert.equal(evaluateNbaForwardCapture(canonical[0], result, official, now + 16 * 60000).status, 'PENDING');
// Full-game OT participates in return, first-half remains first two quarters.
const ot = structuredClone(result), otRaw = structuredClone(raw.game);
for (const side of ['away', 'home']) {
  ot.data.game[side].periodScores.push({ period: 5, score: 5 }); ot.data.game[side].score += 5;
  otRaw[`${side}Team`].periods.push({ period: 5, score: 5 }); otRaw[`${side}Team`].score += 5;
}
const otOfficial = await loadOfficialNbaEvidence(ot.data.game, [], { now: () => now, fetchImpl: async url => new Response(`<script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: url.includes('/games?') ? raw.schedule : { game: otRaw } } })}</script>`) });
assert.equal(evaluateNbaForwardCapture({ ...base, marketKey: 'fullTotal' }, ot, otOfficial, now).outcomes[0].result, 'WIN');
assert.equal(evaluateNbaForwardCapture({ ...base, marketKey: 'firstHalfTotal' }, ot, otOfficial, now).outcomes[0].result, 'PUSH');

const empty = buildNbaForwardReport([]); assert.equal(empty.winRateExcludingPush, null); assert.equal(empty.roi, null); assert.equal(empty.brier, null);
const report = buildNbaForwardReport([...evaluations, ...evaluations]);
assert.equal(report.evaluations, 4); assert.equal(report.directions, 8); assert.equal(report.distinctGames, 1);
assert.equal(report.groups.length, 8); assert.equal(report.partialWins, 2); assert.equal(report.partialLosses, 2);
assert.equal(report.selected.directions, 4); assert.equal(report.selected.distinctGames, 1); assert.equal(report.selectionRate, .5);
assert.equal(report.winRateExcludingPush, .5); assert.equal(report.brier, evaluations.flatMap(e => e.outcomes).reduce((sum, o) => sum + o.brier, 0) / 8);
const secondVersion = { ...full, gameId: `${game.id}1`, observationKey: `${full.observationKey}1`, modelVersion: 'fixture-model-v2', engineVersion: 'fixture-engine-v2' };
assert.equal(buildNbaForwardReport([full, secondVersion]).groups.length, 4);
assert.equal(buildNbaForwardReport([full, secondVersion]).distinctGames, 2);
assert.throws(() => buildNbaForwardReport([full, { ...full, contractHash: 'f'.repeat(64) }]), /Conflicting/);

// The store cannot overwrite a prior observation or write an earlier canonical
// contract; SQL repeats source/capture-time/newer-capture guards atomically.
let saved, writes = 0;
const db = async (strings, ...values) => {
  const sql = strings.join('?');
  if (sql.includes('INSERT INTO nba_forward_evaluations')) {
    assert.match(sql, /ON CONFLICT \(observation_key\) DO NOTHING/); assert.match(sql, /AND NOW\(\) >/);
    assert.match(sql, /AND c\.captured_at </); assert.match(sql, /AND c\.payload =/); assert.match(sql, /AND NOT EXISTS/);
    if (saved) return []; writes++;
    const payload = values.map(value => { try { return JSON.parse(value); } catch { return null; } }).find(value => value?.status === 'EVALUATED');
    saved = { contract_hash: payload.contractHash, payload }; return [saved];
  }
  return saved ? [saved] : [];
};
const fullCapture = canonical.find(c => c.marketKey === 'fullTotal');
assert.equal((await archiveNbaForwardEvaluation(fullCapture, full, { db, prepareSchema: false })).created, true);
assert.equal((await archiveNbaForwardEvaluation(fullCapture, { ...full, evaluatedAt: 'different' }, { db, prepareSchema: false })).created, false);
assert.equal(writes, 1);
await assert.rejects(archiveNbaForwardEvaluation({ ...later, marketKey: 'fullTotal' }, full, { db, prepareSchema: false }), /mismatch/);
assert.equal((await archiveNbaForwardEvaluation(fullCapture, full, { db: async () => [], prepareSchema: false })).status, 'canonical_capture_changed_or_unverified');
let ddl = 0, fail = true;
const ddlDb = async () => { ddl++; if (fail) { fail = false; throw Error('DDL interrupted'); } return []; };
await assert.rejects(prepareNbaForwardSchema(ddlDb), /interrupted/);
await prepareNbaForwardSchema(ddlDb); const prepared = ddl; await prepareNbaForwardSchema(ddlDb); assert.equal(ddl, prepared);
assert.equal(ddl, 8);
const storeRows = [{ ...base, game_id: game.id, board_date: game.taipeiDate, captured_at: base.capturedAt, evaluation_hash: full.contractHash, evaluation: full }];
const read = await readNbaForwardValidation({ date: game.taipeiDate, now }, { db: async strings => {
  assert.match(strings.join('?'), /^SELECT/); return storeRows;
}, prepareSchema: false });
assert.equal(read.evaluations, 1); assert.equal(read.pendingMarkets, 3); assert.equal(read.distinctGames, 1);
const microRead = await readNbaForwardValidation({ date: game.taipeiDate, now }, { db: async () => [{ ...microLate,
  captured_at: new Date(microLate.capturedAtExact), captured_at_exact: microLate.capturedAtExact,
  evaluation_hash: microEvaluation.contractHash, evaluation: microEvaluation }], prepareSchema: false });
assert.equal(microRead.evaluations, 1); assert.equal(microRead.pendingMarkets, 3);
const truncated = await readNbaForwardValidation({ date: game.taipeiDate, now }, { db: async () => Array(10001).fill(storeRows[0]), prepareSchema: false });
assert.equal(truncated.status, 'incomplete_capture_inventory'); assert.equal(truncated.truncated, true);
assert.equal(truncated.roi, null); assert.equal(truncated.selected.winRateExcludingPush, null); assert.equal(truncated.evaluations, null);
await assert.rejects(readNbaForwardValidation({ date: game.taipeiDate, now }, { db: async () => [{ ...storeRows[0], evaluation_hash: 'wrong' }], prepareSchema: false }), /integrity/);
let query = 0;
const pendingList = await listPendingNbaForwardCaptures({ date: game.taipeiDate, now }, { db: async strings => {
  query++; const sql = strings.join('?');
  if (sql.includes('WITH candidate_games')) {
    assert.match(sql, /GROUP BY c.game_id/); assert.match(sql, /ORDER BY attempt.last_attempt ASC NULLS FIRST/);
    assert.match(sql, /nba_forward_attempts_v1/); return storeRows;
  }
  return [{ observation_key: full.observationKey }];
}, prepareSchema: false });
assert.equal(query, 2); assert.equal(pendingList.length, 3); assert.equal(pendingList.some(c => c.marketKey === 'fullTotal'), false);
assert.throws(() => normalizeNbaForwardScope({ date: '2026-02-30', now }), /日期/);
assert.throws(() => normalizeNbaForwardScope({ from: '2024-01-01', through: '2026-01-01', now }), /範圍/);

let loads = 0, officialLoads = 0, archives = 0;
const summary = await evaluatePendingNbaCaptures({ now: () => now, list: async () => pendingList,
  load: async () => { loads++; return result; }, official: async () => { officialLoads++; return official; },
  archive: async (c, e) => { archives++; assert.notEqual(c.marketKey, 'fullTotal'); return { evaluation: e, created: true }; },
  attempt: async (c, s) => { assert.equal(s.evaluated, 3); return { persisted: true }; } });
assert.equal(loads, 1); assert.equal(officialLoads, 1); assert.equal(archives, 3); assert.equal(summary.evaluated, 3);
assert.equal(summary.attemptRecorded, 1);
const fallbackQueries = [];
const fallback = await evaluatePendingNbaCaptures({ now: () => now, list: async () => [base],
  load: async query => { fallbackQueries.push(query.view); return query.view === 'game'
    ? { status: 'unavailable', qa: { issues: [{ code: 'PLAYER_IDENTITY_MISMATCH' }] } }
    : { ...result, status: 'ready', data: { game, players: [] }, identityScope: 'verified_teams_and_periods_only' }; },
  official: async (g, players) => { assert.deepEqual(players, []); return official; },
  archive: async (c, e) => ({ evaluation: e, created: true }), attempt: async () => ({ persisted: true }) });
assert.deepEqual(fallbackQueries, ['game', 'historical-team-box']); assert.equal(fallback.evaluated, 4);
const attemptReceipt = await recordNbaForwardAttempt(base, { checked: 4, evaluated: 0, pending: 4, deferred: 0,
  reasons: { OFFICIAL_SCORE_CROSSCHECK_PENDING: 4 } }, { db: async (strings, ...values) => {
  const sql = strings.join('?'); assert.match(sql, /INSERT INTO nba_forward_attempts/); assert.match(sql, /ON CONFLICT \(attempt_id\) DO NOTHING/);
  const payload = JSON.parse(values[1]); assert.equal(payload.status, 'pending'); assert.equal(payload.isActualBet, false);
  return [{ attempt_id: 'fixture-retry' }];
}, prepareSchema: false, id: 'fixture-retry' });
assert.equal(attemptReceipt.persisted, true);
const olderGame = capture({ gameId: 'nba:espn:game:401111111', game: { ...base.payload.game,
  id: 'nba:espn:game:401111111', sourceId: '401111111' } }, start - 120000);
let elapsed = 0, attemptedGame;
const fairCalls = [];
const fair = await evaluatePendingNbaCaptures({ now: () => now + elapsed, timeBudgetMs: 1000, list: async () => [base, olderGame],
  load: async query => { fairCalls.push(query.id); elapsed = 1001; return result; },
  official: async () => official, archive: async () => { throw Error('Expired budget must not save'); },
  attempt: async (c, s) => { attemptedGame = c.payload.gameId; assert.equal(s.deferred, 4); return { persisted: true }; } });
assert.deepEqual(fairCalls, [game.id]); assert.equal(attemptedGame, game.id); assert.equal(fair.attemptRecorded, 1);
assert.equal(fair.deferred, 8);
const blocked = await evaluatePendingNbaCaptures({ now: () => now, list: async () => [base], load: async () => result, official: async () => null,
  archive: async () => { throw Error('Missing official must never archive'); } });
assert.equal(blocked.evaluated, 0); assert.equal(blocked.pending, 4);
const notStarted = await evaluatePendingNbaCaptures({ now: () => start - 1, list: async () => [base], load: async () => { throw Error('Future must not fetch'); } });
assert.equal(notStarted.reasons.NOT_STARTED, 4);
console.log(`NBA forward validation PASS (${NBA_FORWARD_VERSION}): last-prestart per-market canonical, original prices, frozen selection, JSONB-safe hashes, real two-source final/period verification, OT/half, partial credit, one-unit research ROI/Brier, dependent game counts, append-only/idempotent storage and fail-closed evidence`);
