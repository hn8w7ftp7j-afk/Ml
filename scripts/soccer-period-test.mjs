import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import '../reader/soccer-card-normalizer.js';
import '../reader/soccer-table-normalizer.js';
import { parseSoccerCapture, canonicalSoccerPayload } from '../reader/soccer-parser.js';
import { validateSoccerCapture, matchSoccerReaderGames } from '../lib/soccer/reader.js';
import { buildSoccerMarketDirections, collectUnassignedSoccerQuotes } from '../lib/soccer/market-directions.js';

const now=Date.parse('2026-10-18T12:54:00Z'),at=new Date(now).toISOString();
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-12,`${a} != ${b}`);
const cell=pair=>({pair});
const rawRow=({date='10-18',line='1平',total='3+50',locked=false}={})=>({cells:[cell([date,'21:00']),cell(['水晶宮','白禮頓[主]']),cell(locked?['-','-']:['1.27',`${line} 0.63`]),cell(locked?['-','-']:[`大${total} 0.64`,'小 1.28']),cell(['主勝 -','和 -','客勝 -'])]});
const table=(period,options={})=>({sectionTitle:'英格蘭超級聯賽',headers:['時間','主客隊伍',`${period}讓球`,`${period}大小`,`${period}獨贏`],rows:[rawRow(options)]});
const capture=tables=>({league:'EPL',pageLeagueLabel:'英格蘭超級聯賽',sourceHost:'www.tai888.in',pageUrl:'https://www.tai888.in/newapp/',observedAt:at,tables});
const parse=raw=>parseSoccerCapture(raw,new Date(now));
const wire=payload=>({...payload,readerVersion:'2.1.34',pageActivityAt:at});
const check=payload=>validateSoccerCapture(payload,{now,headerVersion:'2.1.34'});

// Synthetic competition labels only: a familiar senior-name prefix does not
// establish the senior competition, even when rows use otherwise known teams.
const registry=globalThis.Tai888LeagueRegistry;
const competitionLookalikes=['聯盟: 英格蘭超級聯賽盃U21(12)','英超聯賽盃(4)',
  '英格蘭超級聯賽杯(4)','English Premier League Cup (4)','English Premier League 2 (4)',
  '英超2(4)','EPL Reserve (4)','EPL 預備隊(4)','英超 女子(4)',
  '英超 U23(4)','英超 U19(4)','英超 U-21(4)','英超 Under-21(4)',
  '英超 Ｕ２１(4)','UCL Youth (4)','歐洲冠軍聯賽 U19(4)',
  'UEFA Champions League Women (4)','歐冠 後備隊(4)'];
for(const label of competitionLookalikes){
  assert.equal(registry.identify(label),null,label);
  assert.deepEqual(registry.identifyAll(label),[],label);
  assert.equal(registry.standardMarker(label,'EPL'),false,label);
  assert.equal(registry.standardMarker(label,'UCL'),false,label);
  assert.equal(registry.soccerPeriodEvidence({sectionTitle:label,headers:['全場']}).status,'EXCLUDED',label);
  const expected=label.includes('UCL')||label.includes('歐')||label.includes('UEFA')?'UCL':'EPL';
  const scoped={...capture([{...table('全場'),sectionTitle:label}]),league:expected,
    pageLeagueLabel:expected==='EPL'?'英格蘭超級聯賽':'歐洲冠軍聯賽'};
  assert.equal(parse(scoped).games.length,0,`server parser cannot borrow a senior page label for ${label}`);
}
for(const [label,league]of [
  ['聯盟: 英格蘭超級聯賽(6)','EPL'],['EPL(6)','EPL'],['英超 全場(6)','EPL'],
  ['English Premier League 上半場(6)','EPL'],['歐洲聯賽冠軍盃(6)','UCL'],
  ['UEFA Champions League 全場(6)','UCL'],['UCL 上半場(6)','UCL'],
  ['歐冠盃(6)','UCL'],['歐冠杯 上半場(6)','UCL'],
]){assert.equal(registry.identify(label),league,label);assert.equal(registry.standardMarker(label,league),true,label);}
// Period/prop identity continues to be separate from competition identity.
assert.equal(registry.identify('英超 角球'),'EPL');assert.equal(registry.standardMarker('英超 角球','EPL'),false);

