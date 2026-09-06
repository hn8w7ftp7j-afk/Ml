import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NHL_HISTORICAL_SAMPLES } from '../lib/nhl/historical-samples.js';
import { normalizeNhlHistoricalOutcome, buildNhlHistoricalCoverage, nhlHistoryHash, verifyNhlHistorySource,
  validateNhlHistoricalOutcomes, validateNhlHistoricalModelBlocks, NHL_HISTORY_EMBARGO_MS, nhlPeriodReportUrl, joinNhlOfficialPeriodReports,
  mergeNhlHistoricalPeriodSources, loadBundledNhlHistoryValidation, verifyNhlBundledHistoricalReports, hasCompleteNhlPeriodCoverage } from '../lib/nhl/history-validation.js';
import { parseNhlHistoryRunnerArgs, teamsFromNhlStandings, runNhlHistoryValidation } from './nhl-history-validation-runner.mjs';
import { NHL_HISTORY_ARCHIVABLE_SOURCE, readNhlHistoryCheckpoint, decodeNhlSourceArchiveChunk,
  verifyNhlHistoryCheckpoint } from '../lib/nhl/history-source-archive.js';
import { createHash } from 'node:crypto';

let count = 0;
const test = async (name, callback) => { await callback(); count += 1; console.log(`PASS ${name}`); };
const raw = JSON.parse(await fs.readFile(new URL('./fixtures/nhl/landing-2023020001.json', import.meta.url), 'utf8'));
const rawFromSample = row => ({ id: Number(row.gameId), season: row.season, gameType: row.gameType,
  startTimeUTC: row.startTimeUTC, gameDate: row.officialDate, gameState: 'OFF', gameScheduleState: 'OK',
  gameOutcome: { lastPeriodType: row.outcomeType }, awayTeam: { id: row.awayTeamId, abbrev: row.awayAbbrev, score: row.final.awayGoals },
  homeTeam: { id: row.homeTeamId, abbrev: row.homeAbbrev, score: row.final.homeGoals } });
const officialSource = NHL_HISTORICAL_SAMPLES[0].source;
const readBundledHistoryFile = async name => NHL_HISTORY_ARCHIVABLE_SOURCE.test(name)
  ? readNhlHistoryCheckpoint(name, { directory: path.resolve('scripts/fixtures/nhl/history-expanded') })
  : JSON.parse(await fs.readFile(new URL(`./fixtures/nhl/history-expanded/${name}`, import.meta.url), 'utf8'));
const checkpoint = (team, games = [raw]) => {
  const data = { games };
  return { team, ok: true, data, source: { provider: 'NHL', url: `https://api-web.nhle.com/v1/club-schedule-season/${team}/20232024`,
    fetchedAt: '2026-09-06T00:00:00Z', contentHash: nhlHistoryHash(data) } };
};
const expectedTeams = [{ teamId: 18, abbrev: 'NSH', gamesPlayed: 1 }, { teamId: 14, abbrev: 'TBL', gamesPlayed: 1 }];
const outcomes = NHL_HISTORICAL_SAMPLES.map(row => normalizeNhlHistoricalOutcome(rawFromSample(row), row.source));

