'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { NBA_MODULE_VERSION } from '../../lib/nba/config.js';
import { NBA_TEAM_LABELS } from '../../lib/nba/labels.js';
import { nbaRequestKey, nbaScreenNeedsRefresh, readNbaScreen, requestNbaScreen } from '../../lib/nba/client-cache.js';
import styles from './nba.module.css';
import ShadowPanel from './shadow-panel.js';

const VIEWS = [['schedule', '賽程與賽果'], ['teams', '球隊與球員'], ['injuries', '傷病狀態'], ['history', '歷史研究'], ['sources', '資料與 QA']];
const typeLabel = value => ({ regular: '例行賽', preseason: '季前賽', postseason: '季後賽', unknown: '類型待確認' }[value] || value || '—');
const teamName = team => NBA_TEAM_LABELS[team?.abbreviation] || team?.name || team?.displayName || team?.shortName || team?.abbreviation || '待確認';
const number = value => value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toLocaleString('zh-TW', { maximumFractionDigits: 2 });
function taipeiDate(value = new Date()) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value); }
function time(value) {
  const stamp = Date.parse(value || '');
  return Number.isFinite(stamp) ? new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(stamp)) : '未提供';
}
function shortId(value) { return String(value || '').split(':').at(-1); }
function safeSource(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && /(^|\.)(nba\.com|espn\.com)$/.test(url.hostname) ? url.href : null; } catch { return null; }
}
function Empty({ children }) { return <div className={styles.empty}><span aria-hidden="true">◎</span><p>{children}</p></div>; }

function SourceStatus({ result, retained }) {
  if (!result) return null;
  const times = (result.sources || []).map(source => source.fetchedAt || source.retrievedAt).filter(value => Number.isFinite(Date.parse(value || ''))).sort();
  const label = { ready: '資料已取得', empty: '來源已回覆・沒有資料', partial: '部分資料可用', unavailable: '來源暫時無法取得' }[result.status] || '資料待確認';
  return <aside className={styles.sourceStatus} aria-label="資料狀態">
    <div><strong>{retained ? '顯示上次成功資料' : label}</strong><span>來源讀取時間 {time(times[0])}（台灣）</span></div>
    <span className={styles.badge}>QA {result.qa?.status || '待驗證'}</span>
    {result.sources?.some(source => source.stale || source.status === 'stale') && <p>目前使用較早的快取資料，來源時效尚未重新確認。</p>}
  </aside>;
}

function StatList({ rows, title }) {
  const stats = Array.isArray(rows) ? rows : [];
  return <section><h3>{title}</h3>{stats.length ? <dl className={styles.stats}>{stats.map((stat, index) => <div key={`${stat.name}-${index}`}><dt>{stat.label || stat.name}</dt><dd>{stat.displayValue ?? number(stat.value)}</dd></div>)}</dl> : <p className={styles.muted}>來源尚未提供這部分統計。</p>}</section>;
}

function GameCard({ game, onOpen }) {
  return <article className={styles.gameCard}>
    <div className={styles.cardMeta}><time dateTime={game.startTime}>{time(game.startTime)}</time><span>{typeLabel(game.seasonType)}</span><span>{game.statusText || game.status}</span></div>
    <div className={styles.matchup}><div><span>客隊</span><strong>{teamName(game.away)}</strong></div><b>{game.away?.score == null ? '—' : number(game.away.score)}<small>：</small>{game.home?.score == null ? '—' : number(game.home.score)}</b><div><span>主隊</span><strong>{teamName(game.home)}</strong></div></div>
    <div className={styles.cardFooter}><span>{typeof game.venue === 'string' ? game.venue : game.venue?.name || '場館待確認'}</span><button type="button" onClick={() => onOpen(game)}>比賽詳情</button></div>
  </article>;
}

