import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { neon } from '@neondatabase/serverless';
import { durableDatabaseUrl } from '../database-url.js';
import { soccerLeague,validSoccerDate } from './contracts.js';
import { soccerRecordKey,soccerManualRecordFromSnapshot } from './manual-record.js';
import { soccerManualSettlementIdentityVerified } from './manual-settlement-identity.js';
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
    await client.query(`CREATE TABLE IF NOT EXISTS sports_soccer_account_settlement_revisions_v1 (
      record_id text PRIMARY KEY REFERENCES sports_soccer_manual_records_v1(id), revision integer NOT NULL DEFAULT 0)`);
    await client.query(`CREATE TABLE IF NOT EXISTS sports_soccer_account_settlement_amendments_v1 (
      record_id text NOT NULL REFERENCES sports_soccer_manual_records_v1(id), revision integer NOT NULL,
      payload jsonb NOT NULL, PRIMARY KEY(record_id,revision))`);
    await client.query(`CREATE OR REPLACE FUNCTION sports_soccer_settlement_immutable_v1() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'soccer settlement history is append-only'; END $$`);
    await client.query(`CREATE OR REPLACE TRIGGER sports_soccer_settlement_immutable_v1 BEFORE UPDATE OR DELETE ON sports_soccer_settlement_events_v1
      FOR EACH ROW EXECUTE FUNCTION sports_soccer_settlement_immutable_v1()`);
    await client.query(`CREATE OR REPLACE TRIGGER sports_soccer_settlement_immutable_v1 BEFORE UPDATE OR DELETE ON sports_soccer_account_settlement_amendments_v1
      FOR EACH ROW EXECUTE FUNCTION sports_soccer_settlement_immutable_v1()`);
  })().catch(e=>{ready=null;throw e;});
  await ready;return client;
}
function scope(league,date){if(!['epl','ucl'].includes(league)||!soccerLeague(league)||!validSoccerDate(date))throw failure('聯盟或日期不正確。');}
export async function listSoccerManualRecords(league,date,{db=null,through=date}={}){
  scope(league,date);scope(league,through);if(through<date||Date.parse(through)-Date.parse(date)>14*86400000)throw failure('日期範圍不正確。');db||=await database();
  const rows=await db.query(`SELECT r.payload,s.payload AS settlement,c.payload AS settlement_check,a.events AS amendments
    FROM sports_soccer_manual_records_v1 r
    LEFT JOIN sports_soccer_settlement_events_v1 s ON s.record_id=r.id AND s.event_type='SETTLEMENT'
    LEFT JOIN LATERAL (SELECT payload FROM sports_soccer_settlement_events_v1 WHERE record_id=r.id AND event_type='RESULT_CHECK' ORDER BY created_at DESC,event_id DESC LIMIT 1) c ON true
    LEFT JOIN LATERAL (SELECT jsonb_agg(payload ORDER BY revision) AS events FROM sports_soccer_account_settlement_amendments_v1 WHERE record_id=r.id) a ON true
    WHERE r.league=$1 AND r.board_date BETWEEN $2::date AND $3::date ORDER BY r.recorded_at DESC`,[league,date,through]);
  return rows.map(r=>{
    const amendments=r.amendments||[],selfReported=r.settlement?.source==='SELF_REPORTED_USER_CONFIRMED',latest=amendments.at(-1);
    const settlement=selfReported&&latest?.action==='REVOKE'?null:selfReported&&latest?.action==='CORRECT'?{...r.settlement,profit:latest.profit,settledAt:latest.recordedAt}:r.settlement;
    return {...r.payload,...(selfReported?{accountSettlement:{original:r.settlement,revision:latest?.revision||0,amendments},settlement,settlementStatus:settlement?'SETTLED':'UNVERIFIED'}:settlement?{settlement,settlementStatus:'SETTLED'}:{}),...(r.settlement_check?{settlementCheck:r.settlement_check}:{})};
  });
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
  // A serialized status/proof cannot authorize settlement. The exact record
  // must have been rechecked against its immutable original in this process.
  if(check.status==='SETTLED'&&!soccerManualSettlementIdentityVerified(record))throw failure('來源身分尚未核對，不能自動結算。');
  if(check.status==='SETTLED'&&(!Number.isFinite(check.profit)||check.stake!==record.stake||!check.contractVersion||!check.resultHash))throw failure('結算證據不完整。');
  db||=await database();
  const eventType=check.status==='SETTLED'?'SETTLEMENT':'RESULT_CHECK';
  const eventId=createHash('sha256').update(JSON.stringify([record.id,eventType,check.contractHash,check.reason||'',check.resultHash||'',check.contractVersion||''])).digest('hex');
  const payload={...check,checkedAt:new Date(now).toISOString()};
  const inserted=await db.query(`INSERT INTO sports_soccer_settlement_events_v1(event_id,record_id,league,board_date,event_type,payload)
    SELECT $1,r.id,r.league,r.board_date,$5,$6::jsonb FROM sports_soccer_manual_records_v1 r
    WHERE r.id=$2 AND r.league=$3 AND r.board_date=$4::date AND r.payload->>'status'='OPEN' AND r.payload @> $7::jsonb
      AND ($5<>'SETTLEMENT' OR r.payload->>'sourceIdentityStatus'='PROVIDER_SCOPED_UNIQUE_MATCH')
    FOR UPDATE OF r
    ON CONFLICT DO NOTHING RETURNING payload`,[eventId,record.id,record.league,record.date,eventType,JSON.stringify(payload),JSON.stringify(soccerOriginalContract(record))]);
  const rows=inserted.length?inserted:await db.query(`SELECT payload FROM sports_soccer_settlement_events_v1 WHERE record_id=$1 AND event_type=$2
    ${eventType==='SETTLEMENT'?'':'AND event_id=$3'} ORDER BY created_at DESC LIMIT 1`,eventType==='SETTLEMENT'?[record.id,eventType]:[record.id,eventType,eventId]);
  return{created:inserted.length===1,check:rows[0]?.payload||null,persistence:'durable_database'};
}
export async function archiveSoccerManualRecord(snapshot,quoteKey,{db=null,id=randomUUID(),now=Date.now(),identityUnverifiedAcknowledged=false}={}){
  const record=soccerManualRecordFromSnapshot(snapshot,quoteKey,{now,identityUnverifiedAcknowledged}),position=soccerRecordKey(record);
  const payload={...record,id,status:'OPEN',recordedAt:new Date(now).toISOString()};db||=await database();
  const inserted=await db.query(`INSERT INTO sports_soccer_manual_records_v1(position_key,id,league,board_date,payload)
    VALUES($1,$2,$3,$4::date,$5::jsonb) ON CONFLICT(position_key) DO NOTHING RETURNING payload`,[position,id,record.league,record.date,JSON.stringify(payload)]);
  const rows=inserted.length?inserted:await db.query('SELECT payload FROM sports_soccer_manual_records_v1 WHERE position_key=$1',[position]);
  if(!rows[0]?.payload?.id)throw failure('未取得永久保存確認。',503);
  return{record:rows[0].payload,persistence:'durable_database'};
}

