import { randomBytes } from 'node:crypto';
import { soccerJournalQuery, soccerJournalTransaction, ensureSoccerJournal } from './journal.js';
import { soccerLeague, validSoccerDate } from './contracts.js';
import { validateRetrospectiveReaderReceipt } from './retrospective-reader-receipts.js';

// A bounded count of immutable receipts, never a match-identity or scoring proof.
export const SOCCER_READER_INVENTORY_SCAN_VERSION='SOCCER-READER-INVENTORY-SCAN-v1';
export const SOCCER_READER_INVENTORY_SCAN_SCHEMA=[
 `CREATE TABLE IF NOT EXISTS sports_soccer_reader_inventory_scope_v1 (
  league TEXT NOT NULL,board_date DATE NOT NULL,created_count INTEGER NOT NULL CHECK(created_count BETWEEN 1 AND 1000),
  PRIMARY KEY(league,board_date))`,
 `CREATE TABLE IF NOT EXISTS sports_soccer_reader_inventory_scans_v1 (
  cursor TEXT PRIMARY KEY,league TEXT NOT NULL,board_date DATE NOT NULL,version TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  observed_count INTEGER NOT NULL,expected_count INTEGER,verified_count INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL CHECK(status IN ('RUNNING','COMPLETE','PARTIAL')),
  reason_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
  CHECK(verified_count>=0 AND (expected_count IS NULL OR verified_count<=expected_count)),
  CHECK(status<>'COMPLETE' OR (expected_count IS NOT NULL AND verified_count=expected_count)))`,
 `CREATE TABLE IF NOT EXISTS sports_soccer_reader_inventory_items_v1 (
  cursor TEXT NOT NULL REFERENCES sports_soccer_reader_inventory_scans_v1(cursor),
  ordinal BIGINT NOT NULL,observation_id TEXT NOT NULL,periods JSONB NOT NULL,
  PRIMARY KEY(cursor,ordinal),UNIQUE(cursor,observation_id))`,
 `CREATE OR REPLACE FUNCTION sports_soccer_reader_inventory_scope_guard_v1() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'READER_MANIFEST_IMMUTABLE'; END IF;
    IF NEW.league<>OLD.league OR NEW.board_date<>OLD.board_date OR NEW.created_count<>OLD.created_count+1
      THEN RAISE EXCEPTION 'READER_MANIFEST_IMMUTABLE'; END IF;
    RETURN NEW;
  END $$`,
 `CREATE OR REPLACE TRIGGER sports_soccer_reader_inventory_scope_guard_v1 BEFORE UPDATE OR DELETE
  ON sports_soccer_reader_inventory_scope_v1 FOR EACH ROW EXECUTE FUNCTION sports_soccer_reader_inventory_scope_guard_v1()`,
 `CREATE OR REPLACE FUNCTION sports_soccer_reader_inventory_item_guard_v1() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION 'READER_MANIFEST_IMMUTABLE';
  END $$`,
 `CREATE OR REPLACE TRIGGER sports_soccer_reader_inventory_item_guard_v1 BEFORE UPDATE OR DELETE
  ON sports_soccer_reader_inventory_items_v1 FOR EACH ROW EXECUTE FUNCTION sports_soccer_reader_inventory_item_guard_v1()`,
 `CREATE OR REPLACE FUNCTION sports_soccer_reader_inventory_job_guard_v1() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'READER_MANIFEST_IMMUTABLE'; END IF;
    IF NEW.cursor<>OLD.cursor OR NEW.league<>OLD.league OR NEW.board_date<>OLD.board_date OR NEW.version<>OLD.version
      OR NEW.started_at<>OLD.started_at OR NEW.observed_count<>OLD.observed_count
      OR NEW.expected_count IS DISTINCT FROM OLD.expected_count OR OLD.status<>'RUNNING'
      OR NEW.revision<>OLD.revision+1 OR NEW.verified_count<OLD.verified_count
      THEN RAISE EXCEPTION 'READER_MANIFEST_IMMUTABLE'; END IF;
    RETURN NEW;
  END $$`,
 `CREATE OR REPLACE TRIGGER sports_soccer_reader_inventory_job_guard_v1 BEFORE UPDATE OR DELETE
  ON sports_soccer_reader_inventory_scans_v1 FOR EACH ROW EXECUTE FUNCTION sports_soccer_reader_inventory_job_guard_v1()`,
];
const flags=Object.freeze({identityVerified:false,formalEligible:false,calibrationEligible:false,promotionEligible:false,executable:false,OOS:false,selectedPairCount:null,W:null,R:null,S:null});
const bad=()=>Object.assign(Error('READER_INVENTORY_SCOPE_INVALID'),{status:400});
const token=value=>typeof value==='string'&&/^[a-f0-9]{48}$/.test(value);
function validScope(league,date){return ['epl','ucl'].includes(league)&&soccerLeague(league)?.id===league&&validSoccerDate(date);}
let ready;
async function ensure(){return ready||=(async()=>{await ensureSoccerJournal();await soccerJournalTransaction([
 ['SELECT pg_advisory_xact_lock(221019,2311)'],...SOCCER_READER_INVENTORY_SCAN_SCHEMA.map(sql=>[sql])]);})().catch(error=>{ready=null;throw error;});}
