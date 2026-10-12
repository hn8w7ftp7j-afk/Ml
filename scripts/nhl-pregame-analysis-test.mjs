import assert from 'node:assert/strict';
import { normalizeNhlScheduleGame } from '../lib/nhl/data.js';
import { fitNhlModel, predictNhlDistribution } from '../lib/nhl/model.js';
import { auditNhlDistribution } from '../lib/nhl/model-qa.js';
import { nhlContentHash } from '../lib/nhl/distribution.js';
import { analyzeNhlPregame, listNhlPregameAnalyses, loadNhlPregameHistory,
  fittedNhlPregameArtifact, validNhlPregameRequest } from '../lib/nhl/pregame-analysis.js';
import { restoreNhlPregameDistribution, validateNhlAnalysisObservation,
  nhlPregameSnapshotHash, archiveNhlPregameDistribution } from '../lib/nhl/pregame-snapshot.js';
import { validateNhlObservation } from '../lib/nhl/store.js';
import { validateNhlCapture, NHL_READER_INTERFACE_VERSION } from '../lib/nhl/reader.js';

delete process.env.DATABASE_URL; delete process.env.DATABASE_V2_URL; process.env.VERCEL = '0';
const nowValue = Date.parse('2026-10-12T09:00:00Z');
const raw = { id: 2026020100, season: 20262027, gameType: 2, startTimeUTC: '2026-10-14T00:00:00Z',
  gameState: 'FUT', gameScheduleState: 'OK', gameDate: '2026-10-13',
  awayTeam: { id: 18, abbrev: 'NSH', placeName: { default: 'Nashville' }, commonName: { default: 'Predators' } },
  homeTeam: { id: 14, abbrev: 'TBL', placeName: { default: 'Tampa Bay' }, commonName: { default: 'Lightning' } } };
const source = { provider: 'NHL', url: `https://api-web.nhle.com/v1/gamecenter/${raw.id}/landing`,
  fetchedAt: new Date(nowValue).toISOString(), contentHash: nhlContentHash(raw) };
const game = normalizeNhlScheduleGame(raw, source);
const request = { league: 'NHL', date: game.taipeiDate, gameId: game.gameId };
const fullHistory = await loadNhlPregameHistory();
assert.equal(fullHistory.count, 1312);
assert.ok(fullHistory.games.every(row => row.periodCoverageVerified && row.synthetic !== true && row.source.provider === 'NHL'));
const history = { ...fullHistory, games: fullHistory.games.slice(0, 20), count: 20,
  sourceHash: nhlContentHash(fullHistory.games.slice(0, 20)) };
const evidence = { ok: true, league: 'NHL', gameId: game.gameId, asOf: new Date(nowValue).toISOString(),
  status: 'WARNING', features: {}, sources: [], missingSources: [{ code: 'NHL_SOURCE_HTTP_ERROR' }],
  personnel: { ok: false, code: 'NHL_PERSONNEL_ARTICLE_NOT_FOUND' }, issues: [], warnings: ['NHL_SOURCE_PARTIAL'] };
let frozen = null; let writes = 0;
const adapters = {
  now: () => nowValue, persistenceConfigured: () => true,
  fetchGame: async () => ({ ok: true, game: structuredClone(game) }),
  loadObservations: async kind => kind === 'ANALYSIS' && frozen ? [structuredClone(frozen)] : [],
  loadHistory: async () => history, fetchEvidence: async () => structuredClone(evidence),
  saveObservation: async (kind, key, value) => {
    assert.equal(kind, 'ANALYSIS'); assert.equal(key, game.gameId);
    assert.equal(validateNhlObservation(kind, key, value, { now: nowValue }).ok, true);
    frozen = structuredClone(value); writes++;
    return { persisted: true, revision: nhlContentHash(value) };
  },
};

let passes = 0;
const test = async (name, fn) => { await fn(); passes++; console.log(`PASS ${name}`); };

