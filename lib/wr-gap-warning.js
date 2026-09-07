export const WR_GAP_REFERENCE = 0.05;
export function wrGapExceedsReference(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > WR_GAP_REFERENCE + 1e-12;
}
export function wrGapWarning(value) {
  return wrGapExceedsReference(value)
    ? `模型W/R差距${(value * 100).toFixed(4)}個百分點，超過5個百分點參考線；R包含情境下行情形及資料風險扣減，不代表單獨的情境不穩定；保留評分與排名`
    : null;
}
// Re-render legacy warnings without rewriting immutable saved evidence.
export function currentWrWarnings(warnings, gap) {
  if (typeof gap !== 'number' || !Number.isFinite(gap)) return warnings;
  return [...new Set([...warnings.filter(x => !/^模型W\/R(?:情境)?差距/.test(x)), wrGapWarning(gap)].filter(Boolean))];
}
