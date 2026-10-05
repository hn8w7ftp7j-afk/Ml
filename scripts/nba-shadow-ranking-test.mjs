import assert from 'node:assert/strict';
import { analyzeNbaPreseason } from '../lib/nba/preseason-model.js';
import { buildNbaShadowRanking } from '../lib/nba/shadow-ranking.js';
const date='2026-10-06', now=Date.parse('2026-10-05T19:50:00Z'), observedAt=new Date(now).toISOString();
const quotes={ fullTotal:{line:'232.5',overWater:.94,underWater:.94},fullRunline:{line:'3平',lineSide:'home',homeWater:.95,awayWater:.95},firstHalfTotal:{line:'115+50',overWater:.94,underWater:.96},firstHalfRunline:{line:'2-25',lineSide:'away',homeWater:.95,awayWater:.95} };
const make=(id,marketQuotes=quotes)=>{
 const game={league:'NBA',id:`nba:espn:game:${id}`,sourceId:String(id),seasonType:'preseason',season:{year:2027},taipeiDate:date,startTime:'2026-10-05T23:00:00Z',home:{id:'nba:espn:team:1'},away:{id:'nba:espn:team:29'}};
 return {game,quote:marketQuotes,observedAt,pageActivityAt:observedAt,canAnalyze:true,result:{...analyzeNbaPreseason(game,marketQuotes),league:'NBA',gameId:game.id,date,observedAt}};
};
const row=make(401999001), all=buildNbaShadowRanking([row],date,now);
assert.equal(all.entries.length,8);assert.ok(all.entries.every(x=>Number.isFinite(x.score)&&x.score>=1&&x.score<=8.9));assert.equal(all.currentGames,1);
assert.equal(new Set(all.entries.map(x=>x.stableKey)).size,8);
assert.ok(all.entries.every((x,i)=>!i||all.entries[i-1].score>=x.score));
assert.ok(all.entries.some(x=>x.expectedNet<0));
for (const key of Object.keys(quotes)) {
 const filtered=buildNbaShadowRanking([row],date,now,key);assert.equal(filtered.entries.length,2);assert.ok(filtered.entries.every(x=>x.marketKey===key));
 for(const e of filtered.entries){assert.equal(e.expectedNet,row.result.marketAnalyses[key].sides[e.side].expectedNet);assert.equal(e.water,key.endsWith('Total')?quotes[key][e.side==='over'?'overWater':'underWater']:quotes[key][`${e.side}Water`]);}
}
assert.equal(all.entries.find(x=>x.marketKey==='fullRunline'&&x.side==='home').role,'讓分');assert.equal(all.entries.find(x=>x.marketKey==='fullRunline'&&x.side==='away').role,'受讓');
assert.equal(all.entries.find(x=>x.marketKey==='firstHalfRunline'&&x.side==='away').role,'讓分');
const expired=buildNbaShadowRanking([row],date,now+180001);assert.equal(expired.entries.length,0);assert.equal(expired.outdatedGames,1);
assert.equal(buildNbaShadowRanking([{...row,quote:{...quotes,fullRunline:{...quotes.fullRunline,lineSide:'away'}}}],date,now).entries.length,0);
assert.equal(buildNbaShadowRanking([{...row,game:{...row.game,startTime:observedAt}}],date,now).entries.length,0);
assert.equal(buildNbaShadowRanking([{...row,observedAt:new Date(now+1000).toISOString()}],date,now+1000).entries.length,8);
for(const result of [{...row.result,status:'insufficient'},{...row.result,status:'reference'},{...row.result,gameId:'nba:espn:game:123'},{...row.result,date:'2026-10-05'},{...row.result,executable:true}]) assert.equal(buildNbaShadowRanking([{...row,result}],date,now).entries.length,0);
const corrupt=structuredClone(row);corrupt.result.marketAnalyses.fullTotal.sides.over.winProbability=2;assert.equal(buildNbaShadowRanking([corrupt],date,now).entries.length,0);
const five=Array.from({length:5},(_,i)=>make(401999001+i,{fullTotal:quotes.fullTotal,fullRunline:quotes.fullRunline}));
assert.equal(buildNbaShadowRanking(five,date,now).entries.length,20);assert.deepEqual(buildNbaShadowRanking(five.slice().reverse(),date,now),buildNbaShadowRanking(five,date,now));
assert.equal(buildNbaShadowRanking([row,row],date,now).entries.length,8);
// Ordinary model has net estimates but no certified win probability: show null.
const regular={...row,result:{...row.result,modelVersion:'nba-total-pace-rest-v1',quote:quotes.fullTotal,assessment:{positiveExpectedNet:2,negativeExpectedNet:-4}}};
const legacy=buildNbaShadowRanking([regular],date,now);assert.equal(legacy.entries.length,2);assert.ok(legacy.entries.every(x=>x.winProbability===null));
console.log('NBA shadow ranking PASS: all eight sides, current five-game 20 directions, exact net/water/favorite, filters, progressive results, stale/start/identity guards, deterministic sorting and no invented win probability');