const mixedRaw=capture([table('全場'),table('全場',{line:'1.5',total:'3-50'}),table('上半場',{line:'0.5',total:'1+50'})]);
const mixed=parse(mixedRaw);
assert.deepEqual(mixed.parseIssues,[]);assert.equal(mixed.games.length,1);assert.equal(mixed.games[0].markets.length,6);
assert.deepEqual(mixed.periodsCovered,['FT','HT']);assert.deepEqual(mixed.games[0].periodStates,{FT:'open',HT:'open'});
assert.equal(check(wire(mixed)).ok,true);
const byTitle=parse(capture([{sectionTitle:'英格蘭超級聯賽 上半場',headers:['時間','隊伍','讓球','大小','獨贏'],rows:[rawRow()]}]));
assert.ok(byTitle.games[0].markets.every(market=>market.period==='HT'));
const headerOnly=parse(capture([{headers:['時間','隊伍','讓球','大小','獨贏','上半場'],rows:[rawRow()]}]));
assert.ok(headerOnly.games[0].markets.every(market=>market.period==='HT'));
const siblingHeader=parse(capture([{headers:['時間','隊伍','上半場讓球','大小','獨贏'],rows:[rawRow()]}]));
assert.equal(siblingHeader.games[0].markets.find(m=>m.kind==='TOTAL').period,'UNKNOWN','a sibling market is not table-wide period evidence');
for(const qualifier of ['LIVE','下半場','角球']){
  const scoped=table('全場');scoped.headers.push(qualifier);
  assert.equal(parse(capture([scoped])).games.length,0,`standalone ${qualifier} excludes the whole table`);
}
const unknownRaw=capture([{rows:[rawRow()]}]),unknown=parse(unknownRaw);
assert.deepEqual(unknown.periodsCovered,['UNKNOWN']);assert.ok(unknown.games[0].markets.every(market=>market.period==='UNKNOWN'));
for(const title of ['英格蘭超級聯賽 下半場','英格蘭超級聯賽 角球','英格蘭超級聯賽 LIVE','英格蘭超級聯賽 加時','英格蘭超級聯賽 主隊總進球']){
  assert.equal(parse(capture([{sectionTitle:title,rows:[rawRow()]}])).games.length,0,title);
}
const excludedColumns=table('全場');excludedColumns.headers[2]='全場角球讓球';excludedColumns.headers[3]='全場主隊大小';
assert.equal(parse(capture([excludedColumns])).games[0].markets.length,0,'excluded markets never become goal quotes');
const conflict=parse(capture([{sectionTitle:'英格蘭超級聯賽 全場',headers:['時間','隊伍','上半場讓球','上半場大小','上半場獨贏'],rows:[rawRow()]}]));
assert.ok(conflict.games[0].markets.every(market=>market.period==='UNKNOWN'&&market.periodEvidence.status==='CONFLICT'));
const truncated=table('全場');truncated.periodEvidenceTruncated=true;
const truncatedParsed=parse(capture([truncated]));assert.ok(truncatedParsed.games[0].markets.every(market=>market.period==='UNKNOWN'&&market.periodEvidence.status==='TRUNCATED'));assert.equal(check(wire(truncatedParsed)).ok,true);
assert.equal(parse(capture([{...table('全場'),sectionTitle:'歐洲冠軍聯賽 全場'}])).parseIssues[0],'SOCCER_SECTION_LEAGUE_MISMATCH');
const closed=parse(capture([table('上半場',{locked:true})]));
assert.equal(closed.games[0].marketStatus,'locked');assert.deepEqual(closed.games[0].markets,[]);assert.deepEqual(closed.games[0].periodStates,{HT:'locked'});assert.equal(check(wire(closed)).ok,true);
const partialClosed=parse(capture([table('全場'),table('上半場',{locked:true})]));
assert.deepEqual(partialClosed.games[0].periodStates,{FT:'open',HT:'locked'});assert.equal(partialClosed.games[0].marketStatus,'open');
assert.deepEqual(partialClosed.periodsCovered,['FT','HT']);
const multi=parse(capture([table('全場'),table('上半場',{date:'10-19'})]));
const singleDate={...multi,games:multi.games.filter(game=>game.boardDate===multi.boardDate),periodsCovered:['FT']};
assert.equal(check(wire(singleDate)).ok,true,'server derives date-specific coverage from identity rows');
assert.equal(check(wire({...singleDate,periodsCovered:['FT','HT']})).ok,false,'another date cannot clear this date HT');
assert.equal(check(wire({...closed,games:[]})).ok,false,'an arbitrary empty game list is not an observed closed scope');
console.log('PASS explicit table/section periods, mixed FT/HT alternatives, UNKNOWN legacy labels, excluded props/live, conflict isolation, dated locked tombstones and date-specific coverage');

