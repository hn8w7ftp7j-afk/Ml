// Display only. Never fills quotes, estimates, scores, or candidate eligibility.
export function nbaMarketDisplayState(row, key) {
  const quote = row.quote?.[key], analysis = row.result?.marketAnalyses?.[key];
  if (!quote) return { label: '盤口待同步', message: '尚未收到此市場的有效盤口；不代表莊家尚未開盤。' };
  const fields = key.endsWith('Total') ? ['line', 'overWater', 'underWater'] : ['line', 'lineSide', 'homeWater', 'awayWater'];
  const matches = analysis?.quote && fields.every(field => quote[field] === analysis.quote[field]);
  if (analysis?.status === 'ready') return matches
    ? { label: '已分析', message: '' }
    : { label: '待重新分析', message: '此市場盤口已更新；下方保留舊盤估計，請同步後重新分析。' };
  if (analysis?.status === 'insufficient') return { label: '待驗證', message: analysis.reason || '此市場驗證尚未通過。' };
  if (analysis?.status === 'blocked') return { label: '核對未通過', message: analysis.reason || '此市場資料尚未通過核對。' };
  return { label: '待分析', message: '此市場已有盤口，但尚無對應分析；請同步後重新分析。' };
}
