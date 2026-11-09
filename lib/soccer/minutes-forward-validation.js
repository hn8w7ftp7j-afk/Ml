import { soccerLeague, validSoccerDate } from './contracts.js';
import { loadSoccerAnalysisRevision } from './analysis-store.js';
import { loadSoccerSourceDocument } from './source-document-store.js';
import { loadSoccerObservation, restoreSoccerPersonnelObservationProjection } from './observation-store.js';
import { normalizeSoccerPrematch } from './prematch.js';
import { restoreSoccerPersonnelInputObservation } from './personnel-inputs.js';
import { soccerExpectedMinutesArtifacts } from './expected-minutes-frozen.js';
import { soccerExpectedMinutesHash, soccerExpectedMinutesFeatures, predictSoccerExpectedMinutes,
  reconcileSoccerExpectedMinutesTeam } from './expected-minutes-model.js';
import { fetchSoccerJson, normalizeSoccerSchedule } from './data.js';
import { retainSoccerProviderDocument, soccerProviderDocumentHashValid } from './provider-document.js';
import { normalizeSoccerSettlementResult } from './settlement-result.js';
import { soccerMinutesAuditV2 } from './personnel-audit.js';
import { createSoccerCalibrationResultChronology, normalizeSoccerCalibrationShadowResult } from './calibration-shadow-validation.js';

export const SOCCER_MINUTES_FORWARD_VERSION = 'SOCCER-MINUTES-FORWARD-v1';
export const soccerMinutesForwardHash = soccerExpectedMinutesHash;
export const SOCCER_MINUTES_FORWARD_WEIGHTING = 'EQUAL_REAL_GAME_THEN_EQUAL_PRIOR_CANDIDATE_PLAYER';
const flags = { accepted:false, formalEligible:false, executable:false, W:null, R:null, S:null };
const roles = ['STARTER','SUBSTITUTE','NO_APPEARANCE'], DAY=86400000;
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const time = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
const hash = soccerMinutesForwardHash, clone = value => structuredClone(value);
const fail = code => { throw Error(code); };
const publicReason = error => /^MINUTES_FORWARD_[A-Z0-9_]{1,160}$/.test(error?.message||'') ? error.message : 'MINUTES_FORWARD_SOURCE_OR_STORAGE_UNAVAILABLE';
const proofs = new WeakMap();
const store = () => import('./minutes-forward-store.js');
const emptyMetric = () => ({games:0,playerTargets:0,minuteMAE:null,minuteRMSE:null,logLoss:null,logLossState:'UNAVAILABLE',brier:null});
const emptyCoverage = () => ({evaluatedGames:0,modeledPlayerTargets:0,unmodeledCurrentRosterPlayers:0,unseenAppearingPlayers:0,unseenRegulationMinutes:0});
const mean = values => values.reduce((sum,value)=>sum+value,0)/values.length;

/** A separately frozen evaluation contract. Existing forecast/artifact bytes
 * and the model's retrospective diagnostic never change. */
export function soccerMinutesForwardProtocol(league) {
  if(!['epl','ucl'].includes(league))fail('MINUTES_FORWARD_SCOPE_INVALID');
  const artifact=soccerExpectedMinutesArtifacts(),model=artifact.leagues[league].model;
  return {version:SOCCER_MINUTES_FORWARD_VERSION,league,artifactHash:artifact.contentHash,modelHash:hash(model),model:clone(model),
    modelCreatedAt:artifact.createdAt,trainingBefore:model.trainingBefore,
    baselineMethod:'PRIOR_THREE_MATCH_MEAN_MINUTES_AND_ROLE_FREQUENCIES_WITH_ONE_TRAINING_GLOBAL_PSEUDO_OBSERVATION',
    metrics:['minuteMAE','minuteRMSE','logLoss','brier'],metricWeighting:SOCCER_MINUTES_FORWARD_WEIGHTING,
    candidateSelection:'AVAILABLE_SIDES_FULL_PRIOR_CANDIDATE_SET_WITH_CURRENT_ROSTER_COVERAGE_REPORTED',
    reconciliation:'SAME_FULL_PRIOR_TEAM_UPPER_BOUND_RECONCILIATION_BEFORE_CURRENT_ROSTER_FILTER',
    clockBasis:'PROVIDER_REGULATION_MINUTES_EXCLUDES_ADDED_TIME',zeroProbabilityPolicy:'POSITIVE_INFINITY_WITHOUT_PROBABILITY_CLIPPING',
    sourceScope:'ESPN_TWO_ENDPOINT_CROSSCHECK_NOT_INDEPENDENT_OFFICIAL_CONFIRMATION',
    acceptance:'OBSERVATIONS_ONLY_NO_AUTOMATIC_MODEL_OR_SCORE_PROMOTION',...flags};
}