// Freeze the former canonical structure: adding period support must not alter
// any already persisted unscoped snapshot or require old clients to upgrade.
const legacy=structuredClone(unknown);
delete legacy.periodsCovered;
for(const game of legacy.games){delete game.periodsCovered;delete game.periodStates;for(const market of game.markets){delete market.period;delete market.periodEvidence;}}
const legacyCanonical=value=>JSON.stringify({league:value.league,boardDate:value.boardDate,pageLeagueLabel:value.pageLeagueLabel,games:[...value.games].map(game=>({...game,markets:[...game.markets].sort((a,b)=>[a.kind,a.unit,a.line||'',a.lineSide||''].join(':').localeCompare([b.kind,b.unit,b.line||'',b.lineSide||''].join(':')))})).sort((a,b)=>`${a.boardDate}${a.boardTime}${a.awayCode}`.localeCompare(`${b.boardDate}${b.boardTime}${b.awayCode}`))},(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])):value);
assert.equal(canonicalSoccerPayload(legacy),legacyCanonical(legacy));
assert.equal(createHash('sha256').update(canonicalSoccerPayload(legacy)).digest('hex'),'d98dc18bc6bd3e5632583390601d8acec1993df43664265af5442b3698a9bb40');
const oldChecked=check(wire(legacy));assert.equal(oldChecked.ok,true,JSON.stringify(oldChecked));
assert.deepEqual(oldChecked.payload.periodsCovered,['UNKNOWN']);
const forged=structuredClone(wire(unknown));forged.games[0].markets[0].period='FT';forged.games[0].markets[0].periodEvidence={sectionTitle:'全場',period:'FT',status:'EXPLICIT'};
assert.equal(check(forged).ok,false,'client assertions cannot create period evidence');
const forgedServer=structuredClone(wire(mixed));forgedServer.games[0].markets[0].serverObservation={observedAt:at};assert.equal(check(forgedServer).ok,false);
const oversize=structuredClone(wire(mixed));oversize.sourceCapture.tables[0].sectionTitle='全場'.repeat(130);assert.ok(check(oversize).errors.includes('SOCCER_READER_PERIOD_TITLE_INVALID'));
const malformed={...wire(mixed),games:{}};assert.equal(check(malformed).ok,false);
console.log('PASS unchanged legacy canonical/hash, installed old-wire acceptance as UNKNOWN, server reparse rejection of forged period/provenance and bounded raw title validation');

const fragments=[];const add=(text,top,left)=>fragments.push({text,top,left});
for(const [text,left]of [['全場讓球',500],['全場大小',700],['上半場讓球',900],['上半場大小',1100]])add(text,0,left);
add('10/18 21:00 (GMT+8)',70,40);add('白禮頓[主]',160,40);add('水晶宮',330,40);
for(const [left,line,total]of [[500,'1平',false],[700,'3+50',true],[900,'0.5',false],[1100,'1+50',true]]){
  add(total?`大${line}`:line,160,left);add('0.63',230,left);if(total)add('小',400,left);add('1.27',470,left);
}
const normalized=globalThis.Tai888SoccerCardNormalizer.normalize([{label:'英格蘭超級聯賽',fragments}],'EPL');
assert.deepEqual(normalized.diagnostics.cardIssues,[]);assert.equal(normalized.tables.length,2);
assert.equal(normalized.diagnostics.expectedGameCount,1);assert.equal(normalized.diagnostics.gameCount,1,'period and alternative rows do not multiply fixture count');
const geometry=parse(capture(normalized.tables));assert.deepEqual(geometry.periodsCovered,['FT','HT']);assert.equal(geometry.games[0].markets.length,4);
assert.equal(check(wire(geometry)).ok,true);
for(const foreign of ['英格蘭超級聯賽盃U21','English Premier League 2','EPL Reserve']){
  const mixedSection=globalThis.Tai888SoccerCardNormalizer.normalize([{label:'英格蘭超級聯賽',
    fragments:[...fragments,{text:foreign,left:40,top:100}]}],'EPL');
  assert.equal(mixedSection.tables.length,0,'a senior card cannot borrow a nested different-competition price');
  assert.ok(mixedSection.diagnostics.cardIssues.includes('SOCCER_MIXED_LEAGUE_SECTION'));
}
const desktopHeader={text:'時間 主客隊伍 讓球 大小盤',cells:['時間','主客隊伍','讓球','大小盤']
  .map((text,index)=>({text,left:index*100,right:(index+1)*100}))};
const desktopHeading=text=>({text,cells:[{text,left:0,right:400}]});
const desktopGame=top=>({text:'synthetic fixture',cells:[['10-18','21:00'],['水晶宮','白禮頓[主]'],
  ['1平 0.950','0.950'],['大2.5 0.940','小 0.940']].map((values,index)=>({
    text:values.join(' '),left:index*100,right:(index+1)*100,top,
    rows:values.map((text,row)=>({text,left:index*100,top:top+row*18})),
  }))});
