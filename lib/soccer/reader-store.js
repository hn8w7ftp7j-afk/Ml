import { neon } from '@neondatabase/serverless';
import { durableDatabaseConfigured, durableDatabaseUrl } from '../database-url.js';
import { soccerLeague, validSoccerDate } from './contracts.js';
import { canonicalSoccerPayload } from '../../reader/soccer-parser.js';
import { soccerReaderHash } from './reader.js';
import { ensureSoccerJournal, soccerJournalHash, soccerJournalQuery, soccerJournalTransaction, soccerBoardLock } from './journal.js';

let legacyClient;
const PERIODS = ['FT', 'HT', 'UNKNOWN'];
export const soccerReaderStorageConfigured = () => durableDatabaseConfigured();
function capturePeriods(payload) {
  if (!Object.hasOwn(payload, 'periodsCovered')) return ['UNKNOWN'];
  const periods = payload.periodsCovered;
  if (!Array.isArray(periods) || periods.length > 3 || periods.some(period => !PERIODS.includes(period)) || new Set(periods).size !== periods.length) return null;
  return periods.length ? [...periods].sort() : ['UNKNOWN'];
}
function marketPeriod(market, payload) {
  return Object.hasOwn(payload, 'periodsCovered') && PERIODS.includes(market?.period) ? market.period : 'UNKNOWN';
}
function check(payload) {
  try {
    const periods = capturePeriods(payload);
    return ['EPL', 'UCL'].includes(payload?.league) && validSoccerDate(payload?.boardDate) &&
      payload.executable === false && Number.isFinite(Date.parse(payload.observedAt)) && periods &&
      Array.isArray(payload.games) && payload.games.length <= 40 &&
      payload.games.every(game => game.boardDate === payload.boardDate && Array.isArray(game.markets) &&
        game.markets.every(market => periods.includes(marketPeriod(market, payload)))) &&
      payload.contentHash === soccerReaderHash(canonicalSoccerPayload(payload));
  } catch { return false; }
}
function envelope(row) {
  // Validate the immutable original before attaching serverObservation metadata.
  if (!check(row.payload) || soccerJournalHash(row.payload) !== row.observation_id) throw Error('SOCCER_READER_SNAPSHOT_CORRUPTED');
  return { ...row.payload, revision: row.observation_id, observationId: row.observation_id,
    firstFetchedAt: new Date(row.content_first_fetched_at || row.received_at).toISOString(),
    receivedAt: new Date(row.received_at).toISOString(), persistedAt: new Date(row.persisted_at).toISOString(),
    sourceObservedAt: row.payload.observedAt, timeEvidence: 'SERVER_RECEIPT_RECORDED', historicalAvailabilityVerified: false };
}
function contentForPeriod(payload, period) {
  if (!Object.hasOwn(payload, 'periodsCovered')) return payload.contentHash;
  const games = payload.games.filter(game => game.periodsCovered?.includes(period) || game.markets.some(market => marketPeriod(market, payload) === period)).map(game => {
    const markets = game.markets.filter(market => marketPeriod(market, payload) === period)
      .map(({ serverObservation: ignored, ...market }) => market);
    const state = game.periodStates?.[period] || (markets.length ? 'open' : 'locked');
    return { ...game, periodsCovered: [period], periodStates: { [period]: state }, marketStatus: state, markets };
  });
  return soccerJournalHash({ league: payload.league, boardDate: payload.boardDate, period, games });
}
function aggregate(rows, league, date) {
  const games = new Map(), sourceObservations = [];
  for (const row of rows) {
    const snapshot = envelope(row), period = row.period;
    const serverObservation = { observationId: snapshot.observationId, revision: snapshot.revision,
      observedAt: snapshot.observedAt, firstFetchedAt: snapshot.firstFetchedAt,
      receivedAt: snapshot.receivedAt, persistedAt: snapshot.persistedAt,
      sourceHost: snapshot.sourceHost || null, pageUrl: snapshot.pageUrl || null };
    sourceObservations.push({ period, ...serverObservation, contentHash: row.period_content_hash || snapshot.contentHash });
    for (const raw of snapshot.games) {
      const markets = raw.markets.filter(market => marketPeriod(market, snapshot) === period).map(market => ({ ...market,
        period, ...(period === 'UNKNOWN' && (!Object.hasOwn(snapshot, 'periodsCovered') || !market.periodEvidence)
          ? { periodEvidence: { period: 'UNKNOWN', status: 'UNKNOWN' } } : {}),
        serverObservation: { ...serverObservation } }));
      if (!markets.length && !raw.periodsCovered?.includes(period)) continue;
      const key = [raw.boardDate, raw.boardTime, raw.awayKey || raw.awayCode, raw.homeKey || raw.homeCode].join('|');
      const game = games.get(key) || { ...raw, markets: [], periodsCovered: [], periodStates: {} };
      game.markets.push(...markets);
      game.periodsCovered = [...new Set([...game.periodsCovered, period])].sort();
      game.periodStates[period] = raw.periodStates?.[period] || (markets.length ? 'open' : 'locked');
      game.marketStatus = game.markets.length ? 'open' : 'locked';
      games.set(key, game);
    }
  }
  sourceObservations.sort((a, b) => a.period.localeCompare(b.period));
  const values = [...games.values()].sort((a, b) => `${a.boardDate}${a.boardTime}${a.awayCode}`.localeCompare(`${b.boardDate}${b.boardTime}${b.awayCode}`));
  const contentHash = soccerJournalHash(sourceObservations.map(row => ({ period: row.period, contentHash: row.contentHash })));
  const revision = soccerJournalHash({ league, boardDate: date, sourceObservations });
  return { version: 'SOCCER-PERIOD-AGGREGATE-v1', interfaceVersion: 'SOCCER-READER-v1', provider: 'TAI888_READER',
    league: league.toUpperCase(), boardDate: date, pageLeagueLabel: league === 'epl' ? '英格蘭超級聯賽' : '歐洲冠軍聯賽',
    periodsCovered: sourceObservations.map(row => row.period), games: values, sourceObservations,
    // Conservative compatibility timestamp; freshness belongs to each quote.
    observedAt: sourceObservations.map(row => row.observedAt).sort()[0],
    revision, contentHash, observationId: null, firstFetchedAt: null, receivedAt: null, persistedAt: null,
    isPeriodAggregate: true, freshnessScope: 'PER_MARKET_SERVER_OBSERVATION',
    timeEvidence: 'PER_PERIOD_SERVER_RECEIPTS', historicalAvailabilityVerified: false,
    marketVerification: 'CAPTURED_RULES_UNVERIFIED', settlementScope: null, executable: false };
}

