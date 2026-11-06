import { soccerProviderIdentityFixture } from './helpers/soccer-provider-identity-fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fetchSoccerSchedule, normalizeSoccerSchedule } from '../lib/soccer/data.js';
import { normalizeSoccerPrematch } from '../lib/soccer/prematch.js';
import { buildSoccerAnalysis } from '../lib/soccer/analysis.js';
import { soccerReaderIdentityVerified, soccerCompleteScheduleAuthorityVerified } from '../lib/soccer/reader-identity-proof.js';
import { soccerIdentityHash, soccerIdentityTextHash } from '../lib/soccer/identity-hash.js';
import { parseSoccerCapture } from '../reader/soccer-parser.js';
import { validateSoccerCapture } from '../lib/soccer/reader.js';
import { soccerDate } from '../lib/soccer/contracts.js';
import { compactSoccerForwardCapture, validateSoccerForwardCapture, soccerForwardAnalysisRevision, soccerForwardModelDescriptor, soccerForwardHash, SOCCER_FORWARD_POLICY, SOCCER_FORWARD_VERSION } from '../lib/soccer/forward-validation.js';
import { canonicalSoccerMarketReturnCaptures } from '../lib/soccer/market-return-validation.js';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';
for(const text of ['', 'abc', '繁體中文🔥', 'a'.repeat(10000), ...[55,56,63,64,65,119,120,127,128].map(n=>'x'.repeat(n))])
  assert.equal(soccerIdentityTextHash(text),createHash('sha256').update(text).digest('hex'));
const {now,at,start,date,payload,raw,boardFor,board,game,evidence,reader,build,snapshot}=await soccerProviderIdentityFixture();
assert.ok(snapshot.directions.flatMap(d=>d.quotes).length>0);assert.equal(snapshot.provisionalReaderResearch,null);
assert.equal(snapshot.readerIdentityEvidence.status,'PROVIDER_SCOPED_UNIQUE_MATCH');assert.equal(snapshot.readerIdentityEvidence.providerCompletenessVerified,false);
assert.equal(soccerReaderIdentityVerified(snapshot),true,'real adapter/parser/normalizer path without authority mock');
assert.equal(snapshot.formalScoringEnabled,false);assert.ok(snapshot.directions.every(d=>d.W===null&&d.R===null&&d.score===null&&d.eligible===false));
const clone=structuredClone(board);assert.equal(soccerCompleteScheduleAuthorityVerified(clone,game),false,'serializable flags do not issue server receipt');
assert.equal(build(clone).readerIdentityEvidence,null);
const mutatedBoard=await boardFor();mutatedBoard.games[0].home.sourceId='987';assert.equal(soccerCompleteScheduleAuthorityVerified(mutatedBoard,game),false);
const competing=structuredClone(raw);competing.id='987654321';competing.uid=undefined;competing.competitions[0].id='987654321';competing.competitions[0].uid=undefined;
const ambiguous=build(await boardFor([raw,competing]));assert.equal(ambiguous.readerIdentityEvidence,null);assert.equal(ambiguous.directions.flatMap(d=>d.quotes).length,0);
assert.equal(build(board,{...evidence,game:{...evidence.game,neutralSite:!game.neutralSite}}).readerIdentityEvidence,null);
assert.equal(build(board,{...evidence,game:{...evidence.game,startTime:new Date(Date.parse(start)+60000).toISOString()}}).readerIdentityEvidence,null);
const rawConflict=structuredClone(reader);rawConflict.games[0].homeRaw='Different FC[主]';assert.equal(build(board,evidence,rawConflict).readerIdentityEvidence,null);
const rehash=proof=>{const{contentHash,...body}=proof;proof.contentHash=soccerIdentityHash(body);};
for(const mutate of [s=>s.readerIdentityEvidence.manifest.sources[0].contentHash='c'.repeat(64),s=>s.evidence.game.neutralSite=!s.evidence.game.neutralSite,
  s=>s.evidence.game.home.id='soccer:ucl:team:1',s=>s.evidence.game.sourceId='123',s=>s.evidence.scheduleSource.contentHash='c'.repeat(64),
  s=>s.directions.find(d=>d.quotes.length).quotes[0].rawRows=['changed'],s=>s.directions.find(d=>d.quotes.length).quotes[0].provenance.readerRevision='c'.repeat(64),
  s=>s.readerIdentityEvidence.readerIdentities[0].boardTime='invalid',s=>s.readerIdentityEvidence.summarySource.url+='&event=999']){
  const changed=structuredClone(snapshot);mutate(changed);rehash(changed.readerIdentityEvidence);assert.equal(soccerReaderIdentityVerified(changed),false);
}
const protocol={version:SOCCER_FORWARD_VERSION,activatedAt:new Date(now-60000).toISOString(),policy:SOCCER_FORWARD_POLICY};
const p={...snapshot,runStartedAt:new Date(now-1000).toISOString()},captureRow={captureId:'d'.repeat(64),captureSequence:'1',league:'epl',gameId:game.id,date,
  period:'REGULATION_FT',variant:'BASELINE',capturedAt:new Date(now+1000).toISOString(),snapshot:p,revision:soccerForwardAnalysisRevision(p),modelHash:soccerForwardHash(soccerForwardModelDescriptor(p,'REGULATION_FT','BASELINE'))};
assert.equal(validateSoccerForwardCapture(captureRow,protocol,now+2000).ok,true,JSON.stringify(validateSoccerForwardCapture(captureRow,protocol,now+2000)));
const compact=compactSoccerForwardCapture(captureRow,protocol,now+2000);assert.equal(soccerReaderIdentityVerified(compact.snapshot),true,'compaction preserves all actual quote identity bindings');
assert.ok(canonicalSoccerMarketReturnCaptures([compact],protocol,now+2000).observations.length>0,'eligible source-bound observations retain other acceptance gates');
const db=await soccerSqlFixture(),old=process.env.DATABASE_URL,old2=process.env.DATABASE_V2_URL;
try{process.env.DATABASE_URL='postgres://fixture.invalid/provider-identity';delete process.env.DATABASE_V2_URL;
  const{saveSoccerAnalysis,loadSoccerAnalysisRevision}=await import('../lib/soccer/analysis-store.js');const saved=await saveSoccerAnalysis(snapshot);
  const restored=await loadSoccerAnalysisRevision('epl',game.id,date,saved.revision);assert.equal(soccerReaderIdentityVerified(restored),true,'immutable DB readback preserves new proof');
  await assert.rejects(()=>db.db.query('UPDATE sports_soccer_analysis_v1 SET payload=payload'),/SOCCER_IMMUTABLE_HISTORY|SOCCER_IMMUTABLE/);
}finally{if(old===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=old;if(old2===undefined)delete process.env.DATABASE_V2_URL;else process.env.DATABASE_V2_URL=old2;await db.close();}
console.log('PASS actual provider-scoped identity: existing fetch/normalizer/Reader parser, source and candidate ambiguity guards, immutable DB readback and compact return path; no global completeness, independent source, legacy proof or formal S/R promotion');
