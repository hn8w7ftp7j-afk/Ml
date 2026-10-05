'use client';
import { useState } from 'react';
import { buildNbaShadowRanking, buildNbaShadowOrder, NBA_RANK_MARKETS } from '../../lib/nba/shadow-ranking.js';
import { NBA_TEAM_LABELS } from '../../lib/nba/labels.js';
const name = team => NBA_TEAM_LABELS[team?.abbreviation] || team?.name || '球隊待核對';
const num = value => Number.isFinite(value) ? value.toFixed(2) : '—';
const pct = value => Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : '—';
const time = value => new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
export default function NbaShadowRanking({ rows, date, now, onAnalyze, busy }) {
  const [view, setView] = useState('ranking');
  const [filter, setFilter] = useState('all');
  const ranking = buildNbaShadowRanking(rows, date, now, filter);
  const groups = buildNbaShadowOrder(ranking.entries);
  const renderEntry = (entry, index) => <div className="rankRow nbaRankRow" key={entry.stableKey} data-nba-rank-key={entry.stableKey}>
      <b>{view === 'order' ? entry.betOrderIndex : index + 1}</b><strong className={`rankScore nbaRankScore ${entry.score >= 8.5 ? 'strongest' : ''}`} title="固定 S 分數">{entry.score == null ? '—' : entry.score.toFixed(1)}<small>S 分數</small></strong>
      <div><span>{name(entry.game.away)}（客）@ {name(entry.game.home)}（主）</span><div className="scorePick">{entry.market}｜{entry.side === 'home' || entry.side === 'away' ? `${name(entry.game[entry.side])} ${entry.role}` : entry.role}｜{entry.line}</div>
        <div className="scoreMeta">W {num(entry.expectedNet)}%｜R {num(entry.robustExpectedNet)}%（每 100 元含退水淨額）</div>
        {entry.score == null && <div className="scoreMeta">需重新分析以產生 W／R 評分</div>}
        <div className="scoreMeta">模型估計勝率 {pct(entry.winProbability)}｜走水 {pct(entry.pushProbability)}｜水位 {num(entry.water)}</div>
        <small>{time(entry.game.startTime)}（台灣）｜盤口 {time(entry.observedAt)}｜誤差樣本 {entry.samples ?? '—'} 筆</small>
      </div><button className="mini secondary" disabled={busy} onClick={() => onAnalyze(entry.game.sourceId)}>重新分析</button>
    </div>;
  return <section className="panel nbaShadowRanking" aria-label="NBA 影子排名">
    <div className="rankingViewTabs" aria-label="影子排名檢視"><button className={view === 'ranking' ? 'active' : ''} onClick={() => setView('ranking')}>全部方向</button><button className={view === 'order' ? 'active' : ''} onClick={() => setView('order')}>影子候選順序</button></div>
    <div className="panelHead"><h2>{view === 'order' ? '影子候選順序｜7.0分以上' : '全部方向｜分數由高到低'}</h2><span className="state shadow">模型估計</span></div>
    <div className="rankingViewTabs" aria-label="NBA 排名盤口篩選">
      {[['all', '全部方向'], ...NBA_RANK_MARKETS].map(([key, label]) => <button key={key} className={filter === key ? 'active' : ''} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</button>)}
    </div>
    <p className="rankingMeta">{date}｜{ranking.currentGames} 場分析｜{ranking.entries.length} 個方向｜{view === 'order' ? '依開賽時間｜非推薦' : '依 S 分數由高到低'}</p>
    {ranking.outdatedGames > 0 && <p className="muted">{ranking.outdatedGames} 場盤口已變動、過期或已開賽，已退出目前排名。請讀取最新盤口後重新分析。</p>}
    {ranking.pendingGames > 0 && <p className="muted">{ranking.pendingGames} 場尚無完整盤口分析；每完成一場即更新排名。</p>}
    {view === 'ranking' ? ranking.entries.map(renderEntry) : groups.map((group, index) => <div className="betOrderGame" key={group.key}>
      <div className="betOrderGameHead"><div><span>第 {index + 1} 場</span><strong>{name(group.entries[0].game.away)}（客）@ {name(group.entries[0].game.home)}（主）</strong></div><time>{time(group.gameDate)}（台灣）</time></div>
      {group.entries.map(renderEntry)}
    </div>)}
    {view === 'order' && !groups.length && <div className="emptySmall">目前沒有公式分數達 7.0 的盤口方向。</div>}
    {view === 'order' && <details className="rankingDetails"><summary>順序說明</summary><p>依開賽時間排列；同場依全場讓分、全場大小、上半讓分、上半大小排序，同市場按分數排序。場次編號與方向序號分開顯示。</p></details>}
    {!ranking.entries.length && <div className="emptySmall">{filter === 'all' ? '尚無目前盤口的分析結果。請按「分析本日全部 NBA」。' : '這類盤口尚未開盤或尚無有效分析結果。'}</div>}
    <details className="rankingDetails"><summary>排序說明</summary><p>保留大小分與讓分雙邊，包括淨額為負的方向；沿用 MLB 的固定 S 公式，按 S、W、R 排序。W 是目前模型淨額；R 取至少兩個歷史季前賽球季（各至少 30 筆誤差）壓力測試與 W 的最小淨額。R 不是統計信賴下限，NBA 評分仍屬影子估計。</p><p>勝率與淨額是模型估計，尚未證實實際下注獲利；每 100 元淨額含 1.5% 退水。</p></details>
  </section>;
}
