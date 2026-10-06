export function nbaManualRecordStats(records) {
  const active = records.filter(row => (row.status || 'OPEN') === 'OPEN');
  const settled = active.filter(row => row.settlement?.status === 'SETTLED');
  const wins = settled.filter(row => row.settlement.fraction > 0).length;
  const losses = settled.filter(row => row.settlement.fraction < 0).length;
  const profit = settled.reduce((sum, row) => sum + row.settlement.profit, 0);
  const stake = settled.reduce((sum, row) => sum + row.stake, 0);
  return { active: active.length, settled: settled.length, pending: active.length - settled.length,
    wins, losses, pushes: settled.length - wins - losses, profit, stake,
    winRate: wins + losses ? wins / (wins + losses) : null, roi: stake ? profit / stake : null };
}
