import {loadNbaData} from './data.js';
import {loadOfficialNbaEvidence} from './official.js';
import {buildNbaLiveHistoryRow, validateNbaLiveHistoryRow} from './live-history.js';
import {saveNbaLiveHistory, loadNbaLiveHistory} from './live-history-store.js';
import {buildNbaHistoryCandidate,validateNbaHistoryCandidate,saveNbaHistoryCandidate,saveNbaHistoryAttempt,loadPendingNbaHistory} from './history-queue-store.js';
import {assertNba, taipeiDate, validDate} from './identity.js';

const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0,10);
const identity = game => JSON.stringify([game.id,game.startTime,game.taipeiDate,game.season?.year,game.seasonType,game.home?.id,game.away?.id,game.home?.score,game.away?.score]);
export async function syncNbaLiveHistory({throughDate, lookbackDays = 3, limit = 12, timeBudgetMs = 45000, now = Date.now, load = loadNbaData, official = loadOfficialNbaEvidence, store = saveNbaLiveHistory, list = loadNbaLiveHistory, enqueue = saveNbaHistoryCandidate, pending = loadPendingNbaHistory, attempt = saveNbaHistoryAttempt} = {}) {
  const clock = () => Number(typeof now === 'function' ? now() : now), started = clock();
  const lastDate = throughDate || taipeiDate(started);
  assertNba(validDate(lastDate) && lastDate <= taipeiDate(started) && Number.isInteger(lookbackDays) && lookbackDays >= 1 && lookbackDays <= 31 && Number.isInteger(limit) && limit > 0 && limit <= 30 && Number.isFinite(timeBudgetMs) && timeBudgetMs > 0 && timeBudgetMs <= 55000, 'NBA_LIVE_HISTORY_QUERY_INVALID', '同步只接受目前或較早的台北日期及有限執行預算');
  const discoveryBudgetMs = Math.min(15000,Math.floor(timeBudgetMs/3));
  const discoveryStartOffset = new Date(started).getUTCHours()%lookbackDays;
  const summary = {status:'ready', throughDate:lastDate, lookbackDays, discoveryBudgetMs, discoveryStartOffset, checked:0, discovered:0, queued:0, pendingLoaded:0, saved:0, existing:0, failed:0, deferred:0, games:[], issues:[], strictPointInTime:false, modelInputBasis:'verified_completed_games_for_strictly_later_dates',retryBasis:'durable_candidates_least_recent_attempt_first_no_lookback_expiry'};
  const requestBudget = (phase = 'work') => {
    const remaining = Math.floor(Math.min(timeBudgetMs-(clock()-started),phase==='discovery'?discoveryBudgetMs-(clock()-started):Infinity));
    if (remaining <= 0) throw Object.assign(Error('NBA 歷史同步本次時間預算已用完'),{code:'NBA_LIVE_HISTORY_TIME_BUDGET'});
    return {now:clock,timeoutMs:Math.min(12000,remaining)};
  };
  let previous;
  try {previous = await list({beforeDate:addDays(lastDate,1)}); for (const row of previous) validateNbaLiveHistoryRow(row, clock());}
  catch (error) {return {...summary,status:'unavailable',issues:[{code:error.code || 'NBA_LIVE_HISTORY_STORE_UNAVAILABLE',message:'永久歷史資料讀寫暫時無法核對；沒有當成空白球季繼續。'}]};}
  const savedById = new Map(previous.map(row => [row.gameId,row]));
  const candidates = new Map();
  for (let offset = 0; offset < lookbackDays; offset += 1) {
    if (clock() - started >= discoveryBudgetMs) {summary.issues.push({code:'NBA_LIVE_HISTORY_DISCOVERY_BUDGET',message:'排程查詢已用完本次保留預算；其餘時間優先處理永久待核對佇列，下次輪換查詢日期'}); break;}
    const date = addDays(lastDate,-((discoveryStartOffset+offset)%lookbackDays));
    try {
      const result = await load({view:'schedule',date},requestBudget('discovery'));
      const sourceReady = source => {
        try {const url = new URL(source.url),fetched = Date.parse(source.fetchedAt);return source.provider === 'ESPN' && url.origin === 'https://site.api.espn.com' && url.pathname === '/apis/site/v2/sports/basketball/nba/scoreboard' && source.status === 'ready' && /^[a-f0-9]{64}$/.test(source.hash || '') && Number.isFinite(fetched) && fetched <= clock() && clock()-fetched <= 900000;} catch {return false;}
      };
      if (!['ready','empty'].includes(result?.status) || result.qa?.status === 'BLOCK' || !Array.isArray(result.data?.games) || !result.sources?.some(sourceReady) || result.sources.some(source => source.status !== 'ready' && !source.recoveredBy)) throw Object.assign(Error('NBA 賽程來源不完整或過期'),{code:'NBA_LIVE_HISTORY_SCHEDULE_UNAVAILABLE'});
      for (const game of result.data.games) {
        if (game.taipeiDate !== date || game.status !== 'final' || game.completed !== true || Date.parse(game.startTime) >= clock()) continue;
        if (candidates.has(game.id) && identity(candidates.get(game.id)) !== identity(game)) throw Object.assign(Error('同場排程身分或比分衝突'),{code:'NBA_LIVE_HISTORY_SCHEDULE_CONFLICT'});
        candidates.set(game.id,game);
        if (savedById.has(game.id)) {
          if (identity(savedById.get(game.id).game) !== identity(game)) {summary.failed++;summary.games.push({gameId:game.id,status:'failed',code:'NBA_LIVE_HISTORY_CONFLICT',message:'已核對保存的 final 與最新排程衝突，保留原記錄'});}
          else {summary.existing++;summary.games.push({gameId:game.id,status:'already_verified'});}
          continue;
        }
        try {
          const candidate = buildNbaHistoryCandidate(game,result.sources,{now:clock});
          const receipt = await enqueue(candidate,{now:clock});
          if (receipt?.persisted !== true || receipt.gameId !== game.id) throw Object.assign(Error('待核對場次未取得永久保存回條'),{code:'NBA_HISTORY_QUEUE_UNAVAILABLE'});
          summary.queued += receipt.inserted === false ? 0 : 1;
        } catch (error) {summary.failed++;summary.games.push({gameId:game.id,status:'failed',code:error.code || 'NBA_HISTORY_QUEUE_UNAVAILABLE',message:error.message});}
      }
    } catch (error) {summary.issues.push({date,code:error.code || 'NBA_LIVE_HISTORY_SCHEDULE_UNAVAILABLE',message:error.message});}
  }
  summary.discovered = candidates.size;
  let ordered;
  try {ordered = await pending({throughDate:lastDate,limit:Math.min(1000,limit+1)},{now:clock});for (const candidate of ordered) validateNbaHistoryCandidate(candidate,clock());}
  catch (error) {return {...summary,status:'unavailable',issues:[...summary.issues,{code:error.code || 'NBA_HISTORY_QUEUE_UNAVAILABLE',message:'永久待核對佇列無法讀回；不改用會遺失較早場次的臨時列表'}]};}
  summary.pendingLoaded = ordered.length;
  // Least-recent-attempt FIFO: a permanently bad upstream game goes to the back
  // after each durable attempt, and a 3-day discovery window never expires it.
  for (const candidate of ordered) {
    const game = candidate.game;
    if (savedById.has(game.id)) continue;
    if (summary.checked >= limit || clock() - started >= timeBudgetMs) {summary.deferred += 1; continue;}
    summary.checked += 1;
    let outcome;
    try {
      let result = await load({view:'game',id:game.sourceId},requestBudget());
      if (result?.qa?.issues?.some(issue => issue.code === 'PLAYER_IDENTITY_MISMATCH') && result.status !== 'ready') result = await load({view:'historical-team-box',id:game.sourceId},requestBudget());
      if (result?.status !== 'ready' || result.qa?.status === 'BLOCK' || identity(result.data?.game || {}) !== identity(game)) throw Object.assign(Error('完賽 summary 與賽程身分或 final 比分不一致'),{code:'NBA_LIVE_HISTORY_GAME_CONFLICT'});
      const officialOptions = requestBudget();
      // The official adapter's two requests have a fixed internal timeout; an
      // additional abort signal keeps both within this sync's remaining budget.
      officialOptions.fetchImpl = (url,options = {}) => {
        const remaining = requestBudget().timeoutMs;
        return fetch(url,{...options,signal:options.signal ? AbortSignal.any([options.signal,AbortSignal.timeout(remaining)]) : AbortSignal.timeout(remaining)});
      };
      const evidence = await official(result.data.game,result.data.players || [],officialOptions);
      const row = buildNbaLiveHistoryRow(result,evidence,{now:clock});
      const receipt = await store(row);
      if (receipt?.persisted !== true || receipt.gameId !== row.gameId) throw Object.assign(Error('歷史同步未取得永久保存回條'),{code:'NBA_LIVE_HISTORY_PERSISTENCE_INVALID'});
      summary.saved += receipt.inserted === false ? 0 : 1;
      summary.existing += receipt.inserted === false ? 1 : 0;
      summary.games.push({gameId:game.id,status:receipt.inserted === false?'already_verified':'saved',revision:receipt.revision,capturedAt:receipt.capturedAt,seasonYear:row.year,seasonType:row.seasonType});
      outcome = {status:'saved',code:null};
    } catch (error) {summary.failed += 1;summary.games.push({gameId:game.id,status:'failed',code:error.code || 'NBA_LIVE_HISTORY_INGEST_FAILED',message:error.message});outcome = {status:'failed',code:error.code || 'NBA_LIVE_HISTORY_INGEST_FAILED'};}
    try {
      const receipt = await attempt({gameId:game.id,candidateRevision:candidate.recordHash,attemptedAt:new Date(clock()).toISOString(),...outcome},{now:clock});
      if (receipt?.persisted !== true) throw Error('未取得重試保存回條');
    } catch (error) {summary.issues.push({gameId:game.id,code:'NBA_HISTORY_ATTEMPT_SAVE_FAILED',message:'此次來源核對嘗試未取得永久保存回條；保留候選下次重試'});break;}
  }
  if (summary.failed || summary.issues.length) summary.status = summary.saved || summary.existing ? 'partial' : 'unavailable';
  else if (summary.deferred) summary.status = 'partial';
  summary.elapsedMs = Math.max(0,clock()-started);
  return summary;
}