const number=value=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<0)throw Error('READER_INVENTORY_STATE_INVALID');return n;};
const view=row=>({version:SOCCER_READER_INVENTORY_SCAN_VERSION,cursor:row.cursor,league:row.league,date:row.board_date,
 status:row.status,totalCount:row.expected_count==null?null:number(row.expected_count),verifiedCount:number(row.verified_count),
 observedCount:number(row.observed_count),reasonCodes:Array.isArray(row.reason_codes)?row.reason_codes:[],
 scopeDescription:'READER_RECEIPTS_VISIBLE_AT_MANIFEST_STATEMENT_ONLY',identityScope:'FULL_DATE_OFFICIAL_SCHEDULE_NOT_VERIFIED',...flags});

/** Snapshot ID and period bindings in ONE SQL statement. No caller clock or
 * timestamp high-water is used. Records committing later cannot enter it. */
export async function startReaderInventoryScan({league,date,cursor:requestedCursor}={}, {query=soccerJournalQuery,ensure:ensureStore=ensure,maxReceipts=5000,maxScansPerScope=Number(process.env.SOCCER_READER_INVENTORY_MAX_SCANS_PER_SCOPE || 30)}={}){
 if(!validScope(league,date)||typeof query!=='function'||typeof ensureStore!=='function'||!Number.isSafeInteger(maxReceipts)||maxReceipts<1||maxReceipts>10000
  ||!Number.isSafeInteger(maxScansPerScope)||maxScansPerScope<1||maxScansPerScope>1000||(requestedCursor!==undefined&&!token(requestedCursor)))throw bad();
 await ensureStore();
 const cursor=requestedCursor||randomBytes(24).toString('hex');
 const getExisting=async()=>{const rows=await query(`SELECT cursor,lower(league) AS league,board_date::text,version,observed_count,expected_count,verified_count,revision,status,reason_codes
 FROM sports_soccer_reader_inventory_scans_v1 WHERE cursor=$1`,[cursor]);
 if(!rows[0])return null;
 if(rows[0].league!==league||rows[0].board_date!==date||rows[0].version!==SOCCER_READER_INVENTORY_SCAN_VERSION)throw bad();
 return view(rows[0]);};
 const existing=await getExisting();if(existing)return existing;
 try { await query(`WITH candidates AS MATERIALIZED (
   SELECT o.observation_id,o.received_at,
     COALESCE((SELECT jsonb_agg(jsonb_build_object('period',p.period,'contentHash',p.content_hash) ORDER BY p.period)
       FROM sports_soccer_reader_period_observations_v2 p WHERE p.observation_id=o.observation_id),
       CASE WHEN NOT (o.payload ? 'periodsCovered') THEN jsonb_build_array(jsonb_build_object('period','UNKNOWN','contentHash',o.content_hash)) ELSE '[]'::jsonb END) AS periods
   FROM sports_soccer_reader_observations_v2 o WHERE o.league=$1 AND o.board_date=$2::date
   ORDER BY o.received_at,o.observation_id LIMIT ($4::integer+1)
 ), bounds AS MATERIALIZED (SELECT count(*)::integer n FROM candidates), permit AS (
   INSERT INTO sports_soccer_reader_inventory_scope_v1(league,board_date,created_count) VALUES($1,$2::date,1)
   ON CONFLICT(league,board_date) DO UPDATE SET created_count=sports_soccer_reader_inventory_scope_v1.created_count+1
   WHERE sports_soccer_reader_inventory_scope_v1.created_count<$6 RETURNING created_count
 ), job AS (
   INSERT INTO sports_soccer_reader_inventory_scans_v1(cursor,league,board_date,version,observed_count,expected_count,status,reason_codes)
   SELECT $3,$1,$2::date,$5,n,CASE WHEN n<=$4 THEN n ELSE NULL END,
     CASE WHEN n>$4 THEN 'PARTIAL' WHEN n=0 THEN 'COMPLETE' ELSE 'RUNNING' END,
     CASE WHEN n>$4 THEN '["READER_MANIFEST_ROW_BUDGET"]'::jsonb ELSE '[]'::jsonb END FROM bounds CROSS JOIN permit RETURNING cursor
 ), items AS (
   INSERT INTO sports_soccer_reader_inventory_items_v1(cursor,ordinal,observation_id,periods)
   SELECT job.cursor,row_number() OVER(ORDER BY c.received_at,c.observation_id),c.observation_id,c.periods
   FROM candidates c CROSS JOIN job CROSS JOIN bounds WHERE bounds.n<=$4 RETURNING ordinal
 ) SELECT job.cursor,(SELECT count(*) FROM items)::integer AS inserted FROM job`,[league.toUpperCase(),date,cursor,maxReceipts,SOCCER_READER_INVENTORY_SCAN_VERSION,maxScansPerScope]);
 } catch(error) { const retry=await getExisting();if(retry)return retry;throw error; }
 // Scope uses normalized lower-case in the application, uppercase in reader DB.
 const result=await getExisting();
 if(!result)return {version:SOCCER_READER_INVENTORY_SCAN_VERSION,cursor:null,league,date,status:'PARTIAL',totalCount:null,
  observedCount:null,verifiedCount:0,reasonCodes:['READER_MANIFEST_SCOPE_BUDGET'],scopeDescription:'NOT_STARTED_SCOPE_LIMIT',
  identityScope:'FULL_DATE_OFFICIAL_SCHEDULE_NOT_VERIFIED',...flags};
 return result;
}

