import { soccerForwardHash, validateSoccerForwardCapture } from './forward-validation.js';
import { canonicalSoccerMarketReturnCaptures } from './market-return-validation.js';
import { matchSoccerReaderGames } from './reader.js';
import { buildSoccerMarketDirections } from './market-directions.js';
import { adaptSoccerReaderQuote } from './soccer-scoring.js';
import { validSoccerDate } from './contracts.js';
import { soccerTeamLabel } from './team-labels.js';
import { loadSoccerRetrospectiveReaderReceipts } from './retrospective-reader-receipts.js';

// Private, in-process diagnostic. It does not fetch or save results, does not
// create a scored prediction, and must not be used as an acceptance registry.
const restrictions = Object.freeze({ formalEligible:false, calibrationEligible:false, promotionEligible:false,
  executable:false, OOS:false, historicalContractVerified:false, accountSettlementVerified:false, W:null, R:null, S:null });
const at = value => typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : NaN;
// ISO timestamps from PostgreSQL may have microseconds. Round *up* for the
// decision instant; source evidence itself stays byte-for-byte unchanged.
const ceilMs = value => { const n=at(value), f=typeof value==='string' && value.match(/\.(\d+)(?:Z|[+-]\d\d:\d\d)$/)?.[1];
  return Number.isFinite(n) ? n + (f && /[1-9]/.test(f.slice(3)) ? 1 : 0) : NaN; };
// Reader SQL preserves six-digit UTC clocks. Normalize before ordering so the
// earliest source/received/persisted maximum is not lost to Date's ms precision.
const microKey=value=>{const n=at(value);if(!Number.isFinite(n))return null;
  const fraction=value.match(/\.(\d+)(?:Z|[+-]\d\d:\d\d)$/)?.[1]||'';
  return `${new Date(n).toISOString().slice(0,19)}.${fraction.padEnd(6,'0').slice(0,6)}Z`;};
const price = (capture,quote) => [capture.league,capture.gameId,capture.period,capture.variant,capture.modelHash,
  quote.kind,quote.side,quote.line,quote.lineSide||null,quote.water,quote.unit];
const context = game => [game.id,game.league,game.date,game.startTime,game.home?.id,game.home?.sourceId,soccerTeamLabel(game.home),
  game.away?.id,game.away?.sourceId,soccerTeamLabel(game.away)];
const iso = n => new Date(n).toISOString();

/** Rows MUST come from the verified bounded single-statement Reader loader.
 * Captures MUST be the original hydrated DB captures; this function validates
 * them, but deliberately makes no claim their history is complete. It emits
 * hashes/times only and never returns source payloads, private device data, or
 * hypothetical payoff. Rules for pairing were chosen retrospectively. */
