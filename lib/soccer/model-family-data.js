import { getSoccerCalibrationShadowReport, listSoccerCalibrationShadowCaptureIds,
  loadSoccerCalibrationShadowValidationEvidence } from './calibration-shadow-store.js';
import { readSoccerCalibrationHistoryRevision, readSoccerCalibrationShadowEvaluationHistoryPage } from './calibration-shadow-evaluation-store.js';
import { normalizeSoccerCalibrationShadowResult,createSoccerCalibrationResultChronology } from './calibration-shadow-validation.js';
import { evaluateSoccerCalibrationProspectiveValidation, predictSoccerCalibrationResearch, soccerCalibrationHash } from './calibration-research.js';
import { predictHalfTimeDistribution } from './half-time-model.js';
import { buildSoccerModelFamilyConfidenceSet, soccerModelFamilyHash } from './model-family-uncertainty.js';

export const SOCCER_MODEL_FAMILY_DATA_VERSION = 'SOCCER-DURABLE-CALIBRATION-FAMILY-DATA-v1';
const restrictions = { accepted:false, formalEligible:false, calibrationEligible:false, promotionEligible:false,
  executable:false, W:null, R:null, S:null, empiricalErrorMargin:null };
const sha = value => typeof value==='string' && /^[a-f0-9]{64}$/.test(value);
const epoch = value => typeof value==='string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
const seal = body => ({...body,contentHash:soccerModelFamilyHash(body)});
const fail = (code,status=503) => { throw Object.assign(Error(code),{status}); };
const add = (counts,reason) => { counts[reason]=(counts[reason]||0)+1; };
function sourceFreezeVerified(context) {
  try { return context.verifyFreezeReceipt?.({receipt:context.freezeReceipt,candidateHash:context.candidate.contentHash,
    planHash:context.plan.contentHash})===true; } catch { return false; }
}
function baselineFor(context,league,period) {
  const { candidate,model,halfTimeModel,freezeReceipt }=context;
  const modelHash=period==='FT'?candidate.modelHash:candidate.jointHalfTimeModelHash;
  if(candidate.league!==league || model.league!==league || halfTimeModel.league!==league
    || soccerCalibrationHash(model)!==candidate.modelHash || soccerCalibrationHash(halfTimeModel)!==candidate.halfTimeModelHash
    || candidate.jointHalfTimeModelHash!==soccerCalibrationHash({fullTimeModelHash:candidate.modelHash,halfTimeModelHash:candidate.halfTimeModelHash}))
    fail('MODEL_FAMILY_FROZEN_MODEL_SCOPE_INVALID');
  const createdAt=period==='FT'?candidate.modelAvailability.modelCreatedAt
    :new Date(Math.max(epoch(candidate.modelAvailability.modelCreatedAt),epoch(candidate.modelAvailability.halfTimeModelCreatedAt))).toISOString();
  const trainedThrough=period==='FT'?model.trainedThrough
    :new Date(Math.max(epoch(model.trainedThrough),epoch(halfTimeModel.trainedThrough))).toISOString();
  return { league,period,modelHash,createdAt,trainedThrough,
    trainingHash:period==='FT'?model.trainingHash:soccerCalibrationHash({fullTimeTrainingHash:model.trainingHash,halfTimeTrainingHash:halfTimeModel.trainingHash}),
    sourceHashes:[...new Set([candidate.modelHash,...(period==='HT'?[candidate.halfTimeModelHash,candidate.jointHalfTimeModelHash]:[]),freezeReceipt?.artifactHash].filter(sha))] };
}

