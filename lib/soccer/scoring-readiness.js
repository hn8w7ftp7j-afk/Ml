import { soccerQuoteScorePresentation } from './score-presentation.js';

const labels = {
  READER_QUOTE: '原盤來源、時間或期間未通過核對',
  SETTLEMENT_CONTRACT: '足球派彩規則尚未完成原盤綁定與正式登錄',
  PER_SCORE_PAYOFF: '尚無可計算的逐比分損益',
  FOOTBALL_UNCERTAINTY: '尚缺足球情境及模型誤差依據',
  FIXED_S_FORMULA: 'S 公式所需的 W／R 尚未備齊',
  FORMAL_ACCEPTANCE: '足球模型、校準及誤差驗收尚未完成',
  CURRENT_PUBLICATION: '目前候選資格尚未發布',
  SCORING_NOT_RUN: '此版本尚未保存評分計算，請重新分析',
};
const nextSteps = {
  READER_QUOTE: { owner: 'CURRENT_DATA', nextAction: '未開賽場次先更新 Reader 原盤，再核對賽前資料；已開賽場次只能查閱原封存版本。' },
  SETTLEMENT_CONTRACT: { owner: 'SYSTEM', nextAction: '系統須核對原盤、期間與規則版本並完成正式登錄；已確認的信用盤算法與 1% 實際輸贏本金退水不必重報。異常賽事保留人工核對。' },
  PER_SCORE_PAYOFF: { owner: 'SYSTEM', nextAction: '系統須完成適用派彩下的逐比分損益計算；不能用手動輸入或猜測條款補成正式收益。' },
  FOOTBALL_UNCERTAINTY: { owner: 'SYSTEM', nextAction: '系統須建立足球情境及實際原盤收益誤差資料；重新同步盤口不會產生這些模型依據。' },
  FIXED_S_FORMULA: { owner: 'SYSTEM', nextAction: '系統須取得可驗證的 W／R 才能套用既有 S 公式。' },
  FORMAL_ACCEPTANCE: { owner: 'SYSTEM', nextAction: '系統須完成來源時間、人員模型、校準及誤差驗收，並接入正式分析。' },
  SCORING_NOT_RUN: { owner: 'CURRENT_DATA', nextAction: '未開賽場次可重新核對賽前資料；歷史版本不能重建當時未保存的分數。' },
};
const bundleReasons = {
  SOCCER_SCORING_BUNDLE_MISSING: '正式評分所需的足球模型、情境與誤差輸入尚未接齊',
  SOCCER_SCORING_BUNDLE_UNAVAILABLE_AT_CUTOFF: '正式評分輸入在本次分析時間尚不可用',
  SOCCER_SCORING_BUNDLE_EXPIRED: '正式評分輸入已過期，須由系統更新驗證版本',
  SOCCER_SCORING_BUNDLE_CONTEXT_MISMATCH: '正式評分輸入與本場、期間或原盤不符',
  SOCCER_SCORING_BUNDLE_HASH_MISMATCH: '正式評分輸入內容與登錄版本不一致',
  SOCCER_SCORING_BUNDLE_AMBIGUOUS: '同一場有多個正式評分輸入版本，須由系統排除衝突',
  SOCCER_SCORING_BUNDLE_ARTIFACT_INVALID: '正式評分輸入的版本或內容未通過核對',
  SOCCER_SCORING_BUNDLE_REVOKED_OR_CHANGED: '正式評分輸入已撤銷或更新，舊資格不可沿用',
};
const blocker = (code, label = labels[code]) => ({ code, label, ...(nextSteps[code] || { owner: 'SYSTEM', nextAction: '系統須重新核對本場來源、版本與計算依據。' }) });
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
    return [blocker('SCORING_NOT_RUN')];
  const stages = Object.entries(completed).flatMap(([code, statuses]) => {
    const stage = scoring.stages.find(value => value?.stage === code);
    return stage && statuses.includes(stage.status) ? [] : [blocker(code)];
  });
  const bundleCode = scoring?.inputBundle?.code;
  if (Object.hasOwn(bundleReasons,bundleCode)) stages.unshift({ code: bundleCode, label: bundleReasons[bundleCode], owner: 'SYSTEM', nextAction: '系統須完成並登錄適用本場的評分輸入；不需要使用者反覆更新 Reader 或重報退水。' });
  return stages;
}

export function soccerScoringReadiness(result, now = Date.now(), displayGame = result?.evidence?.game) {
  const directions = Array.isArray(result?.directions) ? result.directions : [];
  let quoteCount = 0, scoredQuoteCount = 0, qualifiedQuoteCount = 0, historicalScoreCount = 0, belowThresholdQuoteCount = 0, unpublishedScoreCount = 0;
  const missing = new Map();
  const addBlocker=blocker=>{const old=missing.get(blocker.code);missing.set(blocker.code,{...blocker,quoteCount:(old?.quoteCount||0)+1});};
  for (const direction of directions) for (const quote of Array.isArray(direction?.quotes) ? direction.quotes : []) {
    quoteCount++;
    const presentation = soccerQuoteScorePresentation({ result, direction, quote, displayGame, now });
    if (presentation.score != null) {
      scoredQuoteCount++;
      if (presentation.status === 'QUALIFIED' && presentation.eligible === true) qualifiedQuoteCount++;
      else if (presentation.status === 'HISTORICAL') historicalScoreCount++;
      else if (presentation.status === 'BELOW_THRESHOLD') belowThresholdQuoteCount++;
      else if (presentation.status === 'UNPUBLISHED') unpublishedScoreCount++;
      continue;
    }
    const primary={BLOCKED:'資料未通過核對',CONTEXT_CHANGED:'賽事資料已更新，須重新分析'}[presentation.status];
    if(primary)addBlocker(blocker(presentation.status,primary));
    if(!['FT','HT'].includes(direction.period)||quote?.period!==direction.period)
      addBlocker({code:'PERIOD_UNVERIFIED',label:'原盤期間與分析方向尚未一致',owner:'CURRENT_DATA',nextAction:'先核對每筆原盤的全場／上半場標示；已確認的比賽期間規則不需要重報。'});
    const blockers=soccerQuoteScoringBlockers(quote?.scoring);
    for(const blocker of blockers)addBlocker(blocker);
    if(!primary&&!blockers.length)addBlocker(blocker('SCORE_PAYLOAD_UNVERIFIED','評分的來源、身分或公式核對未通過'));
  }
  const unassignedQuoteCount = Array.isArray(result?.unassignedQuotes) ? result.unassignedQuotes.length : 0;
  return { version: 'SOCCER-SCORING-READINESS-v1', status: !quoteCount ? 'NO_SCOPED_QUOTES'
    : scoredQuoteCount === quoteCount ? 'SCORES_AVAILABLE' : scoredQuoteCount ? 'PARTIAL' : 'SCORING_BLOCKED',
    quoteCount, scoredQuoteCount, qualifiedQuoteCount, historicalScoreCount, belowThresholdQuoteCount, unpublishedScoreCount, unassignedQuoteCount, blockers: [...missing.values()] };
}