function GameDetails({ data, onPlayer }) {
  const game = data.game;
  if (!game) return <Empty>這場比賽尚未取得完整資料。</Empty>;
  const players = data.players || [];
  return <div className={styles.sections}>
    <section className={styles.panel}><div className={styles.sectionHead}><h2>{teamName(game.away)} 對 {teamName(game.home)}</h2><span className={styles.badge}>{typeLabel(game.seasonType)}</span></div>
      <p>{time(game.startTime)}（台灣）・{game.statusText || game.status}</p>
      <div className={styles.resultScore}>{number(game.away?.score)} <span>：</span> {number(game.home?.score)}</div>
      <details><summary>比賽身分與來源</summary><p className={styles.mono}>{game.id}</p><p>ESPN 場次識別已核對；NBA 官方識別尚未交叉確認。</p></details>
      <div className={styles.twoColumns}>{[game.away, game.home].map(team => <section key={team.id}><h3>{teamName(team)}・各節</h3><div className={styles.periods}>{team.periodScores?.length ? team.periodScores.map((period, index) => <div key={index}><span>{(period.period || index + 1) <= 4 ? `Q${period.period || index + 1}` : `OT${(period.period || index + 1) - 4}`}</span><strong>{number(typeof period === 'object' ? period.value ?? period.score : period)}</strong></div>) : <p>各節比分尚未提供。</p>}</div><StatList rows={team.statistics} title="球隊單場統計"/></section>)}</div>
    </section>
    <section className={styles.panel}><h2>籃球進階指標・估算</h2><p className={styles.muted}>由雙方 box score 推導，與 NBA 官方逐回合指標不同。包含延長賽的實際時間核對；缺欄位不補零。</p><dl className={styles.metrics}><div><dt>共同估算回合數</dt><dd>{number(data.basketball?.possessions)}</dd></div><div><dt>Pace／48 分鐘</dt><dd>{number(data.basketball?.pace)}</dd></div><div><dt>主隊進攻效率</dt><dd>{number(data.basketball?.home?.offensiveRating)}</dd></div><div><dt>客隊進攻效率</dt><dd>{number(data.basketball?.away?.offensiveRating)}</dd></div></dl><div className={styles.twoColumns}>{['away', 'home'].map(side => <section key={side}><h3>{teamName(game[side])}</h3><p>防守效率 {number(data.basketball?.[side]?.defensiveRating)}・Net Rating {number(data.basketball?.[side]?.netRating)}</p><p>eFG% {number(data.basketball?.[side]?.effectiveFieldGoalPct)}・進攻籃板率 {number(data.basketball?.[side]?.offensiveReboundPct)}%</p></section>)}</div><details><summary>計算方法與原始輸入</summary><p>雙方各自 FGA + 0.44 × FTA − 進攻籃板 + 球隊總失誤，再取平均作共同回合數。Pace 依完整分節換算每 48 分鐘；效率為每 100 個估算回合得分。</p><p>Usage 依球員出手、罰球、失誤與時間估算；來源分鐘可能已四捨五入，並非官方 Usage。</p>{data.basketball?.qa?.issues?.map(row => <p key={row.code}>{row.message}</p>)}</details></section>
    <section className={styles.panel}><h2>先發與球員單場統計</h2><p className={styles.muted}>{game.completed ? '以下為賽後記錄的實際先發，不能當作賽前已公布的資訊。' : '有來源確認才顯示先發；未公布不以預測名單代替。'}</p>
      {players.length ? <div className={styles.playerGrid}>{players.map(player => <article className={styles.player} key={player.id}><div><strong>{player.name || player.displayName}</strong><span>{teamName(player.teamId === game.home.id ? game.home : game.away)}・{player.position || ''} {player.starterStatus === 'actual' ? '・實際先發' : player.starterStatus === 'reported' ? '・來源回報先發' : '・先發未確認'}</span></div><StatList rows={player.statistics} title="單場表現"/><p>估算 Usage：{number(data.basketball?.players?.find(row => row.playerId === player.id)?.usageEstimate)}%</p><button type="button" onClick={() => onPlayer(player)}>球員球季統計</button></article>)}</div> : <Empty>尚未取得先發及球員統計。</Empty>}
    </section>
    <section className={styles.panel}><h3>傷病時間核對</h3><p>歷史比賽不套用目前傷病清單。缺少當時已發布的傷病或先發快照時，保留為「未驗證」。</p></section>
  </div>;
}

