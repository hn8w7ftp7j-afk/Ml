import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {normalizeSoccerWyscoutShotDataset,validateSoccerWyscoutShotDataset,SOCCER_WYSCOUT_SOURCE_CONTRACT} from '../lib/soccer/wyscout-shot-source.js';
import {soccerWyscoutSyntheticDocuments} from './fixtures/soccer/wyscout-shot-fixture.mjs';

const now=Date.parse('2026-11-07T12:00:00.000Z');
const hash=text=>createHash('sha256').update(text).digest('hex');
const docs=()=>soccerWyscoutSyntheticDocuments({kickoffs:['2017-08-11T18:45:00.000Z','2017-08-12T14:00:00.000Z']});
const mutate=(documents,key,fn)=>{const object=JSON.parse(documents[key].text);fn(object);documents[key].text=JSON.stringify(object);documents[key].source.contentHash=hash(documents[key].text);return documents;};
const parse=documents=>normalizeSoccerWyscoutShotDataset({...documents,now});
const valid=parse(docs());assert.equal(valid.ok,true);assert.equal(valid.matches.length,2);
assert.equal(valid.synthetic,true);assert.equal(valid.sourceAuthenticationVerified,false);
assert.equal(valid.coverage.fullPublishedCohortVerified,false);assert.equal(valid.formalEligible,false);assert.equal(valid.W,null);assert.equal(valid.R,null);assert.equal(valid.S,null);
assert.equal(validateSoccerWyscoutShotDataset(valid).ok,true);
assert.equal(validateSoccerWyscoutShotDataset(structuredClone(valid)).ok,false);
assert.throws(()=>{valid.matches[0].shots[0].goal=!valid.matches[0].shots[0].goal;},TypeError);
assert.throws(()=>Object.defineProperty(valid,'matches',{get:()=>[]}),TypeError);
const originalPin=SOCCER_WYSCOUT_SOURCE_CONTRACT.documents.events.hash;
assert.throws(()=>{SOCCER_WYSCOUT_SOURCE_CONTRACT.documents.events.hash='a'.repeat(64);},TypeError);
assert.equal(SOCCER_WYSCOUT_SOURCE_CONTRACT.documents.events.hash,originalPin);

const forged=docs();for(const d of Object.values(forged))d.source.provider='WYSCOUT_OPEN_DATA';
assert.equal(parse(forged).ok,false,'provider name and caller-computed hashes do not grant pinned original authority');
const damaged=docs();damaged.eventsDocument.text+=' ';
assert.equal(parse(damaged).reason,'WYSCOUT_SOURCE_DOCUMENT_UNVERIFIED');
const future=docs();future.eventsDocument.source.fetchedAt='2027-01-01T00:00:00Z';
assert.equal(parse(future).ok,false);
const duplicate=mutate(docs(),'eventsDocument',value=>{value.events.push(value.events[0]);value.totalEvents++;value.uniqueEventIds++;});
assert.equal(parse(duplicate).reason,'WYSCOUT_EVENT_ID_CONFLICT');
const outside=mutate(docs(),'eventsDocument',value=>value.events[0].matchId=123);
assert.equal(parse(outside).reason,'WYSCOUT_EVENT_MATCH_OUTSIDE_INDEX');
for(const [label,change]of [
  ['missing tags',row=>{delete row.tags;}],
  ['foreign team',row=>{row.teamId=999;}],
  ['missing start position',row=>{row.positions=[];}],
  ['invalid coordinate',row=>{row.positions[0].x=101;}],
  ['missing period',row=>{delete row.matchPeriod;}],
  ['extra time in regular match',row=>{row.matchPeriod='E1';}],
  ['own goal plus goal contradiction',row=>{row.tags=[{id:101},{id:102}];}],
  ['type text conflict',row=>{row.subEventName='Penalty';}],
]){
  const d=mutate(docs(),'eventsDocument',value=>change(value.events[0]));const result=parse(d);
  assert.equal(result.ok,true,label);assert.equal(result.coverage.sourceMatches,2,label);
  assert.equal(result.coverage.eligibleMatches,1,label);assert.equal(result.coverage.quarantinedMatches,1,label);
}
const wrongDate=mutate(docs(),'matchesDocument',value=>{value[0].date=value[0].date.replace('GMT+0','GMT+2');});
assert.equal(parse(wrongDate).coverage.quarantinedMatches,1);
const inconsistent=mutate(docs(),'matchesDocument',value=>{value[0].teamsData['1001'].score++;});
assert.equal(parse(inconsistent).quarantined[0].reason,'WYSCOUT_SCORE_RECONCILIATION_CONFLICT');

