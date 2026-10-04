'use client';

import { useEffect, useState } from 'react';
import { NBA_TEAM_LABELS } from '../../lib/nba/labels.js';
import { matchNbaReaderGame, nbaReaderDisplayStatus } from '../../lib/nba/reader-display.js';
import NbaAnalysisPanel from './analysis-panel';
import styles from './nba.module.css';

const DOWNLOAD = '/downloads/Tai888-Reader-v2.1.28-NBA-READ.zip';
const teamName = (team, code) => NBA_TEAM_LABELS[team?.abbreviation] || team?.name || code || '待核對';
const water = value => typeof value === 'number' && Number.isFinite(value) ? value.toFixed(3) : '—';
const time = value => Number.isFinite(Date.parse(value || ''))
  ? new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value)) : '—';

function Market({ title, value, total, away, home, locked }) {
  return <section className={styles.readerMarket}><h3>{title}</h3>{!value
    ? <p className={styles.muted}>{locked ? '鎖盤／未提供盤口' : '尚未讀到此市場'}</p>
    : total ? <><p><strong>{value.line}</strong></p><dl><div><dt>大分</dt><dd>{water(value.overWater)}</dd></div><div><dt>小分</dt><dd>{water(value.underWater)}</dd></div></dl></>
      : <><p><strong>{value.lineSide === 'away' ? away : home} 讓 {value.line}</strong></p><dl><div><dt>{away}（客）</dt><dd>{water(value.awayWater)}</dd></div><div><dt>{home}（主）</dt><dd>{water(value.homeWater)}</dd></div></dl></>}</section>;
}

export default function NbaReaderPanel({ date, scheduleResult }) {
  const [state, setState] = useState({ date: '', board: null, loading: false, error: '' });
  const [revision, setRevision] = useState(0);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const timer = setTimeout(() => controller.abort(), 20_000);
    setState(previous => ({ date, board: previous.date === date ? previous.board : null, loading: true, error: '' }));
    async function load() {
      try {
        const response = await fetch(`/api/nba/reader?date=${encodeURIComponent(date)}`, { cache: 'no-store', signal: controller.signal });
        const body = await response.json();
        if (!response.ok) throw new Error(response.status === 401 ? '登入已過期，請重新登入。' : body.error || 'NBA 盤口讀取失敗。');
        if (body.league !== 'NBA' || !Array.isArray(body.games) || (body.boardDate && body.boardDate !== date)) throw new Error('NBA 盤口身分或日期不符，請重新讀取。');
        if (!controller.signal.aborted) setState({ date, board: body, loading: false, error: '' });
      } catch (error) {
        if (!active) return;
        setState(previous => ({ ...previous, loading: false, error: error.name === 'AbortError' ? 'NBA 盤口讀取逾時，請重新讀取。' : error.message }));
      } finally { clearTimeout(timer); }
    }
    void load();
    return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [date, revision]);
  const board = state.date === date ? state.board : null;
  const status = nbaReaderDisplayStatus(board, now);
  const games = board?.games || [];
  useEffect(() => {
    if (!board) return;
    const deadlines = [Date.parse(board.observedAt || '') + 3 * 60_000, Date.parse(board.pageActivityAt || board.observedAt || '') + 3 * 60_000,
      ...(scheduleResult?.data?.games || []).map(game => Date.parse(game.startTime || ''))].filter(value => Number.isFinite(value) && value > Date.now());
    if (!deadlines.length) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(1, Math.min(...deadlines) - Date.now() + 1));
    return () => clearTimeout(timer);
  }, [board, scheduleResult, now]);
  return <section aria-label="NBA 今日盤口">
    <div className={styles.toolbar}><a href={DOWNLOAD}>下載 Reader v2.1.28</a><button type="button" className={styles.refresh} disabled={state.loading} onClick={() => setRevision(value => value + 1)}>{state.loading ? '讀取中…' : '重新讀取盤口'}</button></div>
    {state.error && <p className={styles.error} role="alert">{state.error}{state.error.includes('登入') && <a href="/login?next=/nba">重新登入</a>}</p>}
    <aside className={styles.sourceStatus} aria-label="NBA 盤口狀態"><div><strong>{status === 'fresh' ? 'NBA 盤口已同步' : status === 'stale' ? 'NBA 盤口已過期・保留上次內容' : '等待 NBA 盤口同步'}</strong><span>盤日 {date}・已讀 {games.length} 場</span>{board?.observedAt && <span>來源時間 {time(board.observedAt)}・Reader {board.readerVersion}</span>}</div></aside>
    {!games.length ? <div className={styles.empty}><p>電腦更新 Reader v2.1.28 後，開啟 Tai888「NBA → 讓分／大小」標準盤，按 Reader「立即同步」，再按「重新讀取盤口」。</p></div>
      : <div className={styles.sections}>{games.map(row => {
        const away = teamName(row.away, row.awayCode);
        const home = teamName(row.home, row.homeCode);
        const match = matchNbaReaderGame(row, scheduleResult);
        const type = { preseason: '季前賽', regular: '例行賽', postseason: '季後賽' }[match.game?.seasonType];
        const game = match.game;
        const canAnalyze = match.status === 'matched' && status === 'fresh' && game?.status === 'scheduled' && !game.completed
          && game.timeConfirmed === true && Date.parse(game.startTime || '') > now && row.marketStatus !== 'locked' && row.fullTotal != null;
        const validUntil = Math.min(Date.parse(game?.startTime || ''), Date.parse(board?.observedAt || '') + 3 * 60_000, Date.parse(board?.pageActivityAt || board?.observedAt || '') + 3 * 60_000);
        return <article key={`${row.boardDate}:${row.boardTime}:${row.awayCode}:${row.homeCode}`} className={styles.panel}>
          <div className={styles.cardMeta}><time>{row.boardDate} {row.boardTime}（台灣）</time><span>{type || '賽事類型待核對'}</span></div>
          <h2>{away}（客）對 {home}（主）</h2>
          <p className={styles.muted}>{match.status === 'matched' ? '場次、主客隊與開賽時間已核對賽程' : match.status === 'conflict' ? '此盤口尚未與官方賽程配對，保留原始讀取內容' : '賽程尚未取得，場次身分待核對'}</p>
          <div className={styles.readerMarkets}>
            <Market title="全場讓分" value={row.fullRunline} away={away} home={home} locked={row.marketStatus === 'locked'}/>
            <Market title="全場大小" value={row.fullTotal} total locked={row.marketStatus === 'locked'}/>
            <Market title="上半讓分" value={row.firstHalfRunline} away={away} home={home} locked={row.marketStatus === 'locked'}/>
            <Market title="上半大小" value={row.firstHalfTotal} total locked={row.marketStatus === 'locked'}/>
          </div>
          {canAnalyze && <NbaAnalysisPanel key={JSON.stringify([game.id, board.observedAt, row.fullTotal])} date={date} game={game} row={row} observedAt={board.observedAt} validUntil={validUntil} away={away} home={home}/>}
        </article>;
      })}</div>}
  </section>;
}