function TeamDetails({ data, onHistory, onPlayer }) {
  return <div className={styles.sections}><section className={styles.panel}><div className={styles.sectionHead}><h2>{teamName(data.team)}</h2><button type="button" onClick={onHistory}>查看歷史研究</button></div><StatList rows={data.statistics} title="所選球季統計"/><p className={styles.muted}>數值依來源回傳的球季核對；沒有的進階指標保留空值。</p></section>
    <section className={styles.panel}><h2>球員名單</h2><p className={styles.muted}>名單為本次取得的目前陣容，不代表歷史球季當時的完整名單。</p>{data.players?.length ? <div className={styles.playerGrid}>{data.players.map(player => <article className={styles.player} key={player.id}><strong>{player.name || player.displayName}</strong><p>{player.jersey ? `#${player.jersey} ` : ''}{player.position || '位置待確認'}</p><p><small className={styles.mono}>{player.id}</small></p><button type="button" onClick={() => onPlayer(player)}>球員球季統計</button></article>)}</div> : <Empty>球員名單尚未取得。</Empty>}</section>
  </div>;
}

function PlayerDetails({ data }) {
  return <div className={styles.sections}><section className={styles.panel}><h2>{data.player?.name || '球員資料'}</h2><p className={styles.mono}>{data.player?.id}</p><p className={styles.muted}>目前球員身分與所選歷史球季分別核對。轉隊球季依來源列出各隊與合計列，合計不重複相加。</p></section>
    {data.playerSeasons?.length ? data.playerSeasons.map((row, index) => <section className={styles.panel} key={index}><h2>{row.season?.label}・{typeLabel(row.season?.type)}</h2><p>{row.aggregateAcrossTeams ? '多隊合計' : row.team ? teamName(row.team) : row.teamLabel || '球隊待確認'}</p><StatList rows={row.statistics} title={row.categoryLabel || row.category || '球員統計'}/></section>) : <Empty>來源未提供這個球季與賽事類型的球員統計。</Empty>}
  </div>;
}

function Research({ result, seasonType, onOpen }) {
  const report = result.research;
  const games = (result.data.games || []).filter(game => game.seasonType === seasonType);
  return <div className={styles.sections}>
    <ShadowPanel games={games} teamId={result.data.team?.id} seasonType={seasonType}/>
    <section className={styles.panel}><div className={styles.sectionHead}><h2>歷史統計基準</h2><span className={styles.badge}>Shadow・{typeLabel(seasonType)}</span></div>
      <p>使用已結束比賽，依時間順序檢查歷史得分基準。每次驗證只使用更早台灣日期的比賽；季前、例行與季後賽分開。</p>
      {report ? <><dl className={styles.metrics}><div><dt>有效歷史場數</dt><dd>{number(report.counts?.included ?? report.summary?.games)}</dd></div><div><dt>驗證場數</dt><dd>{number(report.counts?.validationGames)}</dd></div><div><dt>每隊得分 MAE</dt><dd>{number(report.validation?.mae)}</dd></div><div><dt>每隊得分 RMSE</dt><dd>{number(report.validation?.rmse)}</dd></div></dl>
        <p className={styles.muted}>MAE／RMSE 越小代表這份樣本的得分誤差越小。此為歷史得分基準研究，尚不具完整賽前傷病與先發快照。</p>
        <details><summary>研究方法與驗證限制</summary><p>{report.method?.description || report.method}</p><p>研究狀態：{report.status}・QA {report.qa?.status}</p>{report.limitations?.map((text, index) => <p key={index}>{text}</p>)}{report.qa?.issues?.map((issue, index) => <p key={index}>{issue.message}</p>)}</details></> : <Empty>選擇球隊與球季後載入歷史資料。</Empty>}
    </section>
    <section><div className={styles.sectionHead}><h2>已完成比賽</h2><span>{games.length} 場</span></div>{games.length ? <div className={styles.gameGrid}>{games.map(game => <GameCard key={game.id} game={game} onOpen={onOpen}/>)}</div> : <Empty>來源尚未提供所選類型的已完成比賽。</Empty>}</section>
  </div>;
}