// This is an account-holder declaration, never a verified result or rules
// contract. The amount is transcribed from their account, not calculated here.
export async function confirmSoccerAccountSettlement(league,date,id,{netProfit,rebateTreatment,confirmedAccountSettlement,confirmedFinalAmount,db=null,now=Date.now()}={}){
  scope(league,date);
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id||'')
    ||confirmedAccountSettlement!==true||confirmedFinalAmount!==true||rebateTreatment!=='INCLUDED'
    ||typeof netProfit!=='string'||!/^[-+]?\d+(?:\.\d{1,2})?$/.test(netProfit)||netProfit.length>32)throw failure('請確認帳戶實際損益及退水狀態。');
  let amount;try{amount=new Decimal(netProfit);}catch{throw failure('帳戶損益格式不正確。');}
  if(!amount.isFinite()||!amount.times(100).isInteger()||amount.times(100).abs().gt(Number.MAX_SAFE_INTEGER))throw failure('帳戶損益格式不正確。');
  db||=await database();
  const found=await db.query('SELECT payload FROM sports_soccer_manual_records_v1 WHERE id=$1 AND league=$2 AND board_date=$3::date',[id,league,date]);
  const record=found[0]?.payload;
  if(!record||record.status!=='OPEN')throw failure('紀錄不存在、已取消或不適用人工確認。',409);
  const check={status:'SETTLED',source:'SELF_REPORTED_USER_CONFIRMED',version:'SOCCER-ACCOUNT-SELF-REPORT-v1',
    contractHash:soccerManualContractHash(record),stake:record.stake,profit:amount.toNumber(),rebateTreatment,
    settledAt:new Date(now).toISOString(),formalEligible:false,calibrationEligible:false,executable:false};
  const eventId=createHash('sha256').update(JSON.stringify([id,'USER_CONFIRMED_ACCOUNT_SETTLEMENT'])).digest('hex');
  const inserted=await db.query(`INSERT INTO sports_soccer_settlement_events_v1(event_id,record_id,league,board_date,event_type,payload)
    SELECT $1,r.id,r.league,r.board_date,'SETTLEMENT',$5::jsonb FROM sports_soccer_manual_records_v1 r
    WHERE r.id=$2 AND r.league=$3 AND r.board_date=$4::date AND r.payload->>'status'='OPEN'
      AND r.payload @> $6::jsonb
    FOR UPDATE OF r ON CONFLICT DO NOTHING RETURNING payload`,[eventId,id,league,date,JSON.stringify(check),JSON.stringify(soccerOriginalContract(record))]);
  if(inserted.length)return {record:(await listSoccerManualRecords(league,date,{db})).find(r=>r.id===id),created:true,persistence:'durable_database'};
  // Re-read both state and receipt: a racing cancellation must never appear
  // as a successful new confirmation, and a different receipt cannot replace it.
  const current=await db.query(`SELECT r.payload,s.payload AS settlement FROM sports_soccer_manual_records_v1 r
    LEFT JOIN sports_soccer_settlement_events_v1 s ON s.record_id=r.id AND s.event_type='SETTLEMENT'
    WHERE r.id=$1 AND r.league=$2 AND r.board_date=$3::date`,[id,league,date]);
  const row=current[0],existing=row?.settlement;
  if(row?.payload?.status==='OPEN'&&existing?.source===check.source&&existing.contractHash===check.contractHash
    &&existing.profit===check.profit&&existing.rebateTreatment===check.rebateTreatment)
    return {record:(await listSoccerManualRecords(league,date,{db})).find(r=>r.id===id),created:false,persistence:'durable_database'};
  throw failure('紀錄狀態已變更或已有不同的結算；請重新讀取。',409);
}