await test('future official game gets unchanged independent score model and immutable pregame archive', async () => {
  const result = await analyzeNhlPregame(request, adapters);
  assert.equal(result.mode, 'PREGAME_SHADOW'); assert.equal(result.persistence.persisted, true);
  assert.equal(result.readiness.formalRecommendations, false); assert.equal(result.readiness.realBetExecutionEnabled, false);
  assert.equal(result.market.weightedEV, null); assert.equal(result.market.robustEV, null); assert.equal(result.market.score, null);
  assert.equal(result.model.expectedGoals.away, result.model.scopes.REGULATION.awayGoals);
  assert.equal(result.model.finalExpectedGoals.away, result.model.scopes.FINAL.awayGoals);
  const p = result.model.probabilities;
  assert.ok(Math.abs(p.homeWin + p.awayWin - 1) < 1e-10);
  assert.ok(Math.abs(p.regulationAwayWin + p.regulationHomeWin + p.regulationDraw - 1) < 1e-10);
  assert.equal(result.distributionArchive, undefined, 'Raw linked paths are not sent to the browser');
  assert.deepEqual(result.missingSources, evidence.missingSources);
  const distribution = restoreNhlPregameDistribution(frozen.distributionArchive);
  assert.equal(auditNhlDistribution(distribution).passed, true);
  assert.equal(distribution.calibrationEvidence.foldEvidence, undefined);
  assert.ok(distribution.calibrationEvidence.foldEvidenceHash);
  assert.equal(distribution.scenarios.length, 9); assert.equal(distribution.scenarios[0].paths.length, 20);
});

await test('past game replays only the original durable pregame result and never recomputes', async () => {
  const replay = await analyzeNhlPregame({ ...request, force: true }, { ...adapters,
    now: () => Date.parse(game.startTimeUTC) + 60_000,
    fetchGame: async () => ({ ok: true, game: { ...game, gameState: 'LIVE' } }),
    fetchEvidence: async () => { throw new Error('Must never read present personnel for a past forecast'); },
    loadHistory: async () => { throw new Error('Must never backfit a completed game'); },
  });
  assert.equal(replay.mode, 'SAVED_PREGAME_REPLAY'); assert.equal(replay.generatedAt, frozen.generatedAt);
  assert.deepEqual(replay.model, frozen.model); assert.equal(writes, 1);
});

await test('started game without a real snapshot is unavailable before model/source enrichment', async () => {
  const unavailable = await analyzeNhlPregame(request, { ...adapters, loadObservations: async () => [],
    now: () => Date.parse(game.startTimeUTC), fetchEvidence: async () => assert.fail('No postgame data'),
    loadHistory: async () => assert.fail('No postgame fitting'),
  });
  assert.equal(unavailable.mode, 'NO_PREGAME_RECORD'); assert.equal(unavailable.model, null);
  assert.equal(unavailable.qa.status, 'BLOCK'); assert.equal(writes, 1);
});

await test('postponed future target cannot produce a fresh model', async () => {
  const unavailable = await analyzeNhlPregame(request, { ...adapters, loadObservations: async () => [],
    fetchGame: async () => ({ ok: true, game: { ...game, gameScheduleState: 'PPD' } }),
    fetchEvidence: async () => assert.fail('No unavailable-game enrichment'),
  });
  assert.equal(unavailable.mode, 'NO_PREGAME_RECORD'); assert.equal(unavailable.model, null);
});

await test('cutoff crossing during source acquisition never backdates a new analysis', async () => {
  let movingNow = nowValue;
  const unavailable = await analyzeNhlPregame(request, { ...adapters, now: () => movingNow,
    loadObservations: async () => [], fetchEvidence: async () => { movingNow = Date.parse(game.startTimeUTC); return evidence; },
  });
  assert.equal(unavailable.mode, 'NO_PREGAME_RECORD'); assert.equal(writes, 1);
});

await test('identity or source-time conflicts fail instead of becoming a warning forecast', async () => {
  for (const changed of [
    { ...evidence, ok: false, status: 'BLOCK', code: 'NHL_PREGAME_EVIDENCE_ACQUIRED_AFTER_START' },
    { ...evidence, league: 'NBA' }, { ...evidence, gameId: '2026020101' },
    { ...evidence, issues: ['NHL_PERSONNEL_IDENTITY_CONFLICT'] },
    { ...evidence, asOf: '2026-10-12T10:00:00Z' },
  ]) await assert.rejects(analyzeNhlPregame(request, { ...adapters, loadObservations: async () => [],
    fetchEvidence: async () => changed }), cause => cause.status === 422);
  await assert.rejects(analyzeNhlPregame(request, { ...adapters, loadObservations: async () => [],
    fetchGame: async () => ({ ok: true, game: { ...game, homeTeamId: 18 } }) }), { code: 'NHL_ANALYSIS_GAME_IDENTITY_MISMATCH' });
});