// Missing legacy scope remains UNKNOWN without rewriting the original hash.
const PERIOD_OBSERVATIONS = `WITH period_observations AS (
  SELECT p.observation_id,p.period,p.content_hash FROM sports_soccer_reader_period_observations_v2 AS p
  UNION ALL
  SELECT o.observation_id,'UNKNOWN'::text,o.content_hash FROM sports_soccer_reader_observations_v2 AS o
    WHERE NOT (o.payload ? 'periodsCovered') AND NOT EXISTS (
      SELECT 1 FROM sports_soccer_reader_period_observations_v2 AS p WHERE p.observation_id=o.observation_id))`;
const FIRST_RECEIPT = `(SELECT min(v.received_at) FROM period_observations AS p
  JOIN sports_soccer_reader_observations_v2 AS v ON v.observation_id=p.observation_id
  WHERE p.period=r.period AND p.content_hash=r.period_content_hash AND v.league=o.league AND v.board_date=o.board_date
    AND ($3::timestamptz IS NULL OR (v.received_at<=$3::timestamptz AND v.persisted_at<=$3::timestamptz))) AS content_first_fetched_at`;

export async function loadSoccerReaderSnapshot(league, date, { asOf = null } = {}) {
  const id = soccerLeague(league)?.id;
  const cutoff = asOf === null ? null : typeof asOf === 'number' && Number.isFinite(asOf) && Math.abs(asOf) <= 8.64e15
    ? new Date(asOf).toISOString() : typeof asOf === 'string' && Number.isFinite(Date.parse(asOf)) ? new Date(asOf).toISOString() : undefined;
  if (!id || !validSoccerDate(date) || cutoff === undefined) throw Error('SOCCER_READER_SCOPE_INVALID');
  await ensureSoccerJournal();
  let rows;
  if (cutoff !== null) {
    rows = await soccerJournalQuery(`${PERIOD_OBSERVATIONS}, ranked AS (
      SELECT DISTINCT ON (p.period) p.period,p.content_hash AS period_content_hash,o.observation_id,
        o.source_observed_at,o.received_at FROM period_observations AS p
      JOIN sports_soccer_reader_observations_v2 AS o ON o.observation_id=p.observation_id
      WHERE o.league=$1 AND o.board_date=$2::date AND o.received_at<=$3::timestamptz AND o.persisted_at<=$3::timestamptz
      ORDER BY p.period,o.source_observed_at DESC,o.received_at DESC,o.observation_id DESC)
      SELECT r.period,r.period_content_hash,o.observation_id,o.received_at,o.persisted_at,o.payload,${FIRST_RECEIPT}
      FROM ranked AS r JOIN sports_soccer_reader_observations_v2 AS o ON o.observation_id=r.observation_id ORDER BY r.period`, [id.toUpperCase(), date, cutoff]);
  } else {
    rows = await soccerJournalQuery(`${PERIOD_OBSERVATIONS}, current_periods AS (
      SELECT h.period,h.content_hash AS period_content_hash,h.observation_id FROM sports_soccer_reader_period_heads_v2 AS h
      WHERE h.league=lower($1) AND h.board_date=$2::date
      UNION ALL
      SELECT 'UNKNOWN'::text,l.content_hash,l.observation_id FROM (
        SELECT o.observation_id,o.content_hash FROM sports_soccer_reader_observations_v2 AS o
        WHERE o.league=$1 AND o.board_date=$2::date AND NOT (o.payload ? 'periodsCovered')
        ORDER BY o.source_observed_at DESC,o.received_at DESC,o.observation_id DESC LIMIT 1) AS l
      WHERE NOT EXISTS (SELECT 1 FROM sports_soccer_reader_period_heads_v2 AS h
        WHERE h.league=lower($1) AND h.board_date=$2::date AND h.period='UNKNOWN'))
      SELECT r.period,r.period_content_hash,o.observation_id,o.received_at,o.persisted_at,o.payload,${FIRST_RECEIPT}
      FROM current_periods AS r JOIN sports_soccer_reader_observations_v2 AS o ON o.observation_id=r.observation_id
      WHERE o.league=$1 AND o.board_date=$2::date ORDER BY r.period`, [id.toUpperCase(), date, null]);
  }
  if (rows.length) return aggregate(rows, id, date);
  if (cutoff !== null) return null;
  const sql = legacyClient ||= neon(durableDatabaseUrl());
  let legacy;
  try { legacy = await sql`SELECT revision,payload FROM sports_soccer_reader_snapshots_v1 WHERE league=${id.toUpperCase()} AND board_date=${date}::date ORDER BY observed_at DESC LIMIT 1`; }
  catch (error) { if (error.code === '42P01') return null; throw error; }
  if (!legacy[0]) return null;
  if (!check(legacy[0].payload)) throw Error('SOCCER_READER_SNAPSHOT_CORRUPTED');
  return { ...legacy[0].payload, games: legacy[0].payload.games.map(game => ({ ...game,
    markets: game.markets.map(market => ({ ...market, period: 'UNKNOWN', periodEvidence: { period: 'UNKNOWN', status: 'UNKNOWN' } })) })),
    revision: legacy[0].revision, observationId: null, firstFetchedAt: null,
    timeEvidence: 'LEGACY_ACQUISITION_UNKNOWN', historicalAvailabilityVerified: false };
}

