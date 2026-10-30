import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { durableDatabaseUrl } from '../database-url.js';
import { soccerLeague,validSoccerDate } from './contracts.js';
import { soccerRecordKey,soccerManualRecordFromSnapshot } from './manual-record.js';
import { soccerManualContractHash,soccerOriginalContract } from './manual-settlement.js';
let client,ready;
const failure=(message,status=400)=>Object.assign(Error(message),{status});
async function database(){
  if(!durableDatabaseUrl())throw failure('永久帳本尚未連線。',503);
  client||=neon(durableDatabaseUrl());
  ready||=(async()=>{await client.query(`CREATE TABLE IF NOT EXISTS sports_soccer_manual_records_v1 (
    position_key text PRIMARY KEY,id text NOT NULL UNIQUE,league text NOT NULL,board_date date NOT NULL,
    payload jsonb NOT NULL,recorded_at timestamptz NOT NULL DEFAULT now())`);
    await client.query(`CREATE TABLE IF NOT EXISTS sports_soccer_settlement_events_v1 (
      event_id text PRIMARY KEY,record_id text NOT NULL REFERENCES sports_soccer_manual_records_v1(id),
      league text NOT NULL,board_date date NOT NULL,event_type text NOT NULL CHECK(event_type IN ('RESULT_CHECK','SETTLEMENT')),
      payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now())`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS sports_soccer_one_settlement_v1
      ON sports_soccer_settlement_events_v1(record_id) WHERE event_type='SETTLEMENT'`);
    await client.query(`CREATE INDEX IF NOT EXISTS sports_soccer_settlement_record_check_v1
      ON sports_soccer_settlement_events_v1(record_id,event_type,created_at DESC)`);
  })().catch(e=>{ready=null;throw e;});
  await ready;return client;
}
function scope(league,date){if(!['epl','ucl'].includes(league)||!soccerLeague(league)||!validSoccerDate(date))throw failure('聯盟或日期不正確。');}
export async function listSoccerManualRecords(league,date,{db=null,through=date}={}){
  scope(league,date);scope(league,through);if(through<date||Date.parse(through)-Date.parse(date)>14*86400000)throw failure('日期範圍不正確。');db||=await database();
  const rows=await db.query(`SELECT r.payload,s.payload AS settlement,c.payload AS settlement_check
    FROM sports_soccer_manual_records_v1 r
    LEFT JOIN sports_soccer_settlement_events_v1 s ON s.record_id=r.id AND s.event_type='SETTLEMENT'
    LEFT JOIN LATERAL (SELECT payload FROM sports_soccer_settlement_events_v1 WHERE record_id=r.id AND event_type='RESULT_CHECK' ORDER BY created_at DESC,event_id DESC LIMIT 1) c ON true
    WHERE r.league=$1 AND r.board_date BETWEEN $2::date AND $3::date ORDER BY r.recorded_at DESC`,[league,date,through]);
  return rows.map(r=>({...r.payload,...(r.settlement?{settlement:r.settlement,settlementStatus:'SETTLED'}:{}),...(r.settlement_check?{settlementCheck:r.settlement_check}:{})}));
}

export async function listUnsettledSoccerManualRecords({league=null,date=null,limit=100,db=null}={}){
  if(league!==null&&!['epl','ucl'].includes(league)||date!==null&&!validSoccerDate(date)||!Number.isInteger(limit)||limit<1||limit>500)throw failure('結算查詢範圍不正確。');
  db||=await database();
  const rows=await db.query(`SELECT r.payload FROM sports_soccer_manual_records_v1 r
    WHERE r.league IN ('epl','ucl') AND ($1::text IS NULL OR r.league=$1) AND ($2::date IS NULL OR r.board_date=$2::date)
      AND r.payload->>'status'='OPEN' AND NOT EXISTS(SELECT 1 FROM sports_soccer_settlement_events_v1 s WHERE s.record_id=r.id AND s.event_type='SETTLEMENT')
    ORDER BY r.board_date,r.recorded_at LIMIT $3`,[league,date,limit]);
  return rows.map(r=>r.payload);
}

// Append-only evidence: a cancellation never erases an already archived result.
// The INSERT is conditional on the same immutable original contract and OPEN
// state, so a concurrent cancellation cannot acquire a new settlement afterward.
export async function archiveSoccerSettlementCheck(record,check,{db=null,now=Date.now()}={}){
  scope(record?.league,record?.date);
  if(!record.id||!['PENDING','SETTLED'].includes(check?.status)||check.contractHash!==soccerManualContractHash(record))throw failure('結算原始契約識別不一致。');
  if(check.status==='SETTLED'&&(!Number.isFinite(check.profit)||check.stake!==record.stake||!check.contractVersion||!check.resultHash))throw failure('結算證據不完整。');
  db||=await database();
  const eventType=check.status==='SETTLED'?'SETTLEMENT':'RESULT_CHECK';
  const eventId=createHash('sha256').update(JSON.stringify([record.id,eventType,check.contractHash,check.reason||'',check.resultHash||'',check.contractVersion||''])).digest('hex');
  const payload={...check,checkedAt:new Date(now).toISOString()};
  const inserted=await db.query(`INSERT INTO sports_soccer_settlement_events_v1(event_id,record_id,league,board_date,event_type,payload)
    SELECT $1,r.id,r.league,r.board_date,$5,$6::jsonb FROM sports_soccer_manual_records_v1 r
    WHERE r.id=$2 AND r.league=$3 AND r.board_date=$4::date AND r.payload->>'status'='OPEN' AND r.payload @> $7::jsonb
    FOR UPDATE OF r
    ON CONFLICT DO NOTHING RETURNING payload`,[eventId,record.id,record.league,record.date,eventType,JSON.stringify(payload),JSON.stringify(soccerOriginalContract(record))]);
  const rows=inserted.length?inserted:await db.query(`SELECT payload FROM sports_soccer_settlement_events_v1 WHERE record_id=$1 AND event_type=$2
    ${eventType==='SETTLEMENT'?'':'AND event_id=$3'} ORDER BY created_at DESC LIMIT 1`,eventType==='SETTLEMENT'?[record.id,eventType]:[record.id,eventType,eventId]);
  return{created:inserted.length===1,check:rows[0]?.payload||null,persistence:'durable_database'};
}
export async function archiveSoccerManualRecord(snapshot,quoteKey,{db=null,id=randomUUID(),now=Date.now()}={}){
  const record=soccerManualRecordFromSnapshot(snapshot,quoteKey,{now}),position=soccerRecordKey(record);
  const payload={...record,id,status:'OPEN',recordedAt:new Date(now).toISOString()};db||=await database();
  const inserted=await db.query(`INSERT INTO sports_soccer_manual_records_v1(position_key,id,league,board_date,payload)
    VALUES($1,$2,$3,$4::date,$5::jsonb) ON CONFLICT(position_key) DO NOTHING RETURNING payload`,[position,id,record.league,record.date,JSON.stringify(payload)]);
  const rows=inserted.length?inserted:await db.query('SELECT payload FROM sports_soccer_manual_records_v1 WHERE position_key=$1',[position]);
  if(!rows[0]?.payload?.id)throw failure('未取得永久保存確認。',503);
  return{record:rows[0].payload,persistence:'durable_database'};
}
export async function changeSoccerManualRecordStatus(league,date,id,action,{db=null,now=Date.now()}={}){
  scope(league,date);
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id||'')||!['cancel','restore'].includes(action))throw failure('紀錄操作不正確。');
  db||=await database();const status=action==='cancel'?'CANCELLED':'OPEN',prior=action==='cancel'?'OPEN':'CANCELLED',at=new Date(now).toISOString();
  const rows=await db.query(`UPDATE sports_soccer_manual_records_v1
    SET payload=payload||$1::jsonb||jsonb_build_object('history',COALESCE(payload->'history','[]'::jsonb)||$2::jsonb)
    WHERE id=$3 AND league=$4 AND board_date=$5::date AND payload->>'status'=$6 RETURNING payload`,
    [JSON.stringify({status,updatedAt:at}),JSON.stringify([{action,at}]),id,league,date,prior]);
  const saved=rows.length?rows:await db.query('SELECT payload FROM sports_soccer_manual_records_v1 WHERE id=$1 AND league=$2 AND board_date=$3::date',[id,league,date]);
  if(!saved[0]?.payload||saved[0].payload.status!==status)throw failure('紀錄不存在或狀態已改變。');
  return{record:saved[0].payload,persistence:'durable_database'};
}
