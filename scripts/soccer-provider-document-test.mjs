import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';
import { soccerCalibrationShadowFixture } from './helpers/soccer-calibration-shadow-fixture.mjs';
import { retainSoccerProviderDocument, soccerProviderDocumentHashValid } from '../lib/soccer/provider-document.js';
import { evaluateSoccerCalibrationShadow, readSoccerCalibrationShadowReport } from '../lib/soccer/calibration-shadow-validation.js';
const sql=await soccerSqlFixture(),f=soccerCalibrationShadowFixture(1),history=[];
const roundtrip=async value=>(await sql.db.query('SELECT $1::jsonb AS value',[JSON.stringify(value)])).rows[0].value;
const hash=value=>createHash('sha256').update(value).digest('hex');
try {
 const raw={ok:true,data:{zz:1,a:{zz:2,a:3},events:[{z:4,a:5}]},source:{provider:'ESPN',contentHash:''}};
 raw.source.contentHash=hash(JSON.stringify(raw.data));
 const old=await roundtrip(raw);
 assert.notEqual(JSON.stringify(old.data),JSON.stringify(raw.data),'real PostgreSQL JSONB changes key order');
 assert.equal(soccerProviderDocumentHashValid(old),false,'legacy lost serialization is not approved by unordered fallback');
 const retained=await roundtrip(retainSoccerProviderDocument(raw));
 assert.equal(retained.source.contentHash,raw.source.contentHash);
 assert.equal(retained.retainedJson,JSON.stringify(raw.data));
 assert.equal(soccerProviderDocumentHashValid(retained),true);
 for(const mutate of [x=>{x.data.a.a=9;},x=>{x.retainedJson+=' ';},x=>{x.source.contentHash='a'.repeat(64);},x=>{x.retainedJson='{';x.source.contentHash=hash(x.retainedJson);}]){
  const x=structuredClone(retained);mutate(x);assert.equal(soccerProviderDocumentHashValid(x),false);
 }
 const id=f.records[0].captureReceipt.captureId;
 const deps={now:()=>f.now,loadEvidence:async(_l,o={})=>f.context(o.captureIds||null,o.limit||100),listPending:async()=>[id],
  readHistory:async(_l,{captureIds})=>history.filter(x=>captureIds.includes(x.captureId)),
  archive:async value=>{history.push({...await roundtrip(value),checkedAt:new Date(f.now).toISOString()});return{persisted:true};},
  fetchJson:async url=>{const d=f.resultDocuments(f.records[0]);return url.includes('/summary?')?d.summaries[0]:d.scoreboard;},
  baseReport:async()=>({captureGames:1,fullTimeCaptures:1,halfTimeCaptures:1,untouchedValidatedGames:0}),
  listCaptureIds:async()=>({captureIds:[id],nextSequence:null,completeWithinRequestedScope:true})};
 const result=await evaluateSoccerCalibrationShadow({league:'epl',limit:1},deps);
 assert.equal(result.summary.validatedGames,1,'actual fetch → serialized proof → JSONB archive → replay retains the valid sample');
 const report=await readSoccerCalibrationShadowReport('epl',deps);
 assert.equal(report.untouchedValidatedGames,1);assert.equal(report.validation.before.FT.games,1);assert.equal(report.validation.after.HT.games,1);
 assert.equal(report.formalEligible,false);assert.equal(report.S,null);
 history[0].resultDocuments.summaries[0].data.header.competitions[0].competitors[0].score='999';
 const tampered=await readSoccerCalibrationShadowReport('epl',deps);
 assert.equal(tampered.untouchedValidatedGames,0);assert.ok(tampered.validation.checkReasons.CALIBRATION_RESULT_DOCUMENT_HASH_OR_TIME_INVALID>0);
 console.log('PASS actual JSONB key-order counterexample and full calibration fetch/archive/readback: original serialized hash retained, semantic equality required, altered data/text/hash rejected, valid paired sample preserved without model acceptance');
} finally {await sql.close();}