const vector = player => ({id:player.id,probabilities:[player.startProbability,player.substituteProbability,player.noAppearanceProbability],expectedMinutes:player.expectedMinutes});
function predictions(model,prior,baseline) {
  const players=soccerExpectedMinutesFeatures(prior).map(feature=>({...feature,...predictSoccerExpectedMinutes(model,feature,{baseline})}));
  reconcileSoccerExpectedMinutesTeam(players);
  return players.map(vector).sort((a,b)=>a.id.localeCompare(b.id));
}
function checkedVector(player) {
  return /^\d{1,16}$/.test(player?.id||'') && Array.isArray(player.probabilities)&&player.probabilities.length===3
    && player.probabilities.every(p=>Number.isFinite(p)&&p>=0&&p<=1)
    && Math.abs(player.probabilities.reduce((a,b)=>a+b,0)-1)<=1e-10
    && Number.isFinite(player.expectedMinutes)&&player.expectedMinutes>=0&&player.expectedMinutes<=90;
}

async function buildFromOriginal(snapshot,revision,at) {
  const {league,gameId,date}=snapshot||{};
  if(!['epl','ucl'].includes(league)||!new RegExp(`^soccer:${league}:\\d{1,16}$`).test(gameId||'')||!validSoccerDate(date)||!sha(revision))fail('MINUTES_FORWARD_CAPTURE_SCOPE_INVALID');
  const loaded=await loadSoccerAnalysisRevision(league,gameId,date,revision),{persisted:_persisted,revision:_revision,...original}=loaded;
  const evidence=original.evidence,game=evidence?.game,cutoff=time(original.analysisCutoff),protocol=soccerMinutesForwardProtocol(league);
  // Minutes observations are an independent research target. A missing joint
  // score prediction must not select which valid player forecasts are saved.
  if(original.status!=='RESEARCH_ONLY'||!['COMPLETED','INSUFFICIENT_DATA'].includes(original.analysisStatus)||evidence?.ok!==true||evidence.phase!=='PREMATCH_OBSERVATION'
    ||game?.id!==gameId||game.league!==league||game.date!==date||game.status!=='scheduled'||!Number.isFinite(cutoff)
    ||cutoff>at||!(at<time(game.startTime))||time(protocol.modelCreatedAt)>cutoff||time(protocol.trainingBefore)>=cutoff)fail('MINUTES_FORWARD_ORIGINAL_NOT_PREGAME');
  const source=evidence.source,receiptId=evidence.sourceDocumentArchive?.receiptId;
  if(!sha(receiptId))fail('MINUTES_FORWARD_SOURCE_RECEIPT_MISSING');
  const retained=await loadSoccerSourceDocument(receiptId),r=retained.receipt;
  if(r.prematchReceipt!==true||r.gameId!==gameId||r.league!==league||r.sourceUrl!==source?.url||r.contentHash!==source?.contentHash
    ||r.fetchedAt!==source.fetchedAt||time(r.recordedAt)>cutoff||time(r.recordedAt)>at)fail('MINUTES_FORWARD_SOURCE_RECEIPT_INVALID');
  const projection=await restoreSoccerPersonnelObservationProjection(evidence,{now:at});
  if(!projection)fail('MINUTES_FORWARD_ARCHIVED_FORECAST_UNAVAILABLE');
  const rebuilt=normalizeSoccerPrematch(retained.document,game,evidence.rawSource,cutoff);
  if(!rebuilt.ok||rebuilt.phase!=='PREMATCH_OBSERVATION'||hash(rebuilt.game)!==hash(game)
    ||['home','away'].some(side=>hash(rebuilt.teams[side].lineup)!==hash(evidence.teams[side].lineup)))fail('MINUTES_FORWARD_SUMMARY_REPLAY_MISMATCH');
  rebuilt.sourceDocumentArchive=clone(r);
  const teams={},observationReceipts=[];
  for(const side of ['home','away']) {
    const observed=evidence.teams?.[side]?.minutes;
    if(observed?.status!=='RESEARCH_FORECAST_AVAILABLE'){teams[side]={sourceId:game[side].sourceId,status:'UNAVAILABLE',reason:'PRIOR_FORECAST_NOT_AVAILABLE',model:[],baseline:[],currentRosterIds:[]};continue;}
    const observationId=observed.observationArchive?.receiptId;
    if(!sha(observationId))fail('MINUTES_FORWARD_OBSERVATION_RECEIPT_MISSING');
    const stored=await loadSoccerObservation(observationId),receipt=stored.receipt;
    if(receipt.prematchReceipt!==true||receipt.gameId!==gameId||receipt.league!==league||receipt.field!==`teams.${side}.minutes`
      ||time(receipt.recordedAt)>cutoff||time(receipt.recordedAt)>at)fail('MINUTES_FORWARD_OBSERVATION_RECEIPT_INVALID');
    const proof={...stored.adapterMetadata,reconstructionInputs:stored.reconstructionInputs,
      binding:{...stored.binding,startTime:stored.binding.kickoffAt}};
    const observation=restoreSoccerPersonnelInputObservation(rebuilt,proof);
    if(observation.model?.modelHash!==protocol.modelHash||observation.model?.artifactHash!==protocol.artifactHash)fail('MINUTES_FORWARD_MODEL_BINDING_INVALID');
    const workload=stored.reconstructionInputs.workload.teams[side].playerWorkload;
    const prior=workload.matches.filter(match=>match.competition?.slug===soccerLeague(league).espnSlug
      &&time(match.startTime)+DAY<=stored.reconstructionInputs.cutoff&&time(match.startTime)>=time(game.startTime)-14*DAY);
    if(!prior.length)fail('MINUTES_FORWARD_PRIOR_HISTORY_UNAVAILABLE');
    const modeled=predictions(protocol.model,prior,false),baseline=predictions(protocol.model,prior,true);
    const saved=[...observation.players.filter(p=>p.forecastStatus==='PRIOR_PARTICIPATION_FORECAST'),...observation.unboundPriorCandidates].map(vector).sort((a,b)=>a.id.localeCompare(b.id));
    if(!modeled.every(checkedVector)||!baseline.every(checkedVector)||hash(modeled)!==hash(saved)
      ||hash(modeled.map(p=>p.id))!==hash(baseline.map(p=>p.id)))fail('MINUTES_FORWARD_PREDICTION_REPLAY_MISMATCH');
    const current=[...rebuilt.teams[side].lineup.starters,...rebuilt.teams[side].lineup.bench].map(p=>p.id).sort();
    teams[side]={sourceId:game[side].sourceId,status:'FROZEN_PRIOR_FORECAST',model:modeled,baseline,currentRosterIds:current,
      unmodeledCurrentRosterIds:current.filter(id=>!modeled.some(p=>p.id===id)),observationReceiptId:observationId};
    observationReceipts.push({receiptId:observationId,recordedAt:receipt.recordedAt,field:receipt.field});
  }
  if(!Object.values(teams).some(team=>team.model.length))fail('MINUTES_FORWARD_PRIOR_FORECAST_UNAVAILABLE');
  const body={version:SOCCER_MINUTES_FORWARD_VERSION,league,game:clone(game),analysisRevision:revision,analysisCutoff:original.analysisCutoff,
    parentAnalysisStatus:original.analysisStatus,parentQaFlag:original.qaFlag,
    modelHash:protocol.modelHash,artifactHash:protocol.artifactHash,protocolHash:hash(protocol),sourceReceiptId:receiptId,sourceHash:source.contentHash,
    sourceRecordedAt:r.recordedAt,observationReceipts,teams,...flags};
  return {league,gameId,date,kickoffAt:game.startTime,analysisRevision:revision,analysisCutoff:original.analysisCutoff,
    sourceReceiptId:receiptId,sourceHash:source.contentHash,sourceRecordedAt:r.recordedAt,observationReceipts,protocolHash:hash(protocol),body};
}

