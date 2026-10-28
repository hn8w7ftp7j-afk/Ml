import { randomBytes } from 'node:crypto';
import { ensureSoccerForwardProtocol, readSoccerForwardProtocol, archiveSoccerForwardCheck, SOCCER_FORWARD_READ_LIMITS } from './forward-validation-service.js';
import { soccerJournalQuery } from './journal.js';
import { normalizeSoccerForwardScope, compactSoccerForwardCapture, canonicalSoccerForwardCaptures, evaluateSoccerForwardCapture, buildSoccerForwardReport, SOCCER_FORWARD_VERSION, SOCCER_FORWARD_POLICY, soccerForwardHash } from './forward-validation.js';
import { canonicalSoccerMarketReturnCaptures, buildSoccerMarketReturnReport, evaluateSoccerMarketReturnCapture, SOCCER_MARKET_RETURN_VERSION } from './market-return-validation.js';
import { fetchSoccerSettlementResult } from './settlement-result.js';
import { mergeSoccerForwardGameReport } from './forward-scan-aggregate.js';
import { buildSoccerReturnErrorDatasetHydrated, summarizeSoccerReturnErrorDatasets } from './return-error-model.js';

export const SOCCER_FORWARD_SCAN_VERSION='SOCCER-FORWARD-SCAN-v1';
const bad=message=>Object.assign(Error(message),{status:400});
export class SoccerForwardScanError extends Error {constructor(message){super(message);this.status=503;this.publicMessage=message;this.code='SOCCER_FORWARD_SCAN_INCOMPLETE';}}
const unavailable=message=>new SoccerForwardScanError(message);
const tokenValid=value=>typeof value==='string'&&/^[a-f0-9]{48}$/.test(value);
const key=row=>`${row.league}|${row.game_id}`;
const iso=value=>new Date(value).toISOString();
const jsonBytes=value=>Buffer.byteLength(JSON.stringify(value));
const safeState=value=>{if(jsonBytes(value)>16*1024*1024)throw unavailable('單場驗證摘要超過安全容量；資料仍保留，尚未完成本次驗證。');return value;};
export const SOCCER_FORWARD_SCAN_SCHEMA=[
 `CREATE TABLE IF NOT EXISTS sports_soccer_forward_scans_v1 (cursor TEXT PRIMARY KEY,scope JSONB NOT NULL,purpose TEXT NOT NULL CHECK(purpose IN ('read','evaluate')),frozen_at TIMESTAMPTZ NOT NULL,processed_games INTEGER NOT NULL DEFAULT 0,total_games INTEGER NOT NULL DEFAULT 0,last_game_key TEXT NOT NULL DEFAULT '',state JSONB,revision INTEGER NOT NULL DEFAULT 0,complete BOOLEAN NOT NULL DEFAULT false,lease_owner TEXT,lease_until TIMESTAMPTZ,expires_at TIMESTAMPTZ NOT NULL DEFAULT (clock_timestamp()+interval '2 days'))`,
 `CREATE TABLE IF NOT EXISTS sports_soccer_forward_scan_captures_v1 (cursor TEXT NOT NULL REFERENCES sports_soccer_forward_scans_v1(cursor) ON DELETE CASCADE,capture_id TEXT NOT NULL REFERENCES sports_soccer_forward_captures_v1(capture_id),capture_sequence BIGINT NOT NULL,league TEXT NOT NULL,game_id TEXT NOT NULL,PRIMARY KEY(cursor,capture_id))`,
 `CREATE INDEX IF NOT EXISTS sports_soccer_forward_scan_games_v1 ON sports_soccer_forward_scan_captures_v1(cursor,league,game_id,capture_sequence)`,
 `CREATE TABLE IF NOT EXISTS sports_soccer_forward_scan_checks_v1 (cursor TEXT NOT NULL REFERENCES sports_soccer_forward_scans_v1(cursor) ON DELETE CASCADE,check_id TEXT NOT NULL REFERENCES sports_soccer_forward_result_checks_v1(check_id),PRIMARY KEY(cursor,check_id))`,
];
let ready;
async function ensureScan(query){await ensureSoccerForwardProtocol();if(query!==soccerJournalQuery){for(const sql of SOCCER_FORWARD_SCAN_SCHEMA)await query(sql);return;}
 return ready||=(async()=>{for(const sql of SOCCER_FORWARD_SCAN_SCHEMA)await query(sql);})().catch(error=>{ready=null;throw error;});}
