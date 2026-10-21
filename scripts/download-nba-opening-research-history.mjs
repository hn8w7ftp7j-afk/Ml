import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { OPENING_ACQUISITION_VERSION, OPENING_ARCHIVE_SOURCE_ROLE, researchScheduleOracle, validatedResearchScoreboard, researchArchiveCoverage } from '../lib/nba/opening-history-acquisition.js';

const destination = process.argv[2];
if (!destination) throw Error('Supply a scratch archive directory (never a production data path)');
const option = (name, fallback) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const years = option('years', '2018,2019,2020,2021,2022').split(',').map(Number);
const concurrency = Number(option('concurrency', '8')), maxRequests = Number(option('max-requests', '1000'));
const schedulesOnly = process.argv.includes('--schedules-only');
if (new Set(years).size !== years.length || years.some(year => !Number.isInteger(year) || year < 2010 || year > 2022) || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8 || !Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 1000) throw Error('Invalid research-only scope/concurrency/request limit');
const root = path.resolve(destination), cacheRoot = path.join(root, 'sources');
await fs.mkdir(cacheRoot, { recursive: true });
const hash = text => createHash('sha256').update(text).digest('hex');
const sources = new Map();
const cachedKeys = new Set((await fs.readdir(cacheRoot)).filter(name => name.endsWith('.meta.json')).map(name => name.slice(0, -10)));
const requestLedgerPath = path.join(root, 'request-attempts.json');
let previousAttempts = 0;
try { previousAttempts = JSON.parse(await fs.readFile(requestLedgerPath, 'utf8')).attempts; } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!Number.isSafeInteger(previousAttempts) || previousAttempts < 0) throw Error('Invalid cumulative source request ledger');
let budgetUsed = Math.max(previousAttempts, cachedKeys.size), ledgerWrites = Promise.resolve();
let requests = 0, completed = 0;
async function source(url, details) {
  const key = hash(url), filename = path.join(cacheRoot, `${key}.json.gz`), metadataPath = path.join(cacheRoot, `${key}.meta.json`);
  let raw, metadata;
  try {
    metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
    raw = gunzipSync(await fs.readFile(filename)).toString('utf8');
    if (metadata.url !== url || metadata.sha256 !== hash(raw)) throw Error(`Corrupted source checkpoint ${url}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (budgetUsed >= maxRequests) throw Error(`Authorized cumulative request bound ${maxRequests} reached; resume only with an approved scope`);
    requests++; budgetUsed++;
    const attempts = budgetUsed;
    ledgerWrites = ledgerWrites.then(() => fs.writeFile(requestLedgerPath, JSON.stringify({ attempts, updatedAt: new Date().toISOString(), scopeYears: years })));
    await ledgerWrites;
    const response = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: 'error' });
    if (!response.ok) throw Error(`Source HTTP ${response.status}: ${url}`);
    raw = await response.text();
    if (raw.length > 8 * 1024 * 1024) throw Error(`Source exceeds size bound: ${url}`);
    const parsed = JSON.parse(raw);
    if (parsed.code >= 400) throw Error(`Source API error ${parsed.code}: ${url}`);
    metadata = { url, sha256: hash(raw), retrievedAt: new Date().toISOString(), bytes: Buffer.byteLength(raw), ...details, cacheFile: `sources/${key}.json.gz` };
    await fs.writeFile(`${filename}.tmp`, gzipSync(raw)); await fs.rename(`${filename}.tmp`, filename);
    await fs.writeFile(`${metadataPath}.tmp`, JSON.stringify(metadata)); await fs.rename(`${metadataPath}.tmp`, metadataPath);
    cachedKeys.add(key);
  }
  sources.set(url, metadata); completed++;
  if (completed % 20 === 0) console.log(JSON.stringify({ completedSources: completed, networkRequestsThisRun: requests, latest: details }));
  return { body: JSON.parse(raw), ...metadata };
}
async function parallel(items, fn) {
  let next = 0, error;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (!error && next < items.length) {
      const item = items[next++];
      try { await fn(item); } catch (failure) { error ??= failure; }
    }
  }));
  if (error) throw error;
}

const records = [];
await parallel(years.flatMap(year => Array.from({ length: 30 }, (_, index) => ({ year, team: index + 1 }))), async ({ year, team }) => {
  const record = await source(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${team}/schedule?season=${year}&seasontype=2`, { kind: 'team_schedule', year, team });
  records.push({ year, team, body: record.body });
});
const oracle = researchScheduleOracle(records, years);
await fs.writeFile(path.join(root, 'schedule-oracle.json'), JSON.stringify({ kind: 'NBA_RESEARCH_SCHEDULE_ORACLE', version: OPENING_ACQUISITION_VERSION, sourceRole: OPENING_ARCHIVE_SOURCE_ROLE, years, sources: [...sources.values()], expected: [...oracle.expected.values()], days: oracle.days, excluded: oracle.excluded }));
console.log(JSON.stringify({ phase: 'schedules_verified', expectedGames: oracle.expected.size, scoreboardDates: oracle.days.length, schedules: records.length, networkRequestsThisRun: requests, cumulativeRequestAttempts: budgetUsed, dateRange: [oracle.days[0], oracle.days.at(-1)], years }));
if (schedulesOnly) process.exit(0);
const neededDates = oracle.days.filter(day => !cachedKeys.has(hash(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${day.replaceAll('-', '')}&limit=1000`)));
if (budgetUsed + neededDates.length > maxRequests) throw Error(`Planned ${budgetUsed} prior + ${neededDates.length} new daily scoreboard calls exceed ${maxRequests}; schedules cached, request new scope or run approved year subset`);
const rows = new Map();
let archiveWrites = Promise.resolve();
function checkpoint() {
  archiveWrites = archiveWrites.then(async () => {
    const history = [...rows.values()].sort((a, b) => a.date.localeCompare(b.date) || a.gameId.localeCompare(b.gameId));
    const coverage = researchArchiveCoverage(oracle, history, years);
    const archive = { kind: 'NBA_OPENING_VERIFIED_REGULAR_ARCHIVE', version: OPENING_ACQUISITION_VERSION, retrievedAt: new Date().toISOString(), sourceRole: OPENING_ARCHIVE_SOURCE_ROLE, temporalBasis: 'postgame_secondary_provider_retrieved_now_not_historical_pregame_capture', strictPointInTime: false, officialNbaVerified: false, quarantinedHoldoutYears: [2022], holdoutPolicy: 'Acquire and validate outcomes only. No 2022 predictive metrics before candidate and selection freeze; development must precede 2022.', sources: [...sources.values()].sort((a, b) => a.url.localeCompare(b.url)), coverage, history, missing: coverage.missing, excluded: oracle.excluded };
    const filename = path.join(root, 'opening-research-history.json');
    await fs.writeFile(`${filename}.tmp`, JSON.stringify(archive)); await fs.rename(`${filename}.tmp`, filename);
  });
  return archiveWrites;
}
try {
  await parallel(oracle.days, async day => {
    const record = await source(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${day.replaceAll('-', '')}&limit=1000`, { kind: 'daily_scoreboard', day });
    for (const row of validatedResearchScoreboard(record.body, oracle.expected, record.sha256)) {
      const previous = rows.get(row.gameId);
      if (previous && (previous.homeHalf !== row.homeHalf || previous.awayHalf !== row.awayHalf)) throw Error(`Conflicting scoreboard quarters ${row.gameId}`);
      rows.set(row.gameId, row);
    }
    if (rows.size % 100 < 15) await checkpoint();
  });
} finally { await checkpoint(); }
const coverage = researchArchiveCoverage(oracle, [...rows.values()], years);
if (coverage.missing.length) throw Error(`Incomplete quarter archive: ${coverage.missing.length} games missing; fail closed`);
console.log(JSON.stringify({ saved: path.join(root, 'opening-research-history.json'), games: rows.size, sources: sources.size, networkRequestsThisRun: requests, coverage }));
