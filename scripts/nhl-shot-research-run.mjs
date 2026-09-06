// Bounded official PBP acquisition + reproducible non-wagering shot research.
// Existing verified responses are reused. 403/429 stop acquisition; no mirror,
// credential extraction, fabricated response, or licensed-provider scraping.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchNhlJson } from '../lib/nhl/data.js';
import { validateNhlIdentity } from '../lib/nhl/identity.js';
import { readNhlShotCheckpoint } from '../lib/nhl/shot-research-archive.js';
import { extractNhlShotResearch, chronologicalNhlShotValidation, freezeNhlShotResearchArtifacts, NHL_SHOT_RESEARCH_VERSION } from '../lib/nhl/shot-research.js';

const args = process.argv.slice(2);
async function saveAtomic(destination, contents) {
  const temporary = `${destination}.tmp-${process.pid}`;
  await fs.writeFile(temporary, contents); await fs.rename(temporary, destination);
}
if (args.includes('--help')) {
  console.log('node scripts/nhl-shot-research-run.mjs [--fetch] [--ids 2023020002,... | --manifest /absolute/outcomes.json] [--concurrency 1|2] [--acquire-only] [--out /absolute/directory]\nDefault offline mode never fetches. Official reads are bounded to at most two workers, existing valid checkpoints first, and stop on 403/429. Report is retrospective conditional-on-observed-shots research, not pregame calibration.');
  process.exit(0);
}
const values = new Set(['--ids', '--out', '--manifest', '--concurrency', '--holdout-block-games', '--initial-training-games', '--pace-ms']); const used = new Set();
for (let i = 0; i < args.length; i += 1) {
  const key = args[i];
  if (used.has(key) || !['--fetch', '--acquire-only'].includes(key) && !values.has(key) || values.has(key) && (!args[i + 1] || args[i + 1].startsWith('--'))) throw new Error(`Invalid argument: ${key}`);
  used.add(key); if (values.has(key)) i += 1;
}
const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = option('--out', path.join(root, 'scripts/fixtures/nhl/xg-research'));
const manifestPath = option('--manifest', null);
if (manifestPath && (!path.isAbsolute(manifestPath) || used.has('--ids'))) throw new Error('Use an absolute manifest path or explicit IDs, not both');
const manifestGames = manifestPath ? JSON.parse(await fs.readFile(manifestPath, 'utf8')).filter(game => game.gameType === 2) : null;
if (manifestGames && (manifestGames.some(game => !validateNhlIdentity(game).ok) || new Set(manifestGames.map(game => game.gameId)).size !== manifestGames.length)) throw new Error('Manifest game identities must be unique and verified NHL identities');
const expectedGames = new Map((manifestGames || []).map(game => [String(game.gameId), game]));
const ids = [...new Set(manifestGames ? manifestGames.map(game => String(game.gameId)) : option('--ids', '2023020001,2023020002,2023020003,2023020030,2023020069,2023020204').split(','))];
let officialCoverage = null;
try { if (manifestPath) officialCoverage = JSON.parse(await fs.readFile(path.join(path.dirname(manifestPath), 'coverage.json'), 'utf8')); } catch { /* No independent coverage certificate; never infer full league coverage from a list size. */ }
const concurrency = Number(option('--concurrency', '1'));
if (![1, 2].includes(concurrency)) throw new Error('Concurrency must be1 or2');
const paceMs = Number(option('--pace-ms', '2000'));
if (!Number.isSafeInteger(paceMs) || paceMs < 2000) throw new Error('Official request-start pacing must be at least2000ms');
const holdoutBlockGames = Number(option('--holdout-block-games', '1'));
const initialTrainingGames = Number(option('--initial-training-games', '3'));
if (!Number.isSafeInteger(holdoutBlockGames) || holdoutBlockGames < 1 || !Number.isSafeInteger(initialTrainingGames) || initialTrainingGames < 2) throw new Error('Invalid chronological-block configuration');
if (!path.isAbsolute(output) || ids.some(id => !/^\d{4}02\d{4}$/.test(id))) throw new Error('Absolute output and regular-season NHL game IDs required');
await fs.mkdir(output, { recursive: true });
const attempts = []; const datasets = []; const acquired = []; const startedAt = new Date().toISOString();
let previousAcquisition = null;
try { previousAcquisition = JSON.parse(await fs.readFile(path.join(output, 'acquisition-manifest.json'), 'utf8')); } catch { /* New acquisition. */ }
if (args.includes('--fetch') && previousAcquisition?.providerStopped) {
  const failed = previousAcquisition.attempts?.filter(row => !row.ok) || [];
  if (failed.some(row => row.code === 'NHL_SOURCE_FORBIDDEN' || row.httpStatus === 401)) throw new Error('Official authorization failure must be resolved before resumption');
  const limited = failed.findLast(row => row.code === 'NHL_SOURCE_RATE_LIMITED');
  const retryAt = Date.parse(limited?.retryAt || '') || Date.parse(limited?.source?.fetchedAt || '') + 15 * 60_000;
  if (Number.isFinite(retryAt) && Date.now() < retryAt) throw new Error(`Official rate-limit cooldown remains active until ${new Date(retryAt).toISOString()}`);
}
// Preserve only public rate-limit headers. Never record authorization/cookies.
const rateHeaders = new Map(); let nextRequestStart = 0; let pacing = Promise.resolve();
const pacedFetch = async (url, options) => {
  let release; const previous = pacing; pacing = new Promise(resolve => { release = resolve; });
  await previous;
  const delay = Math.max(0, nextRequestStart - Date.now());
  if (delay) await new Promise(resolve => setTimeout(resolve, delay));
  nextRequestStart = Date.now() + paceMs; release();
  const response = await fetch(url, options);
  if (response.status === 429) {
    const observedAt = new Date().toISOString(); const retryAfter = response.headers.get('retry-after');
    const seconds = /^\d+$/.test(retryAfter || '') ? Number(retryAfter) : null;
    const retryMs = seconds !== null ? Date.now() + seconds * 1000 : Date.parse(retryAfter || '');
    rateHeaders.set(url, { retryAfter: retryAfter || null, rateLimitObservedAt: observedAt,
      retryAt: Number.isFinite(retryMs) ? new Date(retryMs).toISOString() : new Date(Date.now() + 15 * 60_000).toISOString(),
      retryPolicy: Number.isFinite(retryMs) ? 'OFFICIAL_RETRY_AFTER' : 'CONSERVATIVE_15_MINUTE_BACKOFF_HEADER_ABSENT' });
  }
  return response;
};
const base = path.join(root, 'scripts/fixtures/nhl');
const provenance = JSON.parse(await fs.readFile(path.join(base, 'observed-report-provenance.json'), 'utf8'));
const firstSource = provenance.files.find(row => row.file === 'pbp-2023020001.json');
const first = extractNhlShotResearch(JSON.parse(await fs.readFile(path.join(base, firstSource.file), 'utf8')), {
  source: { provider: 'NHL', url: firstSource.url, fetchedAt: firstSource.fetchedAt, contentHash: firstSource.contentHash },
  expectedGame: expectedGames.get('2023020001') || null,
});
if (!first.ok) throw new Error(`Existing first PBP failed: ${first.code}`);
if (ids.includes(first.game.gameId)) datasets.push(first);
const seedCount = datasets.length;
let cursor = 0; let providerStopped = false; const queue = ids.filter(id => !seedCount || id !== first.game.gameId);
let checkpointWrites = Promise.resolve();
const progress = () => ({ leagueId: 'NHL', startedAt, updatedAt: new Date().toISOString(), requestedGames: ids.length,
  retainedResponses: acquired.length + seedCount, eligibleGames: datasets.length, providerStopped, paceMs, concurrency,
  previousStoppedRun: previousAcquisition?.providerStopped ? { startedAt: previousAcquisition.startedAt, updatedAt: previousAcquisition.updatedAt,
    failures: previousAcquisition.attempts.filter(row => !row.ok) } : null, acquired, attempts });