/** Only default immutable DB loaders can mint this process-private proof. */
export async function prepareSoccerMinutesForwardCapture(snapshot,revision) {
  const prepared=await buildFromOriginal(snapshot,revision,Date.now());proofs.set(prepared,{signature:hash(prepared),proof:clone(prepared)});return prepared;
}
export function getSoccerMinutesForwardCaptureProof(prepared) {
  const stored=proofs.get(prepared);return stored&&stored.signature===hash(prepared)?clone(stored.proof):null;
}
export async function replaySoccerMinutesForwardCapture({capture,protocol}) {
  const body=capture.body||capture.predictionBody,at=time(capture.capturedAt),definition=protocol?.protocol||protocol;
  if(!body||!Number.isFinite(at)||hash(definition)!==body.protocolHash||definition.modelHash!==body.modelHash
    ||!(time(protocol?.registeredAt)<time(body.analysisCutoff)))fail('MINUTES_FORWARD_CAPTURE_PROTOCOL_INVALID');
  const rebuilt=await buildFromOriginal({league:capture.league,gameId:capture.gameId,date:capture.date},capture.analysisRevision,at);
  if(hash(rebuilt.body)!==hash(body))fail('MINUTES_FORWARD_CAPTURE_REPLAY_MISMATCH');
  return {ok:true,body:clone(body)};
}

