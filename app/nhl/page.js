'use client';

import { useEffect, useRef, useState } from 'react';
import NbaEntry from '../nba/entry.js';
import { APP_VERSION } from '../../lib/app-version.js';
import { LEAGUE_IDS, leagueConfig } from '../../lib/leagues.js';

const CACHE = 'sports:nhl:workspace:v1';
const TABS = [['schedule', '賽程與結果'], ['team', '球隊與球員'], ['goalie', '門將與陣容'], ['research', '歷史 Shadow'], ['sources', '資料與 Reader']];
const taipeiDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const clock = (value, zone = 'Asia/Taipei') => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('zh-TW', { timeZone: zone, dateStyle: 'short', timeStyle: 'short', hour12: false }).format(new Date(value)) : '尚未提供';
const number = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 3 }) : '—';
const phase = value => value === 'PRESEASON_SHADOW' ? '季前賽｜獨立 Shadow' : value === 'REGULAR' ? '例行賽' : value === 'PLAYOFFS' ? '季後賽' : '賽季類型待核對';
const state = value => ({ FUT: '尚未開賽', PRE: '賽前', LIVE: '比賽中', CRIT: '比賽中', OFF: '已完賽', FINAL: '已完賽' }[value] || value || '待更新');

async function request(action, args = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 28_000);
  try {
    const response = await fetch(`/api/nhl?${new URLSearchParams({ action, ...args })}`, { cache: 'no-store', signal: controller.signal });
    const body = await response.json();
    if (response.status === 401) throw new Error('登入已過期，請重新登入網站。');
    if (!response.ok || body.ok === false) throw new Error(body.error || body.message || body.code || 'NHL 資料載入失敗');
    if (body.league !== 'NHL') throw new Error('聯盟識別不一致，已停止顯示這次回應。');
    return body;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('NHL 資料來源回應逾時，先前結果仍保留，可按按鈕重試。');
    throw error;
  } finally { clearTimeout(timer); }
}

