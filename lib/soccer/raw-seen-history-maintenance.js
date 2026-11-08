import { createHash } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { durableDatabaseUrl } from '../database-url.js';
import { canonicalReaderSeenCapture } from '../reader-seen-capture.js';
import { RAW_SEEN_DERIVATION_VERSION, RAW_SEEN_HISTORY_FLAGS } from './raw-seen-history.js';
import { initializeRawHistoryIndexStore, indexRawSeenHistoryCapture } from './raw-seen-history-index.js';

const flags={...RAW_SEEN_HISTORY_FLAGS,formalEligible:false,calibrationEligible:false};
let client;const initialized=new WeakMap();
function database(options){if(options.db)return options.db;const url=durableDatabaseUrl();if(!url)throw Error('RAW_HISTORY_INDEX_STORAGE_UNAVAILABLE');return client||=neon(url);}
async function initialize(db){
  if(!initialized.has(db))initialized.set(db,(async()=>{
    await initializeRawHistoryIndexStore({db});
    await db.transaction([
      db`CREATE TABLE IF NOT EXISTS soccer_raw_seen_history_attempts_v1 (
        capture_id CHAR(64) NOT NULL, derivation_version TEXT NOT NULL, batch_hash CHAR(64) NOT NULL,
        league TEXT NOT NULL CHECK(league IN ('EPL','UCL')), source_capture_ids JSONB NOT NULL,
        source_watermark_hash CHAR(64) NOT NULL, status TEXT NOT NULL CHECK(status='SOURCE_UNINDEXED'), reason TEXT NOT NULL,
        attempted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(capture_id,derivation_version))`,
      db`CREATE OR REPLACE TRIGGER soccer_raw_history_attempts_immutable_v1 BEFORE UPDATE OR DELETE ON soccer_raw_seen_history_attempts_v1 FOR EACH ROW EXECUTE FUNCTION reject_soccer_raw_seen_history_index_mutation_v1()`,
    ]);
  })().catch(e=>{initialized.delete(db);throw e;}));await initialized.get(db);
}
// Every SQL path, including initialization and replay writes, uses this lazy
// adapter. DB statement/lock limits protect the transaction; AbortSignal also
// bounds the HTTP wait. An HTTP abort does not prove server cancellation, so
// this remains an explicitly soft deadline and writes stay idempotent.
function deadlineDatabase(source,deadline){
  const expired=()=>Object.assign(Error('RAW_HISTORY_INDEX_BUDGET_EXHAUSTED'),{code:'RAW_HISTORY_INDEX_BUDGET_EXHAUSTED',status:503});
  async function run(queries,transactionOptions={}){
    const remaining=deadline-Date.now();if(remaining<=0)throw expired();
    const perStatementMs=Math.max(1,Math.min(5000,Math.floor(remaining/(queries.length+2))));
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),remaining);
    try{
      const result=await source.transaction([
        source`SELECT set_config('statement_timeout',${String(perStatementMs)},true)`,
        source`SELECT set_config('lock_timeout',${String(perStatementMs)},true)`,
        ...queries.map(query=>source.query(query.query,query.params)),
      ],{...transactionOptions,fetchOptions:{...transactionOptions.fetchOptions,signal:controller.signal}});
      if(Date.now()>=deadline){controller.abort();throw expired();}
      return result.slice(2);
    }finally{clearTimeout(timer);}
  }
  const query=(text,params=[])=>({query:text,params,then(resolve,reject){return run([{query:text,params}]).then(rows=>rows[0]).then(resolve,reject);}});
  const db=(strings,...params)=>query(strings.reduce((sql,part,i)=>sql+(i?'$'+i:'')+part,''),params);
  db.query=query;db.transaction=(queries,options)=>run(queries,options);return db;
}
function failed(error,deadline){return Date.now()>=deadline||error?.code==='RAW_HISTORY_INDEX_BUDGET_EXHAUSTED'
  ?{status:'BUDGET_DEFERRED',reason:'RAW_HISTORY_INDEX_BUDGET_EXHAUSTED'}
  :{status:'RETRYABLE',reason:'RAW_HISTORY_INDEX_UNAVAILABLE'};}
const stableFailure=error=>[422,413].includes(error?.status)&&/^(?:RAW_HISTORY_INDEX_|RAW_SEEN_RECOVERY_)[A-Z0-9_]+$/.test(error?.code||'');

