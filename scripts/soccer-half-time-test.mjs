import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {extractSoccerHalfTime} from '../lib/soccer/data.js';
import {enrichSoccerHistoryHalfTime} from '../lib/soccer/history.js';
import {scoreDistribution,soccerScoreLogProbability} from '../lib/soccer/score-model.js';
import {fitHalfTimeModel,predictHalfTimeDistribution,evaluateHalfTimeModel,soccerHalfTimeLogProbability,soccerHalfTimeJointCells} from '../lib/soccer/half-time-model.js';
import {soccerHalfTimeArtifacts} from '../lib/soccer/half-time-frozen.js';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const near=(a,b,t=1e-10)=>assert.ok(Math.abs(a-b)<=t,`${a} != ${b}`);
const source={url:'https://example.invalid/verified-source',contentHash:'unit-hash',fetchedAt:'2026-10-18T00:00:00.000Z'};
const row=(id,h,a,htH,htA)=>({league:'epl',eventId:String(id),startTime:'2022-06-01T15:00:00.000Z',homeId:'1',awayId:'2',period:'REGULATION_FT',homeGoals:h,awayGoals:a,source,halfTime:{home:htH,away:htA,verified:true,evidence:{method:'EXPLICIT_PERIOD_1'},source}});
const rows=[row(1,1,1,1,0),row(2,9,1,0,1)];
const model=fitHalfTimeModel(rows,{league:'epl',cutoff:'2024-01-01T00:00:00.000Z',halfLifeDays:365});
near(model.shares.home,.1);near(model.shares.away,.5);assert.equal(model.formalEnabled,false);
const withZero=fitHalfTimeModel([...rows,row(3,0,0,0,0)],{league:'epl',cutoff:model.cutoff,halfLifeDays:365});
near(withZero.shares.home,model.shares.home);near(withZero.shares.away,model.shares.away);
assert.throws(()=>fitHalfTimeModel([{...rows[0],league:'ucl'}],{league:'epl',cutoff:model.cutoff}));
assert.throws(()=>fitHalfTimeModel([{...rows[0],startTime:'2025-01-01T00:00:00.000Z'}],{league:'epl',cutoff:model.cutoff}));
assert.throws(()=>fitHalfTimeModel([row(1,0,0,0,0)],{league:'epl',cutoff:model.cutoff}));
console.log('PASS training uses time-weighted goal exposures, keeps zero-exposure semantics and rejects future/cross-league rows');

for(const [lambda,mu,rho,qH,qA] of [[1.8,1.1,-.05,.43,.46],[2.3,.7,.05,.4,.6],[25,20,0,.02,.9],[1,2,-.1,0,1],[1,2,-.1,1,1]]){
 const ft=scoreDistribution(lambda,mu,rho),original=JSON.stringify(ft),m={...model,shares:{home:qH,away:qA}};
 const ht=predictHalfTimeDistribution(ft,m,{league:'epl',startTime:model.cutoff}),fm=new Map(),hm=new Map();let hMean=0,aMean=0,jointMass=0;
 for(const c of soccerHalfTimeJointCells(ft,m,{league:'epl',startTime:model.cutoff})){
  assert.ok(c.home<=c.ftHome&&c.away<=c.ftAway&&c.home>=0&&c.away>=0);assert.ok(c.probability>=0&&Number.isFinite(c.probability));
  const k=`${c.ftHome}:${c.ftAway}`,hk=`${c.home}:${c.away}`;fm.set(k,(fm.get(k)||0)+c.probability);hm.set(hk,(hm.get(hk)||0)+c.probability);jointMass+=c.probability;
 }
 for(const c of ft.cells)near(fm.get(`${c.home}:${c.away}`)||0,c.probability,2e-13);
 for(const c of ht.cells){hMean+=c.home*c.probability;aMean+=c.away*c.probability;assert.ok(Math.abs((hm.get(`${c.home}:${c.away}`)||0)-c.probability)<ft.tailMass+ht.tailMass+3e-13);if(c.home<=1&&c.away<=1){const exact=Math.exp(soccerHalfTimeLogProbability(c.home,c.away,ft,m));near(exact,c.probability,3e-13);}}
 near(jointMass,ft.retainedMass,2e-12);near(ht.retainedMass,ft.retainedMass,2e-12);near(hMean,qH*lambda,1e-9);near(aMean,qA*mu,1e-9);
 near(Object.values(ht.outcomes).reduce((a,b)=>a+b,0),ht.retainedMass,1e-12);assert.equal(JSON.stringify(ft),original);assert.equal(ht.formalEnabled,false);
 if(qH===1&&qA===1)near(soccerHalfTimeLogProbability(2,1,ft,m),soccerScoreLogProbability(2,1,lambda,mu,rho));
}
assert.throws(()=>predictHalfTimeDistribution(scoreDistribution(1,1),model,{league:'ucl'}));
assert.throws(()=>predictHalfTimeDistribution(scoreDistribution(1,1),model,{league:'epl',startTime:'2023-12-31T00:00:00.000Z'}));
assert.throws(()=>predictHalfTimeDistribution(scoreDistribution(1,1),{...model,shares:{home:1.1,away:.5}}));
console.log('PASS legal joint construction preserves every FT marginal, never reverses scores, handles boundary shares and uses exact DC thinning probabilities');
const custom={period:'REGULATION_FT',cells:[{home:0,away:0,probability:.2},{home:2,away:1,probability:.7}],retainedMass:.9,tailMass:.1};
const customHT=predictHalfTimeDistribution(custom,model);
near(customHT.retainedMass,.9);near(customHT.tailMass,.1);assert.equal(customHT.exactScoreAvailable,false);assert.equal(customHT.homeRate,null);
assert.throws(()=>soccerHalfTimeLogProbability(0,0,custom,model));
assert.throws(()=>predictHalfTimeDistribution({...custom,cells:[{home:0,away:0,probability:-.1}]},model));
console.log('PASS arbitrary PMFs use legal thinning with inherited missing mass and cannot claim a DC exact score');

