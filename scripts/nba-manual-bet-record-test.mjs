import assert from 'node:assert/strict';
import { normalizeNbaManualBetRecord } from '../lib/nba/manual-bet-record.js';
import { archiveNbaManualBetRecord } from '../lib/nba/manual-bet-store.js';
const input = { alreadyPlaced: true, gameId: 'nba:espn:game:401999001', date: '2026-10-06', marketKey: 'fullTotal', side: 'over', line: '216.5', water: .94, stake: 10000, away: '客隊', home: '主隊', startTime: '2026-10-05T23:00:00Z', executable: true, formalEligible: true, score: 8.9, settlementStatus: 'WIN' };
const record = normalizeNbaManualBetRecord(input);
assert.equal(record.executable, false); assert.equal(record.formalEligible, false);
assert.equal(record.calibrationEligible, false); assert.equal(record.settlementStatus, 'NOT_SETTLED');
assert.equal(record.evidenceStatus, 'MANUAL_UNVERIFIED'); assert.ok(!('score' in record));
for (const patch of [{alreadyPlaced:false}, {date:'2026-02-30'}, {gameId:'mlb:1'}, {side:'home'}, {marketKey:'moneyline'}, {line:'216+120'}, {water:NaN}, {stake:0}, {stake:1.001}, {stake:9999}]) {
  assert.throws(() => normalizeNbaManualBetRecord({...input,...patch}));
}
assert.throws(() => normalizeNbaManualBetRecord({...input,marketKey:'fullRunline',side:'home',line:'4+25'}));
assert.equal(normalizeNbaManualBetRecord({...input,marketKey:'fullRunline',side:'home',line:'4+25',lineSide:'away'}).lineSide, 'away');
const stored = new Map();
const db = async (strings,...values) => {
  const statement=strings.join('?');
  if (statement.includes('INSERT INTO')) {
    if(stored.has(values[0])) return [];
    const payload=JSON.parse(values[3]); stored.set(values[0],payload); return [{payload}];
  }
  return stored.has(values[0]) ? [{payload:stored.get(values[0])}] : [];
};
const first = await archiveNbaManualBetRecord(input,{db,prepareSchema:false,id:'first',now:Date.parse('2026-10-05T20:10:00Z')});
assert.equal(first.created,true); assert.equal(first.persistence,'durable_database');
const repeated = await archiveNbaManualBetRecord({...input,water:1.01,line:'220平',stake:10000},{db,prepareSchema:false,id:'second'});
assert.equal(repeated.created,false); assert.deepEqual(repeated.record,first.record);
assert.equal(repeated.record.line,'216.5'); assert.equal(stored.size,1);
await assert.rejects(archiveNbaManualBetRecord(input,{db:async()=>{throw Error('database down');},prepareSchema:false}), /database down/);
await assert.rejects(archiveNbaManualBetRecord(input,{db:async()=>[],prepareSchema:false}), /永久保存確認/);
console.log('NBA manual archive PASS: explicit already-placed confirmation, immutable actual contract, durable acknowledgement, duplicate replay and no execution/eligibility/settlement claims');