function Source({ source }) {
  if (!source?.url) return null;
  return <div className="nhlSource">來源：<a href={source.url} target="_blank" rel="noreferrer">{source.provider || 'NHL 官方'}</a>｜取得時間 {clock(source.fetchedAt || source.observedAt)}{source.contentHash && <details><summary>來源版本</summary><span>{source.contentHash}</span></details>}</div>;
}
function Stat({ label, value }) { return <div className="nhlStat"><span>{label}</span><strong>{number(value)}</strong></div>; }
function SituationRatios({ value }) {
  if (!value?.ok || value.metricScope !== 'OBSERVED_EVENTS_NOT_PREGAME_FEATURES') return null;
  const percent = x => typeof x === 'number' && Number.isFinite(x) ? `${(x * 100).toFixed(2)}%` : '—';
  return <div><h3>同情境射正與撲救｜描述性統計</h3>
    <div className="nhlTableWrap"><table className="nhlTable"><thead><tr><th>情境／球隊</th><th>被射正</th><th>失球</th><th>射正占比</th><th>射門得分率</th><th>團隊撲救率</th></tr></thead>
      <tbody>{[['fiveOnFive', '5v5'], ['powerPlay', 'PP'], ['shortHanded', 'PK']].flatMap(([key, label]) => ['away', 'home'].map(side => {
        const row = value[side]?.[key];
        return <tr key={`${key}:${side}`}><td>{label}／{side === 'away' ? '客隊' : '主隊'}</td><td>{number(row?.shotsOnGoalAgainst)}</td><td>{number(row?.goalsAgainst)}</td><td>{percent(row?.shotShare)}</td><td>{percent(row?.shootingPercent)}</td><td>{percent(row?.savePercent)}</td></tr>;
      }))}</tbody></table></div>
    <p className="nhlNote">PP 對照對手 PK，5v5 對照對手 5v5；不含空門與 Shootout。團隊撲救率不是個別門將評分，PP 射門得分率不是 PP 機會成功率。零分母或情境資料不完整時比例留空。只描述本次取得的比賽事件，不作為已驗證的賽前特徵。</p>
    <Source source={value.source}/></div>;
}
function OfficialGameReport({ value }) {
  if (!value) return null;
  if (!value.ok) return <p className="nhlWarning">官方比賽報表 QA BLOCK：{value.issues?.join('、')}</p>;
  const percent = x => typeof x === 'number' ? `${(x * 100).toFixed(2)}%` : '—';
  return <details><summary>官方 PP／PK 與本場未出賽名單</summary>
    <div className="nhlTableWrap"><table className="nhlTable"><thead><tr><th>球隊</th><th>PP 進球／機會</th><th>PP 成功率</th><th>PK 成功率</th></tr></thead>
      <tbody>{['away', 'home'].map(side => <tr key={side}><td>{side === 'away' ? '客隊' : '主隊'}</td><td>{value[side].powerPlayGoals}／{value[side].powerPlayOpportunities}</td><td>{percent(value[side].powerPlayPercent)}</td><td>{percent(value[side].penaltyKillPercent)}</td></tr>)}</tbody></table></div>
    {['away', 'home'].map(side => <p key={side}>{side === 'away' ? '客隊' : '主隊'} scratches：{value[side].scratches == null ? '來源尚未提供' : value[side].scratches.length === 0 ? '官方列出 0 人' : value[side].scratches.map(player => `${player.name || '姓名待核對'}（${player.playerId}）`).join('、')}</p>)}
    <p className="nhlNote">Scratches 只表示本場未列入出賽名單，不代表傷病診斷，也不代表已取得賽前發布時間。這是本次取得的官方比賽報表，不回填為歷史賽前證據。</p><Source source={value.source}/></details>;
}
function Empty({ title, children }) { return <section className="emptyBoard"><h2>{title}</h2><p>{children}</p></section>; }
function GameNotices({ detail }) {
  if (!detail) return null;
  return <div className="nhlNote">{detail.warning && <p className="nhlWarning">{detail.warning}</p>}{detail.issues?.length > 0 && <p className="nhlWarning">部分資料尚未取得或未通過 QA：{detail.issues.join('、')}</p>}{detail.observation && <p>{detail.observation.persisted ? '來源快照已永久保存' : detail.observation.reason}</p>}<OfficialGameReport value={detail.game?.officialReport}/><SituationRatios value={detail.game?.observedSituationStatistics}/></div>;
}
function ScheduleContext({ value }) {
  return <div><p className="nhlNote">{value.message}</p><div className="nhlTableWrap"><table className="nhlTable"><thead><tr><th>球隊</th><th>休息日</th><th>背靠背</th><th>近 7 日含本場</th><th>旅行公里</th></tr></thead><tbody>{['away', 'home'].map(side => <tr key={side}><td>{side === 'away' ? '客隊' : '主隊'}{value[side]?.estimated ? '（預計）' : ''}</td><td>{number(value[side]?.restDays)}</td><td>{value[side]?.backToBack == null ? '待核對' : value[side].backToBack ? '是' : '否'}</td><td>{number(value[side]?.gamesIn7Days)}</td><td>{number(value[side]?.travelKm)}</td></tr>)}</tbody></table></div>{['away', 'home'].map(side => <Source key={side} source={value[side]?.source}/>)}</div>;
}
function SituationStatistics({ value }) {
  if (!value) return null;
  if (!value.ok) return <p className="nhlWarning" role="alert">逐球統計未通過 QA：{value.issues?.join('、')}。不顯示可能衝突的情境數據。</p>;
  return <div><h3>官方逐球事件｜比賽情境</h3><div className="nhlTableWrap"><table className="nhlTable"><thead><tr><th>情境</th><th>客隊射正</th><th>主隊射正</th><th>客隊進球</th><th>主隊進球</th></tr></thead><tbody>{[['fiveOnFive', '5v5'], ['powerPlay', 'Power Play'], ['shortHanded', 'Short-handed']].map(([key, label]) => <tr key={key}><td>{label}</td><td>{number(value.away?.[key]?.shotsOnGoal)}</td><td>{number(value.home?.[key]?.shotsOnGoal)}</td><td>{number(value.away?.[key]?.goals)}</td><td>{number(value.home?.[key]?.goals)}</td></tr>)}</tbody></table></div><p className="nhlNote">依官方場上人數核對事件；不含空門及 Shootout。這些是事件次數，沒有 5v5 時間分母、xG 或 PP 機會數時，不推算每 60 分鐘效率。</p>{value.unknownSituationEvents > 0 && <p className="nhlWarning">{value.unknownSituationEvents} 筆事件情境未知，未計入分類。</p>}<Source source={value.source}/></div>;
}
function ClubStatistics({ value }) {
  const playerName = row => [row.firstName?.default, row.lastName?.default].filter(Boolean).join(' ') || row.playerId;
  return <details><summary>官方球員賽季統計｜例行賽</summary><p className="nhlNote">球員在這支球隊的累計數據；不當成球隊 5v5 效率。</p><div className="nhlTableWrap"><table className="nhlTable"><thead><tr><th>球員</th><th>出賽</th><th>進球</th><th>助攻</th><th>射正</th><th>射門得分率</th><th>PP 進球</th></tr></thead><tbody>{value.skaters?.map(row => <tr key={row.playerId}><td>{playerName(row)}</td><td>{number(row.gamesPlayed)}</td><td>{number(row.goals)}</td><td>{number(row.assists)}</td><td>{number(row.shots)}</td><td>{number(row.shootingPctg)}</td><td>{number(row.powerPlayGoals)}</td></tr>)}</tbody></table></div><Source source={value.source}/></details>;
}

