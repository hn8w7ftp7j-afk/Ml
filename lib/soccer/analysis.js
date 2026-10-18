import { createHash } from 'node:crypto';
import { soccerResearchArtifacts } from './research-frozen.js';
import { predictScoreModel } from './score-model.js';
import { compareSoccerPersonnel } from './personnel-audit.js';
import { soccerValidationArtifacts } from './validation-frozen.js';
import { soccerSettlementReview } from './settlement-review.js';
import { matchSoccerReaderGames } from './reader.js';

export const SOCCER_ANALYSIS_VERSION='SOCCER-EVIDENCE-RESEARCH-v2';
export const soccerAnalysisHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function buildSoccerAnalysis({evidence,reader=null,previous=null,now=Date.now()}){
  if(evidence?.ok!==true||!Number.isFinite(now)||!Number.isFinite(Date.parse(evidence.source?.fetchedAt))||Date.parse(evidence.source.fetchedAt)>now+5000||now-Date.parse(evidence.source.fetchedAt)>180000)throw Error('SOCCER_EVIDENCE_INVALID');
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
  // Every requested direction remains visible, including unavailable half-time quotes.
  // Unverified raw-card periods are not assigned to a full-time contract by guesswork.
  const directions=['FT','HT'].flatMap(period=>['HANDICAP_HOME','HANDICAP_AWAY','TOTAL_OVER','TOTAL_UNDER'].map(direction=>({period,direction,status:'BLOCKED',quote:null,score:null,W:null,R:null,eligible:false,executable:false,reasons:[...(prestart?[]:['MATCH_ALREADY_STARTED']),...(period==='HT'?['HALF_TIME_MODEL_UNVERIFIED']:prediction?[]:['SCORE_MODEL_UNAVAILABLE']),...(!matched.length?['MATCHED_READER_QUOTE_MISSING']:matched.some(x=>!x.fresh)?['READER_QUOTE_STALE']:[]),'SOCCER_PERIOD_SETTLEMENT_REBATE_UNVERIFIED','SOCCER_MODEL_NOT_PROMOTED']})));
  const evidenceMissing=[['攻守 xG',evidence.xg],['傷停與出賽資格',evidence.teams.home.injuries],['預計分鐘與替補',evidence.teams.home.minutes],['天氣',evidence.weather],['旅行與全賽程體能',evidence.travel],...(game.league==='ucl'?[['歐冠回合與跨聯賽強度',evidence.uclContext]]:[])].filter(([,v])=>v?.status==='UNKNOWN').map(([label,v])=>({label,reason:v.reason}));
  const result={ok:true,version:SOCCER_ANALYSIS_VERSION,league:game.league,gameId:game.id,date:game.date,observedAt:new Date(now).toISOString(),analysisCutoff:new Date(now).toISOString(),status:prestart?'RESEARCH_ONLY':'POSTSTART_AUDIT',evidence,personnelComparison:compareSoccerPersonnel(previous,evidence),readerEvidence:{status:matched.length?'MATCHED_RULES_UNVERIFIED':'NO_MATCHED_QUOTE',observedAt:matched.length?reader.observedAt:null,revision:matched.length?reader.revision:null,games:matched,executable:false},settlementReviews,prediction,predictionReason,researchValidation:{test:research.test,history:research.history,protocol:artifact.protocol,artifactHash:artifact.contentHash,modelTrainingHash:research.liveModel.trainingHash,rolling:{...validation.leagues[game.league],artifactHash:validationHash,interpretation:validation.protocol.interpretation},limitations:[...research.limitations.filter(x=>!x.startsWith('Single chronological split only')), 'Rolling retrospective diagnostics are now available; stable improvement, PIT availability and market calibration remain unverified'],formalPromotion:false},directions,missing:evidenceMissing,formalScoringEnabled:false,executable:false};
  return {...result,analysisHash:soccerAnalysisHash(result)};
}
