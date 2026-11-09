import { randomBytes, randomUUID } from 'node:crypto';
import { ensureSoccerJournal, soccerJournalQuery } from './journal.js';
import { readSoccerModelFamilyCalibrationScope, loadSoccerModelFamilyCalibrationDataset } from './model-family-data.js';
import { buildSoccerModelFamilyConfidenceSet, soccerModelFamilyHash } from './model-family-uncertainty.js';
import { diagnoseSoccerModelFamily } from './model-family-diagnostics.js';
import { freezeSoccerModelFamilyArtifact, loadLatestSoccerModelFamilyFreeze } from './model-family-store.js';
import { soccerReturnErrorPlannedProtocol } from './return-error-plans.js';

export const SOCCER_MODEL_FAMILY_SCAN_VERSION = 'SOCCER-MODEL-FAMILY-DURABLE-REPLAY-v1';
const restrictions = { accepted:false, formalEligible:false, executable:false, W:null, R:null, S:null };
const validScope = ({league,period}) => ['epl','ucl'].includes(league) && ['FT','HT'].includes(period);
const tokenValid = value => typeof value === 'string' && /^[a-f0-9]{48}$/.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = (code,status=503) => { throw Object.assign(Error(code),{code,status}); };
const iso = value => new Date(value).toISOString();
export const SOCCER_MODEL_FAMILY_SCAN_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sports_soccer_model_family_scans_v1 (
    cursor TEXT PRIMARY KEY,league TEXT NOT NULL,period TEXT NOT NULL,source_revision TEXT NOT NULL,
    source_scope JSONB NOT NULL,as_of TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    processed INTEGER NOT NULL DEFAULT 0,sequence TEXT NOT NULL DEFAULT '0',complete BOOLEAN NOT NULL DEFAULT false,
    state JSONB NOT NULL,revision INTEGER NOT NULL DEFAULT 0,lease_owner TEXT,lease_until TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (clock_timestamp()+interval '2 days'))`,
  `CREATE INDEX IF NOT EXISTS sports_soccer_model_family_scan_scope_v1
    ON sports_soccer_model_family_scans_v1(league,period,as_of DESC)`,
];
let ready;
async function ensure(query) {
  await ensureSoccerJournal();
  const run=async()=>{for(const sql of SOCCER_MODEL_FAMILY_SCAN_SCHEMA)await query(sql,[]);};
  if(query!==soccerJournalQuery)return run();
  return ready ||= run().catch(error=>{ready=null;throw error;});
}
function stateValid(job) {
  const state=job.state,{stateHash,...body}=state||{};
  if(!sha(stateHash)||soccerModelFamilyHash(body)!==stateHash
    ||!Array.isArray(state.observations)||!Array.isArray(state.quarantinedGameIds)
    ||!Number.isSafeInteger(job.processed)||job.processed<0
    ||job.processed>job.source_scope.totalCaptures)fail('MODEL_FAMILY_SCAN_STATE_INVALID');
  return state;
}
const seal = body => ({...body,stateHash:soccerModelFamilyHash(body)});
function report(job) {
  const state=stateValid(job),source=job.source_scope;
  return { version:SOCCER_MODEL_FAMILY_SCAN_VERSION,league:job.league,period:job.period,cursor:job.cursor,
    status:job.complete?'REPLAY_COMPLETE':'REPLAY_PARTIAL',sourceRevision:job.source_revision,
    asOf:iso(job.as_of),processedCaptures:job.processed,totalCaptures:source.totalCaptures,
    sourceFreshness:'HISTORICAL_AS_OF_SNAPSHOT_NOT_CURRENT_SOURCE_VERIFIED',
    completeWithinRequestedScope:job.complete,nextCursor:job.complete?null:job.cursor,
    confidenceSet:job.complete?state.confidenceSet:null,diagnostics:job.complete?state.diagnostics:null,
    excludedReasons:state.excludedReasons,quarantinedGames:state.quarantinedGameIds.length,
    sourceModelFreezeVerified:source.sourceModelFreezeVerified===true,
    familyProtocolProspectiveVerified:false,
    registrationInterpretation:'SOURCE_CALIBRATION_PLAN_NOT_FAMILY_PREREGISTRATION',...restrictions };
}
async function jobFor({league,period,cursor},query) {
  const rows=await query(`SELECT * FROM sports_soccer_model_family_scans_v1
    WHERE cursor=$1 AND expires_at>clock_timestamp()`,[cursor]);
  const job=rows[0];
  if(!job||job.league!==league||job.period!==period)fail('MODEL_FAMILY_SCAN_SCOPE_OR_EXPIRY_INVALID',400);
  stateValid(job);return job;
}
const defaults = {query:soccerJournalQuery,metadata:readSoccerModelFamilyCalibrationScope,
  page:loadSoccerModelFamilyCalibrationDataset,latestFreeze:loadLatestSoccerModelFamilyFreeze};
async function reportWithFreeze(job,deps) {
  const result=report(job),baseline=job.source_scope.baseline;
  const freeze=await deps.latestFreeze({league:job.league,period:job.period,
    modelHash:baseline.modelHash,trainingHash:baseline.trainingHash});
  return {...result,freeze,freezeMatchesReplay:Boolean(freeze&&result.confidenceSet
    &&freeze.sourceArtifactHash===result.confidenceSet.contentHash)};
}

/** Materialize only server-replayed observations. A client can continue a
 * league/period cursor, never supply rates, results, confidence or PASS flags. */
export async function continueSoccerModelFamilyScan({league,period,cursor=null},overrides={}) {
  if(!validScope({league,period})||cursor!==null&&!tokenValid(cursor))fail('MODEL_FAMILY_SCAN_SCOPE_INVALID',400);
  const deps={...defaults,...overrides};await ensure(deps.query);
  if(!cursor) {
    const clocks=await deps.query('SELECT clock_timestamp() AS observed_at',[]);
    const asOf=clocks[0]?.observed_at;
    if(!Number.isFinite(new Date(asOf).getTime()))fail('MODEL_FAMILY_DATABASE_CLOCK_UNAVAILABLE');
    const source=await deps.metadata({league,period,now:new Date(asOf).getTime()});
    if(!sha(source.sourceRevision)||!Number.isSafeInteger(source.totalCaptures)||source.totalCaptures<0
      ||source.totalCaptures>1000||!source.baseline||!source.protocol)fail('MODEL_FAMILY_SCAN_SOURCE_SCOPE_UNAVAILABLE');
    cursor=randomBytes(24).toString('hex');
    const state=seal({observations:[],quarantinedGameIds:[],excludedReasons:{}});
    await deps.query(`INSERT INTO sports_soccer_model_family_scans_v1
      (cursor,league,period,source_revision,source_scope,state,as_of) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::timestamptz)`,
    [cursor,league,period,source.sourceRevision,JSON.stringify(source),JSON.stringify(state),iso(asOf)]);
  }
  let job=await jobFor({league,period,cursor},deps.query);
  if(job.complete)return report(job);
  const lease=randomUUID();
  const claimed=await deps.query(`UPDATE sports_soccer_model_family_scans_v1 SET lease_owner=$2,
    lease_until=clock_timestamp()+interval '70 seconds' WHERE cursor=$1 AND complete=false
    AND (lease_until IS NULL OR lease_until<=clock_timestamp()) RETURNING cursor`,[cursor,lease]);
  if(!claimed.length)return {...report(job),status:'REPLAY_BUSY'};
  try {
    const source=job.source_scope;
    const page=await deps.page({league,period,protocol:source.protocol,now:new Date(job.as_of).getTime(),
      afterSequence:job.sequence,captureLimit:1,expectedRevision:job.source_revision,timeBudgetMs:25000});
    const {contentHash,...pageBody}=page||{};
    if(!sha(contentHash)||soccerModelFamilyHash(pageBody)!==contentHash)fail('MODEL_FAMILY_SCAN_PAGE_HASH_INVALID');
    if(page.sourceRevision!==job.source_revision
      ||soccerModelFamilyHash(page.baseline)!==soccerModelFamilyHash(source.baseline)
      ||soccerModelFamilyHash(page.protocol)!==soccerModelFamilyHash(source.protocol))
      fail('MODEL_FAMILY_SCAN_SOURCE_CHANGED',409);
    const coverage=page.coverage;
    if(!coverage||!Number.isSafeInteger(coverage.readCaptures)||coverage.readCaptures<0
      ||coverage.totalCaptures!==source.totalCaptures||!Array.isArray(page.observations)
      ||!Array.isArray(page.quarantinedGameIds))fail('MODEL_FAMILY_SCAN_PAGE_INVALID');
    const processed=job.processed+coverage.readCaptures,complete=coverage.complete===true;
    const next=coverage.nextSequence;
    if(processed>source.totalCaptures||complete&&processed!==source.totalCaptures
      ||!complete&&(!/^(?:0|[1-9]\d{0,18})$/.test(next||'')||BigInt(next)<BigInt(job.sequence))
      ||!complete&&processed>job.processed&&BigInt(next)<=BigInt(job.sequence))fail('MODEL_FAMILY_SCAN_PAGE_INVALID');
    if(!complete&&coverage.readCaptures===0)return {...report(job),lastPageReason:page.page?.reason||'MODEL_FAMILY_DATA_TIME_BUDGET'};
    const old=stateValid(job),quarantinedGameIds=[...new Set([...old.quarantinedGameIds,...page.quarantinedGameIds])];
    const excludedReasons={...old.excludedReasons};
    for(const [code,count] of Object.entries(page.excludedReasons||{})) {
      if(!/^[A-Z][A-Z0-9_]{1,120}$/.test(code)||!Number.isSafeInteger(count)||count<0)fail('MODEL_FAMILY_SCAN_PAGE_INVALID');
      excludedReasons[code]=(excludedReasons[code]||0)+count;
    }
    const observations=[...old.observations,...page.observations].filter(row=>!quarantinedGameIds.includes(row.gameId));
    const body={observations,quarantinedGameIds,excludedReasons};
    if(complete) {
      body.confidenceSet=buildSoccerModelFamilyConfidenceSet({observations,baseline:source.baseline,
        protocol:source.protocol,now:new Date(job.as_of).getTime()});
      body.diagnostics=diagnoseSoccerModelFamily({observations,baseline:source.baseline,protocol:source.protocol,
        now:new Date(job.as_of).getTime(),requestedScopeComplete:true});
    }
    const state=seal(body);
    if(Buffer.byteLength(JSON.stringify(state))>2*1024*1024)fail('MODEL_FAMILY_SCAN_STATE_BUDGET');
    const saved=await deps.query(`UPDATE sports_soccer_model_family_scans_v1 SET state=$3::jsonb,processed=$4,
      sequence=$5,complete=$6,revision=revision+1 WHERE cursor=$1 AND lease_owner=$2
      AND lease_until>clock_timestamp() AND revision=$7 RETURNING cursor`,
    [cursor,lease,JSON.stringify(state),processed,complete?job.sequence:next,complete,job.revision]);
    if(saved.length!==1)fail('MODEL_FAMILY_SCAN_LEASE_LOST');
    job=await jobFor({league,period,cursor},deps.query);return report(job);
  } finally {
    await deps.query(`UPDATE sports_soccer_model_family_scans_v1 SET lease_owner=NULL,lease_until=NULL
      WHERE cursor=$1 AND lease_owner=$2`,[cursor,lease]);
  }
}

export async function readSoccerModelFamilyScan({league,period,cursor=null},overrides={}) {
  if(!validScope({league,period})||cursor!==null&&!tokenValid(cursor))fail('MODEL_FAMILY_SCAN_SCOPE_INVALID',400);
  const deps={...defaults,...overrides},{query}=deps;await ensure(query);
  if(cursor)return reportWithFreeze(await jobFor({league,period,cursor},query),deps);
  const rows=await query(`SELECT * FROM sports_soccer_model_family_scans_v1
    WHERE league=$1 AND period=$2 AND expires_at>clock_timestamp() ORDER BY as_of DESC,cursor DESC LIMIT 1`,[league,period]);
  return rows[0]?reportWithFreeze(rows[0],deps):{version:SOCCER_MODEL_FAMILY_SCAN_VERSION,league,period,status:'NOT_STARTED',freeze:null,...restrictions};
}

export async function freezeSoccerModelFamilyScan({league,period,cursor},overrides={}) {
  if(!validScope({league,period})||!tokenValid(cursor))fail('MODEL_FAMILY_SCAN_SCOPE_INVALID',400);
  const deps={...defaults,freeze:freezeSoccerModelFamilyArtifact,...overrides};await ensure(deps.query);
  const job=await jobFor({league,period,cursor},deps.query),state=stateValid(job),artifact=state.confidenceSet;
  if(!job.complete||!artifact||!(artifact.independentRealGames>=1))fail('MODEL_FAMILY_COMPLETE_DATASET_REQUIRED',409);
  const current=await deps.metadata({league,period,now:new Date(job.as_of).getTime()});
  if(current.sourceRevision!==job.source_revision
    ||soccerModelFamilyHash(current.baseline)!==soccerModelFamilyHash(job.source_scope.baseline)
    ||soccerModelFamilyHash(current.protocol)!==soccerModelFamilyHash(job.source_scope.protocol))
    fail('MODEL_FAMILY_SCAN_SOURCE_CHANGED',409);
  // UTC midnight is an explicit future boundary, never a retroactive claim
  // that the new family method was registered before its old source cohort.
  const clocks=await deps.query('SELECT clock_timestamp() AS observed_at',[]);
  const now=new Date(clocks[0]?.observed_at).getTime();
  if(!Number.isFinite(now))fail('MODEL_FAMILY_DATABASE_CLOCK_UNAVAILABLE');
  const testFrom=iso((Math.floor(now/86400000)+1)*86400000);
  const testBefore=soccerReturnErrorPlannedProtocol(league).plan.testBefore;
  if(Date.parse(testFrom)>=Date.parse(testBefore))fail('MODEL_FAMILY_TEST_PLAN_EXPIRED',409);
  const receipt=await deps.freeze({artifact,testFrom,testBefore});
  return {ok:true,league,period,freeze:receipt,...restrictions};
}