function Sources({ result }) {
  return <div className={styles.sections}><section className={styles.panel}><h2>資料來源與時效</h2><p>以下為最近一次已完成資料回應的來源與 QA。若該次更新失敗，原頁籤保留的成功資料仍使用原本取得時間。</p><p>取得時間代表網站何時讀到資料；來源發布時間若未提供，會明確顯示「未提供」。兩者不互相代替。</p><div className={styles.sourceCards}>
    {result?.sources?.map((source, index) => <article key={index}><strong>{source.provider || '資料來源'}</strong><p>取得：{time(source.fetchedAt || source.retrievedAt)}</p><p>來源發布：{time(source.publishedAt)}</p><p>狀態：{source.status || '已取得'}{source.stale ? '・較早快取' : ''}</p>{safeSource(source.url) && <a href={safeSource(source.url)} target="_blank" rel="noreferrer">開啟原始來源 ↗</a>}<details><summary>追溯識別</summary><p className={styles.mono}>{source.hash || source.contentHash || '未提供'}</p></details></article>)}
  </div>{!result?.sources?.length && <p>先讀取任一資料頁籤，即可查看該次來源與時間。</p>}</section>
    <section className={styles.panel}><h2>資料品質 QA</h2><p>賽事、球隊與球員使用各自來源的識別碼。NBA 官方 ID 未完成交叉核對時，不會冒用官方 ID。</p>{result?.qa?.issues?.length ? <ul className={styles.issues}>{result.qa.issues.map((issue, index) => <li key={index}><b>{issue.code}</b><span>{issue.message}</span></li>)}</ul> : <p>本次資料沒有額外 QA 訊息。</p>}</section>
    <section className={styles.panel}><h2>官方資料與待驗證項目</h2><div className={styles.sourceLinks}><a href="https://www.nba.com/schedule" target="_blank" rel="noreferrer">NBA 官方賽程 ↗</a><a href="https://www.nba.com/stats" target="_blank" rel="noreferrer">NBA 官方統計 ↗</a><a href="https://official.nba.com/" target="_blank" rel="noreferrer">NBA 官方傷病報告入口 ↗</a><a href="https://www.espn.com/nba/" target="_blank" rel="noreferrer">ESPN NBA ↗</a></div><p>目前使用 ESPN 作為替代資料來源。NBA 官方即時端點在開發連線驗證時回傳 403；此頁資料尚未完成官方交叉核對。</p><p>官方 Pace、Offensive／Defensive／Net Rating、Usage 與 On/Off 尚未完整取得；不以缺值、零值或棒球公式代替。2026–27 官方傷病發布與賽前先發快照仍待實際資料驗證。</p></section>
  </div>;
}

