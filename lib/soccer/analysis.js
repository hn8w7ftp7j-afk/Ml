import { soccerMatchContextObservations } from './match-context-observations.js';
import { createVerifiedSoccerScheduleIdentityEvidence } from './reader-identity-proof.js';
import { createHash } from 'node:crypto';
import { soccerResearchArtifacts } from './research-frozen.js';
import { predictScoreModel } from './score-model.js';
import { compareSoccerPersonnel } from './personnel-audit.js';
import { soccerValidationArtifacts } from './validation-frozen.js';
import { soccerSettlementReview } from './settlement-review.js';
import { matchSoccerReaderGames, soccerReaderScheduleCandidates } from './reader.js';
import { buildSoccerRequirementAudit, SOCCER_REQUIREMENTS_VERSION } from './requirements.js';
import { soccerHalfTimeArtifacts } from './half-time-frozen.js';
import { predictHalfTimeDistribution } from './half-time-model.js';
import { buildSoccerMarketDirections, collectUnassignedSoccerQuotes } from './market-directions.js';
import { evaluateSoccerQuote } from './market-payoff.js';
import { soccerProviderPolicy } from './provider-policy.js';
import { scoreSoccerQuote, soccerScoringHash } from './soccer-scoring.js';
import { analyzeSoccerConditionalQuote } from './conditional-analysis.js';
import { soccerPersonnelArtifacts } from './personnel-frozen.js';
import { soccerPersonnelObservation, predictSoccerPersonnelModel } from './personnel-model.js';
import { soccerScoringReadiness } from './scoring-readiness.js';
import { prepareSoccerScoringInputs } from './scoring-input-preparation.js';
import { buildSoccerScenarioResearch } from './scenario-research.js';
import { soccerSystemScoringReadiness } from './system-readiness.js';
import { soccerScenarioScore } from './scenario-score.js';
import { soccerCurrentProviderFactAcceptance } from './source-document-store.js';
import { soccerCurrentAnalysisSourceAvailability } from './prematch-inputs.js';
import { buildSoccerExpectedMinutesResearch } from './expected-minutes-model.js';
import { buildSoccerConditionsResearch } from './conditions-research.js';
import { matchXgResearchForGame } from './match-xg.js';
import { soccerMatchXgArtifacts } from './match-xg-frozen.js';
import { shotXgResearchForGame } from './shot-xg-research-view.js';
import { calculateSoccerPredictionScore } from './prediction-score.js';

