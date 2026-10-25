import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseSoccerCapture, canonicalSoccerPayload } from '../reader/soccer-parser.js';
import { matchSoccerReaderGames, validateSoccerCapture, soccerReaderGameHasFreshGoalMarket } from '../lib/soccer/reader.js';
import { buildSoccerMarketDirections, collectUnassignedSoccerQuotes } from '../lib/soccer/market-directions.js';
import { adaptSoccerReaderQuote } from '../lib/soccer/soccer-scoring.js';
import { readSoccerReaderPeriodBinding, soccerMarketHasVerifiedPeriodResolution } from '../lib/soccer/reader-period-binding.js';

const envBefore=process.env.SOCCER_READER_PERIOD_BINDING_JSON;
const confirmedAt='2026-10-25T00:00:00.000Z',observedAt='2026-10-25T00:01:00.000Z',now=Date.parse('2026-10-25T00:01:02.000Z');
const deviceHash=createHash('sha256').update('synthetic-local-reader-device').digest('hex');
const config={version:'TAI888-ACCOUNT-PERIOD-BINDING-v1',profile:'TAI888-DESKTOP-PRIMARY-WITH-EXPLICIT-HT-v1',
  confirmedAt,sourceHost:'www.tai888.in',deviceHash,leagues:['epl','ucl'],proofKey:'a'.repeat(64)};
const setConfig=value=>{if(value===null)delete process.env.SOCCER_READER_PERIOD_BINDING_JSON;else process.env.SOCCER_READER_PERIOD_BINDING_JSON=JSON.stringify(value);};
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
  setConfig(null);assert.equal(readSoccerReaderPeriodBinding(),null);
  assert.deepEqual(periods(matched()),['UNKNOWN','UNKNOWN','HT','HT']);
  const original=JSON.stringify(reader),originalWire=canonicalSoccerPayload(wire);
  setConfig(config);
  const resolved=matched(),ft=resolved[0].markets.filter(market=>market.period==='FT');
  assert.equal(ft.length,2);assert.equal(resolved[0].matchStatus,'MATCHED');
  assert.ok(ft.every(market=>market.periodEvidence.status==='UNKNOWN'&&market.periodEvidence.period==='UNKNOWN'));
  assert.ok(ft.every(market=>soccerMarketHasVerifiedPeriodResolution(market,now)));
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
  setConfig(config);
  assert.equal(adaptSoccerReaderQuote({quote,game,now:now+180001}).ok,false,'account confirmation cannot freshen stale quotes');
  console.log('PASS server-owned football period binding: exact profile and companion HT, current account/host/device/receipt scope, HMAC revalidation, quote hash, no retroactive promotion, immutable Reader43 wire and unchanged betting gates');
} finally {if(envBefore===undefined)delete process.env.SOCCER_READER_PERIOD_BINDING_JSON;else process.env.SOCCER_READER_PERIOD_BINDING_JSON=envBefore;}
