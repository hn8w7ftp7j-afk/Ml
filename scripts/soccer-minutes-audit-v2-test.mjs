import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { soccerMinutesAudit, soccerMinutesAuditV2, SOCCER_MINUTES_AUDIT_V2_VERSION } from '../lib/soccer/personnel-audit.js';
import { normalizeSoccerSchedule } from '../lib/soccer/data.js';
import { normalizeSoccerPersonnelHistoryV2 } from '../lib/soccer/personnel-minutes-v2.js';
import { soccerPersonnelHash } from '../lib/soccer/personnel-history.js';
import { replaySoccerMinutesV2 } from './soccer-minutes-v2-replay.mjs';

const payload=JSON.parse(fs.readFileSync('scripts/fixtures/soccer/minutes-past.json','utf8'));
const competition=payload.header.competitions[0];
const game=normalizeSoccerSchedule({leagues:[payload.header.league],events:[{...payload.header,date:competition.date,status:competition.status}]},'epl',{}).games[0];
const original=soccerMinutesAudit(payload,game),v2=soccerMinutesAuditV2(payload,game);
assert.equal(v2.version,SOCCER_MINUTES_AUDIT_V2_VERSION);assert.equal(v2.status,'REGULATION_CLOCK_RECONSTRUCTED');
assert.equal(v2.stateResolvedSubstitutions,0);
for(const side of ['home','away'])assert.deepEqual(v2.teams[side].players,original.teams[side].players);
for(const key of ['modelEffectApplied','pointInTimeAvailabilityVerified','physicalElapsedMinutesVerified','formalEligible'])assert.equal(v2[key],false);
assert.equal(Object.hasOwn(original,'version'),false,'v1 output shape is unchanged');
const firstSub=p=>p.keyEvents.find(event=>event.type.type==='substitution');
const roster=(p,teamId)=>p.rosters.find(group=>String(group.team.id)===teamId).roster;
const names=(p,event)=>new Map(roster(p,String(event.team.id)).map(player=>[String(player.athlete.id),player.athlete.displayName||player.athlete.fullName]));
const ids=firstSub(payload).participants.map(participant=>String(participant.athlete.id));
const oldEvent=original.teams.home.events.find(event=>event.eventId===String(firstSub(payload).id));
assert.ok(ids.includes(oldEvent.enter)&&ids.includes(oldEvent.exit));

const unknown=structuredClone(payload);firstSub(unknown).text='Provider names unavailable';
const recovered=soccerMinutesAuditV2(unknown,game);
assert.equal(soccerMinutesAudit(unknown,game).reason,'SUBSTITUTION_ROLE_UNVERIFIED');
assert.equal(recovered.status,'REGULATION_CLOCK_RECONSTRUCTED');assert.equal(recovered.stateResolvedSubstitutions,1);
for(const side of ['home','away'])assert.deepEqual(recovered.teams[side].players,original.teams[side].players);
const evidence=recovered.teams.home.events.find(event=>event.eventId===oldEvent.eventId).roleEvidence;
assert.equal(evidence.method,'UNIQUE_SOURCE_IDS_ACTIVE_STATE_AND_ROSTER_FLAGS');
assert.deepEqual(evidence.participantIds,[...ids].sort());
const reversed=structuredClone(unknown);firstSub(reversed).participants.reverse();
assert.deepEqual(soccerMinutesAuditV2(reversed,game),recovered,'reversing participant array order changes no role or minute evidence');

