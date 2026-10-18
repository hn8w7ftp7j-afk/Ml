import { randomUUID } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { durableDatabaseUrl } from '../database-url.js';
import { soccerLeague,validSoccerDate } from './contracts.js';
import { soccerRecordKey,soccerManualRecordFromSnapshot } from './manual-record.js';
let client,ready;
const failure=(message,status=400)=>Object.assign(Error(message),{status});
async function database(){
  if(!durableDatabaseUrl())throw failure('永久帳本尚未連線。',503);
  client||=neon(durableDatabaseUrl());
  ready||=Promise.resolve(client.query(`CREATE TABLE IF NOT EXISTS sports_soccer_manual_records_v1 (
    position_key text PRIMARY KEY,id text NOT NULL UNIQUE,league text NOT NULL,board_date date NOT NULL,
    payload jsonb NOT NULL,recorded_at timestamptz NOT NULL DEFAULT now())`)).catch(e=>{ready=null;throw e;});
  await ready;return client;
}
function scope(league,date){if(!['epl','ucl'].includes(league)||!soccerLeague(league)||!validSoccerDate(date))throw failure('聯盟或日期不正確。');}
export async function listSoccerManualRecords(league,date,{db=null,through=date}={}){
  scope(league,date);scope(league,through);if(through<date||Date.parse(through)-Date.parse(date)>14*86400000)throw failure('日期範圍不正確。');db||=await database();
  const rows=await db.query('SELECT payload FROM sports_soccer_manual_records_v1 WHERE league=$1 AND board_date BETWEEN $2::date AND $3::date ORDER BY recorded_at DESC',[league,date,through]);
  return rows.map(r=>r.payload);
}
export async function archiveSoccerManualRecord(snapshot,quoteKey,{db=null,id=randomUUID(),now=Date.now()}={}){
  const record=soccerManualRecordFromSnapshot(snapshot,quoteKey),position=soccerRecordKey(record);
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
