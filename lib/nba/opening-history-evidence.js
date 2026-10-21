import { createHash } from 'node:crypto';
import { validateOpeningHistory } from './opening-core.js';
import { validDate } from './identity.js';
import { OPENING_ACQUISITION_VERSION, OPENING_ARCHIVE_SOURCE_ROLE } from './opening-history-acquisition.js';

// Reviewed by re-reading all 941 raw, checksummed source checkpoints with
// prepare-nba-opening-research-history.mjs. This is an allowlisted retrospective
// artifact, not a remote attestation or evidence of historical pregame access.
// A replacement archive requires a new raw-source review and explicit pin.
export const OPENING_RESEARCH_REVIEWED_ARCHIVE_SHA256 = '0885775b75c4901a65a2261330918bbef387e3e623a7d1d3c45e9d4e7f4a1b49';
export const OPENING_RESEARCH_REQUIRED_SOURCE_YEARS = Object.freeze([2018, 2019, 2020, 2021, 2022]);
const fields = ['gameId', 'date', 'startTime', 'year', 'seasonType', 'homeId', 'awayId',
  'homeScore', 'awayScore', 'neutralSite', 'homeHalf', 'awayHalf', 'checkpointSha256'];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const digest = value => { try { return sha256(JSON.stringify(value)); } catch { return null; } };
const isoTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;
const dateFormatter = zone => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
const sourceDay = dateFormatter('America/New_York'), taipeiDay = dateFormatter('Asia/Taipei');
const order = (a, b) => a.gameId.localeCompare(b.gameId);
const identities = rows => rows.map(row => Object.fromEntries(fields.map(key => [key, row[key]]))).sort(order);

