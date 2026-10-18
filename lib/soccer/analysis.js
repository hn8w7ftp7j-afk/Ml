import { createHash } from 'node:crypto';
import { soccerResearchArtifacts } from './research-frozen.js';
import { predictScoreModel } from './score-model.js';
import { compareSoccerPersonnel } from './personnel-audit.js';
import { soccerValidationArtifacts } from './validation-frozen.js';
import { soccerSettlementReview } from './settlement-review.js';
import { matchSoccerReaderGames } from './reader.js';
import { buildSoccerRequirementAudit, SOCCER_REQUIREMENTS_VERSION } from './requirements.js';
import { soccerHalfTimeArtifacts } from './half-time-frozen.js';
import { predictHalfTimeDistribution } from './half-time-model.js';
import { buildSoccerMarketDirections, collectUnassignedSoccerQuotes } from './market-directions.js';
import { evaluateSoccerQuote } from './market-payoff.js';
import { soccerProviderPolicy } from './provider-policy.js';

export const SOCCER_ANALYSIS_VERSION='SOCCER-MARKET-RESEARCH-v4-2.2';
export const soccerAnalysisHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function buildSoccerAnalysis({evidence,reader=null,previous=null,now=Date.now()}){
  if(evidence?.ok!==true||!Number.isFinite(now)||!Number.isFinite(Date.parse(evidence.source?.fetchedAt))||Date.parse(evidence.source.fetchedAt)>now||now-Date.parse(evidence.source.fetchedAt)>180000)throw Error('SOCCER_EVIDENCE_INVALID');
  for(const time of [reader?.firstFetchedAt,reader?.receivedAt])if(time&&(!Number.isFinite(Date.parse(time))||Date.parse(time)>now))throw Error('SOCCER_READER_AFTER_CUTOFF');
  const game=evidence.game,id=`soccer:${game.league}:${game.sourceId}`;
  if(id!==game.id||!['epl','ucl'].includes(game.league))throw Error('SOCCER_ANALYSIS_IDENTITY_INVALID');
  const artifact=soccerResearchArtifacts(),{contentHash,...rest}=artifact;
  if(contentHash!==soccerAnalysisHash(rest)||artifact.formalScoringEnabled!==false)throw Error('SOCCER_RESEARCH_ARTIFACT_INVALID');
  const research=artifact.leagues[game.league],matched=reader?matchSoccerReaderGames(reader,[game],now).filter(r=>r.officialGameId===id):[];
  const validation=soccerValidationArtifacts(),{contentHash:validationHash,...validationBody}=validation;
  if(validationHash!==soccerAnalysisHash(validationBody))throw Error('SOCCER_VALIDATION_ARTIFACT_INVALID');
  const settlementReviews=matched.flatMap(g=>(g.markets||[]).filter(m=>['HANDICAP','TOTAL'].includes(m.kind)).map(m=>{try{return soccerSettlementReview(m);}catch{return{kind:m.kind,rawLine:m.line,status:'INVALID_REVIEW_INPUT',rows:[],executable:false};}}));
  const prestart=evidence.phase==='PREMATCH_OBSERVATION'&&game.status==='scheduled'&&Date.parse(game.startTime)>now;
  let prediction=null,predictionReason=null;
  if(prestart){try{prediction=predictScoreModel(research.liveModel,{league:game.league,startTime:game.startTime,homeId:game.home.sourceId,awayId:game.away.sourceId,neutralSite:game.neutralSite});}catch(e){predictionReason=e.message;}}
  else predictionReason='NOT_A_PREMATCH_SNAPSHOT';
  const halfTimeArtifact=soccerHalfTimeArtifacts(),{contentHash:halfTimeHash,...halfTimeBody}=halfTimeArtifact;
  if(halfTimeHash!==soccerAnalysisHash(halfTimeBody)||halfTimeArtifact.formalScoringEnabled!==false)throw Error('SOCCER_HALF_TIME_ARTIFACT_INVALID');
  const halfTimeResearch=halfTimeArtifact.leagues?.[game.league]||null;
  let halfTimePrediction=null,halfTimePredictionReason=null;
  if(prediction&&halfTimeResearch?.liveModel){try{halfTimePrediction=predictHalfTimeDistribution(prediction,halfTimeResearch.liveModel,{league:game.league,startTime:game.startTime});}catch(e){halfTimePredictionReason=e.message;}}
  else halfTimePredictionReason=prestart?'HALF_TIME_MODEL_UNAVAILABLE':'NOT_A_PREMATCH_SNAPSHOT';
  const providerPolicy=soccerProviderPolicy({asOf:now}),distributions={FT:prediction,HT:halfTimePrediction};
  const analysisStatus=prediction||!prestart?'COMPLETED':'INSUFFICIENT_DATA';
  const qaFlag=analysisStatus==='COMPLETED'?'WARN':'BLOCKED';
  const selectionResult=analysisStatus==='COMPLETED'?'RESEARCH_SHADOW':null;
  // Quotes retain their actual source, period and alternatives. A goal threshold
  // probability is not a settlement probability and does not authorize a wager.
  const directions=buildSoccerMarketDirections({matchedGames:matched,reader,game,now,distributions}).map(direction=>{
    const distribution=distributions[direction.period];
    const quotes=direction.quotes.map(quote=>({...quote,payoff:evaluateSoccerQuote({quote,distribution,contract:null})}));
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
  const evidenceMissing=[['攻守 xG',evidence.xg],...personnelMissing,['天氣',evidence.weather],['旅行與全賽程體能',evidence.travel],...(game.league==='ucl'?[['歐冠回合與跨聯賽強度',evidence.uclContext]]:[])].filter(([,v])=>!v||v.status==='UNKNOWN').map(([label,v])=>({label,reason:v?.reason||'EVIDENCE_NOT_PROVIDED'}));
  const result={ok:true,version:SOCCER_ANALYSIS_VERSION,league:game.league,gameId:game.id,date:game.date,observedAt:new Date(now).toISOString(),analysisCutoff:new Date(now).toISOString(),status:prestart?'RESEARCH_ONLY':'POSTSTART_AUDIT',evidence,personnelComparison:compareSoccerPersonnel(previous,evidence),readerEvidence:{status:matched.length?'MATCHED_RULES_UNVERIFIED':'NO_MATCHED_QUOTE',observedAt:matched.length?reader.observedAt:null,revision:matched.length?reader.revision:null,games:matched,executable:false},settlementReviews,prediction,predictionReason,researchValidation:{test:research.test,history:research.history,protocol:artifact.protocol,artifactHash:artifact.contentHash,modelTrainingHash:research.liveModel.trainingHash,rolling:{...validation.leagues[game.league],artifactHash:validationHash,interpretation:validation.protocol.interpretation},limitations:[...research.limitations.filter(x=>!x.startsWith('Single chronological split only')&&!x.startsWith('No half-time model,')), 'Settlement verification, executable market and betting return remain unverified', 'Rolling retrospective diagnostics are now available; stable improvement, PIT availability and market calibration remain unverified'],formalPromotion:false},directions,missing:evidenceMissing,formalScoringEnabled:false,executable:false};
  const audited={...result,halfTimePrediction,halfTimePredictionReason,
    halfTimeResearch:halfTimeResearch?{...halfTimeResearch,artifactHash:halfTimeHash,protocol:halfTimeArtifact.protocol,formalPromotion:false}:null,
    unassignedQuotes,providerPolicy,requirementsVersion:SOCCER_REQUIREMENTS_VERSION,analysisStatus,qaFlag,selectionResult,
    qualification:{status:'NOT_AUTHORIZED',eligible:false,reason:'SOCCER_FORMAL_VALIDATION_PENDING'},
    requirements:buildSoccerRequirementAudit({evidence,prediction,halfTimePrediction,reader:{games:matched},providerPolicy,validation:{...research,...validation.leagues[game.league]}}),
    inputVersions:{evidenceHash:evidence.source?.contentHash||null,evidenceFetchedAt:evidence.source.fetchedAt,
      workloadSourceVersions:(evidence.workload?.sources||[]).filter(s=>s?.contentHash).map(s=>({url:s.url,contentHash:s.contentHash,fetchedAt:s.fetchedAt})),
      readerObservationId:reader?.observationId||null,readerRevision:reader?.revision||null,readerFirstFetchedAt:reader?.firstFetchedAt||null,readerReceivedAt:reader?.receivedAt||null,readerSourceObservations:reader?.sourceObservations||[],
      modelTrainingHash:research.liveModel.trainingHash,researchArtifactHash:artifact.contentHash,validationArtifactHash:validationHash,halfTimeArtifactHash:halfTimeHash}};
  return {...audited,analysisHash:soccerAnalysisHash(audited)};
}
