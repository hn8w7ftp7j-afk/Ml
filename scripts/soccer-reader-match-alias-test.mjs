import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { soccerReaderMatchTeamKey } from '../lib/soccer/reader-team-identity.js';
import { matchSoccerReaderGames, validateSoccerCapture } from '../lib/soccer/reader.js';
import { parseSoccerCapture, canonicalSoccerPayload } from '../reader/soccer-parser.js';

const now=Date.parse('2026-10-20T00:00:00Z'),at=new Date(now).toISOString();
// Source pairs observed on the live UCL board and provider schedule. Sabah FK
// is Azerbaijan's Baku club, not Malaysia's Sabah: UEFA club 2609356 and the
// club's own https://sabahfc.az/contact identify the Azerbaijani/Baku identity.
const aliases=[
  ['費倫巴治','Fenerbahce'],['沙巴巴庫','Sabah FK'],['多蒙特','Borussia Dortmund'],['拿玻里','Napoli'],
  ['波杜基林特','Bodo/Glimt'],['史特加','VfB Stuttgart'],['馬德里體育會','Atlético Madrid'],['波圖','FC Porto'],
  ['PSV燕豪芬','PSV Eindhoven'],['AEK雅典','AEK Athens'],['維拉利爾','Villarreal'],
  ['巴迪斯拉華','Slovan Bratislava'],['巴黎聖日門','Paris Saint-Germain'],['巴塞隆拿','Barcelona'],
];
const key=value=>globalThis.Tai888SoccerTeams.key(value);
const hash=value=>createHash('sha256').update(canonicalSoccerPayload(value)).digest('hex');
for(const [index,[boardName,officialName]] of aliases.entries()){
  const originalKey=key(boardName);
  assert.equal(soccerReaderMatchTeamKey(boardName),key(officialName),boardName);
  assert.equal(soccerReaderMatchTeamKey(originalKey),key(officialName),'already-saved normalized keys resolve exactly');
  assert.equal(soccerReaderMatchTeamKey(`${boardName}[主]`),key(officialName));
  assert.notEqual(originalKey,key(officialName),'the installed Reader still emits its original identity');
  const capture={league:'UCL',pageLeagueLabel:'歐洲冠軍聯賽',sourceHost:'www.tai888.in',pageUrl:'https://www.tai888.in/newapp/',observedAt:at,
    tables:[{sectionTitle:'歐洲冠軍聯賽 全場',headers:['時間','主客隊伍','全場讓球','全場大小','全場獨贏'],rows:[{cells:[
      {pair:['10-21','03:00']},{pair:['Arsenal',`${boardName}[主]`]},{pair:['0.95','1平 0.95']},
      {pair:['大3平 0.95','小 0.95']},{pair:['主勝 -','和 -','客勝 -']},
    ]}]}]};
  const wire={...parseSoccerCapture(capture,new Date(now)),readerVersion:'2.1.39',pageActivityAt:at};
  assert.deepEqual(wire.parseIssues,[]);
  const canonicalBefore=canonicalSoccerPayload(wire),hashBefore=hash(wire),before=JSON.stringify(wire);
  const checked=validateSoccerCapture(wire,{now,headerVersion:'2.1.39'});
  assert.equal(checked.ok,true,JSON.stringify(checked));
  assert.equal(checked.payload.games[0].homeKey,originalKey,'validation preserves the old Reader identity');
  const official={id:`soccer:ucl:${123+index}`,league:'ucl',date:'2026-10-21',startTime:'2026-10-20T19:00:00.000Z',status:'scheduled',
    home:{name:officialName},away:{name:'Arsenal'}};
  const joined=matchSoccerReaderGames(checked.payload,[official],now)[0];
  assert.equal(joined.matchStatus,'MATCHED',`${boardName} → ${officialName}`);
  assert.equal(joined.officialGameId,official.id);
  assert.equal(joined.homeKey,originalKey);
  assert.equal(joined.homeRaw,`${boardName}[主]`);
  assert.equal(joined.executable,false);
  for(const other of [
    {...official,league:'epl'}, {...official,date:'2026-10-22'},
    {...official,startTime:'2026-10-20T19:01:00.000Z'},
    {...official,home:official.away,away:official.home},
    {...official,home:{name:`${officialName} U21`}},
    {...official,away:{name:'Chelsea'}},
  ])assert.equal(matchSoccerReaderGames(checked.payload,[other],now)[0].matchStatus,'UNMATCHED');
  assert.equal(matchSoccerReaderGames(checked.payload,[official,{...official,id:`${official.id}-duplicate`}],now)[0].matchStatus,'AMBIGUOUS');
  for(const patch of [
    {homeKey:key('Chelsea')},{homeRaw:'Chelsea[主]'},{awayRaw:'Chelsea'},
    {homeKey:null},{homeKey:123},{homeRaw:null},{league:'EPL'},
    {homeRaw:`${boardName}-角球數[主]`},{boardDate:'2026-02-30'},{boardTime:'25:00'},
  ]){
    const tampered={...checked.payload,games:[{...checked.payload.games[0],...patch}]};
    assert.equal(matchSoccerReaderGames(tampered,[official],now)[0].matchStatus,'UNMATCHED',JSON.stringify(patch));
  }
  const forged=structuredClone(wire);forged.games[0].homeKey=key(officialName);
  assert.equal(validateSoccerCapture(forged,{now,headerVersion:'2.1.39'}).ok,false,'matching aliases do not weaken raw wire reparse');
  assert.equal(JSON.stringify(wire),before);
  assert.equal(canonicalSoccerPayload(wire),canonicalBefore);
  assert.equal(hash(wire),hashBefore,'match-time correction cannot rewrite captured payload or hash');
}
for(const value of ['沙巴','Sabah','Sabah FC Malaysia','費倫巴治 U21','巴塞隆拿-角球數','多蒙特 BOOKING']){
  assert.notEqual(soccerReaderMatchTeamKey(value),soccerReaderMatchTeamKey(value.includes('沙巴')||value.includes('Sabah')?'Sabah FK':value.includes('費倫')?'Fenerbahce':value.includes('巴塞')?'Barcelona':'Borussia Dortmund'));
}
console.log('PASS exact UCL board aliases → legacy-key server matching: old Reader wire/hash unchanged, both teams/date/kickoff/league exact, duplicate/prop/conflicting identities fail closed; no fuzzy matching or scoring promotion');