// Every run checks at most one batch per league. Alternating newest and oldest
// and independently rotating first league gives recent and backlog work
// for each league a first turn over four runs. Old unprocessed sources
// continue to advance. This is NOT a claim that every observation is indexed.
export async function drainRawSeenHistoryIndex(options={}){
  const started=Date.now(),budget=Math.min(20000,Math.max(1000,options.timeBudgetMs??20000)),deadline=started+budget,db=deadlineDatabase(database(options),deadline);
  await initialize(db);
  const hour=new Date(options.now??started).getUTCHours();
  const latestFirst=Math.floor(hour/2)%2===0;
  const until=new Date(options.now??Date.now()).toISOString(),results=[];
  const leagues=hour%2===0?['EPL','UCL']:['UCL','EPL'];
  for(const league of leagues){
    const mode=(league==='EPL'?latestFirst:!latestFirst)?'LATEST':'BACKLOG';
    if(Date.now()>=deadline){results.push({league,mode,status:'BUDGET_DEFERRED',...flags});continue;}
    try{
      // Use the persisted-time index. No JSON payload is scanned to find work,
      // and a known unsupported batch cannot pin the backlog forever. Each
      // previously unseen fragment ID becomes eligible even after an earlier
      // incomplete-batch receipt; 503/storage failures are never skipped.
      const candidates=mode==='LATEST'
        ?await db`SELECT r.capture_id,r.capture_batch_id FROM sports_reader_seen_captures_v1 r WHERE r.league=${league} AND r.persisted_at<=${until}::timestamptz
          AND NOT EXISTS(SELECT 1 FROM soccer_raw_seen_history_batches_v1 b WHERE b.batch_hash=coalesce(r.capture_batch_id,r.capture_id) AND b.derivation_version=${RAW_SEEN_DERIVATION_VERSION})
          AND NOT EXISTS(SELECT 1 FROM soccer_raw_seen_history_attempts_v1 a WHERE a.capture_id=r.capture_id AND a.derivation_version=${RAW_SEEN_DERIVATION_VERSION}) ORDER BY r.persisted_at DESC,r.capture_id DESC LIMIT 1`
        :await db`SELECT r.capture_id,r.capture_batch_id FROM sports_reader_seen_captures_v1 r WHERE r.league=${league} AND r.persisted_at<=${until}::timestamptz
          AND NOT EXISTS(SELECT 1 FROM soccer_raw_seen_history_batches_v1 b WHERE b.batch_hash=coalesce(r.capture_batch_id,r.capture_id) AND b.derivation_version=${RAW_SEEN_DERIVATION_VERSION})
          AND NOT EXISTS(SELECT 1 FROM soccer_raw_seen_history_attempts_v1 a WHERE a.capture_id=r.capture_id AND a.derivation_version=${RAW_SEEN_DERIVATION_VERSION}) ORDER BY r.persisted_at,r.capture_id LIMIT 1`;
      if(!candidates.length){results.push({league,mode,status:'NO_PENDING_SOURCE',...flags});continue;}
      const seed=candidates[0].capture_id.trim(),batch=candidates[0].capture_batch_id?.trim()||seed;
      // Capture the exact retry watermark BEFORE replay. A fragment arriving
      // during replay remains unacknowledged and eligible for a later run.
      const sourceRows=await db`SELECT capture_id FROM sports_reader_seen_captures_v1 WHERE league=${league} AND (capture_id=${seed} OR capture_batch_id=${batch}) AND persisted_at<=${until}::timestamptz ORDER BY (capture_id=${seed}) DESC,capture_id LIMIT 9`;
      const sourceIds=sourceRows.map(r=>r.capture_id.trim()).sort();
      try{
        const receipt=await indexRawSeenHistoryCapture(seed,{...options,db,sourceCutoff:until});
        results.push({league,mode,status:'INDEXED',captureId:seed,indexedGames:receipt.indexedGames,...flags});
      }catch(error){
        if(!stableFailure(error)){results.push({league,mode,...failed(error,deadline),captureId:seed,...flags});continue;}
        const watermark=createHash('sha256').update(canonicalReaderSeenCapture(sourceIds)).digest('hex');
        await db`INSERT INTO soccer_raw_seen_history_attempts_v1(capture_id,derivation_version,batch_hash,league,source_capture_ids,source_watermark_hash,status,reason)
          SELECT id,${RAW_SEEN_DERIVATION_VERSION},${batch},${league},${JSON.stringify(sourceIds)}::jsonb,${watermark},'SOURCE_UNINDEXED',${error.code}
          FROM jsonb_array_elements_text(${JSON.stringify(sourceIds)}::jsonb) id ON CONFLICT DO NOTHING`;
        results.push({league,mode,status:'SOURCE_UNINDEXED',captureId:seed,reason:error.code,sourceWatermarkHash:watermark,sourceParts:sourceIds.length,...flags});
      }
    }catch(error){results.push({league,mode,...failed(error,deadline),...flags});}
  }
  results.sort((a,b)=>['EPL','UCL'].indexOf(a.league)-['EPL','UCL'].indexOf(b.league));
  return {ok:results.every(r=>r.status!=='RETRYABLE'),status:'PARTIAL',budgetKind:'SOFT_DEADLINE',hardDeadlineEnforced:false,results,until,maxBatches:2,timeBudgetMs:budget,completeWithinWindow:false,indexCoverage:'NOT_VERIFIED',...flags};
}