const seniorDesktop=globalThis.Tai888SoccerTableNormalizer.normalize([[desktopHeader,
  desktopHeading('聯盟: 英格蘭超級聯賽(1)'),desktopGame(100)]],'EPL');
assert.equal(seniorDesktop.tables.flatMap(table=>table.rows).length,1,'positive synthetic desktop source is readable');
for(const foreign of ['聯盟: 英格蘭超級聯賽盃U21(12)','English Premier League 2','EPL Reserve']){
  const isolatedDesktop=globalThis.Tai888SoccerTableNormalizer.normalize([[desktopHeader,
    desktopHeading('聯盟: 英格蘭超級聯賽(1)'),desktopGame(100),desktopHeading(foreign),desktopGame(200)]],'EPL');
  assert.equal(isolatedDesktop.tables.flatMap(table=>table.rows).length,1,'foreign youth/cup/reserve rows do not borrow the previous senior table');
}
const dedicatedFragments=fragments.filter(part=>part.left<800).map(part=>({...part,text:part.text.replace('全場','')}));dedicatedFragments.push({text:'上半場',left:300,top:0});
const dedicated=globalThis.Tai888SoccerCardNormalizer.normalize([{label:'英格蘭超級聯賽',fragments:dedicatedFragments}],'EPL');
assert.ok(parse(capture(dedicated.tables)).games[0].markets.every(market=>market.period==='HT'),'a separate observed cell in the same physical table header is retained');
const content=fs.readFileSync(new URL('../reader/tai888-content.js',import.meta.url),'utf8');
const fingerprintSource=content.slice(content.indexOf('  function stableMarketFingerprint('),content.indexOf('\n  function captureNhlCards('));
const fingerprint=vm.runInNewContext(`${fingerprintSource}\nstableMarketFingerprint`);
const ftFingerprint={tables:[table('全場')]},htFingerprint={tables:[table('上半場')]};
assert.equal(fingerprint(ftFingerprint),fingerprint(htFingerprint),'other sports keep original cell-only fingerprint behavior');
assert.notEqual(fingerprint(ftFingerprint,{soccer:true}),fingerprint(htFingerprint,{soccer:true}),'football period changes update content activity even with identical prices');
console.log('PASS actual card normalizer preserves each original period header and responsive mixed-column price evidence through server reparse');

