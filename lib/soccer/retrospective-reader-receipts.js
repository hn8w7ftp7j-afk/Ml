// Server-only research input. Never return these rows or payloads from an API.
// This is a read of one PostgreSQL snapshot; it neither initializes nor mutates storage.
import { createHash } from 'node:crypto';
import { soccerLeague, validSoccerDate } from './contracts.js';
import { soccerJournalHash, soccerJournalQuery } from './journal.js';
import { soccerReaderHash } from './reader.js';
import { canonicalSoccerPayload } from '../../reader/soccer-parser.js';
import { soccerReaderMatchTeamKey } from './reader-team-identity.js';
import { soccerTeamLabel } from './team-labels.js';

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

/** Freeze immutable metadata in one MVCC statement, then verify whole original
 * documents in bounded pages. Projection happens only AFTER original hash and
 * period validation; a selected-game slice is never hashed as an original. */
export async function loadSoccerRetrospectiveGameReaderReceipts(league,date,game,{maxRows=1000,maxTotalBytes=128*1024*1024,
  pageBytes=2*1024*1024,budgetMs=40000,query=soccerJournalQuery}={}){
  const id=soccerLeague(league)?.id;
  if(!id||league!==id||!validSoccerDate(date)||game?.league!==id||game?.date!==date||!game.id?.startsWith(`soccer:${id}:`)
    ||!Number.isSafeInteger(maxRows)||maxRows<1||maxRows>1000||!Number.isSafeInteger(maxTotalBytes)||maxTotalBytes<2||maxTotalBytes>128*1024*1024
    ||!Number.isSafeInteger(pageBytes)||pageBytes<1024||pageBytes>MAX_BYTES||!Number.isFinite(budgetMs)||budgetMs<=0||budgetMs>40000||typeof query!=='function')
    throw Error('SOCCER_RETROSPECTIVE_SCOPE_INVALID');
  const deadline=Date.now()+budgetMs;
  const read=async(statement,values)=>{
    const remaining=deadline-Date.now();if(remaining<=0)throw Error('READER_ORIGINAL_READ_TIME_BUDGET');
    let timer;
    try{return await Promise.race([query(statement,values),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('READER_ORIGINAL_READ_TIME_BUDGET')),remaining);})]);}
    finally{clearTimeout(timer);}
  };
  let manifestRows;
  try{manifestRows=await read(`WITH limited AS MATERIALIZED (
    SELECT o.observation_id,o.content_hash,o.source_observed_at,o.received_at,o.persisted_at,octet_length(o.payload::text) AS payload_bytes,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('period',p.period,'contentHash',p.content_hash) ORDER BY p.period)
        FROM sports_soccer_reader_period_observations_v2 p WHERE p.observation_id=o.observation_id),
        CASE WHEN NOT (o.payload ? 'periodsCovered') THEN jsonb_build_array(jsonb_build_object('period','UNKNOWN','contentHash',o.content_hash)) ELSE '[]'::jsonb END) AS periods
    FROM sports_soccer_reader_observations_v2 o WHERE o.league=$1 AND o.board_date=$2::date
    ORDER BY o.received_at,o.observation_id LIMIT ($3::integer+1)
  ), bounds AS (SELECT count(*) AS n,COALESCE(sum(payload_bytes),0) AS bytes,COALESCE(max(payload_bytes),0) AS largest FROM limited)
  SELECT n::text AS n,bytes::text AS bytes,largest::text AS largest,
    CASE WHEN n<=$3::integer AND bytes<=$4::integer AND largest<=$5::integer THEN COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'observationId',observation_id,'contentHash',content_hash,'sourceObservedAt',to_char(source_observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'receivedAt',to_char(received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'persistedAt',to_char(persisted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'periods',periods,'payloadBytes',payload_bytes)
      ORDER BY received_at,observation_id) FROM limited),'[]'::jsonb) ELSE '[]'::jsonb END AS items FROM bounds`,[id.toUpperCase(),date,maxRows,maxTotalBytes,MAX_BYTES-4096]);}
  catch{return{status:'PARTIAL',rows:[],observedCount:null,observedBytes:null,verifiedOriginalCount:0,reasonCodes:['READER_ORIGINAL_MANIFEST_READ_UNAVAILABLE_OR_TIMED_OUT']};}
  const manifest=manifestRows[0],count=Number(manifest?.n),bytes=Number(manifest?.bytes),largest=Number(manifest?.largest);
  const partial=(reason,verified=0)=>({status:'PARTIAL',rows:[],observedCount:Number.isSafeInteger(count)?count:null,observedBytes:Number.isSafeInteger(bytes)?bytes:null,
    verifiedOriginalCount:verified,countsDescribe:'FROZEN_IMMUTABLE_RECEIPT_MANIFEST',reasonCodes:[reason]});
  if(!manifest||!Array.isArray(manifest.items)||![count,bytes,largest].every(value=>Number.isSafeInteger(value)&&value>=0))throw Error('SOCCER_RETROSPECTIVE_RECEIPTS_UNAVAILABLE');
  if(count>maxRows)return partial('READER_RECEIPT_ROW_BUDGET');
  if(bytes>maxTotalBytes)return partial('READER_RECEIPT_TOTAL_BYTE_BUDGET');
  if(largest>MAX_BYTES-4096)return partial('READER_ORIGINAL_DOCUMENT_BYTE_BUDGET');
  if(manifest.items.length!==count||new Set(manifest.items.map(row=>row.observationId)).size!==count)throw Error('SOCCER_RETROSPECTIVE_RECEIPTS_UNAVAILABLE');
  const rows=[],page=[];let size=0,pages=0;
  const readPage=async()=>{
    if(!page.length)return true;
    if(Date.now()>=deadline)return false;
    const originals=await read(`WITH encoded AS MATERIALIZED (
      SELECT jsonb_build_object('observationId',o.observation_id,'contentHash',o.content_hash,
        'sourceObservedAt',to_char(o.source_observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'payloadObservedAt',to_char((o.payload->>'observedAt')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'receivedAt',to_char(o.received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'persistedAt',to_char(o.persisted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'payload',o.payload) AS item
      FROM sports_soccer_reader_observations_v2 o WHERE o.league=$1 AND o.board_date=$2::date AND o.observation_id=ANY($3::text[])
    ), bounds AS (SELECT count(*) AS n,COALESCE(sum(octet_length(item::text)),0)+GREATEST(count(*)-1,0)*2+2 AS bytes FROM encoded)
    SELECT n::text AS n,bytes::text AS bytes,CASE WHEN bytes<=$4::integer THEN COALESCE((SELECT jsonb_agg(item) FROM encoded),'[]'::jsonb) ELSE '[]'::jsonb END AS items FROM bounds`,
    [id.toUpperCase(),date,page.map(row=>row.observationId),MAX_BYTES]);
    const result=originals[0];
    if(!result||!Array.isArray(result.items)||Number(result.n)!==page.length||Number(result.bytes)>MAX_BYTES)throw Error('READER_ORIGINAL_PAGE_INCOMPLETE');
    const expected=new Map(page.map(row=>[row.observationId,row]));
    for(const original of result.items){
      const meta=expected.get(original.observationId);
      if(!meta||['contentHash','sourceObservedAt','receivedAt','persistedAt'].some(key=>meta[key]!==original[key]))throw Error('READER_ORIGINAL_MANIFEST_MISMATCH');
      const verified=validateRetrospectiveReaderReceipt({...original,periods:meta.periods},id,date);
      expected.delete(original.observationId);
      const selected=verified.payload.games.filter(raw=>raw.boardDate===date&&/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(raw.boardTime||'')
        &&new Date(`${date}T${raw.boardTime}:00+08:00`).toISOString()===game.startTime&&['home','away'].every(side=>
          soccerReaderMatchTeamKey(raw[`${side}Key`])===soccerReaderMatchTeamKey(soccerTeamLabel(game[side]))));
      const payload=Object.fromEntries(['league','boardDate','observedAt','sourceHost','pageUrl','periodsCovered'].filter(key=>Object.hasOwn(verified.payload,key)).map(key=>[key,verified.payload[key]]));
      rows.push({...verified,payload:{...payload,games:selected},fullPayloadHashVerified:true,payloadProjection:'POST_VALIDATION_SELECTED_GAME_ONLY'});
    }
    if(expected.size)throw Error('READER_ORIGINAL_PAGE_INCOMPLETE');
    pages++;page.length=0;size=0;return Date.now()<deadline;
  };
  try{
    for(const meta of manifest.items){
      if(page.length&&size+Number(meta.payloadBytes)>pageBytes&&!await readPage())return partial('READER_ORIGINAL_READ_TIME_BUDGET',rows.length);
      page.push(meta);size+=Number(meta.payloadBytes);
    }
    if(!await readPage())return partial('READER_ORIGINAL_READ_TIME_BUDGET',rows.length);
  }catch(error){return partial(/^READER_ORIGINAL_/.test(error?.message||'')?error.message:'READER_ORIGINAL_CONTENT_VALIDATION_FAILED',rows.length);}
  rows.sort((a,b)=>a.receivedAt.localeCompare(b.receivedAt)||a.observationId.localeCompare(b.observationId));
  return{status:'COMPLETE',rows,observedCount:count,observedBytes:bytes,verifiedOriginalCount:rows.length,rawPayloadPages:pages,
    originalManifestHash:soccerJournalHash(manifest.items),countsDescribe:'FROZEN_IMMUTABLE_RECEIPT_MANIFEST',
    payloadProjection:'POST_VALIDATION_SELECTED_GAME_ONLY',reasonCodes:[]};
}
