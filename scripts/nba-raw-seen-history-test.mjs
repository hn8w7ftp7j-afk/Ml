import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {buildReaderSeenCapture,canonicalReaderSeenCapture} from '../lib/reader-seen-capture.js';
import {deriveNbaRawSeenHistory,reassembleNbaRawSeenBatch,parseNbaRawHistoryQuery} from '../lib/nba/raw-seen-history.js';
const parts=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/nba/nba-seen-pregame-20261108.json.gz',import.meta.url))));
const before=JSON.stringify(parts),clock=Date.parse('2026-11-09T00:00:00Z');
const restored=reassembleNbaRawSeenBatch(parts),result=deriveNbaRawSeenHistory(parts,{now:clock});
assert.equal(restored.batchHash,'54f5045ac7c6f688cd870523e9f42fe3a0e89f5f614cb3fca95610236e77d305');
assert.equal(restored.evidence.tables.length,228);assert.equal(result.games.length,5);
assert.equal(result.observedAt,'2026-11-08T00:58:16.127Z');
assert.equal(result.historicalAvailabilityVerified,false);assert.equal(result.currentBoardUpdated,false);assert.equal(result.executable,false);
assert.equal(result.coverageComplete,false);assert.equal(result.closingCoverage,'NOT_VERIFIED');
assert.ok(result.games.every(g=>g.markets.length===4&&g.identityStatus==='ORIGINAL_BOARD_IDENTITY_ONLY'&&g.markets.every(m=>m.unit==='POINTS'&&!m.executable)));
const was=result.games.find(g=>g.awayKey==='WSH'),ny=result.games.find(g=>g.awayKey==='NY');
assert.deepEqual(was.markets.filter(m=>m.period==='HT').map(m=>[m.kind,m.line,m.lineSide??null]),[['HANDICAP','8+75','home'],['TOTAL','115平',null]]);
assert.deepEqual(ny.markets.filter(m=>m.period==='HT').map(m=>[m.kind,m.line,m.lineSide??null]),[['HANDICAP','2.5','away'],['TOTAL','114平',null]]);
assert.deepEqual(was.markets[2].source.originalCell,['0.940','8+75','0.940']);
assert.equal(was.markets[2].source.columnIndex,5);assert.equal(ny.markets[2].source.columnIndex,6);
assert.equal(was.markets[3].overWater,.93);assert.equal(ny.markets[2].awayWater,.94);
assert.equal(deriveNbaRawSeenHistory([...parts].reverse(),{now:clock+60000}).derivedHash,result.derivedHash);
assert.equal(JSON.stringify(parts),before,'recovery never rewrites original fragments');
assert.throws(()=>deriveNbaRawSeenHistory(parts.slice(1)),e=>e.code==='RAW_SEEN_RECOVERY_INCOMPLETE');
const corrupt=structuredClone(parts);corrupt[0].evidence.tables[11].rows[2].cells[0].pair[0]='changed';
assert.throws(()=>deriveNbaRawSeenHistory(corrupt),e=>/HASH_MISMATCH|ID_MISMATCH/.test(e.code));
assert.throws(()=>deriveNbaRawSeenHistory(Array(9).fill(parts[0])),e=>e.status===413);
for(const query of ['', 'captureId=bad', `captureId=${parts[0].captureId}&league=NBA`,`captureId=${parts[0].captureId}&captureId=${parts[0].captureId}`])assert.throws(()=>parseNbaRawHistoryQuery(new URLSearchParams(query)),e=>e.status===400);
const base=restored.evidence.tables.find(t=>t.rows.some(r=>r.cells.length===8&&r.cells[1]?.pair?.[0]==='WAS 巫師'));
const primary=base.rows.find(r=>r.cells.length===8&&r.cells[1]?.pair?.[0]==='WAS 巫師');
function synthetic(change=()=>{}){
 const evidence={...structuredClone(restored.evidence),tables:[{...structuredClone(base),rows:[structuredClone(primary)]}]};change(evidence);
 const b=buildReaderSeenCapture({schema:'READER-SEEN-CAPTURE-v1',evidence},{deviceId:'isolated-fixture',headerVersion:evidence.readerVersion});
 return [{...b,league:evidence.league,readerVersion:evidence.readerVersion,observedAt:evidence.observedAt,captureBatchId:null,partIndex:null,partCount:null,receivedAt:parts[0].receivedAt,persistedAt:parts[0].persistedAt}];
}
assert.equal(deriveNbaRawSeenHistory(synthetic()).games[0].markets.length,4);
// Invalid or unavailable neighbors do not discard independently verified markets.
const partial=deriveNbaRawSeenHistory(synthetic(e=>{e.tables[0].rows[0].cells[2].pair=['bad'];}));
assert.equal(partial.games[0].markets.length,3);assert.equal(partial.diagnostics.unrecognizedMarkets,1);
assert.throws(()=>deriveNbaRawSeenHistory(synthetic(e=>{e.league='MLB';})),e=>e.code==='RAW_SEEN_RECOVERY_LEAGUE_INVALID');
for(const mutate of [
 e=>{e.tables[0].sectionTitle='聯盟: NBA 美國職業籃球-第一節(5)';},
 e=>{e.tables[0].sectionTitle='聯盟: NBA 美國職業籃球-主隊總得分(5)';},
 e=>{e.tables[0].headers[6]='下半讓球';},
 e=>{e.tables[0].periodEvidenceTruncated=true;},
 e=>{e.tables[0].rows[0].marketLocked=true;},
 e=>{e.tables[0].rows[0].cells[1].pair[0]='KIA 起亞老虎';},
 e=>{e.tables[0].rows[0].cells[1].pair[0]='OKC 雷霆[主]';},
 e=>{e.tables[0].rows[0].cells[4].pair=['單','0.930'];},
 e=>{e.tables[0].rows.unshift({cells:[{pair:['聯盟: NBA 美國職業籃球-第一節(5)']}]});},
])assert.throws(()=>deriveNbaRawSeenHistory(synthetic(mutate)),e=>['RAW_SEEN_RECOVERY_NO_MARKETS','RAW_SEEN_RECOVERY_UNSUPPORTED_FORMAT'].includes(e.code));
// A changed fragment batch ID cannot satisfy the original whole-board hash.
const changed=structuredClone(parts);for(const p of changed){p.captureBatchId=p.evidence.captureBatchId='a'.repeat(64);const b=buildReaderSeenCapture({schema:'READER-SEEN-CAPTURE-v1',evidence:p.evidence},{deviceId:'isolated-fixture',headerVersion:p.readerVersion});p.captureId=b.captureId;p.evidenceHash=b.evidenceHash;}
assert.throws(()=>deriveNbaRawSeenHistory(changed),e=>e.code==='RAW_SEEN_RECOVERY_HASH_MISMATCH');
const ui=readFileSync(new URL('../app/market-line-history/raw-seen-replay.js',import.meta.url),'utf8');
assert.match(ui,/nba-raw-seen-history-v1/);assert.match(ui,/POINTS/);assert.match(ui,/capture\.league === 'NBA' \? 'nba' : 'soccer'/);
assert.match(readFileSync(new URL('../app/market-line-history/seen-capture-panel.js',import.meta.url),'utf8'),/\['EPL', 'UCL', 'NBA'\]\.includes\(row\.league\)/);
console.log('NBA raw seen Production fixture recovery PASS: 5 games, 20 markets; half-game gaps recoverable; immutable hashes, scope, lock, corruption, league and UI contracts checked');
const {seenCaptureTaipeiUntil,seenCaptureQueryUrl}=await import('../app/market-line-history/seen-capture-view.js');
const oldTZ=process.env.TZ;
try{for(const tz of ['UTC','Asia/Taipei','America/New_York']){process.env.TZ=tz;assert.equal(seenCaptureTaipeiUntil('2026-11-08T08:59',{now:clock}),'2026-11-08T00:59:00.000Z');}}finally{if(oldTZ===undefined)delete process.env.TZ;else process.env.TZ=oldTZ;}
assert.equal(seenCaptureTaipeiUntil(''), '');
for(const value of ['2026-02-30T10:00','2026-13-08T08:59','bad','2026-11-08T25:00','2026-11-10T08:59'])assert.throws(()=>seenCaptureTaipeiUntil(value,{now:clock}));
assert.match(seenCaptureQueryUrl({league:'NBA',until:'2026-11-08T00:59:00.000Z'}),/until=2026-11-08T00%3A59%3A00.000Z/);
const wrongHalfHeader={cells:['時間','主客隊伍','讓球','大小盤','單雙','獨贏','下半讓球','下半大小','下半單雙'].map(v=>({pair:[v]}))};
assert.throws(()=>deriveNbaRawSeenHistory(synthetic(e=>{e.tables[0].rows.unshift(wrongHalfHeader);})),e=>e.code==='RAW_SEEN_RECOVERY_NO_MARKETS','new row headers revoke old table period authority');
assert.throws(()=>deriveNbaRawSeenHistory(synthetic(e=>{e.tables[0].rows.unshift({cells:[{pair:['下半場']}]});})),e=>e.code==='RAW_SEEN_RECOVERY_NO_MARKETS');
const restoredHeader=deriveNbaRawSeenHistory(synthetic(e=>{e.tables[0].rows.unshift(wrongHalfHeader,{cells:e.tables[0].headers.map(v=>({pair:[v]}))});}));
assert.equal(restoredHeader.games[0].markets.length,4,'an exact later standard header can restore column authority');