// Exact counter-evidence prevents fallback, including a partially recognized
// name. The resolver never selects a convenient role from contradictory text.
for(const kind of ['reversed-known-pair','different-known-exit','partial-contrary-enter','two-contrary-clauses']){
  const changed=structuredClone(payload),event=firstSub(changed),label=names(changed,event);
  const other=roster(changed,String(event.team.id)).find(player=>player.starter&&!ids.includes(String(player.athlete.id)));
  if(kind==='reversed-known-pair')event.text=`${label.get(oldEvent.exit)} replaces ${label.get(oldEvent.enter)}.`;
  if(kind==='different-known-exit')event.text=`${label.get(oldEvent.enter)} replaces ${other.athlete.displayName||other.athlete.fullName}.`;
  if(kind==='partial-contrary-enter')event.text=`${label.get(oldEvent.exit)} replaces Unknown provider spelling.`;
  if(kind==='two-contrary-clauses')event.text=`${label.get(oldEvent.enter)} replaces ${label.get(oldEvent.exit)}. ${label.get(oldEvent.exit)} replaces ${label.get(oldEvent.enter)}.`;
  const audit=soccerMinutesAuditV2(changed,game);
  assert.equal(audit.status,'UNVERIFIED',kind);
  assert.ok(['SUBSTITUTION_STATE_CONFLICT','SUBSTITUTION_TEXT_STATE_CONFLICT','SUBSTITUTION_ROLE_UNVERIFIED'].includes(audit.reason),kind);
}
for(const kind of ['both-starters','both-off-field','missing-incoming-flag','missing-outgoing-flag','duplicate-participant','unknown-player']){
  const changed=structuredClone(unknown),event=firstSub(changed),players=roster(changed,String(event.team.id));
  const lookup=new Map(players.map(player=>[String(player.athlete.id),player]));
  if(kind==='both-starters')event.participants=players.filter(player=>player.starter).slice(0,2).map(player=>({athlete:{id:String(player.athlete.id)}}));
  if(kind==='both-off-field')event.participants=players.filter(player=>!player.starter).slice(0,2).map(player=>({athlete:{id:String(player.athlete.id)}}));
  if(kind==='missing-incoming-flag')lookup.get(oldEvent.enter).subbedIn=false;
  if(kind==='missing-outgoing-flag')lookup.get(oldEvent.exit).subbedOut=false;
  if(kind==='duplicate-participant')event.participants=[event.participants[0],event.participants[0]];
  if(kind==='unknown-player')event.participants[0].athlete.id='999999999999';
  assert.equal(soccerMinutesAuditV2(changed,game).status,'UNVERIFIED',kind);
}

const simultaneous=structuredClone(payload);
for(const event of simultaneous.keyEvents)if(event.type.type==='substitution'){event.text='Role labels differ from roster';event.participants.reverse();}
const sameClock=simultaneous.keyEvents.filter(event=>event.type.type==='substitution'&&event.clock.value===4475);
assert.equal(sameClock.length,2);const [a,b]=sameClock.map(event=>simultaneous.keyEvents.indexOf(event));
[simultaneous.keyEvents[a],simultaneous.keyEvents[b]]=[simultaneous.keyEvents[b],simultaneous.keyEvents[a]];
const simultaneousAudit=soccerMinutesAuditV2(simultaneous,game);
assert.equal(simultaneousAudit.status,'REGULATION_CLOCK_RECONSTRUCTED');assert.equal(simultaneousAudit.stateResolvedSubstitutions,9);
for(const side of ['home','away']){
  assert.deepEqual(simultaneousAudit.teams[side].players,original.teams[side].players,'disjoint simultaneous substitutions do not depend on source array order');
  assert.equal(simultaneousAudit.teams[side].teamPlayerMinutes,990);
}
const stoppage=simultaneousAudit.teams.away.players.find(player=>player.name==='Oleksandr Zinchenko');
assert.equal(stoppage.appeared,true);assert.equal(stoppage.regulationClockMinutes,0);assert.equal(stoppage.addedTimeOnlyAppearance,true);
const duplicateEvent=structuredClone(unknown);duplicateEvent.keyEvents.push(structuredClone(firstSub(duplicateEvent)));
assert.deepEqual(soccerMinutesAuditV2(duplicateEvent,game),recovered,'identical duplicate events are not counted twice');
const conflictingDuplicate=structuredClone(unknown);conflictingDuplicate.keyEvents.push({...firstSub(conflictingDuplicate),text:'conflicting revision'});
assert.equal(soccerMinutesAuditV2(conflictingDuplicate,game).reason,'EVENT_REVISION_CONFLICT');
const duplicatePlayer=structuredClone(unknown);duplicatePlayer.rosters[0].roster.push(structuredClone(duplicatePlayer.rosters[0].roster[0]));
assert.equal(soccerMinutesAuditV2(duplicatePlayer,game).reason,'PLAYER_IDENTITY_INVALID');
const missingEnd=structuredClone(unknown);missingEnd.keyEvents=missingEnd.keyEvents.filter(event=>event.type.type!=='end-regular-time');
assert.equal(soccerMinutesAuditV2(missingEnd,game).reason,'REGULATION_END_MISSING');
const extra=structuredClone(unknown);extra.header.competitions[0].status.type.name='STATUS_FINAL_AFTER_EXTRA_TIME';
assert.equal(soccerMinutesAuditV2(extra,game).reason,'REGULATION_PERIOD_UNVERIFIED');
assert.equal(soccerMinutesAuditV2(unknown,{...game,status:'live'}).reason,'MATCH_NOT_FINAL');
const teamOnly=soccerMinutesAuditV2(unknown,game,{teamSide:'away'});
assert.equal(teamOnly.teamScope,'TEAM_ONLY');assert.deepEqual(Object.keys(teamOnly.teams),['away']);
assert.equal(teamOnly.stateResolvedSubstitutions,0,'other-side evidence is not silently certified by a team-only audit');
console.log('PASS explicit minutes v2: unique source IDs/current active state/two roster flags, unordered and simultaneous substitutions, contradictory/ambiguous roles rejected, duplicate coverage and original timing/roster/stoppage safeguards');

