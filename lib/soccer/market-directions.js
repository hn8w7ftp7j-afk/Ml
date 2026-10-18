import { createHash } from 'node:crypto';
import '../../reader/league-registry.js';

export const SOCCER_MARKET_DIRECTIONS_VERSION='SOCCER-SCOPED-RAW-DIRECTIONS-v1';
const periods=['FT','HT'];
const slots=[['HANDICAP_HOME','HANDICAP','home'],['HANDICAP_AWAY','HANDICAP','away'],['TOTAL_OVER','TOTAL','over'],['TOTAL_UNDER','TOTAL','under']];
const linePattern=/^(\d+(?:\.\d+)?)(?:平|[+-]\d{1,3})?$/;
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unique=values=>[...new Map(values.map(value=>[value.sourceQuoteKey,value])).values()];

function scope(market){
  const proof=market.periodEvidence;
  if(!proof)return{period:'UNKNOWN',status:'UNKNOWN',sectionTitle:'',tableHeaders:[],marketHeader:null};
  const parsed=globalThis.Tai888LeagueRegistry.soccerPeriodEvidence({sectionTitle:proof.sectionTitle,headers:proof.tableHeaders,marketHeader:proof.marketHeader,truncated:proof.truncated});
  if(parsed.status==='EXCLUDED')return parsed;
  return parsed.status==='EXPLICIT'&&parsed.period===market.period?parsed:{...parsed,period:'UNKNOWN',status:parsed.status==='CONFLICT'?'CONFLICT':'UNKNOWN'};
}

function distributionFor(distributions,period,game){
  const value=distributions?.[period];
  if(!value||!Array.isArray(value.cells)||!value.cells.length||!Number.isFinite(value.retainedMass)||!Number.isFinite(value.tailMass)||value.retainedMass<0||value.tailMass<0)return null;
  if(value.league&&value.league!==game.league||value.gameId&&value.gameId!==game.id)return null;
  const allowed=period==='FT'?['FT','REGULATION_FT']:['HT','REGULATION_HT','FIRST_HALF'];
  if(value.period&&!allowed.includes(value.period))return null;
  let sum=0;const seen=new Set();
  for(const cell of value.cells){
    if(!Number.isInteger(cell.home)||cell.home<0||!Number.isInteger(cell.away)||cell.away<0||!Number.isFinite(cell.probability)||cell.probability<0||cell.probability>1)return null;
    const key=`${cell.home}:${cell.away}`;if(seen.has(key))return null;seen.add(key);sum+=cell.probability;
  }
  if(Math.abs(sum-value.retainedMass)>1e-10||Math.abs(sum+value.tailMass-1)>1e-10)return null;
  return value;
}

function threshold(market,period,distributions,game){
  const match=typeof market.line==='string'?market.line.match(linePattern):null;
  if(!match||!periods.includes(period))return null;
  const boundary=Number(match[1]),distribution=distributionFor(distributions,period,game);
  if(!Number.isFinite(boundary)||!distribution||market.kind==='HANDICAP'&&!['home','away'].includes(market.lineSide))return null;
  let above=0,equal=0,below=0;
  for(const cell of distribution.cells){
    const value=market.kind==='TOTAL'?cell.home+cell.away:market.lineSide==='home'?cell.home-cell.away:cell.away-cell.home;
    if(value>boundary)above+=cell.probability;else if(value===boundary)equal+=cell.probability;else below+=cell.probability;
  }
  const noun=market.kind==='TOTAL'?'總進球':`${market.lineSide==='home'?'主隊':'客隊'}（讓球方）淨勝球`;
  return{axis:market.kind==='TOTAL'?'TOTAL_GOALS':'GIVING_TEAM_MARGIN',boundary,above,equal,below,
    retainedMass:distribution.retainedMass,tailMass:distribution.tailMass,
    labels:{above:`${noun}大於 ${boundary}`,equal:`${noun}等於 ${boundary}`,below:`${noun}小於 ${boundary}`},
    interpretation:'SCORE_THRESHOLD_ONLY_NOT_SETTLEMENT_PROBABILITY'};
}