// Exact nine-column rows retain fixed source positions when optional single/
// double or moneyline quotes are absent, locked or malformed. Do not borrow
// this rule for eight-column rows whose missing slot still needs both anchors.
const nineRow=base.rows.find(r=>r.cells.length===9&&r.cells[1]?.pair?.[0]==='NYK 尼克');
assert.ok(nineRow);
for(const column of [4,5,8])for(const unavailable of [[],['-'],['封盤'],['malformed','0.900']]){
  const retained=deriveNbaRawSeenHistory(synthetic(e=>{e.tables[0].rows=[structuredClone(nineRow)];e.tables[0].rows[0].cells[column].pair=unavailable;}));
  assert.equal(retained.games[0].markets.length,4,`nine cells: non-core column ${column} cannot erase core markets`);
  assert.deepEqual(retained.games[0].markets.map(m=>[m.period,m.kind,m.line]),ny.markets.map(m=>[m.period,m.kind,m.line]));
  assert.deepEqual(retained.games[0].markets.map(m=>m.source.columnIndex),[2,3,6,7]);
}
const nonCoreUnavailable=deriveNbaRawSeenHistory(synthetic(e=>{e.tables[0].rows=[structuredClone(nineRow)];for(const column of [4,5,8])e.tables[0].rows[0].cells[column].pair=['-'];}));
assert.equal(nonCoreUnavailable.games[0].markets.length,4);
const oneCoreUnavailable=deriveNbaRawSeenHistory(synthetic(e=>{e.tables[0].rows=[structuredClone(nineRow)];for(const column of [4,5,6,8])e.tables[0].rows[0].cells[column].pair=['-'];}));
assert.equal(oneCoreUnavailable.games[0].markets.length,3,'each core market still requires its own price proof');
assert.equal(oneCoreUnavailable.diagnostics.unrecognizedMarkets,1);
for(const column of [4,7])assert.throws(()=>deriveNbaRawSeenHistory(synthetic(e=>{e.tables[0].rows[0].cells[column].pair=['-'];})),e=>e.code==='RAW_SEEN_RECOVERY_NO_MARKETS',`eight cells: missing anchor ${column} remains ambiguous`);