const actualSources=Object.fromEntries(['epl','ucl'].map(league=>[league,JSON.parse(gunzipSync(fs.readFileSync(`research/soccer/personnel-${league}-sources.json.gz`)))]));
const actualRows=Object.fromEntries(['epl','ucl'].map(league=>[league,new Map(JSON.parse(gunzipSync(fs.readFileSync(`research/soccer/${league}-history.json.gz`))).rows.map(row=>[row.eventId,row]))]));
const actual=(league,eventId)=>{
  const record=actualSources[league].find(source=>source.eventId===eventId),row=actualRows[league].get(eventId);
  assert.ok(record&&row);
  return{record,row,game:{status:'final',home:{sourceId:row.homeId},away:{sourceId:row.awayId}}};
};
// The provider explicitly distinguishes actual red card type 93 from type
// 167/168 VAR reviews. A review may confirm, decline or precede an actual card;
// only the actual card changes participation, with final roster corroboration.
const noChange=actual('epl','578438');
const noChangeV1=soccerMinutesAudit(noChange.record.data,noChange.game),noChangeV2=soccerMinutesAuditV2(noChange.record.data,noChange.game);
assert.equal(noChangeV1.status,'REGULATION_CLOCK_RECONSTRUCTED');assert.equal(noChangeV2.status,'REGULATION_CLOCK_RECONSTRUCTED');
const oldBednarek=noChangeV1.teams.away.players.find(player=>player.id==='221788');
const newBednarek=noChangeV2.teams.away.players.find(player=>player.id==='221788');
assert.ok(oldBednarek.regulationClockMinutes<90);assert.equal(newBednarek.regulationClockMinutes,90);
assert.ok(noChangeV2.teams.away.informationalCardReviews.some(event=>/No card change/.test(event.sourceText)));
assert.ok(!noChangeV2.teams.away.events.some(event=>event.type.includes('DISMISSAL')&&event.playerId==='221788'));
const secondYellow=noChange.record.data.keyEvents.find(event=>/^Second yellow card/.test(event.text||''));
assert.equal(secondYellow.type.id,'93');assert.equal(secondYellow.type.type,'red-card');
assert.ok(noChangeV2.teams.home.events.some(event=>event.eventId===String(secondYellow.id)&&event.type==='ON_FIELD_DISMISSAL'),
  'a true second-yellow dismissal remains an actual red-card event');
