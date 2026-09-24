// Presentation only: never change score, eligibility, or saved audit evidence.
export function rankingWarningPresentation(warnings = []) {
  const details = [...new Set(warnings.filter(value => typeof value === 'string' && value.trim()))];
  const visible = details.flatMap(text => {
    // Only this known informational notice is hidden from the compact list.
    if (/^缺少.*獨立國際市場.*外部稽核無資料.*不影響/.test(text)) return [];
    const wrGap = text.match(/^模型W\/R(?:情境)?差距([\d.]+)個百分點/);
    if (wrGap) return [`W/R 差距 ${Number(wrGap[1]).toFixed(2)} 個百分點`];
    const marketGap = text.match(/^模型\s*[／/]\s*Tai888去水機率高度分歧\s*([\d.]+)pp/);
    if (marketGap) return [`模型與盤口機率差距 ${marketGap[1]}pp`];
    // Preserve unrecognized warnings verbatim, especially errors and blocks.
    return [text];
  });
  return { visible: [...new Set(visible)], details };
}

export function rankingStatusText(entry) {
  if (!entry.qualified) return '模型檢查未通過';
  if (!entry.qaPassed) return '資料檢查未通過';
  if (entry.researchPolicy) return '僅供研究';
  if (!entry.currentAnalysisExecutable) return '盤口待複核';
  if (!entry.rankingEligible) return entry.row?.rankingQualificationReason || '未達排名條件';
  return null;
}