const official={league:'epl',date:'2026-10-18',id:'soccer:epl:123',startTime:'2026-10-18T13:00:00.000Z',status:'scheduled',home:{name:'Brighton & Hove Albion'},away:{name:'Crystal Palace'}};
const receipt={...mixed,revision:'reader-rev',observationId:'reader-obs',firstFetchedAt:at,receivedAt:at,persistedAt:at};
const matched=matchSoccerReaderGames(receipt,[official],now);
const distribution={period:'FT',retainedMass:.9,tailMass:.1,cells:[{home:0,away:0,probability:.1},{home:1,away:0,probability:.2},{home:2,away:0,probability:.3},{home:1,away:2,probability:.3}]};
const distributions={FT:distribution,HT:{...distribution,period:'HT'}};
const input={matchedGames:matched,reader:receipt,game:official,now,distributions};
const before=JSON.stringify(input),directions=buildSoccerMarketDirections(input);
assert.equal(directions.length,8);assert.equal(directions.find(d=>d.period==='FT'&&d.direction==='HANDICAP_HOME').quotes.length,2);
assert.ok(directions.every(d=>d.selectedQuoteKey===null&&d.quote===null&&d.W===null&&d.R===null&&d.score===null&&!d.eligible&&!d.executable));
assert.equal(JSON.stringify(input),before);
const handicap=directions.find(d=>d.period==='FT'&&d.direction==='HANDICAP_HOME').quotes.find(q=>q.line==='1平');
assert.equal(handicap.side,'home');assert.equal(handicap.water,.63);assert.equal(handicap.lineSide,'home');
assert.equal(handicap.thresholdProbabilities.axis,'GIVING_TEAM_MARGIN');near(handicap.thresholdProbabilities.above,.3);near(handicap.thresholdProbabilities.equal,.2);near(handicap.thresholdProbabilities.below,.4);
const total=directions.find(d=>d.period==='FT'&&d.direction==='TOTAL_UNDER').quotes.find(q=>q.line==='3+50');
assert.equal(total.water,1.28);assert.equal(total.thresholdProbabilities.axis,'TOTAL_GOALS');near(total.thresholdProbabilities.above,0);near(total.thresholdProbabilities.equal,.3);near(total.thresholdProbabilities.below,.6);near(total.thresholdProbabilities.tailMass,.1);
assert.equal(total.thresholdProbabilities.interpretation,'SCORE_THRESHOLD_ONLY_NOT_SETTLEMENT_PROBABILITY');assert.equal(total.profitP,undefined);assert.equal(total.EV,undefined);
const unknownDirections=buildSoccerMarketDirections({...input,matchedGames:matchSoccerReaderGames({...receipt,games:unknown.games},[official],now)});
assert.ok(unknownDirections.every(d=>d.quotes.length===0));assert.equal(collectUnassignedSoccerQuotes(unknownDirections).length,4);
assert.equal(collectUnassignedSoccerQuotes({...input,matchedGames:matchSoccerReaderGames({...receipt,games:unknown.games},[official],now)}).length,4);
assert.ok(collectUnassignedSoccerQuotes(unknownDirections).every(q=>q.thresholdProbabilities===null));
const variant=transform=>{const value=structuredClone(input);transform(value);return buildSoccerMarketDirections(value);};
const quoteOf=values=>values.find(d=>d.period==='FT'&&d.direction==='HANDICAP_HOME').quotes.find(q=>q.line==='1平');
const reverse=variant(v=>{v.matchedGames[0].markets.find(m=>m.period==='FT'&&m.line==='1平').lineSide='away';});
near(quoteOf(reverse).thresholdProbabilities.equal,.3);near(quoteOf(reverse).thresholdProbabilities.above,0);
assert.equal(quoteOf(variant(v=>v.distributions.FT.retainedMass=.95)).thresholdProbabilities,null);
assert.equal(quoteOf(variant(v=>v.distributions.FT.cells[0].probability=-.1)).thresholdProbabilities,null);
assert.equal(quoteOf(variant(v=>v.distributions.FT.period='HT')).thresholdProbabilities,null);
const splitline=variant(v=>{v.matchedGames[0].markets.find(m=>m.period==='FT'&&m.line==='1平').line='0.5/1';});
assert.equal(splitline.find(d=>d.period==='FT'&&d.direction==='HANDICAP_HOME').quotes.find(q=>q.line==='0.5/1').thresholdProbabilities,null);
const stale=variant(v=>v.reader.observedAt=new Date(now-180001).toISOString());assert.equal(quoteOf(stale).thresholdProbabilities,null);
const future=variant(v=>v.reader.receivedAt=new Date(now+1).toISOString());assert.ok(future.every(d=>!d.quotes.length));
const perScope=variant(v=>{
  v.reader.isPeriodAggregate=true;v.reader.sourceHost='do-not-borrow.invalid';v.reader.pageUrl='https://do-not-borrow.invalid/';v.reader.observedAt=new Date(now-180001).toISOString();v.matchedGames[0].fresh=false;
  for(const market of v.matchedGames[0].markets)market.serverObservation={observationId:market.period,revision:`rev:${market.period}`,observedAt:market.period==='FT'?at:new Date(now-180001).toISOString(),firstFetchedAt:at,receivedAt:at,persistedAt:at,...(market.period==='FT'?{sourceHost:'www.tai888.in',pageUrl:'https://www.tai888.in/newapp/ft'}:{})};
});
assert.equal(quoteOf(perScope).fresh,true,'fresh scope is not suppressed by stale bundle/game');
assert.equal(quoteOf(perScope).provenance.sourceUrl,'https://www.tai888.in/newapp/ft');
const htQuote=perScope.find(d=>d.period==='HT'&&d.direction==='HANDICAP_HOME').quotes[0];assert.equal(htQuote.fresh,false);assert.equal(htQuote.provenance.sourceHost,null);assert.equal(htQuote.provenance.sourceUrl,null);
const duplicate=variant(v=>v.matchedGames.push(structuredClone(v.matchedGames[0])));assert.equal(duplicate[0].quotes.length,directions[0].quotes.length);
const alternateSource=variant(v=>{const copy=structuredClone(v.matchedGames[0]);for(const market of copy.markets)market.serverObservation={observationId:'another-source',observedAt:at,firstFetchedAt:at};v.matchedGames.push(copy);});
assert.equal(alternateSource[0].quotes.length,4,'same line from different source observations remains traceable, never silently chosen');
console.log('PASS 8 exact direction/side pairings, all alternatives, unknown scope diagnostics, no auto-selection, conserved score thresholds/tails, complete line grammar, independent source freshness and quote provenance');
