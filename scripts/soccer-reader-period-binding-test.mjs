import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseSoccerCapture, canonicalSoccerPayload } from '../reader/soccer-parser.js';
import { matchSoccerReaderGames, validateSoccerCapture, soccerReaderGameHasFreshGoalMarket } from '../lib/soccer/reader.js';
import { buildSoccerMarketDirections, collectUnassignedSoccerQuotes } from '../lib/soccer/market-directions.js';
import { adaptSoccerReaderQuote } from '../lib/soccer/soccer-scoring.js';
import { readSoccerReaderPeriodBinding, soccerMarketHasVerifiedPeriodResolution, soccerReaderPeriodBindingDiagnostics } from '../lib/soccer/reader-period-binding.js';

const envBefore=process.env.SOCCER_READER_PERIOD_BINDING_JSON;
const additionalEnvBefore=process.env.SOCCER_READER_PERIOD_BINDING_ADDITIONAL_JSON;
const confirmedAt='2026-10-25T00:00:00.000Z',observedAt='2026-10-25T00:01:00.000Z',now=Date.parse('2026-10-25T00:01:02.000Z');
const deviceHash=createHash('sha256').update('synthetic-local-reader-device').digest('hex');
const config={version:'TAI888-ACCOUNT-PERIOD-BINDING-v1',profile:'TAI888-DESKTOP-PRIMARY-WITH-EXPLICIT-HT-v1',
  confirmedAt,sourceHost:'www.tai888.in',deviceHash,leagues:['epl','ucl'],proofKey:'a'.repeat(64)};
const setConfig=value=>{if(value===null)delete process.env.SOCCER_READER_PERIOD_BINDING_JSON;else process.env.SOCCER_READER_PERIOD_BINDING_JSON=JSON.stringify(value);};
const setAdditional=value=>{if(value===null)delete process.env.SOCCER_READER_PERIOD_BINDING_ADDITIONAL_JSON;else process.env.SOCCER_READER_PERIOD_BINDING_ADDITIONAL_JSON=JSON.stringify(value);};
const tables=[
  {headers:['時間','主客隊伍','讓球','大小盤','獨贏','單雙','備註'],sectionTitle:'聯盟: 英格蘭超級聯賽(25)'},
  {headers:['時間','主客隊伍','上半讓球','上半大小','','單雙','備註'],sectionTitle:'聯盟: 英格蘭超級聯賽(25)'},
].map(table=>({...table,rows:[{cells:[{pair:['10-25','22:00']},{pair:['賓福特','侯城[主]']},
  {pair:['1+50 0.91','0.97']},{pair:['大3+50 0.85','小 1.01']},{pair:['主勝 -','和 -','客勝 -']}]}]}));
const capture={league:'EPL',pageLeagueLabel:'聯盟: 英格蘭超級聯賽(25)',sourceHost:config.sourceHost,pageUrl:'https://www.tai888.in/newapp/',observedAt,tables};
const wire={...parseSoccerCapture(capture,new Date(observedAt)),readerVersion:'2.1.43',pageActivityAt:observedAt};
const checked=validateSoccerCapture(wire,{now,headerVersion:'2.1.43'});assert.equal(checked.ok,true,JSON.stringify(checked));
const observation={observationId:'b'.repeat(64),revision:'b'.repeat(64),observedAt,firstFetchedAt:'2026-10-24T22:00:00.000Z',
  receivedAt:'2026-10-25T00:01:00.100Z',persistedAt:'2026-10-25T00:01:00.200Z',sourceHost:config.sourceHost,pageUrl:capture.pageUrl,deviceHash};
const reader={...checked.payload,isPeriodAggregate:true,revision:'c'.repeat(64),games:checked.payload.games.map(game=>({...game,
  markets:game.markets.map(market=>({...market,serverObservation:{...observation}}))}))};
const game={id:'soccer:epl:401878766',sourceId:'401878766',league:'epl',date:'2026-10-25',startTime:'2026-10-25T14:00:00.000Z',status:'scheduled',
  home:{sourceId:'306',name:'Hull City'},away:{sourceId:'337',name:'Brentford'}};
