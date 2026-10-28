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

const replay=replaySoccerMinutesV2();
const committed=JSON.parse(fs.readFileSync('research/soccer/personnel-minutes-v2-coverage.json','utf8'));
assert.deepEqual(replay.summary,committed,'the small shipped coverage artifact is exactly reproducible from every retained original source');
assert.equal(replay.observations.length,2995);
for(const[league,wanted]of Object.entries({epl:{population:2190,v1Reconstructed:1247,v2Reconstructed:2177,recovered:930,unverified:13},
  ucl:{population:805,v1Reconstructed:246,v2Reconstructed:799,recovered:553,unverified:6}})){
  const actual=replay.summary.leagues[league];for(const[key,value]of Object.entries(wanted))assert.equal(actual[key],value,`${league}/${key}`);
  assert.equal(actual.regressed,0);assert.equal(actual.numericChangesOnOriginalUsableGames,0);
  assert.equal(actual.derivationAccepted,actual.population);assert.equal(actual.derivationExcluded,0);
}
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
console.log('PASS retained 2995-source replay: EPL1247→2177, UCL246→799, 1483 newly usable; 19 excluded remain explicit, zero v1 regressions/numerical changes, immutable source/model hashes and independent postmatch-only observations');

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
