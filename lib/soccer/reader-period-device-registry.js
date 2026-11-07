import { createHash } from 'node:crypto';
import { soccerJournalQuery, soccerJournalTransaction } from './journal.js';
import { createSoccerReaderDeviceAuthorization, soccerReaderDeviceContinuationTemplate } from './reader-period-binding.js';

const TABLE='sports_soccer_reader_period_devices_v1';
const SCHEMA=`CREATE TABLE IF NOT EXISTS ${TABLE} (
  parent_config_hash TEXT NOT NULL CHECK (parent_config_hash ~ '^[a-f0-9]{64}$'),
  device_hash TEXT NOT NULL CHECK (device_hash ~ '^[a-f0-9]{64}$'),
  source_host TEXT NOT NULL CHECK (source_host='www.tai888.in'),
  league TEXT NOT NULL CHECK (league IN ('epl','ucl')),
  profile TEXT NOT NULL CHECK (profile='TAI888-DESKTOP-PRIMARY-WITH-EXPLICIT-HT-v1'),
  registered_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  evidence_observation_id TEXT NOT NULL REFERENCES sports_soccer_reader_observations_v2(observation_id),
  PRIMARY KEY (parent_config_hash,device_hash,source_host,league))`;
const hash=value=>createHash('sha256').update(value).digest('hex');
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
let ready;
const receipt=row=>({parentConfigHash:row.parent_config_hash,deviceHash:row.device_hash,sourceHost:row.source_host,
  // Effective authorization rounds forward, never truncates a PostgreSQL
  // microsecond receipt into an earlier millisecond.
  league:row.league,profile:row.profile,registeredAt:new Date(row.effective_at).toISOString(),
  evidenceObservationId:row.evidence_observation_id});

// This entry point is invoked only after Reader token verification, server
// reparse, durable save and readback. No HTTP body field grants registration.
export async function registerSoccerReaderPeriodDevice({payload,authenticatedDeviceId,observationId},options={}) {
  if (typeof authenticatedDeviceId!=='string'||payload?.deviceId!==authenticatedDeviceId||!hex(observationId))
    return {status:'NOT_REGISTERED',reason:'AUTHENTICATED_DEVICE_REQUIRED'};
  const now=options.now??Date.now(),deviceHash=hash(authenticatedDeviceId);
  const template=soccerReaderDeviceContinuationTemplate(payload,deviceHash,now);
  if (!template) return {status:'NOT_REQUIRED_OR_PROFILE_UNCONFIRMED'};
  const query=options.query||soccerJournalQuery;
  if(options.query)await query(SCHEMA);
  else await (ready||=soccerJournalTransaction([
    ['SELECT pg_advisory_xact_lock(221019,2204)'],[SCHEMA],
  ]).catch(error=>{ready=null;throw error;}));
  // Check the immutable stored observation, not the registration caller's
  // claim. The server DB clock is the effective date; source time is never
  // used to backdate a reinstall or promote older saved quotes.
  const rows=await query(`INSERT INTO ${TABLE}
    (parent_config_hash,device_hash,source_host,league,profile,evidence_observation_id)
    SELECT $1,$2,$3,$4,$5,o.observation_id FROM sports_soccer_reader_observations_v2 o
    WHERE o.observation_id=$6 AND o.league=upper($4) AND o.payload->>'deviceId'=$7
      AND o.payload->>'sourceHost'=$3 AND o.payload=$8::jsonb
      AND o.source_observed_at<=clock_timestamp() AND o.received_at<=clock_timestamp() AND o.persisted_at<=clock_timestamp()
    ON CONFLICT (parent_config_hash,device_hash,source_host,league) DO NOTHING RETURNING registered_at`,
  [template.parentConfigHash,deviceHash,template.sourceHost,template.league,template.profile,observationId,
    authenticatedDeviceId,JSON.stringify(payload)]);
  return {status:rows.length?'REGISTERED_FORWARD_ONLY':'ALREADY_REGISTERED_OR_EVIDENCE_REJECTED'};
}

export async function loadSoccerReaderPeriodDeviceAuthorizations(league,deviceHashes,{asOf=null,query=soccerJournalQuery,now=Date.now()}={}) {
  const devices=[...new Set(deviceHashes.filter(hex))];
  if(!['epl','ucl'].includes(league)||!devices.length)return {status:'NOT_REQUIRED',authorizations:[]};
  let rows;
  try {
    // Reads do not create schema or grant new registrations. A source receipt
    // older than this registration remains UNKNOWN even when viewed today.
    rows=await query(`SELECT r.*,
        date_trunc('milliseconds',r.registered_at)+CASE WHEN r.registered_at>date_trunc('milliseconds',r.registered_at)
          THEN interval '1 millisecond' ELSE interval '0 milliseconds' END AS effective_at
      FROM ${TABLE} r
      JOIN sports_soccer_reader_observations_v2 o ON o.observation_id=r.evidence_observation_id
      WHERE r.league=$1 AND r.device_hash=ANY($2::text[])
        AND ($3::timestamptz IS NULL OR r.registered_at<=$3::timestamptz)
        AND r.registered_at<=clock_timestamp() AND o.league=upper(r.league)
        AND o.source_observed_at<=r.registered_at AND o.received_at<=r.registered_at AND o.persisted_at<=r.registered_at
        AND o.payload->>'sourceHost'=r.source_host
        AND encode(sha256(convert_to(o.payload->>'deviceId','UTF8')),'hex')=r.device_hash
      ORDER BY r.registered_at DESC,r.parent_config_hash`,[league,devices,asOf]);
  }catch(error){return {status:error?.code==='42P01'?'NOT_INITIALIZED':'UNAVAILABLE',authorizations:[]};}
  const authorizations=rows.flatMap(row=>{
    try{const authorization=createSoccerReaderDeviceAuthorization(receipt(row),now);return authorization?[authorization]:[];}
    catch{return [];}
  });
  return {status:'READY',authorizations};
}