export default function NhlWorkspace() {
  const [date, setDate] = useState(taipeiDay);
  const [tab, setTab] = useState('schedule');
  const [boards, setBoards] = useState({});
  const [details, setDetails] = useState({});
  const [selectedGame, setSelectedGame] = useState(null);
  const [selectedTeam, setSelectedTeam] = useState(null);
  const [rosters, setRosters] = useState({});
  const [teamSummaries, setTeamSummaries] = useState({});
  const [summaryType, setSummaryType] = useState(2);
  const [player, setPlayer] = useState(null);
  const [contexts, setContexts] = useState({});
  const [versions, setVersions] = useState({});
  const [status, setStatus] = useState(null);
  const [research, setResearch] = useState(null);
  const [busy, setBusy] = useState({});
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const inFlight = useRef(new Set());
  const activePlayerRequest = useRef(null);
  const board = boards[date];
  const game = selectedGame ? details[selectedGame]?.game || board?.games?.find(row => row.gameId === selectedGame) : null;
  const rosterKey = selectedTeam ? `${selectedTeam.abbrev}:${selectedTeam.season || 'current'}` : '';
  const roster = rosters[rosterKey];
  const summaryKey = selectedTeam ? `${selectedTeam.teamId}:${selectedTeam.season}:${summaryType}` : '';
  const teamSummary = teamSummaries[summaryKey];

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(CACHE) || 'null');
      if (saved?.league === 'NHL') {
        if (typeof saved.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(saved.date) && saved.boards?.[saved.date]?.league === 'NHL') setDate(saved.date);
        if (saved.selectedGame && saved.details?.[saved.selectedGame]?.game?.league === 'NHL' && saved.details[saved.selectedGame].game.gameId === saved.selectedGame) setSelectedGame(saved.selectedGame);
        if (saved.boards && typeof saved.boards === 'object') setBoards(Object.fromEntries(Object.entries(saved.boards).filter(([key, value]) => /^\d{4}-\d{2}-\d{2}$/.test(key) && value?.league === 'NHL' && Array.isArray(value.games) && value.games.every(game => game.league === 'NHL' && game.taipeiDate === key))));
        if (saved.details && typeof saved.details === 'object') setDetails(Object.fromEntries(Object.entries(saved.details).filter(([key, value]) => value?.league === 'NHL' && value.game?.league === 'NHL' && value.game?.gameId === key)));
      }
    } catch { /* A damaged local copy never changes a server record. */ }
    setReady(true);
    request('status').then(setStatus).catch(cause => setError(cause.message));
  }, []);
  useEffect(() => {
    if (!ready) return;
    try {
      localStorage.setItem(CACHE, JSON.stringify({ league: 'NHL', date, selectedGame, boards: Object.fromEntries(Object.entries(boards).slice(-8)), details: Object.fromEntries(Object.entries(details).slice(-12)) }));
    } catch { setError('這台裝置無法保存 NHL 顯示快照；目前結果仍保留在畫面，可重新載入官方資料。'); }
  }, [boards, details, date, selectedGame, ready]);

  async function run(key, operation) {
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key); setBusy(value => ({ ...value, [key]: true })); setError('');
    try { await operation(); }
    catch (cause) { setError(cause.message || '載入失敗，先前資料已保留。'); }
    finally { inFlight.current.delete(key); setBusy(value => ({ ...value, [key]: false })); }
  }
  function loadSchedule(target = date) {
    return run(`schedule:${target}`, async () => {
      const result = await request('schedule', { date: target });
      if (result.date !== target) throw new Error('回應日期不符，已保留原本賽程。');
      setBoards(value => ({ ...value, [target]: result }));
    });
  }
  function loadGame(id) {
    setSelectedGame(id);
    return run(`game:${id}`, async () => {
      const result = await request('game', { gameId: id });
      if (result.game?.gameId !== id) throw new Error('賽事識別不符，已停止更新。');
      setDetails(value => ({ ...value, [id]: result }));
    });
  }
  function loadTeam(team, season = 'current') {
    activePlayerRequest.current = null;
    const selected = { ...team, season }; setSelectedTeam(selected); setTab('team'); setPlayer(null);
    const key = `${team.abbrev}:${season}`;
    return run(`team:${key}`, async () => {
      const result = await request('team', { team: team.abbrev, teamId: String(team.teamId), season: String(season) });
      if (result.roster?.teamId !== team.teamId) throw new Error('球隊識別不符。');
      setRosters(value => ({ ...value, [key]: result }));
    });
  }
  function loadPlayer(id) {
    activePlayerRequest.current = id;
    return run(`player:${id}`, async () => {
      const result = await request('player', { playerId: String(id) });
      if (id === activePlayerRequest.current) setPlayer(result);
    });
  }
  function loadTeamSummary(team, gameType) {
    const season = Number(team.season);
    const key = `${team.teamId}:${season}:${gameType}`;
    return run(`team-summary:${key}`, async () => {
      const result = await request('team-summary', { teamId: String(team.teamId), season: String(season), gameType: String(gameType) });
      if (result.league !== 'NHL' || result.teamId !== team.teamId || result.season !== season || result.gameType !== gameType)
        throw new Error('球隊統計的球隊、賽季或賽事類型不符，已保留先前結果。');
      setTeamSummaries(value => ({ ...value, [key]: result }));
    });
  }
  function loadContext(id) { return run(`context:${id}`, async () => { const result = await request('context', { gameId: id }); if (result.gameId !== id) throw new Error('賽程身分不符'); setContexts(value => ({ ...value, [id]: result })); }); }
  function loadVersions(id) { return run(`versions:${id}`, async () => { const result = await request('versions', { gameId: id }); setVersions(value => ({ ...value, [id]: result.versions })); }); }
  function loadResearch() { return run('research', async () => setResearch(await request('research'))); }

  return <main className="appShell nhlApp">
    <header className="appHeader"><div><div className="eyebrow">NHL DATA & SHADOW RESEARCH</div><h1>NHL｜冰球資料與研究</h1><p>官方賽程、球員與門將資訊。每筆資料保留來源、時間與身分核對結果。</p></div><div className="headerBadges"><span className="state shadow">獨立 NHL 模組</span><span className="version">v{APP_VERSION}</span></div></header>
    <nav className="leagueTabs" aria-label="聯盟切換">{LEAGUE_IDS.map(id => <a className="sportModuleLink" key={id} href={`/?league=${id}`}><b>{id}</b><small>{leagueConfig(id).shortLabel}</small></a>)}<NbaEntry/><a className="sportModuleLink active" href="/nhl" aria-current="page"><b>NHL</b><small>冰球</small></a></nav>
    <nav className="mainTabs" aria-label="NHL 功能" role="tablist">{TABS.map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} aria-controls={`nhl-${id}`} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>)}</nav>
    {error && <div className="errorBox global" role="alert"><strong>更新未完成</strong><span>{error}</span><button onClick={() => setError('')}>關閉</button></div>}
    {Object.values(busy).some(Boolean) && <div className="nhlProgress" role="status">正在載入 NHL 資料；可切換頁籤，已完成結果會保留。</div>}
    <div role="tabpanel" id={`nhl-${tab}`}>
    {tab === 'team' && selectedTeam && <section className="panel">
      <h2>官方球隊賽季統計</h2><p>{selectedTeam.name || selectedTeam.abbrev}｜{selectedTeam.season}｜球隊 ID {selectedTeam.teamId}</p>
      <div className="nhlToolbar"><label>統計賽事類型<select value={summaryType} onChange={event => setSummaryType(Number(event.target.value))}><option value={1}>季前賽｜獨立 Shadow</option><option value={2}>例行賽</option><option value={3}>季後賽</option></select></label>
        <button className="secondary" disabled={busy[`team-summary:${summaryKey}`]} onClick={() => loadTeamSummary(selectedTeam, summaryType)}>{busy[`team-summary:${summaryKey}`] ? '讀取球隊統計中…' : '讀取官方球隊統計'}</button></div>
      <p className="nhlNote">依所選賽季與類型分開查詢，不與下方例行賽球員總表混用。這是本次取得的賽季累計，不是當時可得的賽前快照；不加入歷史賽前模型。切換頁籤保留本頁結果，重新進入網站可再次讀取。</p>
      {!teamSummary && <p className="nhlNote">尚未讀取這個賽季／類型的球隊統計。</p>}
      {teamSummary && <><p className="nhlNote">{phase(teamSummary.seasonPhase)}｜資料 QA {teamSummary.status}｜{teamSummary.cache?.hit ? '快取資料' : '本次取得'}</p>
        {teamSummary.status === 'EMPTY' ? <p className="nhlNote">官方未回傳此球隊、賽季與類型的統計；不是全零戰績。</p> : <div className="nhlTableWrap"><table className="nhlTable"><thead><tr><th>項目</th><th>官方數值</th></tr></thead><tbody>
          {[['gamesPlayed', '出賽'], ['wins', '勝'], ['losses', '敗'], ['otLosses', '延長／點球敗'], ['points', '積分'], ['goalsFor', '進球'], ['goalsAgainst', '失球'], ['goalsForPerGame', '場均進球'], ['goalsAgainstPerGame', '場均失球'], ['shotsForPerGame', '場均射正'], ['shotsAgainstPerGame', '場均被射正'], ['powerPlayPct', 'PP 成功率'], ['penaltyKillPct', 'PK 成功率'], ['faceoffWinPct', '爭球勝率']].map(([key, label]) => <tr key={key}><td>{label}</td><td>{key.endsWith('Pct') && typeof teamSummary.statistics?.[key] === 'number' ? `${(teamSummary.statistics[key] * 100).toFixed(2)}%` : number(teamSummary.statistics?.[key])}</td></tr>)}
        </tbody></table></div>}
        {teamSummary.issues?.length > 0 && <p className="nhlNote nhlWarning">{teamSummary.issues.join('；')}</p>}<Source source={teamSummary.source}/>
      </>}
    </section>}
    {tab === 'schedule' && <>
      <section className="panel"><div className="nhlToolbar"><label>台灣日期<input type="date" value={date} onChange={event => { if (event.target.value) { setDate(event.target.value); setSelectedGame(null); } }}/></label><button className="primary" disabled={busy[`schedule:${date}`]} onClick={() => loadSchedule()}>{busy[`schedule:${date}`] ? '取得官方賽程中…' : '載入 NHL 賽程'}</button><button className="secondary" onClick={() => { const today = taipeiDay(); setDate(today); setSelectedGame(null); }}>回到今天</button></div><p className="nhlNote">按鈕手動更新，不會自動重跑或清除已讀資料。北美晚間比賽通常列在台灣隔天。</p>{board && <><div className="nhlNote">{board.sampleOnly ? '歷史樣本，非完整當日賽程｜' : ''}台灣 {date}｜{board.games?.length || 0} 場｜{board.cache?.hit ? '快取資料' : '本次取得'}。下方保留的資料以來源時間為準。</div><Source source={board.source}/></>}</section>
      {!board && <Empty title="尚未載入這天的 NHL 賽程">選擇台灣日期，再按「載入 NHL 賽程」。</Empty>}
      {board && !board.games?.length && <Empty title="官方賽程此日沒有賽事">已依台灣日期篩選。可選其他日期或稍後手動更新。</Empty>}
      {(board?.games || []).map(row => <section className="gameCard" key={row.gameId}><div className="nhlGameHeader"><div><h2>{row.away?.name || row.away?.abbrev} 對 {row.home?.name || row.home?.abbrev}</h2><div className="nhlDates"><span>台灣 {clock(row.startTimeUTC)}</span><span>美東 {clock(row.startTimeUTC, 'America/New_York')}｜官方比賽日 {row.officialDate || '尚未提供'}</span><span>{row.venue || '球場待公布'}｜{phase(row.seasonPhase)}</span></div></div><div><span className="state">{state(row.gameState)}</span>{row.final && <div className="nhlGameScore">{number(row.final.awayGoals)} : {number(row.final.homeGoals)}</div>}</div></div><div className="nhlSource">Game ID {row.gameId}｜球隊 ID {row.awayTeamId}／{row.homeTeamId}｜身分 QA {row.identity?.status || '待核對'}</div><div className="nhlActions"><button className="secondary" disabled={busy[`game:${row.gameId}`]} onClick={() => loadGame(row.gameId)}>比賽詳情與節次</button><button className="secondary" onClick={() => loadTeam(row.away, row.season)}>{row.away?.abbrev} 球員</button><button className="secondary" onClick={() => loadTeam(row.home, row.season)}>{row.home?.abbrev} 球員</button><button className="secondary" onClick={() => { setTab('goalie'); loadGame(row.gameId); }}>門將與陣容</button></div>{selectedGame === row.gameId && <GameNotices detail={details[row.gameId]}/>}
      {selectedGame === row.gameId && <div className="nhlActions"><button className="secondary" disabled={busy[`context:${row.gameId}`]} onClick={() => loadContext(row.gameId)}>休息與賽程密度</button></div>}
      {selectedGame === row.gameId && contexts[row.gameId] && <ScheduleContext value={contexts[row.gameId]}/>}
      {selectedGame === row.gameId && game?.periods && <><div className="nhlTableWrap"><table className="nhlTable"><thead><tr><th>比分範圍</th><th>客隊</th><th>主隊</th></tr></thead><tbody>{game.periods.map((period, i) => <tr key={i}><td>第 {i + 1} 節</td><td>{period.awayGoals}</td><td>{period.homeGoals}</td></tr>)}<tr><td>60 分鐘</td><td>{game.regulation?.awayGoals}</td><td>{game.regulation?.homeGoals}</td></tr><tr><td>官方終場 {game.outcomeType}</td><td>{game.final?.awayGoals}</td><td>{game.final?.homeGoals}</td></tr></tbody></table></div><div className="nhlStats"><Stat label="客隊射正" value={game.teamStatistics?.away?.shotsOnGoal}/><Stat label="主隊射正" value={game.teamStatistics?.home?.shotsOnGoal}/></div><SituationStatistics value={game.observedSituationStatistics}/><Source source={game.source}/></>}{selectedGame === row.gameId && details[row.gameId] && !game?.periods && <p className="nhlNote">官方尚未提供可核對的完整逐節結果；不把缺值當成 0 分。</p>}</section>)}
    </>}
    {tab === 'team' && <section className="panel"><h2>球隊與球員</h2>{!selectedTeam ? <p className="nhlNote">先在賽程選擇一隊的「球員」按鈕。</p> : <><h3>{selectedTeam.name || selectedTeam.abbrev}｜球隊 ID {selectedTeam.teamId}</h3><button className="secondary" disabled={busy[`team:${rosterKey}`]} onClick={() => loadTeam(selectedTeam, selectedTeam.season)}>更新球隊資料</button>{roster && <><Source source={roster.roster?.source}/><div className="nhlTableWrap"><table className="nhlTable nhlRoster"><thead><tr><th>球員</th><th>位置</th><th>官方 ID</th><th>持桿</th></tr></thead><tbody>{roster.roster?.players?.map(row => <tr key={row.playerId}><td><button onClick={() => loadPlayer(row.playerId)}>{row.name || row.playerId}</button></td><td>{row.position || '—'}</td><td>{row.playerId}</td><td>{row.shootsCatches || '—'}</td></tr>)}</tbody></table></div>{roster.statistics?.ok ? <ClubStatistics value={roster.statistics}/> : <p className="nhlNote nhlWarning">名單已取得；球員統計來源本次未完成更新。</p>}</>}{player && <section className="panel"><h3>{player.player?.name}｜{player.player?.playerId}</h3><Source source={player.source}/><div className="nhlTableWrap"><table className="nhlTable"><thead><tr><th>賽季</th><th>聯盟／類型</th><th>出賽</th><th>進球</th><th>助攻</th><th>積分</th><th>撲救率</th></tr></thead><tbody>{(player.seasonTotals || []).filter(row => row.leagueAbbrev === 'NHL').map((row, i) => <tr key={`${row.season}-${i}`}><td>{row.season}</td><td>{row.leagueAbbrev}／{row.gameTypeId === 2 ? '例行賽' : row.gameTypeId === 3 ? '季後賽' : row.gameTypeId}</td><td>{number(row.gamesPlayed)}</td><td>{number(row.goals)}</td><td>{number(row.assists)}</td><td>{number(row.points)}</td><td>{number(row.savePctg)}</td></tr>)}</tbody></table></div></section>}</>}</section>}
    {tab === 'goalie' && <section className="panel"><h2>門將與陣容</h2>{!game ? <p className="nhlNote">先從賽程選擇一場比賽。</p> : <><h3>{game.away?.name} 對 {game.home?.name}</h3><GameNotices detail={details[game.gameId]}/><button className="secondary" disabled={busy[`game:${game.gameId}`]} onClick={() => loadGame(game.gameId)}>更新門將與比賽資料</button><div className="nhlStatusRows">{[['Projected goalie', game.goalie?.projected], ['Confirmed goalie', game.goalie?.confirmed], ['傷病／出賽狀態', game.injury?.players], ['Line combinations', game.lineup?.lines], ['Defensive pairings', game.lineup?.defensivePairings]].map(([label, value]) => <div className="nhlStatusRow" key={label}><strong>{label}</strong><span>{value ? JSON.stringify(value) : '尚未取得帶發布時間的可靠資料'}</span></div>)}</div><p className="nhlNote">官方賽後 Boxscore 的門將出賽記錄會獨立列出，不當成賽前已確認先發。缺少資料時保持未知，不補為零。</p>{game.playerStatistics && ['away', 'home'].map(side => <div key={side}><h3>{side === 'away' ? '客隊' : '主隊'}｜官方門將名單與出場時間</h3><div className="nhlTableWrap"><table className="nhlTable"><thead><tr><th>球員</th><th>Player ID</th><th>Save %</th><th>出場時間</th></tr></thead><tbody>{game.playerStatistics[side]?.goalies?.map(row => <tr key={row.playerId}><td>{row.name?.default || row.name || '—'}</td><td>{row.playerId}</td><td>{number(row.savePctg)}</td><td>{row.toi || '—'}</td></tr>)}</tbody></table></div></div>)}<div className="nhlStatusRows"><div className="nhlStatusRow"><strong>門將更新偵測</strong><span>{details[game.gameId]?.observation?.persisted ? '本次來源快照已永久保存；目前尚無可驗證的賽前門將變更。' : '來源版本可查看；沒有可信的新先發證據時不宣稱門將已變更。'}</span></div><div className="nhlStatusRow"><strong>5v5／xG／High-Danger</strong><span>{game.advanced?.status === 'SOURCE_NOT_CONNECTED' ? '尚未接通可用的進階資料；不以全場數據代替 5v5 或 xG。' : game.advanced?.status || '待來源確認'}</span></div></div><button className="secondary" disabled={busy[`versions:${game.gameId}`]} onClick={() => loadVersions(game.gameId)}>查看來源版本紀錄</button>{versions[game.gameId] && <div className="nhlSource">{versions[game.gameId].length ? versions[game.gameId].map(row => <p key={row.revision}>{clock(row.observedAt)}｜{row.revision}</p>) : '尚無已保存來源版本'}</div>}<Source source={game.source}/></>}</section>}
    {tab === 'research' && <section className="panel"><h2>歷史資料與 Shadow 驗證</h2><p className="nhlNote">逐場歷史比分、節次及數學檢查。季前賽獨立保存；模型研究不混入正式長期績效。</p><button className="primary" disabled={busy.research} onClick={loadResearch}>{busy.research ? '載入歷史驗證中…' : '載入歷史與驗證結果'}</button>{research && <><div className="nhlStats"><Stat label="真實歷史場次" value={research.games?.length}/><Stat label="完整逐節比分" value={research.completePeriodGames}/></div><p className="nhlNote">{research.message}</p><div className="nhlTableWrap"><table className="nhlTable"><thead><tr><th>台灣日期</th><th>賽事</th><th>結果</th><th>資料 QA</th><th>詳情</th></tr></thead><tbody>{research.games?.map(row => <tr key={row.gameId}><td>{row.taipeiDate}</td><td>{row.away?.abbrev} @ {row.home?.abbrev}</td><td>{row.final?.awayGoals} : {row.final?.homeGoals} {row.outcomeType}</td><td>{row.qa?.status || row.identity?.status}</td><td><button className="secondary" onClick={() => { setDate(row.taipeiDate); setBoards(value => ({ ...value, [row.taipeiDate]: value[row.taipeiDate]?.sampleOnly === false || (value[row.taipeiDate] && !value[row.taipeiDate].sampleOnly) ? value[row.taipeiDate] : { league: 'NHL', date: row.taipeiDate, sampleOnly: true, games: research.games.filter(item => item.taipeiDate === row.taipeiDate), source: row.source } })); setDetails(value => ({ ...value, [row.gameId]: value[row.gameId]?.game?.gameId === row.gameId ? value[row.gameId] : { league: 'NHL', game: row, acquisition: 'ARCHIVED_OFFICIAL_HISTORICAL_SAMPLE', warning: '官方歷史研究樣本；非本次即時更新資料。' } })); setSelectedGame(row.gameId); setTab('schedule'); }}>查看</button></td></tr>)}</tbody></table></div>{research.validation && <><div className="nhlStats"><Stat label="回溯 Walk-forward 場次" value={research.validation.retrospective.folds}/><Stat label="正規時間 Brier" value={research.validation.retrospective.regulationBrier}/><Stat label="比分平方誤差" value={research.validation.retrospective.regulationSquaredError}/><Stat label="嚴格賽前快照驗證場次" value={research.validation.strictPointInTime.folds}/></div><p className="nhlNote">使用 48 小時結果隔離。Brier 與比分誤差越低越好；這個小樣本僅供工程檢查，沒有通過正式預測效力或校準驗證。</p><details><summary>逐場訓練範圍與驗證證據</summary><pre>{JSON.stringify(research.validation, null, 2)}</pre></details></>}<p className="nhlNote nhlWarning">歷史結果資料不等於當時的傷病、門將或盤口快照；沒有時間證據的欄位不參與賽前回測。</p></>}</section>}
    {tab === 'sources' && <section className="panel"><h2>資料品質與 Reader</h2><p className="noticeBox">等待真實 Tai888 NHL 盤驗證</p><p className="nhlNote">NHL Reader 資料介面與市場身分欄位獨立保存。尚未核實的盤型、OT／Shootout 規則不會被當成已驗證市場。</p><button className="secondary" disabled={busy.status} onClick={() => run('status', async () => setStatus(await request('status')))}>更新資料狀態</button><div className="nhlStatusRows">{[['賽程／Game identity', 'NHL 官方 Schedule／Gamecenter'], ['球隊／球員身分', 'NHL 官方 Roster／Player'], ['日期', 'UTC、台灣與美東時間分開顯示'], ['比分', '三節、Regulation、OT、Shootout 分開核對'], ['球員傷病／陣容／先發門將', '須具備來源、發布時間與球員所屬隊伍證據'], ['5v5／xG／High-Danger', '可保留獨立欄位；來源未提供時明確缺資料'], ['Cache', 'NHL 獨立命名空間；失敗保留畫面上一次結果'], ['永久來源快照', status?.persistenceConfigured ? '已設定；逐次寫入另行確認' : '尚未設定'], ['投注與正式績效', '本輪新增資料與研究介面；NHL 實盤功能尚未啟用']].map(([label, detail]) => <div className="nhlStatusRow" key={label}><strong>{label}</strong><span>{detail}</span></div>)}</div>{status?.sources && <div className="nhlSource">{Object.entries(status.sources).filter(([, value]) => value.productionEnabled !== false).map(([key, value]) => <p key={key}><a href={value.url} target="_blank" rel="noreferrer">{key}｜{value.provider}</a></p>)}</div>}</section>}
    </div>
  </main>;
}