export function buildSoccerRetrospectivePairDiagnostic({league,date,protocol,captures=[],reader,now=Date.now()}={}) {
  const reasons={}, count=(reason,n=1)=>{reasons[reason]=(reasons[reason]||0)+n;};
  const base={version:'SOCCER-RETROSPECTIVE-PAIR-DIAGNOSTIC-v1',league,date,
    forecastCoverage:'NOT_VERIFIED', selectionTiming:'DEFINED_AFTER_HISTORY',
    priceDeduplication:'CONSERVATIVE_PRICE_FIELDS_IGNORE_SOURCE_DEVICE',
    identityScope:'UNIQUE_AMONG_LOADED_VALIDATED_FORECASTS',
    forecastReceiptPrecision:'MILLISECONDS_LOWER_BOUND_DECISION_CONSERVATIVELY_ROUNDED_UP',
    interpretation:'RESEARCH_PAIRING_ONLY_NOT_PREREGISTERED_OOS_NOT_ACTUAL_WAGER', ...restrictions};
  const result=(status,pairs=[],extra={})=>({...base,status,selectedPairCount:pairs.length,
    uniqueGames:new Set(pairs.map(row=>row.gameId)).size, pairs:pairs.slice(0,250),
    pairCountScope:status==='PARTIAL'?'PROVEN_SUBSET_ONLY':'THIS_DIAGNOSTIC_ONLY',
    pairDetailsTruncated:pairs.length>250, excludedReasons:reasons,...extra});
  if(reader?.status==='PARTIAL'){
    for(const reason of (reader.reasonCodes?.length?reader.reasonCodes:['READER_HISTORY_INCOMPLETE']))count(reason);
    return result('PARTIAL',[],{duplicatePriceCount:0});
  }
  if (!['epl','ucl'].includes(league)||!validSoccerDate(date)||!Number.isFinite(now)
    || !Array.isArray(captures)||captures.length>500||!reader||reader.status!=='COMPLETE'||!Array.isArray(reader.rows)||reader.rows.length>1000) {
    count('INCOMPLETE_OR_INVALID_INPUT'); return result('PARTIAL',[],{duplicatePriceCount:0});
  }
  const rows=reader.rows, valid=[], gamesById=new Map(), conflicts=new Set();
  for (const capture of captures) {
    if(capture?.league!==league||capture?.date!==date){count('FORECAST_SCOPE_MISMATCH');continue;}
    const checked=validateSoccerForwardCapture(capture,protocol,now);
    if(!checked.ok){count(checked.reason||'FORECAST_INVALID');continue;}
    const game=capture.snapshot.evidence.game, identity=soccerForwardHash(context(game));
    if(gamesById.has(game.id)&&gamesById.get(game.id).identity!==identity)conflicts.add(game.id);
    else gamesById.set(game.id,{identity,game});
    valid.push(capture);
  }
  const usable=valid.filter(c=>{if(!conflicts.has(c.gameId))return true;count('FORECAST_GAME_CONTEXT_CONFLICT');return false;})
    .sort((a,b)=>ceilMs(a.capturedAt)-ceilMs(b.capturedAt)||String(a.captureId).localeCompare(String(b.captureId)));
  // The capture loader exposes DB timestamps to milliseconds. Distinct
  // receipts at the same earliest millisecond have no provable order here;
  // never break that tie using captureId or pretend one came first.
  // Later captures remain available for excluding already-priced snapshots.
  const firstForecasts=new Map(),ambiguousFirst=new Set();
  for(const c of usable){const key=JSON.stringify([c.gameId,c.period,c.variant,c.modelHash]),first=firstForecasts.get(key);
    if(!first)firstForecasts.set(key,c);
    else if(ceilMs(c.capturedAt)===ceilMs(first.capturedAt)&&c.captureId!==first.captureId)ambiguousFirst.add(key);
  }
  for(const key of ambiguousFirst){firstForecasts.delete(key);count('FORECAST_TIME_TIE_AMBIGUOUS');}
  if(firstForecasts.size*rows.length>20000){count('PAIR_COMPARISON_BUDGET');return result('PARTIAL',[],{duplicatePriceCount:0});}
  const games=[...gamesById.values()].filter(({game})=>!conflicts.has(game.id)).map(({game})=>game);
  const originals=canonicalSoccerMarketReturnCaptures(usable,protocol,now), existing=new Set();
  const byId=new Map(usable.map(c=>[c.captureId,c]));
  for(const selected of originals.observations){const c=byId.get(selected.captureId);
    const q=(c?.snapshot?.directions||[]).flatMap(d=>d.quotes||[]).find(q=>q.key===selected.quoteKey);
    if(q)existing.add(soccerForwardHash(price(c,q)));
  }
  const available=row=>Math.max(...[row.sourceObservedAt,row.receivedAt,row.persistedAt].map(ceilMs));
  const exactAvailable=row=>{const times=[row.sourceObservedAt,row.receivedAt,row.persistedAt].map(microKey);
    return times.some(value=>!value)?'':times.sort().at(-1);};
  const timeValid=row=>{const [source,payloadSource,received,persisted]=
    [row?.sourceObservedAt,row?.payload?.observedAt,row?.receivedAt,row?.persistedAt].map(microKey);
    return Number.isFinite(available(row))&&Boolean(source&&payloadSource&&received&&persisted)
      &&source===payloadSource&&received<=persisted;};
  const sorted=[...rows].sort((a,b)=>exactAvailable(a).localeCompare(exactAvailable(b))||String(a.persistedAt).localeCompare(String(b.persistedAt))||String(a.observationId).localeCompare(String(b.observationId)));
  // Index prefix minima by availability; this computes true first receipt as
  // known at the decision without repeatedly scanning all raw history.
  const firstByPeriod=new Map();
  for(const row of sorted){
    if(row?.payload?.league!==league.toUpperCase()||row.payload?.boardDate!==date||!timeValid(row))continue;
    for(const period of row.periods||[]){
      const key=JSON.stringify([period.period,period.contentHash]),items=firstByPeriod.get(key)||[];
      const prior=items.at(-1)?.first,first=!prior||row.receivedAt<prior?row.receivedAt:prior;
      items.push({available:available(row),first});firstByPeriod.set(key,items);
    }
  }
  const firstReceipt=(period,decision)=>{
    const items=firstByPeriod.get(JSON.stringify([period.period,period.contentHash]))||[];
    let lo=0,hi=items.length;while(lo<hi){const mid=(lo+hi)>>>1;if(items[mid].available<=decision)lo=mid+1;else hi=mid;}
    return lo?items[lo-1].first:null;
  };
  const seen=new Set(), pairs=[]; let duplicatePriceCount=0;
  for(const row of sorted){
    if(row?.payload?.league!==league.toUpperCase()||row?.payload?.boardDate!==date){count('READER_SCOPE_MISMATCH');continue;}
    const sourceTimes=[row.sourceObservedAt,row.receivedAt,row.persistedAt].map(ceilMs);
    if(!timeValid(row)||sourceTimes.some(v=>!Number.isFinite(v))||!Array.isArray(row.periods)||!Array.isArray(row.payload.games)){
      count('READER_RECEIPT_TIME_INVALID');continue;
    }
    for(const c of firstForecasts.values()){
      const predictionAvailable=ceilMs(c.capturedAt)+1, start=at(c.snapshot.evidence.game.startTime);
      if(!Number.isFinite(predictionAvailable)||sourceTimes[0]<=predictionAvailable||sourceTimes[1]<=predictionAvailable){count('READER_NOT_AFTER_FORECAST');continue;}
      const decision=Math.max(predictionAvailable,...sourceTimes);
      if(decision>now){count('READER_DECISION_IN_FUTURE');continue;}
      if(!(decision<start)){count('READER_NOT_PRESTART');continue;}
      if(decision-sourceTimes[0]>=180000){count('READER_STALE_AT_DECISION');continue;}
      const enriched={...row.payload,revision:row.observationId,observationId:row.observationId,
        receivedAt:row.receivedAt,persistedAt:row.persistedAt,sourceObservedAt:row.sourceObservedAt,deviceHash:row.deviceHash,
        games:row.payload.games.map(raw=>({...raw,markets:(raw.markets||[]).map(market=>{
          const period=row.periods.find(p=>p.period===(market.period||'UNKNOWN'));
          if(!period)return {...market,serverObservation:null};
          const first=firstReceipt(period,decision);
          return {...market,serverObservation:{observationId:row.observationId,revision:row.observationId,
            observedAt:row.payload.observedAt,firstFetchedAt:first,receivedAt:row.receivedAt,persistedAt:row.persistedAt,
            sourceHost:row.payload.sourceHost||null,pageUrl:row.payload.pageUrl||null,deviceHash:row.deviceHash||null}};
        })}))};
      const matched=matchSoccerReaderGames(enriched,games,decision).filter(item=>item.officialGameId===c.gameId&&item.matchStatus==='MATCHED');
      if(matched.length!==1){count(matched.length?'READER_GAME_AMBIGUOUS':'READER_GAME_NOT_MATCHED');continue;}
      const dirs=buildSoccerMarketDirections({matchedGames:matched,reader:enriched,game:c.snapshot.evidence.game,now:decision});
      const period=c.period==='REGULATION_FT'?'FT':'HT'; let considered=0;
      for(const direction of dirs.filter(d=>d.period===period))for(const quote of direction.quotes){
        considered++; const check=adaptSoccerReaderQuote({quote,game:c.snapshot.evidence.game,now:decision});
        if(!check.ok){count(check.code);continue;}
        const key=soccerForwardHash(price(c,quote));
        if(existing.has(key)){count('ALREADY_IN_ORIGINAL_SNAPSHOT');continue;}
        if(seen.has(key)){duplicatePriceCount++;continue;}
        seen.add(key); pairs.push({pairId:soccerForwardHash([c.captureId,row.observationId,quote.key]),
          league,gameId:c.gameId,period,variant:c.variant,modelHash:c.modelHash,captureId:c.captureId,
          predictionRevision:c.revision,predictionAnalysisCutoff:c.snapshot.analysisCutoff,predictionCapturedAt:c.capturedAt,
          sourceObservationId:row.observationId,sourceObservedAt:row.sourceObservedAt,sourceReceivedAt:row.receivedAt,
          sourcePersistedAt:row.persistedAt,decisionAt:iso(decision),predictionAgeMs:decision-at(c.capturedAt),
          economicPriceHash:key,quoteHash:quote.key,kind:quote.kind,side:quote.side});
      }
      if(!considered)count('NO_ELIGIBLE_PERIOD_QUOTE');
    }
  }
  return result(ambiguousFirst.size?'PARTIAL':pairs.length?'RESEARCH_DIAGNOSTIC_AVAILABLE':'NO_ELIGIBLE_PAIRS',pairs,{duplicatePriceCount});
}

// This entry point obtains its Reader input only from the internal DB loader.
// Forecast history completeness remains intentionally unverified.
export async function diagnoseSoccerRetrospectivePairs({league,date,protocol,captures,now=Date.now(),readerLimits={maxRows:1000}}={}) {
  const reader=await loadSoccerRetrospectiveReaderReceipts(league,date,readerLimits);
  return buildSoccerRetrospectivePairDiagnostic({league,date,protocol,captures,reader,now});
}