for(const[league,eventId,playerId]of[['epl','578473','222396'],['epl','578444','221788'],['ucl','618705','199049']]){
  const sample=actual(league,eventId),audit=soccerMinutesAuditV2(sample.record.data,sample.game);
  assert.equal(audit.status,'REGULATION_CLOCK_RECONSTRUCTED',eventId);
  const card=sample.record.data.keyEvents.find(event=>event.type.type==='red-card'&&String(event.participants[0].athlete.id)===playerId);
  const side=sample.game.home.sourceId===String(card.team.id)?'home':'away';
  assert.equal(audit.teams[side].players.find(player=>player.id===playerId).regulationClockMinutes,card.clock.value/60,
    'the actual red-card time, not an earlier or later VAR notification, closes the segment');
  assert.equal(audit.teams[side].events.filter(event=>event.type.includes('DISMISSAL')&&event.playerId===playerId).length,1);
  assert.ok(audit.teams[side].informationalCardReviews.some(event=>event.playerIds.includes(playerId)));
}
const genuine=actual('epl','578473');
const recipient=payload=>payload.rosters.find(group=>String(group.team.id)==='370').roster.find(player=>String(player.athlete.id)==='222396');
for(const kind of ['explicit-zero','missing-stat','duplicate-stat','string-stat','review-without-actual-card','unknown-card-type','different-id-duplicate-real-card']){
  const changed=structuredClone(genuine.record.data),player=recipient(changed);
  if(kind==='explicit-zero')player.stats.find(stat=>stat.name==='redCards').value=0;
  if(kind==='missing-stat')player.stats=player.stats.filter(stat=>stat.name!=='redCards');
  if(kind==='duplicate-stat')player.stats.push({name:'redCards',value:1});
  if(kind==='string-stat')player.stats.find(stat=>stat.name==='redCards').value='1';
  if(kind==='review-without-actual-card')changed.keyEvents=changed.keyEvents.filter(event=>event.type.type!=='red-card');
  if(kind==='unknown-card-type')changed.keyEvents.find(event=>event.type.type==='red-card').type={id:'999',type:'second-yellow-card',text:'Unrecognized card schema'};
  if(kind==='different-id-duplicate-real-card')changed.keyEvents.push({...structuredClone(changed.keyEvents.find(event=>event.type.type==='red-card')),id:'999999999999'});
  const result=soccerMinutesAuditV2(changed,genuine.game);
  assert.equal(result.status,'UNVERIFIED',kind);assert.equal(result.formalEligible,false);
  if(kind==='explicit-zero'||kind==='review-without-actual-card')assert.equal(result.reason,'ROSTER_DISMISSAL_EVENT_CONFLICT');
  if(['missing-stat','duplicate-stat','string-stat'].includes(kind))assert.equal(result.reason,'ROSTER_DISMISSAL_COUNT_UNVERIFIED');
  if(kind==='unknown-card-type')assert.equal(result.reason,'DISMISSAL_EVENT_TYPE_UNVERIFIED');
  if(kind==='different-id-duplicate-real-card')assert.equal(result.reason,'DISMISSAL_IDENTITY_CONFLICT');
}
console.log('PASS actual retained VAR regressions: no-card reviews do not dismiss players, true red/second-yellow type93 remains counted at actual time, VAR given/upgrade is informational in either order, missing/zero/conflicting roster stats and unknown or duplicated true card events stay unverified');