export default function NbaWorkspace({ onClose }) {
  const [view, setView] = useState('schedule');
  const [date, setDate] = useState('');
  const [season, setSeason] = useState('2026');
  const [teamId, setTeamId] = useState('');
  const [gameId, setGameId] = useState('');
  const [playerId, setPlayerId] = useState('');
  const [seasonType, setSeasonType] = useState('regular');
  const [teams, setTeams] = useState([]);
  const [screen, setScreen] = useState({ key: '', result: null, loading: false, error: '', retained: false });
  const [ready, setReady] = useState(false);
  const activeKey = useRef('');
  const mounted = useRef(true);
  const lastData = useRef(null);
  useEffect(() => {
    mounted.current = true;
    let preferences;
    try { preferences = JSON.parse(sessionStorage.getItem('sports-data:nba:v1:preferences') || 'null'); } catch { /* optional */ }
    setDate(preferences?.date && /^\d{4}-\d{2}-\d{2}$/.test(preferences.date) ? preferences.date : taipeiDate());
    setSeason(preferences?.season || String(new Date().getUTCFullYear()));
    setTeamId(preferences?.teamId || '');
    setReady(true);
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!ready) return;
    try { sessionStorage.setItem('sports-data:nba:v1:preferences', JSON.stringify({ date, season, teamId })); } catch { /* optional */ }
  }, [ready, date, season, teamId]);

  const params = useMemo(() => {
    if (view === 'sources') return null;
    if (view === 'schedule') return { view, date };
    if (view === 'game') return { view, id: gameId };
    if (view === 'player') return { view, id: playerId, season, seasonType };
    if (view === 'team' || view === 'history') return teamId ? { view, id: teamId, season, ...(view === 'history' ? { seasonType } : {}) } : { view: 'teams' };
    return { view };
  }, [view, date, gameId, playerId, teamId, season, seasonType]);
  const key = params ? nbaRequestKey(params) : '';

  async function load(requestKey, force = false) {
    const cached = readNbaScreen(requestKey);
    if (!force && cached) {
      if (mounted.current && activeKey.current === requestKey) setScreen({ key: requestKey, result: cached, loading: false, error: '', retained: true });
      if (cached.data?.teams?.length) setTeams(cached.data.teams);
      lastData.current = cached;
      if (!nbaScreenNeedsRefresh(requestKey, cached)) return;
    }
    setScreen(previous => ({ key: requestKey, result: previous.key === requestKey ? previous.result : cached, loading: true, error: '', retained: false }));
    try {
      const result = await requestNbaScreen(requestKey);
      if (!mounted.current) return;
      if (result.data.teams?.length) setTeams(result.data.teams);
      if (activeKey.current !== requestKey) return;
      setScreen(previous => {
        if ((result.status === 'unavailable' || result.status === 'partial' || result.qa?.status === 'BLOCK') && previous.result) return { ...previous, loading: false, error: '部分來源未更新或未通過資料檢查，保留上次成功資料。', retained: true };
        return { key: requestKey, result, loading: false, error: '', retained: false };
      });
      lastData.current = result;
    } catch (error) {
      if (mounted.current && activeKey.current === requestKey) setScreen(previous => ({ ...previous, loading: false, error: error.message, retained: Boolean(previous.result) }));
    }
  }
  useEffect(() => {
    activeKey.current = key;
    if (ready && key) load(key);
    // A tab change does not discard an already running request. Its result is
    // cached under its own exact key and cannot overwrite the visible tab.
  }, [ready, key]); // eslint-disable-line react-hooks/exhaustive-deps

  function openGame(game) { setGameId(game.sourceId || shortId(game.id)); if (game.season?.year) setSeason(String(game.season.year)); if (['regular', 'preseason', 'postseason'].includes(game.seasonType)) setSeasonType(game.seasonType); setView('game'); }
  function openTeam(team) { setTeamId(team.sourceId || shortId(team.id)); setView('team'); }
  function openPlayer(player) { setPlayerId(player.sourceId || shortId(player.id)); setView('player'); }
  const visible = screen.key === key ? screen.result : null;
  const result = view === 'sources' ? lastData.current : visible;
  const data = result?.data;
  const loading = screen.key === key && screen.loading;
  const topView = view === 'game' ? 'schedule' : (view === 'team' || view === 'player') ? 'teams' : view;
  const years = Array.from({ length: 28 }, (_, index) => new Date().getUTCFullYear() + 1 - index);

  return <main className={styles.workspace} aria-label="NBA 資料工作區">
    <header className={styles.header}><div><p className={styles.eyebrow}>NBA・BASKETBALL DATA</p><h1>NBA 籃球資料</h1><p>賽程、球員狀態與歷史統計，同一個網站接著看。</p></div><div className={styles.headerActions}>{onClose ? <button type="button" onClick={onClose}>返回原本聯盟</button> : <a href="/">返回網站</a>}<span>{NBA_MODULE_VERSION}</span></div></header>
    <nav className={styles.tabs} aria-label="NBA 資料頁籤">{VIEWS.map(([id, label]) => <button type="button" key={id} aria-pressed={topView === id} className={topView === id ? styles.active : ''} onClick={() => setView(id)}>{label}</button>)}</nav>
    <div className={styles.toolbar}>
      {view === 'schedule' && <><label>台灣日期<input type="date" value={date} onChange={event => { if (event.target.value) setDate(event.target.value); }}/></label><button type="button" onClick={() => setDate(taipeiDate())}>今天</button></>}
      {(view === 'team' || view === 'history') && <><label>球隊<select value={teamId} onChange={event => setTeamId(event.target.value)}><option value="">選擇球隊</option>{teams.length ? teams.map(team => <option key={team.id} value={team.sourceId || shortId(team.id)}>{teamName(team)}</option>) : teamId && <option value={teamId}>已選球隊 {teamId}</option>}</select></label><label>球季<select value={season} onChange={event => setSeason(event.target.value)}>{years.map(year => <option key={year} value={year}>{year - 1}–{String(year).slice(-2)}</option>)}</select></label>{view === 'history' && <label>賽事類型<select value={seasonType} onChange={event => setSeasonType(event.target.value)}><option value="regular">例行賽</option><option value="preseason">季前賽（獨立）</option><option value="postseason">季後賽（獨立）</option></select></label>}</>}
      {view === 'game' && <button type="button" onClick={() => setView('schedule')}>← 返回賽程</button>}
      {view === 'player' && <><button type="button" onClick={() => setView('teams')}>← 返回球隊</button><label>球季<select value={season} onChange={event => setSeason(event.target.value)}>{years.map(year => <option key={year} value={year}>{year - 1}–{String(year).slice(-2)}</option>)}</select></label><label>賽事類型<select value={seasonType} onChange={event => setSeasonType(event.target.value)}><option value="regular">例行賽</option><option value="preseason">季前賽（獨立）</option><option value="postseason">季後賽（獨立）</option></select></label></>}
      {view !== 'sources' && <button type="button" className={styles.refresh} disabled={loading || !ready} onClick={() => load(key, true)}>{loading ? '讀取中…' : '重新讀取'}</button>}
    </div>
    {loading && <p className={styles.loading} role="status">正在讀取 NBA 資料…可切換頁籤，已取得的內容會保留。</p>}
    {screen.key === key && screen.error && <div className={styles.error} role="alert">{screen.error}{screen.error.includes('登入') && <a href="/login?next=/nba">重新登入</a>}</div>}
    <SourceStatus result={result} retained={view !== 'sources' && screen.retained}/>
    {result?.qa?.status === 'BLOCK' && <div className={styles.error} role="alert">NBA 資料未通過身分或完整性檢查，請查看「資料與 QA」。</div>}
    {view === 'sources' ? <Sources result={result}/> : data && result.qa?.status !== 'BLOCK' ? <>
      {view === 'schedule' && <section><div className={styles.sectionHead}><h2>{date}・賽程與賽果</h2><span>{data.games?.length || 0} 場</span></div>{data.games?.length ? <div className={styles.gameGrid}>{data.games.map(game => <GameCard game={game} key={game.id} onOpen={openGame}/>)}</div> : <Empty>{result.status === 'unavailable' ? '目前無法確認賽程，請稍後重新讀取。' : '來源目前沒有這個台灣日期的 NBA 賽事。可選歷史日期查看賽果，或到「歷史研究」選擇球隊。'}</Empty>}</section>}
      {(view === 'teams' || (view === 'history' && !teamId)) && <section><h2>{view === 'history' ? '選擇研究球隊' : 'NBA 球隊'}</h2>{data.teams?.length ? <div className={styles.teamGrid}>{data.teams.map(team => <button type="button" className={styles.teamCard} key={team.id} onClick={() => view === 'history' ? setTeamId(team.sourceId || shortId(team.id)) : openTeam(team)}><b>{team.abbreviation || 'NBA'}</b><strong>{teamName(team)}</strong><span>查看資料 →</span></button>)}</div> : <Empty>球隊資料暫時無法取得。</Empty>}</section>}
      {view === 'team' && <TeamDetails data={data} onHistory={() => setView('history')} onPlayer={openPlayer}/>}
      {view === 'game' && <GameDetails data={data} onPlayer={openPlayer}/>}
      {view === 'player' && <PlayerDetails data={data}/>}
      {view === 'history' && teamId && <Research result={result} seasonType={seasonType} onOpen={openGame}/>}
      {view === 'injuries' && <section className={styles.panel}><h2>目前傷病與出賽狀態</h2><p className={styles.muted}>以下為 ESPN 報導狀態，並非 NBA 官方當日傷病報告；過往發布的傷病不能直接視為今天的出賽確認。</p>{data.injuries?.length ? <div className={styles.playerGrid}>{data.injuries.map((injury, index) => <article className={styles.player} key={injury.id || `${injury.playerId}-${index}`}><strong>{injury.playerName || injury.name || injury.player?.name || '球員待核對'}</strong><p>{injury.teamName || teamName(injury.team)}・{injury.status || '狀態待確認'}</p><p>{injury.description || injury.shortComment || [injury.bodyPart, injury.detail, injury.side].filter(Boolean).join('・') || '來源未提供詳細原因'}</p><span>報導更新：{time(injury.reportedAt)}{injury.freshness === 'older_report' ? '・較早報導' : injury.freshness === 'future_timestamp' ? '・時間異常待核對' : ''}</span>{injury.expectedReturnDate && <p>來源預計回歸：{injury.expectedReturnDate}（尚未確認出賽）</p>}</article>)}</div> : <Empty>來源尚未提供可核對的傷病清單，不代表全員健康。</Empty>}</section>}
    </> : !loading && view !== 'sources' && <Empty>資料尚未載入，請按「重新讀取」。</Empty>}
    <footer className={styles.footer}>時間以 Asia/Taipei 顯示・資料只在進入頁籤或按重新讀取時更新。</footer>
  </main>;
}
