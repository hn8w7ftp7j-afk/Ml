import assert from 'node:assert/strict';
import { candidateFixture } from './helpers/soccer-candidate-fixture.mjs';
import { soccerReaderIdentityVerified } from '../lib/soccer/reader-identity-proof.js';
import { soccerHighScoreCandidates, summarizeSoccerHighScoreBets } from '../lib/soccer/league-bet-status.js';

// No identity loader: even a plausible, caller-supplied historical receipt is
// not an authority for the complete schedule or for current candidate status.
const now=Date.now(),league='epl',date='2026-10-20';
const game={id:'soccer:epl:123',sourceId:'123',league,date,status:'scheduled',startTime:new Date(now+86400000).toISOString(),home:{sourceId:'359'},away:{sourceId:'364'}};
const directions=['FT','HT'].map(period=>({period,direction:'TOTAL_OVER',eligible:true,qaFlag:'PASS',score:8,W:2,R:1,
  quotes:[{key:`${period}-total-over`,period,kind:'TOTAL',side:'over',line:'3+50',lineSide:null,water:.95,unit:'GOALS',fresh:true,prestart:true,provenance:{gameId:game.id,observedAt:new Date(now).toISOString()}}]}));
const fake=candidateFixture({gameId:game.id,league,date,publishedCurrent:true,persisted:true,analysisStatus:'COMPLETED',observedAt:new Date(now).toISOString(),evidence:{game},formalScoringEnabled:true,qualification:{eligible:true},directions},now);
assert.equal(soccerReaderIdentityVerified(fake),false,'a serializable completeness claim is not trusted');
for(const snapshot of [fake,{...fake,readerIdentityEvidence:null},{...fake,formalScoringEnabled:true,qualification:{eligible:true}}]){
  const report=soccerHighScoreCandidates([game],{[game.id]:{status:'done',data:snapshot}},{league,date,now});
  assert.equal(report.candidates.length,0,'legacy or fabricated authority cannot populate the league reminder');
  assert.notEqual(summarizeSoccerHighScoreBets(report.candidates,{league,date,ledgerReady:true,analysisReady:report.analysisReady}).state,'all_bet');
}
console.log('PASS real league status: missing and forged schedule identity cannot produce candidates or an all-bet reminder');
