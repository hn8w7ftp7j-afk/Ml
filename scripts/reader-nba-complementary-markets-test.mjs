// Synthetic responsive clones execute the real normalizer, parser, authority,
// NBA intake, and immutable PostgreSQL history. No live odds are invented.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { parseTai888Capture, canonicalReaderPayload, readerMarketProperties } from '../reader/parser.js';
import { selectAuthoritativeBoard } from '../reader/board-selector.js';
import { normalizeNbaReaderPayload } from '../lib/nba/reader.js';
import { recordMarketLineHistory } from '../lib/market-line-history-v1.js';

const now=new Date('2026-11-08T00:58:16.127Z'), deviceId='complementary-nba-isolated-fixture';
const version=JSON.parse(readFileSync('reader/manifest.json','utf8')).version;
const headers=['時間','主客隊伍','讓分','大小盤','獨贏','一輸二贏','上半讓分','上半大小'];
const marketIndexes=[2,3,6,7], keys=readerMarketProperties('NBA'), cell=pair=>({pair,lines:pair.filter(Boolean)});
const complete={marketLocked:false,cells:[cell(['11-08','09:05']),cell(['WSH-巫師','OKC-雷霆[主]']),
  cell(['0.950','12.5 0.950']),cell(['224.5 大 0.940','小 0.940']),cell([]),cell([]),
  cell(['0.940','8+75 0.940']),cell(['115平 大 0.930','小 0.930'])]};
const clone=x=>structuredClone(x);
const subset=keep=>{const row=clone(complete);for(const index of marketIndexes)if(!keep.includes(index))row.cells[index]=cell([]);return row;};
const capture=rows=>({version:'TAI888-DOM-CAPTURE-v2.2.0',league:'NBA',sourceHost:'tai888.in',
  pageUrl:'https://tai888.in/newapp/#/BS',observedAt:now.toISOString(),tables:[{headers,rows}],
  diagnostics:{gameCount:rows.length,expectedGameCount:1,lastMutationAt:now.toISOString()}});
const candidate=c=>({tabId:1,frameId:0,capture:c,parsed:parseTai888Capture(c,now)});
const expected=parseTai888Capture(capture([complete]),now).games[0];
const sources=[];
for(const groups of [[[2,3],[6,7]],[[2,3,6],[7]],[[2,3],[3,6,7]],[[2],[3],[6],[7]]]){
  for(const reverse of [false,true]){
    const rows=groups.map(subset);if(reverse)rows.reverse();
    const c=capture(rows), before=JSON.stringify(c), parsed=parseTai888Capture(c,now);
    assert.deepEqual(parsed.parseIssues,[]);
    assert.equal(parsed.games.length,1);
    for(const key of keys)assert.deepEqual(parsed.games[0][key],expected[key]);
    assert.deepEqual(parsed.games[0].marketStates,expected.marketStates);
    assert.equal(JSON.stringify(c),before,'input source cells are never mutated');
    assert.equal(selectAuthoritativeBoard([candidate(c)],{league:'NBA',now:+now}).ok,true);
    sources.push(c);
  }
}
// Any overlapping changed price still blocks the whole captured board.
for(const reverse of [false,true]){
  const a=subset([2,3]),b=subset([3,6,7]);b.cells[3]=cell(['225平 大 0.940','小 0.940']);
  const c=capture(reverse?[b,a]:[a,b]);
  assert.equal(selectAuthoritativeBoard([candidate(c)],{league:'NBA',now:+now}).ok,false);
}
// Malformed text is not an absent slot, and an explicit lock must not be
// overwritten by the quote union. Existing rejection remains fail closed.
const malformed=subset([2,3]);malformed.cells[6]=cell(['unreadable','0.940']);
assert.ok(parseTai888Capture(capture([malformed,subset([6,7])]),now).parseIssues.length);
const locked=subset([2,3]);locked.marketLocked=true;
assert.ok(parseTai888Capture(capture([locked,subset([6,7])]),now).parseIssues.length);
// Both quotes may be null while only one clone contains rejected text.
// UNAVAILABLE on the other clone must never hide that BLOCKED source state,
// in either row order, with or without an additional complementary market.
for(const additional of [false,true])for(const reverse of [false,true]){
  const empty=subset([2,3]),blocked=subset(additional?[2,3,7]:[2,3]);
  blocked.cells[6]=cell(['unreadable','0.940']);
  const c=capture(reverse?[blocked,empty]:[empty,blocked]);
  const parsed=parseTai888Capture(c,now);
  assert.ok(parsed.parseIssues.some(issue=>issue.startsWith('conflicting-duplicate:')),
    'a both-null BLOCKED/UNAVAILABLE duplicate cannot disappear behind price equality or richness');
  assert.equal(selectAuthoritativeBoard([candidate(c)],{league:'NBA',now:+now}).ok,false);
}
const otherTab={...candidate(capture([subset([6,7])])),tabId:2};
assert.equal(selectAuthoritativeBoard([candidate(capture([subset([2,3])])),otherTab],{league:'NBA',now:+now}).ok,false,
  'two distinct source tabs cannot be stitched into a live authority');

