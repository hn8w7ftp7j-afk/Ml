import { deterministicScore } from '../deterministic-score.js';
import { soccerQuoteCandidateCurrent, soccerCandidatePayloadValid } from './candidate-qualification.js';
import { soccerMarketScorePresentations } from './score-presentation.js';
export const SOCCER_RANK_MARKETS = [['all','全部方向'],['FT:HANDICAP','全場讓球'],['FT:TOTAL','全場大小'],['HT:HANDICAP','上半讓球'],['HT:TOTAL','上半大小']];
export const soccerMarketName = (period,kind) => `${period==='HT'?'上半場':'全場'}${kind==='TOTAL'?'大小':'讓球'}`;
export function soccerResultCurrent(game,result,now=Date.now()) {
  return Boolean(result && result.gameId===game.id && result.league===game.league && result.date===game.date
    && result.publishedCurrent===true && result.persisted===true && result.analysisStatus==='COMPLETED'
    && game.status==='scheduled' && Date.parse(game.startTime)>now && Date.parse(result.observedAt)<=now
    && now-Date.parse(result.observedAt)<180000);
}
export function buildSoccerRanking(games,states,{now=Date.now(),market='all',includePrevious=false}={}) {
  const entries=[],seen=new Set(),presentations=new Map();
  function presentationFor(game,result,direction,quote) {
    if(!presentations.has(game))presentations.set(game,soccerMarketScorePresentations({result,displayGame:game,now}));
    return presentations.get(game).get(direction).get(quote);
  }
  let pendingGames=0,outdatedGames=0,currentGames=0;
  for(const game of games){
    if(!['epl','ucl'].includes(game?.league)||!game.id?.startsWith(`soccer:${game.league}:`)||seen.has(game.id))continue;
    // Rankings and their recovery notices concern only upcoming games.
    if(['live','final'].includes(game.status)||game.status==='scheduled'&&Date.parse(game.startTime)<=now)continue;
    seen.add(game.id);const state=states[game.id],result=state?.data;
    if(state?.status!=='done'||!result){pendingGames++;continue;}
    if(!soccerResultCurrent(game,result,now)){outdatedGames++;continue;}
    currentGames++;
    const original=result.evidence?.game;
    const formalPayloadValid=soccerCandidatePayloadValid(result,now);
    if(original?.sourceId!==game.sourceId
      ||!Number.isFinite(Date.parse(game.startTime))||Date.parse(original.startTime)!==Date.parse(game.startTime)
      ||!game.home?.sourceId||!game.away?.sourceId||original.home?.sourceId!==game.home.sourceId
      ||original.away?.sourceId!==game.away.sourceId||Boolean(original.neutralSite)!==Boolean(game.neutralSite))continue;
    for(const d of result.directions||[]){
      if(!['FT','HT'].includes(d.period)||!['HANDICAP_HOME','HANDICAP_AWAY','TOTAL_OVER','TOTAL_UNDER'].includes(d.direction))continue;
      const kind=d.direction.startsWith('TOTAL')?'TOTAL':'HANDICAP',marketKey=`${d.period}:${kind}`;
      if(market!=='all'&&market!==marketKey)continue;
      for(const quote of d.quotes||[]){
        const at=Date.parse(quote.provenance?.observedAt||'');
        if(quote.period!==d.period||quote.kind!==kind||quote.unit!=='GOALS'||quote.provenance?.gameId!==game.id
          ||quote.fresh!==true||quote.prestart!==true||!Number.isFinite(at)||at>now||now-at>=180000
          ||!Number.isFinite(quote.water)||quote.water<=0||!quote.key)continue;
        // Only explicit source-bound model predictions or existing formal
        // calculations can enter. Loose direction scores/1X2 never create S.
        const formal=formalPayloadValid&&result.formalScoringEnabled===true&&result.qualification?.eligible===true&&soccerQuoteCandidateCurrent(result,d,quote,{now});
        const presentation=!formal&&quote.predictionScore?presentationFor(game,result,d,quote):null;
        const prediction=presentation?.scoreKind==='PREDICTION'&&presentation.eligiblePrediction===true;
        const score=formal?quote.qualification.score:prediction?presentation.score:null,
          W=formal?quote.qualification.W:prediction?presentation.W:null,
          R=formal?quote.qualification.R:prediction?presentation.R_model:null;
        if(!((formal||prediction)&&score>=7.2&&W>0&&R>0))continue;
        const stableKey=`${game.id}:${d.period}:${d.direction}:${quote.key}`;
        if(entries.some(e=>e.stableKey===stableKey))continue;
        entries.push({stableKey,game,result,quote,marketKey,market:soccerMarketName(d.period,kind),score,W,R,
          candidate:true,...(prediction?{prediction:true,scoreKind:'PREDICTION',formalEligible:false}: {})});
      }
    }
  }
  const ranked = sortMarkets(entries);
  if (!includePrevious) return {...ranked,currentGames,pendingGames,outdatedGames};
  const previous = sortMarkets(previousPredictions(games,states,now,market,ranked.entries,presentationFor));
  return {...ranked,currentGames,pendingGames,outdatedGames,previousEntries:previous.entries,previousOrder:previous.order};
}