export async function amendSoccerAccountSettlement(league,date,id,{revision,action,netProfit,reason,confirmedAccountSettlement,confirmedFinalAmount,db=null,now=Date.now()}={}){
  scope(league,date);
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id||'')||!Number.isSafeInteger(revision)||revision<0||revision>=2147483647
    ||!['CORRECT','REVOKE'].includes(action)||confirmedAccountSettlement!==true||confirmedFinalAmount!==true
    ||typeof reason!=='string'||!reason.trim()||reason.trim().length>200)throw failure('請填寫修正原因並確認帳戶資料。');
  let amount;
  if(action==='CORRECT'){
    if(typeof netProfit!=='string'||!/^[-+]?\d+(?:\.\d{1,2})?$/.test(netProfit)||netProfit.length>32)throw failure('帳戶損益格式不正確。');
    try{amount=new Decimal(netProfit);}catch{throw failure('帳戶損益格式不正確。');}
    if(!amount.isFinite()||!amount.times(100).isInteger()||amount.times(100).abs().gt(Number.MAX_SAFE_INTEGER))throw failure('帳戶損益格式不正確。');
  }
  db||=await database();
  await db.query(`INSERT INTO sports_soccer_account_settlement_revisions_v1(record_id)
    SELECT r.id FROM sports_soccer_manual_records_v1 r JOIN sports_soccer_settlement_events_v1 s ON s.record_id=r.id AND s.event_type='SETTLEMENT'
    WHERE r.id=$1 AND r.league=$2 AND r.board_date=$3::date
      AND s.payload->>'source'='SELF_REPORTED_USER_CONFIRMED' ON CONFLICT DO NOTHING`,[id,league,date]);
  const event={revision:revision+1,action,reason:reason.trim(),recordedAt:new Date(now).toISOString(),source:'SELF_REPORTED_USER_CONFIRMED',
    ...(action==='CORRECT'?{profit:amount.toNumber(),rebateTreatment:'INCLUDED'}:{}),formalEligible:false,calibrationEligible:false,executable:false};
  const inserted=await db.query(`WITH locked AS MATERIALIZED (
    SELECT r.id FROM sports_soccer_manual_records_v1 r JOIN sports_soccer_settlement_events_v1 s ON s.record_id=r.id AND s.event_type='SETTLEMENT'
    WHERE r.id=$1 AND r.league=$2 AND r.board_date=$3::date AND r.payload->>'status'='OPEN'
      AND s.payload->>'source'='SELF_REPORTED_USER_CONFIRMED'
      AND ($6<>'REVOKE' OR COALESCE((SELECT payload->>'action' FROM sports_soccer_account_settlement_amendments_v1 WHERE record_id=r.id ORDER BY revision DESC LIMIT 1),'')<>'REVOKE') FOR UPDATE OF r
  ), changed AS (UPDATE sports_soccer_account_settlement_revisions_v1 a SET revision=a.revision+1 FROM locked
    WHERE a.record_id=locked.id AND a.revision=$4 RETURNING a.record_id,a.revision)
  INSERT INTO sports_soccer_account_settlement_amendments_v1(record_id,revision,payload)
    SELECT record_id,revision,$5::jsonb FROM changed RETURNING payload`,[id,league,date,revision,JSON.stringify(event),action]);
  if(!inserted.length){
    const current=(await listSoccerManualRecords(league,date,{db})).find(r=>r.id===id);
    const previous=current?.accountSettlement?.amendments?.find(a=>a.revision===event.revision);
    if(current?.status==='OPEN'&&current.accountSettlement?.revision===event.revision&&previous?.action===event.action
      &&previous.reason===event.reason&&(event.action==='REVOKE'||previous.profit===event.profit))
      return {record:current,created:false,persistence:'durable_database'};
    throw failure('紀錄已取消、重複撤銷或結算版本已變更，請重新讀取。',409);
  }
  return {record:(await listSoccerManualRecords(league,date,{db})).find(r=>r.id===id),created:true,persistence:'durable_database'};
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