export const SOCCER_ANALYSIS_VERSION='SOCCER-MARKET-PREDICTION-v7-2.2';
export const soccerAnalysisHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Generators also serve historical research and do not own a live event ID.
// Bind only the verified analysis game's scope; preserve every computed value.
export function bindSoccerDistributionIdentity(distribution,game,period){
  const expectedPeriod={FT:'REGULATION_FT',HT:'REGULATION_HT'}[period];
  if(!game||!['epl','ucl'].includes(game.league)||!/^\d{1,16}$/.test(game.sourceId||'')
    ||game.id!==`soccer:${game.league}:${game.sourceId}`||!expectedPeriod)throw Error('SOCCER_DISTRIBUTION_IDENTITY_INVALID');
  if(!distribution||distribution.period!==expectedPeriod
    ||distribution.league!==undefined&&distribution.league!==game.league
    ||distribution.gameId!==undefined&&distribution.gameId!==game.id)throw Error('SOCCER_DISTRIBUTION_SCOPE_MISMATCH');
  return {...distribution,league:game.league,gameId:game.id};
}
export function buildSoccerAnalysis({evidence,reader=null,schedule=null,previous=null,now=Date.now()}){
  if(evidence?.ok!==true||!Number.isFinite(now)||!Number.isFinite(Date.parse(evidence.source?.fetchedAt))||Date.parse(evidence.source.fetchedAt)>now||now-Date.parse(evidence.source.fetchedAt)>180000)throw Error('SOCCER_EVIDENCE_INVALID');
  for(const time of [reader?.firstFetchedAt,reader?.receivedAt])if(time&&(!Number.isFinite(Date.parse(time))||Date.parse(time)>now))throw Error('SOCCER_READER_AFTER_CUTOFF');
  const game=evidence.game,id=`soccer:${game.league}:${game.sourceId}`;
  if(id!==game.id||!['epl','ucl'].includes(game.league))throw Error('SOCCER_ANALYSIS_IDENTITY_INVALID');
  const artifact=soccerResearchArtifacts(),{contentHash,...rest}=artifact;
  if(contentHash!==soccerAnalysisHash(rest)||artifact.formalScoringEnabled!==false)throw Error('SOCCER_RESEARCH_ARTIFACT_INVALID');
  const research=artifact.leagues[game.league],candidates=soccerReaderScheduleCandidates(schedule,game);
  const proposedMatches=reader&&candidates?matchSoccerReaderGames(reader,candidates,now).filter(r=>r.officialGameId===id):[];
  // Source scope, current summary identity and cutoff must agree before the
  // original quotes enter directions. A registered but stale/revised board is
  // still only provisional research.
  const sourceIdentity=candidates?createVerifiedSoccerScheduleIdentityEvidence(schedule,game,evidence.scheduleSource,now,{summarySource:evidence.source,matchedGames:proposedMatches}):null;
  const matched=sourceIdentity?proposedMatches:[];
  const observedCandidates=!sourceIdentity?soccerReaderScheduleCandidates(schedule,game,{requireVerified:false}):null;
  const provisionalMatched=reader&&observedCandidates?matchSoccerReaderGames(reader,observedCandidates,now)
    .filter(r=>r.officialGameId===id&&r.matchStatus==='MATCHED'):[];
  const validation=soccerValidationArtifacts(),{contentHash:validationHash,...validationBody}=validation;
  if(validationHash!==soccerAnalysisHash(validationBody))throw Error('SOCCER_VALIDATION_ARTIFACT_INVALID');
  const settlementReviews=matched.flatMap(g=>(g.markets||[]).filter(m=>['HANDICAP','TOTAL'].includes(m.kind)).map(m=>{try{return soccerSettlementReview(m);}catch{return{kind:m.kind,rawLine:m.line,status:'INVALID_REVIEW_INPUT',rows:[],executable:false};}}));
  const prestart=evidence.phase==='PREMATCH_OBSERVATION'&&game.status==='scheduled'&&Date.parse(game.startTime)>now;
  let prediction=null,predictionReason=null;
  if(prestart){try{prediction=bindSoccerDistributionIdentity(predictScoreModel(research.liveModel,{league:game.league,startTime:game.startTime,homeId:game.home.sourceId,awayId:game.away.sourceId,neutralSite:game.neutralSite}),game,'FT');}catch(e){predictionReason=e.message;}}
  else predictionReason='NOT_A_PREMATCH_SNAPSHOT';
  const personnelArtifact=soccerPersonnelArtifacts(),{contentHash:personnelArtifactHash,...personnelArtifactBody}=personnelArtifact;
  if(personnelArtifactHash!==soccerAnalysisHash(personnelArtifactBody)||personnelArtifact.formalEnabled!==false)throw Error('SOCCER_PERSONNEL_ARTIFACT_INVALID');
  const personnel=personnelArtifact.leagues[game.league],personnelModel=personnel?.model;
  if(!personnelModel||personnelModel.baselineHash!==soccerAnalysisHash(research.liveModel))throw Error('SOCCER_PERSONNEL_BASELINE_MISMATCH');
  const personnelAvailable=Number.isFinite(Date.parse(personnelArtifact.createdAt))&&Date.parse(personnelArtifact.createdAt)<=now;
  let personnelPrediction=null,personnelReason=null;
  if(!personnelAvailable)personnelReason='PERSONNEL_ARTIFACT_NOT_AVAILABLE_AT_CUTOFF';
  else if(prestart&&prediction){try{personnelPrediction=predictSoccerPersonnelModel(personnelModel,soccerPersonnelObservation(evidence,{asOf:now}),{mode:'CURRENT_PREMATCH',asOf:now});}catch(error){personnelReason=error.message;}}
  else personnelReason=prestart?'SCORE_MODEL_UNAVAILABLE':'NOT_A_PREMATCH_SNAPSHOT';
  const personnelResearch=personnelAvailable?{artifactHash:personnelArtifactHash,protocolHash:personnelArtifact.protocolHash,trainingHash:personnelModel.trainingHash,
    baselineHash:personnelModel.baselineHash,modelVersion:personnelModel.version,status:personnelPrediction?'RESEARCH_CHALLENGER_AVAILABLE':'PERSONNEL_INPUTS_INSUFFICIENT',
    reason:personnelReason,defaultDistribution:'UNCHANGED_BASELINE',challengerDisplayOnly:true,formalEnabled:false,
    collection:personnel.collection,validation:{originalPopulation:personnel.validation.originalPopulation,commonCount:personnel.validation.commonCount,
      preferredModel:personnel.validationPreferredModel,reference:personnel.validation.reference,
      challenger:personnel.validation.trials.find(t=>t.penalty===personnel.selectedPenalty)?.common||null},
    diagnostic:{count:personnel.diagnostic.count,sample:personnel.diagnostic.sample,logLoss:personnel.diagnostic.logLoss,brier:personnel.diagnostic.brier,
      baseline:personnel.diagnostic.baseline,comparison:personnel.diagnostic.comparison,interpretation:personnel.diagnostic.interpretation}}:
    {status:'NOT_AVAILABLE_AT_CUTOFF',reason:personnelReason,artifactHash:null,protocolHash:null,trainingHash:null,baselineHash:null,
      defaultDistribution:'UNCHANGED_BASELINE',challengerDisplayOnly:true,formalEnabled:false};
  const halfTimeArtifact=soccerHalfTimeArtifacts(),{contentHash:halfTimeHash,...halfTimeBody}=halfTimeArtifact;
  if(halfTimeHash!==soccerAnalysisHash(halfTimeBody)||halfTimeArtifact.formalScoringEnabled!==false)throw Error('SOCCER_HALF_TIME_ARTIFACT_INVALID');
  const halfTimeResearch=halfTimeArtifact.leagues?.[game.league]||null;
  let halfTimePrediction=null,halfTimePredictionReason=null;
  if(prediction&&halfTimeResearch?.liveModel){try{halfTimePrediction=bindSoccerDistributionIdentity(predictHalfTimeDistribution(prediction,halfTimeResearch.liveModel,{league:game.league,startTime:game.startTime}),game,'HT');}catch(e){halfTimePredictionReason=e.message;}}
  else halfTimePredictionReason=prestart?'HALF_TIME_MODEL_UNAVAILABLE':'NOT_A_PREMATCH_SNAPSHOT';
  const providerPolicy=soccerProviderPolicy({asOf:now}),distributions={FT:prediction,HT:halfTimePrediction};
  // This distinct display-only field never enters directions, forward return
  // selection, scoring or qualification. Completeness of the fetched board is
  // not established, even when its visible candidates uniquely match.
  const provisionalReaderResearch=provisionalMatched.length?{
    status:'UNVERIFIED_SCHEDULE_SCOPE',league:game.league,gameId:game.id,date:game.date,
    identityScope:'UNIQUE_AMONG_FETCHED_SCHEDULE_ONLY',scheduleCompletenessVerified:false,
    formalEligible:false,calibrationEligible:false,promotionEligible:false,executable:false,W:null,R:null,S:null,
    quotes:buildSoccerMarketDirections({matchedGames:provisionalMatched,reader,game,now,distributions})
      .flatMap(direction=>direction.quotes.map(quote=>({
        ...quote,conditionalAnalysis:analyzeSoccerConditionalQuote({quote,distribution:distributions[direction.period],game,now}),
        provisionalDistributionHash:distributions[direction.period]?soccerScoringHash(distributions[direction.period]):null,
        formalEligible:false,eligible:false,executable:false,W:null,R:null,S:null,
      }))),
  }:null;
  const scenarioInputs=buildSoccerScenarioResearch({game,now});
  const scenarioResearch={...Object.fromEntries(Object.entries(scenarioInputs).filter(([key])=>key!=='periods')),
    gameId:game.id,league:game.league,date:game.date,startTime:game.startTime,
    periods:Object.fromEntries(Object.entries(scenarioInputs.periods).map(([period,value])=>[period,{
      ...Object.fromEntries(Object.entries(value).filter(([key])=>key!=='scenarios')),
      sourceEvidence:value.scenarios[0]?.sourceEvidence||null,
    }]))};
  const analysisStatus=prediction||!prestart?'COMPLETED':'INSUFFICIENT_DATA';
  const qaFlag=analysisStatus==='COMPLETED'?'WARN':'BLOCKED';
  const selectionResult=analysisStatus==='COMPLETED'?'RESEARCH_SHADOW':null;
  // Quotes retain their actual source, period and alternatives. A goal threshold
  // probability is not a settlement probability and does not authorize a wager.
  const directions=buildSoccerMarketDirections({matchedGames:matched,reader,game,now,distributions}).map(direction=>{
    const distribution=distributions[direction.period];
    const quotes=direction.quotes.map(quote=>{
      const prepared=prepareSoccerScoringInputs({quote,distribution,game,evidence,scenarioResearch:scenarioInputs,now});
      const scoring={...scoreSoccerQuote({...prepared.runtimeInputs,quote,distribution,game,evidence,now}),
        inputBundle:prepared.inputBundle,inputPreparation:prepared.preparation};
      const predictionScore=calculateSoccerPredictionScore({quote,distribution,game,evidence,research:scenarioInputs,now});
      return{...quote,scoring,predictionScore,scenarioScore:soccerScenarioScore({quote,distribution,game,research:scenarioInputs,now}),conditionalAnalysis:analyzeSoccerConditionalQuote({quote,distribution,game,now}),payoff:scoring.conditionalPayoff||evaluateSoccerQuote({quote,distribution,contract:null})};
    });
    return {...direction,quotes,status:selectionResult||'INSUFFICIENT_DATA',
      analysisStatus:distribution&&quotes.length?'COMPLETED':'INSUFFICIENT_DATA',qaFlag,selectionResult,
      score:null,W:null,R:null,eligible:false,executable:false,
      reasons:[...new Set([...(direction.reasons||[]),...(prestart?[]:['MATCH_ALREADY_STARTED']),
        ...(!distribution?[direction.period==='HT'?'HALF_TIME_MODEL_UNVERIFIED':'SCORE_MODEL_UNAVAILABLE']:[]),
        'SOCCER_PERIOD_SETTLEMENT_REBATE_UNVERIFIED','SOCCER_MODEL_NOT_PROMOTED'])]};
  });
  const unassignedQuotes=collectUnassignedSoccerQuotes({matchedGames:matched,reader,game,now});
  const personnelMissing=['home','away'].flatMap(side=>[
    [`${side==='home'?'主隊':'客隊'}傷停與復出`,evidence.teams[side]?.injuries],
    [`${side==='home'?'主隊':'客隊'}停賽與出賽資格`,evidence.teams[side]?.suspensions],
    [`${side==='home'?'主隊':'客隊'}預計分鐘與替補`,evidence.teams[side]?.minutes],
  ]);
  const matchContext=soccerMatchContextObservations(evidence);
  const aggregateXg=evidence.xg?.version==='SOCCER-OPTA-TEAM-XG-v1'&&evidence.xg?.ok===true;
  const evidenceMissing=[[aggregateXg?'逐場非十二碼 xG 與射門品質':'攻守 xG',evidence.xg],...personnelMissing,['天氣',evidence.weather],['旅行與全賽程體能',evidence.travel],...(game.league==='ucl'?[[matchContext.uclPhase?'歐冠跨聯賽強度與階段效果':'歐冠階段、回合與跨聯賽強度',evidence.uclContext]]:[])].filter(([label,v])=>!v||['UNKNOWN','UNAVAILABLE','PROVIDER_REPORTED_PARTIAL'].includes(v.status)||aggregateXg&&label==='逐場非十二碼 xG 與射門品質').map(([label,v])=>({label,reason:aggregateXg&&label==='逐場非十二碼 xG 與射門品質'?'MATCH_LEVEL_NPXG_HISTORY_AND_SHOT_QUALITY_UNVERIFIED':label==='歐冠跨聯賽強度與階段效果'?'UCL_DOMESTIC_STRENGTH_AND_PHASE_EFFECTS_UNVERIFIED':v?.reason||'EVIDENCE_NOT_PROVIDED'}));
  // Bound to the provider pages actually returned; no universal completeness
  // or independent corroboration is inferred from this derived receipt.
  const readerIdentityEvidence=candidates?createVerifiedSoccerScheduleIdentityEvidence(schedule,game,evidence.scheduleSource,now,{summarySource:evidence.source,matchedGames:matched,directions,unassignedQuotes}):null;
  const result={ok:true,version:SOCCER_ANALYSIS_VERSION,league:game.league,gameId:game.id,date:game.date,observedAt:new Date(now).toISOString(),analysisCutoff:new Date(now).toISOString(),status:prestart?'RESEARCH_ONLY':'POSTSTART_AUDIT',evidence,readerIdentityEvidence,personnelComparison:compareSoccerPersonnel(previous,evidence),readerEvidence:{status:matched.length?'MATCHED_RULES_UNVERIFIED':'NO_MATCHED_QUOTE',observedAt:matched.length?reader.observedAt:null,revision:matched.length?reader.revision:null,games:matched,executable:false},settlementReviews,prediction,predictionReason,researchValidation:{test:research.test,history:research.history,protocol:artifact.protocol,artifactHash:artifact.contentHash,modelTrainingHash:research.liveModel.trainingHash,rolling:{...validation.leagues[game.league],artifactHash:validationHash,interpretation:validation.protocol.interpretation},limitations:[...research.limitations.filter(x=>!x.startsWith('Single chronological split only')&&!x.startsWith('No half-time model,')), 'Settlement verification, executable market and betting return remain unverified', 'Rolling retrospective diagnostics are now available; stable improvement, PIT availability and market calibration remain unverified'],formalPromotion:false},directions,missing:evidenceMissing,formalScoringEnabled:false,executable:false};
  const expectedMinutesResearch=buildSoccerExpectedMinutesResearch({evidence,game,now});
  const conditionsResearch=buildSoccerConditionsResearch({evidence,game,now});
  const matchXgResearch=matchXgResearchForGame(game,soccerMatchXgArtifacts(),{now});
  const shotXgResearch=shotXgResearchForGame(game,{now});
  const audited={...result,personnelPrediction,personnelResearch,expectedMinutesResearch,conditionsResearch,matchXgResearch,shotXgResearch,halfTimePrediction,halfTimePredictionReason,
    halfTimeResearch:halfTimeResearch?{...halfTimeResearch,artifactHash:halfTimeHash,protocol:halfTimeArtifact.protocol,formalPromotion:false}:null,
    unassignedQuotes,providerPolicy,requirementsVersion:SOCCER_REQUIREMENTS_VERSION,analysisStatus,qaFlag,selectionResult,
    qualification:{status:'NOT_AUTHORIZED',eligible:false,reason:'SOCCER_FORMAL_VALIDATION_PENDING'},
    requirements:buildSoccerRequirementAudit({evidence,prediction,halfTimePrediction,reader:{games:matched},providerPolicy,validation:{...research,...validation.leagues[game.league]}}),
    inputVersions:{evidenceHash:evidence.source?.contentHash||null,evidenceFetchedAt:evidence.source.fetchedAt,
      teamXgSourceVersion:aggregateXg?{provider:evidence.xg.source.provider,url:evidence.xg.source.url,contentHash:evidence.xg.source.contentHash,
        fetchedAt:evidence.xg.source.fetchedAt,availableAt:evidence.xg.source.availableAt,sourceUpdatedAt:evidence.xg.source.sourceUpdatedAt,
        sourcePublishedAt:evidence.xg.source.sourcePublishedAt,receiptId:evidence.xg.sourceDocumentArchive?.receiptId||null,modelEffectApplied:false}:null,
      scheduleSourceVersion:evidence.scheduleSource?{provider:evidence.scheduleSource.provider,url:evidence.scheduleSource.url,contentHash:evidence.scheduleSource.contentHash,fetchedAt:evidence.scheduleSource.fetchedAt}:null,
      workloadSourceVersions:(evidence.workload?.sources||[]).filter(s=>s?.contentHash).map(s=>({url:s.url,contentHash:s.contentHash,fetchedAt:s.fetchedAt})),
      readerObservationId:reader?.observationId||null,readerRevision:reader?.revision||null,readerFirstFetchedAt:reader?.firstFetchedAt||null,readerReceivedAt:reader?.receivedAt||null,readerSourceObservations:reader?.sourceObservations||[],
      modelTrainingHash:research.liveModel.trainingHash,researchArtifactHash:artifact.contentHash,validationArtifactHash:validationHash,halfTimeArtifactHash:halfTimeHash,
      personnelArtifactHash:personnelResearch.artifactHash,personnelTrainingHash:personnelResearch.trainingHash,personnelBaselineHash:personnelResearch.baselineHash}};
  const scoringQuotes=directions.flatMap(direction=>direction.quotes),inputReasons={};
  for(const quote of scoringQuotes)if(quote.scoring.inputBundle.status!=='AVAILABLE'){
    const code=quote.scoring.inputBundle.code;inputReasons[code]=(inputReasons[code]||0)+1;
  }
  const scoringInputReadiness={version:'SOCCER-RUNTIME-INPUT-READINESS-v1',quoteCount:scoringQuotes.length,
    trustedBundleQuoteCount:scoringQuotes.filter(quote=>quote.scoring.inputBundle.status==='AVAILABLE').length,
    missingBundleQuoteCount:scoringQuotes.filter(quote=>quote.scoring.inputBundle.status!=='AVAILABLE').length,reasons:inputReasons};
  const predictionQuotes=scoringQuotes.filter(quote=>quote.predictionScore?.status==='PREDICTION_SCORE_AVAILABLE');
  const predictionContext={version:'SOCCER-AVAILABLE-DATA-PREDICTION-v1',mode:'PREDICTION',
    missingDataBlocksForecast:false,formalModelAccepted:false,totalModelError:null,
    goalModel:'FROZEN_SAME_LEAGUE_HISTORICAL_SCORE_MODEL',
    availableContext:['home','away'].map(side=>({side,lineup:evidence.teams[side]?.lineup?.status||'UNKNOWN',
      injuries:evidence.teams[side]?.injuries?.status||'UNKNOWN',suspensions:evidence.teams[side]?.suspensions?.status||'UNKNOWN',
      expectedMinutes:expectedMinutesResearch?.teams?.[side]?.status||'UNKNOWN'})),
    contextualGoalEffectApplied:false,missing:evidenceMissing,
    interpretation:'AVAILABLE_CONTEXT_RETAINED_SEPARATELY_NO_INVENTED_INJURY_WEATHER_OR_XG_COEFFICIENTS'};
  const predictionScoringSummary={version:'SOCCER-PREDICTION-SCORING-SUMMARY-v1',mode:'PREDICTION',
    quoteCount:scoringQuotes.length,scoredQuoteCount:predictionQuotes.length,
    thresholdQuoteCount:predictionQuotes.filter(quote=>quote.predictionScore.eligiblePrediction===true).length,
    currentQuoteCount:0,qualifiedQuoteCount:0,formalEligible:false,executable:false};
  const complete={...audited,scenarioResearch,provisionalReaderResearch,scoringInputReadiness,predictionContext,predictionScoringSummary,
    scoringSystemReadiness:soccerSystemScoringReadiness(game.league,now),scoreReadiness:soccerScoringReadiness(audited,now,undefined,
      {currentSourceAvailability:soccerCurrentAnalysisSourceAvailability,currentProviderFactAcceptance:soccerCurrentProviderFactAcceptance})};
  return {...complete,analysisHash:soccerAnalysisHash(complete)};
}
