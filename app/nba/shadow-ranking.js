'use client';
import { useState } from 'react';
import { buildNbaShadowRanking, NBA_RANK_MARKETS } from '../../lib/nba/shadow-ranking.js';
import { NBA_TEAM_LABELS } from '../../lib/nba/labels.js';
const name = team => NBA_TEAM_LABELS[team?.abbreviation] || team?.name || '球隊待核對';
const num = value => Number.isFinite(value) ? value.toFixed(2) : '—';
const pct = value => Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : '—';
const time = value => new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
export default function NbaShadowRanking({ rows, date, now, onAnalyze, busy }) {
  const [filter, setFilter] = useState('all');
  const ranking = buildNbaShadowRanking(rows, date, now, filter);
  return <section className="panel nbaShadowRanking" aria-label="NBA 影子排名">
    <div className="panelHead"><h2>NBA 影子排名</h2><span className="state shadow">模型估計</span></div>
    <div className="rankingViewTabs" aria-label="NBA 排名盤口篩選">
      {[['all', '全部方向'], ...NBA_RANK_MARKETS].map(([key, label]) => <button key={key} className={filter === key ? 'active' : ''} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</button>)}
    </div>
    <p className="rankingMeta">{date}｜{ranking.currentGames} 場分析｜{ranking.entries.length} 個方向｜依每 100 元模型淨額由高到低</p>
    {ranking.outdatedGames > 0 && <p className="muted">{ranking.outdatedGames} 場盤口已變動、過期或已開賽，已退出目前排名。請讀取最新盤口後重新分析。</p>}
    {ranking.pendingGames > 0 && <p className="muted">{ranking.pendingGames} 場尚無完整盤口分析；每完成一場即更新排名。</p>}
    {ranking.entries.map((entry, index) => <div className="rankRow nbaRankRow" key={entry.stableKey} data-nba-rank-key={entry.stableKey}>
      <b>{index + 1}</b><strong className={entry.expectedNet > 0 ? 'nbaRankNet positive' : 'nbaRankNet'}>{entry.expectedNet > 0 ? '+' : ''}{num(entry.expectedNet)}<small>元／100元</small></strong>
      <div><span>{name(entry.game.away)}（客）@ {name(entry.game.home)}（主）</span><div className="scorePick">{entry.market}｜{entry.side === 'home' || entry.side === 'away' ? `${name(entry.game[entry.side])} ${entry.role}` : entry.role}｜{entry.line}</div>
        <div className="scoreMeta">模型估計勝率 {pct(entry.winProbability)}｜走水 {pct(entry.pushProbability)}｜水位 {num(entry.water)}</div>
        <small>{time(entry.game.startTime)}（台灣）｜盤口 {time(entry.observedAt)}｜誤差樣本 {entry.samples ?? '—'} 筆</small>
      </div><button className="mini secondary" disabled={busy} onClick={() => onAnalyze(entry.game.sourceId)}>重新分析</button>
    </div>)}
    {!ranking.entries.length && <div className="emptySmall">{filter === 'all' ? '尚無目前盤口的分析結果。請按「分析本日全部 NBA」。' : '這類盤口尚未開盤或尚無有效分析結果。'}</div>}
    <details className="rankingDetails"><summary>排序說明</summary><p>保留大小分與讓分雙邊，包括淨額為負的方向；按同一版盤口計算的模型淨額排序。NBA 尚無已驗證的 S 分數，這裡不套用棒球評分。</p><p>勝率與淨額是模型估計，尚未證實實際下注獲利；每 100 元淨額含 1.5% 退水。</p></details>
  </section>;
}
