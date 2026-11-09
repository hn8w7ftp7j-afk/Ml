import { createHash } from 'node:crypto';
import { ensureSoccerJournal, soccerJournalQuery, soccerJournalTransaction } from './journal.js';
import { ensureSoccerSourceDocumentStore } from './source-document-store.js';
import { ensureSoccerObservationStore } from './observation-store.js';

export const SOCCER_MINUTES_FORWARD_STORE_VERSION = 'SOCCER-MINUTES-FORWARD-v1';
const restrictions = { accepted:false,formalEligible:false,promotionEligible:false,executable:false,W:null,R:null,S:null };
const canonical = value => JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)
  ?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
export const soccerMinutesForwardStorageHash = value => createHash('sha256').update(canonical(value)).digest('hex');
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const leagueValid=value=>['epl','ucl'].includes(value);
const instant=value=>typeof value==='string'&&/(?:Z|[+-]\d{2}:\d{2})$/.test(value)?Date.parse(value):NaN;
const iso=value=>new Date(value).toISOString();
const count=value=>Number.isSafeInteger(value)&&value>=0;
const sequence=value=>typeof value==='string'&&/^(?:0|[1-9]\d{0,17})$/.test(value);
const fail=code=>{throw Object.assign(Error(code),{status:503});};
const maxBodyBytes=2*1024*1024,maxCheckBytes=16*1024*1024,maxHistoryBytes=64*1024*1024;
const service=()=>import('./minutes-forward-validation.js');
const notCaptured=reason=>({version:SOCCER_MINUTES_FORWARD_STORE_VERSION,status:'NOT_CAPTURED',persisted:false,reason,...restrictions});
const schema=[
  `CREATE TABLE IF NOT EXISTS sports_soccer_minutes_forward_protocols_v1 (
    protocol_id TEXT PRIMARY KEY CHECK(protocol_id ~ '^[a-f0-9]{64}$'),league TEXT NOT NULL CHECK(league IN ('epl','ucl')),
    protocol_hash TEXT NOT NULL,protocol JSONB NOT NULL,registered_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),UNIQUE(league,protocol_hash))`,
  `CREATE TABLE IF NOT EXISTS sports_soccer_minutes_forward_captures_v1 (
    capture_id TEXT PRIMARY KEY CHECK(capture_id ~ '^[a-f0-9]{64}$'),capture_sequence BIGSERIAL UNIQUE NOT NULL,
    protocol_id TEXT NOT NULL REFERENCES sports_soccer_minutes_forward_protocols_v1(protocol_id),
    league TEXT NOT NULL CHECK(league IN ('epl','ucl')),game_id TEXT NOT NULL,board_date DATE NOT NULL,
    analysis_revision TEXT NOT NULL,analysis_cutoff TIMESTAMPTZ NOT NULL,
    source_receipt_id TEXT NOT NULL REFERENCES sports_soccer_source_document_observations_v1(receipt_id),
    source_hash TEXT NOT NULL,source_recorded_at TIMESTAMPTZ NOT NULL,kickoff_at TIMESTAMPTZ NOT NULL,
    body JSONB NOT NULL,body_hash TEXT NOT NULL,captured_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY(league,game_id,analysis_revision) REFERENCES sports_soccer_analysis_v1(league,game_id,analysis_hash),
    UNIQUE(protocol_id,league,game_id))`,
  `CREATE TABLE IF NOT EXISTS sports_soccer_minutes_forward_checks_v1 (
    check_id TEXT PRIMARY KEY CHECK(check_id ~ '^[a-f0-9]{64}$'),capture_id TEXT NOT NULL REFERENCES sports_soccer_minutes_forward_captures_v1(capture_id),
    league TEXT NOT NULL CHECK(league IN ('epl','ucl')),evidence_hash TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('PENDING','EVALUATED','QUARANTINED')),
    payload JSONB NOT NULL,payload_hash TEXT NOT NULL,checked_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),UNIQUE(capture_id,evidence_hash))`,
  `CREATE TABLE IF NOT EXISTS sports_soccer_minutes_forward_attempts_v1 (
    attempt_sequence BIGSERIAL PRIMARY KEY,capture_id TEXT NOT NULL REFERENCES sports_soccer_minutes_forward_captures_v1(capture_id),
    check_id TEXT NOT NULL REFERENCES sports_soccer_minutes_forward_checks_v1(check_id),source_observations JSONB NOT NULL,
    source_observations_hash TEXT NOT NULL,attempted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())`,
  `CREATE INDEX IF NOT EXISTS sports_soccer_minutes_forward_capture_scope_v1 ON sports_soccer_minutes_forward_captures_v1(league,protocol_id,capture_sequence)`,
  `CREATE INDEX IF NOT EXISTS sports_soccer_minutes_forward_attempt_scope_v1 ON sports_soccer_minutes_forward_attempts_v1(capture_id,attempted_at)`,
  ...['protocols','captures','checks','attempts'].map(table=>`CREATE OR REPLACE TRIGGER sports_soccer_minutes_forward_immutable_v1
    BEFORE UPDATE OR DELETE ON sports_soccer_minutes_forward_${table}_v1 FOR EACH ROW EXECUTE FUNCTION sports_soccer_immutable_v2()`),
];
let ready;
export async function ensureSoccerMinutesForwardStore(){
  return ready||=(async()=>{await ensureSoccerJournal();await ensureSoccerSourceDocumentStore();await ensureSoccerObservationStore();
    await soccerJournalTransaction([['SELECT pg_advisory_xact_lock(221019,2410)'],...schema.map(sql=>[sql])]);
  })().catch(error=>{ready=null;throw error;});
}
async function fixed(league){
  if(!leagueValid(league))throw Error('MINUTES_FORWARD_LEAGUE_INVALID');
  const protocol=(await service()).soccerMinutesForwardProtocol(league),hash=soccerMinutesForwardStorageHash(protocol);
  if(protocol?.version!==SOCCER_MINUTES_FORWARD_STORE_VERSION||protocol.league!==league||!sha(protocol.modelHash)
    ||!sha(protocol.artifactHash)||!Number.isFinite(instant(protocol.modelCreatedAt))
    ||Buffer.byteLength(canonical(protocol))>maxBodyBytes)fail('MINUTES_FORWARD_PROTOCOL_INVALID');
  return{protocol,hash,id:soccerMinutesForwardStorageHash([SOCCER_MINUTES_FORWARD_STORE_VERSION,league,hash])};
}
function protocolFromRow(row,expected){
  if(!row||row.protocol_id!==expected.id||row.league!==expected.protocol.league||row.protocol_hash!==expected.hash
    ||soccerMinutesForwardStorageHash(row.protocol)!==expected.hash||!Number.isFinite(new Date(row.registered_at).getTime())
    ||new Date(row.registered_at).getTime()<instant(expected.protocol.modelCreatedAt))fail('MINUTES_FORWARD_PROTOCOL_READBACK_INVALID');
  return{version:SOCCER_MINUTES_FORWARD_STORE_VERSION,status:'DATABASE_FROZEN',protocolId:row.protocol_id,
    protocolHash:row.protocol_hash,registeredAt:iso(row.registered_at),protocol:row.protocol,...restrictions};
}
async function readProtocol(expected){
  const rows=await soccerJournalQuery('SELECT * FROM sports_soccer_minutes_forward_protocols_v1 WHERE protocol_id=$1',[expected.id]);
  if(rows.length>1)fail('MINUTES_FORWARD_PROTOCOL_READBACK_INVALID');
  return rows.length?protocolFromRow(rows[0],expected):null;
}
export async function loadSoccerMinutesForwardProtocol(league){const expected=await fixed(league);await ensureSoccerMinutesForwardStore();return readProtocol(expected);}
export async function freezeSoccerMinutesForwardProtocol(league){
  const expected=await fixed(league);await ensureSoccerMinutesForwardStore();
  await soccerJournalQuery(`INSERT INTO sports_soccer_minutes_forward_protocols_v1(protocol_id,league,protocol_hash,protocol)
    SELECT $1,$2,$3,$4::jsonb WHERE clock_timestamp()>=$5::timestamptz ON CONFLICT DO NOTHING`,
  [expected.id,league,expected.hash,JSON.stringify(expected.protocol),expected.protocol.modelCreatedAt]);
  const receipt=await readProtocol(expected);if(!receipt)fail('MINUTES_FORWARD_PROTOCOL_NOT_FROZEN');return receipt;
}
const captureSelection=`SELECT c.*,(s.receipt_id IS NOT NULL AND s.league=c.league AND s.game_id=c.game_id
  AND s.content_hash=c.source_hash AND s.recorded_at=c.source_recorded_at AND s.recorded_at<=c.analysis_cutoff
  AND ar.run_id IS NOT NULL AND p.registered_at<ar.started_at AND p.registered_at<s.fetched_at
  AND s.fetched_at<=c.analysis_cutoff AND p.registered_at<c.analysis_cutoff
  AND jsonb_typeof(c.body->'observationReceipts')='array'
  AND jsonb_array_length(c.body->'observationReceipts') BETWEEN 1 AND 2
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c.body->'observationReceipts') r
    LEFT JOIN sports_soccer_observations_v1 o ON o.receipt_id=r->>'receiptId'
    WHERE o.receipt_id IS NULL OR o.league<>c.league OR o.game_id<>c.game_id OR o.field<>r->>'field'
      OR o.kind<>'PERSONNEL_RESEARCH' OR o.recorded_at>c.analysis_cutoff OR o.recorded_at<p.registered_at)
  AND c.analysis_cutoff<=c.captured_at AND c.captured_at<c.kickoff_at) AS time_bound
  FROM sports_soccer_minutes_forward_captures_v1 c
  JOIN sports_soccer_minutes_forward_protocols_v1 p USING(protocol_id)
  LEFT JOIN sports_soccer_source_document_observations_v1 s ON s.receipt_id=c.source_receipt_id
  LEFT JOIN sports_soccer_analysis_v1 a ON a.league=c.league AND a.game_id=c.game_id AND a.analysis_hash=c.analysis_revision
  LEFT JOIN sports_soccer_analysis_runs_v2 ar ON ar.run_id=a.payload->>'analysisRunId'
    AND ar.league=c.league AND ar.game_id=c.game_id AND ar.board_date=c.board_date`;