await test('immutable snapshot rejects corruption, league mixing, timestamp changes and altered numerical summaries', async () => {
  for (const mutate of [
    record => { record.distributionArchive.data = record.distributionArchive.data.replace(/./, 'A'); },
    record => { record.game.league = 'NBA'; },
    record => { record.generatedAt = game.startTimeUTC; record.observedAt = game.startTimeUTC; },
    record => { record.model.expectedGoals.home += 1; },
    record => { record.sources[0].url = 'https://evil.example/current'; },
  ]) {
    const corrupt = structuredClone(frozen); mutate(corrupt);
    corrupt.snapshotHash = nhlPregameSnapshotHash(corrupt); corrupt.snapshotId = `nhl-pregame-${corrupt.snapshotHash.slice(0, 24)}`;
    assert.equal(validateNhlAnalysisObservation(corrupt, game.gameId, { now: nowValue }).ok, false);
  }
  await assert.rejects(analyzeNhlPregame(request, { ...adapters,
    loadObservations: async () => [{ ...frozen, snapshotHash: '0'.repeat(64) }] }), { code: 'NHL_SNAPSHOT_CORRUPTED' });
});

await test('PostgreSQL JSONB object key ordering cannot corrupt an otherwise identical saved forecast', async () => {
  const reorder = value => value && typeof value === 'object' ? Array.isArray(value) ? value.map(reorder)
    : Object.fromEntries(Object.keys(value).reverse().map(key => [key, reorder(value[key])])) : value;
  const jsonb = reorder(JSON.parse(JSON.stringify(frozen)));
  assert.equal(nhlPregameSnapshotHash(jsonb), frozen.snapshotHash);
  assert.equal(validateNhlAnalysisObservation(jsonb, game.gameId, { now: nowValue }).ok, true);
  const restored = await listNhlPregameAnalyses(request.date, { ...adapters, loadDate: async () => [jsonb] });
  assert.equal(restored.analyses[0].mode, 'SAVED_PREGAME_REPLAY');
});

await test('failed current official source can replay durable evidence but identity BLOCK cannot', async () => {
  const replay = await analyzeNhlPregame(request, { ...adapters, fetchGame: async () => ({ ok: false, code: 'NHL_SOURCE_TIMEOUT' }) });
  assert.equal(replay.mode, 'SAVED_PREGAME_REPLAY'); assert.deepEqual(replay.model, frozen.model);
  await assert.rejects(analyzeNhlPregame(request, { ...adapters,
    fetchGame: async () => ({ ok: false, status: 'BLOCK', code: 'NHL_IDENTITY_INVALID' }) }), { code: 'NHL_IDENTITY_INVALID' });
});

await test('unconfigured or failed persistence stays visible and never claims a saved forecast', async () => {
  for (const dep of [{ persistenceConfigured: () => false }, { saveObservation: async () => { throw new Error('write failed'); } }]) {
    const result = await analyzeNhlPregame({ ...request, force: true }, { ...adapters, ...dep, loadObservations: async () => [] });
    assert.equal(result.model.version, frozen.model.version); assert.equal(result.persistence.persisted, false);
    assert.ok(result.persistence.reason); assert.equal(result.qa.status, 'WARNING');
  }
});

