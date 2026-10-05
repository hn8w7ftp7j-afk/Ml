import assert from 'node:assert/strict';
import { normalizeNbaManualBetRecord } from '../lib/nba/manual-bet-record.js';
import { archiveNbaManualBetRecord, changeNbaManualBetRecordStatus } from '../lib/nba/manual-bet-store.js';
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

let ticket = { ...first.record, id: '11111111-1111-4111-8111-111111111111' };
const statusDb = async (strings,...values) => {
  const statement = strings.join('?');
  if (statement.includes('UPDATE')) {
    const [patch,events,id,previous] = values;
    if (id !== ticket.id || (ticket.status || 'OPEN') !== previous) return [];
    ticket = {...ticket,...JSON.parse(patch),recordHistory:[...(ticket.recordHistory||[]),...JSON.parse(events)]};
    return [{payload:structuredClone(ticket)}];
  }
  return values[0] === ticket.id ? [{payload:structuredClone(ticket)}] : [];
};
const original = structuredClone(ticket);
const opts = {db:statusDb,prepareSchema:false,now:Date.parse('2026-10-05T20:25:00Z')};
const cancelled = await changeNbaManualBetRecordStatus(ticket.id,'cancel',opts);
assert.equal(cancelled.record.status,'CANCELLED'); assert.equal(cancelled.persistence,'durable_database');
for (const field of ['line','stake','water','recordedAt','side','marketKey']) assert.deepEqual(cancelled.record[field],original[field]);
const retry = await changeNbaManualBetRecordStatus(ticket.id,'cancel',{...opts,now:opts.now+5000});
assert.equal(retry.changed,false); assert.equal(retry.record.recordHistory.length,1); assert.equal(retry.record.cancelledAt,cancelled.record.cancelledAt);
const restored = await changeNbaManualBetRecordStatus(ticket.id,'restore',opts);
assert.equal(restored.record.status,'OPEN'); assert.equal(restored.record.recordHistory.length,2); assert.equal(restored.record.stake,10000);
await assert.rejects(changeNbaManualBetRecordStatus('bad','cancel',opts),/識別/);
await assert.rejects(changeNbaManualBetRecordStatus('22222222-2222-4222-8222-222222222222','cancel',opts),/不存在/);
await assert.rejects(changeNbaManualBetRecordStatus(ticket.id,'cancel',{...opts,db:async()=>{throw Error('offline');}}),/offline/);
console.log('NBA cancellation PASS: atomic state, immutable contract, old status default, duplicate cancellation, reversible archive and no transaction execution');
