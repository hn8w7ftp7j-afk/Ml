export const SOCCER_RANK_MARKETS = [['all','全部方向'],['FT:HANDICAP','全場讓球'],['FT:TOTAL','全場大小'],['HT:HANDICAP','上半讓球'],['HT:TOTAL','上半大小']];
export const soccerMarketName = (period,kind) => `${period==='HT'?'上半場':'全場'}${kind==='TOTAL'?'大小':'讓球'}`;
export function soccerResultCurrent(game,result,now=Date.now()) {
  return Boolean(result && result.gameId===game.id && result.league===game.league && result.date===game.date
    && result.publishedCurrent===true && result.persisted===true && result.analysisStatus==='COMPLETED'
    && game.status==='scheduled' && Date.parse(game.startTime)>now && Date.parse(result.observedAt)<=now
    && now-Date.parse(result.observedAt)<180000);
}
export function buildSoccerRanking(games,states,{now=Date.now(),market='all'}={}) {
  const entries=[],seen=new Set();let pendingGames=0,outdatedGames=0,currentGames=0;
  for(const game of games){
    if(!['epl','ucl'].includes(game?.league)||!game.id?.startsWith(`soccer:${game.league}:`)||seen.has(game.id))continue;
    seen.add(game.id);const state=states[game.id],result=state?.data;
    if(state?.status!=='done'||!result){pendingGames++;continue;}
    if(!soccerResultCurrent(game,result,now)){outdatedGames++;continue;}
    currentGames++;
    for(const d of result.directions||[]){
      if(!['FT','HT'].includes(d.period)||!['HANDICAP_HOME','HANDICAP_AWAY','TOTAL_OVER','TOTAL_UNDER'].includes(d.direction))continue;
      const kind=d.direction.startsWith('TOTAL')?'TOTAL':'HANDICAP',marketKey=`${d.period}:${kind}`;
      if(market!=='all'&&market!==marketKey)continue;
      for(const quote of d.quotes||[]){
        const at=Date.parse(quote.provenance?.observedAt||'');
        if(quote.period!==d.period||quote.kind!==kind||quote.unit!=='GOALS'||quote.provenance?.gameId!==game.id
          ||quote.fresh!==true||quote.prestart!==true||!Number.isFinite(at)||at>now||now-at>=180000
          ||!Number.isFinite(quote.water)||quote.water<=0||!quote.key)continue;
        // A research quote has no S/W/R. Never derive a score from 1X2 or threshold probabilities.
        const formal=result.formalScoringEnabled===true&&result.qualification?.eligible===true&&d.eligible===true&&d.qaFlag!=='BLOCKED';
        const score=formal&&Number.isFinite(d.score)?d.score:null,W=formal&&Number.isFinite(d.W)?d.W:null,R=formal&&Number.isFinite(d.R)?d.R:null;
        const stableKey=`${game.id}:${d.period}:${d.direction}:${quote.key}`;
        if(entries.some(e=>e.stableKey===stableKey))continue;
        entries.push({stableKey,game,result,quote,marketKey,market:soccerMarketName(d.period,kind),score,W,R,
          candidate:formal&&score>=7.2&&W>0&&R>0});
      }
    }
  }
  entries.sort((a,b)=>(b.score??-Infinity)-(a.score??-Infinity)||(b.W??-Infinity)-(a.W??-Infinity)||(b.R??-Infinity)-(a.R??-Infinity)
    ||Date.parse(a.game.startTime)-Date.parse(b.game.startTime)||a.stableKey.localeCompare(b.stableKey));
  const order=entries.filter(e=>e.candidate).sort((a,b)=>Date.parse(a.game.startTime)-Date.parse(b.game.startTime)
    ||a.game.id.localeCompare(b.game.id)||['FT:HANDICAP','FT:TOTAL','HT:HANDICAP','HT:TOTAL'].indexOf(a.marketKey)-['FT:HANDICAP','FT:TOTAL','HT:HANDICAP','HT:TOTAL'].indexOf(b.marketKey)
    ||(b.score-a.score)||a.stableKey.localeCompare(b.stableKey));
  return{entries,order,currentGames,pendingGames,outdatedGames};
}