export async function ensureSoccerMinutesForwardProtocol(league) {return (await store()).freezeSoccerMinutesForwardProtocol(league);}
export async function captureSoccerMinutesForward(snapshot,revision) {
  try {const prepared=await prepareSoccerMinutesForwardCapture(snapshot,revision),saved=await(await store()).archiveSoccerMinutesForwardCapture(prepared);
    if(saved?.persisted!==true)return {version:SOCCER_MINUTES_FORWARD_VERSION,status:'NOT_CAPTURED',persisted:false,reason:saved?.reason||'MINUTES_FORWARD_CAPTURE_NOT_SAVED',...flags};
    const receipt={...saved,status:'DATABASE_PREGAME_CAPTURED',league:prepared.league,gameId:prepared.gameId};
    return {version:SOCCER_MINUTES_FORWARD_VERSION,status:'PREDICTION_SAVED',persisted:true,receipt,...flags};}
  catch(error){return {version:SOCCER_MINUTES_FORWARD_VERSION,status:'NOT_CAPTURED',persisted:false,reason:publicReason(error),...flags};}
}

/** Target labels require normal 90-minute final results from both endpoints,
 * exact raw hashes, and the independent V2 player-ID/active-state audit. */
export function normalizeSoccerMinutesForwardResult(game,documents,checkedAt) {
  const now=time(checkedAt),league=soccerLeague(game?.league);
  if(!league||!Number.isFinite(now)||!documents?.scoreboard?.ok||!Array.isArray(documents.summaries)||!documents.summaries.length)
    return {ok:false,reason:'MINUTES_FORWARD_RESULT_DOCUMENTS_UNAVAILABLE'};
  for(const [index,document] of [documents.scoreboard,...documents.summaries].entries()) {
    if(!document.ok||document.source?.provider!=='ESPN'||!soccerProviderDocumentHashValid(document)||!(time(document.source?.fetchedAt)>time(game.startTime))
      ||time(document.source.fetchedAt)>now||document.source.requestedAt!=null&&(!Number.isFinite(time(document.source.requestedAt))
        ||time(document.source.requestedAt)>time(document.source.fetchedAt)))return {ok:false,reason:'MINUTES_FORWARD_RESULT_DOCUMENT_INVALID'};
    try {const u=new URL(document.source.url);if(u.origin!=='https://site.api.espn.com'||u.username||u.password||u.hash
      ||u.pathname!==`/apis/site/v2/sports/soccer/${league.espnSlug}/${index?'summary':'scoreboard'}`
      ||index&&(u.searchParams.getAll('event').length!==1||u.searchParams.get('event')!==game.sourceId)
      ||!index&&(u.searchParams.getAll('dates').length!==1||u.searchParams.get('dates')!==new Date(game.startTime).toISOString().slice(0,10).replaceAll('-','')))throw Error();}catch{return {ok:false,reason:'MINUTES_FORWARD_RESULT_SOURCE_INVALID'};}
  }
  const board=normalizeSoccerSchedule(documents.scoreboard.data,league.id,documents.scoreboard.source);
  const context=normalizeSoccerCalibrationShadowResult(game,documents,checkedAt),chronology=context.chronologyEvidence||[];
  if(context.quarantine)return {ok:false,quarantine:true,reason:context.reason,chronologyEvidence:chronology};
  const valid=[];
  for(const summary of documents.summaries) {
    const result=normalizeSoccerSettlementResult({league:league.id,gameId:game.id,date:game.date,startTime:game.startTime,
      teamIds:{home:game.home.id,away:game.away.id}},summary,board,now);
    if(!result.ok)return {ok:false,reason:result.reason,quarantine:['RESULT_ENDPOINTS_DISAGREE','RESULT_EXTRA_PERIODS_REQUIRE_REVIEW','RESULT_REGULATION_FORMAT_UNVERIFIED'].includes(result.reason),chronologyEvidence:chronology};
    const audit=soccerMinutesAuditV2(summary.data,{...game,status:'final'});
    if(audit.status!=='REGULATION_CLOCK_RECONSTRUCTED')return {ok:false,reason:audit.reason||'MINUTES_FORWARD_ACTUAL_MINUTES_UNVERIFIED',chronologyEvidence:chronology};
    const playerIds=Object.values(audit.teams).flatMap(team=>team.players.map(p=>p.id));
    if(summary.data.rosters?.length!==2||new Set(playerIds).size!==playerIds.length)
      return {ok:false,quarantine:true,reason:'MINUTES_FORWARD_TARGET_PLAYER_IDENTITY_CONFLICT',chronologyEvidence:chronology};
    valid.push({result,audit});
  }
  const signature=value=>hash({fullTime:value.result.fullTime,teams:Object.fromEntries(['home','away'].map(side=>[side,
    {sourceId:value.audit.teams[side].sourceId,players:value.audit.teams[side].players.map(p=>({id:p.id,starter:p.starter,appeared:p.appeared,minutes:p.regulationClockMinutes})).sort((a,b)=>a.id.localeCompare(b.id))}]))});
  if(valid.some(value=>signature(value)!==signature(valid[0])))return {ok:false,quarantine:true,reason:'MINUTES_FORWARD_TARGET_REVISION_CONFLICT',chronologyEvidence:chronology};
  return {ok:true,targetHash:signature(valid[0]),teams:valid[0].audit.teams,chronologyEvidence:chronology,
    clockBasis:valid[0].audit.clockBasis,sourceScope:'ESPN_TWO_ENDPOINT_CROSSCHECK_NOT_INDEPENDENT_OFFICIAL_CONFIRMATION'};
}