// Only a context loaded by the immutable source adapter can vouch for these
// receipts. A caller-provided VERIFIED flag is never consulted. This export
// is a private server composition boundary, not an HTTP data intake.
export function buildSoccerModelFamilyCalibrationDataset({ league,period,protocol,context,checks=[],
  completeWithinRequestedScope=false,now=Date.now() }={}, {deadline=Infinity,clock=Date.now}={}) {
  if(!['epl','ucl'].includes(league)||!['FT','HT'].includes(period)||!Number.isFinite(now)||!Array.isArray(checks))
    fail('MODEL_FAMILY_DATA_SCOPE_INVALID',400);
  const baseline=baselineFor(context,league,period), reasons={}, grouped=new Map(), observations=[], quarantined=new Set();
  const from=epoch(protocol?.calibrationFrom), before=epoch(protocol?.calibrationBefore);
  if(!Number.isFinite(from)||!Number.isFinite(before)||from>=before)fail('MODEL_FAMILY_DATA_PROTOCOL_INVALID',400);
  const byCapture=new Map();
  for(const record of context.records||[]) {
    const id=record.captureReceipt?.captureId,game=record.prediction?.game;
    if(!sha(id)||game?.league!==league||game.id!==`soccer:${league}:${game.sourceId}`)fail('MODEL_FAMILY_DATA_CAPTURE_SCOPE_INVALID');
    if(byCapture.has(id)&&soccerCalibrationHash(byCapture.get(id))!==soccerCalibrationHash(record))fail('MODEL_FAMILY_DATA_DUPLICATE_CAPTURE_CONFLICT');
    byCapture.set(id,record);
    if(!grouped.has(game.id))grouped.set(game.id,[]);
    grouped.get(game.id).push(record);
  }
  const validChecks=new Map(),chronology=createSoccerCalibrationResultChronology();let captureReplayComplete=true;
  for(const check of checks) {
    if(clock()>=deadline){captureReplayComplete=false;add(reasons,'MODEL_FAMILY_DATA_REPLAY_TIME_BUDGET');break;}
    const record=byCapture.get(check.captureId);
    if(!record||check.league!=null&&check.league!==league)fail('MODEL_FAMILY_DATA_RESULT_SCOPE_INVALID');
    if(!Number.isFinite(epoch(check.checkedAt)))fail('MODEL_FAMILY_DATA_RESULT_RECEIPT_TIME_INVALID');
    if(epoch(check.checkedAt)>now)fail('MODEL_FAMILY_DATA_SOURCE_AFTER_AS_OF',409);
    const game=record.prediction.game;
    if(epoch(game.startTime)<from||epoch(game.startTime)>=before)continue;
    const normalized=normalizeSoccerCalibrationShadowResult(game,check.resultDocuments,check.checkedAt);
    const chronologyReason=chronology.add(game.id,normalized);
    if(chronologyReason){quarantined.add(game.id);add(reasons,chronologyReason);}
    if(!normalized.ok) { add(reasons,normalized.reason||'MODEL_FAMILY_RESULT_UNAVAILABLE');if(normalized.quarantine)quarantined.add(game.id);continue; }
    const scoped={...record,resultDocuments:check.resultDocuments};
    const verified=evaluateSoccerCalibrationProspectiveValidation({...context,records:[scoped],requestedScopeComplete:true,now});
    if(verified.untouchedVerifiedGames!==1||verified.quarantinedGames) {
      for(const [reason,count] of Object.entries(verified.excludedReasons||{}))reasons[reason]=(reasons[reason]||0)+count;
      if(verified.quarantinedGames)quarantined.add(game.id);
      continue;
    }
    const signature=soccerCalibrationHash([normalized.fullTime,normalized.halfTime.home,normalized.halfTime.away]);
    const contextSignature=soccerCalibrationHash({kickoff:game.startTime,home:game.home,away:game.away,neutralSite:game.neutralSite});
    const availableAt=Math.max(epoch(check.checkedAt),...[check.resultDocuments.scoreboard,...check.resultDocuments.summaries].map(document=>epoch(document.source.fetchedAt)));
    const old=validChecks.get(game.id);
    if(old&&(old.signature!==signature||old.contextSignature!==contextSignature))quarantined.add(game.id);
    if(!old||epoch(record.prediction.capturedAt)<epoch(old.record.prediction.capturedAt)
      ||record.prediction.capturedAt===old.record.prediction.capturedAt&&availableAt<old.availableAt)
      validChecks.set(game.id,{record,check,normalized,signature,contextSignature,availableAt});
  }
  if(captureReplayComplete)for(const [gameId,records] of grouped) {
    const selected=validChecks.get(gameId),game=selected?.record.prediction.game||records[0].prediction.game;
    if(!records.some(record=>epoch(record.prediction.game.startTime)>=from&&epoch(record.prediction.game.startTime)<before))
      {add(reasons,'MODEL_FAMILY_CAPTURE_OUTSIDE_WINDOW');continue;}
    if(quarantined.has(gameId)){add(reasons,'MODEL_FAMILY_GAME_RESULT_OR_CONTEXT_QUARANTINED');continue;}
    if(!selected){add(reasons,'MODEL_FAMILY_CAPTURE_WITHOUT_VERIFIED_RESULT');continue;}
    const {record,check,normalized,availableAt}=selected,capturedAt=epoch(record.prediction.capturedAt);
    const expected=predictSoccerCalibrationResearch({...context,game:record.prediction.game,now:capturedAt});
    const distribution=period==='FT'?expected.original:predictHalfTimeDistribution(expected.original,context.halfTimeModel,{league,startTime:game.startTime});
    const sourceHashes=[...new Set([...baseline.sourceHashes,record.captureReceipt.sourceContentHash,
      check.resultDocuments.scoreboard.source.contentHash,...check.resultDocuments.summaries.map(document=>document.source.contentHash)].filter(sha))];
    observations.push({league,period,gameId,kickoff:game.startTime,predictedAt:record.prediction.capturedAt,
      baselineModelHash:baseline.modelHash,homeRate:distribution.homeRate,awayRate:distribution.awayRate,rho:distribution.rho,
      actualScore:period==='FT'?{home:normalized.fullTime.home,away:normalized.fullTime.away}
        :{home:normalized.halfTime.home,away:normalized.halfTime.away},
      resultAvailableAt:new Date(availableAt).toISOString(),sourceHashes,
      captureId:record.captureReceipt.captureId,sourceReceiptId:record.captureReceipt.sourceReceiptId||null,
      analysisRevision:record.captureReceipt.analysisRevision||null});
  }
  observations.sort((a,b)=>a.kickoff.localeCompare(b.kickoff)||a.gameId.localeCompare(b.gameId));
  const complete=completeWithinRequestedScope&&captureReplayComplete;
  const confidenceSet=complete?buildSoccerModelFamilyConfidenceSet({observations,baseline,protocol,now}):null;
  return seal({version:SOCCER_MODEL_FAMILY_DATA_VERSION,league,period,baseline,protocol,
    generatedAt:new Date(now).toISOString(),status:complete?'COMPLETE_SOURCE_REPLAY':'PARTIAL_SOURCE_REPLAY',
    completeWithinRequestedScope:complete,captureReplayComplete,observations,independentRealGames:observations.length,quarantinedGames:quarantined.size,
    quarantinedGameIds:[...quarantined].sort(),excludedReasons:reasons,confidenceSet,sourceModelFreezeVerified:sourceFreezeVerified(context),
    outcomeCohortComplete:complete&&!quarantined.size&&!reasons.MODEL_FAMILY_CAPTURE_WITHOUT_VERIFIED_RESULT,
    familyProtocolRegistrationVerified:false,familyProtocolProspectiveVerified:false,
    registrationInterpretation:'SOURCE_CALIBRATION_PLAN_NOT_FAMILY_PREREGISTRATION',
    coverageAssumptionsVerified:false,modelMisspecificationBound:null,...restrictions});
}