const rare=row(50,30,30,30,30);rare.startTime='2025-05-01T12:00:00.000Z';
const metrics=evaluateHalfTimeModel(model,[rare],{predictFullTime:()=>scoreDistribution(.3,.2)});
assert.equal(metrics.count,1);assert.ok(Number.isFinite(metrics.scoreLogLoss));assert.ok(metrics.scoreLogLoss>100);
const changed=row(50,29,29,30,30);changed.startTime=rare.startTime;
const invalid=evaluateHalfTimeModel(model,[changed],{predictFullTime:()=>scoreDistribution(.3,.2)});
assert.equal(invalid.count,0);
console.log('PASS rare observed HT scores remain in exact logloss denominator and impossible HT/FT pairs are excluded explicitly');

const examples=JSON.parse(fs.readFileSync('research/soccer/half-time-extraction-examples.json','utf8'));
assert.equal(examples.examples.length,2);
for(const e of examples.examples){
 assert.equal(hash(e.payload),e.projectionHash);assert.ok(e.source.contentHash&&e.source.fetchedAt&&e.source.url);
 const c=e.payload.header.competitions[0],extracted=extractSoccerHalfTime({competition:c,status:c.status,format:e.payload.format,keyEvents:e.payload.keyEvents,source:e.source});
 assert.ok(extracted.halfTime?.verified);assert.equal(extracted.halfTime.evidence.method,'ORDERED_PERIOD_TOTALS_WITH_SCORING_TIMELINE');
 const home=c.competitors.find(t=>t.homeAway==='home'),away=c.competitors.find(t=>t.homeAway==='away');
 const r={league:e.name.startsWith('epl')?'epl':'ucl',eventId:e.payload.header.id,startTime:c.date||e.payload.header.date,period:'REGULATION_FT',homeId:String(home.team.id),awayId:String(away.team.id),homeGoals:Number(home.score),awayGoals:Number(away.score)};
 assert.ok(enrichSoccerHistoryHalfTime(r,e.payload,e.source).ok);
 assert.equal(enrichSoccerHistoryHalfTime({...r,homeGoals:r.homeGoals+1},e.payload,e.source).ok,false);
 const broken=structuredClone(c);broken.competitors[0].linescores[1].displayValue=String(Number(broken.competitors[0].linescores[1].displayValue)+1);
 assert.equal(extractSoccerHalfTime({competition:broken,status:c.status,format:e.payload.format,keyEvents:e.payload.keyEvents,source:e.source}).halfTime,null);
 assert.equal(extractSoccerHalfTime({competition:c,status:c.status,format:e.payload.format,keyEvents:[],source:e.source}).halfTime,null);
}
console.log('PASS two actual EPL/UCL summaries prove period totals against scoring events; cumulative/mismatched or incomplete lines fail closed');

const artifact=soccerHalfTimeArtifacts(),{contentHash,...body}=artifact;
assert.equal(hash(body),contentHash);assert.equal(artifact.formalEnabled,false);assert.equal(artifact.formalScoringEnabled,false);assert.equal(artifact.pointInTimeAvailabilityVerified,false);
for(const league of ['epl','ucl']){
 const r=artifact.leagues[league],history=JSON.parse(gunzipSync(fs.readFileSync(`research/soccer/half-time-${league}-history.json.gz`)));
 assert.equal(r.collection.sample,r.collection.used+r.collection.excluded);assert.equal(r.collection.used,history.rows.length);assert.equal(r.collection.excluded,history.excluded.length);
 assert.ok(r.liveModel.trainingCount>0);assert.ok(r.diagnostic.metrics.count>0);assert.equal(r.diagnostic.used+r.diagnostic.excluded,r.diagnostic.sample);
 assert.equal(r.liveModel.formalEnabled,false);assert.equal(r.liveModel.cutoff,artifact.protocol.liveTrainingBefore);
 const ft=JSON.parse(gunzipSync(fs.readFileSync(`research/soccer/${league}-history.json.gz`))).rows,map=new Map(history.rows.map(row=>[row.eventId,row]));
 const training=ft.map(row=>map.get(row.eventId)||row).filter(row=>Date.parse(row.startTime)+86400000<Date.parse(r.liveModel.cutoff));
 assert.deepEqual(fitHalfTimeModel(training,{league,cutoff:r.liveModel.cutoff,...r.selected}),r.liveModel);
 assert.equal(new Set(r.validation.trials.map(t=>t.metrics.count)).size,1);
}
console.log('PASS frozen artifacts have reproducible hashes, original collection denominators, separate league fits and explicitly retrospective diagnostics');
