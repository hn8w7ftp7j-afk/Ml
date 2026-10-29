import { createHash } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { durableDatabaseConfigured, durableDatabaseUrl } from './database-url.js';
import { resolveLeagueTeamId, TEAM_CODE_RE } from './league-teams.js';
import { validateTai888ReaderEnvelope } from './tai888-reader-parser-v2.js';
import { normalizeNbaReaderPayload } from './nba/reader.js';
import { validateSoccerCapture } from './soccer/reader.js';
import { canonicalReaderPayload, parseReaderMarketRows, readerMarketProperties } from '../reader/parser.js';

export const READER_CAPTURE_ARCHIVE_SCHEMA = 'READER-CAPTURE-ARCHIVE-v1';
export const READER_CAPTURE_ARCHIVE_TABLE = 'sports_reader_capture_archive_v1';
export const READER_CAPTURE_ARCHIVE_LEAGUES = Object.freeze(['MLB', 'NPB', 'KBO', 'CPBL', 'NBA', 'EPL', 'UCL']);
const BASEBALL = READER_CAPTURE_ARCHIVE_LEAGUES.slice(0, 4);
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const LINE = /^(?:\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?)(?:平|[+-]\d{1,3})?$/;
const HASH = /^[a-f0-9]{64}$/;
const SCHEMA_FLAGS = Object.freeze({ schema: READER_CAPTURE_ARCHIVE_SCHEMA, archiveOnly: true,
  currentBoardUpdated: false, historicalAvailabilityVerified: false, executable: false });
const schemaByClient = new WeakMap();
let client;
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = (code, status = 422) => Object.assign(new Error(code), { code, status });
const assert = (condition, code, status) => { if (!condition) throw fail(code, status); };
const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
function timestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function date(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && timestamp(`${value}T00:00:00.000Z`); }
function source(payload) {
  let url;
  try { url = new URL(payload.pageUrl); } catch { throw fail('READER_ARCHIVE_SOURCE_INVALID'); }
  const host = payload.sourceHost;
  assert(typeof host === 'string' && (host === 'tai888.in' || /^(?:[a-z0-9-]+\.)+tai888\.in$/.test(host))
    && url.protocol === 'https:' && !url.username && !url.password && !url.port && url.hostname === host,
  'READER_ARCHIVE_SOURCE_INVALID');
  const marker = /^#\/(?:BS|BB|FT)(?:$|[/?&])/i.test(url.hash) ? url.hash.match(/^#\/(?:BS|BB|FT)/i)[0].toUpperCase() : '';
  return { sourceHost: host, pageUrl: `${url.origin}${url.pathname}${marker}`.slice(0, 500) };
}
function market(value, key) {
  if (value == null) return null;
  const total = key.endsWith('Total');
  const fields = total ? ['line', 'overWater', 'underWater'] : ['lineSide', 'line', 'awayWater', 'homeWater'];
  assert(object(value) && typeof value.line === 'string' && value.line.length <= 32 && LINE.test(value.line)
    && (total || ['away', 'home'].includes(value.lineSide)), 'READER_ARCHIVE_MARKET_INVALID');
  const waters = total ? [value.overWater, value.underWater] : [value.awayWater, value.homeWater];
  assert(waters.every(water => typeof water === 'number' && Number.isFinite(water) && water >= 0.01 && water <= 3),
    'READER_ARCHIVE_MARKET_INVALID');
  const safe = Object.fromEntries(fields.map(field => [field, value[field]]));
  if (Object.hasOwn(value, 'rawRows')) {
    const reparsed = parseReaderMarketRows(key, value.rawRows);
    assert(reparsed && fields.every(field => reparsed[field] === value[field]), 'READER_ARCHIVE_RAW_MARKET_MISMATCH');
    // Validate original row evidence without retaining unrelated text prefixes.
    // The canonical source quote consists of the exact line/side/water fields.
  }
  return safe;
}
function standardGames(payload, league) {
  const keys = readerMarketProperties(league);
  const identities = new Set();
  return payload.games.map(row => {
    assert(object(row) && TEAM_CODE_RE.test(row.awayCode) && TEAM_CODE_RE.test(row.homeCode)
      && row.boardDate === payload.boardDate && TIME.test(row.boardTime)
      && ['open', 'locked'].includes(row.marketStatus), 'READER_ARCHIVE_GAME_INVALID');
    let away = row.awayCode, home = row.homeCode;
    if (BASEBALL.includes(league)) {
      away = resolveLeagueTeamId(league, row.awayCode); home = resolveLeagueTeamId(league, row.homeCode);
      assert(away && home && away !== home && !Object.hasOwn(row, 'firstHalfRunline') && !Object.hasOwn(row, 'firstHalfTotal'),
        'READER_ARCHIVE_TEAM_OR_PERIOD_INVALID');
    }
    const identity = `${row.boardTime}|${away}|${home}`;
    assert(!identities.has(identity), 'READER_ARCHIVE_DUPLICATE_GAME'); identities.add(identity);
    const values = Object.fromEntries(keys.map(key => [key, market(row[key], key)]));
    const count = Object.values(values).filter(Boolean).length;
    assert(row.marketStatus === 'locked' ? count === 0 : count > 0, 'READER_ARCHIVE_MARKET_STATUS_INVALID');
    const safe = { awayCode: row.awayCode, homeCode: row.homeCode, boardDate: row.boardDate,
      boardTime: row.boardTime, marketStatus: row.marketStatus, ...values };
    if (row.marketStates !== undefined) {
      const stateKeys = league === 'NBA' ? keys : ['FULL_HANDICAP', 'FULL_TOTAL', 'FIRST_HALF_HANDICAP', 'FIRST_HALF_TOTAL'];
      assert(object(row.marketStates) && Object.keys(row.marketStates).every(key => stateKeys.includes(key)), 'READER_ARCHIVE_MARKET_STATES_INVALID');
      // Preserve insertion order: it is part of the existing NBA wire hash.
      safe.marketStates = Object.fromEntries(Object.entries(row.marketStates).map(([key, state]) => {
        const index = stateKeys.indexOf(key);
        const allowed = league === 'NBA' ? ['AVAILABLE', 'UNAVAILABLE'] : ['AVAILABLE', 'UNAVAILABLE', 'BLOCKED'];
        assert(allowed.includes(state) && (state === 'AVAILABLE') === Boolean(values[keys[index]]),
          'READER_ARCHIVE_MARKET_STATES_INVALID');
        return [key, state];
      }));
    }
    return safe;
  });
}