/** The already-frozen calibration plan supplies a reproducible SOURCE window.
 * Its old timestamp is not a preregistration receipt for this new family method.
 * The method/alpha are declared now and remain explicitly retrospective. */
export async function readSoccerModelFamilyCalibrationScope({league,period,now=Date.now()}={},overrides={}) {
  if(!['epl','ucl'].includes(league)||!['FT','HT'].includes(period)||!Number.isFinite(now))fail('MODEL_FAMILY_DATA_SCOPE_INVALID',400);
  const deps={baseReport:getSoccerCalibrationShadowReport,loadEvidence:loadSoccerCalibrationShadowValidationEvidence,
    readRevision:readSoccerCalibrationHistoryRevision,...overrides};
  const base=await deps.baseReport(league),sourceFreeze=base.freeze||null;
  const revision=await deps.readRevision(league,sourceFreeze?.freezeId??null);
  const context=await deps.loadEvidence(league,{captureIds:[],limit:1}),baseline=baselineFor(context,league,period);
  const current=await deps.readRevision(league,sourceFreeze?.freezeId??null);
  if(revision.revision!==current.revision||revision.captures!==base.captureGames)fail('MODEL_FAMILY_DATA_SOURCE_CHANGED',409);
  const sourceFrom=Math.max(epoch(context.plan.beginsStrictlyAfter),sourceFreeze?epoch(sourceFreeze.frozenAt):0);
  if(!Number.isFinite(sourceFrom)||sourceFrom>=now)fail('MODEL_FAMILY_DATA_SOURCE_WINDOW_UNAVAILABLE');
  const protocol={registeredAt:context.plan.createdAt,calibrationFrom:new Date(sourceFrom).toISOString(),
    calibrationBefore:new Date(now).toISOString(),alpha:0.1,declaredAt:new Date(now).toISOString(),
    sourceCalibrationPlanHash:context.plan.contentHash,familyProtocolProspectiveVerified:false,
    registrationInterpretation:'SOURCE_CALIBRATION_PLAN_NOT_FAMILY_PREREGISTRATION'};
  return seal({version:SOCCER_MODEL_FAMILY_DATA_VERSION,league,period,baseline,protocol,sourceFreeze,
    sourceRevision:revision.revision,totalCaptures:base.captureGames,sourceModelFreezeVerified:sourceFreezeVerified(context),
    familyProtocolRegistrationVerified:false,familyProtocolProspectiveVerified:false,
    registrationInterpretation:'SOURCE_CALIBRATION_PLAN_NOT_FAMILY_PREREGISTRATION',...restrictions});
}