/** Metrics use one weight per real game, then equal player weights within that
 * game. True zero-probability outcomes remain infinite, never clipped. */
export function evaluateSoccerMinutesForwardPrediction(body,target) {
  if(!target?.ok)fail('MINUTES_FORWARD_TARGET_UNVERIFIED');
  const arms={model:[],baseline:[]},coverage=emptyCoverage();
  for(const side of ['home','away']) {
    const forecast=body.teams[side],actual=target.teams[side];
    if(actual?.sourceId!==forecast.sourceId)fail('MINUTES_FORWARD_TARGET_TEAM_MISMATCH');
    if(forecast.status!=='FROZEN_PRIOR_FORECAST')continue;
    if(hash(forecast.model.map(p=>p.id).sort())!==hash(forecast.baseline.map(p=>p.id).sort())
      ||new Set(forecast.model.map(p=>p.id)).size!==forecast.model.length)fail('MINUTES_FORWARD_PAIRED_COHORT_INVALID');
    const targets=new Map(actual.players.map(p=>[p.id,p])),ids=new Set(forecast.model.map(p=>p.id));
    coverage.unmodeledCurrentRosterPlayers+=forecast.unmodeledCurrentRosterIds.length;
    for(const player of actual.players)if(player.appeared&&!ids.has(player.id)){coverage.unseenAppearingPlayers++;coverage.unseenRegulationMinutes+=player.regulationClockMinutes;}
    for(const arm of ['model','baseline'])for(const p of forecast[arm]) {
      if(!checkedVector(p))fail('MINUTES_FORWARD_PREDICTION_INVALID');
      const label=targets.get(p.id),which=label?.starter?0:label?.appeared?1:2,minutes=label?.regulationClockMinutes??0;
      arms[arm].push({absolute:Math.abs(p.expectedMinutes-minutes),squared:(p.expectedMinutes-minutes)**2,
        loss:p.probabilities[which]===0?Infinity:-Math.log(p.probabilities[which]),
        brier:p.probabilities.reduce((sum,x,i)=>sum+(x-Number(i===which))**2,0)});
    }
  }
  const size=arms.model.length;
  if(!size||size!==arms.baseline.length)fail('MINUTES_FORWARD_PAIRED_COHORT_INVALID');
  const metrics=Object.fromEntries(Object.entries(arms).map(([arm,rows])=>{const loss=mean(rows.map(row=>row.loss));return[arm,
    {games:1,playerTargets:rows.length,minuteMAE:mean(rows.map(row=>row.absolute)),minuteRMSE:Math.sqrt(mean(rows.map(row=>row.squared))),
      logLoss:Number.isFinite(loss)?loss:null,logLossState:Number.isFinite(loss)?'FINITE':'POSITIVE_INFINITY',brier:mean(rows.map(row=>row.brier))}];}));
  return {metrics,coverage:{...coverage,evaluatedGames:1,modeledPlayerTargets:size},targetHash:target.targetHash};
}

