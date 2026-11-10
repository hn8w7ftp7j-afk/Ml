import { createHash } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { durableDatabaseUrl } from '../database-url.js';
import { canonicalReaderSeenCapture, readReaderSeenCaptureBatchMetadata } from '../reader-seen-capture.js';
import { RAW_SEEN_DERIVATION_VERSION, RAW_SEEN_READABLE_DERIVATION_VERSIONS, RAW_SEEN_HISTORY_FLAGS } from './raw-seen-history.js';
import { bindRawHistoryIndexDatabaseClient, invalidateRawHistoryIndexStore, initializeRawHistoryIndexStore, indexRawSeenHistoryCapture } from './raw-seen-history-index.js';
import { compatibleRawHistoryAttemptSql } from './raw-seen-history-attempt-policy.js';

export const RAW_HISTORY_MAINTENANCE_SCHEMA='soccer-raw-history-maintenance-v1';
export const RAW_HISTORY_MAINTENANCE_FLAGS=Object.freeze({...RAW_SEEN_HISTORY_FLAGS,formalEligible:false,calibrationEligible:false,indexCoverage:'NOT_VERIFIED'});
const flags=RAW_HISTORY_MAINTENANCE_FLAGS,leagues=['EPL','UCL'];
const keys=['sourceFragments','sourceBatches','indexedBatches','previousReadableIndexedBatches','unindexedBatches','stableAttemptBatches','retryPendingBatches','indexedGames'];
const fail=(code,status=503)=>Object.assign(Error(code),{code,status});
let client;const initialized=new WeakSet();
function database(options){if(options.db)return options.db;const url=durableDatabaseUrl();if(!url)throw fail('RAW_HISTORY_INDEX_STORAGE_UNAVAILABLE');return client||=neon(url);}
async function initialize(db,underlying){
  if(initialized.has(underlying))return;
  try{
    await initializeRawHistoryIndexStore({db});
    await db.transaction([
      db`CREATE TABLE IF NOT EXISTS soccer_raw_seen_history_attempts_v1 (
        capture_id CHAR(64) NOT NULL, derivation_version TEXT NOT NULL, batch_hash CHAR(64) NOT NULL,
        league TEXT NOT NULL CHECK(league IN ('EPL','UCL')), source_capture_ids JSONB NOT NULL,
        source_watermark_hash CHAR(64) NOT NULL, status TEXT NOT NULL CHECK(status='SOURCE_UNINDEXED'), reason TEXT NOT NULL,
        attempted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(capture_id,derivation_version))`,
      db`CREATE OR REPLACE TRIGGER soccer_raw_history_attempts_immutable_v1 BEFORE UPDATE OR DELETE ON soccer_raw_seen_history_attempts_v1 FOR EACH ROW EXECUTE FUNCTION reject_soccer_raw_seen_history_index_mutation_v1()`,
    ]);
    initialized.add(underlying);
  }catch(error){initialized.delete(underlying);invalidateRawHistoryIndexStore(db);throw error;}
}
// Statement/lock limits and an HTTP AbortSignal bound each database wait. An
// HTTP abort cannot prove server cancellation; receipts explicitly say SOFT.
function deadlineDatabase(source,deadline){
  const expired=()=>fail('RAW_HISTORY_INDEX_BUDGET_EXHAUSTED');
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
const empty=()=>Object.fromEntries(keys.map(key=>[key,0]));
function checkedCounts(raw){
  const value={};
  for(const key of keys){const text=String(raw?.[key]);if(!/^(?:0|[1-9]\d*)$/.test(text)||!Number.isSafeInteger(Number(text)))throw fail('RAW_HISTORY_INDEX_PROGRESS_INVALID');value[key]=Number(text);}
  if(value.sourceBatches!==value.indexedBatches+value.unindexedBatches||value.unindexedBatches!==value.stableAttemptBatches+value.retryPendingBatches||value.sourceFragments<value.sourceBatches
    ||value.previousReadableIndexedBatches>value.unindexedBatches)throw fail('RAW_HISTORY_INDEX_PROGRESS_INVALID');return value;
}
const sum=rows=>rows.reduce((total,row)=>{for(const key of keys)total[key]+=row[key];return total;},empty());
const reasonValid=value=>typeof value==='string'&&/^(?:RAW_HISTORY_INDEX_|RAW_SEEN_RECOVERY_)[A-Z0-9_]+$/.test(value);
const manifest=`CASE WHEN jsonb_typeof(b.metadata->'parts')='array' THEN b.metadata->'parts' ELSE '[]'::jsonb END`;
// Authority covers exact fragment IDs, not only a claimed batch hash. New
// fragments remain retryable. No original evidence JSON is scanned here.
const indexedFragment=(cutoff=true)=>`EXISTS(SELECT 1 FROM soccer_raw_seen_history_batches_v1 b WHERE b.league=r.league
  AND b.batch_hash=coalesce(r.capture_batch_id,r.capture_id) AND b.derivation_version=$3 ${cutoff?'AND b.indexed_at<=$2::timestamptz':''}
  AND EXISTS(SELECT 1 FROM jsonb_array_elements(${manifest}) p WHERE p->>'captureId'=btrim(r.capture_id)))`;
const attemptedFragment=(cutoff=true)=>`EXISTS(SELECT 1 FROM soccer_raw_seen_history_attempts_v1 a WHERE a.capture_id=r.capture_id
  AND a.league=r.league AND a.batch_hash=coalesce(r.capture_batch_id,r.capture_id) AND ${compatibleRawHistoryAttemptSql('a')}
  ${cutoff?'AND a.attempted_at<=$2::timestamptz':'AND (a.derivation_version=$3 OR a.attempted_at<=$2::timestamptz)'} AND a.status='SOURCE_UNINDEXED')`;

/** Read-only counts. Source batches/dates differ from fragments, board dates,
 * official games and closing lines. Missing storage is never a healthy zero. */
export async function getRawSeenHistoryProgress(options={}){
  const now=options.now??Date.now(),until=new Date(now).toISOString(),db=deadlineDatabase(database(options),Date.now()+Math.min(15000,options.timeBudgetMs??15000));
  let rows;
  try{rows=await db.query(`WITH source AS MATERIALIZED (
    SELECT r.league,r.capture_id,coalesce(r.capture_batch_id,r.capture_id) AS batch_hash,r.source_observed_at,
      ${indexedFragment()} AS indexed_fragment,${attemptedFragment()} AS attempted_fragment
    FROM sports_reader_seen_captures_v1 r WHERE r.league IN ('EPL','UCL') AND ($1::text IS NULL OR r.league=$1) AND r.persisted_at<=$2::timestamptz
  ), batches AS MATERIALIZED (
    SELECT league,batch_hash,min((source_observed_at AT TIME ZONE 'Asia/Taipei')::date) AS source_date,count(*)::int AS fragments,
      array_agg(btrim(capture_id)) AS source_capture_ids,
      bool_and(indexed_fragment) AS indexed,bool_and(attempted_fragment) AS attempted FROM source GROUP BY league,batch_hash
  ), attempt_reasons AS MATERIALIZED (
    SELECT DISTINCT ON (a.league,a.batch_hash) a.league,a.batch_hash,a.reason FROM soccer_raw_seen_history_attempts_v1 a
    WHERE ${compatibleRawHistoryAttemptSql('a')} AND a.attempted_at<=$2::timestamptz AND a.status='SOURCE_UNINDEXED'
    ORDER BY a.league,a.batch_hash,(a.derivation_version=$3) DESC,a.attempted_at DESC,a.capture_id DESC
  ), game_counts AS MATERIALIZED (
    SELECT league,batch_hash,count(*)::int AS observations FROM soccer_raw_seen_history_games_v1 WHERE derivation_version=$3 GROUP BY league,batch_hash
  ), previous_readable AS MATERIALIZED (
    SELECT DISTINCT b.league,b.batch_hash FROM soccer_raw_seen_history_batches_v1 b JOIN batches s USING(league,batch_hash)
    WHERE NOT s.indexed AND b.derivation_version<>$3 AND b.derivation_version=ANY($4::text[]) AND b.indexed_at<=$2::timestamptz
      AND NOT EXISTS(SELECT 1 FROM unnest(s.source_capture_ids) source_id
        WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(${manifest}) p WHERE p->>'captureId'=source_id))
  ), classified AS MATERIALIZED (
    SELECT s.*,a.reason,p.batch_hash IS NOT NULL AS previous_readable_indexed,
      CASE WHEN s.indexed THEN coalesce(g.observations,0) ELSE 0 END AS game_observations FROM batches s
    LEFT JOIN attempt_reasons a USING(league,batch_hash) LEFT JOIN game_counts g USING(league,batch_hash)
    LEFT JOIN previous_readable p USING(league,batch_hash)
  ), days AS (
    SELECT league,source_date::text AS source_date,sum(fragments)::text AS "sourceFragments",count(*)::text AS "sourceBatches",
      count(*) FILTER(WHERE indexed)::text AS "indexedBatches",count(*) FILTER(WHERE NOT indexed)::text AS "unindexedBatches",
      count(*) FILTER(WHERE NOT indexed AND previous_readable_indexed)::text AS "previousReadableIndexedBatches",
      count(*) FILTER(WHERE NOT indexed AND attempted)::text AS "stableAttemptBatches",
      count(*) FILTER(WHERE NOT indexed AND NOT attempted)::text AS "retryPendingBatches",sum(game_observations)::text AS "indexedGames"
    FROM classified GROUP BY league,source_date
  ), reasons AS (SELECT league,reason,count(*)::text AS batches FROM classified WHERE NOT indexed AND attempted GROUP BY league,reason)
  SELECT (SELECT coalesce(jsonb_agg(to_jsonb(days) ORDER BY league,source_date),'[]'::jsonb) FROM days) AS days,
    (SELECT coalesce(jsonb_agg(to_jsonb(reasons) ORDER BY league,reason),'[]'::jsonb) FROM reasons) AS reasons`,[null,until,RAW_SEEN_DERIVATION_VERSION,RAW_SEEN_READABLE_DERIVATION_VERSIONS]);}
  catch(error){if(error?.code==='42P01')return {ok:true,schema:RAW_HISTORY_MAINTENANCE_SCHEMA,status:'NOT_INITIALIZED',until,
    derivationVersion:RAW_SEEN_DERIVATION_VERSION,countUnit:'CANONICAL_SOURCE_BATCHES',dateBasis:'SOURCE_OBSERVATION_TAIPEI_DATE',
    dateBucketBasis:'EARLIEST_SOURCE_OBSERVATION_OF_BATCH',counts:null,leagues:leagues.map(league=>({league,counts:null,days:[],reasons:[]})),...flags};throw error;}
  const envelope=rows?.[0];if(!Array.isArray(envelope?.days)||!Array.isArray(envelope?.reasons))throw fail('RAW_HISTORY_INDEX_PROGRESS_INVALID');
  const output=leagues.map(league=>{
    const days=envelope.days.filter(row=>row.league===league).map(row=>({sourceDate:row.source_date,counts:checkedCounts(row)}));
    if(days.some(day=>!/^\d{4}-\d{2}-\d{2}$/.test(day.sourceDate)))throw fail('RAW_HISTORY_INDEX_PROGRESS_INVALID');
    const counts=sum(days.map(day=>day.counts)),reasons=envelope.reasons.filter(row=>row.league===league).map(row=>{
      if(!reasonValid(row.reason)||!/^[1-9]\d*$/.test(String(row.batches))||!Number.isSafeInteger(Number(row.batches)))throw fail('RAW_HISTORY_INDEX_PROGRESS_INVALID');
      return {code:row.reason,batches:Number(row.batches)};
    });
    if(reasons.reduce((n,row)=>n+row.batches,0)!==counts.stableAttemptBatches)throw fail('RAW_HISTORY_INDEX_PROGRESS_INVALID');
    return {league,counts,days,reasons};
  });
  if(envelope.days.some(row=>!leagues.includes(row.league))||envelope.reasons.some(row=>!leagues.includes(row.league)))throw fail('RAW_HISTORY_INDEX_PROGRESS_INVALID');
  const counts=sum(output.map(row=>row.counts));checkedCounts(counts);
  return {ok:true,schema:RAW_HISTORY_MAINTENANCE_SCHEMA,status:counts.retryPendingBatches?'PENDING':counts.stableAttemptBatches?'SOURCE_UNINDEXED':'NO_PENDING_SOURCE',
    until,derivationVersion:RAW_SEEN_DERIVATION_VERSION,countUnit:'CANONICAL_SOURCE_BATCHES',dateBasis:'SOURCE_OBSERVATION_TAIPEI_DATE',
    dateBucketBasis:'EARLIEST_SOURCE_OBSERVATION_OF_BATCH',indexedGameCountUnit:'BATCH_GAME_OBSERVATIONS',counts,leagues:output,...flags};
}
function limits(options){
  const max=options.maxBatches??64,budget=options.timeBudgetMs??40000;
  if(!Number.isInteger(max)||max<1||!Number.isInteger(budget)||budget<1000)throw fail('RAW_HISTORY_INDEX_OPTIONS_INVALID',400);
  return {maxBatches:Math.min(64,max),timeBudgetMs:Math.min(40000,budget)};
}
function failureReason(error,deadline){return Date.now()>=deadline||error?.code==='RAW_HISTORY_INDEX_BUDGET_EXHAUSTED'?'RAW_HISTORY_INDEX_BUDGET_EXHAUSTED':'RAW_HISTORY_INDEX_UNAVAILABLE';}
const stableFailure=error=>[422,413].includes(error?.status)&&reasonValid(error?.code);
async function candidate(db,{league,mode,until,seen}){
  const coverage=mode.startsWith('BUCKET_'),descending=mode==='LATEST'||mode==='BUCKET_NEWEST',direction=descending?'DESC':'ASC';
  const coverageCtes=coverage?`, represented_days AS (
    SELECT DISTINCT (observed_at AT TIME ZONE 'Asia/Taipei')::date AS source_date FROM soccer_raw_seen_history_batches_v1
    WHERE league=$1 AND derivation_version=$3
  ), attempted_days AS (
    SELECT (r.source_observed_at AT TIME ZONE 'Asia/Taipei')::date AS source_date,count(DISTINCT a.batch_hash) AS attempts
    FROM sports_reader_seen_captures_v1 r JOIN soccer_raw_seen_history_attempts_v1 a ON a.capture_id=r.capture_id
    WHERE r.league=$1 AND r.persisted_at<=$2::timestamptz AND a.league=$1
      AND a.batch_hash=coalesce(r.capture_batch_id,r.capture_id) AND ${compatibleRawHistoryAttemptSql('a')} AND a.status='SOURCE_UNINDEXED'
      AND (a.derivation_version=$3 OR a.attempted_at<=$2::timestamptz)
    GROUP BY (r.source_observed_at AT TIME ZONE 'Asia/Taipei')::date
  )`:'';
  // Keep regular candidate selection inlineable so ORDER/LIMIT can use the
  // original metadata indexes. Source cutoff is fixed; freshly committed
  // derivations/attempts remain visible for deduplication during this run.
  const rows=await db.query(`WITH eligible AS (
    SELECT r.capture_id,r.capture_batch_id,r.persisted_at,r.source_observed_at,(r.source_observed_at AT TIME ZONE 'Asia/Taipei')::date AS source_date
    FROM sports_reader_seen_captures_v1 r WHERE r.league=$1 AND r.persisted_at<=$2::timestamptz
      AND NOT ${indexedFragment(false)} AND NOT ${attemptedFragment(false)}
      AND NOT(btrim(coalesce(r.capture_batch_id,r.capture_id))=ANY($4::text[]))
  ) ${coverageCtes} SELECT r.capture_id,r.capture_batch_id,r.source_date::text AS source_date FROM eligible r
  ${coverage?'WHERE NOT EXISTS(SELECT 1 FROM represented_days d WHERE d.source_date=r.source_date)':''}
  ORDER BY ${coverage?'coalesce((SELECT attempts FROM attempted_days a WHERE a.source_date=r.source_date),0),r.source_date '+direction+',':''}
    ${coverage?'r.source_observed_at':'r.persisted_at'} ${direction},r.persisted_at ${direction},r.capture_id ${direction} LIMIT 1`,
  [league,until,RAW_SEEN_DERIVATION_VERSION,[...seen]]);
  if(rows.length)return {...rows[0],mode};
  if(coverage)return candidate(db,{league,mode:descending?'LATEST':'BACKLOG',until,seen});return null;
}
/** Bounded, balanced source-date representatives then backlog/latest work.
 * Unsupported days rotate behind unattempted days. A failed batch cannot pin
 * the same run, and new fragments remain eligible without changing old proof. */
export async function drainRawSeenHistoryIndex(options={}){
  const {maxBatches,timeBudgetMs}=limits(options),started=Date.now(),deadline=started+timeBudgetMs,now=options.now??started;
  const underlying=database(options),db=deadlineDatabase(underlying,deadline),until=new Date(now).toISOString(),results=[],selectionErrors=[],seen=new Map(leagues.map(league=>[league,new Set()])),emptyLeagues=new Set();
  bindRawHistoryIndexDatabaseClient(db,underlying);
  await initialize(db,underlying);
  const tick=Math.floor(now/60000),first=tick%2===0?'EPL':'UCL',second=first==='EPL'?'UCL':'EPL',reverse=Math.floor(tick/2)%2===1;
  let turn=0,stop='BATCH_LIMIT_REACHED';
  while(results.length<maxBatches){
    if(Date.now()>=deadline){stop='BUDGET_DEFERRED';break;}
    const league=turn%2===0?first:second,round=Math.floor(turn/2),edge=(round+(league==='EPL'?0:1)+(reverse?1:0))%2;
    const mode=round<2?(edge?'BUCKET_NEWEST':'BUCKET_OLDEST'):(edge?'LATEST':'BACKLOG');turn++;
    if(emptyLeagues.has(league)){if(emptyLeagues.size===2){stop='WINDOW_EXHAUSTED';break;}continue;}
    let selected;
    try{selected=await candidate(db,{league,mode,until,seen:seen.get(league)});}
    catch(error){selectionErrors.push({league,mode,reason:failureReason(error,deadline)});emptyLeagues.add(league);if(Date.now()>=deadline){stop='BUDGET_DEFERRED';break;}continue;}
    if(!selected){emptyLeagues.add(league);if(emptyLeagues.size===2){stop='WINDOW_EXHAUSTED';break;}continue;}
    const seed=selected.capture_id.trim(),batch=selected.capture_batch_id?.trim()||seed;seen.get(league).add(batch);
    const base={league,mode:selected.mode,captureId:seed,sourceDate:selected.source_date,...flags};
    try{
      // Replay historically checks every fragment claiming this batch, so a
      // foreign-league claim must still fail closed. Failure attempts remain
      // scoped to the selected league; one malformed claim cannot suppress it.
      const batchMetadata=await readReaderSeenCaptureBatchMetadata(seed,{sql:db,sourceCutoff:until,maxFragments:10000});
      const sourceIds=batchMetadata.rows.filter(row=>row.league===league).map(row=>row.capture_id.trim()).sort();
      try{
        const receipt=await indexRawSeenHistoryCapture(seed,{...options,db,batchMetadata,sourceCutoff:until});results.push({...base,status:'INDEXED',indexedGames:receipt.indexedGames});
      }catch(error){
        if(!stableFailure(error)){results.push({...base,status:'RETRYABLE',reason:failureReason(error,deadline)});continue;}
        const watermark=createHash('sha256').update(canonicalReaderSeenCapture(sourceIds)).digest('hex');
        // Keep each immutable attempt self-contained without repeating a
        // 10,000-ID manifest in every row (quadratic storage). Each group has
        // at most nine exact IDs and its own matching canonical watermark.
        const groups=[];
        for(let offset=0;offset<sourceIds.length;offset+=9){
          const ids=sourceIds.slice(offset,offset+9);
          groups.push({ids,watermark:createHash('sha256').update(canonicalReaderSeenCapture(ids)).digest('hex')});
        }
        await db`INSERT INTO soccer_raw_seen_history_attempts_v1(capture_id,derivation_version,batch_hash,league,source_capture_ids,source_watermark_hash,status,reason)
          SELECT id,${RAW_SEEN_DERIVATION_VERSION},${batch},${league},g->'ids',g->>'watermark','SOURCE_UNINDEXED',${error.code}
          FROM jsonb_array_elements(${JSON.stringify(groups)}::jsonb) g CROSS JOIN jsonb_array_elements_text(g->'ids') id ON CONFLICT DO NOTHING`;
        results.push({...base,status:'SOURCE_UNINDEXED',reason:error.code,sourceWatermarkHash:watermark,sourceParts:sourceIds.length,
          sourceWatermarkScope:'CUTOFF_FRAGMENT_SET',attemptWatermarkScope:'BOUNDED_FRAGMENT_GROUPS',attemptGroupCount:groups.length});
      }
    }catch(error){results.push({...base,status:'RETRYABLE',reason:failureReason(error,deadline)});}
  }
  const indexedBatches=results.filter(row=>row.status==='INDEXED').length,stableAttemptBatches=results.filter(row=>row.status==='SOURCE_UNINDEXED').length,
    retryableBatches=results.filter(row=>row.status==='RETRYABLE').length,ok=!selectionErrors.length&&!retryableBatches;
  // A stale/missing schema or transient storage error stays a failure this run.
  // The next run checks it again through its own fresh deadline adapter.
  if(!ok){initialized.delete(underlying);invalidateRawHistoryIndexStore(db);}
  if(!ok&&stop!=='BUDGET_DEFERRED')stop='RETRYABLE';
  return {ok,schema:RAW_HISTORY_MAINTENANCE_SCHEMA,status:stop,derivationVersion:RAW_SEEN_DERIVATION_VERSION,budgetKind:'SOFT_DEADLINE',hardDeadlineEnforced:false,
    results,selectionErrors,processedBatches:results.length,indexedBatches,stableAttemptBatches,retryableBatches,until,maxBatches,timeBudgetMs,
    completeWithinWindow:false,concurrentSourceCommitsVerified:false,hasMore:stop==='WINDOW_EXHAUSTED'?false:null,...flags};
}
