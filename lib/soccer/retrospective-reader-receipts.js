// Server-only research input. Never return these rows or payloads from an API.
// This is a read of one PostgreSQL snapshot; it neither initializes nor mutates storage.
import { createHash } from 'node:crypto';
import { soccerLeague, validSoccerDate } from './contracts.js';
import { soccerJournalHash, soccerJournalQuery } from './journal.js';
import { soccerReaderHash } from './reader.js';
import { canonicalSoccerPayload } from '../../reader/soccer-parser.js';

const PERIODS = ['FT', 'HT', 'UNKNOWN'];
const MAX_ROWS = 10000, MAX_BYTES = 16 * 1024 * 1024;

export const SOCCER_READER_METADATA_COUNT_SCOPE='RAW_RECEIPT_METADATA_COUNT_NOT_CONTENT_VALIDATION';

/** Bounded, read-only metadata count. Deliberately does not hydrate or validate
 * payloads, hashes, period bindings, clocks, identity, or pairing eligibility.
 * No ordering is needed: fewer than maxRows+1 visible rows proves the count in
 * this one statement's current snapshot. No stored scanner PASS is consulted. */
export async function countSoccerRetrospectiveReaderMetadata(league,date,{maxRows=1000,query=soccerJournalQuery}={}) {
  const id=soccerLeague(league)?.id;
  if(!id||league!==id||!validSoccerDate(date)||!Number.isSafeInteger(maxRows)||maxRows<1||maxRows>MAX_ROWS||typeof query!=='function')
    throw Error('SOCCER_RETROSPECTIVE_SCOPE_INVALID');
  const rows=await query(`WITH candidates AS MATERIALIZED (
    SELECT observation_id FROM sports_soccer_reader_observations_v2
    WHERE league=$1 AND board_date=$2::date LIMIT ($3::integer+1)
  ) SELECT count(*)::text AS n FROM candidates`,[id.toUpperCase(),date,maxRows]);
  const rawCount=rows?.[0]?.n,count=Number(rawCount);
  if(typeof rawCount!=='string'||!/^\d+$/.test(rawCount)||!Number.isSafeInteger(count)||count>maxRows+1)
    throw Error('SOCCER_RETROSPECTIVE_READER_METADATA_UNAVAILABLE');
  return {status:count>maxRows?'PARTIAL':'COMPLETE',observedCount:count>maxRows?null:count,
    countsDescribe:SOCCER_READER_METADATA_COUNT_SCOPE,contentValidated:false,
    reasonCodes:count>maxRows?['READER_RECEIPT_METADATA_ROW_BUDGET']:[]};
}

function periodHash(payload, period) {
  if (!Object.hasOwn(payload, 'periodsCovered')) return payload.contentHash;
  const marketPeriod = market => PERIODS.includes(market?.period) ? market.period : 'UNKNOWN';
  const games = payload.games.filter(game => game.periodsCovered?.includes(period) || game.markets.some(market => marketPeriod(market) === period)).map(game => {
    const markets = game.markets.filter(market => marketPeriod(market) === period)
      .map(({ serverObservation: ignored, ...market }) => market);
    const state = game.periodStates?.[period] || (markets.length ? 'open' : 'locked');
    return { ...game, periodsCovered: [period], periodStates: { [period]: state }, marketStatus: state, markets };
  });
  return soccerJournalHash({ league: payload.league, boardDate: payload.boardDate, period, games });
}
function withoutDevice(value) {
  if (Array.isArray(value)) return value.map(withoutDevice);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/device/i.test(key)).map(([key, item]) => [key, withoutDevice(item)]));
}
export function validateRetrospectiveReaderReceipt(row, league, date) {
  const payload = row.payload;
  const periods = Object.hasOwn(payload || {}, 'periodsCovered') ? payload.periodsCovered : ['UNKNOWN'];
  if (!payload || payload.league !== league.toUpperCase() || payload.boardDate !== date || payload.executable !== false ||
      !Array.isArray(periods) || periods.length > 3 || periods.some(p => !PERIODS.includes(p)) || new Set(periods).size !== periods.length ||
      !Array.isArray(payload.games) || payload.games.length > 40 || payload.games.some(g => !g || g.boardDate !== date ||
        (g.league !== undefined && g.league !== payload.league) || !Array.isArray(g.markets) ||
        g.markets.some(m => !m || !(periods.length ? periods : ['UNKNOWN']).includes(Object.hasOwn(payload, 'periodsCovered') && PERIODS.includes(m.period) ? m.period : 'UNKNOWN'))) ||
      row.sourceObservedAt !== row.payloadObservedAt || row.observationId !== soccerJournalHash(payload) ||
      row.contentHash !== payload.contentHash || row.contentHash !== soccerReaderHash(canonicalSoccerPayload(payload))) throw Error('SOCCER_RETROSPECTIVE_RECEIPT_CORRUPTED');
  const expected = periods.length ? [...periods].sort() : ['UNKNOWN'];
  if (!Array.isArray(row.periods) || JSON.stringify(row.periods.map(p => p.period).sort()) !== JSON.stringify(expected) ||
      row.periods.some(p => p.contentHash !== periodHash(payload, p.period))) throw Error('SOCCER_RETROSPECTIVE_PERIOD_CORRUPTED');
  const deviceHash = typeof payload.deviceId === 'string' && payload.deviceId ? createHash('sha256').update(payload.deviceId).digest('hex') : null;
  return { observationId: row.observationId, contentHash: row.contentHash, sourceObservedAt: row.sourceObservedAt,
    receivedAt: row.receivedAt, persistedAt: row.persistedAt, periods: row.periods, deviceHash, payload: withoutDevice(payload) };
}