await test('REG/OT/SO score outcomes are observed, not invented regulation periods', () => {
  assert.equal(outcomes.length, NHL_HISTORICAL_SAMPLES.length);
  for (let i = 0; i < outcomes.length; i += 1) {
    assert.deepEqual(outcomes[i].regulation, NHL_HISTORICAL_SAMPLES[i].regulation);
    assert.equal(outcomes[i].periods, null);
    assert.equal(outcomes[i].outcomeAvailableAt, null);
    assert.equal(outcomes[i].pregamePointInTimeVerified, false);
  }
});
await test('missing, tied, extra-time-invalid scores block rather than becoming zero', () => {
  for (const patch of [
    { awayTeam: { ...raw.awayTeam, score: null } },
    { homeTeam: { ...raw.homeTeam, score: raw.awayTeam.score } },
    { gameOutcome: { lastPeriodType: 'OT' }, periodDescriptor: { periodType: 'OT' } },
  ]) assert.throws(() => normalizeNhlHistoricalOutcome({ ...raw, ...patch }, officialSource));
  assert.equal(normalizeNhlHistoricalOutcome({ ...raw, gameState: 'FUT' }, officialSource), null);
});
await test('source hashes bind checkpoints and reject payload mutation', () => {
  const row = checkpoint('NSH'); assert.equal(verifyNhlHistorySource(row, row.source.url), true);
  row.data.games[0] = { ...row.data.games[0], gameState: 'FUT' };
  assert.equal(verifyNhlHistorySource(row, row.source.url), false);
  delete row.data; assert.equal(verifyNhlHistorySource(row, row.source.url), false);
});
await test('both club schedules corroborate one unique game and exact official team totals', () => {
  const result = buildNhlHistoricalCoverage({ season: 20232024, expectedTeams, schedules: [checkpoint('NSH'), checkpoint('TBL')] });
  assert.equal(result.outcomes.length, 1);
  assert.equal(result.manifest.completeOfficialRecordedRegularSeasonCoverage, true);
  assert.equal(result.outcomes[0].corroboratingScheduleUrls.length, 2);
  assert.equal(result.manifest.productionModelCalibrated, false);
});
await test('missing team schedules cannot masquerade as complete season', () => {
  const result = buildNhlHistoricalCoverage({ season: 20232024, expectedTeams, schedules: [checkpoint('NSH')] });
  assert.equal(result.manifest.completeOfficialRecordedRegularSeasonCoverage, false);
  assert.deepEqual(result.manifest.missingTeams, ['TBL']);
});
await test('duplicate official identity or score conflicts quarantine the whole game', () => {
  const other = { ...raw, homeTeam: { ...raw.homeTeam, score: raw.homeTeam.score + 1 } };
  const result = buildNhlHistoricalCoverage({ season: 20232024, expectedTeams, schedules: [checkpoint('NSH'), checkpoint('TBL', [other])] });
  assert.equal(result.outcomes.length, 0);
  assert.equal(result.manifest.completeOfficialRecordedRegularSeasonCoverage, false);
  assert.ok(result.manifest.invalid.some(row => row.code === 'NHL_HISTORY_DUPLICATE_CONFLICT'));
});
await test('all walk-forward folds and fixed holdouts exclude target and obey 48-hour embargo', () => {
  const report = validateNhlHistoricalOutcomes(outcomes, { initialTrainingGames: 3 });
  const byId = new Map(outcomes.map(row => [row.gameId, row]));
  assert.ok(report.walkForward.folds > 0);
  for (const fold of report.walkForward.evidence) {
    const prior = outcomes.filter(row => row.gameType === 2 && Date.parse(row.startTimeUTC) + NHL_HISTORY_EMBARGO_MS <= Date.parse(fold.asOf));
    assert.equal(fold.trainingGames, prior.length);
    assert.equal(fold.trainingGameIdsHash, nhlHistoryHash(prior.map(row => row.gameId)));
    assert.ok(!prior.some(row => row.gameId === fold.targetGameId));
    assert.ok(Math.abs(fold.mass - 1) < 1e-10);
  }
  for (const target of [...report.fixedHoldout.validation.evidence, ...report.fixedHoldout.untouchedTest.evidence]) {
    for (const id of report.fixedHoldout.trainingGameIds) assert.ok(Date.parse(byId.get(id).startTimeUTC) + NHL_HISTORY_EMBARGO_MS <= Date.parse(target.asOf));
  }
  assert.equal(report.fixedHoldout.fitOnValidationOrTest, false);
  assert.equal(report.strictPointInTimeVerified, false);
});
await test('changing a future result never changes earlier forecasts or metrics', () => {
  const original = validateNhlHistoricalOutcomes(outcomes, { initialTrainingGames: 3 });
  const poisoned = structuredClone(outcomes); poisoned.at(-1).regulation = { awayGoals: 20, homeGoals: 19 };
  poisoned.at(-1).final = { awayGoals: 20, homeGoals: 19 }; poisoned.at(-1).outcomeType = 'REG';
  const changed = validateNhlHistoricalOutcomes(poisoned, { initialTrainingGames: 3 });
  assert.deepEqual(changed.walkForward.evidence.slice(0, -1), original.walkForward.evidence.slice(0, -1));
});
await test('preseason and playoffs cannot train regular-season score benchmark', () => {
  const preseason = structuredClone(outcomes[0]);
  preseason.gameId = '2023010001'; preseason.gameType = 1; preseason.seasonPhase = 'PRESEASON_SHADOW';
  const original = validateNhlHistoricalOutcomes(outcomes, { initialTrainingGames: 3 });
  const mixed = validateNhlHistoricalOutcomes([...outcomes, preseason], { initialTrainingGames: 3 });
  assert.deepEqual(mixed.walkForward, original.walkForward); assert.equal(mixed.preseasonExcluded, 1);
  assert.throws(() => validateNhlHistoricalOutcomes(outcomes, { gameType: 1 }));
});
await test('existing model block validation preserves formula and explicit retrospective evidence', () => {
  const result = validateNhlHistoricalModelBlocks(NHL_HISTORICAL_SAMPLES, { initialTrainingGames: 12, blockGames: 20 });
  assert.ok(result.folds > 0); assert.ok(result.blocks.length > 0);
  const byId = new Map(NHL_HISTORICAL_SAMPLES.map(row => [row.gameId, row]));
  for (const block of result.blocks) for (const id of block.trainingGameIds) assert.ok(Date.parse(byId.get(id).startTimeUTC) + NHL_HISTORY_EMBARGO_MS <= Date.parse(block.cutoff));
  for (const fold of result.evidence) assert.ok(Math.abs(fold.distributionMass - 1) < 1e-10);
  assert.equal(result.productionModelCalibrated, false); assert.equal(result.strictPointInTimeVerified, false);
});
await test('independent period-source conflicts quarantine a game, not overwrite its score', () => {
  const changed = structuredClone(NHL_HISTORICAL_SAMPLES[0]);
  changed.periods[0].homeGoals += 1; changed.periods[2].homeGoals -= 1;
  const result = mergeNhlHistoricalPeriodSources([[NHL_HISTORICAL_SAMPLES[0]], [changed]]);
  assert.deepEqual(result.conflictingGameIds, [changed.gameId]); assert.equal(result.games.length, 0);
  const same = mergeNhlHistoricalPeriodSources([[NHL_HISTORICAL_SAMPLES[0]], [structuredClone(NHL_HISTORICAL_SAMPLES[0])]]);
  assert.equal(same.games.length, 1); assert.equal(same.corroboratedGameIds.length, 1);
});
await test('equal period counts cannot hide missing, duplicated or out-of-scope game identities', () => {
  const wanted = NHL_HISTORICAL_SAMPLES.filter(row => row.season === 20232024);
  const merged = { games: structuredClone(wanted), conflictingGameIds: [] };
  assert.equal(hasCompleteNhlPeriodCoverage(wanted, merged, { season: 20232024 }), true);
  merged.games[0].gameId = '2023021312';
  assert.equal(hasCompleteNhlPeriodCoverage(wanted, merged, { season: 20232024 }), false);
  merged.games = structuredClone(wanted); merged.conflictingGameIds.push(wanted[0].gameId);
  assert.equal(hasCompleteNhlPeriodCoverage(wanted, merged, { season: 20232024 }), false);
});
await test('actual retained full-season coverage is reproducible from all 32 official schedule hashes', async () => {
  const read = readBundledHistoryFile;
  const saved = await read('coverage.json');
  const schedules = await Promise.all(saved.teamCoverage.map(row => read(`schedule-${row.abbrev}-${saved.season}.json`)));
  const rebuilt = buildNhlHistoricalCoverage({ season: saved.season, expectedTeams: saved.teamCoverage, schedules });
  assert.equal(rebuilt.manifest.completeOfficialRecordedRegularSeasonCoverage, true);
  assert.equal(rebuilt.manifest.acquiredRegularOutcomes, 1312);
  assert.equal(rebuilt.manifest.teamCoverage.length, 32);
  assert.equal(rebuilt.manifest.outcomeCorpusHash, saved.outcomeCorpusHash);
  assert.ok(rebuilt.manifest.teamCoverage.every(row => row.matchesOfficialRecordedGames && row.acquiredRegularOutcomes === 82));
});
await test('actual capped NHL period pages preserve 300 rows without inventing missing offsets', async () => {
  const read = readBundledHistoryFile;
  const pages = await Promise.all([0, 1000, 2000].map(start => read(`period-report-20232024-${start}.json`)));
  const sourceOutcomes = await read('outcomes.json');
  const result = joinNhlOfficialPeriodReports(sourceOutcomes, pages, { season: 20232024 });
  assert.equal(result.report.acquiredReportRows, 300); assert.equal(result.games.length, 150);
  assert.equal(result.report.fullRequestedPeriodCoverage, false); assert.equal(result.report.missingGameIds.length, 1162);
  assert.deepEqual(result.report.invalid, []);
  const changed = structuredClone(pages); changed[0].data.data[0].period1GoalsAgainst += 1;
  changed[0].source.contentHash = nhlHistoryHash(changed[0].data); // Explicit semantic counterexample, not production data.
  const rejected = joinNhlOfficialPeriodReports(sourceOutcomes, changed, { season: 20232024 });
  assert.ok(rejected.report.invalid.some(row => row.code === 'NHL_HISTORY_PERIOD_IDENTITY_OR_TOTAL_CONFLICT'));
});
await test('bundled report serves compact evidence and never marks strict PIT or model calibration complete', async () => {
  const report = await loadBundledNhlHistoryValidation();
  assert.equal(report.ok, true); assert.equal(report.coverage.acquiredRegularOutcomes, 1312);
  assert.equal(report.benchmark.walkForward.folds, 1194); assert.equal(report.benchmark.fixedHoldout.untouchedTest.folds, 260);
  assert.equal(report.strictPointInTimeVerified, false); assert.equal(report.productionModelCalibrated, false);
  assert.equal(report.benchmark.walkForward.evidence, undefined);
  assert.ok(report.coverage.batchPeriodCoverage.missingGameIds.length <= 20);
});
await test('playoff report corruption and crossed phase are rejected independently of main report hashes', async () => {
  const read = readBundledHistoryFile;
  const [coverage, benchmark, playoffs, model, sourceOutcomes, periods] = await Promise.all(['coverage.json', 'score-validation.json',
    'playoff-score-validation.json', 'model-validation.json', 'outcomes.json', 'period-games.json'].map(read));
  const bundle = { coverage, benchmark, playoffs, model, outcomes: sourceOutcomes, periods };
  assert.equal(verifyNhlBundledHistoricalReports(bundle), true);
  const poisoned = structuredClone(bundle); poisoned.playoffs.fixedHoldout.untouchedTest.regulationBrier = 999;
  assert.throws(() => verifyNhlBundledHistoricalReports(poisoned), error => error.code === 'NHL_HISTORY_BUNDLED_REPORT_HASH_CONFLICT');
  const crossed = structuredClone(bundle); crossed.playoffs.gameType = 2;
  crossed.coverage.playoffValidationHash = nhlHistoryHash(crossed.playoffs);
  assert.throws(() => verifyNhlBundledHistoricalReports(crossed), error => error.code === 'NHL_HISTORY_BUNDLED_REPORT_SCOPE_CONFLICT');
});
await test('CLI validates seasons, absolute output paths, duplicate flags, dates and game IDs', () => {
  const valid = ['--season', '20232024', '--out', '/tmp/nhl-history-test'];
  assert.equal(parseNhlHistoryRunnerArgs(valid).season, 20232024);
  assert.equal(parseNhlHistoryRunnerArgs(['--help']).help, true);
  for (const args of [valid.concat('--season', '20232024'), ['--season', '20232025', '--out', '/tmp/test'], valid.concat('--standings-date', '2024-02-30'),
    valid.concat('--pbp-games', '2024020001'), valid.concat('--teams', 'TOR,TOR'), valid.concat('--period-games', '-1')]) assert.throws(() => parseNhlHistoryRunnerArgs(args));
});
await test('provider 403 stops acquisition, is explicit, and never returns fabricated coverage', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nhl-history-block-test-'));
  let calls = 0;
  const report = await runNhlHistoryValidation({ season: 20232024, out: directory, standingsDate: '2024-04-19', timeoutMs: 1000,
    periodGames: 0, pbpGames: [], teams: ['NSH', 'TBL'] }, { fetchImpl: async () => { calls += 1; return { ok: false, status: 403 }; }, progress() {} });
  assert.equal(calls, 1); assert.equal(report.blocked, true);
  assert.equal(report.completeOfficialRecordedRegularSeasonCoverage, false);
  assert.ok(report.attempts.some(row => row.code === 'NHL_SOURCE_FORBIDDEN'));
});
await test('provider 429 Retry-After is retained and does not trigger another request', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nhl-history-rate-test-')); let calls = 0;
  const report = await runNhlHistoryValidation({ season: 20232024, out: directory, standingsDate: '2024-04-18', timeoutMs: 1000,
    periodGames: 0, pbpGames: [], teams: ['NSH', 'TBL'] }, { fetchImpl: async () => {
      calls += 1; return { ok: false, status: 429, headers: { get: key => key === 'retry-after' ? '120' : null } };
    }, progress() {} });
  assert.equal(calls, 1); assert.equal(report.blocked, true);
  const failure = report.attempts.find(row => row.httpStatus === 429);
  assert.equal(failure.retryAfter.header, '120'); assert.ok(Number.isFinite(Date.parse(failure.retryAfter.retryAfterAt)));
});
await test('all source archives round-trip with exact original checkpoint and official source hashes', async () => {
  const directory = path.resolve('scripts/fixtures/nhl/history-expanded');
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'archives/manifest.json'), 'utf8'));
  assert.equal(manifest.records.length, 123);
  for (const entry of manifest.records) {
    const restored = readNhlHistoryCheckpoint(entry.file, { directory, allowRaw: false });
    assert.equal(verifyNhlHistoryCheckpoint(restored, entry.file), true);
    assert.equal(restored.source.contentHash, entry.sourceContentHash);
    let original;
    try { original = await fs.readFile(path.join(directory, entry.file), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (original != null) {
      assert.equal(createHash('sha256').update(original).digest('hex'), entry.checkpointSha256);
      assert.deepEqual(restored, JSON.parse(original));
    }
  }
});
await test('archive tampering is rejected even after a decoded cache hit', async () => {
  const directory = path.resolve('scripts/fixtures/nhl/history-expanded');
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'archives/manifest.json'), 'utf8'));
  const chunk = manifest.chunks[0]; const text = await fs.readFile(path.join(directory, 'archives', chunk.file), 'utf8');
  assert.equal(decodeNhlSourceArchiveChunk(text, chunk).length, chunk.records);
  const corrupted = `${text[0] === 'A' ? 'B' : 'A'}${text.slice(1)}`;
  assert.throws(() => decodeNhlSourceArchiveChunk(corrupted, chunk), error => error.code === 'NHL_SOURCE_ARCHIVE_COMPRESSED_HASH_MISMATCH');
  assert.throws(() => decodeNhlSourceArchiveChunk(text, { ...chunk, payloadSha256: '0'.repeat(64) }), error => error.code === 'NHL_SOURCE_ARCHIVE_PAYLOAD_HASH_MISMATCH');
  assert.throws(() => readNhlHistoryCheckpoint('../coverage.json', { directory, allowRaw: false }), error => error.code === 'NHL_HISTORY_ARCHIVE_LOOKUP_INVALID');
  const entry = manifest.records[0]; const response = readNhlHistoryCheckpoint(entry.file, { directory, allowRaw: false });
  response.source.url = 'https://api-web.nhle.com/v1/gamecenter/2023021312/landing';
  assert.equal(verifyNhlHistoryCheckpoint(response, entry.file), false);
});
console.log(JSON.stringify({ ok: true, groups: count, source: 'OFFICIAL_RETAINED_FIXTURES_AND_EXPLICIT_COUNTEREXAMPLES', productionValidationClaimed: false }));
