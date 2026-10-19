'use client';
import { useEffect,useState } from 'react';
import { buildSoccerRanking,SOCCER_RANK_MARKETS } from '../../lib/soccer/ranking.js';
import { soccerTeamLabel } from '../../lib/soccer/team-labels.js';
import { SoccerRecordProvider,SoccerRecordButton,SoccerBetRecords } from './bet-records.js';
import { soccerValidationArtifacts } from '../../lib/soccer/validation-frozen.js';
import { soccerHalfTimeArtifacts } from '../../lib/soccer/half-time-frozen.js';
import { SoccerCalibrationPanel } from './calibration-panel.js';
import { SoccerForwardValidationPanel } from './forward-validation-panel.js';
import { soccerHighScoreCandidates } from '../../lib/soccer/league-bet-status.js';
const num=v=>Number.isFinite(v)?v.toFixed(2):'—';
const time=v=>Number.isFinite(Date.parse(v))?new Date(v).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false}):'—';
export function SoccerValidationPanel({league}){
  const validation=soccerValidationArtifacts(),research=validation.leagues[league];
  const halfTime=soccerHalfTimeArtifacts()?.leagues?.[league]?.diagnostic;
  return <section className="panel"><h2>{league==='ucl'?'歐冠':'英超'}｜模型驗證</h2><p>逐年只使用更早的資料選參數；以下為事後取得資料的診斷，並非實際下注績效。</p><div className="soccerTableWrap"><table className="soccerAuditTable"><thead><tr><th>年份</th><th>覆蓋場數</th><th>低比分模型誤差</th><th>獨立模型誤差</th><th>差異區間</th></tr></thead><tbody>{(research?.folds||[]).map(f=><tr key={f.testYear}><td>{f.testYear}</td><td>{f.metrics.count}／{f.metrics.total}</td><td>{num(f.metrics.logLoss)}</td><td>{num(f.referenceMetrics.logLoss)}</td><td>{f.comparison.interval?`${f.comparison.interval.lower.toFixed(4)} ～ ${f.comparison.interval.upper.toFixed(4)}`:'樣本不足'}</td></tr>)}</tbody></table></div><p>誤差採 1X2 Log Loss，越低越好。各年度尚未呈現一致改善；全場與上半場、人員影響及足球結算仍需分別驗收。</p>
    <div className="soccerCalibrationGroup"><h3>全場｜逐年分事件校準</h3>{(research?.folds||[]).map(f=><SoccerCalibrationPanel key={f.testYear} league={league} period="FT" label={`${f.testYear} 年診斷`} audit={f.metrics?.probabilityAudit}/>)}</div>
    <div className="soccerCalibrationGroup"><h3>上半場｜分事件校準</h3><SoccerCalibrationPanel league={league} period="HT" label={halfTime?.period?`${halfTime.period} 年診斷`:'研究診斷'} audit={halfTime?.metrics?.probabilityAudit}/></div>
    <SoccerForwardValidationPanel league={league}/>
    <p>目前正式評分與候選資格維持待驗證。球員、原盤與分析版本的依據可在各場分析結果內查閱。</p><a href="/soccer/specification">完整分析規格 2.2</a></section>;
}
export function SoccerRanking({games,states,run,now,externalBusy=false}){
  const [view,setView]=useState('ranking'),[filter,setFilter]=useState('all');
  const ranking=buildSoccerRanking(games,states,{now,market:filter}),entries=view==='order'?ranking.order:ranking.entries;
  return <section className="panel soccerRanking" aria-label="足球分析排名"><div className="rankingViewTabs" aria-label="足球排名檢視"><button className={view==='ranking'?'active':''} aria-pressed={view==='ranking'} onClick={()=>setView('ranking')}>全部排名</button><button className={view==='order'?'active':''} aria-pressed={view==='order'} onClick={()=>setView('order')}>時間順序排名</button></div>
    <h2>{view==='order'?'時間順序排名':'全部排名'}</h2><div className="rankingViewTabs" aria-label="足球排名盤口篩選">{SOCCER_RANK_MARKETS.map(([key,label])=><button key={key} className={filter===key?'active':''} aria-pressed={filter===key} onClick={()=>setFilter(key)}>{label}</button>)}</div>
    <p>{ranking.currentGames} 場目前分析｜{entries.length} 個候選方向｜{view==='order'?'候選依開賽時間排列，同場按盤口分組':'候選依 S、W、R 由高到低'}</p>
    <p className="soccerAvailability">兩種排名皆僅顯示通過正式資格核對，且 S ≥ 7.2、W &gt; 0、R &gt; 0 的候選。足球正式收益與模型仍待驗收，研究原盤請至「分析結果」查閱。</p>
    {ranking.outdatedGames>0&&<p>{ranking.outdatedGames} 場資料已過期或已開賽，請重新核對。</p>}{ranking.pendingGames>0&&<p>{ranking.pendingGames} 場待分析或重新核對。</p>}
    {entries.map((e,i)=><article className="soccerRankRow" key={e.stableKey}><b>{i+1}</b><div className="soccerRankScore">{e.score==null?'—':e.score.toFixed(1)}<small>S 分數</small></div><div><h3>{soccerTeamLabel(e.game.home)}（主）對 {soccerTeamLabel(e.game.away)}（客）</h3><p>{e.market}｜{e.quote.label}｜水位 {e.quote.water}</p><p>W {num(e.W==null?null:e.W*100)}%｜R {num(e.R==null?null:e.R*100)}%{e.score==null?'｜研究中・正式評分待驗證':''}</p><time>{time(e.game.startTime)}（台灣）</time></div><div><SoccerRecordButton game={e.game} result={e.result} quote={e.quote}/><button className="mini secondary" disabled={externalBusy||['queued','loading'].includes(states[e.game.id]?.status)} onClick={()=>run(e.game)}>重新分析</button></div></article>)}
    {!entries.length&&<p className="emptySmall">目前沒有通過 S／W／R 及正式資格核對的候選。研究原盤仍可在「分析結果」查閱。</p>}
  </section>;
}
export default function SoccerWorkspace({games,states,run,league,date,children,analysisReady=true,onHighScoreStatusChange,externalBusy=false}){
  const [view,setView]=useState('board'),[now,setNow]=useState(Date.now());
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),10000);return()=>clearInterval(timer);},[]);
  const name=league==='ucl'?'歐冠':'英超';
  const dates=[date,...games.map(g=>g.date)].sort();
  const reminder=onHighScoreStatusChange?soccerHighScoreCandidates(games,states,{league,date,now,analysisReady}):null;
  return <SoccerRecordProvider league={league} date={dates[0]} through={dates.at(-1)} summaryDate={date} candidates={reminder?.candidates||[]} analysisReady={reminder?.analysisReady??analysisReady} onHighScoreStatusChange={onHighScoreStatusChange}><nav className="mainTabs soccerWorkspaceTabs" aria-label="足球主站功能">{[['board','今日盤口'],['results','分析結果'],['ranking','排名'],['records','下注紀錄'],['data','賽程與球員'],['validation','模型驗證']].map(([key,label])=><button key={key} className={view===key?'active':''} aria-pressed={view===key} onClick={()=>setView(key)}>{label}</button>)}</nav>
    {view==='ranking'&&<SoccerRanking games={games} states={states} run={run} now={now} externalBusy={externalBusy}/>}
    {view==='records'&&<SoccerBetRecords/>}
    {view==='results'&&<section className="panel"><h2>{name}｜分析結果</h2><p>已分析 {games.filter(g=>states[g.id]?.data).length}／{games.length} 場。展開各場查看八方向原盤、比分研究與核對紀錄。</p></section>}
    {view==='validation'&&<SoccerValidationPanel league={league}/>}
    <div hidden={['ranking','records','validation'].includes(view)} className={view==='results'?'soccerResultsView':''}>
      {children}
    </div>
  </SoccerRecordProvider>;
}
