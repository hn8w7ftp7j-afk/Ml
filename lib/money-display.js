// Preserve settlement fractions when displaying account totals and breakdowns.
export function moneyText(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const amount = Number(value);
  return `${amount >= 0 ? '+' : ''}${amount.toLocaleString('zh-TW', { maximumFractionDigits: 2 })}元`;
}