function captureFromRow(row,protocol){
  const body=row.body,game=body?.game;
  if(row.protocol_id!==protocol.protocolId||row.league!==protocol.protocol.league||row.time_bound!==true
    ||!sha(row.analysis_revision)||!sha(row.source_receipt_id)||!sha(row.source_hash)
    ||row.game_id!==game?.id||game.id!==`soccer:${row.league}:${game.sourceId}`
    ||game.league!==row.league||iso(row.kickoff_at)!==game.startTime
    ||(typeof row.board_date==='string'?row.board_date:iso(row.board_date).slice(0,10))!==game.date
    ||soccerMinutesForwardStorageHash(body)!==row.body_hash
    ||row.capture_id!==soccerMinutesForwardStorageHash([SOCCER_MINUTES_FORWARD_STORE_VERSION,protocol.protocolId,row.game_id]))
    fail('MINUTES_FORWARD_CAPTURE_READBACK_INVALID');
  return{version:SOCCER_MINUTES_FORWARD_STORE_VERSION,captureId:row.capture_id,captureSequence:String(row.capture_sequence),
    protocolId:row.protocol_id,protocolHash:protocol.protocolHash,protocol,league:row.league,gameId:row.game_id,date:game.date,
    kickoffAt:iso(row.kickoff_at),analysisRevision:row.analysis_revision,analysisCutoff:iso(row.analysis_cutoff),
    sourceReceiptId:row.source_receipt_id,sourceHash:row.source_hash,sourceRecordedAt:iso(row.source_recorded_at),
    capturedAt:iso(row.captured_at),body,predictionBody:body,predictionHash:row.body_hash,...restrictions};
}
export async function loadSoccerMinutesForwardCapture(league,captureId){
  if(!leagueValid(league)||!sha(captureId))throw Error('MINUTES_FORWARD_CAPTURE_SCOPE_INVALID');
  const protocol=await loadSoccerMinutesForwardProtocol(league);if(!protocol)return null;
  const rows=await soccerJournalQuery(`${captureSelection} WHERE c.league=$1 AND c.capture_id=$2 AND c.protocol_id=$3`,[league,captureId,protocol.protocolId]);
  if(rows.length!==1)return null;
  const capture=captureFromRow(rows[0],protocol);
  const replayed=await(await service()).replaySoccerMinutesForwardCapture({capture,protocol});
  if(replayed?.ok!==true||soccerMinutesForwardStorageHash(replayed.body)!==capture.predictionHash)
    fail('MINUTES_FORWARD_CAPTURE_SOURCE_REPLAY_FAILED');
  return capture;
}
export async function hasSoccerMinutesForwardCapture(league,gameId){
  if(!leagueValid(league)||!new RegExp(`^soccer:${league}:\\d{1,16}$`).test(gameId||''))throw Error('MINUTES_FORWARD_CAPTURE_SCOPE_INVALID');
  const protocol=await loadSoccerMinutesForwardProtocol(league);if(!protocol)return false;
  const rows=await soccerJournalQuery(`SELECT capture_id FROM sports_soccer_minutes_forward_captures_v1
    WHERE league=$1 AND game_id=$2 AND protocol_id=$3`,[league,gameId,protocol.protocolId]);return rows.length===1;
}
export async function archiveSoccerMinutesForwardCapture(prepared){
  const incoming=(await service()).getSoccerMinutesForwardCaptureProof(prepared);
  if(!incoming)return notCaptured('MINUTES_FORWARD_PRIVATE_SOURCE_PROOF_MISSING');
  const proof=structuredClone(incoming);
  const protocol=await loadSoccerMinutesForwardProtocol(proof.league);
  if(!protocol)return notCaptured('MINUTES_FORWARD_PROTOCOL_NOT_FROZEN_BEFORE_ANALYSIS');
  if(proof.protocolHash!==protocol.protocolHash||!sha(proof.analysisRevision)||!sha(proof.sourceReceiptId)||!sha(proof.sourceHash)
    ||!Number.isFinite(instant(proof.analysisCutoff))||!Number.isFinite(instant(proof.kickoffAt))
    ||proof.gameId!==proof.body?.game?.id||proof.date!==proof.body?.game?.date||proof.league!==proof.body?.game?.league
    ||!Array.isArray(proof.observationReceipts)||proof.observationReceipts.length<1||proof.observationReceipts.length>2
    ||new Set(proof.observationReceipts.map(o=>o.field)).size!==proof.observationReceipts.length
    ||proof.observationReceipts.some(o=>!sha(o.receiptId)||!/^teams\.(home|away)\.minutes$/.test(o.field||''))
    ||soccerMinutesForwardStorageHash(proof.observationReceipts)!==soccerMinutesForwardStorageHash(proof.body.observationReceipts)
    ||Buffer.byteLength(canonical(proof.body))>maxBodyBytes)return notCaptured('MINUTES_FORWARD_CAPTURE_PROOF_INVALID');
  const captureId=soccerMinutesForwardStorageHash([SOCCER_MINUTES_FORWARD_STORE_VERSION,protocol.protocolId,proof.gameId]);
  await soccerJournalQuery(`WITH receipt AS MATERIALIZED(SELECT clock_timestamp() AS captured_at)
    INSERT INTO sports_soccer_minutes_forward_captures_v1(capture_id,protocol_id,league,game_id,board_date,
      analysis_revision,analysis_cutoff,source_receipt_id,source_hash,source_recorded_at,kickoff_at,body,body_hash,captured_at)
    SELECT $1,p.protocol_id,a.league,a.game_id,(a.payload->>'date')::date,a.analysis_hash,$2::timestamptz,
      s.receipt_id,s.content_hash,s.recorded_at,$3::timestamptz,$4::jsonb,$5,r.captured_at
    FROM sports_soccer_analysis_v1 a CROSS JOIN receipt r
      JOIN sports_soccer_minutes_forward_protocols_v1 p ON p.protocol_id=$6
      JOIN sports_soccer_source_document_observations_v1 s ON s.receipt_id=$7
      JOIN sports_soccer_analysis_runs_v2 ar ON ar.run_id=a.payload->>'analysisRunId'
        AND ar.league=a.league AND ar.game_id=a.game_id AND ar.board_date=(a.payload->>'date')::date
    WHERE a.league=$8 AND a.game_id=$9 AND a.analysis_hash=$10 AND s.league=a.league AND s.game_id=a.game_id
      AND (a.payload->>'analysisCutoff')::timestamptz=$2::timestamptz
      AND a.payload#>>'{evidence,sourceDocumentArchive,receiptId}'=$7
      AND a.payload#>>'{evidence,source,contentHash}'=$11
      AND (a.payload#>>'{evidence,game,startTime}')::timestamptz=$3::timestamptz
      AND s.content_hash=$11 AND s.recorded_at<=$2::timestamptz AND p.registered_at<$2::timestamptz
      AND p.registered_at<ar.started_at AND p.registered_at<s.fetched_at AND s.fetched_at<=$2::timestamptz
      AND NOT EXISTS(SELECT 1 FROM jsonb_to_recordset($12::jsonb) r(receipt_id text,field text)
        LEFT JOIN sports_soccer_observations_v1 o ON o.receipt_id=r.receipt_id
        WHERE o.receipt_id IS NULL OR o.league<>a.league OR o.game_id<>a.game_id OR o.field<>r.field
          OR o.kind<>'PERSONNEL_RESEARCH' OR o.recorded_at>$2::timestamptz OR o.recorded_at<p.registered_at)
      AND $2::timestamptz<=r.captured_at AND r.captured_at<$3::timestamptz
    ON CONFLICT DO NOTHING`,[captureId,proof.analysisCutoff,proof.kickoffAt,JSON.stringify(proof.body),soccerMinutesForwardStorageHash(proof.body),
      protocol.protocolId,proof.sourceReceiptId,proof.league,proof.gameId,proof.analysisRevision,proof.sourceHash,
      JSON.stringify(proof.observationReceipts.map(o=>({receipt_id:o.receiptId,field:o.field})))]);
  const capture=await loadSoccerMinutesForwardCapture(proof.league,captureId);
  if(!capture)return notCaptured('MINUTES_FORWARD_DATABASE_CAPTURE_TIME_INVALID');
  return{version:SOCCER_MINUTES_FORWARD_STORE_VERSION,status:'DATABASE_PREGAME_CAPTURED',persisted:true,captureId,
    league:proof.league,gameId:proof.gameId,protocolId:protocol.protocolId,protocolHash:protocol.protocolHash,
    capturedAt:capture.capturedAt,analysisRevision:capture.analysisRevision,...restrictions};
}
const documentIdentity=document=>{if(!document?.source)return document;const{fetchedAt,requestedAt,...source}=document.source;return{...document,source};};
const resultIdentity=payload=>soccerMinutesForwardStorageHash({status:payload.status,reason:payload.reason,
  resultDocuments:payload.resultDocuments?{...payload.resultDocuments,scoreboard:documentIdentity(payload.resultDocuments.scoreboard),
    summaries:payload.resultDocuments.summaries?.map(documentIdentity)}:null});