async function readGame(gameId) {
  const destination = path.join(output, `pbp-${gameId}.json`); let response = null; let data = null;
  try {
    response = readNhlShotCheckpoint(gameId, { directory: output });
    data = extractNhlShotResearch(response.data, { source: response.source, expectedGame: expectedGames.get(gameId) || { gameId } });
    if (data?.code === 'NHL_SHOT_SOURCE_UNVERIFIED') {
      attempts.push({ gameId, ok: false, code: 'CORRUPT_CHECKPOINT_SOURCE_HASH', repairedByNetworkAllowed: args.includes('--fetch') });
      response = null;
    }
    if (response?.ok !== true || !response?.data || !response?.source || String(response.data.id) !== gameId
      || response.source.url !== `https://api-web.nhle.com/v1/gamecenter/${gameId}/play-by-play`) response = null;
  } catch { response = null; }
  if (!response && args.includes('--fetch')) {
    response = await fetchNhlJson(`https://api-web.nhle.com/v1/gamecenter/${gameId}/play-by-play`, { timeoutMs: 20_000, retry: false, fetchImpl: pacedFetch });
    attempts.push({ gameId, ok: response.ok, code: response.code || null, httpStatus: response.httpStatus || null,
      source: response.source, ...(rateHeaders.get(response.source?.url) || {}) });
    if (!response.ok) {
      if (['NHL_SOURCE_FORBIDDEN', 'NHL_SOURCE_RATE_LIMITED'].includes(response.code) || response.httpStatus === 401) providerStopped = true;
      return;
    }
    data = extractNhlShotResearch(response.data, { source: response.source, expectedGame: expectedGames.get(gameId) || { gameId } });
    await saveAtomic(destination, `${JSON.stringify(response)}\n`);
  }
  if (!response) { attempts.push({ gameId, ok: false, code: 'OFFLINE_CHECKPOINT_UNAVAILABLE' }); return; }
  acquired.push({ gameId, source: response.source, qaStatus: data?.status, rows: data?.rows?.length || 0, code: data?.code || null });
  if (!data?.ok) { attempts.push({ gameId, ok: false, code: data?.code || 'NHL_SHOT_QA_FAILED' }); return; }
  for (const attempt of attempts.filter(row => row.gameId === gameId && row.code === 'CORRUPT_CHECKPOINT_SOURCE_HASH')) {
    attempt.recovered = true; attempt.replacementSourceHash = response.source.contentHash;
  }
  datasets.push(data);
}
async function worker() {
  while (!providerStopped && cursor < queue.length) {
    const gameId = queue[cursor++]; await readGame(gameId);
    if (acquired.length && acquired.length % 25 === 0 || providerStopped) {
      console.log(JSON.stringify({ step: 'official-pbp-progress', acquired: acquired.length + seedCount, eligible: datasets.length, requested: ids.length,
        elapsedSeconds: (Date.now() - Date.parse(startedAt)) / 1000, providerStopped, lastGameId: gameId }));
      if (args.includes('--fetch')) checkpointWrites = checkpointWrites.then(() => saveAtomic(path.join(output, 'acquisition-manifest.json'), `${JSON.stringify(progress(), null, 2)}\n`));
      await checkpointWrites;
    }
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));
await checkpointWrites;
if (args.includes('--fetch')) await saveAtomic(path.join(output, 'acquisition-manifest.json'), `${JSON.stringify(progress(), null, 2)}\n`);
if (args.includes('--acquire-only')) {
  console.log(JSON.stringify({ step: 'acquisition-complete', requested: ids.length, acquired: acquired.length + seedCount, eligible: datasets.length, providerStopped,
    failures: attempts.filter(row => !row.ok) }, null, 2));
  if (providerStopped || datasets.length !== ids.length) process.exitCode = 1;
  process.exit();
}
const reports = Object.fromEntries(['5V5', 'PP', 'PK', 'OTHER_EVEN_STRENGTH'].map(strength => [strength, chronologicalNhlShotValidation(datasets, { strength, holdoutBlockGames, initialTrainingGames })]));
let acquisition = null;
try { acquisition = JSON.parse(await fs.readFile(path.join(output, 'acquisition-manifest.json'), 'utf8')); } catch { /* No acquisition has been run. */ }
const fullSeason = Boolean(manifestGames && officialCoverage?.completeOfficialRecordedRegularSeasonCoverage === true
  && officialCoverage.requestedRegularGames === ids.length && officialCoverage.acquiredRegularOutcomes === ids.length
  && manifestGames.every(game => game.season === officialCoverage.season) && datasets.length === ids.length);