// Non-penalty is not synonymous with normal Shot: direct free-kick shots are
// included, while explicit penalty attempts remain separately observable.
const types=mutate(docs(),'eventsDocument',value=>{
  for(const [id,sub,name]of [[999001,33,'Free kick shot'],[999002,35,'Penalty']])value.events.push({id,eventId:3,subEventId:sub,eventName:'Free Kick',subEventName:name,
    matchId:9000,teamId:1001,matchPeriod:'1H',eventSec:300,positions:[{x:88,y:50}],tags:[{id:1802}]});
  value.totalEvents+=2;value.uniqueEventIds+=2;
});
const typed=parse(types);assert.equal(typed.coverage.shotUniverse.directFreeKickShots,1);assert.equal(typed.coverage.shotUniverse.penaltyShots,1);
assert.equal(typed.matches[0].shots.filter(row=>row.penalty).length,1);
assert.equal(typed.coverage.eligibleShots-typed.coverage.eligibleNonPenaltyShots,1);

// Source keeper-concession tags cannot double the shooting-side goal count.
const keeper=mutate(docs(),'eventsDocument',value=>{value.events.push({id:999003,eventId:9,subEventId:90,eventName:'Save attempt',subEventName:'Reflexes',
  matchId:9000,teamId:1002,matchPeriod:'1H',eventSec:100,positions:[{x:0,y:50}],tags:[{id:101}]});value.totalEvents++;value.uniqueEventIds++;});
assert.equal(parse(keeper).coverage.quarantinedMatches,0);assert.equal(parse(keeper).coverage.shotUniverse.goalkeeperGoalTagsIgnored,1);
const own=mutate(docs(),'eventsDocument',value=>{value.events.push({id:999004,eventId:7,subEventId:72,eventName:'Others on the ball',subEventName:'Touch',
  matchId:9000,teamId:1001,matchPeriod:'1H',eventSec:200,positions:[{x:1,y:50}],tags:[{id:102}]});value.totalEvents++;value.uniqueEventIds++;});
mutate(own,'matchesDocument',value=>{value[0].teamsData['1002'].score++;value[0].teamsData['1002'].scoreHT++;});
assert.equal(parse(own).coverage.quarantinedMatches,0);assert.equal(parse(own).coverage.shotUniverse.ownGoals,1);

if(process.argv.includes('--actual')){
  const at=process.argv.indexOf('--actual'),root=path.resolve(process.argv[at+1]||'');
  const names={events:'events_England.native-shots.json',matches:'matches_England.json',eventMapping:'eventid2name.csv',tagMapping:'tags2name.csv'};
  const actual={};for(const [key,file]of Object.entries(names)){
    const text=fs.readFileSync(path.join(root,file),'utf8'),{hash:_expected,...source}=SOCCER_WYSCOUT_SOURCE_CONTRACT.documents[key];
    actual[{events:'eventsDocument',matches:'matchesDocument',eventMapping:'eventsMappingDocument',tagMapping:'tagsMappingDocument'}[key]]={text,
      source:{...source,provider:'WYSCOUT_OPEN_DATA',contentHash:hash(text),fetchedAt:new Date().toISOString()}};
  }
  const began=Date.now(),real=normalizeSoccerWyscoutShotDataset({...actual,now:Date.parse('2019-01-01T00:00:00Z')});
  assert.equal(real.ok,true);assert.equal(real.synthetic,false);assert.equal(real.sourceAuthenticationVerified,true);
  assert.ok(Date.parse(real.normalizedAt)>=began,'genuine source validation cannot be backdated by caller now');
  assert.equal(real.coverage.sourceMatches,380);assert.equal(real.coverage.sourceEvents,643150);assert.equal(real.coverage.eligibleMatches,378);
  assert.equal(real.coverage.eligibleNonPenaltyShots,8758);assert.deepEqual(real.quarantined.map(row=>row.matchId).sort(),['2499781','2500001']);
  assert.ok(validateSoccerWyscoutShotDataset(real).sourceAvailableAt>=Date.parse(real.normalizedAt));
  assert.throws(()=>{real.sourceAttribution.documents.events.hash='b'.repeat(64);},TypeError);
  assert.equal(validateSoccerWyscoutShotDataset(real).ok,true);
  const sourceCorruption=structuredClone(actual);sourceCorruption.eventsDocument.text+=' ';
  sourceCorruption.eventsDocument.source.contentHash=hash(sourceCorruption.eventsDocument.text);
  assert.equal(normalizeSoccerWyscoutShotDataset(sourceCorruption).ok,false,'a valid caller hash cannot replace fixed authentic source bytes');
  const originalText=actual.eventsDocument.text;let textReads=0;
  const accessor={...actual,eventsDocument:{source:actual.eventsDocument.source}};
  Object.defineProperty(accessor.eventsDocument,'text',{get(){textReads++;return textReads<=3?originalText:'{}';}});
  assert.equal(normalizeSoccerWyscoutShotDataset(accessor).ok,true);
  assert.equal(textReads,1,'untrusted input accessor is captured once before byte validation and parsing');
  console.log('PASS actual CC-BY Wyscout full source: 380 matches / 643150 events, 378 eligible, 8758 non-penalty shots, 2 native source conflicts quarantined, original/projection hashes and actual availability verified');
}
console.log('PASS Wyscout source engineering: explicit synthetic isolation, frozen private authority, original byte pins, identity/clock/type/tag/coordinate/goal reconciliation and penalty/own-goal/keeper counterexamples');
