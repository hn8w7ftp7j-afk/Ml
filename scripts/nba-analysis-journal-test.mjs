import assert from 'node:assert/strict';
import { buildNbaAnalysisCapture, saveNbaAnalysisCapture } from '../lib/nba/analysis-journal.js';
const input = {status:'ready',league:'NBA',gameId:'nba:espn:game:123',date:'2026-10-07',modelVersion:'synthetic-v1',
 game:{status:'scheduled',completed:false,timeConfirmed:true,startTime:'2026-10-07T02:00:00Z'},prediction:{total:220},
 quoteHash:'a'.repeat(64),quote:{line:'220平',overWater:.94,underWater:.92},generatedAt:'2026-10-07T01:00:00Z'};
const capture=buildNbaAnalysisCapture(input);
assert.equal(capture.payload.strictPregameReplay,false);assert.equal(capture.payload.promotionEligible,false);
assert.equal(capture.revision,buildNbaAnalysisCapture({...input,generatedAt:'2026-10-07T01:01:00Z'}).revision);
assert.notEqual(capture.revision,buildNbaAnalysisCapture({...input,quote:{...input.quote,line:'221平'}}).revision);
assert.notEqual(capture.revision,buildNbaAnalysisCapture({...input,modelVersion:'synthetic-v2'}).revision);
for(const patch of [{status:'reference'},{league:'MLB'},{prediction:null},{game:{...input.game,status:'final'}}])assert.throws(()=>buildNbaAnalysisCapture({...input,...patch}));
let saved=null, writes=0;
const db=async(strings,...values)=>{const sql=strings.join('?');if(sql.includes('INSERT INTO')){
 assert.match(sql,/WHERE NOW\(\) </);assert.match(sql,/ON CONFLICT \(revision\) DO NOTHING/);
 if(saved)return[];writes++;saved={revision:values[0],captured_at:'2026-10-07T01:00:01Z'};return[saved];
}return saved?[saved]:[];};
assert.equal((await saveNbaAnalysisCapture(input,{db,prepareSchema:false})).inserted,true);
assert.equal((await saveNbaAnalysisCapture(input,{db,prepareSchema:false})).inserted,false);assert.equal(writes,1);
assert.equal((await saveNbaAnalysisCapture(input,{db:async()=>[],prepareSchema:false})).status,'capture_window_closed');
await assert.rejects(saveNbaAnalysisCapture(input,{db:async()=>{throw Error('offline');},prepareSchema:false}),/offline/);
console.log('NBA forward capture PASS: immutable server prediction/quotes, version-sensitive hash, database tipoff guard, idempotent durable receipt and honest incomplete PIT status');