const report = { leagueId: 'NHL', version: NHL_SHOT_RESEARCH_VERSION, generatedAt: new Date().toISOString(), requestedGameIds: ids,
  acquiredGames: datasets.length, completeRequestedCoverage: datasets.length === ids.length,
  retainedOfficialResponses: acquired.length + seedCount, qaEligibleGames: datasets.length,
  completeRequestedSourceCoverage: acquired.length + seedCount === ids.length,
  completeSeasonCoverage: fullSeason, productionCalibrated: false, pregamePointInTime: false,
  acquisition: acquisition ? { startedAt: acquisition.startedAt, updatedAt: acquisition.updatedAt, providerStopped: acquisition.providerStopped,
    requestedGames: acquisition.requestedGames, retainedResponses: acquisition.retainedResponses, failures: acquisition.attempts.filter(row => !row.ok) } : null,
  attempts: attempts.filter(row => row.code !== 'OFFLINE_CHECKPOINT_UNAVAILABLE'), unavailableCheckpointCount: attempts.filter(row => row.code === 'OFFLINE_CHECKPOINT_UNAVAILABLE').length,
  sources: datasets.map(row => row.source), coverage: datasets.map(row => ({ game: row.game, rows: row.rows.length, rowHash: row.rowHash,
    strengths: Object.fromEntries([...new Set(row.rows.map(shot => shot.strength))].map(strength => [strength, row.rows.filter(shot => shot.strength === strength).length])), exclusions: row.exclusions, warnings: row.warnings })), reports };
await saveAtomic(path.join(output, 'research-report.json'), `${JSON.stringify(report, null, 2)}\n`);
const latestStart = Math.max(...datasets.map(dataset => Date.parse(dataset.game.startTimeUTC)));
const artifacts = freezeNhlShotResearchArtifacts(datasets, { asOf: new Date(latestStart + 48 * 3600_000 + 1).toISOString(),
  generatedAt: report.generatedAt, completeSeasonCoverage: report.completeSeasonCoverage });
await saveAtomic(path.join(output, 'frozen-artifacts.json'), `${JSON.stringify(artifacts, null, 2)}\n`);
console.log(JSON.stringify({ output, acquiredGames: datasets.length, completeRequestedCoverage: report.completeRequestedCoverage,
  reports: Object.fromEntries(Object.entries(reports).map(([key, value]) => [key, { folds: value.foldCount, shots: value.evaluatedShots, brier: value.brier, logLoss: value.logLoss, baselineBrier: value.baselineBrier }])) }, null, 2));
if (!report.completeRequestedCoverage || attempts.some(row => !row.ok && row.recovered !== true)) process.exitCode = 1;