function aggregateMetrics(rows) {
  if(!rows.length)return emptyMetric();
  const infinite=rows.some(r=>r.logLossState==='POSITIVE_INFINITY');
  return {games:rows.length,playerTargets:rows.reduce((n,r)=>n+r.playerTargets,0),minuteMAE:mean(rows.map(r=>r.minuteMAE)),
    minuteRMSE:Math.sqrt(mean(rows.map(r=>r.minuteRMSE**2))),logLoss:infinite?null:mean(rows.map(r=>r.logLoss)),
    logLossState:infinite?'POSITIVE_INFINITY':'FINITE',brier:mean(rows.map(r=>r.brier))};
}
export function replaySoccerMinutesForwardChecks(body,checks,now=Date.now(),{deadline=Infinity}={}) {
  const reasons=new Map(),chronology=createSoccerCalibrationResultChronology(),targets=[];let quarantined=false;
  const reason=code=>reasons.set(code,(reasons.get(code)||0)+1);
  const expanded=checks.flatMap(check=>[check,...(check.attempts||[]).map(attempt=>{
    const resultDocuments=clone(check.resultDocuments);let index=0;
    if(resultDocuments)for(const document of [resultDocuments.scoreboard,...(resultDocuments.summaries||[])].filter(Boolean)) {
      const observed=attempt.sourceObservations?.[index++];
      if(!observed||observed.source?.contentHash!==document.source?.contentHash)fail('MINUTES_FORWARD_ATTEMPT_SOURCE_SCOPE_INVALID');
      document.source=clone(observed.source);
    }
    if(index!==(attempt.sourceObservations||[]).length)fail('MINUTES_FORWARD_ATTEMPT_SOURCE_SCOPE_INVALID');
    return {...check,attempts:undefined,resultDocuments,checkedAt:attempt.attemptedAt};
  })]);
  for(const check of expanded) {
    if(Date.now()>=deadline)fail('MINUTES_FORWARD_REPORT_TIME_BUDGET');
    if(!check.resultDocuments){reason(check.reason||'MINUTES_FORWARD_NO_RESULT_DOCUMENTS');continue;}
    if(!Number.isFinite(time(check.checkedAt))||time(check.checkedAt)>now){reason('MINUTES_FORWARD_CHECK_TIME_INVALID');quarantined=true;continue;}
    const target=normalizeSoccerMinutesForwardResult(body.game,check.resultDocuments,check.checkedAt);
    const chronologyReason=chronology.add(body.game.id,target);
    if(chronologyReason){reason(chronologyReason);quarantined=true;}
    if(target.quarantine)quarantined=true;
    if(!target.ok)reason(target.reason);else targets.push(target);
  }
  if(targets.some(target=>target.targetHash!==targets[0]?.targetHash)){reason('MINUTES_FORWARD_TARGET_REVISION_CONFLICT');quarantined=true;}
  return {status:quarantined?'QUARANTINED':targets.length?'EVALUATED':'PENDING',
    evaluation:!quarantined&&targets.length?evaluateSoccerMinutesForwardPrediction(body,targets[0]):null,
    reasons:[...reasons].sort(([a],[b])=>a.localeCompare(b)).map(([code,count])=>({code,count}))};
}

