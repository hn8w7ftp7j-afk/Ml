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
  ['皇家貝迪斯','Real Betis'],['科木','Como'],['朗斯','Lens'],['維京','Viking FK'],
  ['波杜基林特','Bodo/Glimt'],['史特加','VfB Stuttgart'],['馬德里體育會','Atlético Madrid'],['波圖','FC Porto'],
  ['PSV燕豪芬','PSV Eindhoven'],['AEK雅典','AEK Athens'],['維拉利爾','Villarreal'],
  ['加拉塔沙雷','Galatasaray'],['寧斯','LASK Linz'],
  ['巴迪斯拉華','Slovan Bratislava'],['巴黎聖日門','Paris Saint-Germain'],['巴塞隆拿','Barcelona'],
  ['葡萄牙士砵亭','Sporting CP'],['薩克達','Shakhtar Donetsk'],['利爾','Lille'],
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
    {homeKey:key(officialName)},{homeRaw:`${officialName}[主]`},
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
// Both names below were observed together on Production's EPL board on Oct 24.
// Exercise the installed Reader parse and strict server reparse, not a forged
// normalized key, before matching the exact official pair.
{
  const beforeKickoff=Date.parse('2026-10-23T18:55:00.000Z'),observedAt=new Date(beforeKickoff).toISOString();
  const capture={league:'EPL',pageLeagueLabel:'英超',sourceHost:'www.tai888.in',pageUrl:'https://www.tai888.in/newapp/',observedAt,
    tables:[{sectionTitle:'英超 全場',headers:['時間','主客隊伍','全場讓球','全場大小','全場獨贏'],rows:[{cells:[
      {pair:['10-24','03:00']},{pair:['諾定咸森林','葉士域治[主]']},{pair:['0-50 0.95','0.91']},
      {pair:['大3+50 0.95','小 0.89']},{pair:['主勝 -','和 -','客勝 -']},
    ]}]}]};
  const wire={...parseSoccerCapture(capture,new Date(beforeKickoff)),readerVersion:'2.1.39',pageActivityAt:observedAt};
  assert.deepEqual(wire.parseIssues,[]);
  const original=JSON.stringify(wire),originalCanonical=canonicalSoccerPayload(wire),originalHash=hash(wire);
  const checked=validateSoccerCapture(wire,{now:beforeKickoff,headerVersion:'2.1.39'});
  assert.equal(checked.ok,true,JSON.stringify(checked));
  const raw=checked.payload.games[0];
  assert.equal(raw.homeKey,key('葉士域治'));
  assert.equal(raw.awayKey,key('諾定咸森林'));
  assert.notEqual(raw.homeKey,key('Ipswich Town'));
  assert.notEqual(raw.awayKey,key('Nottingham Forest'));
  assert.equal(soccerReaderMatchTeamKey(raw.homeKey),key('Ipswich Town'));
  assert.equal(soccerReaderMatchTeamKey(raw.awayKey),key('Nottingham Forest'));
  const official={id:'soccer:epl:20261024',league:'epl',date:'2026-10-24',startTime:'2026-10-23T19:00:00.000Z',status:'scheduled',
    home:{name:'Ipswich Town'},away:{name:'Nottingham Forest'}};
  const matched=matchSoccerReaderGames(checked.payload,[official],beforeKickoff)[0];
  assert.equal(matched.matchStatus,'MATCHED');
  assert.equal(matched.officialGameId,official.id);
  assert.equal(matched.fresh,true);
  assert.equal(matched.prestart,true);
  assert.equal(matched.executable,false,'identity matching cannot authorize scoring or betting');
  for(const other of [
    {...official,league:'ucl'}, {...official,date:'2026-10-25'},
    {...official,startTime:'2026-10-23T19:01:00.000Z'},
    {...official,home:official.away,away:official.home},
    {...official,home:{name:'Ipswich Town U21'}},
    {...official,away:{name:'Nottingham Forest U21'}},
  ])assert.equal(matchSoccerReaderGames(checked.payload,[other],beforeKickoff)[0].matchStatus,'UNMATCHED');
  assert.equal(matchSoccerReaderGames(checked.payload,[official,{...official,id:'soccer:epl:duplicate'}],beforeKickoff)[0].matchStatus,'AMBIGUOUS');
  for(const patch of [
    {homeKey:key('Ipswich Town')},{awayKey:key('Nottingham Forest')},
    {homeRaw:'Ipswich Town[主]'},{awayRaw:'Nottingham Forest'},
    {homeRaw:'葉士域治 U21[主]'},{awayRaw:'諾定咸森林-角球數'},
  ]){
    const tampered={...checked.payload,games:[{...raw,...patch}]};
    assert.equal(matchSoccerReaderGames(tampered,[official],beforeKickoff)[0].matchStatus,'UNMATCHED',JSON.stringify(patch));
  }
  for(const side of ['home','away']){
    const forged=structuredClone(wire);forged.games[0][`${side}Key`]=key(official[side].name);
    assert.equal(validateSoccerCapture(forged,{now:beforeKickoff,headerVersion:'2.1.39'}).ok,false);
  }
  const stale=matchSoccerReaderGames(checked.payload,[official],beforeKickoff+180001)[0];
  assert.equal(stale.matchStatus,'MATCHED');assert.equal(stale.fresh,false);
  const final=matchSoccerReaderGames(checked.payload,[{...official,status:'final'}],Date.parse('2026-10-24T00:50:00.000Z'))[0];
  assert.equal(final.matchStatus,'MATCHED');assert.equal(final.fresh,false);assert.equal(final.prestart,false);assert.equal(final.executable,false);
  assert.equal(JSON.stringify(wire),original);assert.equal(canonicalSoccerPayload(wire),originalCanonical);assert.equal(hash(wire),originalHash);

  // Production's old observation contains HT and unlabelled columns. An alias
  // correction must not upgrade UNKNOWN to FT or give the old quote a new time.
  const oldObservedAt='2026-10-22T21:45:04.969Z',oldNow=Date.parse(oldObservedAt);
  const oldCapture={...capture,observedAt:oldObservedAt,tables:[
    {...capture.tables[0],sectionTitle:'英超 上半場',headers:['時間','主客隊伍','上半場讓球','上半場大小','上半場獨贏']},
    {...capture.tables[0],sectionTitle:'英超',headers:['時間','主客隊伍','讓球','大小','獨贏']},
  ]};
  const oldWire={...parseSoccerCapture(oldCapture,new Date(oldNow)),readerVersion:'2.1.42',pageActivityAt:oldObservedAt};
  const oldChecked=validateSoccerCapture(oldWire,{now:oldNow,headerVersion:'2.1.42'});
  assert.equal(oldChecked.ok,true,JSON.stringify(oldChecked));
  const oldHash=hash(oldWire),oldPeriods=oldChecked.payload.games[0].markets.map(m=>m.period);
  assert.ok(oldPeriods.includes('HT'));assert.ok(oldPeriods.includes('UNKNOWN'));assert.ok(!oldPeriods.includes('FT'));
  const oldMatched=matchSoccerReaderGames(oldChecked.payload,[{...official,status:'final'}],Date.parse('2026-10-24T00:50:00.000Z'))[0];
  assert.equal(oldMatched.matchStatus,'MATCHED');assert.equal(oldMatched.fresh,false);assert.equal(oldMatched.prestart,false);
  assert.deepEqual(oldMatched.markets.map(m=>m.period),oldPeriods);
  assert.equal(oldChecked.payload.observedAt,oldObservedAt);assert.equal(hash(oldWire),oldHash);
}
// Exact public football names observed in the user's Oct 25/30 Reader diagnostics
// and the Newcastle/Everton pair on Production's Nov 3 EPL board.
// The official pairs and UTC kickoffs were checked against the EPL schedule;
// the Sunderland event falls on Oct 26 in Taipei. The minimal rows below use a
// synthetic observation clock, not a replay claiming the historical receipt.
{
  const syntheticNow=Date.parse('2026-10-25T00:00:00.000Z'),observedAt=new Date(syntheticNow).toISOString();
  const games=[
    {id:'401878766',homeRaw:'侯城[主]',awayRaw:'賓福特',home:'Hull City',away:'Brentford',date:'2026-10-25',time:'22:00',kickoff:'2026-10-25T14:00:00.000Z'},
    {id:'401879252',homeRaw:'曼聯[主]',awayRaw:'般尼茅夫',home:'Manchester United',away:'AFC Bournemouth',date:'2026-10-25',time:'22:00',kickoff:'2026-10-25T14:00:00.000Z'},
    {id:'401878764',homeRaw:'新特蘭[主]',awayRaw:'列斯聯',home:'Sunderland',away:'Leeds United',date:'2026-10-26',time:'00:30',kickoff:'2026-10-25T16:30:00.000Z'},
    {id:'401879250',homeRaw:'阿士東維拉[主]',awayRaw:'富咸',home:'Aston Villa',away:'Fulham',date:'2026-11-01',time:'04:00',kickoff:'2026-10-31T20:00:00.000Z'},
    {id:'401878762',homeRaw:'紐卡素[主]',awayRaw:'愛華頓',home:'Newcastle United',away:'Everton',date:'2026-11-03',time:'04:00',kickoff:'2026-11-02T20:00:00.000Z'},
  ];
  for(const fixture of games){
    const capture={league:'EPL',pageLeagueLabel:'英超',sourceHost:'www.tai888.in',pageUrl:'https://www.tai888.in/newapp/',observedAt,
      tables:[{sectionTitle:'英超 全場',headers:['時間','主客隊伍','全場讓球','全場大小','全場獨贏'],rows:[{cells:[
        {pair:[fixture.date.slice(5),fixture.time]},{pair:[fixture.awayRaw,fixture.homeRaw]},
        {pair:['1+50 0.910','0.970']},{pair:['大3+50 0.850','小 1.010']},{pair:['主勝 -','和 -','客勝 -']},
      ]}]}]};
    const wire={...parseSoccerCapture(capture,new Date(syntheticNow)),readerVersion:'2.1.42',pageActivityAt:observedAt};
    const before=JSON.stringify(wire),canonical=canonicalSoccerPayload(wire),originalHash=hash(wire);
    const checked=validateSoccerCapture(wire,{now:syntheticNow,headerVersion:'2.1.42'});
    assert.equal(checked.ok,true,JSON.stringify(checked));
    const raw=checked.payload.games[0];
    const official={id:`soccer:epl:${fixture.id}`,league:'epl',date:fixture.date,startTime:fixture.kickoff,status:'scheduled',
      home:{name:fixture.home},away:{name:fixture.away}};
    for(const side of ['home','away']){
      assert.equal(raw[`${side}Key`],key(fixture[`${side}Raw`]));
      assert.equal(soccerReaderMatchTeamKey(raw[`${side}Key`]),key(fixture[side]));
      if(key(fixture[`${side}Raw`])!==key(fixture[side])){
        const forged=structuredClone(wire);forged.games[0][`${side}Key`]=key(fixture[side]);
        assert.equal(validateSoccerCapture(forged,{now:syntheticNow,headerVersion:'2.1.42'}).ok,false,'official aliases cannot rewrite original Reader keys');
      }
      for(const suffix of [' U21','-角球數']){
        const tampered={...checked.payload,games:[{...raw,[`${side}Raw`]:`${fixture[`${side}Raw`]}${suffix}`}]};
        assert.equal(matchSoccerReaderGames(tampered,[official],syntheticNow)[0].matchStatus,'UNMATCHED');
        const providerSuffix=suffix==='-角球數'?' CORNER':suffix;
        assert.equal(matchSoccerReaderGames(checked.payload,[{...official,[side]:{name:`${fixture[side]}${providerSuffix}`}}],syntheticNow)[0].matchStatus,'UNMATCHED');
      }
    }
    const matched=matchSoccerReaderGames(checked.payload,[official],syntheticNow)[0];
    assert.equal(matched.matchStatus,'MATCHED',`${fixture.homeRaw} / ${fixture.awayRaw}`);
    assert.equal(matched.officialGameId,official.id);
    assert.equal(matched.fresh,true);assert.equal(matched.prestart,true);assert.equal(matched.executable,false);
    assert.equal(matchSoccerReaderGames(checked.payload,[{...official,home:official.away,away:official.home}],syntheticNow)[0].matchStatus,'UNMATCHED');
    assert.equal(matchSoccerReaderGames(checked.payload,[{...official,away:{name:'Chelsea'}}],syntheticNow)[0].matchStatus,'UNMATCHED','an exact home alias cannot borrow a different opponent');
    assert.equal(matchSoccerReaderGames(checked.payload,[{...official,league:'ucl'}],syntheticNow)[0].matchStatus,'UNMATCHED');
    assert.equal(matchSoccerReaderGames(checked.payload,[{...official,startTime:new Date(Date.parse(official.startTime)+60000).toISOString()}],syntheticNow)[0].matchStatus,'UNMATCHED');
    assert.equal(matchSoccerReaderGames(checked.payload,[{...official,date:'2026-10-27'}],syntheticNow)[0].matchStatus,'UNMATCHED');
    assert.equal(matchSoccerReaderGames(checked.payload,[official,{...official,id:`${official.id}-duplicate`}],syntheticNow)[0].matchStatus,'AMBIGUOUS');
    const stale=matchSoccerReaderGames(checked.payload,[official],syntheticNow+180001)[0];
    assert.equal(stale.matchStatus,'MATCHED');assert.equal(stale.fresh,false);assert.equal(stale.executable,false);
    assert.equal(JSON.stringify(wire),before);assert.equal(canonicalSoccerPayload(wire),canonical);assert.equal(hash(wire),originalHash);
  }
}
// The two saved Production identity pairs below failed the Nov 2–8 schedule
// audit. Event/team IDs, home/away and kickoff were cross-checked against the
// returned ESPN schedule and UEFA's Nov 3 fixture roster. Quotes and the
// observation clock are synthetic; this does not claim a historical receipt.
{
  const observedAt='2026-11-03T16:00:00.000Z',clock=Date.parse(observedAt);
  const fixtures=[
    {id:'401915310',time:'01:45',kickoff:'2026-11-03T17:45:00.000Z',awayRaw:'葡萄牙士砵亭',homeRaw:'薩克達[主]',away:'Sporting CP',home:'Shakhtar Donetsk',awayId:'2250',homeId:'493'},
    {id:'401915384',time:'04:00',kickoff:'2026-11-03T20:00:00.000Z',awayRaw:'利爾',homeRaw:'波杜基林特[主]',away:'Lille',home:'Bodo/Glimt',awayId:'166',homeId:'2980'},
  ];
  for(const fixture of fixtures){
    const row={cells:[{pair:['11-04',fixture.time]},{pair:[fixture.awayRaw,fixture.homeRaw]},
      {pair:['1+50 0.910','0.970']},{pair:['大3+50 0.850','小 1.010']},{pair:['主勝 -','和 -','客勝 -']}]};
    const capture={league:'UCL',pageLeagueLabel:'歐洲冠軍聯賽',sourceHost:'www.tai888.in',pageUrl:'https://www.tai888.in/newapp/',observedAt,
      tables:[
        {sectionTitle:'歐洲冠軍聯賽',headers:['時間','主客隊伍','讓球','大小','獨贏'],rows:[row]},
        {sectionTitle:'歐洲冠軍聯賽 上半場',headers:['時間','主客隊伍','上半場讓球','上半場大小','上半場獨贏'],rows:[row]},
      ]};
    const wire={...parseSoccerCapture(capture,new Date(clock)),readerVersion:'2.1.56',pageActivityAt:observedAt};
    assert.deepEqual(wire.parseIssues,[]);
    const before=JSON.stringify(wire),canonical=canonicalSoccerPayload(wire),originalHash=hash(wire);
    const checked=validateSoccerCapture(wire,{now:clock,headerVersion:'2.1.56'});
    assert.equal(checked.ok,true,JSON.stringify(checked));
    const raw=checked.payload.games[0];
    const official={id:`soccer:ucl:${fixture.id}`,sourceId:fixture.id,league:'ucl',date:'2026-11-04',startTime:fixture.kickoff,status:'scheduled',
      away:{id:`soccer:ucl:team:${fixture.awayId}`,sourceId:fixture.awayId,name:fixture.away},
      home:{id:`soccer:ucl:team:${fixture.homeId}`,sourceId:fixture.homeId,name:fixture.home}};
    const matched=matchSoccerReaderGames(checked.payload,[official],clock)[0];
    assert.equal(matched.matchStatus,'MATCHED');assert.equal(matched.officialGameId,official.id);
    assert.deepEqual(matched.markets,raw.markets,'identity repair preserves the exact original quote and period evidence');
    assert.deepEqual([...new Set(matched.markets.map(m=>m.period))].sort(),['HT','UNKNOWN'],'a new alias cannot promote an unlabelled quote to FT');
    for(const side of ['away','home']){
      assert.equal(matched[`${side}Raw`],fixture[`${side}Raw`]);
      assert.equal(matched[`${side}Key`],key(fixture[`${side}Raw`]));
      assert.equal(soccerReaderMatchTeamKey(matched[`${side}Key`]),key(fixture[side]));
      assert.equal(matchSoccerReaderGames(checked.payload,[{...official,[side]:{...official[side],name:`${fixture[side]} U21`}}],clock)[0].matchStatus,'UNMATCHED');
    }
    for(const other of [
      {...official,league:'epl'}, {...official,home:official.away,away:official.home},
      {...official,startTime:new Date(Date.parse(fixture.kickoff)+60000).toISOString()},
      {...official,date:'2026-11-05'}, {...official,away:{name:'Arsenal'}},
    ])assert.equal(matchSoccerReaderGames(checked.payload,[other],clock)[0].matchStatus,'UNMATCHED');
    assert.equal(matchSoccerReaderGames(checked.payload,[official,{...official,id:`soccer:ucl:${Number(fixture.id)+1}`}],clock)[0].matchStatus,'AMBIGUOUS');
    const postgame=matchSoccerReaderGames(checked.payload,[{...official,status:'final'}],Date.parse('2026-11-08T00:00:00.000Z'))[0];
    assert.equal(postgame.matchStatus,'MATCHED');assert.equal(postgame.fresh,false);assert.equal(postgame.prestart,false);assert.equal(postgame.executable,false);
    assert.equal(JSON.stringify(wire),before);assert.equal(canonicalSoccerPayload(wire),canonical);assert.equal(hash(wire),originalHash);
  }
}
console.log('PASS exact EPL/UCL board aliases → legacy-key server matching: old Reader wire/hash unchanged, both teams/date/kickoff/league exact, duplicate/prop/conflicting identities fail closed; two saved Nov 4 UCL identity pairs match without period/scoring promotion; stale/final quotes stay ineligible');
