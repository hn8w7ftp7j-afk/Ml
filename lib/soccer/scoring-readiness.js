import { soccerQuoteScorePresentation } from './score-presentation.js';

const labels = {
  READER_QUOTE: '原盤來源、時間或期間未通過核對',
  SETTLEMENT_CONTRACT: '足球派彩及退水適用條款未完整確認',
  PER_SCORE_PAYOFF: '尚無可計算的逐比分損益',
  FOOTBALL_UNCERTAINTY: '尚缺足球情境及模型誤差依據',
  FIXED_S_FORMULA: 'S 公式所需的 W／R 尚未備齊',
  FORMAL_ACCEPTANCE: '足球模型、校準及誤差驗收尚未通過',
  CURRENT_PUBLICATION: '目前候選資格尚未發布',
  SCORING_NOT_RUN: '此版本尚未保存評分計算，請重新分析',
};
const completed = {
  READER_QUOTE: ['PASS'], SETTLEMENT_CONTRACT: ['REGISTERED'],
  PER_SCORE_PAYOFF: ['CALCULATED_CONDITIONALLY'],
  FOOTBALL_UNCERTAINTY: ['CONDITIONAL_PROTOCOL_ARITHMETIC'],
  FIXED_S_FORMULA: ['DIAGNOSTIC_ONLY'], FORMAL_ACCEPTANCE: ['PASS'],
};

// Explain the calculation actually performed. This is not a model, settlement
// registration, current-candidate receipt, or permission to synthesize a score.
export function soccerQuoteScoringBlockers(scoring) {
  if (!Array.isArray(scoring?.stages) || !scoring.stages.length)
    return [{ code: 'SCORING_NOT_RUN', label: labels.SCORING_NOT_RUN }];
  return Object.entries(completed).flatMap(([code, statuses]) => {
    const stage = scoring.stages.find(value => value?.stage === code);
    return stage && statuses.includes(stage.status) ? [] : [{ code, label: labels[code] }];
  });
}

export function soccerScoringReadiness(result, now = Date.now(), displayGame = result?.evidence?.game) {
  const directions = Array.isArray(result?.directions) ? result.directions : [];
  let quoteCount = 0, scoredQuoteCount = 0;
  const missing = new Map();
  const addBlocker=blocker=>{const old=missing.get(blocker.code);missing.set(blocker.code,{...blocker,quoteCount:(old?.quoteCount||0)+1});};
  for (const direction of directions) for (const quote of Array.isArray(direction?.quotes) ? direction.quotes : []) {
    quoteCount++;
    const presentation = soccerQuoteScorePresentation({ result, direction, quote, displayGame, now });
    if (presentation.score != null) { scoredQuoteCount++; continue; }
    const primary={BLOCKED:'資料未通過核對',CONTEXT_CHANGED:'賽事資料已更新，須重新分析'}[presentation.status];
    if(primary)addBlocker({code:presentation.status,label:primary});
    if(!['FT','HT'].includes(direction.period)||quote?.period!==direction.period)
      addBlocker({code:'PERIOD_UNVERIFIED',label:'原盤期間與分析方向尚未一致'});
    const blockers=soccerQuoteScoringBlockers(quote?.scoring);
    for(const blocker of blockers)addBlocker(blocker);
    if(!primary&&!blockers.length)addBlocker({code:'SCORE_PAYLOAD_UNVERIFIED',label:'評分的來源、身分或公式核對未通過'});
  }
  const unassignedQuoteCount = Array.isArray(result?.unassignedQuotes) ? result.unassignedQuotes.length : 0;
  return { version: 'SOCCER-SCORING-READINESS-v1', status: !quoteCount ? 'NO_SCOPED_QUOTES'
    : scoredQuoteCount === quoteCount ? 'SCORES_AVAILABLE' : scoredQuoteCount ? 'PARTIAL' : 'SCORING_BLOCKED',
    quoteCount, scoredQuoteCount, unassignedQuoteCount, blockers: [...missing.values()] };
}