function checkFromRow(row){
  const p=row.payload;
  if(!sha(row.check_id)||!sha(row.capture_id)||!leagueValid(row.league)||soccerMinutesForwardStorageHash(p)!==row.payload_hash
    ||p?.version!==SOCCER_MINUTES_FORWARD_STORE_VERSION||p.status!==row.status||resultIdentity(p)!==row.evidence_hash
    ||row.check_id!==soccerMinutesForwardStorageHash([SOCCER_MINUTES_FORWARD_STORE_VERSION,row.capture_id,row.evidence_hash])
    ||!Number.isFinite(new Date(row.checked_at).getTime()))fail('MINUTES_FORWARD_CHECK_READBACK_INVALID');
  const docs=[p.resultDocuments?.scoreboard,...(p.resultDocuments?.summaries||[])].filter(Boolean);
  if(docs.some(d=>!Number.isFinite(instant(d.source?.fetchedAt))||instant(d.source.fetchedAt)>new Date(row.checked_at).getTime()))fail('MINUTES_FORWARD_CHECK_TIME_INVALID');
  return{checkId:row.check_id,captureId:row.capture_id,league:row.league,checkedAt:iso(row.checked_at),...p};
}
export async function archiveSoccerMinutesForwardCheck({league,captureId,resultDocuments=null,status,reason=null}={}){
  if(!leagueValid(league)||!sha(captureId)||!['PENDING','EVALUATED','QUARANTINED'].includes(status)
    ||reason!==null&&(typeof reason!=='string'||!/^[A-Z][A-Z0-9_]{1,199}$/.test(reason)))throw Error('MINUTES_FORWARD_CHECK_SCOPE_INVALID');
  const payload={version:SOCCER_MINUTES_FORWARD_STORE_VERSION,resultDocuments,status,reason,...restrictions};
  if(Buffer.byteLength(canonical(payload))>maxCheckBytes)fail('MINUTES_FORWARD_CHECK_DOCUMENT_BUDGET');
  const docs=[resultDocuments?.scoreboard,...(resultDocuments?.summaries||[])].filter(Boolean),times=docs.map(d=>instant(d.source?.fetchedAt));
  if(times.some(t=>!Number.isFinite(t)))throw Error('MINUTES_FORWARD_CHECK_SOURCE_TIME_INVALID');
  const cutoff=iso(times.length?Math.max(...times):0),evidenceHash=resultIdentity(payload),
    checkId=soccerMinutesForwardStorageHash([SOCCER_MINUTES_FORWARD_STORE_VERSION,captureId,evidenceHash]);
  const observations=docs.map(d=>({ok:d.ok,code:d.code??null,source:d.source??null}));
  await ensureSoccerMinutesForwardStore();
  await soccerJournalQuery(`INSERT INTO sports_soccer_minutes_forward_checks_v1(check_id,capture_id,league,evidence_hash,status,payload,payload_hash)
    SELECT $1,c.capture_id,c.league,$3,$4,$5::jsonb,$6 FROM sports_soccer_minutes_forward_captures_v1 c
    WHERE c.capture_id=$2 AND c.league=$7 AND $8::timestamptz<=clock_timestamp()
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements($9::jsonb) o
        WHERE (o#>>'{source,fetchedAt}')::timestamptz>clock_timestamp()) ON CONFLICT DO NOTHING`,
    [checkId,captureId,evidenceHash,status,JSON.stringify(payload),soccerMinutesForwardStorageHash(payload),league,cutoff,JSON.stringify(observations)]);
  const rows=await soccerJournalQuery('SELECT * FROM sports_soccer_minutes_forward_checks_v1 WHERE check_id=$1',[checkId]);
  if(rows.length!==1)fail('MINUTES_FORWARD_CHECK_STORAGE_UNAVAILABLE');const check=checkFromRow(rows[0]);
  const attempts=await soccerJournalQuery(`INSERT INTO sports_soccer_minutes_forward_attempts_v1(capture_id,check_id,source_observations,source_observations_hash)
    SELECT capture_id,check_id,$3::jsonb,$4 FROM sports_soccer_minutes_forward_checks_v1
    WHERE check_id=$1 AND capture_id=$2 AND $5::timestamptz<=clock_timestamp()
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements($3::jsonb) o
        WHERE (o#>>'{source,fetchedAt}')::timestamptz>clock_timestamp()) RETURNING attempted_at`,
    [checkId,captureId,JSON.stringify(observations),soccerMinutesForwardStorageHash(observations),cutoff]);
  if(attempts.length!==1)fail('MINUTES_FORWARD_CHECK_STORAGE_UNAVAILABLE');
  return{status:'ARCHIVED',persisted:true,checkId,captureId,checkedAt:check.checkedAt,attemptedAt:iso(attempts[0].attempted_at),...restrictions};
}
export async function listSoccerMinutesForwardPending(league,{limit=3,recheckAfterMs=900000}={}){
  if(!leagueValid(league)||!Number.isSafeInteger(limit)||limit<1||limit>20||!Number.isFinite(recheckAfterMs)||recheckAfterMs<0||recheckAfterMs>86400000)
    throw Error('MINUTES_FORWARD_PENDING_SCOPE_INVALID');
  const protocol=await loadSoccerMinutesForwardProtocol(league);if(!protocol)return{captures:[],completeWithinRequestedScope:true};
  const rows=await soccerJournalQuery(`SELECT c.capture_id,c.game_id,c.board_date,c.kickoff_at,max(a.attempted_at) AS attempted_at
    FROM sports_soccer_minutes_forward_captures_v1 c LEFT JOIN sports_soccer_minutes_forward_attempts_v1 a USING(capture_id)
    WHERE c.league=$1 AND c.protocol_id=$2 AND c.kickoff_at<=clock_timestamp()
    GROUP BY c.capture_id,c.capture_sequence HAVING max(a.attempted_at) IS NULL
      OR max(a.attempted_at)<=clock_timestamp()-($3::double precision*interval '1 millisecond')
    ORDER BY max(a.attempted_at) NULLS FIRST,c.capture_sequence LIMIT $4`,[league,protocol.protocolId,recheckAfterMs,limit+1]);
  return{captures:rows.slice(0,limit).map(r=>({captureId:r.capture_id,league,gameId:r.game_id,
    date:typeof r.board_date==='string'?r.board_date:iso(r.board_date).slice(0,10),kickoffAt:iso(r.kickoff_at)})),completeWithinRequestedScope:rows.length<=limit};
}
async function revisionAndCounts(league,protocolId){
  const rows=await soccerJournalQuery(`WITH observed AS MATERIALIZED(SELECT clock_timestamp() AS at)
    SELECT observed.at,count(c.capture_id)::int AS captures,count(c.capture_id) FILTER(WHERE c.kickoff_at<=observed.at)::int AS started,
      count(c.capture_id) FILTER(WHERE c.kickoff_at>observed.at)::int AS upcoming,
      (SELECT count(*)::int FROM sports_soccer_minutes_forward_checks_v1 h JOIN sports_soccer_minutes_forward_captures_v1 g USING(capture_id)
        WHERE g.league=$1 AND g.protocol_id=$2) AS checks,
      (SELECT count(*)::int FROM sports_soccer_minutes_forward_attempts_v1 h JOIN sports_soccer_minutes_forward_captures_v1 g USING(capture_id)
        WHERE g.league=$1 AND g.protocol_id=$2) AS attempts,
      (SELECT count(DISTINCT(h.check_id,h.source_observations_hash))::int FROM sports_soccer_minutes_forward_attempts_v1 h
        JOIN sports_soccer_minutes_forward_captures_v1 g USING(capture_id) WHERE g.league=$1 AND g.protocol_id=$2
        AND EXISTS(SELECT 1 FROM jsonb_array_elements(h.source_observations) o WHERE o->>'ok'='true')) AS source_observations
    FROM observed LEFT JOIN sports_soccer_minutes_forward_captures_v1 c ON c.league=$1 AND c.protocol_id=$2 GROUP BY observed.at`,[league,protocolId]);
  const r=rows[0];if(rows.length!==1||!['captures','started','upcoming','checks','attempts','source_observations'].every(k=>count(r[k]))||r.started+r.upcoming!==r.captures)
    fail('MINUTES_FORWARD_COUNTS_INVALID');
  return{revision:soccerMinutesForwardStorageHash([league,protocolId,r.captures,r.started,r.upcoming,r.checks,r.source_observations]),
    counts:{captures:r.captures,captureGames:r.captures,startedGames:r.started,upcomingGames:r.upcoming,upcoming:r.upcoming},observedAt:iso(r.at)};
}
export async function readSoccerMinutesForwardReportPage(league,{afterSequence='0',limit=1,revision=null}={}){
  if(!leagueValid(league)||!sequence(afterSequence)||!Number.isSafeInteger(limit)||limit<1||limit>5
    ||revision!==null&&!sha(revision)||afterSequence!=='0'&&!revision)throw Error('MINUTES_FORWARD_REPORT_SCOPE_INVALID');
  const protocol=await loadSoccerMinutesForwardProtocol(league),scope=await revisionAndCounts(league,protocol?.protocolId??null);
  const changed=()=>Object.assign(Error('MINUTES_FORWARD_HISTORY_CHANGED_DURING_READ'),{status:409});
  if(revision!==null&&revision!==scope.revision)throw changed();
  if(afterSequence!=='0'){
    const cursor=protocol?await soccerJournalQuery(`SELECT capture_id FROM sports_soccer_minutes_forward_captures_v1
      WHERE league=$1 AND protocol_id=$2 AND capture_sequence=$3::bigint`,[league,protocol.protocolId,afterSequence]):[];
    if(cursor.length!==1)throw Error('MINUTES_FORWARD_REPORT_CURSOR_INVALID');
  }
  const meta=protocol?await soccerJournalQuery(`SELECT capture_id,capture_sequence,octet_length(body::text)::bigint AS bytes
    FROM sports_soccer_minutes_forward_captures_v1 WHERE league=$1 AND protocol_id=$2 AND capture_sequence>$3::bigint
    ORDER BY capture_sequence LIMIT $4`,[league,protocol.protocolId,afterSequence,limit+1]):[];
  const selected=meta.slice(0,limit);if(selected.some(r=>Number(r.bytes)>maxBodyBytes))fail('MINUTES_FORWARD_CAPTURE_READ_BUDGET');
  const rows=selected.length?await soccerJournalQuery(`${captureSelection} WHERE c.league=$1 AND c.protocol_id=$2
    AND c.capture_id=ANY($3::text[])`,[league,protocol.protocolId,selected.map(r=>r.capture_id)]):[];
  if(rows.length!==selected.length)throw changed();
  const captures=[];
  for(const selectedRow of selected){
    // Identity, immutable payload and original DB-clock fences must pass first.
    // A source replay failure then quarantines this whole game without making
    // the next game's valid source unreadable. Default load/archive stay strict.
    const capture=captureFromRow(rows.find(r=>r.capture_id===selectedRow.capture_id),protocol);
    try{
      const replayed=await(await service()).replaySoccerMinutesForwardCapture({capture,protocol});
      if(replayed?.ok!==true||soccerMinutesForwardStorageHash(replayed.body)!==capture.predictionHash)
        fail('MINUTES_FORWARD_CAPTURE_SOURCE_REPLAY_FAILED');
    }catch(error){capture.sourceReplayError=/^MINUTES_[A-Z0-9_]{1,150}$/.test(error?.message||'')
      ?error.message:'MINUTES_FORWARD_CAPTURE_SOURCE_REPLAY_FAILED';}
    captures.push(capture);
  }
  const ids=captures.map(c=>c.captureId),checkMeta=ids.length?await soccerJournalQuery(`SELECT check_id,octet_length(payload::text)::bigint AS bytes
    FROM sports_soccer_minutes_forward_checks_v1 WHERE league=$1 AND capture_id=ANY($2::text[]) ORDER BY checked_at,check_id LIMIT 1001`,[league,ids]):[];
  if(checkMeta.length>1000||checkMeta.reduce((n,r)=>n+Number(r.bytes),0)>maxHistoryBytes)fail('MINUTES_FORWARD_COMPLETE_HISTORY_READ_BUDGET');
  const checks=checkMeta.length?(await soccerJournalQuery(`SELECT * FROM sports_soccer_minutes_forward_checks_v1
    WHERE check_id=ANY($1::text[]) ORDER BY checked_at,check_id`,[checkMeta.map(r=>r.check_id)])).map(checkFromRow):[];
  if(checks.length!==checkMeta.length)throw changed();
  const attemptMeta=ids.length?await soccerJournalQuery(`SELECT DISTINCT ON(a.check_id,a.source_observations_hash)
      a.attempt_sequence,a.check_id,octet_length(a.source_observations::text)::bigint AS bytes
    FROM sports_soccer_minutes_forward_attempts_v1 a WHERE a.capture_id=ANY($1::text[])
    ORDER BY a.check_id,a.source_observations_hash,a.attempt_sequence LIMIT 10001`,[ids]):[];
  if(attemptMeta.length>10000||attemptMeta.reduce((n,r)=>n+Number(r.bytes),0)>16*1024*1024)
    fail('MINUTES_FORWARD_COMPLETE_ATTEMPT_HISTORY_READ_BUDGET');
  const attempts=attemptMeta.length?await soccerJournalQuery(`SELECT * FROM sports_soccer_minutes_forward_attempts_v1
    WHERE attempt_sequence=ANY($1::bigint[]) ORDER BY attempted_at,attempt_sequence`,[attemptMeta.map(r=>String(r.attempt_sequence))]):[];
  if(attempts.length!==attemptMeta.length)throw changed();
  for(const check of checks)check.attempts=[];
  for(const attempt of attempts){
    const check=checks.find(c=>c.checkId===attempt.check_id);
    const originals=[check?.resultDocuments?.scoreboard,...(check?.resultDocuments?.summaries||[])].filter(Boolean);
    if(!check||check.captureId!==attempt.capture_id||!Array.isArray(attempt.source_observations)
      ||soccerMinutesForwardStorageHash(attempt.source_observations)!==attempt.source_observations_hash
      ||attempt.source_observations.length!==originals.length
      ||attempt.source_observations.some((o,i)=>o.ok!==originals[i].ok||o.code!==(originals[i].code??null)
        ||soccerMinutesForwardStorageHash(documentIdentity({source:o.source}))!==soccerMinutesForwardStorageHash(documentIdentity({source:originals[i].source})))
      ||!Number.isFinite(new Date(attempt.attempted_at).getTime())
      ||attempt.source_observations.some(o=>!Number.isFinite(instant(o.source?.fetchedAt))
        ||instant(o.source.fetchedAt)>new Date(attempt.attempted_at).getTime()))fail('MINUTES_FORWARD_ATTEMPT_READBACK_INVALID');
    check.attempts.push({attemptedAt:iso(attempt.attempted_at),sourceObservations:attempt.source_observations});
  }
  const ending=await revisionAndCounts(league,protocol?.protocolId??null);if(ending.revision!==scope.revision)throw changed();
  const reachedEnd=meta.length<=limit,nextSequence=reachedEnd?null:String(selected.at(-1).capture_sequence);
  return{version:SOCCER_MINUTES_FORWARD_STORE_VERSION,league,protocol,...scope,captures,checks,
    page:{afterSequence,nextSequence,revision:scope.revision,complete:true,reachedEnd},completeWithinRequestedScope:reachedEnd,...restrictions};
}
