import { matchSoccerReaderGames, soccerReaderGameHasFreshGoalMarket } from './reader.js';
import { buildSoccerMarketDirections, collectUnassignedSoccerQuotes } from './market-directions.js';

export const SOCCER_READER_DIAGNOSTICS_VERSION='SOCCER-READER-DIAGNOSTICS-v1';
const countKeys=['capturedGames','matchedGames','capturedMarkets','matchedGoalMarkets','assignedQuotes','unassignedQuotes','freshPrematchQuotes'];
const openGoalMarket=market=>market?.unit==='GOALS'&&['HANDICAP','TOTAL'].includes(market.kind)
  &&typeof market.line==='string'&&market.line.length>0
  &&(market.kind!=='HANDICAP'||['home','away'].includes(market.lineSide))
  &&(market.kind==='HANDICAP'?['home','away']:['over','under']).some(side=>Number.isFinite(market[`${side}Water`])&&market[`${side}Water`]>0&&market[`${side}Water`]<=1000);

// Observational diagnostics only. Read failures are unknown counts, never an
// assertion that the user's Reader has no prices. No source/private error text
// or another board's identities leave this requested game/date scope.
export function buildSoccerReaderDiagnostics({reader=null,game,unavailable=false,now=Date.now()}={}){
  const result={version:SOCCER_READER_DIAGNOSTICS_VERSION,league:game?.league||null,date:game?.date||null,gameId:game?.id||null,
    status:null,code:null,counts:Object.fromEntries(countKeys.map(key=>[key,0])),confirmedPeriods:[],freshPeriods:[],executable:false};
  const finish=(status,code)=>({...result,status,code:`SOCCER_READER_${code}`});
  if(unavailable){result.counts=Object.fromEntries(countKeys.map(key=>[key,null]));return finish('UNAVAILABLE','STORAGE_UNAVAILABLE');}
  if(!reader)return finish('MISSING','CAPTURE_MISSING');
  if(!game||!['epl','ucl'].includes(game.league)||reader.league!==game.league.toUpperCase()||reader.boardDate!==game.date){
    result.counts=Object.fromEntries(countKeys.map(key=>[key,null]));return finish('SCOPE_MISMATCH','CAPTURE_SCOPE_MISMATCH');
  }
  const captured=Array.isArray(reader.games)?reader.games:[];
  result.counts.capturedGames=captured.length;
  result.counts.capturedMarkets=captured.reduce((sum,raw)=>sum+(Array.isArray(raw?.markets)?raw.markets.length:0),0);
  const matched=matchSoccerReaderGames(reader,[game],now).filter(raw=>raw.officialGameId===game.id&&raw.matchStatus==='MATCHED');
  result.counts.matchedGames=matched.length;
  if(!matched.length)return finish('UNMATCHED','GAME_UNMATCHED');
  result.counts.matchedGoalMarkets=matched.reduce((sum,raw)=>sum+(Array.isArray(raw.markets)?raw.markets.filter(openGoalMarket).length:0),0);
  if(!result.counts.matchedGoalMarkets)return finish('NO_OPEN_GOALS','NO_OPEN_GOAL_MARKET');
  const input={matchedGames:matched,reader,game,now},directions=buildSoccerMarketDirections(input);
  const assigned=directions.flatMap(direction=>direction.quotes||[]),unassigned=collectUnassignedSoccerQuotes(input);
  // Use the same original-market receipt checks as board selection. The raw
  // directions retain historical evidence and their compatibility freshness
  // field alone cannot certify an aggregate's own server receipt.
  const freshRows=matched.map(raw=>({...raw,markets:(raw.markets||[]).filter(market=>soccerReaderGameHasFreshGoalMarket({markets:[market]},reader,now))}));
  const freshKeys=new Set(buildSoccerMarketDirections({...input,matchedGames:freshRows}).flatMap(direction=>direction.quotes||[]).map(quote=>quote.key));
  const freshAssigned=assigned.filter(quote=>quote.fresh===true&&quote.prestart===true&&freshKeys.has(quote.key));
  result.counts.assignedQuotes=assigned.length;
  result.counts.unassignedQuotes=unassigned.length;
  result.counts.freshPrematchQuotes=freshAssigned.length;
  result.confirmedPeriods=['FT','HT'].filter(period=>assigned.some(quote=>quote.period===period));
  result.freshPeriods=['FT','HT'].filter(period=>freshAssigned.some(quote=>quote.period===period));
  if(!assigned.length)return unassigned.length?finish('PERIOD_UNCONFIRMED','PERIOD_UNCONFIRMED'):finish('UNUSABLE_CAPTURE','CAPTURE_UNUSABLE_AT_CUTOFF');
  if(game.status!=='scheduled'||!(Date.parse(game.startTime)>now))return finish('POSTSTART','MATCH_STARTED');
  if(!result.counts.freshPrematchQuotes)return assigned.some(quote=>quote.fresh===true&&quote.prestart===true)
    ?finish('UNUSABLE_CAPTURE','CAPTURE_UNUSABLE_AT_CUTOFF'):finish('STALE','QUOTES_STALE');
  return finish('READY','CAPTURE_READY');
}