function collect({matchedGames=[],reader=null,game,now=Date.now(),distributions=null}={}){
  if(!game||!['epl','ucl'].includes(game.league)||!game.id?.startsWith(`soccer:${game.league}:`)||!Number.isFinite(now))return[];
  const result=[];
  for(const matched of matchedGames){
    if(matched?.officialGameId!==game.id||matched.matchStatus&&matched.matchStatus!=='MATCHED'||String(matched.league||'').toLowerCase()!==game.league||matched.boardDate!==game.date)continue;
    for(const market of matched.markets||[]){
      if(market.unit!=='GOALS'||!['HANDICAP','TOTAL'].includes(market.kind)||typeof market.line!=='string'||market.kind==='HANDICAP'&&!['home','away'].includes(market.lineSide))continue;
      const periodEvidence=scope(market);if(periodEvidence.status==='EXCLUDED')continue;
      const observation=market.serverObservation||{};
      const provenance={gameId:game.id,readerRevision:observation.revision||reader?.revision||null,readerObservationId:observation.observationId||reader?.observationId||null,
        observedAt:observation.observedAt||reader?.observedAt||null,firstFetchedAt:observation.firstFetchedAt||reader?.firstFetchedAt||null,
        receivedAt:observation.receivedAt||reader?.receivedAt||null,persistedAt:observation.persistedAt||reader?.persistedAt||null,
        sourceHost:observation.sourceHost||(!reader?.isPeriodAggregate?reader?.sourceHost:null)||null,
        sourceUrl:observation.pageUrl||(!reader?.isPeriodAggregate?reader?.pageUrl:null)||null,periodEvidence};
      if([provenance.firstFetchedAt,provenance.receivedAt].some(time=>time&&(!Number.isFinite(Date.parse(time))||Date.parse(time)>now)))continue;
      const observed=Date.parse(provenance.observedAt||''),fresh=Number.isFinite(observed)&&observed<=now&&now-observed<=180000;
      const prestart=game.status==='scheduled'&&Date.parse(game.startTime)>now&&matched.prestart!==false;
      for(const side of market.kind==='HANDICAP'?['home','away']:['over','under']){
        const water=market[`${side}Water`];if(!Number.isFinite(water)||water<=0||water>1000)continue;
        const period=periodEvidence.period,rawRows=Array.isArray(market.rawRows)?market.rawRows.map(String):[];
        const marketKey=[game.id,period,market.kind,market.line,market.lineSide||'',side].join(':');
        const sourceQuoteKey=hash({marketKey,water,rawRows,provenance});
        result.push({key:sourceQuoteKey,sourceQuoteKey,marketKey,period,kind:market.kind,unit:'GOALS',line:market.line,lineSide:market.lineSide||null,side,water,rawRows,provenance,fresh,prestart,
          label:market.kind==='TOTAL'?`${side==='over'?'大':'小'} ${market.line}`:`${side==='home'?'主隊':'客隊'}${side===market.lineSide?'讓':'受讓'} ${market.line}`,
          thresholdProbabilities:periods.includes(period)&&fresh&&prestart?threshold(market,period,distributions,game):null,
          settlementStatus:'PROVIDER_RULES_UNVERIFIED',eligible:false,executable:false});
      }
    }
  }
  return unique(result).sort((a,b)=>a.marketKey.localeCompare(b.marketKey)||a.sourceQuoteKey.localeCompare(b.sourceQuoteKey));
}

export function buildSoccerMarketDirections(input={}){
  const all=collect(input);
  return periods.flatMap(period=>slots.map(([direction,kind,side])=>{
    const quotes=all.filter(quote=>quote.period===period&&quote.kind===kind&&quote.side===side);
    const unknownPeriodQuotes=all.filter(quote=>quote.period==='UNKNOWN'&&quote.kind===kind&&quote.side===side);
    const reasons=[];
    if(!quotes.length)reasons.push(unknownPeriodQuotes.length?'SOCCER_PERIOD_UNVERIFIED':'MATCHED_READER_QUOTE_MISSING');
    if(quotes.some(quote=>!quote.fresh))reasons.push('READER_QUOTE_STALE');
    if(quotes.some(quote=>!quote.prestart))reasons.push('MATCH_ALREADY_STARTED');
    reasons.push('SOCCER_PERIOD_SETTLEMENT_REBATE_UNVERIFIED');
    return{period,direction,quotes,unknownPeriodQuotes,selectedQuoteKey:null,quote:null,
      quoteStatus:quotes.length?(quotes.every(quote=>quote.fresh&&quote.prestart)?'AVAILABLE':'STALE_OR_CLOSED'):unknownPeriodQuotes.length?'PERIOD_UNVERIFIED':'MISSING',
      W:null,R:null,score:null,eligible:false,executable:false,reasons};
  }));
}

export function collectUnassignedSoccerQuotes(input={}){
  return Array.isArray(input)?unique(input.flatMap(direction=>direction.unknownPeriodQuotes||[])):collect(input).filter(quote=>quote.period==='UNKNOWN');
}