// maxBytes is measured on the aggregate JSON text including metadata and brackets;
// either bound exceeded => no rows at all, so no truncated result can be called complete.
export async function loadSoccerRetrospectiveReaderReceipts(league, date, { maxRows = 5000, maxBytes = MAX_BYTES } = {}) {
  const id = soccerLeague(league)?.id;
  if (!id || league !== id || !validSoccerDate(date) || !Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > MAX_ROWS ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 2 || maxBytes > MAX_BYTES) throw Error('SOCCER_RETROSPECTIVE_SCOPE_INVALID');
  const rows = await soccerJournalQuery(`WITH limited AS MATERIALIZED (
    SELECT o.*, COALESCE((SELECT jsonb_agg(jsonb_build_object('period',p.period,'contentHash',p.content_hash) ORDER BY p.period)
      FROM sports_soccer_reader_period_observations_v2 p WHERE p.observation_id=o.observation_id),
      CASE WHEN NOT (o.payload ? 'periodsCovered') THEN jsonb_build_array(jsonb_build_object('period','UNKNOWN','contentHash',o.content_hash)) ELSE '[]'::jsonb END) AS periods
    FROM sports_soccer_reader_observations_v2 o WHERE o.league=$1 AND o.board_date=$2::date
    ORDER BY o.received_at,o.observation_id LIMIT ($3::integer + 1)
  ), encoded AS MATERIALIZED (
    SELECT jsonb_build_object('observationId',observation_id,'contentHash',content_hash,
      'sourceObservedAt',to_char(source_observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'payloadObservedAt',to_char((payload->>'observedAt')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'receivedAt',to_char(received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'persistedAt',to_char(persisted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'periods',periods,'payload',payload) AS item, received_at, observation_id FROM limited
  ), bounds AS (SELECT count(*) AS n, COALESCE(sum(octet_length(item::text)),0) + GREATEST(count(*)-1,0)*2 + 2 AS bytes FROM encoded)
  SELECT n::text AS n, bytes::text AS bytes,
    CASE WHEN n<=$3::integer AND bytes<=$4::integer THEN
      COALESCE((SELECT jsonb_agg(item ORDER BY received_at,observation_id) FROM encoded),'[]'::jsonb)
    ELSE '[]'::jsonb END AS items FROM bounds`, [id.toUpperCase(), date, maxRows, maxBytes]);
  const result = rows[0];
  if (!result || !Array.isArray(result.items)) throw Error('SOCCER_RETROSPECTIVE_RECEIPTS_UNAVAILABLE');
  const count = Number(result.n), bytes = Number(result.bytes);
  if (count > maxRows || bytes > maxBytes) return { status: 'PARTIAL', rows: [], observedCount: count, observedBytes: bytes,
    countsDescribe: 'BOUNDED_PREFIX_ONLY', reasonCodes: [
      ...(count > maxRows ? ['READER_RECEIPT_ROW_BUDGET'] : []), ...(bytes > maxBytes ? ['READER_RECEIPT_BYTE_BUDGET'] : [])] };
  return { status: 'COMPLETE', rows: result.items.map(row => validateRetrospectiveReaderReceipt(row, id, date)), observedCount: count, observedBytes: bytes };
}
