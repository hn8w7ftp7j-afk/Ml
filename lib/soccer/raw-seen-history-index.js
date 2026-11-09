import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { durableDatabaseUrl } from '../database-url.js';
import { canonicalReaderSeenCapture, readReaderSeenCaptureBatch } from '../reader-seen-capture.js';
import { deriveRawSeenSoccerHistory, RAW_SEEN_DERIVATION_VERSION, RAW_SEEN_READABLE_DERIVATION_VERSIONS, RAW_SEEN_HISTORY_FLAGS } from './raw-seen-history.js';

export const RAW_HISTORY_INDEX_SCHEMA = 'soccer-raw-history-index-v1';
const HASH=/^[a-f0-9]{64}$/, LEAGUES=['EPL','UCL'];
const fail=(code,status=422)=>Object.assign(Error(code),{code,status});
const check=(ok,code,status)=>{if(!ok)throw fail(code,status);};
const validDate=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
const validTime=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:\d{3})?Z$/.test(v)&&Number.isFinite(Date.parse(v));
const stamp=v=>v instanceof Date?v.toISOString():String(v);
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
let client;const schemas=new WeakMap();
function database(options){if(options.db)return options.db;const url=durableDatabaseUrl();check(url,'RAW_HISTORY_INDEX_STORAGE_UNAVAILABLE',503);return client||=neon(url);}
const flags={...RAW_SEEN_HISTORY_FLAGS,formalEligible:false,calibrationEligible:false,identityVerified:false};
export const RAW_HISTORY_INDEX_DDL=[
 `CREATE TABLE IF NOT EXISTS soccer_raw_seen_history_batches_v1 (batch_hash CHAR(64) NOT NULL, derivation_version TEXT NOT NULL, derived_hash CHAR(64) NOT NULL, capture_id CHAR(64) NOT NULL, league TEXT NOT NULL CHECK(league IN ('EPL','UCL')), observed_at TIMESTAMPTZ NOT NULL, source_received_at TIMESTAMPTZ NOT NULL, source_persisted_at TIMESTAMPTZ NOT NULL, metadata JSONB NOT NULL, indexed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(batch_hash,derivation_version))`,
 `CREATE TABLE IF NOT EXISTS soccer_raw_seen_history_games_v1 (batch_hash CHAR(64) NOT NULL, derivation_version TEXT NOT NULL, league TEXT NOT NULL CHECK(league IN ('EPL','UCL')), board_date DATE NOT NULL, game_key TEXT NOT NULL, metadata JSONB NOT NULL, PRIMARY KEY(batch_hash,derivation_version,league,board_date,game_key), FOREIGN KEY(batch_hash,derivation_version) REFERENCES soccer_raw_seen_history_batches_v1(batch_hash,derivation_version))`,
 `CREATE INDEX IF NOT EXISTS soccer_raw_seen_history_games_scope_v1 ON soccer_raw_seen_history_games_v1(league,board_date,game_key,batch_hash)`,
 `CREATE OR REPLACE FUNCTION reject_soccer_raw_seen_history_index_mutation_v1() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'RAW_HISTORY_INDEX_IMMUTABLE'; END $$`,
 `CREATE OR REPLACE TRIGGER soccer_raw_history_batches_immutable_v1 BEFORE UPDATE OR DELETE ON soccer_raw_seen_history_batches_v1 FOR EACH ROW EXECUTE FUNCTION reject_soccer_raw_seen_history_index_mutation_v1()`,
 `CREATE OR REPLACE TRIGGER soccer_raw_history_games_immutable_v1 BEFORE UPDATE OR DELETE ON soccer_raw_seen_history_games_v1 FOR EACH ROW EXECUTE FUNCTION reject_soccer_raw_seen_history_index_mutation_v1()`,
];
async function ensure(db){if(!schemas.has(db))schemas.set(db,db.transaction(RAW_HISTORY_INDEX_DDL.map(sql=>db.query(sql,[])),{isolationLevel:'ReadCommitted'}).catch(e=>{schemas.delete(db);throw e;}));await schemas.get(db);}
function validateScope(value,{scan=false}={}){
 check(value&&LEAGUES.includes(value.league),'RAW_HISTORY_INDEX_QUERY_INVALID',400);
 const {from,through}=value;
 check(validDate(from)&&validDate(through)&&from<=through&&(Date.parse(through)-Date.parse(from))/86400000<=(scan?6:30),'RAW_HISTORY_INDEX_QUERY_INVALID',400);
 if(value.gameKey!==undefined&&value.gameKey!==null)check(typeof value.gameKey==='string'&&value.gameKey.length>0&&value.gameKey.length<=200&&!/[\u0000-\u001f\u007f]/.test(value.gameKey),'RAW_HISTORY_INDEX_QUERY_INVALID',400);
 return {league:value.league,from,through,gameKey:value.gameKey||null};
}
export function parseRawHistoryIndexQuery(params){
 check([...params.keys()].every(k=>['league','from','through','gameKey','after'].includes(k)&&params.getAll(k).length===1),'RAW_HISTORY_INDEX_QUERY_INVALID',400);
 return {...validateScope(Object.fromEntries(params)),after:params.get('after')};
}
function secret(options){const s=options.secret??process.env.SESSION_SECRET;check(typeof s==='string'&&s.length>=16,'RAW_HISTORY_INDEX_CURSOR_UNAVAILABLE',503);return s;}
function encode(body,options){const encoded=Buffer.from(JSON.stringify(body)).toString('base64url');return encoded+'.'+createHmac('sha256',secret(options)).update('RAW-HISTORY-INDEX-v1\n'+encoded).digest('base64url');}
function decode(token,scope,kind,options){
 check(typeof token==='string'&&token.length<=1800&&/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token),'RAW_HISTORY_INDEX_CURSOR_INVALID',400);
 const [body,sig]=token.split('.'),expected=createHmac('sha256',secret(options)).update('RAW-HISTORY-INDEX-v1\n'+body).digest('base64url');check(timingSafeEqual(Buffer.from(sig),Buffer.from(expected)),'RAW_HISTORY_INDEX_CURSOR_INVALID',400);
 let v;try{v=JSON.parse(Buffer.from(body,'base64url').toString());}catch{throw fail('RAW_HISTORY_INDEX_CURSOR_INVALID',400);}
 check(v.version===1&&v.derivationVersion===RAW_SEEN_DERIVATION_VERSION&&v.kind===kind&&v.scope===hash(scope)&&validTime(v.until)&&Date.parse(v.until)<=(options.now??Date.now()),'RAW_HISTORY_INDEX_CURSOR_INVALID',400);return v;
}
export async function indexRawSeenHistoryCapture(captureId,options={}){
 check(HASH.test(captureId||''),'RAW_HISTORY_INDEX_QUERY_INVALID',400);
 const db=database(options),parts=await readReaderSeenCaptureBatch(captureId,{...options,sql:db}),derived=deriveRawSeenSoccerHistory(parts,{now:options.now??Date.now()});
 if(options.sourceCutoff)check(parts.every(p=>p.persistedAt.replace(/\.(\d{3})Z$/,(_,n)=>'.'+n+'000Z')<=options.sourceCutoff.replace(/\.(\d{3})Z$/,(_,n)=>'.'+n+'000Z')),'RAW_HISTORY_INDEX_SOURCE_AFTER_CUTOFF');
 check(derived.games.every(g=>g.markets.length<=200),'RAW_HISTORY_INDEX_MARKET_BUDGET_EXCEEDED',413);
 const first=[...parts].sort((a,b)=>(a.partIndex??0)-(b.partIndex??0))[0];
 const capture={captureId:first.captureId,captureBatchId:first.captureBatchId,league:first.league,observedAt:first.observedAt,evidenceHash:first.evidenceHash};
 const metadata={schema:RAW_HISTORY_INDEX_SCHEMA,derivationVersion:derived.derivationVersion,derivedHash:derived.derivedHash,capture,parts:derived.parts};
 const games=derived.games.map(g=>({league:g.league,boardDate:g.boardDate,gameKey:[g.boardTime,g.awayKey,g.homeKey].join('|'),boardTime:g.boardTime,awayRaw:g.awayRaw,homeRaw:g.homeRaw,awayKey:g.awayKey,homeKey:g.homeKey,marketCount:g.markets.length,unavailableMarketCount:g.unavailableMarkets?.length||0,periods:[...new Set(g.markets.map(m=>m.period))],identityStatus:g.identityStatus,executable:false}));
 await ensure(db);
 // Both immutable tables are inserted atomically. Source captures are only read.
 await db.transaction([
 db`INSERT INTO soccer_raw_seen_history_batches_v1(batch_hash,derivation_version,derived_hash,capture_id,league,observed_at,source_received_at,source_persisted_at,metadata) VALUES(${derived.captureBatchId},${derived.derivationVersion},${derived.derivedHash},${first.captureId},${derived.league},${derived.observedAt}::timestamptz,${derived.receivedAt}::timestamptz,${derived.persistedAt}::timestamptz,${JSON.stringify(metadata)}::jsonb) ON CONFLICT(batch_hash,derivation_version) DO NOTHING`,
 db`INSERT INTO soccer_raw_seen_history_games_v1(batch_hash,derivation_version,league,board_date,game_key,metadata) SELECT ${derived.captureBatchId},${derived.derivationVersion},x->>'league',(x->>'boardDate')::date,x->>'gameKey',x FROM jsonb_array_elements(${JSON.stringify(games)}::jsonb) x ON CONFLICT DO NOTHING`,
 ]);
 const saved=await db`SELECT b.metadata,b.derived_hash,to_char(b.indexed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS indexed_at,(SELECT jsonb_agg(g.metadata ORDER BY g.board_date,g.game_key) FROM soccer_raw_seen_history_games_v1 g WHERE g.batch_hash=b.batch_hash AND g.derivation_version=b.derivation_version) AS games FROM soccer_raw_seen_history_batches_v1 b WHERE b.batch_hash=${derived.captureBatchId} AND b.derivation_version=${derived.derivationVersion}`;
 check(saved.length===1&&saved[0].derived_hash?.trim()===derived.derivedHash&&canonicalReaderSeenCapture(saved[0].metadata)===canonicalReaderSeenCapture(metadata)&&canonicalReaderSeenCapture([...(saved[0].games||[])].sort((a,b)=>a.boardDate.localeCompare(b.boardDate)||a.gameKey.localeCompare(b.gameKey)))===canonicalReaderSeenCapture([...games].sort((a,b)=>a.boardDate.localeCompare(b.boardDate)||a.gameKey.localeCompare(b.gameKey))),'RAW_HISTORY_INDEX_READBACK_FAILED',503);
 return {ok:true,schema:RAW_HISTORY_INDEX_SCHEMA,...flags,indexedGames:games.length,indexedAt:stamp(saved[0].indexed_at),observedAt:derived.observedAt,sourcePersistedAt:derived.persistedAt,captureBatchId:derived.captureBatchId,derivedHash:derived.derivedHash};
}
export async function queryRawHistoryIndex(query,options={}){
 const scope=validateScope(query),db=database(options),after=query.after?decode(query.after,scope,'LIST',options):null;
 const until=after?.until||new Date(options.now??Date.now()).toISOString();
 if(after)check(typeof after.boardDate==='string'&&validDate(after.boardDate)&&typeof after.gameKey==='string'&&HASH.test(after.batch||''),'RAW_HISTORY_INDEX_CURSOR_INVALID',400);
 let rows;
 // Select one immutable derivation per original batch at the original query
 // cutoff. New versions do not hide un-reindexed archives or change later
 // pages when a maintenance job appends a newer derivation mid-query.
 try{rows=await db`WITH selected_batches AS (SELECT DISTINCT ON (batch_hash) * FROM soccer_raw_seen_history_batches_v1 WHERE league=${scope.league} AND indexed_at<=${until}::timestamptz AND derivation_version=ANY(${RAW_SEEN_READABLE_DERIVATION_VERSIONS}::text[]) ORDER BY batch_hash,(derivation_version=${RAW_SEEN_DERIVATION_VERSION}) DESC,derivation_version DESC), filtered AS (SELECT g.*,b.metadata AS batch_metadata,b.derived_hash,b.observed_at,b.source_received_at,b.source_persisted_at,b.indexed_at FROM soccer_raw_seen_history_games_v1 g JOIN selected_batches b USING(batch_hash,derivation_version) WHERE g.league=${scope.league} AND g.board_date>=${scope.from}::date AND g.board_date<=${scope.through}::date AND (${scope.gameKey}::text IS NULL OR g.game_key=${scope.gameKey}) AND b.indexed_at<=${until}::timestamptz AND (${after?.boardDate??null}::date IS NULL OR (g.board_date,g.game_key,g.batch_hash)>(${after?.boardDate??null}::date,${after?.gameKey??null}::text,${after?.batch??null}::char(64))) ORDER BY g.board_date,g.game_key,g.batch_hash LIMIT 51) SELECT *,board_date::text AS board_date_text,to_char(observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed_at_exact,to_char(indexed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS indexed_at_exact,to_char(source_received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS source_received_at_exact,to_char(source_persisted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS source_persisted_at_exact FROM filtered ORDER BY board_date,game_key,batch_hash`;}
 catch(e){if(e.code==='42P01')return {ok:true,schema:RAW_HISTORY_INDEX_SCHEMA,...flags,status:'NOT_INITIALIZED',filters:scope,until,entries:[],hasMore:false,nextAfter:null,indexCoverage:'NOT_VERIFIED'};throw e;}
 const page=rows.slice(0,50),entries=page.map(r=>{const m=r.metadata,b=r.batch_metadata;check(m?.league===scope.league&&m.boardDate===r.board_date_text&&m.gameKey===r.game_key&&b?.schema===RAW_HISTORY_INDEX_SCHEMA&&RAW_SEEN_READABLE_DERIVATION_VERSIONS.includes(b.derivationVersion)&&b.derivationVersion===r.derivation_version&&b.derivedHash===r.derived_hash?.trim()&&b.capture?.league===scope.league&&HASH.test(b.capture.captureId),'RAW_HISTORY_INDEX_READBACK_FAILED',503);return {...m,capture:b.capture,captureBatchId:r.batch_hash.trim(),derivedHash:b.derivedHash,derivationVersion:b.derivationVersion,sourceReceivedAt:r.source_received_at_exact,sourcePersistedAt:r.source_persisted_at_exact,observedAt:r.observed_at_exact,indexedAt:r.indexed_at_exact,...flags};});
 const hasMore=rows.length>50,last=page.at(-1);return {ok:true,schema:RAW_HISTORY_INDEX_SCHEMA,...flags,status:'INDEXED_HISTORY_ONLY',filters:scope,until,entries,hasMore,nextAfter:hasMore?encode({version:1,derivationVersion:RAW_SEEN_DERIVATION_VERSION,kind:'LIST',scope:hash(scope),until,boardDate:last.board_date_text,gameKey:last.game_key,batch:last.batch_hash.trim()},options):null,indexCoverage:'NOT_VERIFIED'};
}
export async function scanRawHistoryIndex(input,options={}){
 const scope=validateScope(input,{scan:true}),db=database(options),cursor=input.after?decode(input.after,scope,'SCAN',options):null;
 const until=cursor?.until||new Date(options.now??Date.now()).toISOString();
 if(cursor)check(validTime(cursor.persistedAt)&&HASH.test(cursor.batch||''),'RAW_HISTORY_INDEX_CURSOR_INVALID',400);
 const scanRows=await db.transaction([db`SELECT set_config('statement_timeout','5000',true)`,db`WITH groups AS (SELECT league,coalesce(capture_batch_id,capture_id) AS batch_key,min(capture_id) AS seed,max(persisted_at) AS persisted_at FROM sports_reader_seen_captures_v1 WHERE league=${scope.league} AND source_observed_at>=(${scope.from}::date::timestamp AT TIME ZONE 'Asia/Taipei') AND source_observed_at<((${scope.through}::date+1)::timestamp AT TIME ZONE 'Asia/Taipei') AND persisted_at<=${until}::timestamptz GROUP BY league,coalesce(capture_batch_id,capture_id)) SELECT *,to_char(persisted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS persisted_at_exact FROM groups WHERE (${cursor?.persistedAt??null}::timestamptz IS NULL OR (persisted_at,batch_key)<(${cursor?.persistedAt??null}::timestamptz,${cursor?.batch??null}::char(64))) ORDER BY persisted_at DESC,batch_key DESC LIMIT 2`]);
 const rows=scanRows[1];
 if(!rows.length)return {ok:true,schema:RAW_HISTORY_INDEX_SCHEMA,...flags,status:'WINDOW_EXHAUSTED',scanScope:scope,until,indexedGames:0,hasMore:false,nextAfter:null,completeWithinWindow:false,concurrentSourceCommitsVerified:false};
 const row=rows[0];let result,reason=null;
 try{result=await indexRawSeenHistoryCapture(row.seed.trim(),{...options,db,sourceCutoff:until});}
 catch(e){if(e.status!==422&&e.status!==413)throw e;reason=e.code;}
 const next=encode({version:1,derivationVersion:RAW_SEEN_DERIVATION_VERSION,kind:'SCAN',scope:hash(scope),until,persistedAt:row.persisted_at_exact,batch:row.batch_key.trim()},options);
 return {ok:true,schema:RAW_HISTORY_INDEX_SCHEMA,...flags,status:reason?'SOURCE_UNINDEXED':'PARTIAL',scanScope:scope,until,indexedGames:result?.indexedGames??0,captureId:row.seed.trim(),reason,hasMore:rows.length>1,nextAfter:rows.length>1?next:null,completeWithinWindow:false,concurrentSourceCommitsVerified:false,notice:'One bounded batch checked. Observation dates differ from board dates; exhausted pages do not certify complete games, quotes or closing lines.'};
}

// Only authenticated index writes and the independent maintenance job initialize
// derived storage. The historical GET deliberately remains SELECT-only.
export async function initializeRawHistoryIndexStore(options={}) { await ensure(database(options)); }