await test('actual Reader team and timestamp must uniquely agree with the official dated game', async () => {
  const awayRaw = 'NSH Nashville Predators'; const homeRaw = 'TBL Tampa Bay Lightning[主]';
  const rawRows = [{ sourceRowId: `NHL:${request.date}:08:00:NSH:TBL:total`, eventLabel: `${awayRaw} @ ${homeRaw}`,
    marketLabel: '大小盤', lineText: '6 - 50 大 0.970 | 小 0.910', settlementRuleText: null }];
  const validated = validateNhlCapture({ league: 'NHL', provider: 'TAI888_READER', interfaceVersion: NHL_READER_INTERFACE_VERSION,
    pageUrl: 'https://www1.tai888.in/newapp/', readerVersion: '2.1.31', pageLeagueLabel: '聯盟：NHL 國家冰球聯盟(1)',
    boardDate: request.date, observedAt: evidence.asOf, rawRows,
    games: [{ league: 'NHL', boardDate: request.date, boardTime: '08:00', awayTeamId: 18, homeTeamId: 14,
      awayAbbrev: 'NSH', homeAbbrev: 'TBL', awayRaw, homeRaw, teamEvidence: [awayRaw, homeRaw], rawRows,
      rawMarketEvidence: [{ key: 'total', label: '大小盤', rawRows: ['6 - 50 大 0.970', '小 0.910'] }], executable: false }] }, { now: nowValue });
  assert.equal(validated.ok, true, JSON.stringify(validated.errors));
  const captured = validated.payload;
  const run = async capture => analyzeNhlPregame({ ...request, force: true }, { ...adapters,
    loadObservations: async kind => kind === 'READER' ? [capture] : [],
    fetchSchedule: async () => ({ ok: true, games: [game] }),
  });
  const matched = await run(captured);
  assert.equal(matched.market.status, 'CAPTURED_UNVERIFIED'); assert.equal(matched.market.robustEV, null);
  const wrongTime = structuredClone(captured); wrongTime.games[0].boardTime = '09:00';
  assert.equal((await run(wrongTime)).market.status, 'WAITING_REAL_DATA');
  const wrongIdentity = structuredClone(captured); wrongIdentity.games[0].homeTeamId = 10;
  assert.equal((await run(wrongIdentity)).market.status, 'WAITING_REAL_DATA');
  const corrupt = structuredClone(captured); corrupt.games[0].rawRows[0].lineText = '6+10';
  assert.equal((await run(corrupt)).market.status, 'WAITING_REAL_DATA');
});

await test('date recovery validates before returning a durable replay and strips raw archives', async () => {
  const restored = await listNhlPregameAnalyses(request.date, { ...adapters, loadDate: async () => [frozen] });
  assert.equal(restored.analyses.length, 1); assert.equal(restored.analyses[0].mode, 'SAVED_PREGAME_REPLAY');
  assert.equal(restored.analyses[0].distributionArchive, undefined); assert.equal(restored.persistence.persisted, true);
  await assert.rejects(listNhlPregameAnalyses('2026-02-30', adapters), { code: 'NHL_INVALID_ANALYSIS_DATE' });
  await assert.rejects(listNhlPregameAnalyses('2026-10-15', { ...adapters, loadDate: async () => [frozen] }), { code: 'NHL_SNAPSHOT_CORRUPTED' });
});

await test('immutable historical fitting is coalesced and injected artifacts never seed the live cache', async () => {
  let fitCalls = 0;
  const fitter = (...args) => { fitCalls++; return fitNhlModel(...args); };
  const [one, two] = await Promise.all([1, 2].map(() => fittedNhlPregameArtifact(history, 2, evidence.asOf, { fit: fitter })));
  assert.equal(one.artifactId, two.artifactId); assert.equal(fitCalls, 1);
  const fakeFitter = () => ({ artifactId: 'test-only-fake' });
  assert.equal((await fittedNhlPregameArtifact(history, 2, evidence.asOf, { fit: fakeFitter })).artifactId, 'test-only-fake');
  assert.notEqual((await fittedNhlPregameArtifact(history, 2, evidence.asOf)).artifactId, 'test-only-fake');
  await assert.rejects(fittedNhlPregameArtifact(history, 3, evidence.asOf), { code: 'NHL_PREGAME_PHASE_HISTORY_MISSING' });
  await assert.rejects(fittedNhlPregameArtifact(history, 2, '2026-08-01T00:00:00Z'), { code: 'NHL_PREGAME_HISTORY_NOT_YET_AVAILABLE' });
});

await test('compaction round trips complete linked paths with unchanged score probabilities', async () => {
  const artifact = await fittedNhlPregameArtifact(history, 2, evidence.asOf);
  const original = predictNhlDistribution(artifact, game, { asOf: evidence.asOf });
  const { archive, distribution } = archiveNhlPregameDistribution(original);
  const restored = restoreNhlPregameDistribution(archive);
  assert.deepEqual(restored.scenarios, original.scenarios);
  assert.deepEqual(restored.features, original.features);
  assert.equal(auditNhlDistribution(restored).passed, true); assert.deepEqual(restored, distribution);
  assert.equal(validNhlPregameRequest({ ...request, league: 'NBA' }), false);
  assert.equal(validNhlPregameRequest({ ...request, force: 'true' }), false);
});
console.log(`NHL pregame service: ${passes} groups PASS`);