const context=vm.createContext({});
for(const name of ['league-registry.js','row-normalizer.js'])vm.runInContext(readFileSync(`reader/${name}`,'utf8'),context);
const normalizer=context.Tai888RowNormalizer;
function record(order,values){const top=order*40;return {order,top,bottom:top+30,text:values.flatMap(x=>x).filter(Boolean).join(' '),
 cells:values.map((values,index)=>({text:values.join(' '),lines:values,
 rows:values.map((text,row)=>({text,top:top+row*18,left:index*100})),left:index*100,right:index*100+95})).filter(c=>c.text)};}
for(const reverse of [false,true]){
  const parts=[subset([2,3]),subset([6,7])];if(reverse)parts.reverse();
  const records=[record(0,headers.map(x=>[x])),record(1,[['聯盟：NBA 美國職業籃球(1)']]),
    ...parts.map((row,index)=>record(index+2,row.cells.map(c=>c.pair)))];
  const normalized=normalizer.normalizeRowRecords(records,{expectedLeague:'NBA'});
  assert.equal(normalized.diagnostics.conflictingGameKeys.length,0);
  assert.equal(normalized.diagnostics.gameCount,1);
  const parsed=parseTai888Capture({...capture([]),tables:normalized.tables,diagnostics:normalized.diagnostics},now);
  assert.deepEqual(parsed.parseIssues,[]);
  assert.equal(parsed.games.length,1);
  for(const key of keys)assert.deepEqual(parsed.games[0][key],expected[key]);
  sources.push({...capture([]),tables:normalized.tables,diagnostics:normalized.diagnostics});
}
// Another standard section may expose a different contract; it is still
// checked independently by the parser before any union can be accepted.
const conflictRecords=[record(0,headers.map(x=>[x])),record(1,[['聯盟：NBA 美國職業籃球(1)']]),record(2,complete.cells.map(c=>c.pair)),
 record(3,[['聯盟：NBA 美國職業籃球(1)']]),record(4,complete.cells.map((c,index)=>index===7?['116平 大 0.930','小 0.930']:c.pair))];
const conflictNormalized=normalizer.normalizeRowRecords(conflictRecords,{expectedLeague:'NBA'});
assert.ok(parseTai888Capture({...capture([]),tables:conflictNormalized.tables,diagnostics:conflictNormalized.diagnostics},now).parseIssues.length);

const db=new PGlite();
const sql=(strings,...params)=>{const query=strings.reduce((s,p,i)=>s+(i?`$${i}`:'')+p,'');
 return {query,params,then:(resolve,reject)=>db.query(query,params).then(x=>x.rows).then(resolve,reject)};};
sql.transaction=queries=>db.transaction(async tx=>{const output=[];for(const q of queries)output.push((await tx.query(q.query,q.params)).rows);return output;});
try{
  for(const c of sources){
    const parsed=parseTai888Capture(c,now), payload={...parsed,readerVersion:version,deviceId,
      pageActivityAt:now.toISOString(),expectedGameCount:1,detectedGameCount:1};
    payload.payloadHash=createHash('sha256').update(canonicalReaderPayload(payload)).digest('hex');
    const snapshot=normalizeNbaReaderPayload(payload,{now:+now,deviceId,headerVersion:version});
    assert.equal(snapshot.marketCount,4,'all original four markets survive independent server reparse');
    const receipt=await recordMarketLineHistory(snapshot,{sql});assert.equal(receipt.failed,0);
  }
  const rows=(await db.query('SELECT markets FROM tai888_market_line_history_v1')).rows;
  assert.equal(rows.length,1,'equivalent same-time source observations remain idempotent');
  assert.deepEqual(JSON.parse(rows[0].markets),[[1,'12.5',.95,.95],['224.5',.94,.94],[1,'8+75',.94,.94],['115平',.93,.93]]);
}finally{await db.close();}
console.log('PASS same-capture NBA complementary market preservation: normalized visual clones → parser → authority → independent NBA intake → isolated PostgreSQL full/half history; changed quotes, malformed content, locks and cross-tab stitching fail closed. Live desktop NOT VERIFIED.');
