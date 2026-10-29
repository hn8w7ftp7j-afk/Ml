'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { APP_VERSION } from '../../lib/app-version.js';
import { SoccerReaderBoards, soccerReaderBoardDates } from './reader-panel.js';
import { SoccerReaderInventoryPanel } from './reader-inventory-panel.js';
import SoccerAnalysisPanel, { SoccerAnalysisProvider } from './analysis-panel.js';
import { soccerTeamLabel } from '../../lib/soccer/team-labels.js';
import './soccer.css';

const SOCCER_LEAGUES = { EPL: { name: '英超', fullName: '英格蘭超級聯賽' }, UCL: { name: '歐冠 UCL', fullName: '歐洲冠軍聯賽' } };
const VIEW_NAMES = { schedule: '當日賽程', upcoming: '近期賽程', standings: '積分榜' };
const STATUSES = { scheduled: '未開賽', live: '比賽中', final: '已完賽', postponed: '延期', cancelled: '取消', unknown: '狀態待更新' };

function taipeiDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function shiftDate(value, days) {
  if (!validDate(value)) return value;
  const next = new Date(`${value}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}
function readLocation(search, now = new Date()) {
  const query = new URLSearchParams(search);
  const rawLeague = (query.get('sport') || query.get('league') || '').toUpperCase();
  return {
    league: Object.hasOwn(SOCCER_LEAGUES, rawLeague) ? rawLeague : 'EPL',
    date: validDate(query.get('date')) ? query.get('date') : taipeiDate(now),
    view: Object.hasOwn(VIEW_NAMES, query.get('view')) ? query.get('view') : 'schedule',
    ...(/^[a-zA-Z0-9_:-]{8,300}$/.test(query.get('runId')||'') ? { runId: query.get('runId') } : {}),
  };
}
function workspaceUrl(location, embedded = false) {
  const query = new URLSearchParams({ [embedded ? 'sport' : 'league']: location.league, date: location.date });
  if (location.view !== 'schedule') query.set('view', location.view);
  if (/^[a-zA-Z0-9_:-]{8,300}$/.test(location.runId||'')) query.set('runId', location.runId);
  return `${embedded ? '/' : '/soccer'}?${query}`;
}
function savedAllRun() {
  try { return JSON.parse(window.localStorage.getItem('sports-positive-ev-all-league-analysis-v1') || 'null'); } catch { return null; }
}
function runLocation(location, run, allowDate = true) {
  const date = run?.leagues?.[location.league]?.boardDate;
  if (!validDate(date) || typeof run?.runId !== 'string' || !/^[a-zA-Z0-9_:-]{8,300}$/.test(run.runId)
    || !allowDate && location.date !== date) return null;
  return { ...location, date, runId: run.runId };
}
function boardKey(location) { return `soccer:${location.league}:${location.date}:${location.view}`; }
function teamName(team) { return soccerTeamLabel(team); }
function scoreValue(value) { return Number.isInteger(value) && value >= 0 ? value : null; }
function verifiedScore(game) {
  if (!['live', 'final'].includes(game.status)) return null;
  const home = scoreValue(game.home?.score);
  const away = scoreValue(game.away?.score);
  return home == null || away == null ? null : `${home} : ${away}`;
}
function clock(value, dateOnly = false) {
  if (!value || !Number.isFinite(Date.parse(value))) return '尚未提供';
  return new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', ...(dateOnly ? { month: 'numeric', day: 'numeric' } : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) }).format(new Date(value));
}
function safeSourceUrl(value) {
  try { const parsed = new URL(value); return parsed.protocol === 'https:' ? parsed.href : null; } catch { return null; }
}
function validateBoard(body, location) {
  const id = location.league.toLowerCase();
  if (body?.ok !== true || body.league?.id !== id || body.timeZone !== 'Asia/Taipei' || body.date !== location.date) throw new Error('賽事聯盟或日期不符，請重新整理。');
  if (location.view === 'standings') {
    if (!Array.isArray(body.standings) || body.standings.some(group => !Array.isArray(group?.rows) || group.rows.some(row => !row?.team?.id?.startsWith(`soccer:${id}:team:`)))) throw new Error('積分榜球隊識別不符，請重試。');
  } else {
    if (!Array.isArray(body.games)) throw new Error('賽程資料不完整，請重試。');
    for (const game of body.games) {
      if (game?.league !== id || !game.id?.startsWith(`soccer:${id}:`) || !validDate(game.date) || (location.view === 'schedule' && game.date !== location.date)) throw new Error('賽事識別不符，已停止顯示這次資料。');
    }
  }
  return body;
}
async function requestBoard(location, signal) {
  const query = new URLSearchParams({ league: location.league.toLowerCase(), date: location.date });
  if (location.view !== 'schedule') query.set('view', location.view);
  const response = await fetch(`/api/soccer?${query}`, { signal, cache: 'no-store' });
  let body;
  try { body = await response.json(); } catch { throw new Error('資料來源暫時無法讀取，請重試。'); }
  if (response.status === 401) throw new Error('登入已過期，請返回首頁重新登入。');
  if (!response.ok || body.ok !== true) throw new Error(body.message || body.error || '足球資料暫時無法載入，請稍後重試。');
  return validateBoard(body, location);
}

function Source({ value }) {
  if (!value) return null;
  const url = safeSourceUrl(value.url);
  return <p className="soccerSource">來源 {url ? <a href={url} target="_blank" rel="noreferrer">{value.provider || '賽事資料'}</a> : value.provider || '賽事資料'}<span>更新 {clock(value.fetchedAt || value.observedAt)}</span></p>;
}
function MatchCard({ game, showDate }) {
  const score = verifiedScore(game);
  const halfTime = game.halfTime?.verified === true && scoreValue(game.halfTime.home) != null && scoreValue(game.halfTime.away) != null ? `${game.halfTime.home} : ${game.halfTime.away}` : null;
  return <article className="gameCard soccerGame" data-soccer-game={game.id}>
    <div className="soccerMatchTop"><time dateTime={game.startTime || undefined}>{clock(game.startTime)}</time><span className={`soccerStatus ${game.status}`}>{STATUSES[game.status] || STATUSES.unknown}</span></div>
    <h2 className="soccerMatchup"><span className="soccerTeam"><small>主隊</small><span>{teamName(game.home)}</span></span><span className={`soccerScore ${score ? '' : 'pending'}`} aria-label={score ? `主隊 ${game.home.score}，客隊 ${game.away.score}` : '尚無比分'}>{score || 'VS'}</span><span className="soccerTeam soccerAway"><small>客隊</small><span>{teamName(game.away)}</span></span></h2>
    <SoccerAnalysisPanel game={game}/>
    {halfTime && <p className="soccerHalfTime">半場 {halfTime}</p>}
    <details className="soccerDetails"><summary>賽事資料</summary><dl className="soccerFacts"><dt>賽事狀態</dt><dd>{game.statusText || STATUSES[game.status] || STATUSES.unknown}</dd><dt>開賽時間</dt><dd>{clock(game.startTime)}（台灣）</dd>{showDate && <><dt>賽事日期</dt><dd>{game.date}</dd></>}{game.round && <><dt>輪次</dt><dd>{game.round}</dd></>}{game.venue && <><dt>球場</dt><dd>{typeof game.venue === 'string' ? game.venue : game.venue.name || '尚未提供'}</dd></>}</dl><Source value={game.source}/></details>
  </article>;
}
function Standings({ board }) {
  const groups = Array.isArray(board.standings) ? board.standings : [];
  if (!groups.length) return <section className="emptyBoard soccerEmpty"><h2>積分榜尚未提供</h2><p>資料來源目前沒有可顯示的積分榜。</p></section>;
  return <div className="soccerStandings">{groups.map((group, index) => <section className="panel" key={group.id || group.name || index}><h2>{group.name || '聯賽積分榜'}</h2><div className="soccerTableWrap" tabIndex="0" role="region" aria-label={`${group.name || '聯賽'}積分榜，可左右捲動`}><table className="soccerTable"><thead><tr><th scope="col">排名</th><th scope="col">球隊</th><th scope="col">場</th><th scope="col">勝</th><th scope="col">和</th><th scope="col">敗</th><th scope="col">淨球</th><th scope="col">積分</th></tr></thead><tbody>{(group.rows || []).map((row, rowIndex) => <tr key={row.team?.id || row.id || rowIndex}><td>{row.rank ?? '—'}</td><th scope="row">{teamName(row.team)}</th><td>{row.played ?? '—'}</td><td>{row.won ?? '—'}</td><td>{row.drawn ?? '—'}</td><td>{row.lost ?? '—'}</td><td>{row.goalDifference ?? '—'}</td><td><strong>{row.points ?? '—'}</strong></td></tr>)}</tbody></table></div></section>)}</div>;
}

export default function SoccerMainWorkspace({ active = true, embedded = false, selectedLeague = 'EPL', allRun = null, onAnalyzeAll = null, otherBusy = false, onHighScoreStatusChange = null, onBusyChange = null, onScopeChange = null, requestedScope = null }) {
  const [location, setLocation] = useState({ league: Object.hasOwn(SOCCER_LEAGUES, selectedLeague) ? selectedLeague : 'EPL', date: '', view: 'schedule' });
  const [responses, setResponses] = useState({});
  const [loadingKey, setLoadingKey] = useState('');
  const [failure, setFailure] = useState(null);
  const [refresh, setRefresh] = useState(0);
  const [leagueBatchRequest, setLeagueBatchRequest] = useState(null);
  const batchSequence = useRef(0);
  const generation = useRef(0);
  const opened = useRef(false), appliedRuns = useRef(new Set()), manualRun = useRef(''), entryRun = useRef(null);
  const latestLocation = useRef(location); latestLocation.current = location;
  const requested = useRef(null), reportedScope = useRef(''), scopeCallback = useRef(onScopeChange);
  scopeCallback.current = onScopeChange;
  const key = boardKey(location);
  const board = responses[key];
  const busy = loadingKey === key;
  const error = failure?.key === key ? failure.message : '';
  const league = SOCCER_LEAGUES[location.league];

  useEffect(() => {
    if (!active) return;
    const sync = (initialEntry = false) => {
      const query = new URLSearchParams(window.location.search);
      const next = readLocation(window.location.search);
      if (embedded) {
        next.league = Object.hasOwn(SOCCER_LEAGUES, selectedLeague) ? selectedLeague : 'EPL';
        // A fixed league instance retains its date while another league is shown.
        if (initialEntry && opened.current && latestLocation.current.date) return;
        if (!initialEntry && query.get('sport')?.toUpperCase() !== next.league) return;
      }
      const run = allRun || savedAllRun();
      if (entryRun.current === null) entryRun.current = run?.runId || '';
      if (!query.has('date')) {
        const scoped = runLocation(next, run);
        if (scoped) Object.assign(next, scoped);
      }
      opened.current = true;
      setLocation(next);
    };
    sync(true);
    const onPopState = () => sync(false);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [active, embedded, selectedLeague]);

  useEffect(() => {
    if (!active || !location.date) return;
    const controller = new AbortController();
    const token = ++generation.current;
    let timedOut = false;
    setLoadingKey(key);
    setFailure(null);
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 45_000);
    requestBoard(location, controller.signal).then(body => {
      if (token !== generation.current || controller.signal.aborted) return;
      setResponses(previous => ({ ...previous, [key]: body }));
    }).catch(cause => {
      if (token !== generation.current || (controller.signal.aborted && !timedOut)) return;
      setFailure({ key, message: timedOut ? '資料載入逾時，請重試。' : cause.message || '資料暫時無法載入，請重試。' });
    }).finally(() => {
      clearTimeout(timer);
      if (token === generation.current) setLoadingKey('');
    });
    return () => { clearTimeout(timer); controller.abort(); };
  }, [key, refresh, active]);

  useEffect(() => {
    if (!active || !location.date) return;
    const scoped = runLocation(location, allRun);
    if (!scoped) return;
    const scope = `${scoped.runId}:${location.league}`;
    if (appliedRuns.current.has(scope)) return;
    appliedRuns.current.add(scope);
    const query = new URLSearchParams(window.location.search);
    // Existing links/manual date choices cannot be reset by a late old batch.
    const preserveDate = manualRun.current === scoped.runId
      || entryRun.current === scoped.runId && validDate(query.get('date')) && query.get('runId') !== scoped.runId;
    const next = runLocation(location, allRun, !preserveDate);
    if (!next) return;
    if (next.date !== location.date || next.runId !== location.runId) {
      generation.current += 1;
      window.history.replaceState(null, '', workspaceUrl(next, embedded));
      setLocation(next);
    }
  }, [active, embedded, location.league, location.date, allRun?.runId, allRun?.leagues?.[location.league]?.boardDate]);

  useEffect(() => {
    if (!active || !requestedScope || requested.current === requestedScope) return;
    const league = String(requestedScope.league || selectedLeague).toUpperCase();
    if (!Object.hasOwn(SOCCER_LEAGUES, league) || embedded && league !== selectedLeague || !validDate(requestedScope.date)) return;
    requested.current = requestedScope;
    const next = { league, date: requestedScope.date, view: Object.hasOwn(VIEW_NAMES, requestedScope.view) ? requestedScope.view : 'schedule' };
    if (/^[a-zA-Z0-9_:-]{8,300}$/.test(requestedScope.runId || '')) next.runId = requestedScope.runId;
    manualRun.current = next.runId ? '' : allRun?.runId || '';
    generation.current += 1;
    opened.current = true;
    window.history.replaceState(null, '', workspaceUrl(next, embedded));
    setLocation(next);
  }, [active, embedded, selectedLeague, requestedScope]);

  useEffect(() => {
    if (!active || !location.date) return;
    const signature = `${boardKey(location)}:${location.runId || ''}`;
    if (reportedScope.current === signature) return;
    reportedScope.current = signature;
    scopeCallback.current?.({ ...location, runId: location.runId || '' });
  }, [active, location.league, location.date, location.view, location.runId]);

  // A previous click must not replay when an old date/view is mounted again.
  useEffect(() => { setLeagueBatchRequest(null); }, [key]);

  function navigate(next) {
    if (!validDate(next.date) || boardKey(next) === boardKey(location) && next.runId === location.runId) return;
    next = { ...next };
    if (next.league !== location.league) {
      next = runLocation(next, allRun || savedAllRun()) || next;
    } else if (next.date !== location.date) {
      manualRun.current = allRun?.runId || location.runId || '';
      delete next.runId;
    }
    // Invalidate this response immediately, before React runs effect cleanup.
    generation.current += 1;
    window.history.pushState(null, '', workspaceUrl(next, embedded));
    setLocation(next);
  }
  function leagueClick(event, id) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate({ ...location, league: id });
  }
  function retry() { setRefresh(value => value + 1); }
  const games = board?.games || [];
  const analysisTargets = [...new Map(games.filter(game => game.league === location.league.toLowerCase()
    && game.status === 'scheduled' && Date.parse(game.startTime) > Date.now()).map(game => [game.id, game])).values()];
  const canAnalyzeLeague = active && Boolean(board) && !busy && !error && !otherBusy
    && location.view !== 'standings' && analysisTargets.length > 0;
  function analyzeLeague() {
    if (!canAnalyzeLeague) return;
    setLeagueBatchRequest({ id: ++batchSequence.current, scope: key });
  }
  const dateLabel = location.date || '讀取中';
  const displayCount = location.view === 'standings' ? '積分榜' : `${games.length} 場`;
  const dateInputId = `soccer-date-${location.league.toLowerCase()}`;

  if (!active && !opened.current) return null;
  const WorkspaceElement = embedded ? 'section' : 'main';
  return <WorkspaceElement className={embedded ? 'soccerApp soccerEmbedded' : 'appShell soccerApp'} hidden={!active} aria-label={embedded ? `${league.name}分析工作區` : undefined}>
    {!embedded && <>
    <header className="appHeader"><div><div className="eyebrow">FOOTBALL</div><h1>{league.name}｜足球賽程</h1><p>{league.fullName}・台灣時間</p></div><div className="headerBadges"><span className="version">v{APP_VERSION}</span></div></header>
    <nav className="soccerLeagueNav" aria-label="聯盟切換"><Link prefetch={false} href={`/?league=MLB${location.date ? `&date=${location.date}` : ''}`}><b>棒球</b><small>MLB・日韓台棒</small></Link><Link prefetch={false} href={`/?sport=NBA${location.date ? `&date=${location.date}` : ''}`}><b>NBA</b><small>美國職籃</small></Link>{Object.entries(SOCCER_LEAGUES).map(([id, item]) => <a key={id} href={workspaceUrl({ ...location, league: id }, embedded)} onClick={event => leagueClick(event, id)} aria-current={location.league === id ? 'page' : undefined} className={location.league === id ? 'active' : ''}><b>{id}</b><small>{item.name}</small></a>)}</nav></>}
    <section className="panel soccerControls" aria-label="足球賽程查詢">
      <div className="soccerDateControls"><button type="button" className="secondary" aria-label="前一天" disabled={!location.date} onClick={() => navigate({ ...location, date: shiftDate(location.date, -1), view: 'schedule' })}>前一天</button><label htmlFor={dateInputId}>台灣日期<input id={dateInputId} type="date" value={location.date} onChange={event => { if (validDate(event.target.value)) navigate({ ...location, date: event.target.value, view: 'schedule' }); }}/></label><button type="button" className="secondary" aria-label="後一天" disabled={!location.date} onClick={() => navigate({ ...location, date: shiftDate(location.date, 1), view: 'schedule' })}>後一天</button><button type="button" className="secondary" onClick={() => navigate({ ...location, date: taipeiDate(), view: 'schedule' })}>今天</button><button type="button" className="secondary soccerRefresh" disabled={!location.date || busy} onClick={retry}>{busy ? '更新中…' : '重新整理'}</button></div>
      <div className="soccerViewNav" aria-label="足球資料檢視">{Object.entries(VIEW_NAMES).map(([view, name]) => <button key={view} type="button" className={location.view === view ? 'active' : ''} aria-pressed={location.view === view} disabled={!location.date} onClick={() => navigate({ ...location, view })}>{name}</button>)}</div>
      {location.date&&<><div className="soccerAnalyzeActions"><button type="button" className="primary soccerLeagueAnalyzeButton" disabled={!canAnalyzeLeague} onClick={analyzeLeague}>{otherBusy ? '分析工作進行中…' : `一鍵分析${location.league === 'EPL' ? '英超' : '歐冠'}`}</button>{embedded ? <button type="button" className="secondary allLeagueAnalyzeButton" disabled={otherBusy || !onAnalyzeAll} onClick={() => onAnalyzeAll?.(location.date)}>一鍵分析全部聯盟</button> : <a className="secondary allLeagueAnalyzeButton" href={`/?analyzeAll=1&date=${encodeURIComponent(location.date)}`}>一鍵分析全部聯盟</a>}</div><p className="soccerAvailability">{location.view === 'standings' ? '切回當日或近期賽程，即可分析本聯盟。' : busy ? '正在讀取本聯盟賽程…' : error ? '請先重新整理賽程，再分析本聯盟。' : analysisTargets.length ? `${location.view === 'upcoming' ? '目前近期賽程' : `${location.date}（台灣時間）`}｜僅分析${league.name}未開賽 ${analysisTargets.length} 場` : '目前沒有可分析的未開賽賽事。'}</p></>}
      <p className="soccerAvailability">目前可更新賽前資料與比分研究；正式評分尚未完成，有盤口仍不代表已有 S 分數。新鮮且期間已確認的原盤可顯示條件式收益分析；未同步原盤時，可先分析賽事，再使用手動盤口試算。<Link prefetch={false} href="/soccer/specification">分析規格 2.2</Link></p>
    </section>
    {active && <><SoccerReaderBoards league={location.league} date={location.date} games={games} view={location.view}/><SoccerReaderInventoryPanel league={location.league} date={location.date} throughDate={soccerReaderBoardDates({league:location.league,date:location.date,games,view:location.view}).at(-1)||location.date} onSelectDate={savedDate=>navigate({...location,date:savedDate,view:'schedule'})}/></>}
    {error && <div className="errorBox soccerError" role="alert"><div><strong>{board ? '更新失敗，保留上次資料' : '資料載入失敗'}</strong><p>{error}</p></div><button type="button" className="secondary" disabled={busy} onClick={retry}>重試</button></div>}
    <section aria-label={`${league.name}${VIEW_NAMES[location.view]}`} aria-busy={busy}>
      <div className="soccerBoardHeading"><h2>{location.view === 'upcoming' ? '近期賽程' : location.view === 'standings' ? '目前積分榜' : dateLabel}</h2><span role="status" aria-live="polite">{busy ? board ? '更新中…' : '載入中…' : board ? displayCount : ''}</span></div>
      {board && <Source value={board.source}/>}
      {board?.cohortPersistence?.persisted===false&&<p className="soccerAnalysisWarning" role="status">賽程紀錄暫未保存，統計範圍尚未確認。</p>}
      {busy && !board && <div className="panel soccerLoading" role="status">正在取得{league.name}資料…</div>}
      {board && location.view === 'standings' && <><p className="soccerAvailability">目前賽季積分，不回推所選日期。</p><Standings board={board}/></>}
      {board && location.view !== 'standings' && <SoccerAnalysisProvider key={key} games={games} runId={location.runId||''} league={location.league.toLowerCase()} date={location.date} batchScope={key} batchRequest={leagueBatchRequest} onHighScoreStatusChange={onHighScoreStatusChange} onBusyChange={onBusyChange} externalBusy={otherBusy}><div className="soccerGames">{games.map(game => <MatchCard key={game.id} game={game} showDate={location.view === 'upcoming'}/>)}</div>{!games.length&&<section className="emptyBoard soccerEmpty"><h2>{location.view === 'upcoming' ? '近期查無賽事' : '當日無賽事'}</h2><p>{location.view === 'upcoming' ? '來源在目前查詢範圍沒有列出賽事。' : `${dateLabel}（台灣時間）未安排${league.name}賽事。`}</p>{location.view === 'schedule' && <button type="button" className="primary" onClick={() => navigate({ ...location, view: 'upcoming' })}>查看近期賽程</button>}</section>}</SoccerAnalysisProvider>}
    </section>
  </WorkspaceElement>;
}