/** Bounded production source read. A partial page never fits a confidence set.
 * The caller may durably accumulate sealed complete-game pages, but must replay
 * a fresh scope when the immutable capture/check revision changes. */
export async function loadSoccerModelFamilyCalibrationDataset({league,period,protocol,afterSequence='0',expectedRevision=null,
  captureLimit=1,timeBudgetMs=18000,now=Date.now()}={},overrides={}) {
  if(!['epl','ucl'].includes(league)||!['FT','HT'].includes(period)||!Number.isFinite(now)
    ||!/^(?:0|[1-9]\d{0,17})$/.test(afterSequence)||expectedRevision!==null&&!sha(expectedRevision)
    ||afterSequence!=='0'&&!expectedRevision||!Number.isSafeInteger(captureLimit)||captureLimit<1||captureLimit>3
    ||!Number.isFinite(timeBudgetMs)||timeBudgetMs<1||timeBudgetMs>50000)fail('MODEL_FAMILY_DATA_SCOPE_INVALID',400);
  const deps={baseReport:getSoccerCalibrationShadowReport,listCaptureIds:listSoccerCalibrationShadowCaptureIds,
    loadEvidence:loadSoccerCalibrationShadowValidationEvidence,readRevision:readSoccerCalibrationHistoryRevision,
    readHistoryPage:readSoccerCalibrationShadowEvaluationHistoryPage,clock:Date.now,...overrides};
  const deadline=deps.clock()+timeBudgetMs,base=await deps.baseReport(league);
  const revision=await deps.readRevision(league,base.freeze?.freezeId??null);
  if(expectedRevision&&revision.revision!==expectedRevision||revision.captures!==base.captureGames)fail('MODEL_FAMILY_DATA_SOURCE_CHANGED',409);
  const page=await deps.listCaptureIds(league,{afterSequence,limit:captureLimit});
  const context=await deps.loadEvidence(league,{captureIds:page.captureIds,limit:captureLimit});
  if(context.records.length!==page.captureIds.length)fail('MODEL_FAMILY_DATA_CAPTURE_PAGE_INCOMPLETE');
  const checks=[],seen=new Set();let afterCheckId='',historyComplete=false,loadedBytes=0;
  do {
    if(deps.clock()>=deadline)break;
    const history=await deps.readHistoryPage(league,{captureIds:page.captureIds,afterCheckId,limit:100});
    loadedBytes+=history.loadedBytes||0;
    if(loadedBytes>64*1024*1024||seen.size+history.checks.length>10000)fail('MODEL_FAMILY_DATA_COMPLETE_HISTORY_BUDGET');
    for(const check of history.checks){if(!sha(check.checkId)||seen.has(check.checkId))fail('MODEL_FAMILY_DATA_RESULT_CURSOR_INVALID');seen.add(check.checkId);checks.push(check);}
    if(history.completeWithinRequestedScope){if(seen.size!==history.totalCheckRows)fail('MODEL_FAMILY_DATA_RESULT_HISTORY_INCOMPLETE');historyComplete=true;break;}
    if(!sha(history.nextCheckId)||history.nextCheckId<=afterCheckId)fail('MODEL_FAMILY_DATA_RESULT_CURSOR_INVALID');
    afterCheckId=history.nextCheckId;
  }while(true);
  const current=await deps.readRevision(league,base.freeze?.freezeId??null);
  if(current.revision!==revision.revision)fail('MODEL_FAMILY_DATA_SOURCE_CHANGED',409);
  const reachedSourceEnd=historyComplete&&page.completeWithinRequestedScope&&page.nextSequence===null;
  const complete=afterSequence==='0'&&reachedSourceEnd&&context.records.length===base.captureGames;
  const result=buildSoccerModelFamilyCalibrationDataset({league,period,protocol,context:historyComplete?context:{...context,records:[]},
    checks:historyComplete?checks:[],completeWithinRequestedScope:complete,now},{deadline,clock:deps.clock});
  const pageComplete=historyComplete&&result.captureReplayComplete,reachedEnd=pageComplete&&reachedSourceEnd;
  const nextSequence=pageComplete?(reachedEnd?null:page.nextSequence):afterSequence;
  const {contentHash:_contentHash,...body}=result;
  return seal({...body,sourceRevision:revision.revision,
    coverage:{readCaptures:pageComplete?context.records.length:0,nextSequence,complete:reachedEnd,totalCaptures:base.captureGames},
    page:{afterSequence,nextSequence,reachedEnd,complete:pageComplete,revision:revision.revision,
    processedCaptures:pageComplete?context.records.length:0,totalCaptures:base.captureGames,
    readResultCheckRows:checks.length,reason:pageComplete?null:'MODEL_FAMILY_DATA_TIME_BUDGET'}});
}
