'use client';
import { analysisLeagueIdsForRun } from '../lib/analysis-leagues.js';
import { allLeagueAnalysisProgress, allLeagueAnalysisOutcomeText, allLeagueStatusLabel } from '../lib/all-league-analysis-v117.js';

export default function AllLeagueProgress({ run }) {
  if (!run) return null;
  const progress = allLeagueAnalysisProgress(run);
  return <div className="allLeagueState" aria-live="polite">
    <div><strong>全部聯盟工作｜已結束 {progress.terminal}/{progress.total}</strong><span>{allLeagueAnalysisOutcomeText(progress)}</span>
      <span>{run.state === 'running' ? '目前工作' : '保存的工作結果'}｜不代表 Reader 即時狀態</span></div>
    <div className="allLeaguePills">{analysisLeagueIdsForRun(run).map(id => {
      const row = run.leagues[id];
      return <span key={id} className={`batch-${row.status}`} title={row.message || ''}>{id} {row.boardDate || '—'}｜{allLeagueStatusLabel(row.status)}</span>;
    })}</div>
    {analysisLeagueIdsForRun(run).filter(id => run.leagues[id].message && ['failed', 'partial', 'no_open_markets'].includes(run.leagues[id].status)).map(id => <small key={id}>{id}：{run.leagues[id].message}</small>)}
  </div>;
}