// The score and kickoff views are two orders of exactly the same contracts.
function sortMarkets(all) {
  const bestByMarket = new Map();
  for (const entry of all) {
    const key = `${entry.game.id}:${entry.marketKey}`, best = bestByMarket.get(key);
    if (!best || entry.W > best.W || (entry.W === best.W && (entry.R > best.R
      || (entry.R === best.R && entry.stableKey.localeCompare(best.stableKey) < 0)))) bestByMarket.set(key,entry);
  }
  const entries = [...bestByMarket.values()].sort((a,b)=> b.score-a.score || b.W-a.W || b.R-a.R
    || Date.parse(a.game.startTime)-Date.parse(b.game.startTime) || a.stableKey.localeCompare(b.stableKey));
  const markets = SOCCER_RANK_MARKETS.map(([key])=>key);
  const order = [...entries].sort((a,b)=>Date.parse(a.game.startTime)-Date.parse(b.game.startTime)
    || a.game.id.localeCompare(b.game.id) || markets.indexOf(a.marketKey)-markets.indexOf(b.marketKey)
    || b.score-a.score || a.stableKey.localeCompare(b.stableKey));
  return {entries,order};
}

function archiveMatches(archive,game,result,now) {
  return archive?.status === 'HISTORICAL_PREDICTION' && archive.eligible === false && archive.executable === false
    && /^[a-f0-9]{64}$/.test(archive.revision || '') && archive.revision !== result.revision
    && archive.gameId === game.id && archive.league === game.league && archive.date === game.date
    && archive.homeId === game.home.sourceId && archive.awayId === game.away.sourceId
    && archive.neutralSite === Boolean(game.neutralSite) && Date.parse(archive.startTime) === Date.parse(game.startTime)
    && Date.parse(archive.observedAt) <= Date.parse(result.observedAt) && Date.parse(archive.observedAt) <= now
    && Array.isArray(archive.quotes);
}

function previousPredictions(games,states,now,filter,currentEntries,presentationFor) {
  const entries = [], covered = new Set(currentEntries.map(e => `${e.game.id}:${e.marketKey}`));
  for (const game of games) {
    const state = states[game?.id], result = state?.data, original = result?.evidence?.game;
    if (!['epl','ucl'].includes(game?.league) || game.id !== `soccer:${game.league}:${game.sourceId}`
      || game.status !== 'scheduled' || !(Date.parse(game.startTime)>now) || !game.home?.sourceId || !game.away?.sourceId
      || result?.persisted !== true || result.status !== 'RESEARCH_ONLY' || result.executable !== false || !/^[a-f0-9]{64}$/.test(result.revision || '')
      || result.gameId !== game.id || result.league !== game.league || result.date !== game.date
      || original?.id !== game.id || original.sourceId !== game.sourceId || original.league !== game.league || original.date !== game.date
      || original.home?.sourceId !== game.home.sourceId || original.away?.sourceId !== game.away.sourceId
      || Date.parse(original.startTime) !== Date.parse(game.startTime) || Boolean(original.neutralSite) !== Boolean(game.neutralSite)
      || !(Date.parse(result.observedAt)<=now)) continue;

    const latestScored = new Set(), currentMarkets = new Set(), historical = [];
    for (const direction of result.directions || []) for (const quote of direction.quotes || []) {
      const marketKey = `${quote.period}:${quote.kind}`;
      if (!quote.predictionScore || (filter !== 'all' && filter !== marketKey) || covered.has(`${game.id}:${marketKey}`)) continue;
      const presented = presentationFor(game,result,direction,quote);
      if (presented.scoreKind !== 'PREDICTION' || !Number.isFinite(presented.score)) continue;
      if (['PREDICTION_QUALIFIED','BELOW_THRESHOLD'].includes(presented.status)) currentMarkets.add(marketKey);
      if (!['HISTORICAL','PREDICTION_QUALIFIED','BELOW_THRESHOLD'].includes(presented.status)) continue;
      latestScored.add(marketKey);
      if (presented.status === 'HISTORICAL' && presented.score>=7.2 && presented.W>0 && presented.R_model>0) {
        historical.push({quote,score:presented.score,W:presented.W,R:presented.R_model,marketKey,
          observedAt:quote.provenance.observedAt});
      }
    }

    // An older, independently checked database revision fills only a missing
    // market. It may never displace a scored market from the latest analysis.
    const archive = state.historicalPrediction;
    if (archiveMatches(archive,game,result,now)) for (const quote of archive.quotes) {
      const marketKey = `${quote?.period}:${quote?.kind}`;
      if ((filter !== 'all' && filter !== marketKey) || latestScored.has(marketKey)
        || !['FT','HT'].includes(quote?.period) || !/^[a-f0-9]{64}$/.test(quote.key || '')
        || !(quote.kind === 'TOTAL' && ['over','under'].includes(quote.side) && quote.lineSide == null
          || quote.kind === 'HANDICAP' && ['home','away'].includes(quote.side) && ['home','away'].includes(quote.lineSide))
        || typeof quote.line !== 'string' || !quote.line || typeof quote.label !== 'string' || !quote.label
        || !Number.isFinite(quote.water) || quote.water<=0 || ![quote.S,quote.W,quote.R].every(Number.isFinite)
        || quote.S<7.2 || quote.W<=0 || quote.R<=0 || !(Date.parse(quote.observedAt)<=Date.parse(quote.calculatedAt)
          && Date.parse(quote.calculatedAt)<=Date.parse(archive.observedAt))) continue;
      const fixed = deterministicScore({weightedEV:quote.W,robustEV:quote.R,actualWater:true,qaPassed:true,executable:false});
      if (fixed.score === quote.S) historical.push({quote,score:quote.S,W:quote.W,R:quote.R,marketKey,observedAt:quote.observedAt});
    }
    for (const entry of historical) {
      if (currentMarkets.has(entry.marketKey) || covered.has(`${game.id}:${entry.marketKey}`)) continue;
      const {quote} = entry;
      const direction = `${quote.kind}_${quote.side.toUpperCase()}`;
      entries.push({...entry,game,market:soccerMarketName(quote.period,quote.kind),
        stableKey:`${game.id}:${quote.period}:${direction}:${quote.key}`,prediction:true,candidate:false,executable:false,formalEligible:false});
    }
  }
  return entries;
}