const replay=replaySoccerMinutesV2();
const committed=JSON.parse(fs.readFileSync('research/soccer/personnel-minutes-v2-coverage.json','utf8'));
assert.deepEqual(replay.summary,committed,'the small shipped coverage artifact is exactly reproducible from every retained original source');
assert.equal(replay.observations.length,2995);
for(const[league,wanted]of Object.entries({epl:{population:2190,v1Reconstructed:1247,v2Reconstructed:2190,recovered:943,unverified:0,
    numericChangesOnOriginalUsableGames:7,correctedOriginalUsableGames:7,originalUsableVarReviewCorrectionGames:8,originalUsableVarReviewCorrectionsWithNoMinuteChange:1},
  ucl:{population:805,v1Reconstructed:246,v2Reconstructed:800,recovered:554,unverified:5,numericChangesOnOriginalUsableGames:0,
    correctedOriginalUsableGames:0,originalUsableVarReviewCorrectionGames:0,originalUsableVarReviewCorrectionsWithNoMinuteChange:0}})){
  const actual=replay.summary.leagues[league];for(const[key,value]of Object.entries(wanted))assert.equal(actual[key],value,`${league}/${key}`);
  assert.equal(actual.regressed,0);
  assert.equal(actual.derivationAccepted,actual.population);assert.equal(actual.derivationExcluded,0);
}
assert.deepEqual(replay.summary.leagues.epl.correctionReasons,{VAR_REVIEW_MISCLASSIFIED_AS_DISMISSAL:7});
assert.deepEqual(replay.summary.leagues.ucl.v2Reasons,{SUBSTITUTION_STATE_CONFLICT:1,REGULATION_END_MISSING:4});
const correctedEvents=replay.observations.filter(value=>value.corrections.length).map(value=>value.eventId).sort();
assert.deepEqual(correctedEvents,['578438','578328','605948','605909','605889','605832','605754','638213'].sort());
for(const observation of replay.observations){
  assert.equal(observation.source.contentHash.length,64);assert.equal(observation.sourcePublishedAt,null);
  assert.equal(observation.availability,'BACKFILLED_POSTMATCH_OBSERVATION_NOT_PREMATCH_SAVED');
  assert.equal(observation.pointInTimeAvailabilityVerified,false);assert.equal(observation.modelEffectApplied,false);assert.equal(observation.formalEligible,false);
  if(observation.minutes.status==='REGULATION_CLOCK_RECONSTRUCTED')for(const side of ['home','away']){
    const team=observation.minutes.teams[side];
    assert.ok(Math.abs(team.players.reduce((sum,player)=>sum+player.regulationClockMinutes,0)-team.expectedTeamPlayerMinutes)<1e-7);
    for(const player of team.players)assert.ok(player.regulationClockMinutes>=0&&player.regulationClockMinutes<=90);
  }
}
const sources=JSON.parse(gunzipSync(fs.readFileSync('research/soccer/personnel-epl-sources.json.gz'))),record=sources[0];
const rows=JSON.parse(gunzipSync(fs.readFileSync('research/soccer/epl-history.json.gz'))).rows;
const row=rows.find(row=>row.eventId===record.eventId),unchanged=JSON.stringify({row,data:record.data,source:record.source});
assert.equal(normalizeSoccerPersonnelHistoryV2(row,record.data,record.source).ok,true);
assert.equal(JSON.stringify({row,data:record.data,source:record.source}),unchanged,'the new pipeline never mutates original rows/sources or v1 personnel fields');
assert.equal(normalizeSoccerPersonnelHistoryV2(row,record.data,{...record.source,contentHash:'a'.repeat(64)}).ok,false);
assert.equal(normalizeSoccerPersonnelHistoryV2({...row,eventId:'999'},record.data,record.source).ok,false);
assert.equal(normalizeSoccerPersonnelHistoryV2(row,record.data,{...record.source,sourcePublishedAt:'2020-01-01T00:00:00Z'}).ok,false,'historical source publication is never filled from assumed timestamps');
const changedPayload=structuredClone(record.data);changedPayload.header.competitions[0].competitors[0].score='99';
assert.equal(normalizeSoccerPersonnelHistoryV2(row,changedPayload,{...record.source,contentHash:soccerPersonnelHash(changedPayload)}).ok,false,'recomputed projection hashes do not excuse result/identity conflicts');
console.log('PASS retained 2995-source replay: EPL1247→2190, UCL246→800, 1497 newly usable; five remain unverified, seven separate V2 numerical corrections have actual VAR evidence, eight semantic corrections include one at90min; immutable original V1/source/model artifacts and no model use or promotion');

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'soccer-minutes-v2-'));
try{
  const output=path.join(directory,'derived.json'),summaryOutput=path.join(directory,'coverage.json');
  const cli=spawnSync(process.execPath,['scripts/soccer-minutes-v2-replay.mjs','--output',output,'--summary-output',summaryOutput],{encoding:'utf8',maxBuffer:1024*1024});
  assert.equal(cli.status,0,cli.stderr);assert.deepEqual(JSON.parse(fs.readFileSync(summaryOutput,'utf8')),committed);
  const full=JSON.parse(fs.readFileSync(output,'utf8'));assert.equal(full.observations.length,2995);assert.deepEqual(full.summary,committed);
  const before=createHash('sha256').update(fs.readFileSync(output)).digest('hex');
  const noOverwrite=spawnSync(process.execPath,['scripts/soccer-minutes-v2-replay.mjs','--output',output],{encoding:'utf8',maxBuffer:1024*1024});
  assert.notEqual(noOverwrite.status,0);assert.equal(createHash('sha256').update(fs.readFileSync(output)).digest('hex'),before);
  const sameOutput=path.join(directory,'same.json');
  const noDuplicate=spawnSync(process.execPath,['scripts/soccer-minutes-v2-replay.mjs','--output',sameOutput,'--summary-output',sameOutput],{encoding:'utf8',maxBuffer:1024*1024});
  assert.notEqual(noDuplicate.status,0);assert.equal(fs.existsSync(sameOutput),false);
}finally{fs.rmSync(directory,{recursive:true,force:true});}
console.log('PASS offline derived-data CLI: actual per-game observations can be exported to new private JSON, original/existing files cannot be overwritten and duplicate destinations fail before any write');