async function startScan(scope,purpose,query){
 const cursor=randomBytes(24).toString('hex');
 // One MVCC statement seals BOTH manifests. A late commit with an older
 // timestamp/sequence cannot enter an already-created scan.
 await query(`WITH job AS (INSERT INTO sports_soccer_forward_scans_v1(cursor,scope,purpose,frozen_at) VALUES($1,$2::jsonb,$3,clock_timestamp()) RETURNING *), captures AS (
 INSERT INTO sports_soccer_forward_scan_captures_v1(cursor,capture_id,capture_sequence,league,game_id)
 SELECT j.cursor,c.capture_id,c.capture_sequence,c.league,c.game_id FROM sports_soccer_forward_captures_v1 c CROSS JOIN job j
 WHERE c.protocol_version=$4 AND ($5::text IS NULL OR c.league=$5) AND c.board_date BETWEEN $6::date AND $7::date AND c.captured_at<=j.frozen_at RETURNING *)
 INSERT INTO sports_soccer_forward_scan_checks_v1(cursor,check_id)
 SELECT c.cursor,r.check_id FROM captures c JOIN sports_soccer_forward_result_checks_v1 r ON r.capture_id=c.capture_id`,[cursor,JSON.stringify(scope),purpose,SOCCER_FORWARD_VERSION,scope.league,scope.from,scope.through]);
 await query(`UPDATE sports_soccer_forward_scans_v1 SET total_games=(SELECT count(*) FROM (SELECT DISTINCT league,game_id FROM sports_soccer_forward_scan_captures_v1 WHERE cursor=$1) g) WHERE cursor=$1`,[cursor]);
 return cursor;
}
async function readJob(cursor,scope,purpose,query){
 if(!tokenValid(cursor))throw bad('驗證續讀憑據不正確。');
 const rows=await query(`SELECT *,clock_timestamp() AS checked_at FROM sports_soccer_forward_scans_v1 WHERE cursor=$1 AND expires_at>clock_timestamp()`,[cursor]);
 const job=rows[0];if(!job||job.purpose!==purpose||soccerForwardHash(job.scope)!==soccerForwardHash(scope))throw bad('驗證續讀憑據已到期，或聯盟、日期與核對方式不符。請重新開始。');
 return job;
}
function captureFrom(row,snapshot){return {captureId:row.capture_id,captureSequence:String(row.capture_sequence),league:row.league,gameId:row.game_id,date:row.board_date,period:row.period,variant:row.variant,modelHash:row.model_hash,revision:row.analysis_revision,capturedAt:iso(row.captured_at),snapshot};}
function compactCheckKey(row){const e=row.payload?.evaluation,m=e?.marketReturnValidation;return soccerForwardHash({captureId:row.capture_id,status:e?.status,reason:e?.reason,revision:e?.revision,modelHash:e?.modelHash,period:e?.period,variant:e?.variant,league:e?.league,gameId:e?.gameId,actualScore:e?.actualScore,actualOutcome:e?.actualOutcome,market:m&&{status:m.status,reason:m.reason,observations:m.observations?.map(o=>({observationId:o.observationId,status:o.status,reason:o.reason,contractHash:o.contractHash,predictedNetReturn:o.predictedNetReturn,realizedNetReturn:o.realizedNetReturn,actualScore:o.actualScore}))}});}
const checkTime=value=>value instanceof Date?value.getTime():Date.parse(value);
function checkAvailability(row){
 const database=checkTime(row.checked_at),logical=checkTime(row.payload?.evaluation?.marketReturnValidation?.checkedAt??row.payload?.checkedAt??row.checked_at);
 return Number.isFinite(database)&&Number.isFinite(logical)?Math.max(database,logical):Infinity;
}
function resultProofClass(row,captures,protocol,now,cache){
 const result=row.payload?.resultEvidence,evaluation=row.payload?.evaluation,market=evaluation?.marketReturnValidation;
 if(!result)return 'MISSING_ORIGINAL_RESULT';
 const observed=market?.observations?.filter?.(value=>value?.status==='OBSERVED')||[];
 let seal=null;
 if(market){
  if(market.version!==SOCCER_MARKET_RETURN_VERSION||!Array.isArray(market.observations))return 'INVALID_ORIGINAL_RESULT';
  const {evidenceHash,checkedAt,...body}=market;
  seal=soccerForwardHash({...body,observations:market.observations.map(({checkedAt,...value})=>value)});
  if(seal!==evidenceHash)return 'INVALID_ORIGINAL_RESULT';
 }
 if(evaluation?.status==='EVALUATED'&&evaluation.resultHash!==result.resultHash
   ||observed.some(value=>value.resultHash!==result.resultHash))return 'INVALID_ORIGINAL_RESULT';
 const available=checkAvailability(row),sourceTimes=[result.observedAt,...(Array.isArray(result.sources)?result.sources.map(source=>source?.fetchedAt):[])].map(Date.parse);
 if(!Number.isFinite(available)||sourceTimes.length!==3||sourceTimes.some(time=>!Number.isFinite(time)||time>available))return 'INVALID_ORIGINAL_RESULT';
 const id=soccerForwardHash({captureId:row.capture_id,result,seal,status:evaluation?.status,actualScore:evaluation?.actualScore,actualOutcome:evaluation?.actualOutcome});
 if(cache.has(id))return cache.get(id);
 const capture=captures.get(row.capture_id),checked=capture&&evaluateSoccerForwardCapture(capture,protocol,result,now);
 const usable=checked?.status==='EVALUATED'&&(evaluation?.status!=='EVALUATED'
   ||soccerForwardHash([checked.actualScore,checked.actualOutcome])===soccerForwardHash([evaluation.actualScore,evaluation.actualOutcome]))
   &&observed.every(value=>soccerForwardHash(value.actualScore)===soccerForwardHash(checked.actualScore));
 const classification=usable?'USABLE_ORIGINAL_RESULT':'INVALID_ORIGINAL_RESULT';
 // Heartbeats normally reuse identical proof. Bound this optimization without
 // trusting a claimed result hash as a substitute for the retained document.
 if(cache.size>=256)cache.delete(cache.keys().next().value);cache.set(id,classification);
 return classification;
}
const retainedChecks=states=>[...new Map([...states.values()].flatMap(state=>[state.earliest,state.latest]).map(row=>[row.check_id,row])).values()];
// Full payloads never exceed the existing per-read limits. Only validated,
// in-process compact summaries survive between batches; no DB/request trust flag.
export async function loadSoccerForwardScanGame(cursor,game,{query=soccerJournalQuery,protocol,now=Date.now(),captureRows=256,capturePayloadBytes=SOCCER_FORWARD_READ_LIMITS.capturePayloadBytes,resultCheckRows=1000,resultCheckPayloadBytes=SOCCER_FORWARD_READ_LIMITS.resultCheckPayloadBytes,deadline=Infinity,clock=Date.now}={}){
 for(const [n,max] of [[captureRows,5000],[capturePayloadBytes,SOCCER_FORWARD_READ_LIMITS.capturePayloadBytes],[resultCheckRows,25000],[resultCheckPayloadBytes,SOCCER_FORWARD_READ_LIMITS.resultCheckPayloadBytes]])if(!Number.isSafeInteger(n)||n<1||n>max)throw bad('驗證分批讀取上限不正確。');
 const expected=await query(`SELECT count(*)::integer AS n FROM sports_soccer_forward_scan_captures_v1 WHERE cursor=$1 AND league=$2 AND game_id=$3`,[cursor,game.league,game.game_id]);
 const expectedChecks=await query(`SELECT count(*)::integer AS n FROM sports_soccer_forward_scan_checks_v1 s JOIN sports_soccer_forward_result_checks_v1 r ON r.check_id=s.check_id JOIN sports_soccer_forward_scan_captures_v1 c ON c.cursor=s.cursor AND c.capture_id=r.capture_id WHERE s.cursor=$1 AND c.league=$2 AND c.game_id=$3`,[cursor,game.league,game.game_id]);
 const captures=[],checkStates=new Map(),compactSnapshots=new WeakSet();
 let after='0',checkAfter='',physicalCaptureBytes=0,physicalCheckBytes=0,checkRows=0,uniqueRows=0,compactCaptureBytes=0;
 const guard=()=>{if(clock()>=deadline)throw unavailable('本場驗證尚未讀完，請續讀重試；未完成資料不會列為完整驗收。');};
 while(true){guard();
  const revisions=await query(`WITH revisions AS MATERIALIZED (SELECT c.league,c.game_id,c.analysis_revision,min(c.capture_sequence)::text AS first_sequence,
   jsonb_agg(jsonb_build_object('capture_id',c.capture_id,'capture_sequence',c.capture_sequence::text,'league',c.league,'game_id',c.game_id,'board_date',c.board_date::text,'period',c.period,'variant',c.variant,'model_hash',c.model_hash,'analysis_revision',c.analysis_revision,'captured_at',c.captured_at) ORDER BY c.capture_sequence) AS receipts
   FROM sports_soccer_forward_captures_v1 c JOIN sports_soccer_forward_scan_captures_v1 m ON m.capture_id=c.capture_id AND m.cursor=$1
   WHERE c.league=$2 AND c.game_id=$3 GROUP BY c.league,c.game_id,c.analysis_revision HAVING min(c.capture_sequence)>$4::bigint ORDER BY min(c.capture_sequence) LIMIT $5)
   SELECT r.*,octet_length(a.payload::text)::bigint AS payload_bytes FROM revisions r
   JOIN sports_soccer_analysis_v1 a ON a.league=r.league AND a.game_id=r.game_id AND a.analysis_hash=r.analysis_revision
   ORDER BY r.first_sequence::bigint`,[cursor,game.league,game.game_id,after,captureRows]);
  if(!revisions.length)break;
  let batch=[],bytes=0;
  for(const row of revisions){const n=Number(row.payload_bytes);if(n>capturePayloadBytes)throw unavailable('原始單筆分析超過安全容量，未載入也未視為驗收完成。');if(bytes+n>capturePayloadBytes)break;batch.push(row);bytes+=n;}
  if(!batch.length)throw unavailable('驗證分批讀取未能前進。');
  const payloads=await query(`SELECT a.analysis_hash,a.payload FROM sports_soccer_analysis_v1 a WHERE a.league=$1 AND a.game_id=$2 AND a.analysis_hash=ANY($3::text[])`,[game.league,game.game_id,batch.map(r=>r.analysis_revision)]);
  if(payloads.length!==batch.length)throw unavailable('原始分析保存版本未完整讀回。');
  const snapshots=new Map(payloads.map(r=>[r.analysis_hash,r.payload]));
  for(const row of batch){guard();const original=snapshots.get(row.analysis_revision);if(!original)throw unavailable('原始分析版本不一致。');
   for(const receipt of row.receipts){
    const compact=compactSoccerForwardCapture(captureFrom(receipt,original),protocol,now),{snapshot,...metadata}=compact;
    compactCaptureBytes+=jsonBytes(metadata);
    if(!compactSnapshots.has(snapshot)){compactSnapshots.add(snapshot);compactCaptureBytes+=jsonBytes(snapshot);}
    if(compactCaptureBytes>16*1024*1024)throw unavailable('單場驗證摘要超過安全容量；資料仍保留，尚未完成本次驗證。');
    captures.push(compact);
   }
  }
  physicalCaptureBytes+=bytes;uniqueRows+=batch.length;after=batch.at(-1).first_sequence;
  // Snapshot objects are shared across FT/HT/personnel receipts. Charge each
  // once; repeated JSON serialization both triple-counted memory and made each
  // bounded page increasingly expensive. Receipt metadata is charged separately.
 }
 const proofCaptures=new Map(captures.map(capture=>[capture.captureId,capture])),proofCache=new Map();
 while(true){guard();
  const metadata=await query(`SELECT r.check_id,r.capture_id,r.checked_at,octet_length(r.payload::text)::bigint AS payload_bytes FROM sports_soccer_forward_result_checks_v1 r
   JOIN sports_soccer_forward_scan_checks_v1 s ON s.check_id=r.check_id AND s.cursor=$1
   JOIN sports_soccer_forward_scan_captures_v1 c ON c.capture_id=r.capture_id AND c.cursor=$1
   WHERE c.league=$2 AND c.game_id=$3 AND r.check_id>$4 ORDER BY r.check_id LIMIT $5`,[cursor,game.league,game.game_id,checkAfter,resultCheckRows]);
  if(!metadata.length)break;
  let batch=[],bytes=0;for(const row of metadata){const n=Number(row.payload_bytes);if(n>resultCheckPayloadBytes)throw unavailable('單筆賽果證據超過安全容量，尚未完成其歷史核對。');if(bytes+n>resultCheckPayloadBytes)break;batch.push(row);bytes+=n;}
  if(!batch.length)throw unavailable('賽果歷史分批讀取未能前進。');
  const rows=await query(`SELECT check_id,capture_id,checked_at,payload FROM sports_soccer_forward_result_checks_v1 WHERE check_id=ANY($1::text[])`,[batch.map(r=>r.check_id)]);
  if(rows.length!==batch.length)throw unavailable('保存賽果證據未完整讀回。');
  for(const row of rows){
   // An unusable earlier proof cannot displace an intermediate usable result
   // receipt. Preserve its diagnostics separately from usable temporal evidence.
   const id=`${compactCheckKey(row)}:${resultProofClass(row,proofCaptures,protocol,now,proofCache)}`,old=checkStates.get(id);
   if(!old){checkStates.set(id,{earliest:row,latest:row});continue;}
   if(checkAvailability(row)<checkAvailability(old.earliest)||checkAvailability(row)===checkAvailability(old.earliest)&&row.check_id<old.earliest.check_id)old.earliest=row;
   if(checkTime(row.checked_at)>checkTime(old.latest.checked_at)||checkTime(row.checked_at)===checkTime(old.latest.checked_at)&&row.check_id>old.latest.check_id)old.latest=row;
  }
  physicalCheckBytes+=bytes;checkRows+=batch.length;checkAfter=batch.at(-1).check_id;safeState(retainedChecks(checkStates));
 }
 if(captures.length!==Number(expected[0].n)||checkRows!==Number(expectedChecks[0].n))throw unavailable('驗證原始憑據或賽果歷史未完整載入，未視為完整驗收。');
 const checks=retainedChecks(checkStates);
 const readCoverage={status:'COMPLETE_WITHIN_REQUESTED_GAME',loadedCaptureRows:captures.length,loadedUniqueAnalysisRows:uniqueRows,loadedCapturePayloadBytes:physicalCaptureBytes,loadedResultCheckRows:checkRows,loadedResultCheckPayloadBytes:physicalCheckBytes,incompleteResultHistories:0,reasons:[],guidance:null};
 return {protocol,captures,evaluations:checks.map(row=>row.payload.evaluation).filter(Boolean),checks:checks.map(row=>({captureId:row.capture_id,checkId:row.check_id,checkedAt:iso(row.checked_at),reason:row.payload.reason||row.payload.evaluation?.reason||null,resultEvidence:row.payload.resultEvidence||null,marketReturnEvidenceHash:row.payload.evaluation?.marketReturnValidation?.evidenceHash||null})),incompleteResultCaptureIds:[],readCoverage,truncated:false};
}
const blankSummary=()=>({capturedRevisions:0,checkedGameModelPeriods:0,evaluated:0,pending:0,deferred:0,reasons:{},marketReturnCheckedPredictionPeriods:0,marketReturnObservedQuoteReturns:0,marketReturnPendingQuoteReturns:0,marketReturnDeferredPredictionPeriods:0,recheckedGameModelPeriods:0,persistence:'DURABLE_APPEND_ONLY_DATABASE',budgetExhausted:false,formalEligible:false,executable:false});
function sumSummary(a,b){const out={...a,reasons:{...a.reasons}};for(const [k,v]of Object.entries(b))if(typeof v==='number')out[k]=(out[k]||0)+v;for(const[k,v]of Object.entries(b.reasons||{}))out.reasons[k]=(out.reasons[k]||0)+v;return out;}
async function hydrateCapture(cursor,id,query){const rows=await query(`SELECT c.*,c.board_date::text AS board_date,a.payload FROM sports_soccer_forward_captures_v1 c JOIN sports_soccer_forward_scan_captures_v1 m ON m.capture_id=c.capture_id AND m.cursor=$1 JOIN sports_soccer_analysis_v1 a ON a.league=c.league AND a.game_id=c.game_id AND a.analysis_hash=c.analysis_revision WHERE c.capture_id=$2`,[cursor,id]);if(rows.length!==1)throw unavailable('找不到已封存的原始分析。');return captureFrom(rows[0],rows[0].payload);}
async function evaluateGame(evidence,cursor,{query,now,deadline,fetchResult,archive}){
 const summary=blankSummary(),goal=canonicalSoccerForwardCaptures(evidence.captures,evidence.protocol,now()).chosen,prices=canonicalSoccerMarketReturnCaptures(evidence.captures,evidence.protocol,now());
 const goalIds=new Set(goal.map(c=>c.captureId)),marketIds=new Set(prices.chosen.map(c=>c.captureId));
 const lastChecked=new Map();for(const check of evidence.checks||[])lastChecked.set(check.captureId,Math.max(lastChecked.get(check.captureId)||0,Date.parse(check.checkedAt)));
 const evaluated=new Set(evidence.evaluations.filter(e=>e.status==='EVALUATED').map(e=>e.captureId)),marketChecked=new Set(evidence.evaluations.filter(e=>e.marketReturnValidation).map(e=>e.captureId));
 const chosen=[...new Map([...goal,...prices.chosen].map(c=>[c.captureId,c])).values()].filter(c=>Date.parse(c.snapshot.evidence.game.startTime)<now()
   &&(!evaluated.has(c.captureId)||now()-(lastChecked.get(c.captureId)||0)>=SOCCER_FORWARD_POLICY.settledResultRecheckIntervalMs||marketIds.has(c.captureId)&&!marketChecked.has(c.captureId)));
 const results=new Map();
 for(const compact of chosen){
  if(now()>=deadline)throw unavailable('本場賽果尚未核對完，請續讀重試。');
  const game=compact.snapshot.evidence.game,context={league:compact.league,gameId:compact.gameId,date:compact.date,startTime:game.startTime,teamIds:{home:game.home.id,away:game.away.id}},contextKey=soccerForwardHash(context);
  if(!results.has(contextKey)){
   let result;try{result=await fetchResult(context,{now,timeoutMs:Math.max(1,Math.min(6000,deadline-now()))});}catch{result={ok:false,reason:'FORWARD_RESULT_SOURCE_UNAVAILABLE'};}
   results.set(contextKey,result);
  }
  const result=results.get(contextKey),full=await hydrateCapture(cursor,compact.captureId,query),evaluation=evaluateSoccerForwardCapture(full,evidence.protocol,result,now());evaluation.marketReturnValidation=evaluateSoccerMarketReturnCapture({capture:full,protocol:evidence.protocol,result,now:now()});
 const saved=await archive(full,evaluation,result,{now:now(),query});await query(`INSERT INTO sports_soccer_forward_scan_checks_v1(cursor,check_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,[cursor,saved.checkId]);
 summary.checkedGameModelPeriods+=Number(goalIds.has(full.captureId));summary.marketReturnCheckedPredictionPeriods+=Number(marketIds.has(full.captureId));
 if(goalIds.has(full.captureId)){if(evaluation.status==='EVALUATED')summary.evaluated++;else{summary.pending++;summary.reasons[evaluation.reason]=(summary.reasons[evaluation.reason]||0)+1;}}
 if(marketIds.has(full.captureId)){const wanted=new Set(prices.observations.filter(o=>o.captureId===full.captureId).map(o=>o.observationId));for(const row of evaluation.marketReturnValidation.observations.filter(o=>wanted.has(o.observationId)))summary[row.status==='OBSERVED'?'marketReturnObservedQuoteReturns':'marketReturnPendingQuoteReturns']++;}
 }
 return summary;
}
export async function continueSoccerForwardScan(scope,{cursor=null,purpose='read',query=soccerJournalQuery,now=Date.now,timeBudgetMs=18000,gameLimit=5,fetchResult=fetchSoccerSettlementResult,archive=archiveSoccerForwardCheck,onGameEvidence=null,readOptions={}}={}){
 if(!['read','evaluate'].includes(purpose)||!Number.isInteger(gameLimit)||gameLimit<1||gameLimit>25||!Number.isFinite(timeBudgetMs)||timeBudgetMs<=0||timeBudgetMs>25000)throw bad('驗證續讀設定不正確。');
 const range=normalizeSoccerForwardScope(scope,now()),deadline=now()+timeBudgetMs;await ensureScan(query);
 // Only ephemeral derived scan caches are pruned, never source receipts/results.
 await query(`DELETE FROM sports_soccer_forward_scans_v1 WHERE cursor IN (SELECT cursor FROM sports_soccer_forward_scans_v1 WHERE expires_at<clock_timestamp() ORDER BY expires_at LIMIT 20)`);
 const token=cursor||await startScan(range,purpose,query);let job=await readJob(token,range,purpose,query);
 const protocol=await readSoccerForwardProtocol(query);
 const lease=randomBytes(16).toString('hex');
 if(!job.complete){const claimed=await query(`UPDATE sports_soccer_forward_scans_v1 SET lease_owner=$2,lease_until=clock_timestamp()+interval '60 seconds' WHERE cursor=$1 AND (lease_until IS NULL OR lease_until<clock_timestamp()) RETURNING cursor`,[token,lease]);if(!claimed.length)throw unavailable('這批驗證正在處理，請稍後續讀；已完成資料仍保留。');}
 try{
 let lastGameMs=0;
 for(let done=0;!job.complete&&done<gameLimit&&now()<deadline;done++){
  // Return the durable cursor while there is still time to do so. Starting a
  // second large game with the tail of the first game's budget used to throw
  // away the response containing already-committed progress on a new scan.
  if(done>0&&deadline-now()<lastGameMs+500)break;
  const gameStarted=now();
  try{
  const rows=await query(`SELECT league,game_id,min(capture_sequence)::text AS first_sequence FROM sports_soccer_forward_scan_captures_v1 WHERE cursor=$1 AND (league||'|'||game_id)>$2 GROUP BY league,game_id ORDER BY league,game_id LIMIT 1`,[token,job.last_game_key]);
  if(!rows.length){await query(`UPDATE sports_soccer_forward_scans_v1 SET complete=true,revision=revision+1 WHERE cursor=$1 AND revision=$2`,[token,job.revision]);job=await readJob(token,range,purpose,query);break;}
  const game=rows[0];let evidence=await loadSoccerForwardScanGame(token,game,{query,protocol,now:Date.parse(iso(job.frozen_at)),deadline,clock:now,...readOptions});
  let summary=job.state?.summary||blankSummary();
  if(purpose==='evaluate'){summary=sumSummary(summary,await evaluateGame(evidence,token,{query,now,deadline,fetchResult,archive}));evidence=await loadSoccerForwardScanGame(token,game,{query,protocol,now:now(),deadline,clock:now,...readOptions});}
  const at=purpose==='evaluate'?now():Date.parse(iso(job.frozen_at));
  let contribution={...buildSoccerForwardReport({...evidence,now:at}),marketReturnValidation:buildSoccerMarketReturnReport(evidence,at)};
  const context={now:at,hydrateCapture:id=>hydrateCapture(token,id,query)};
  const dataset=await buildSoccerReturnErrorDatasetHydrated(evidence,context);
  contribution.returnErrorResearch=summarizeSoccerReturnErrorDatasets([dataset]);
  if(onGameEvidence){const extra=await onGameEvidence(evidence,context);if(extra)contribution={...contribution,...extra};}
  const report=mergeSoccerForwardGameReport(job.state?.report||null,contribution);
  const coverage={...(job.state?.coverage||{})};for(const k of ['loadedCaptureRows','loadedUniqueAnalysisRows','loadedCapturePayloadBytes','loadedResultCheckRows','loadedResultCheckPayloadBytes'])coverage[k]=(coverage[k]||0)+(evidence.readCoverage[k]||0);
  const state=safeState({report,summary,coverage});
  await query(`UPDATE sports_soccer_forward_scans_v1 SET state=$3::jsonb,last_game_key=$4,processed_games=processed_games+1,complete=(processed_games+1>=total_games),revision=revision+1 WHERE cursor=$1 AND revision=$2`,[token,job.revision,JSON.stringify(state),key(game)]);
  job=await readJob(token,range,purpose,query); // CAS loser adopts durable progress, never double-counts
  lastGameMs=Math.max(0,now()-gameStarted);
  }catch(error){
   if(error instanceof SoccerForwardScanError&&now()>=deadline&&job.processed_games>0)break;
   throw error;
  }
 }
 const empty={...buildSoccerForwardReport({protocol,now:Date.parse(iso(job.frozen_at))}),marketReturnValidation:buildSoccerMarketReturnReport({protocol,captures:[],evaluations:[]},Date.parse(iso(job.frozen_at)))};
 const base=job.state?.report||empty,complete=job.complete===true&&base.complete!==false;
 const maxRows=await query(`SELECT coalesce(max(capture_sequence),0)::text AS n FROM sports_soccer_forward_scan_captures_v1 WHERE cursor=$1`,[token]);
 const scan={version:SOCCER_FORWARD_SCAN_VERSION,purpose,scope:range,cursor:token,nextCursor:job.complete?null:token,complete:job.complete===true,processedGames:job.processed_games,totalGames:job.total_games,frozenAt:iso(job.frozen_at),captureHighWater:maxRows[0].n,resultEvidenceScope:purpose==='evaluate'?'INITIAL_MANIFEST_AND_THIS_SCAN_CHECKS':'INITIAL_DATABASE_MANIFEST'};
 const coverage={...(base.readCoverage||{}),...(job.state?.coverage||{}),status:complete?'COMPLETE_WITHIN_REQUESTED_SCOPE':'SCAN_IN_PROGRESS',requestedScope:range,processedGames:scan.processedGames,totalGames:scan.totalGames,frozenAt:scan.frozenAt,scanComplete:scan.complete,reasons:complete?[]:['SCAN_CONTINUATION_REQUIRED'],guidance:complete?null:'請繼續讀取，完成全部分批資料後才是完整範圍。'};
 const report={...base,complete,truncated:!complete,scan,readCoverage:coverage,returnErrorResearch:base.returnErrorResearch?{...base.returnErrorResearch,completeWithinRequestedScope:complete&&base.returnErrorResearch.completeWithinRequestedScope!==false}:null,marketReturnValidation:{...base.marketReturnValidation,evidenceTruncated:!complete,readCoverage:coverage}};
 return {report,summary:{...(job.state?.summary||blankSummary()),scan,budgetExhausted:!scan.complete}};
 }finally{await query(`UPDATE sports_soccer_forward_scans_v1 SET lease_owner=NULL,lease_until=NULL WHERE cursor=$1 AND lease_owner=$2`,[token,lease]);}
}

// Cron resumes one existing frozen scan before starting a new scope. This is a
// derived job cache; source receipts and historical checks remain append-only.
export async function continueSoccerForwardBacklog(scope,options={}){
 const query=options.query||soccerJournalQuery;await ensureScan(query);
 const active=await query(`SELECT cursor,scope FROM sports_soccer_forward_scans_v1 WHERE purpose='evaluate' AND complete=false AND expires_at>clock_timestamp() AND (lease_until IS NULL OR lease_until<clock_timestamp()) ORDER BY frozen_at LIMIT 1`);
 const job=active[0];return continueSoccerForwardScan(job?.scope||scope,{...options,purpose:'evaluate',cursor:job?.cursor||null});
}
