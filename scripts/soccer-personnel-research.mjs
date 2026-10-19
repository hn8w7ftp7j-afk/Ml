import fs from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {fitScoreModel,evaluateScoreModel} from '../lib/soccer/score-model.js';
import {soccerResearchArtifacts} from '../lib/soccer/research-frozen.js';
import {fitSoccerPersonnelModel,evaluateSoccerPersonnelModel,predictSoccerPersonnelModel} from '../lib/soccer/personnel-model.js';
import {soccerPersonnelHash} from '../lib/soccer/personnel-history.js';
import {pairedBlockDifference} from '../lib/soccer/validation.js';

const root='research/soccer',load=file=>JSON.parse(gunzipSync(fs.readFileSync(`${root}/${file}`))),protocol=JSON.parse(fs.readFileSync(`${root}/personnel-protocol.json`)),original=soccerResearchArtifacts(),collection=JSON.parse(fs.readFileSync(`${root}/personnel-collection.json`));
const before=(row,cutoff)=>Date.parse(row.startTime)+86400000<Date.parse(cutoff);
const summary=m=>({sample:m.sample,count:m.count,excluded:m.excluded,coverage:m.coverage,logLoss:m.logLoss,brier:m.brier,scoreLogLoss:m.scoreLogLoss,probabilityAudit:m.probabilityAudit,baseline:m.baseline});
const leagues={};
for(const league of ['epl','ucl']){
 const all=load(`${league}-history.json.gz`).rows,personnel=load(`personnel-${league}-history.json.gz`).rows,byId=new Map(personnel.map(row=>[row.eventId,row])),population=all.map(row=>byId.get(row.eventId)||row),choice=original.leagues[league].selected;
 const fitBaseline=cutoff=>fitScoreModel(all.filter(row=>before(row,cutoff)),{league,cutoff,...choice,maxIterations:6000,tolerance:1e-6});
 const baseline=fitBaseline(protocol.trainingBefore),training=personnel.filter(row=>before(row,protocol.trainingBefore)),validation=population.filter(row=>row.startTime>=protocol.trainingBefore&&row.startTime<protocol.validationBefore),trials=[];
 for(const penalty of protocol.penalties){
  const model=fitSoccerPersonnelModel(training,{league,cutoff:protocol.trainingBefore,baselineModel:baseline,penalty}),metrics=evaluateSoccerPersonnelModel(model,validation,{fold:'personnel-validation-2024'});
  trials.push({penalty,model,metrics});console.log(JSON.stringify({stage:'PERSONNEL_VALIDATION',league,penalty,fit:model.fit,count:metrics.count,sample:metrics.sample,logLoss:metrics.logLoss,baseline:metrics.baseline.logLoss}));
 }
 const fittedTrials=trials.filter(trial=>trial.model.fit.converged);
 const common=validation.filter(row=>fittedTrials.length>0&&fittedTrials.every(trial=>trial.metrics.games.some(g=>g.eventId===row.eventId&&g.status==='EVALUATED')));
 for(const trial of trials)trial.common=evaluateSoccerPersonnelModel(trial.model,common,{fold:'personnel-common-validation-2024'});
 const valid=trials.filter(t=>t.model.fit.converged&&Number.isFinite(t.common.logLoss)&&t.common.count===common.length&&common.length>0).sort((a,b)=>a.common.logLoss-b.common.logLoss||a.penalty-b.penalty);
 if(!valid.length)throw Error(`PERSONNEL_NO_VALIDATED_MODEL_${league}`);
 const selected=valid[0],reference=evaluateScoreModel(baseline,common,{fold:'personnel-common-validation-2024'}),preferred=selected.common.logLoss<reference.logLoss?'XI_CHALLENGER':'UNCHANGED_BASELINE';
 const diagnosticBaseline=fitBaseline(protocol.validationBefore),diagnosticModel=fitSoccerPersonnelModel(personnel.filter(row=>before(row,protocol.validationBefore)),{league,cutoff:protocol.validationBefore,baselineModel:diagnosticBaseline,penalty:selected.penalty}),diagnosticRows=population.filter(row=>row.startTime>=protocol.validationBefore&&row.startTime<protocol.diagnosticBefore),diagnostic=evaluateSoccerPersonnelModel(diagnosticModel,diagnosticRows,{fold:'personnel-retrospective-2025'});
 const matchedRows=diagnosticRows.filter(row=>diagnostic.games.some(g=>g.eventId===row.eventId&&g.status==='EVALUATED')),referenceDiagnostic=evaluateScoreModel(diagnosticBaseline,matchedRows),refById=new Map(referenceDiagnostic.games.map(g=>[g.eventId,g]));
 const paired=diagnostic.games.filter(g=>g.status==='EVALUATED').map(g=>({eventId:g.eventId,startTime:g.startTime,difference:g.logLoss+Math.log(refById.get(g.eventId).probabilities[refById.get(g.eventId).actualOutcome])}));
 const live=fitSoccerPersonnelModel(personnel.filter(row=>before(row,protocol.liveTrainingBefore)),{league,cutoff:protocol.liveTrainingBefore,baselineModel:original.leagues[league].liveModel,penalty:selected.penalty});
 const sensitivities=[];
 for(const row of matchedRows.slice(0,10)){
  try{
  const base=predictSoccerPersonnelModel(diagnosticModel,row,{mode:'RETROSPECTIVE_OBSERVED_XI'}),replacement=Object.keys(diagnosticModel.clubStarterFrequencies[row.homeId]).find(player=>!row.personnel.teams.home.starters.includes(player));
  if(!replacement)continue;const changed=structuredClone(row),removed=changed.personnel.teams.home.starters[0];changed.personnel.teams.home.starters[0]=replacement;
  const counterfactual=predictSoccerPersonnelModel(diagnosticModel,changed,{mode:'COUNTERFACTUAL_DIAGNOSTIC'});
  sensitivities.push({eventId:row.eventId,kind:'COUNTERFACTUAL_SINGLE_KNOWN_PLAYER_SWAP_NOT_FORECAST_OR_CAUSAL_EFFECT',removed,replacement,originalRates:{home:base.homeRate,away:base.awayRate},changedRates:{home:counterfactual.homeRate,away:counterfactual.awayRate}});
  }catch(error){sensitivities.push({eventId:row.eventId,kind:'COUNTERFACTUAL_DIAGNOSTIC_UNAVAILABLE',reason:error.message});}
 }
 leagues[league]={collection:collection.leagues[league],selectedPenalty:selected.penalty,validationPreferredModel:preferred,validation:{originalPopulation:validation.length,commonCount:common.length,reference:{count:reference.count,logLoss:reference.logLoss,brier:reference.brier},trials:trials.map(t=>({penalty:t.penalty,fit:t.model.fit,metrics:summary(t.metrics),common:summary(t.common)}))},diagnostic:{...diagnostic,comparison:pairedBlockDifference(paired),interpretation:'ALREADY_EXAMINED_2025_RETROSPECTIVE_DEVELOPMENT_DIAGNOSTIC_NOT_NEW_OOS'},sensitivities,model:live,defaultDistribution:'UNCHANGED_BASELINE',challengerDisplayOnly:true,formalEnabled:false};
 console.log(JSON.stringify({stage:'PERSONNEL_DIAGNOSTIC',league,selectedPenalty:selected.penalty,preferred,fit:live.fit,count:diagnostic.count,sample:diagnostic.sample,logLoss:diagnostic.logLoss,baseline:diagnostic.baseline.logLoss,comparison:leagues[league].diagnostic.comparison}));
}
const report={version:'SOCCER-XI-RESEARCH-ARTIFACT-v1',createdAt:new Date().toISOString(),protocol,protocolHash:soccerPersonnelHash(protocol),collectionHash:soccerPersonnelHash(collection),leagues,formalEnabled:false};
fs.writeFileSync(`${root}/personnel-baseline.json`,JSON.stringify(report,null,2)+'\n');
const compact={...report,leagues:Object.fromEntries(Object.entries(leagues).map(([league,value])=>[league,{...value,diagnostic:{...value.diagnostic,games:undefined}}]))};compact.contentHash=soccerPersonnelHash(compact);
fs.writeFileSync('lib/soccer/personnel-frozen.js','// Retrospective starting-XI challenger. Never a formal model promotion.\nconst data='+JSON.stringify(compact)+';\nexport function soccerPersonnelArtifacts(){return structuredClone(data);}\n');