// Archive intake is deliberately separate from every live-board store and all
// model/analysis heads. Validation at source time checks the ORIGINAL capture's
// structure; it is not proof that the server possessed that quote at that time.
export function buildReaderCaptureArchive(input, { deviceId, headerVersion, now = Date.now() } = {}) {
  assert(object(input) && input.schema === READER_CAPTURE_ARCHIVE_SCHEMA && object(input.payload), 'READER_ARCHIVE_SCHEMA_INVALID');
  const payload = input.payload, league = payload.league;
  assert(READER_CAPTURE_ARCHIVE_LEAGUES.includes(league), 'READER_ARCHIVE_LEAGUE_INVALID');
  assert(/^[a-zA-Z0-9._:-]{8,100}$/.test(deviceId || '') && (payload.deviceId === undefined || payload.deviceId === deviceId),
    'READER_ARCHIVE_DEVICE_INVALID', 401);
  assert(typeof payload.readerVersion === 'string' && /^\d+\.\d+\.\d+$/.test(payload.readerVersion)
    && payload.readerVersion === headerVersion, 'READER_ARCHIVE_VERSION_INVALID', 426);
  assert(timestamp(payload.observedAt) && timestamp(payload.pageActivityAt) && Number.isFinite(now), 'READER_ARCHIVE_TIME_INVALID');
  const observed = Date.parse(payload.observedAt), activity = Date.parse(payload.pageActivityAt);
  assert(observed <= now + 5_000 && activity <= now + 5_000 && activity <= observed + 5_000
    && observed - activity <= 180_000, 'READER_ARCHIVE_TIME_INVALID');
  assert(date(payload.boardDate), 'READER_ARCHIVE_DATE_INVALID');
  assert(Array.isArray(payload.games) && payload.games.length >= 1 && payload.games.length <= 40, 'READER_ARCHIVE_COUNT_INVALID');
  assert(payload.parseIssues == null || (Array.isArray(payload.parseIssues) && payload.parseIssues.length === 0), 'READER_ARCHIVE_PARSE_CONFLICT');
  assert(typeof payload.payloadHash === 'string' && HASH.test(payload.payloadHash), 'READER_ARCHIVE_HASH_INVALID');
  const safeSource = source(payload);
  let canonical;
  try { canonical = canonicalReaderPayload(payload); } catch { throw fail('READER_ARCHIVE_PAYLOAD_INVALID'); }
  assert(digest(canonical) === payload.payloadHash, 'READER_ARCHIVE_HASH_MISMATCH');
  let safe;
  if (BASEBALL.includes(league)) {
    validateTai888ReaderEnvelope(payload, { receivedAt: payload.observedAt, league });
    safe = { version: payload.version, league, ...safeSource, boardDate: payload.boardDate,
      observedAt: payload.observedAt, pageActivityAt: payload.pageActivityAt, readerVersion: payload.readerVersion,
      expectedGameCount: payload.expectedGameCount, detectedGameCount: payload.detectedGameCount,
      games: standardGames(payload, league), parseIssues: [] };
  } else if (league === 'NBA') {
    normalizeNbaReaderPayload({ ...payload, deviceId }, { now: observed, deviceId, headerVersion });
    safe = { version: payload.version, league, ...safeSource, boardDate: payload.boardDate,
      observedAt: payload.observedAt, pageActivityAt: payload.pageActivityAt, readerVersion: payload.readerVersion,
      expectedGameCount: payload.expectedGameCount, detectedGameCount: payload.detectedGameCount,
      games: standardGames(payload, league), parseIssues: [] };
  } else {
    const checked = validateSoccerCapture(payload, { now: observed, headerVersion });
    assert(checked.ok, 'READER_ARCHIVE_SOCCER_REPARSE_FAILED');
    safe = { ...checked.payload, ...safeSource };
    // The validator returns a new bounded sport-only parse and source tables.
    // Retain its complete selected date/period evidence, not arbitrary input.
  }
  assert(canonicalReaderPayload(safe) === canonical, 'READER_ARCHIVE_CANONICAL_MISMATCH');
  safe.payloadHash = payload.payloadHash;
  const captureId = digest(JSON.stringify([READER_CAPTURE_ARCHIVE_SCHEMA, league, payload.boardDate,
    payload.observedAt, payload.pageActivityAt, payload.payloadHash]));
  return { captureId, payloadHash: payload.payloadHash, league, boardDate: payload.boardDate,
    observedAt: payload.observedAt, pageActivityAt: payload.pageActivityAt, readerVersion: payload.readerVersion,
    payload: safe };
}