export async function saveSoccerReaderSnapshot(payload, { receivedAt = new Date().toISOString() } = {}) {
  if (!check(payload) || !Number.isFinite(Date.parse(receivedAt))) throw Object.assign(Error('SOCCER_READER_SNAPSHOT_INVALID'), { status: 422 });
  await ensureSoccerJournal();
  const revision = soccerJournalHash(payload), periods = capturePeriods(payload);
  const records = periods.map(period => ({ period, content_hash: contentForPeriod(payload, period) }));
  const results = await soccerJournalTransaction([
    soccerBoardLock(payload.league, payload.boardDate),
    [`INSERT INTO sports_soccer_reader_period_observations_v2 (observation_id,period,content_hash)
      SELECT o.observation_id,'UNKNOWN',o.content_hash FROM sports_soccer_source_heads_v2 AS h
      JOIN sports_soccer_reader_observations_v2 AS o ON o.observation_id=h.observation_id
      WHERE h.league=$1 AND h.board_date=$2::date AND NOT (o.payload ? 'periodsCovered')
      ON CONFLICT DO NOTHING`, [payload.league.toLowerCase(), payload.boardDate]],
    [`INSERT INTO sports_soccer_reader_period_heads_v2 (league,board_date,period,observation_id,content_hash,source_observed_at,received_at)
      SELECT h.league,h.board_date,p.period,o.observation_id,p.content_hash,o.source_observed_at,o.received_at
      FROM sports_soccer_source_heads_v2 AS h
      JOIN sports_soccer_reader_observations_v2 AS o ON o.observation_id=h.observation_id
      JOIN sports_soccer_reader_period_observations_v2 AS p ON p.observation_id=o.observation_id AND p.period='UNKNOWN'
      WHERE h.league=$1 AND h.board_date=$2::date AND NOT (o.payload ? 'periodsCovered')
      ON CONFLICT DO NOTHING`, [payload.league.toLowerCase(), payload.boardDate]],
    [`INSERT INTO sports_soccer_reader_observations_v2
      (observation_id,league,board_date,content_hash,source_observed_at,received_at,payload)
      VALUES ($1,$2,$3::date,$4,$5::timestamptz,$6::timestamptz,$7::jsonb) ON CONFLICT DO NOTHING`,
    [revision, payload.league, payload.boardDate, payload.contentHash, payload.observedAt, receivedAt, JSON.stringify(payload)]],
    [`INSERT INTO sports_soccer_reader_period_observations_v2 (observation_id,period,content_hash)
      SELECT $1,r.period,r.content_hash FROM jsonb_to_recordset($2::jsonb) AS r(period text,content_hash text) ON CONFLICT DO NOTHING`,
    [revision, JSON.stringify(records)]],
    [`INSERT INTO sports_soccer_reader_period_heads_v2 (league,board_date,period,observation_id,content_hash,source_observed_at,received_at)
      SELECT lower(o.league),o.board_date,p.period,o.observation_id,p.content_hash,o.source_observed_at,o.received_at
      FROM sports_soccer_reader_period_observations_v2 AS p
      JOIN sports_soccer_reader_observations_v2 AS o ON o.observation_id=p.observation_id WHERE o.observation_id=$1
      ON CONFLICT (league,board_date,period) DO UPDATE SET observation_id=EXCLUDED.observation_id,
        content_hash=EXCLUDED.content_hash,source_observed_at=EXCLUDED.source_observed_at,
        received_at=EXCLUDED.received_at,updated_at=clock_timestamp()
      WHERE (sports_soccer_reader_period_heads_v2.source_observed_at,sports_soccer_reader_period_heads_v2.received_at,
        sports_soccer_reader_period_heads_v2.observation_id) <= (EXCLUDED.source_observed_at,EXCLUDED.received_at,EXCLUDED.observation_id)
      RETURNING period`, [revision]],
    // Fingerprint is built under the same lock from active period content only.
    // Receipt/observation changes do not turn a same-price heartbeat into a reprice.
    [`INSERT INTO sports_soccer_source_heads_v2 (league,board_date,quote_generation,content_hash,source_observed_at,observation_id)
      SELECT $1,$2::date,1,encode(sha256(convert_to(string_agg(period||':'||content_hash,'|' ORDER BY period),'UTF8')),'hex'),
        max(source_observed_at),(array_agg(observation_id ORDER BY source_observed_at DESC,received_at DESC,observation_id DESC))[1]
      FROM sports_soccer_reader_period_heads_v2 WHERE league=$1 AND board_date=$2::date
      HAVING count(*)>0
      ON CONFLICT (league,board_date) DO UPDATE SET
        quote_generation=sports_soccer_source_heads_v2.quote_generation+
          CASE WHEN sports_soccer_source_heads_v2.content_hash IS DISTINCT FROM EXCLUDED.content_hash THEN 1 ELSE 0 END,
        content_hash=EXCLUDED.content_hash,source_observed_at=EXCLUDED.source_observed_at,
        observation_id=EXCLUDED.observation_id,updated_at=clock_timestamp() RETURNING quote_generation`,
    [payload.league.toLowerCase(), payload.boardDate]],
    [`UPDATE sports_soccer_analysis_heads_v2 AS h SET published_revision=NULL,valid_until=NULL,updated_at=clock_timestamp()
      WHERE h.league=$1 AND h.board_date=$2::date AND h.quote_generation<>
        (SELECT quote_generation FROM sports_soccer_source_heads_v2 WHERE league=$1 AND board_date=$2::date)`,
    [payload.league.toLowerCase(), payload.boardDate]],
  ]);
  const rows = await soccerJournalQuery(`SELECT o.observation_id,o.received_at,o.persisted_at,o.payload,
    (SELECT min(v.received_at) FROM sports_soccer_reader_observations_v2 AS v
      WHERE v.league=o.league AND v.board_date=o.board_date AND v.content_hash=o.content_hash) AS content_first_fetched_at
    FROM sports_soccer_reader_observations_v2 AS o WHERE o.observation_id=$1`, [revision]);
  if (!rows[0] || soccerJournalHash(rows[0].payload) !== revision) throw Error('SOCCER_READER_READBACK_FAILED');
  const saved = envelope(rows[0]);
  return { persisted: true, revision, observationId: revision, observedAt: saved.observedAt,
    firstFetchedAt: saved.firstFetchedAt, receivedAt: saved.receivedAt,
    adoptedPeriods: results[5].map(row => row.period), quoteGeneration: String(results[6][0].quote_generation),
    timeEvidence: saved.timeEvidence, historicalAvailabilityVerified: false };
}