export async function readSoccerMinutesForwardReport(league,{afterSequence='0',revision=null,timeBudgetMs=18000}={}) {
  if(!Number.isFinite(timeBudgetMs)||timeBudgetMs<0||timeBudgetMs>18000)fail('MINUTES_FORWARD_REPORT_BUDGET_INVALID');
  const deadline=Date.now()+timeBudgetMs;
  const page=await(await store()).readSoccerMinutesForwardReportPage(league,{afterSequence,revision,limit:1});
  const evaluated=[],readKeys=[],evaluatedKeys=[],quarantinedKeys=[],reasonCounts=new Map(),coverage=emptyCoverage();
  let partial=Date.now()>=deadline;
  for(const capture of page.captures) {
    if(partial)break;
    const body=capture.body;readKeys.push(body.game.id);
    if(capture.sourceReplayError){quarantinedKeys.push(body.game.id);reasonCounts.set(capture.sourceReplayError,(reasonCounts.get(capture.sourceReplayError)||0)+1);continue;}
    let result;
    try{result=replaySoccerMinutesForwardChecks(body,page.checks.filter(check=>check.captureId===capture.captureId),Date.now(),{deadline});}
    catch(error){if(error.message!=='MINUTES_FORWARD_REPORT_TIME_BUDGET')throw error;partial=true;break;}
    for(const r of result.reasons)reasonCounts.set(r.code,(reasonCounts.get(r.code)||0)+r.count);
    if(result.status==='QUARANTINED')quarantinedKeys.push(body.game.id);
    if(result.evaluation){evaluated.push(result.evaluation);evaluatedKeys.push(body.game.id);for(const k of Object.keys(coverage))coverage[k]+=result.evaluation.coverage[k];}
  }
  if(partial){evaluated.length=readKeys.length=evaluatedKeys.length=quarantinedKeys.length=0;reasonCounts.clear();Object.assign(coverage,emptyCoverage());}
  const captures=page.counts.captures??page.counts.captureGames,upcoming=page.counts.upcoming??page.counts.upcomingGames;
  const protocol=page.protocol?{...page.protocol,protocol:{...page.protocol.protocol,model:undefined}}:null;
  const readPage=partial?{...page.page,complete:false,reachedEnd:false,nextSequence:afterSequence}:page.page;
  return {version:SOCCER_MINUTES_FORWARD_VERSION,league,protocol,page:readPage,
    counts:{captures,evaluated:evaluatedKeys.length,quarantined:quarantinedKeys.length,pending:captures-evaluatedKeys.length-quarantinedKeys.length,upcoming},
    metrics:Object.fromEntries(['model','baseline'].map(arm=>[arm,aggregateMetrics(evaluated.map(row=>row.metrics[arm]))])),
    coverage,readCaptureGameKeys:readKeys,evaluatedGameKeys:evaluatedKeys,quarantinedGameKeys:quarantinedKeys,
    metricWeighting:SOCCER_MINUTES_FORWARD_WEIGHTING,reasons:[...reasonCounts].map(([code,count])=>({code,count})),
    completeWithinRequestedScope:readPage.reachedEnd,sourceScope:'ESPN_TWO_ENDPOINT_CROSSCHECK_NOT_INDEPENDENT_OFFICIAL_CONFIRMATION',...flags};
}

