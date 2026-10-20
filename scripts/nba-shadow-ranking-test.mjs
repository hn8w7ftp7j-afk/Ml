import assert from 'node:assert/strict';
import { analyzeNbaPreseason } from '../lib/nba/preseason-model.js';
import { buildNbaShadowRanking, buildNbaPreviousRanking, buildNbaShadowOrder } from '../lib/nba/shadow-ranking.js';
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
const previous=buildNbaPreviousRanking([row],date,now+180001);
assert.equal(previous.entries.length,8);assert.equal(previous.gameCount,1);
assert.ok(previous.entries.every(entry=>entry.previousAnalysis&&entry.observedAt===observedAt));
assert.deepEqual(buildNbaPreviousRanking([row],date,now).entries,[]);
const changed={...row,quote:{...quotes,fullTotal:{...quotes.fullTotal,line:'240.5'}}};
assert.equal(buildNbaShadowRanking([changed],date,now).entries.length,0);
assert.equal(buildNbaPreviousRanking([changed],date,now,'fullTotal').entries[0].line,'232.5');
assert.equal(buildNbaPreviousRanking([row],date,Date.parse(row.game.startTime)).entries.length,0);
assert.equal(buildNbaPreviousRanking([row],'2026-10-07',now).entries.length,0);
assert.equal(buildNbaPreviousRanking([{...row,result:{...row.result,gameId:'nba:espn:game:123'}}],date,now).entries.length,0);
const mixed=[row,{...make(401999002),canAnalyze:false}];
assert.equal(buildNbaShadowRanking(mixed,date,now).entries.length,8);
assert.equal(buildNbaPreviousRanking(mixed,date,now).entries.length,8);
assert.ok(buildNbaPreviousRanking(mixed,date,now).entries.every(entry=>entry.game.id==='nba:espn:game:401999002'));
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

const orderedInput = all.entries.map((entry, i) => ({ ...entry, expectedNet: 6.56, robustExpectedNet: 1, score: i === 0 ? 6.9 : 7 + i / 10 }));
const later = orderedInput.map(entry => ({ ...entry, stableKey: 'later:' + entry.stableKey, game: { ...entry.game, id: 'nba:espn:game:401999999', startTime: '2026-10-06T00:00:00Z' } }));
const groups = buildNbaShadowOrder([...later, ...orderedInput].reverse());
assert.equal(groups.length, 2);
assert.equal(groups[0].gameDate, row.game.startTime);
assert.ok(groups.every(group => group.entries.every(entry => entry.score >= 7)));
assert.deepEqual(groups.flatMap(group => group.entries).map(entry => entry.betOrderIndex), Array.from({length:14}, (_,i)=>i+1));
const marketOrder = ['全場讓分','全場大小','上半讓分','上半大小'];
assert.ok(groups.every(group => group.entries.every((entry,i)=>!i || marketOrder.indexOf(group.entries[i-1].market) <= marketOrder.indexOf(entry.market))));
assert.deepEqual(buildNbaShadowOrder(orderedInput), buildNbaShadowOrder(orderedInput.slice().reverse()));
console.log('NBA order PASS: shared MLB threshold, chronological game groups, market order, contiguous direction sequence');
const screenshotEntry = { ...orderedInput[1], score: 7, expectedNet: 6.56, robustExpectedNet: -2.57 };
assert.deepEqual(buildNbaShadowOrder([screenshotEntry]), [], '截圖的 S7/W6.56/R-2.57 不得進候選');
for (const field of ['expectedNet', 'robustExpectedNet']) {
  for (const value of [0, -1, null, undefined, NaN, Infinity]) {
    assert.deepEqual(buildNbaShadowOrder([{ ...orderedInput[1], [field]: value }]), []);
  }
}
const original = structuredClone(all.entries);
buildNbaShadowOrder(all.entries);
assert.deepEqual(all.entries, original, '全部方向含負EV的原始資料必須保留');
assert.ok(all.entries.some(x => x.expectedNet < 0));
console.log('NBA order PASS: positive W/R gates, screenshot regression, all-direction preservation');

// Render the real ranking component; expired quotes must remain visibly labelled.
const { readFileSync } = await import('node:fs');
const { default: vm } = await import('node:vm');
const { transform } = await import('next/dist/build/swc/index.js');
const rankingModule = await import('../lib/nba/shadow-ranking.js');
const compiled = await transform(readFileSync(new URL('../app/nba/shadow-ranking.js', import.meta.url),'utf8'), {
 filename:'app/nba/shadow-ranking.js', module:{type:'commonjs'},
 jsc:{parser:{syntax:'ecmascript',jsx:true},transform:{react:{runtime:'automatic'}},target:'es2022'},
});
let uiView='ranking',uiFilter='all',uiHook=0;
const sandbox={exports:{},Intl,Date,require(id){
 if(id==='react') return {useState:()=>[uiHook++===0?uiView:uiFilter,()=>{}]};
 if(id==='react/jsx-runtime')return {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};
 if(id.endsWith('/shadow-ranking.js'))return rankingModule;
 if(id.endsWith('/labels.js'))return {NBA_TEAM_LABELS:{}};
 if(id.endsWith('/bet-records.js'))return {NbaBetRecordButton:'BetRecordButton'};
 throw Error(id);
}};
vm.runInNewContext(compiled.code,sandbox);
function nodes(value){
 if(Array.isArray(value))return value.flatMap(nodes);
 if(value&&typeof value==='object')return [value,...nodes(value.props?.children)];
 return value==null||value===false?[]:[value];
}
const render=(input,at)=>{uiHook=0;return nodes(sandbox.exports.default({rows:input,date,now:at,onAnalyze:()=>{},busy:false}));};
const staleUi=render([row],now+180001);
assert.equal(staleUi.filter(n=>n?.props?.['data-nba-rank-key']).length,8);
assert.ok(staleUi.includes('上次分析｜盤口待更新'));
assert.ok(!staleUi.includes('尚無目前盤口的分析結果。'));
assert.equal(staleUi.filter(n=>n?.type==='BetRecordButton').length,8);
assert.ok(!render([row],now).includes('上次分析｜盤口待更新'));
uiView='order';
const staleOrderUi=render([row],now+180001);
assert.equal(staleOrderUi.filter(n=>n?.props?.['data-nba-rank-key']).length,buildNbaShadowOrder(previous.entries).flatMap(group=>group.entries).length);
console.log('NBA ranking UI PASS: accepted stale results and record controls stay visible with original-price warning; fresh results are not duplicated and candidate gates remain intact');