// Pure, fail-closed provenance audit. Numeric coverage claims alone, a valid
// checksum supplied by the caller, or a plausible sources array cannot pass.
// The reviewed archive hash binds exact expected IDs/results to the generator's
// independently rebuilt two-team schedule oracle and quarter checksums.
export function auditOpeningResearchArchive(history, archive, { requiredYears = OPENING_RESEARCH_REQUIRED_SOURCE_YEARS } = {}) {
  const years = Array.isArray(requiredYears) ? [...requiredYears] : [...OPENING_RESEARCH_REQUIRED_SOURCE_YEARS];
  const errors = [];
  const fail = (ok, code) => { if (!ok && !errors.includes(code)) errors.push(code); };
  fail(Array.isArray(requiredYears) && JSON.stringify(years) === JSON.stringify(OPENING_RESEARCH_REQUIRED_SOURCE_YEARS), 'SOURCE_YEAR_SCOPE_INVALID');
  const archiveHash = digest(archive);
  fail(archiveHash === OPENING_RESEARCH_REVIEWED_ARCHIVE_SHA256, 'REVIEWED_ARCHIVE_HASH_MISMATCH');
  fail(archive?.kind === 'NBA_OPENING_VERIFIED_REGULAR_ARCHIVE' && archive?.version === OPENING_ACQUISITION_VERSION
    && archive.synthetic !== true && archive.sourceRole === OPENING_ARCHIVE_SOURCE_ROLE
    && archive.temporalBasis === 'postgame_secondary_provider_retrieved_now_not_historical_pregame_capture'
    && archive.strictPointInTime === false && archive.officialNbaVerified === false
    && Array.isArray(archive.quarantinedHoldoutYears) && archive.quarantinedHoldoutYears.includes(2022)
    && isoTime(archive.retrievedAt), 'ARCHIVE_SCOPE_INVALID');
  fail(archive?.coverage?.status === 'complete' && Array.isArray(archive.missing) && archive.missing.length === 0
    && Array.isArray(archive.coverage?.missing) && archive.coverage.missing.length === 0, 'ARCHIVE_INCOMPLETE');
  fail(validateOpeningHistory(history) && !history.some(row => row.league != null && row.league !== 'NBA'), 'EVALUATED_HISTORY_INVALID');
  const rows = Array.isArray(archive?.history) ? archive.history : [];
  fail(validateOpeningHistory(rows) && !rows.some(row => row.league != null && row.league !== 'NBA'), 'ARCHIVE_HISTORY_INVALID');
  fail(JSON.stringify(Object.keys(archive?.coverage?.years || {}).map(Number).sort((a, b) => a - b))
    === JSON.stringify(OPENING_RESEARCH_REQUIRED_SOURCE_YEARS), 'ARCHIVE_COVERAGE_YEAR_SCOPE_INVALID');
  fail(rows.every(row => OPENING_RESEARCH_REQUIRED_SOURCE_YEARS.includes(row?.year)), 'ARCHIVE_HISTORY_YEAR_SCOPE_INVALID');
  const sources = Array.isArray(archive?.sources) ? archive.sources : [];
  fail(sources.length > 0, 'SOURCE_MANIFEST_MISSING');
  const urls = new Set(), scheduleTeams = new Map(), boards = new Map();
  for (const source of sources) {
    if (!source || typeof source !== 'object') { fail(false, 'SOURCE_MANIFEST_INVALID'); continue; }
    fail(typeof source.url === 'string' && !urls.has(source.url), 'SOURCE_URL_DUPLICATE_OR_INVALID');
    urls.add(source.url);
    fail(/^[a-f0-9]{64}$/.test(source.sha256 || '') && Number.isSafeInteger(source.bytes) && source.bytes > 0
      && isoTime(source.retrievedAt) && source.retrievedAt <= archive?.retrievedAt
      && typeof source.url === 'string' && source.cacheFile === `sources/${sha256(String(source.url))}.json.gz`, 'SOURCE_CHECKPOINT_INVALID');
    if (source.kind === 'team_schedule') {
      const team = String(source.team), year = source.year;
      fail(OPENING_RESEARCH_REQUIRED_SOURCE_YEARS.includes(year) && /^(?:[1-9]|[12]\d|30)$/.test(team)
        && source.url === `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${team}/schedule?season=${year}&seasontype=2`, 'SCHEDULE_SOURCE_SCOPE_INVALID');
      const teams = scheduleTeams.get(year) || new Set();
      fail(!teams.has(team), 'SCHEDULE_TEAM_DUPLICATE'); teams.add(team); scheduleTeams.set(year, teams);
    } else if (source.kind === 'daily_scoreboard') {
      fail(validDate(source.day) && source.url === `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${String(source.day).replaceAll('-', '')}&limit=1000`, 'SCOREBOARD_SOURCE_SCOPE_INVALID');
      fail(!boards.has(source.day), 'SCOREBOARD_DAY_DUPLICATE'); boards.set(source.day, source);
    } else fail(false, 'SOURCE_KIND_INVALID');
  }
  const observedDays = new Set();
  for (const row of rows) {
    if (!isoTime(row?.startTime)) { fail(false, 'ROW_START_TIME_INVALID'); continue; }
    const day = sourceDay.format(new Date(row.startTime)); observedDays.add(day);
    fail(taipeiDay.format(new Date(row.startTime)) === row.date, 'ROW_TAIPEI_DATE_MISMATCH');
    fail(boards.get(day)?.sha256 === row.checkpointSha256, 'ROW_SOURCE_CHECKPOINT_MISMATCH');
  }
  fail(boards.size === observedDays.size && [...boards.keys()].every(day => observedDays.has(day)), 'SCOREBOARD_CALENDAR_INCOMPLETE');
  return years.map(year => {
    const yearErrors = [...errors], sourceRows = rows.filter(row => row?.year === year);
    const evaluatedRows = Array.isArray(history) ? history.filter(row => row?.year === year) : [];
    const dates = sourceRows.map(row => row.date).sort(), coverage = archive?.coverage?.years?.[year];
    const check = (ok, code) => { if (!ok && !yearErrors.includes(code)) yearErrors.push(code); };
    check(scheduleTeams.get(year)?.size === 30, 'THIRTY_TEAM_SCHEDULES_REQUIRED');
    check(sourceRows.length > 0 && coverage?.expectedGames === sourceRows.length
      && coverage?.observedGames === sourceRows.length && coverage?.quarterCrosscheckedGames === sourceRows.length
      && coverage?.teamSchedulesChecked === 30 && coverage?.missingGames === 0
      && coverage?.firstSourceGameDate === dates[0] && coverage?.lastSourceGameDate === dates.at(-1), 'RECONSTRUCTED_COVERAGE_MISMATCH');
    let matches = false;
    try { matches = JSON.stringify(identities(sourceRows)) === JSON.stringify(identities(evaluatedRows)); } catch { /* malformed evaluated data stays unaudited */ }
    check(matches, 'EVALUATED_HISTORY_SOURCE_MISMATCH');
    return { year, observedGames: evaluatedRows.length, verified: yearErrors.length === 0,
      reason: yearErrors.length ? 'COMPLETE_YEAR_SOURCE_AUDIT_REQUIRED' : null, failureCodes: yearErrors,
      reviewedArchiveSha256: OPENING_RESEARCH_REVIEWED_ARCHIVE_SHA256,
      suppliedArchiveSha256: archiveHash, schedulesChecked: scheduleTeams.get(year)?.size || 0,
      sourceBasis: 'reviewed_raw_source_hash_and_reconstructed_manifest_not_remote_attestation' };
  });
}
