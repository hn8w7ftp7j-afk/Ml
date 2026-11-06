import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { durableDatabaseUrl } from './database-url.js';
import { canonicalReaderPayload } from '../reader/parser.js';
import { READER_CAPTURE_ARCHIVE_SCHEMA, READER_CAPTURE_ARCHIVE_LEAGUES, buildReaderCaptureArchive } from './reader-capture-archive.js';

const HASH = /^[a-f0-9]{64}$/;
const flags = { schema: READER_CAPTURE_ARCHIVE_SCHEMA, archiveOnly: true, currentBoardUpdated: false,
  historicalAvailabilityVerified: false, executable: false, productionWrites: false };
const fail = (code, status = 400) => Object.assign(new Error(code), { code, status });
const hash = value => createHash('sha256').update(value).digest('hex');
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
const validTime = (value, micro = false) => typeof value === 'string'
  && (micro ? /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{6}Z$/ : /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/).test(value)
  && validDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
const microTime = value => value.replace(/(\.\d{3})Z$/, (_, milliseconds) => `${milliseconds}000Z`);
const signature = (value, secret) => createHmac('sha256', secret).update(`READER-ARCHIVE-QUERY-v1\n${value}`).digest('base64url');
const stamp = value => value == null ? null : new Date(value).toISOString();
function count(value) {
  const number = Number(value);
  if (!/^(?:0|[1-9]\d*)$/.test(String(value)) || !Number.isSafeInteger(number)) throw fail('READER_ARCHIVE_QUERY_RESPONSE_INVALID', 503);
  return number;
}
export function parseReaderArchiveQuery(params, { now = Date.now(), secret = process.env.SESSION_SECRET } = {}) {
  const allowed = ['view', 'league', 'date', 'from', 'through', 'gameKey', 'limit', 'after', 'until', 'captureId'];
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) throw fail('READER_ARCHIVE_QUERY_INVALID');
  if (params.has('captureId')) {
    if ([...params.keys()].length !== 1 || !HASH.test(params.get('captureId'))) throw fail('READER_ARCHIVE_QUERY_INVALID');
    return { captureId: params.get('captureId') };
  }
  if (params.get('view') !== 'records') throw fail('READER_ARCHIVE_QUERY_INVALID');
  const league = params.get('league');
  let from = params.get('from'), through = params.get('through');
  if (league !== null && !READER_CAPTURE_ARCHIVE_LEAGUES.includes(league)) throw fail('READER_ARCHIVE_QUERY_INVALID');
  if (params.has('date')) {
    if (from !== null || through !== null) throw fail('READER_ARCHIVE_QUERY_INVALID');
    from = through = params.get('date');
  }
  if ((from !== null && !validDate(from)) || (through !== null && !validDate(through)) || (from && through && from > through)) throw fail('READER_ARCHIVE_QUERY_INVALID');
  const gameKey = params.get('gameKey');
  if (gameKey !== null && (!gameKey || gameKey.length > 200 || gameKey.trim() !== gameKey || /[\u0000-\u001f\u007f]/.test(gameKey))) throw fail('READER_ARCHIVE_QUERY_INVALID');
  const limitText = params.get('limit') ?? '25';
  if (!/^[1-9]\d?$/.test(limitText) || Number(limitText) > 50) throw fail('READER_ARCHIVE_QUERY_INVALID');
  if (!secret) throw fail('READER_ARCHIVE_CURSOR_UNAVAILABLE', 503);
  const filters = { league, from, through, gameKey };
  const filtersHash = hash(JSON.stringify(filters));
  let after = null;
  if (params.has('after')) {
    const value = params.get('after');
    if (value.length > 1200 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value)) throw fail('READER_ARCHIVE_QUERY_INVALID');
    const [encoded, signed] = value.split('.');
    if (!timingSafeEqual(Buffer.from(signed), Buffer.from(signature(encoded, secret)))) throw fail('READER_ARCHIVE_QUERY_INVALID');
    try { after = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { throw fail('READER_ARCHIVE_QUERY_INVALID'); }
    if (after?.v !== 1 || after.filtersHash !== filtersHash || !validTime(after.until) || !validTime(after.persistedAt, true) || !HASH.test(after.captureId || '')
      || after.persistedAt > microTime(after.until)) throw fail('READER_ARCHIVE_QUERY_INVALID');
  }
  const until = params.get('until') ?? after?.until ?? new Date(now).toISOString();
  if (!validTime(until) || Date.parse(until) > now || (after && after.until !== until)) throw fail('READER_ARCHIVE_QUERY_INVALID');
  return { filters, limit: Number(limitText), until, after, secret, filtersHash };
}
function cursor(row, query) {
  const encoded = Buffer.from(JSON.stringify({ v: 1, filtersHash: query.filtersHash, until: query.until,
    persistedAt: row.persisted_at, captureId: row.capture_id.trim() })).toString('base64url');
  return `${encoded}.${signature(encoded, query.secret)}`;
}
function client(options) {
  if (options.sql) return options.sql;
  const url = durableDatabaseUrl(options.env ?? process.env);
  if (!url) throw fail('READER_ARCHIVE_DATABASE_UNAVAILABLE', 503);
  return neon(url);
}
function metadata(row) {
  return { captureId: row.capture_id.trim(), league: row.league, boardDate: row.board_date,
    observedAt: stamp(row.source_observed_at), pageActivityAt: stamp(row.page_activity_at),
    receivedAt: stamp(row.received_at), persistedAt: row.persisted_at,
    readerVersion: row.reader_version, payloadHash: row.payload_hash.trim() };
}
export async function queryReaderCaptureArchives(query, options = {}) {
  const sql = client(options);
  if (query.captureId) {
    const rows = await sql`SELECT capture_id,schema_version,league,board_date::text AS board_date,
      source_observed_at,page_activity_at,payload_hash,payload_json,checksum,reader_version,received_at,
      to_char(persisted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS persisted_at
      FROM sports_reader_capture_archive_v1 WHERE capture_id=${query.captureId}`;
    if (!rows.length) throw fail('READER_ARCHIVE_NOT_FOUND', 404);
    const row = rows[0], info = metadata(row);
    let payload, valid = false;
    try {
      payload = JSON.parse(row.payload_json);
      const captureId = hash(JSON.stringify([READER_CAPTURE_ARCHIVE_SCHEMA, row.league, row.board_date,
        info.observedAt, info.pageActivityAt, info.payloadHash]));
      valid = row.schema_version === READER_CAPTURE_ARCHIVE_SCHEMA && captureId === query.captureId
        && row.checksum.trim() === hash(row.payload_json) && hash(canonicalReaderPayload(payload)) === info.payloadHash
        && payload.league === row.league && payload.boardDate === row.board_date && payload.observedAt === info.observedAt
        && payload.pageActivityAt === info.pageActivityAt && payload.payloadHash === info.payloadHash;
      if (valid) {
        // Reapply the sports-only intake allowlist before exposing saved JSON.
        // Capture source time is a replay validation time, never a claim of historical server availability.
        const checked = buildReaderCaptureArchive({ schema: READER_CAPTURE_ARCHIVE_SCHEMA, payload }, {
          deviceId: 'archive-query-validation', headerVersion: info.readerVersion, now: Date.parse(info.observedAt),
        });
        valid = checked.captureId === query.captureId;
        payload = checked.payload;
      }
    } catch { valid = false; /* Invalid archive content remains visible only as failed integrity metadata. */ }
    return { ok: true, ...flags, record: { ...info, integrity: { status: valid ? 'PASS' : 'FAIL',
      issues: valid ? [] : ['READER_ARCHIVE_CONTENT_MISMATCH'] }, payload: valid ? payload : null } };
  }
  const { league, from, through, gameKey } = query.filters;
  const rows = await sql`
    WITH filtered AS MATERIALIZED (
      SELECT capture_id,league,board_date,source_observed_at,page_activity_at,payload_hash,reader_version,received_at,persisted_at
      FROM sports_reader_capture_archive_v1
      WHERE persisted_at<=${query.until}::timestamptz
        AND (${league}::text IS NULL OR league=${league})
        AND (${from}::date IS NULL OR board_date>=${from}::date)
        AND (${through}::date IS NULL OR board_date<=${through}::date)
        AND (${gameKey}::text IS NULL OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(payload_json::jsonb->'games')='array' THEN payload_json::jsonb->'games' ELSE '[]'::jsonb END) g
          WHERE concat_ws('|',g->>'boardTime',coalesce(g->>'awayKey',g->>'awayCode'),coalesce(g->>'homeKey',g->>'homeCode'))=${gameKey}
        ))
    ), page AS (
      SELECT capture_id,league,board_date::text AS board_date,source_observed_at,page_activity_at,payload_hash,reader_version,received_at,
        to_char(persisted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS persisted_at
      FROM filtered
      WHERE (${query.after?.persistedAt ?? null}::timestamptz IS NULL OR (persisted_at,capture_id)>(${query.after?.persistedAt ?? null}::timestamptz,${query.after?.captureId ?? null}))
      ORDER BY persisted_at,capture_id LIMIT ${query.limit + 1}
    ), displayed AS (
      SELECT p.*,
        (SELECT jsonb_agg(jsonb_build_object('gameKey',concat_ws('|',g->>'boardTime',coalesce(g->>'awayKey',g->>'awayCode'),coalesce(g->>'homeKey',g->>'homeCode')),
          'away',coalesce(g->>'awayCode',g->>'awayKey'),'home',coalesce(g->>'homeCode',g->>'homeKey'),'boardTime',g->>'boardTime') ORDER BY n)
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(a.payload_json::jsonb->'games')='array' THEN a.payload_json::jsonb->'games' ELSE '[]'::jsonb END) WITH ORDINALITY AS games(g,n)) AS games
      FROM page p JOIN sports_reader_capture_archive_v1 a USING (capture_id)
    )
    SELECT (SELECT count(*)::text FROM filtered) AS total_count,
      (SELECT coalesce(jsonb_agg(to_jsonb(displayed) ORDER BY persisted_at,capture_id),'[]'::jsonb) FROM displayed) AS records
  `;
  const envelope = rows?.[0];
  if (!envelope || !Array.isArray(envelope.records)) throw fail('READER_ARCHIVE_QUERY_RESPONSE_INVALID', 503);
  const hasMore = envelope.records.length > query.limit, page = envelope.records.slice(0, query.limit);
  return { ok: true, ...flags, filters: query.filters, until: query.until, totalCount: count(envelope.total_count), hasMore,
    nextAfter: hasMore ? cursor(page.at(-1), query) : null,
    records: page.map(row => ({ ...metadata(row), games: Array.isArray(row.games) ? row.games : [], integrity: { status: 'NOT_VERIFIED', issues: [] } })) };
}
