import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { normalizeStatsBombMatchXg, fitMatchXgResearch, matchXgHash, MATCH_XG_VERSION } from '../lib/soccer/match-xg.js';

// Reviewed, fixed provider snapshot. No moving default branch is accepted.
const COMMIT = '4b73468fc5b0f1950f9f66fada70ad3a4f9327cb';
const args = process.argv.slice(2), root = path.resolve('research/soccer/match-xg');
const cacheDir = args.includes('--cache') ? path.resolve(args[args.indexOf('--cache') + 1]) : path.resolve('/workspace/scratch/statsbomb-epl-events');
const base = `https://raw.githubusercontent.com/statsbomb/open-data/${COMMIT}/data`;
const observationArchive = path.join(cacheDir, 'normalized-shots.json.gz');
const hash = text => createHash('sha256').update(text).digest('hex');
const document = (text, url, fetchedAt) => ({ text, source: { provider: 'STATSBOMB_OPEN_DATA', url, fetchedAt, contentHash: hash(text),
  representation: 'DECODED_UTF8_HTTP_RESPONSE', timing: 'LOCAL_FETCH_COMPLETION_NOT_HISTORICAL_PUBLICATION' } });
fs.mkdirSync(root, { recursive: true });
let observations, collection;
if (args.includes('--replay')) {
  const archived = JSON.parse(gunzipSync(fs.readFileSync(observationArchive)));
  observations = archived.observations; collection = archived.collection;
} else {
  const indexPath = path.join(cacheDir, 'matches-2-27.json');
  fs.mkdirSync(cacheDir, { recursive: true });
  async function fetchText(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(25000) });
    if (!response.ok) throw Error(`MATCH_XG_SOURCE_HTTP_${response.status}`);
    const length = Number(response.headers.get('content-length'));
    if (length > 8 * 1024 * 1024) throw Error('MATCH_XG_SOURCE_BYTE_BUDGET');
    const text = await response.text(); if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw Error('MATCH_XG_SOURCE_BYTE_BUDGET');
    JSON.parse(text); return text;
  }
  if (!fs.existsSync(indexPath)) fs.writeFileSync(indexPath, await fetchText(`${base}/matches/2/27.json`));
  const indexText = fs.readFileSync(indexPath, 'utf8'), matches = JSON.parse(indexText);
  if (!Array.isArray(matches) || matches.length !== 380 || matches.some(match => match.competition?.competition_id !== 2 || match.season?.season_id !== 27)) throw Error('MATCH_XG_SOURCE_COHORT_SCOPE_CHANGED');
  const missing = matches.filter(match => !fs.existsSync(path.join(cacheDir, `${match.match_id}.json.gz`)));
  if (missing.length && !args.includes('--fetch')) throw Error(`MATCH_XG_RAW_CACHE_INCOMPLETE_${missing.length}_RUN_WITH_FETCH`);
  let next = 0;
  if (missing.length) await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < missing.length) { const match = missing[next++], text = await fetchText(`${base}/events/${match.match_id}.json`);
      fs.writeFileSync(path.join(cacheDir, `${match.match_id}.json.gz`), gzipSync(text, { level: 1, mtime: 0 })); }
  }));
  observations = []; const excluded = [];
  const indexDocument = document(indexText, `${base}/matches/2/27.json`, fs.statSync(indexPath).mtime.toISOString());
  for (const match of matches) {
    const file = path.join(cacheDir, `${match.match_id}.json.gz`), text = gunzipSync(fs.readFileSync(file)).toString('utf8');
    const result = normalizeStatsBombMatchXg({ matchId: match.match_id, matchesDocument: indexDocument,
      eventsDocument: document(text, `${base}/events/${match.match_id}.json`, fs.statSync(file).mtime.toISOString()) });
    if (result.ok) observations.push(result); else excluded.push({ matchId: match.match_id, reason: result.code });
  }
  collection = { provider: 'STATSBOMB_OPEN_DATA', sourceCommit: COMMIT, competition: 'Premier League', season: '2015/2016',
    availableIndexGames: matches.length, attemptedGames: matches.length, extractedGames: observations.length,
    excludedGames: excluded.length, excludedReasons: excluded.reduce((counts, row) => { counts[row.reason] = (counts[row.reason] || 0) + 1; return counts; }, {}),
    fullIndexCohortAttempted: true, currentSeasonCoverage: false, uclCoverage: false,
    originalEventDocumentsRetained: false, pinnedSourceDocumentsReproducible: true,
    localRawCacheExcludedFromRepository: true, attribution: 'StatsBomb Open Data',
    sourceUrl: 'https://github.com/statsbomb/open-data', licenseUrl: `https://github.com/statsbomb/open-data/blob/${COMMIT}/LICENSE.pdf`,
    accessScope: 'PUBLIC_OPEN_DATA_RESEARCH_NOT_CURRENT_OPTA_ACCOUNT_DATA' };
  fs.writeFileSync(observationArchive, gzipSync(JSON.stringify({ version: MATCH_XG_VERSION, collection, observations }), { level: 9, mtime: 0 }));
}
if (!observations.length || observations.some(row => row.league !== 'epl')) throw Error('MATCH_XG_COHORT_EMPTY_OR_WRONG_LEAGUE');
const privateReports = { epl: Object.fromEntries(['FT', 'HT'].map(period => [period, fitMatchXgResearch(observations, { period })])) };
fs.writeFileSync(path.join(cacheDir, 'private-research-models.json'), JSON.stringify(privateReports));
// Source rows, provider/team statistics, fitted coefficients and per-game hashes
// are intentionally excluded from the public repository and runtime artifact.
const reports = { epl: Object.fromEntries(['FT', 'HT'].map(period => {
  const { model, contentHash, ...aggregate } = privateReports.epl[period];
  return [period, { ...aggregate, contentHash: matchXgHash(aggregate) }];
})) };
const existingReport = args.includes('--replay') && fs.existsSync(path.join(root, 'research-report.json')) ? JSON.parse(fs.readFileSync(path.join(root, 'research-report.json'))) : null;
const result = { createdAt: existingReport?.createdAt || new Date().toISOString(), version: MATCH_XG_VERSION, status: 'RETROSPECTIVE_RESEARCH_AVAILABLE', provider: 'STATSBOMB_OPEN_DATA',
  collection, normalizedObservationArchiveSha256: hash(fs.readFileSync(observationArchive)), reports,
  historicalAvailabilityVerified: false, independentUntouchedTestVerified: false,
  accepted: false, formalEligible: false, modelEffectApplied: false, executable: false, W: null, R: null, S: null,
  limitations: ['Provider xG is reconstructed from actual regulation-time shots; npxG excludes explicit penalties only.',
    'StatsBomb shot values are not Opta values. The two providers are not merged.',
    '2015/16 EPL open data is an older research cohort, not complete current-season or UCL coverage.',
    'Source files were fetched retrospectively; match dates do not prove historical source availability.',
    'The fixed chronological diagnostic is not an untouched independently accepted test, profitability validation or formal W/R/S.',
    'The regression target is observed non-penalty xG, not future goals, injury effects, penalty frequency, or a complete score distribution.',
    'StatsBomb user agreement restricts commercial use and redistribution of source data; only aggregate research conclusions are published here with attribution.'] };
result.contentHash = matchXgHash(result);
fs.writeFileSync(path.join(root, 'research-report.json'), JSON.stringify(result, null, 2) + '\n');
fs.writeFileSync('lib/soccer/match-xg-frozen.js', `// Generated by soccer-match-xg-build.mjs from pinned, retrospective StatsBomb open data.\nconst data=${JSON.stringify(result)};\nexport function soccerMatchXgArtifacts(){return structuredClone(data);}\n`);
console.log(JSON.stringify({ collection, reports: Object.fromEntries(['FT', 'HT'].map(period => [period, { training: reports.epl[period].training, calibration: reports.epl[period].calibration, test: reports.epl[period].test }])) }, null, 2));
