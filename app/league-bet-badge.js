export default function LeagueBetBadge({ summary }) {
  if (!summary?.label) return null;
  return <small className={`leagueBetBadge bet-${summary.state}`} data-league-bet-state={summary.state}
    title={summary.state === 'pending' ? summary.label : `高分候選 ${summary.total} 筆｜已下注 ${summary.recorded} 筆｜未下注 ${summary.unbet} 筆`}>
    {summary.label}
  </small>;
}