/** Continue one page. CAS on revision means concurrent/replayed requests never
 * count a page twice. Nothing from the source payload escapes this function. */
export async function continueReaderInventoryScan({cursor,league,date}={}, {query=soccerJournalQuery,ensure:ensureStore=ensure,maxPageRows=50,maxPageBytes=4*1024*1024}={}){
 if(!token(cursor)||!validScope(league,date)||typeof query!=='function'||typeof ensureStore!=='function'
   ||!Number.isSafeInteger(maxPageRows)||maxPageRows<1||maxPageRows>100||!Number.isSafeInteger(maxPageBytes)||maxPageBytes<2||maxPageBytes>16*1024*1024)throw bad();
 await ensureStore();
 // getJob compares stored uppercase DB scope; normalize the returned scope.
 const jobRows=await query(`SELECT cursor,lower(league) AS league,board_date::text,version,observed_count,expected_count,verified_count,revision,status,reason_codes
 FROM sports_soccer_reader_inventory_scans_v1 WHERE cursor=$1 AND league=$2 AND board_date=$3::date`,[cursor,league.toUpperCase(),date]);
 const job=jobRows[0];if(!job||job.version!==SOCCER_READER_INVENTORY_SCAN_VERSION)throw bad();
 if(job.status!=='RUNNING')return view(job);
 const verified=number(job.verified_count),expected=number(job.expected_count),revision=number(job.revision);
 const meta=await query(`SELECT m.ordinal::text,m.observation_id,CASE WHEN o.observation_id IS NULL THEN NULL
  ELSE octet_length(o.payload::text)+octet_length(m.periods::text)+octet_length(to_jsonb(m.observation_id)::text)+octet_length(to_jsonb(o.content_hash)::text)+1024 END AS bytes
 FROM sports_soccer_reader_inventory_items_v1 m LEFT JOIN sports_soccer_reader_observations_v2 o ON o.observation_id=m.observation_id
 WHERE m.cursor=$1 AND m.ordinal>$2::bigint ORDER BY m.ordinal LIMIT $3`,[cursor,verified,maxPageRows]);
 let reason=null,bytes=0,through=verified;
 if(!meta.length&&verified<expected)reason='READER_MANIFEST_ITEM_MISSING';
 for(const row of meta){const ordinal=number(row.ordinal),size=row.bytes==null?null:number(row.bytes);
   if(ordinal!==through+1){reason='READER_MANIFEST_ITEM_MISSING';break;}
   if(size==null){reason='READER_ORIGINAL_RECEIPT_MISSING';break;}
   if(bytes+size>maxPageBytes){if(through===verified)reason='READER_RECEIPT_BYTE_BUDGET';break;}
   bytes+=size;through=ordinal;
 }
 if(through>expected)reason='READER_MANIFEST_ITEM_MISMATCH';
 if(!reason&&through>verified){
   let rows;
   try { rows=await query(`SELECT m.ordinal::text,m.observation_id AS "observationId",o.content_hash AS "contentHash",
     to_char(o.source_observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "sourceObservedAt",
     to_char((o.payload->>'observedAt')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "payloadObservedAt",
     to_char(o.received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "receivedAt",
     to_char(o.persisted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "persistedAt",m.periods,o.payload
     FROM sports_soccer_reader_inventory_items_v1 m LEFT JOIN sports_soccer_reader_observations_v2 o ON o.observation_id=m.observation_id
     WHERE m.cursor=$1 AND m.ordinal>$2::bigint AND m.ordinal<=$3::bigint ORDER BY m.ordinal`,[cursor,verified,through]);
   } catch { reason='READER_SOURCE_READ_UNAVAILABLE'; }
   if(!reason && rows.length!==through-verified)reason='READER_MANIFEST_ITEM_MISSING';
   else if(!reason)try{for(const [i,row] of rows.entries()){
      if(number(row.ordinal)!==verified+i+1||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(row.receivedAt||'')
       ||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(row.persistedAt||'')||row.receivedAt>row.persistedAt)throw Error('CLOCK');
      validateRetrospectiveReaderReceipt(row,league,date);
   }}catch{reason='READER_RECEIPT_INVALID_OR_CLOCK_CONFLICT';}
 }
 if(!reason&&through===verified&&verified<expected)reason='READER_PAGE_UNAVAILABLE';
 const status=reason?'PARTIAL':through===expected?'COMPLETE':'RUNNING';
 const rows=await query(`UPDATE sports_soccer_reader_inventory_scans_v1 SET verified_count=$4,revision=revision+1,status=$5,reason_codes=$6::jsonb
 WHERE cursor=$1 AND league=$2 AND board_date=$3::date AND revision=$7 AND status='RUNNING'
 RETURNING cursor,lower(league) AS league,board_date::text,version,observed_count,expected_count,verified_count,revision,status,reason_codes`,
 [cursor,league.toUpperCase(),date,reason?verified:through,status,JSON.stringify(reason?[reason]:[]),revision]);
 if(rows[0])return view(rows[0]);
 // A concurrent worker may have committed the exact same page. Return the
 // actual persisted state, never a client-computed sum.
 const latest=await query(`SELECT cursor,lower(league) AS league,board_date::text,version,observed_count,expected_count,verified_count,revision,status,reason_codes
 FROM sports_soccer_reader_inventory_scans_v1 WHERE cursor=$1 AND league=$2 AND board_date=$3::date`,[cursor,league.toUpperCase(),date]);
 if(!latest[0])throw bad();return view(latest[0]);
}
