import assert from 'node:assert/strict';
import fs from 'node:fs';
import {validateNbaCorpus,corpusRevision} from '../lib/nba/corpus-store.js';
const p={league:'NBA',kind:'nba-odds-corpus-shadow-research',strictPointInTime:false,modelInputEnabled:false,sourceHash:'a'.repeat(64),generatedAt:'2026-09-20T00:00:00Z',summary:{candidateGames:1,rawSnapshots:1,providerMatched:1,researchIncluded:1,marketBacktestEligible:0},candidateSubsetMetrics:{games:1,model:{samples:2,mae:2,rmse:2,bias:0},baseline:{samples:2,mae:1,rmse:1,bias:0}},entries:[{key:'04-01|NYK|CLE',candidateDate:'2026-04-01',away:'NYK',home:'CLE',gameId:'nba:espn:game:900001',sourceRows:['001-01'],snapshotCount:1,marketBacktestEligible:false,reasons:['ODDS_CAPTURE_TIME_MISSING'],researchStatus:'included_home_team_chronological_fold',fold:{gameId:'nba:espn:game:900001',date:'2026-04-01',trainingThrough:'2026-03-30',trainingRows:12,historicalDiagnostics:{predictedOwn:102,predictedOpponent:98,actualOwn:100,actualOpponent:100,baselineOwn:101,baselineOpponent:99}}}]};
validateNbaCorpus(p);
for(const mutate of [x=>x.league='MLB',x=>x.strictPointInTime=true,x=>x.summary.candidateGames=2,x=>x.entries.push(x.entries[0]),x=>x.entries[0].gameId='nhl:1',x=>x.entries[0].fold.trainingThrough='2026-04-01',x=>x.entries[0].marketBacktestEligible=true,x=>x.candidateSubsetMetrics.model.mae=0,x=>x.entries[0].fold.historicalDiagnostics.predictedOwn=null,x=>x.entries[0].sourceRows.push('001-01')]){const x=structuredClone(p);mutate(x);assert.throws(()=>validateNbaCorpus(x));}
const reorder=x=>x&&typeof x==='object'?Array.isArray(x)?x.map(reorder):Object.fromEntries(Object.entries(x).reverse().map(([k,v])=>[k,reorder(v)])):x;
assert.equal(corpusRevision(p),corpusRevision(reorder(p)));
// Actual store logic with SQL transport double. Not a live database test.
const records=new Map();const statements=[];
process.env.DATABASE_V2_URL='postgresql://synthetic:synthetic@localhost/synthetic';
globalThis.__nbaCorpusSql=()=>async(parts,...values)=>{const q=parts.join('?');statements.push(q);if(q.startsWith('CREATE'))return[];if(q.startsWith('INSERT')){if(!records.has(values[0]))records.set(values[0],reorder(JSON.parse(values[2])));return[];}if(q.startsWith('SELECT'))return [...records].filter(([k])=>!values.length||k===values[0]).map(([revision,payload])=>({revision,payload:structuredClone(payload)}));throw Error('Unexpected SQL');};
const url=new URL('../lib/nba/corpus-store.js',import.meta.url);const source=fs.readFileSync(url,'utf8').replace("import {neon} from '@neondatabase/serverless';",'const neon=globalThis.__nbaCorpusSql;').replace("'../database-url.js'",JSON.stringify(new URL('../database-url.js',url).href)).replace("'./identity.js'",JSON.stringify(new URL('./identity.js',url).href));
const store=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
assert.equal((await store.saveNbaCorpus(p)).persisted,true);await store.saveNbaCorpus(p);assert.equal(records.size,1);assert.deepEqual(await store.loadNbaCorpus(),reorder(p));
records.values().next().value.summary.candidateGames=2;await assert.rejects(()=>store.loadNbaCorpus());assert.ok(statements.every(q=>q.includes('sports_nba_corpus_v1')&&!/\b(DELETE|UPDATE|TRUNCATE)\b/.test(q)));
delete globalThis.__nbaCorpusSql;
console.log('NBA corpus: counts, chronology, math, NBA isolation, JSONB ordering, append-only persistence and tamper rejection PASS. SQL transport double, not live DB.');
