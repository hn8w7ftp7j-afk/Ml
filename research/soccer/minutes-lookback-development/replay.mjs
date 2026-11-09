import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
// Offline research only. No product files, forecasts or registry are written.
const directory=path.dirname(fileURLToPath(import.meta.url));
const args=process.argv.slice(2);let root=path.resolve(directory,'../../..'),output=null,verify=false;
for(let i=0;i<args.length;i++){
 if(args[i]==='--root'&&args[i+1])root=path.resolve(args[++i]);
 else if(args[i]==='--output'&&args[i+1])output=path.resolve(args[++i]);
 else if(args[i]==='--verify')verify=true;
 else throw Error('USAGE: node replay.mjs [--root REPOSITORY] [--output NEW_REPORT_JSON] [--verify]');
}
if(output&&fs.existsSync(output))throw Error('OUTPUT_ALREADY_EXISTS');
const DAY=86400000;
const canonical=value=>JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const hash=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:canonical(value)).digest('hex');
const protocol=JSON.parse(fs.readFileSync(path.join(directory,'protocol.json'),'utf8'));
assert.deepEqual(protocol.windows,[14,28,42]);
assert.deepEqual(protocol.leagues,['epl','ucl']);
assert.equal(protocol.labelLagHours,24);assert.equal(protocol.maximumPriorMatches,3);
assert.equal(protocol.accepted,false);assert.equal(protocol.modelEffect,false);assert.equal(protocol.untouchedOOS,false);
for(const [relative,expected] of Object.entries(protocol.sourceFiles)){
 if(hash(fs.readFileSync(path.join(root,relative)))!==expected)throw Error('PINNED_SOURCE_HASH_MISMATCH '+relative);
}
const sourcePath=path.join(root,'lib/soccer/expected-minutes-model.js');let code=fs.readFileSync(sourcePath,'utf8');
const originalCodeHash=hash(code);
if(code.split('export function buildSoccerExpectedMinutesRows(observations){').length!==2||code.split('instant(match.startTime)>=at-14*DAY').length!==2)throw Error('TRANSFORM_ANCHOR_CHANGED');
code=code.replace('export function buildSoccerExpectedMinutesRows(observations){','export function buildSoccerExpectedMinutesRows(observations,windowDays=14){').replace('instant(match.startTime)>=at-14*DAY','instant(match.startTime)>=at-windowDays*DAY');
const temporaryTransformedSourceSemanticHash=hash(code);
code=code.replace(/from '(\.\/[^']+)'/g,(_m,s)=>`from '${pathToFileURL(path.resolve(path.dirname(sourcePath),s)).href}'`);
const module=await import('data:text/javascript,'+encodeURIComponent(code));
const original=await import(pathToFileURL(sourcePath));
const {soccerExpectedMinutesArtifacts}=await import(pathToFileURL(path.join(root,'lib/soccer/expected-minutes-frozen.js')));
const {normalizeSoccerPersonnelHistoryV2}=await import(pathToFileURL(path.join(root,'lib/soccer/personnel-minutes-v2.js')));
const artifact=soccerExpectedMinutesArtifacts(),sourceHashes={},derivedHashes={},results={};
for(const league of protocol.leagues)assert.equal(artifact.leagues[league].validation.selectedShrinkage,protocol.fixedShrinkage[league]);
const load=file=>{const b=fs.readFileSync(path.join(root,file));sourceHashes[file]=hash(b);return JSON.parse(gunzipSync(b));};
const begin=Date.parse(protocol.trainingBefore),end=Date.parse(protocol.developmentBefore);
const before=(row,cut)=>Date.parse(row.startTime)+DAY<cut;
const key=r=>`${r.eventId}:${r.teamId}:${r.id}`;
const mean=v=>v.reduce((a,b)=>a+b,0)/v.length;
function evaluated(model,rows,only=null,baseline=false){
 const teams=new Map();for(const row of rows){let k=`${row.eventId}:${row.teamId}`;if(!teams.has(k))teams.set(k,[]);teams.get(k).push({...module.predictSoccerExpectedMinutes(model,row,{baseline}),row});}
 for(const ps of teams.values())module.reconcileSoccerExpectedMinutesTeam(ps);
 const games=new Map();for(const p of [...teams.values()].flat()){
  const r=p.row;if(only&&!only.has(key(r)))continue;const which=['STARTER','SUBSTITUTE','NO_APPEARANCE'].indexOf(r.targetRole),e=p.expectedMinutes-r.targetMinutes;
  if(!games.has(r.eventId))games.set(r.eventId,[]);games.get(r.eventId).push({ae:Math.abs(e),se:e*e,ll:p.probabilities[which]===0?Infinity:-Math.log(p.probabilities[which]),bs:p.probabilities.reduce((v,x,i)=>v+(x-Number(i===which))**2,0)});
 }
 const g=[...games.values()].map(ps=>Object.fromEntries(['ae','se','ll','bs'].map(k=>[k,mean(ps.map(p=>p[k]))]))),n=g.length;
 return {games:n,playerTargets:[...games.values()].reduce((v,g)=>v+g.length,0),minuteMAE:n?mean(g.map(g=>g.ae)):null,minuteRMSE:n?Math.sqrt(mean(g.map(g=>g.se))):null,logLoss:n&&g.every(g=>Number.isFinite(g.ll))?mean(g.map(g=>g.ll)):null,logLossState:!n?'UNAVAILABLE':g.some(g=>!Number.isFinite(g.ll))?'POSITIVE_INFINITY':'FINITE',brier:n?mean(g.map(g=>g.bs)):null};
}
for(const league of protocol.leagues){
 const history=load(`research/soccer/${league}-history.json.gz`).rows,retained=load(`research/soccer/personnel-${league}-sources.json.gz`),byId=new Map(history.map(r=>[r.eventId,r])),obs=[];
 let excluded2025=0;for(const record of retained){const row=byId.get(record.eventId);if(!row)throw Error('MISSING_HISTORY_ID');if(Date.parse(row.startTime)>=end){excluded2025++;continue;}const r=normalizeSoccerPersonnelHistoryV2(row,record.data,record.source);if(!r.ok)throw Error('SOURCE_REPLAY_FAILED '+r.code);obs.push(r.observation);}
 obs.sort((a,b)=>Date.parse(a.startTime)-Date.parse(b.startTime)||a.eventId.localeCompare(b.eventId));derivedHashes[league]=hash(obs);
 if(derivedHashes[league]!==protocol.expectedDerivedObservationHashes[league])throw Error('DERIVED_OBSERVATION_HASH_MISMATCH '+league);
 const originalRows=original.buildSoccerExpectedMinutesRows(obs),defaultRows=module.buildSoccerExpectedMinutesRows(obs,14);
 if(hash(originalRows)!==hash(defaultRows))throw Error('14_DAY_REPRODUCTION_FAILED');
 const developmentGames=obs.filter(g=>g.minutes.status==='REGULATION_CLOCK_RECONSTRUCTED'&&Date.parse(g.startTime)>=begin&&before(g,end));
 const shrinkage=protocol.fixedShrinkage[league],candidates=[];
 for(const days of protocol.windows){
  const dataset=module.buildSoccerExpectedMinutesRows(obs,days),train=dataset.rows.filter(r=>before(r,begin)),dev=dataset.rows.filter(r=>Date.parse(r.startTime)>=begin&&before(r,end)),model=module.fitSoccerExpectedMinutesModel(train,{league,shrinkage});
  const teamCandidates=new Map();for(const row of dev){let k=`${row.eventId}:${row.teamId}`;if(!teamCandidates.has(k))teamCandidates.set(k,new Set());teamCandidates.get(k).add(row.id);}
  let unseenAppearing=0,unseenMinutes=0,targetAppearing=0,bothSides=0;
  for(const g of developmentGames){let sides=0;for(const side of ['home','away']){const t=g.minutes.teams[side],ids=teamCandidates.get(`${g.eventId}:${t.sourceId}`)||new Set();if(ids.size)sides++;for(const p of t.players)if(p.appeared){targetAppearing++;if(!ids.has(p.id)){unseenAppearing++;unseenMinutes+=p.regulationClockMinutes;}}}if(sides===2)bothSides++;}
  const metric=evaluated(model,dev),reference=module.evaluateSoccerExpectedMinutes(model,dev).model;
  for(const k of ['minuteMAE','minuteRMSE','logLoss','brier'])if(Number.isFinite(metric[k])&&Math.abs(metric[k]-reference[k])>1e-12)throw Error('METRIC_MISMATCH '+k);
  candidates.push({days,model,dev,teamCandidates,trainingGames:model.trainingGames,trainingPlayerTargets:train.length,developmentRowsHash:hash(dev),modelHash:module.soccerExpectedMinutesHash(model),coverage:{populationGames:developmentGames.length,populationTeamTargets:developmentGames.length*2,evaluatedGames:metric.games,bothSidesGames:bothSides,availableTeamTargets:teamCandidates.size,candidatePlayerTargets:dev.length,targetAppearingPlayers:targetAppearing,unseenAppearingPlayers:unseenAppearing,unseenRegulationMinutes:unseenMinutes},allOwnCohort:{model:metric,baseline:evaluated(model,dev,null,true)}});
 }
 const common=new Set(candidates[0].dev.map(key));for(const c of candidates.slice(1)){const s=new Set(c.dev.map(key));for(const k of common)if(!s.has(k))common.delete(k);}
 const baselineTeamKeys=new Set(candidates[0].teamCandidates.keys());
 for(const c of candidates){c.commonPairedCohort={model:evaluated(c.model,c.dev,common),baseline:evaluated(c.model,c.dev,common,true)};c.rescuedTeamTargetsOver14=[...c.teamCandidates.keys()].filter(k=>!baselineTeamKeys.has(k)).length;delete c.model;delete c.dev;delete c.teamCandidates;}
 results[league]={retainedPre2025Observations:obs.length,excluded2025BeforeNormalization:excluded2025,shrinkage,commonPairedPlayerTargets:common.size,candidates};
 console.log(JSON.stringify({league,done:true,windows:candidates.map(c=>({days:c.days,coverage:c.coverage,all:c.allOwnCohort,paired:c.commonPairedCohort,rescuedTeamTargetsOver14:c.rescuedTeamTargetsOver14}))}));
}
const report={classification:protocol.classification,protocol,protocolHash:hash(protocol),originalImplementationHash:originalCodeHash,
 temporaryTransformedSourceSemanticHash,sourceHashes,derivedHashes,results,networkRequests:0,
 modelChanged:false,registryChanged:false,modelEffect:false,accepted:false,holdout2025Used:false,untouchedOOS:false,
 pointInTimeAvailabilityVerified:false,prospectivelyPreregistered:false,formalEligible:false,
 interpretation:'POST_HOC_RETROSPECTIVE_TRAIN_DEVELOPMENT_SENSITIVITY_NOT_NEW_UNTOUCHED_OOS'};
if(verify){
 const saved=JSON.parse(fs.readFileSync(path.join(directory,'report.json'),'utf8'));
 assert.deepEqual(report,saved,'RESEARCH_REPORT_REPRODUCTION_FAILED');
}
if(output)fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({classification:report.classification,reportHash:hash(report),verifiedCommittedReport:verify,output,
 accepted:false,modelEffect:false,holdout2025Used:false,untouchedOOS:false}));