async function database(options) {
  if (options.sql) return options.sql;
  const env = options.env ?? process.env;
  if (!durableDatabaseConfigured(env)) throw fail('READER_ARCHIVE_DATABASE_UNAVAILABLE', 503);
  return client ||= neon(durableDatabaseUrl(env));
}
async function ensureSchema(sql) {
  if (!schemaByClient.has(sql)) {
    const pending = (async () => {
      await sql.transaction([
        sql`SELECT pg_advisory_xact_lock(hashtextextended('reader-capture-archive-schema-v1', 0))`,
        sql`CREATE TABLE IF NOT EXISTS sports_reader_capture_archive_v1 (
        capture_id CHAR(64) PRIMARY KEY,
        schema_version VARCHAR(40) NOT NULL CHECK (schema_version='READER-CAPTURE-ARCHIVE-v1'),
        league VARCHAR(5) NOT NULL CHECK (league IN ('MLB','NPB','KBO','CPBL','NBA','EPL','UCL')),
        board_date DATE NOT NULL, source_observed_at TIMESTAMPTZ NOT NULL, page_activity_at TIMESTAMPTZ NOT NULL,
        payload_hash CHAR(64) NOT NULL, payload_json TEXT NOT NULL, checksum CHAR(64) NOT NULL,
        reader_version VARCHAR(30) NOT NULL, received_at TIMESTAMPTZ NOT NULL,
        persisted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        CHECK (octet_length(payload_json)<=600000), CHECK (jsonb_typeof(payload_json::jsonb)='object')
      )`,
        sql`CREATE INDEX IF NOT EXISTS sports_reader_capture_archive_scope_v1
        ON sports_reader_capture_archive_v1 (league,board_date,source_observed_at DESC)`,
        sql`CREATE OR REPLACE FUNCTION reject_reader_capture_archive_mutation_v1() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'READER_CAPTURE_ARCHIVE_IMMUTABLE'; END $$`,
        sql`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='sports_reader_capture_archive_immutable_v1'
        AND tgrelid='sports_reader_capture_archive_v1'::regclass) THEN
        CREATE TRIGGER sports_reader_capture_archive_immutable_v1 BEFORE UPDATE OR DELETE ON sports_reader_capture_archive_v1
          FOR EACH ROW EXECUTE FUNCTION reject_reader_capture_archive_mutation_v1();
        END IF; END $$`,
      ], { isolationLevel: 'ReadCommitted' });
    })().catch(error => { schemaByClient.delete(sql); throw error; });
    schemaByClient.set(sql, pending);
  }
  await schemaByClient.get(sql);
}
function publicReceipt(row, expected) {
  let saved;
  try { saved = JSON.parse(row?.payload_json); } catch { throw fail('READER_ARCHIVE_READBACK_FAILED', 503); }
  const stamp = value => value == null || !Number.isFinite(new Date(value).getTime()) ? null : new Date(value).toISOString();
  const observedAt = stamp(row.source_observed_at), pageActivityAt = stamp(row.page_activity_at);
  const receivedAt = stamp(row.received_at), persistedAt = stamp(row.persisted_at);
  const captureId = digest(JSON.stringify([READER_CAPTURE_ARCHIVE_SCHEMA, row.league, row.board_date,
    observedAt, pageActivityAt, row.payload_hash?.trim()]));
  assert(row.schema_version === READER_CAPTURE_ARCHIVE_SCHEMA && row.capture_id?.trim() === expected.captureId
    && captureId === expected.captureId && row.payload_hash?.trim() === expected.payloadHash
    && row.league === expected.league && row.board_date === expected.boardDate
    && observedAt === expected.observedAt && pageActivityAt === expected.pageActivityAt
    && saved.observedAt === observedAt && saved.pageActivityAt === pageActivityAt
    && saved.league === row.league && saved.boardDate === row.board_date && saved.payloadHash === expected.payloadHash
    && digest(canonicalReaderPayload(saved)) === expected.payloadHash
    && digest(row.payload_json) === row.checksum?.trim() && receivedAt && persistedAt,
  'READER_ARCHIVE_READBACK_FAILED', 503);
  return { ok: true, durable: true, ...SCHEMA_FLAGS, captureId: expected.captureId, payloadHash: expected.payloadHash,
    league: expected.league, boardDate: expected.boardDate, observedAt, pageActivityAt, receivedAt, persistedAt };
}
export async function saveReaderCaptureArchive(input, options = {}) {
  const archive = buildReaderCaptureArchive(input, options);
  const sql = await database(options); await ensureSchema(sql);
  const payload = JSON.stringify(archive.payload);
  assert(Buffer.byteLength(payload) <= 600_000, 'READER_ARCHIVE_TOO_LARGE', 413);
  const receivedAt = new Date(options.now ?? Date.now()).toISOString();
  await sql`INSERT INTO sports_reader_capture_archive_v1
    (capture_id,schema_version,league,board_date,source_observed_at,page_activity_at,payload_hash,payload_json,checksum,reader_version,received_at)
    VALUES (${archive.captureId},${READER_CAPTURE_ARCHIVE_SCHEMA},${archive.league},${archive.boardDate}::date,
      ${archive.observedAt}::timestamptz,${archive.pageActivityAt}::timestamptz,${archive.payloadHash},${payload},${digest(payload)},${archive.readerVersion},${receivedAt}::timestamptz)
    ON CONFLICT (capture_id) DO NOTHING`;
  const rows = await sql`SELECT capture_id,schema_version,league,board_date::text AS board_date,
    source_observed_at,page_activity_at,payload_hash,payload_json,checksum,reader_version,received_at,persisted_at
    FROM sports_reader_capture_archive_v1 WHERE capture_id=${archive.captureId}`;
  return publicReceipt(rows?.[0], archive);
}
export async function listReaderCaptureArchives(options = {}) {
  const sql = await database(options); await ensureSchema(sql);
  const rows = await sql`SELECT league,count(*)::text AS capture_count,min(board_date)::text AS first_board_date,
    max(board_date)::text AS last_board_date,max(source_observed_at) AS last_observed_at,max(persisted_at) AS last_persisted_at
    FROM sports_reader_capture_archive_v1 GROUP BY league`;
  const indexed = new Map(rows.map(row => [row.league, row]));
  assert(indexed.size === rows.length && rows.every(row => READER_CAPTURE_ARCHIVE_LEAGUES.includes(row.league)), 'READER_ARCHIVE_SUMMARY_INVALID', 503);
  const leagues = READER_CAPTURE_ARCHIVE_LEAGUES.map(league => {
    const row = indexed.get(league);
    if (!row) return { league, captureCount: 0, firstBoardDate: null, lastBoardDate: null, lastObservedAt: null, lastPersistedAt: null };
    const count = Number(row.capture_count);
    const observedAt = new Date(row.last_observed_at).toISOString(), persistedAt = new Date(row.last_persisted_at).toISOString();
    assert(Number.isSafeInteger(count) && count > 0 && date(row.first_board_date) && date(row.last_board_date)
      && timestamp(observedAt) && timestamp(persistedAt), 'READER_ARCHIVE_SUMMARY_INVALID', 503);
    return { league, captureCount: count, firstBoardDate: row.first_board_date, lastBoardDate: row.last_board_date,
      lastObservedAt: observedAt, lastPersistedAt: persistedAt };
  });
  return { ok: true, ...SCHEMA_FLAGS, leagues };
}