export async function evaluateSoccerMinutesForward({league,limit=2,timeBudgetMs=18000}={}) {
  if(!['epl','ucl'].includes(league)||!Number.isInteger(limit)||limit<1||limit>2||!Number.isFinite(timeBudgetMs)||timeBudgetMs<1||timeBudgetMs>18000)fail('MINUTES_FORWARD_EVALUATION_SCOPE_INVALID');
  const started=Date.now(),deadline=started+timeBudgetMs,s=await store(),pending=await s.listSoccerMinutesForwardPending(league,{limit});
  let evaluated=0,checked=0,pendingResults=0,quarantined=0;
  for(const meta of pending.captures) {
    if(Date.now()>=deadline)break;
    let capture;
    try {capture=await s.loadSoccerMinutesForwardCapture(league,meta.captureId);if(!capture)throw Error('MINUTES_FORWARD_CAPTURE_MISSING');}
    catch(error){await s.archiveSoccerMinutesForwardCheck({league,captureId:meta.captureId,resultDocuments:null,status:'PENDING',reason:/^[A-Z][A-Z0-9_]{1,199}$/.test(error.message)?error.message:'MINUTES_FORWARD_SOURCE_REPLAY_UNAVAILABLE'});checked++;pendingResults++;continue;}
    const body=capture.body;
    if(time(body.game.startTime)>=Date.now())continue;
    const slug=soccerLeague(league).espnSlug,date=new Date(body.game.startTime).toISOString().slice(0,10).replaceAll('-','');
    const options={ttlMs:0,timeoutMs:Math.max(1,Math.min(8000,deadline-Date.now()))};
    const [summary,scoreboard]=await Promise.all([fetchSoccerJson(`https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/summary?event=${body.game.sourceId}`,options),
      fetchSoccerJson(`https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/scoreboard?dates=${date}&limit=1000`,options)]);
    const resultDocuments={scoreboard:scoreboard.ok?retainSoccerProviderDocument(scoreboard):null,summaries:summary.ok?[retainSoccerProviderDocument(summary)]:[]},at=new Date().toISOString();
    const result=normalizeSoccerMinutesForwardResult(body.game,resultDocuments,at),status=result.quarantine?'QUARANTINED':result.ok?'EVALUATED':'PENDING';
    await s.archiveSoccerMinutesForwardCheck({league,captureId:meta.captureId,resultDocuments,status,reason:result.ok?null:result.reason});checked++;
    if(result.ok)evaluated++;else if(result.quarantine)quarantined++;else pendingResults++;
  }
  const completeWithinRequestedScope=pending.completeWithinRequestedScope&&checked===pending.captures.length;
  return {version:SOCCER_MINUTES_FORWARD_VERSION,league,persisted:true,
    status:!pending.captures.length?'NO_PENDING_CAPTURES':!completeWithinRequestedScope?'PARTIAL':evaluated?'EVALUATED':'PENDING',
    checked,evaluated,summary:{checked,evaluated,pending:pendingResults,quarantined},completeWithinRequestedScope,...flags};
}
