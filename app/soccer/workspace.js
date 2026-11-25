'use client';
import { useEffect,useState } from 'react';
import { buildSoccerRanking,SOCCER_RANK_MARKETS } from '../../lib/soccer/ranking.js';
import { soccerTeamLabel } from '../../lib/soccer/team-labels.js';
import { SoccerRecordProvider,SoccerRecordButton,SoccerBetRecords } from './bet-records.js';
import { soccerValidationArtifacts } from '../../lib/soccer/validation-frozen.js';
import { soccerHalfTimeArtifacts } from '../../lib/soccer/half-time-frozen.js';
import { SoccerCalibrationPanel } from './calibration-panel.js';
import { SoccerForwardValidationPanel } from './forward-validation-panel.js';
import { SoccerModelFamilyPanel } from './model-family-panel.js';
import { soccerHighScoreCandidates } from '../../lib/soccer/league-bet-status.js';
const num=v=>Number.isFinite(v)?v.toFixed(2):'—';
const time=v=>Number.isFinite(Date.parse(v))?new Date(v).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false}):'—';
function rankingPickLabel(game,quote){
  if(quote.kind==='HANDICAP'&&['home','away'].includes(quote.side)){
    return `${soccerTeamLabel(game[quote.side])}（${quote.side==='home'?'主隊':'客隊'}）`;
  }
  if(quote.kind==='TOTAL'&&['over','under'].includes(quote.side)){
    return `${quote.side==='over'?'大球':'小球'}（兩隊總進球）`;
  }
  return '方向待確認';
}
export function SoccerValidationPanel({league}){
  const validation=soccerValidationArtifacts(),research=validation.leagues[league];
  const halfTime=soccerHalfTimeArtifacts()?.leagues?.[league]?.diagnostic;
  return <section className="panel"><h2>{league==='ucl'?'歐冠':'英超'}｜模型驗證</h2><p>逐年只使用更早的資料選參數；以下為事後取得資料的診斷，並非實際下注績效。</p><div className="soccerTableWrap"><table className="soccerAuditTable"><thead><tr><th>年份</th><th>覆蓋場數</th><th>低比分模型誤差</th><th>獨立模型誤差</th><th>差異區間</th></tr></thead><tbody>{(research?.folds||[]).map(f=><tr key={f.testYear}><td>{f.testYear}</td><td>{f.metrics.count}／{f.metrics.total}</td><td>{num(f.metrics.logLoss)}</td><td>{num(f.referenceMetrics.logLoss)}</td><td>{f.comparison.interval?`${f.comparison.interval.lower.toFixed(4)} ～ ${f.comparison.interval.upper.toFixed(4)}`:'樣本不足'}</td></tr>)}</tbody></table></div><p>誤差採 1X2 Log Loss，越低越好。各年度尚未呈現一致改善；全場與上半場、人員影響及足球結算仍需分別驗收。</p>
    <div className="soccerCalibrationGroup"><h3>全場｜逐年分事件校準</h3>{(research?.folds||[]).map(f=><SoccerCalibrationPanel key={f.testYear} league={league} period="FT" label={`${f.testYear} 年診斷`} audit={f.metrics?.probabilityAudit}/>)}</div>
    <div className="soccerCalibrationGroup"><h3>上半場｜分事件校準</h3><SoccerCalibrationPanel league={league} period="HT" label={halfTime?.period?`${halfTime.period} 年診斷`:'研究診斷'} audit={halfTime?.metrics?.probabilityAudit}/></div>
    <SoccerForwardValidationPanel league={league}/>
    <SoccerModelFamilyPanel league={league}/>
    <p>模型驗證持續收集。預測 S 使用現有資料與模型情境；正式模型驗收狀態另行保留。球員、原盤與分析版本的依據可在各場分析結果內查閱。</p><a href="/soccer/specification">完整分析規格 2.2</a></section>;
}
export function SoccerRanking({games,states,run,now,externalBusy=false,onShowResults,readProgress,onRetryReads}){
  const [view,setView]=useState('ranking'),[filter,setFilter]=useState('all');
  const ranking=buildSoccerRanking(games,states,{now,market:filter,includePrevious:true}),entries=view==='order'?ranking.order:ranking.entries;
  const previous=view==='order'?ranking.previousOrder:ranking.previousEntries;
  const incomplete=readProgress&&readProgress.loaded<readProgress.total;
  const loading=incomplete&&readProgress.loaded+readProgress.failed<readProgress.total;
  const groups=[];
  if(view==='order')for(const [index,entry] of entries.entries()){
    let group=groups.find(value=>value.game.id===entry.game.id);
    if(!group){group={game:entry.game,entries:[]};groups.push(group);}
    group.entries.push({entry,index});
  }
  const renderEntry=(e,i)=><article className="soccerRankRow" key={e.stableKey} data-soccer-rank-key={e.stableKey}>
    <b aria-label={`方向第 ${i+1} 名`}>{i+1}</b><div className="soccerRankScore">{e.score==null?'—':e.score.toFixed(1)}<small>{e.prediction?'預測 S':'S 分數'}</small></div>
    <div className="soccerRankBody"><h3>{soccerTeamLabel(e.game.home)}（主）對 {soccerTeamLabel(e.game.away)}（客）</h3><p className="soccerRankSelection">下注方向：{rankingPickLabel(e.game,e.quote)}</p><p className="soccerRankPick">{e.market}｜{e.quote.label}｜水位 {e.quote.water}</p><p>W {num(e.W==null?null:e.W*100)}%｜{e.prediction?'模型情境 R':'R'} {num(e.R==null?null:e.R*100)}%</p><time dateTime={e.game.startTime}>{time(e.game.startTime)}（台灣）</time>
      <details className="soccerDetails soccerRankDetails"><summary>評分明細</summary><p>{e.prediction?'依現有資料預測・完整模型誤差未驗證':'已通過目前盤口資格核對'}。</p><p>原盤時間：{time(e.quote.provenance?.observedAt)}（台灣）</p></details>
    </div><div className="soccerRankActions"><SoccerRecordButton game={e.game} result={e.result} quote={e.quote}/><button className="mini secondary" disabled={externalBusy||['queued','loading'].includes(states[e.game.id]?.status)} onClick={()=>run(e.game)}>重新分析</button></div>
  </article>;
  return <section className="panel soccerRanking" aria-label="足球分析排名"><div className="rankingViewTabs" aria-label="足球排名檢視"><button className={view==='ranking'?'active':''} aria-pressed={view==='ranking'} onClick={()=>setView('ranking')}>全部排名</button><button className={view==='order'?'active':''} aria-pressed={view==='order'} onClick={()=>setView('order')}>時間順序排名</button></div>
    <h2>{view==='order'?'時間順序排名':'全部排名'}</h2><div className="rankingViewTabs" aria-label="足球排名盤口篩選">{SOCCER_RANK_MARKETS.map(([key,label])=><button key={key} className={filter===key?'active':''} aria-pressed={filter===key} onClick={()=>setFilter(key)}>{label}</button>)}</div>
    {incomplete&&<div role="status"><p>{loading?'正在讀取已保存分析，':''}已載回 {readProgress.loaded}/{readProgress.total} 場{readProgress.failed>0&&`，${readProgress.failed} 場讀取失敗`}。</p>
      {readProgress.failed>0&&onRetryReads&&<button type="button" className="secondary" onClick={onRetryReads}>重試讀取</button>}</div>}
    {(!incomplete||entries.length>0||previous.length>0)&&<p>{ranking.currentGames} 場分析有效｜{incomplete?'已載回範圍':'目前'} {entries.length} 個候選方向{previous.length>0&&`｜上次達標 ${previous.length} 個方向`}</p>}
    {view==='order'?groups.map((group,index)=><section className="soccerOrderGame" key={group.game.id} aria-label={`第 ${index+1} 場`}><header className="soccerOrderGameHead"><div><span>第 {index+1} 場</span><strong>{soccerTeamLabel(group.game.home)}（主）對 {soccerTeamLabel(group.game.away)}（客）</strong></div><time dateTime={group.game.startTime}>{time(group.game.startTime)}（台灣）</time></header>{group.entries.map(({entry,index})=>renderEntry(entry,index))}</section>):entries.map(renderEntry)}
    {readProgress?.total===0&&<p>目前範圍沒有未開賽場次。</p>}
    {!incomplete&&readProgress?.total!==0&&!entries.length&&!previous.length&&<div className="emptySmall"><p>目前沒有通過 S／W／R 及目前盤口核對的候選。研究原盤仍可在「分析結果」查閱。</p>{onShowResults&&<button className="secondary" onClick={onShowResults}>查看全部分析分數</button>}</div>}
    {previous.length>0&&<section aria-label="上次分析｜盤口待更新">
      <h3>上次分析｜盤口待更新</h3>
      <p>以下保留上次達標時的盤口、水位及評分，僅供查閱。</p>
      {previous.map((entry,index)=><article key={entry.stableKey} className="soccerRankRow" data-soccer-history-key={entry.stableKey}>
        <b>{index+1}</b><div className="soccerRankScore">{entry.score.toFixed(1)}<small>當時預測 S</small></div>
        <div className="soccerRankBody"><h3>{soccerTeamLabel(entry.game.home)}（主）對 {soccerTeamLabel(entry.game.away)}（客）</h3>
          <p>{entry.market}｜{rankingPickLabel(entry.game,entry.quote)}｜{entry.quote.label||entry.quote.line}｜水位 {entry.quote.water}</p>
          <p>W {num(entry.W*100)}%｜模型情境 R {num(entry.R*100)}%</p>
          <p>原盤時間 <time dateTime={entry.observedAt}>{time(entry.observedAt)}</time>（台灣）</p>
          <p>開賽時間 <time dateTime={entry.game.startTime}>{time(entry.game.startTime)}</time>（台灣）</p>
        </div>
      </article>)}
    </section>}
    <p className="soccerAvailability">同場同期間同盤種只列 EV（W）最高的合格盤口。預測候選・S ≥ 7.2、W／R 為正。完整模型誤差未驗證。</p>
    {ranking.outdatedGames>0&&<p>{ranking.outdatedGames} 場賽前資料已過期或待核對，請重新核對。</p>}{!incomplete&&ranking.pendingGames>0&&<p>{ranking.pendingGames} 場待分析或重新核對。</p>}
    <details className="soccerDetails"><summary>排序與評分說明</summary><p>預測候選維持 S ≥ 7.2、W &gt; 0、模型情境 R &gt; 0，並通過場次、期間與盤口時效核對。依現有資料預測，缺項及未驗證狀態另行標示。</p><p>全部排名依 S、W、R 排序；時間順序排名依開賽時間分場，同場依全場讓球、全場大小、上半讓球、上半大小排列，每個市場先從合格盤口中選 W 最高的一筆，W 相同時依 R、固定盤口識別排序。其他原盤保留在分析結果。場次與方向序號分開顯示。</p></details>
  </section>;
}
export default function SoccerWorkspace({games,states,run,league,date,children,analysisReady=true,onHighScoreStatusChange,externalBusy=false,readProgress,onRetryReads}){
  const [view,setView]=useState('board'),[,setClockTick]=useState(0);
  // A newly received proof can be newer than the last timer tick. Validate it
  // against this render's real clock; the timer only refreshes idle screens.
  const now=Date.now();
  useEffect(()=>{const timer=setInterval(()=>setClockTick(value=>value+1),10000);return()=>clearInterval(timer);},[]);
  const name=league==='ucl'?'歐冠':'英超';
  const dates=[...new Set([date,...games.map(g=>g.date)])].sort();
  const reminder=onHighScoreStatusChange?soccerHighScoreCandidates(games,states,{league,date,through:dates.at(-1),now,analysisReady}):null;
  return <SoccerRecordProvider league={league} date={dates[0]} through={dates.at(-1)} dates={dates} summaryDate={date} candidates={reminder?.candidates||[]} analysisReady={reminder?.analysisReady??analysisReady} onHighScoreStatusChange={onHighScoreStatusChange}><nav className="mainTabs soccerWorkspaceTabs" aria-label="足球主站功能">{[['board','盤口'],['results','分析結果'],['ranking','排名'],['records','下注紀錄'],['data','賽程與球員'],['validation','模型驗證']].map(([key,label])=><button key={key} className={view===key?'active':''} aria-pressed={view===key} onClick={()=>setView(key)}>{label}</button>)}</nav>
    {view==='ranking'&&<SoccerRanking games={games} states={states} run={run} now={now} externalBusy={externalBusy} readProgress={readProgress} onRetryReads={onRetryReads} onShowResults={()=>setView('results')}/>}
    {view==='records'&&<SoccerBetRecords/>}
    {view==='results'&&<section className="panel"><h2>{name}｜分析結果</h2><p>已分析 {games.filter(g=>states[g.id]?.data).length}／{games.length} 場。展開各場查看八方向原盤、比分研究與核對紀錄。</p></section>}
    {view==='validation'&&<SoccerValidationPanel league={league}/>}
    <div hidden={['ranking','records','validation'].includes(view)} className={view==='results'?'soccerResultsView':''}>
      {children}
    </div>
  </SoccerRecordProvider>;
}