const matched=(value=reader,at=now)=>matchSoccerReaderGames(value,[game],at);
const quotes=(value=reader,at=now)=>buildSoccerMarketDirections({reader:value,matchedGames:matched(value,at),game,now:at}).flatMap(direction=>direction.quotes);
const periods=value=>value[0].markets.map(market=>market.period);
try {
  setAdditional(null);
  setConfig(null);assert.equal(readSoccerReaderPeriodBinding(),null);
  assert.deepEqual(periods(matched()),['UNKNOWN','UNKNOWN','HT','HT']);
  const diagnosis=()=>soccerReaderPeriodBindingDiagnostics(matched(),reader,now);
  assert.deepEqual(diagnosis().blockerCounts,{CONFIG_MISSING:2});
  setConfig('broken');assert.equal(diagnosis().configurationStatus,'INVALID');assert.deepEqual(diagnosis().blockerCounts,{CONFIG_INVALID:2});
  const original=JSON.stringify(reader),originalWire=canonicalSoccerPayload(wire);
  setConfig(config);
  const resolved=matched(),ft=resolved[0].markets.filter(market=>market.period==='FT');
  assert.equal(ft.length,2);assert.equal(resolved[0].matchStatus,'MATCHED');
  assert.ok(ft.every(market=>market.periodEvidence.status==='UNKNOWN'&&market.periodEvidence.period==='UNKNOWN'));
  assert.ok(ft.every(market=>soccerMarketHasVerifiedPeriodResolution(market,now)));
  assert.deepEqual(diagnosis(),{version:'SOCCER-PERIOD-BINDING-DIAGNOSTICS-v1',configurationStatus:'READY',additionalConfigurationStatus:'MISSING',candidateMarketCount:2,resolvedMarketCount:2,blockedMarketCount:0,blockerCounts:{}});
  assert.ok(!JSON.stringify(diagnosis()).includes(config.proofKey)&&!JSON.stringify(diagnosis()).includes(config.deviceHash),'diagnostics disclose neither key nor device identity');
  assert.equal(soccerReaderGameHasFreshGoalMarket({markets:ft},reader,now),true);
  const directions=buildSoccerMarketDirections({reader,matchedGames:resolved,game,now});
  assert.equal(directions.filter(direction=>direction.period==='FT').flatMap(direction=>direction.quotes).length,4);
  assert.equal(collectUnassignedSoccerQuotes({reader,matchedGames:resolved,game,now}).length,0);
  const currentQuotes=quotes();
  assert.equal(currentQuotes.length,8);
  for(const quote of currentQuotes)assert.equal(adaptSoccerReaderQuote({quote,game,now}).ok,true,quote.period);
  const quote=currentQuotes.find(value=>value.period==='FT');
  const reverseKeys=value=>Array.isArray(value)?value.map(reverseKeys):value&&typeof value==='object'
    ?Object.fromEntries(Object.entries(value).reverse().map(([key,item])=>[key,reverseKeys(item)])):value;
  assert.equal(adaptSoccerReaderQuote({quote:reverseKeys(quote),game,now}).ok,true,'JSONB key order cannot invalidate a signed resolution or its original quote hash');
  for(const patch of [
    {line:'2平'},{water:.99},{rawRows:['2平 0.91','0.97']},
    {provenance:{...quote.provenance,readerObservationId:'d'.repeat(64)}},
    {provenance:{...quote.provenance,sourceUrl:'https://www.tai888.in/unrelated/'}},
    {provenance:{...quote.provenance,periodResolution:{...quote.provenance.periodResolution,resolvedPeriod:'HT'}}},
    {provenance:{...quote.provenance,periodResolution:{...quote.provenance.periodResolution,signature:'e'.repeat(64)}}},
  ])assert.equal(adaptSoccerReaderQuote({quote:{...quote,...patch},game,now}).ok,false);
  assert.equal(adaptSoccerReaderQuote({quote,game:{...game,id:'soccer:epl:999',sourceId:'999'},now}).ok,false);
  assert.equal(adaptSoccerReaderQuote({quote,game:{...game,startTime:'2026-10-25T15:00:00.000Z'},now}).ok,false,'a changed kickoff cannot reuse an old account binding');
  assert.equal(JSON.stringify(reader),original);assert.equal(canonicalSoccerPayload(wire),originalWire);
  assert.equal(ft.some(market=>JSON.stringify(market.periodResolution).includes(config.proofKey)),false,'private signing key is never serialized');
  assert.ok(currentQuotes.every(value=>value.eligible===false&&value.executable===false),'period binding cannot authorize a wager');

  const separateFirstReceipts=structuredClone(reader);
  separateFirstReceipts.games[0].markets.forEach(market=>{if(market.period==='HT')market.serverObservation.firstFetchedAt='2026-10-24T23:00:00.000Z';});
  assert.equal(periods(matched(separateFirstReceipts)).filter(period=>period==='FT').length,2,'period content can first appear at different times in the same capture');
  const separatelyTimedQuotes=quotes(separateFirstReceipts);
  assert.ok(separatelyTimedQuotes.filter(value=>value.period==='FT').every(value=>value.provenance.firstFetchedAt===observation.firstFetchedAt));
  assert.ok(separatelyTimedQuotes.filter(value=>value.period==='HT').every(value=>value.provenance.firstFetchedAt==='2026-10-24T23:00:00.000Z'));
  assert.ok(separatelyTimedQuotes.every(value=>adaptSoccerReaderQuote({quote:value,game,now}).ok));

  const rejectReader=mutate=>{const changed=structuredClone(reader);mutate(changed);assert.equal(periods(matched(changed)).includes('FT'),false);};
  rejectReader(value=>value.games[0].markets.forEach(market=>{market.serverObservation.deviceHash='d'.repeat(64);}));
  rejectReader(value=>value.games[0].markets.forEach(market=>{market.serverObservation.sourceHost='another.tai888.in';}));
  rejectReader(value=>value.games[0].markets.forEach(market=>{market.serverObservation.observedAt='2026-10-24T23:59:59.000Z';}));
  rejectReader(value=>value.games[0].markets.forEach(market=>{market.serverObservation.receivedAt='2026-10-24T23:59:59.000Z';}));
  rejectReader(value=>value.games[0].markets.forEach(market=>{market.serverObservation.persistedAt='2026-10-24T23:59:59.000Z';}));
  rejectReader(value=>value.games[0].markets.forEach(market=>{delete market.serverObservation.deviceHash;}));
  rejectReader(value=>value.games[0].markets.forEach(market=>{if(market.period==='HT')market.serverObservation.observationId='f'.repeat(64);}));
  rejectReader(value=>value.games[0].markets.forEach(market=>{if(market.period==='HT')market.serverObservation.firstFetchedAt='2026-10-25T00:01:01.000Z';}));
  rejectReader(value=>value.games[0].markets.forEach(market=>{if(market.period==='HT')market.serverObservation.firstFetchedAt='invalid';}));
  rejectReader(value=>{value.games[0].markets=value.games[0].markets.filter(market=>market.period!=='HT');});
  rejectReader(value=>value.games[0].markets.forEach(market=>{if(market.period==='UNKNOWN')market.periodEvidence.tableHeaders[0]='其他';}));
  rejectReader(value=>value.games[0].markets.forEach(market=>{if(market.period==='UNKNOWN')market.periodEvidence.sectionTitle='英超 走地';}));
  for(const bad of [{...config,proofKey:''},{...config,sourceHost:'tai888.in'},{...config,leagues:['nba']},{...config,confirmedAt:'invalid'}]){
    setConfig(bad);assert.equal(periods(matched()).includes('FT'),false);
  }
  setConfig({...config,proofKey:'f'.repeat(64)});
  assert.equal(adaptSoccerReaderQuote({quote,game,now}).ok,false,'private config key rotation invalidates old claims');
  setConfig({...config,confirmedAt:'2026-10-25T00:02:00.000Z'});
  assert.equal(periods(matched()).includes('FT'),false,'confirmation is never backdated into an older observation');
  assert.deepEqual(diagnosis().blockerCounts,{CONFIRMATION_NOT_EFFECTIVE:2});
  setConfig({...config,deviceHash:'d'.repeat(64)});assert.deepEqual(diagnosis().blockerCounts,{SOURCE_DEVICE_MISMATCH:2});
  setConfig({...config,leagues:['ucl']});assert.deepEqual(diagnosis().blockerCounts,{LEAGUE_NOT_BOUND:2});
  setConfig(config);
  const noHalf=structuredClone(reader);noHalf.games[0].markets=noHalf.games[0].markets.filter(market=>market.period!=='HT');
  assert.deepEqual(soccerReaderPeriodBindingDiagnostics(matched(noHalf),noHalf,now).blockerCounts,{SAME_CAPTURE_HALF_MISSING:2});
  const noMatch=matchSoccerReaderGames(reader,[],now);assert.deepEqual(soccerReaderPeriodBindingDiagnostics(noMatch,reader,now).blockerCounts,{GAME_NOT_MATCHED:2});
  assert.equal(adaptSoccerReaderQuote({quote,game,now:now+180001}).ok,false,'account confirmation cannot freshen stale quotes');

  // Adding a new device is forward-only and keeps the original private key and
  // its historical signed resolutions. All identities below are synthetic.
  const nextConfig={...config,deviceHash:createHash('sha256').update('synthetic-second-reader-device').digest('hex'),
    proofKey:'1'.repeat(64),confirmedAt:'2026-10-25T00:01:30.000Z'};
  const nextAt=Date.parse('2026-10-25T00:02:02.000Z'),nextReader=structuredClone(reader);
  nextReader.games[0].markets.forEach(market=>Object.assign(market.serverObservation,{deviceHash:nextConfig.deviceHash,
    observationId:'2'.repeat(64),revision:'2'.repeat(64),observedAt:'2026-10-25T00:02:00.000Z',firstFetchedAt:'2026-10-25T00:02:00.050Z',
    receivedAt:'2026-10-25T00:02:00.100Z',persistedAt:'2026-10-25T00:02:00.200Z'}));
  setAdditional([nextConfig]);
  assert.deepEqual(readSoccerReaderPeriodBinding(),config,'the legacy primary export still returns exactly the original configuration');
  assert.deepEqual(matched(reader,nextAt),resolved,'adding another device does not rewrite or resign the original resolution');
  assert.equal(adaptSoccerReaderQuote({quote,game,now:nextAt}).ok,true,'a previously signed original-device quote remains valid');
  const nextMatched=matched(nextReader,nextAt),nextQuotes=quotes(nextReader,nextAt),nextQuote=nextQuotes.find(value=>value.period==='FT');
  assert.equal(periods(nextMatched).filter(value=>value==='FT').length,2);
  assert.ok(nextMatched[0].markets.filter(market=>market.period==='FT').every(market=>soccerMarketHasVerifiedPeriodResolution(market,nextAt)));
  assert.ok(nextQuotes.every(value=>adaptSoccerReaderQuote({quote:value,game,now:nextAt}).ok));
  const nextDiagnosis=()=>soccerReaderPeriodBindingDiagnostics(matched(nextReader,nextAt),nextReader,nextAt);
  assert.equal(nextDiagnosis().additionalConfigurationStatus,'READY');assert.equal(nextDiagnosis().resolvedMarketCount,2);assert.deepEqual(nextDiagnosis().blockerCounts,{});
  for(const privateValue of [config.proofKey,config.deviceHash,nextConfig.proofKey,nextConfig.deviceHash])assert.equal(JSON.stringify(nextDiagnosis()).includes(privateValue),false);
  const mixedReader=structuredClone(nextReader);mixedReader.games[0].markets.forEach((market,index)=>{if(market.period==='HT')market.serverObservation=structuredClone(reader.games[0].markets[index].serverObservation);});
  assert.equal(periods(matched(mixedReader,nextAt)).includes('FT'),false,'a companion on another registered device cannot confirm this capture');
  assert.deepEqual(soccerReaderPeriodBindingDiagnostics(matched(mixedReader,nextAt),mixedReader,nextAt).blockerCounts,{SAME_CAPTURE_HALF_MISSING:2});
  for(const key of ['observedAt','receivedAt','persistedAt']){
    const earlier=structuredClone(nextReader);earlier.games[0].markets.forEach(market=>{market.serverObservation[key]='2026-10-25T00:01:29.000Z';});
    assert.equal(periods(matched(earlier,nextAt)).includes('FT'),false,`${key} before the new-device confirmation cannot use the original-device binding`);
    assert.deepEqual(soccerReaderPeriodBindingDiagnostics(matched(earlier,nextAt),earlier,nextAt).blockerCounts,{OBSERVATION_BEFORE_CONFIRMATION:2});
  }
  const wrongConfigHash=structuredClone(nextQuote);wrongConfigHash.provenance.periodResolution.configHash=quote.provenance.periodResolution.configHash;
  assert.equal(adaptSoccerReaderQuote({quote:wrongConfigHash,game,now:nextAt}).ok,false,'a second-device signature cannot be verified under the original binding');
  const wrongSignature=structuredClone(nextQuote);wrongSignature.provenance.periodResolution.signature=quote.provenance.periodResolution.signature;
  assert.equal(adaptSoccerReaderQuote({quote:wrongSignature,game,now:nextAt}).ok,false,'signatures from registered devices are not interchangeable');
  setAdditional(null);assert.equal(adaptSoccerReaderQuote({quote:nextQuote,game,now:nextAt}).ok,false);
  assert.equal(adaptSoccerReaderQuote({quote,game,now:nextAt}).ok,true);

  const additionalFixtures=Array.from({length:7},(_,index)=>({...nextConfig,
    deviceHash:createHash('sha256').update(`synthetic-additional-device-${index}`).digest('hex')}));
  additionalFixtures[0]=nextConfig;
  setAdditional(additionalFixtures);assert.equal(nextDiagnosis().additionalConfigurationStatus,'READY');assert.equal(nextDiagnosis().resolvedMarketCount,2,'one primary plus seven additions reaches the eight-binding limit');
  for(const invalid of ['not-an-array',[{...nextConfig,proofKey:''}],[nextConfig,{...nextConfig,proofKey:'3'.repeat(64)}],[config],
    [...additionalFixtures,{...nextConfig,deviceHash:'4'.repeat(64)}]]){
    setAdditional(invalid);
    assert.equal(nextDiagnosis().additionalConfigurationStatus,'INVALID');assert.equal(nextDiagnosis().configurationStatus,'READY');
    assert.deepEqual(nextDiagnosis().blockerCounts,{SOURCE_DEVICE_MISMATCH:2});
    assert.deepEqual(matched(reader,nextAt),resolved,'invalid additional batches cannot disable or replace the primary binding');
    assert.equal(adaptSoccerReaderQuote({quote,game,now:nextAt}).ok,true);
    assert.equal(adaptSoccerReaderQuote({quote:nextQuote,game,now:nextAt}).ok,false);
  }
  process.env.SOCCER_READER_PERIOD_BINDING_ADDITIONAL_JSON='{invalid json';
  assert.equal(nextDiagnosis().additionalConfigurationStatus,'INVALID');assert.equal(adaptSoccerReaderQuote({quote,game,now:nextAt}).ok,true);
  setConfig(null);assert.equal(nextDiagnosis().configurationStatus,'INVALID','a present invalid additional setting is not reported as missing');
  setAdditional([nextConfig]);assert.equal(nextDiagnosis().resolvedMarketCount,2,'a valid explicitly registered additional device does not depend on a primary device');
  assert.equal(nextDiagnosis().configurationStatus,'READY');assert.equal(readSoccerReaderPeriodBinding(),null);
  setConfig(config);setAdditional(null);
  console.log('PASS server-owned football period binding: exact profile and companion HT, current account/host/device/receipt scope, HMAC revalidation, quote hash, no retroactive promotion, immutable Reader43 wire and unchanged betting gates');
  console.log('PASS additional private device bindings: forward-only device/host/league selection, preserved original signatures, eight-binding cap, all-or-nothing invalid/duplicate isolation and secret-free diagnostic states');
} finally {
  if(envBefore===undefined)delete process.env.SOCCER_READER_PERIOD_BINDING_JSON;else process.env.SOCCER_READER_PERIOD_BINDING_JSON=envBefore;
  if(additionalEnvBefore===undefined)delete process.env.SOCCER_READER_PERIOD_BINDING_ADDITIONAL_JSON;else process.env.SOCCER_READER_PERIOD_BINDING_ADDITIONAL_JSON=additionalEnvBefore;
}
