'use client';
import { createContext,useContext,useEffect,useRef,useState } from 'react';
import { SoccerMarketDirections, SoccerHalfTimeResearch } from './market-panel.js';
import { SoccerWorkloadPanel } from './workload-panel.js';
import SoccerWorkspace from './workspace.js';

const Context=createContext(null);
const clock=v=>v?new Date(v).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false}):'—';
const pct=v=>Number.isFinite(v)?`${(v*100).toFixed(1)}%`:'—';
const reasons={MATCH_ALREADY_STARTED:'比賽已開始',HALF_TIME_MODEL_UNVERIFIED:'上半場模型未驗證',SCORE_MODEL_UNAVAILABLE:'比分模型不適用',MATCHED_READER_QUOTE_MISSING:'缺少已配對原盤',READER_QUOTE_STALE:'原盤已逾期',SOCCER_PERIOD_SETTLEMENT_REBATE_UNVERIFIED:'期間、派彩及退水適用條件待核對',SOCCER_MODEL_NOT_PROMOTED:'研究模型尚未正式驗收'};
const names={HANDICAP_HOME:'主隊讓球',HANDICAP_AWAY:'客隊讓球',TOTAL_OVER:'大球',TOTAL_UNDER:'小球'};
const lineupChanges={LINEUP_PUBLISHED:'先前名單不完整，目前已取得先發 11 人',LINEUP_CHANGED:'先發人選有變動',UNCHANGED:'先發人選相同',LINEUP_COVERAGE_INCOMPLETE:'目前名單仍不完整，無法判定換人'};
const shareText=o=>o.winFraction===1?'全贏':o.lossFraction===1?'全輸':o.pushFraction===1?'走盤':`${o.winFraction?`贏 ${(o.winFraction*100).toFixed(0)}%`:`輸 ${(o.lossFraction*100).toFixed(0)}%`}／走 ${(o.pushFraction*100).toFixed(0)}%`;
const analysisLabels={NOT_STARTED:'待分析',PROCESSING:'處理中',COMPLETED:'完成',INSUFFICIENT_DATA:'資料不足',FAILED:'失敗',UNVERIFIED:'待重新核對'};
const qaLabels={PASS:'資料核對通過',WARN:'有待核對項目',BLOCKED:'資料檢核阻擋'};
const observationLabels={AVAILABLE:'資料已取得',PARTIAL:'資料部分取得',UNKNOWN:'資料待補'};
const usageLabels={USED_BASELINE:'已用於研究基準',OBSERVED_ONLY:'僅供觀測，未納入模型',NOT_AVAILABLE:'尚未納入模型'};
export function soccerAnalysisPresentation(state){
  let analysisStatus='NOT_STARTED';
  if(['queued','loading'].includes(state?.status))analysisStatus='PROCESSING';
  else if(state?.status==='error')analysisStatus=state.analysisStatus==='INSUFFICIENT_DATA'?'INSUFFICIENT_DATA':'FAILED';
  else if(state?.status==='done')analysisStatus=state.data?.analysisStatus==='INSUFFICIENT_DATA'?'INSUFFICIENT_DATA':state.data?.publishedCurrent===true&&state.data?.analysisStatus==='COMPLETED'?'COMPLETED':'UNVERIFIED';
  const current=state?.status==='done'&&state.data?.publishedCurrent===true&&analysisStatus==='COMPLETED';
  const selectionResult=current&&analysisStatus==='COMPLETED'&&state.data?.selectionResult==='RESEARCH_SHADOW'?'RESEARCH_SHADOW':null;
  return{analysisStatus,analysisLabel:analysisLabels[analysisStatus],selectionResult,selectionLabel:selectionResult?'研究中':'尚無結果',current};
}
export function soccerAnalysisCounts(games,states){
  const counts={total:games.length,candidates:0,waiting:0,processing:0,completed:0,insufficient:0,failed:0,research:0};
  for(const game of games){const view=soccerAnalysisPresentation(states[game.id]);if(view.analysisStatus==='PROCESSING')counts.processing++;else if(view.analysisStatus==='FAILED')counts.failed++;else if(view.analysisStatus==='INSUFFICIENT_DATA')counts.insufficient++;else if(view.analysisStatus==='COMPLETED')counts.completed++;else counts.waiting++;if(view.selectionResult==='RESEARCH_SHADOW')counts.research++;}
  return counts;
}
export function SoccerRequirementDetails({audit}){
  const layers=Array.isArray(audit?.layers)?audit.layers:[];
  return <details className="soccerDetails soccerRequirementDetails"><summary>六層分析依據與缺口</summary><p className="soccerAvailability">資料已取得不代表已納入模型；研究基準的計算也不代表正式驗收通過。</p>{layers.length?layers.map(layer=><section className="soccerRequirementLayer" key={layer.key}><h4>{layer.title}</h4><ul>{(layer.items||[]).map(item=><li key={item.key}><div className="soccerRequirementRow"><strong>{item.label}</strong><span className={`soccerEvidenceStatus ${item.status||'UNKNOWN'}`}>{observationLabels[item.status]||observationLabels.UNKNOWN}</span></div><p className="soccerRequirementUsage">{usageLabels[item.modelUsage]||usageLabels.NOT_AVAILABLE}</p>{item.reason&&<p className="soccerRequirementReason">{/^[A-Z][A-Z0-9_]+$/.test(item.reason)?'來源或適用範圍仍待核對。':item.reason}</p>}</li>)}</ul></section>):<p className="soccerAvailability">此歷史版本尚未保存六層核對結果，請重新核對取得目前資料。</p>}<p className="soccerAvailability"><a href="/soccer/specification">查看完整分析規格 2.2</a></p></details>;
}
export function SoccerRunHistory({runs=[]}){
  const messages={SOCCER_SOURCE_UNAVAILABLE:'資料來源暫時無法讀取',SOCCER_SOURCE_TIMEOUT:'資料來源讀取逾時',SOCCER_SCHEDULE_UNAVAILABLE:'賽程資料暫時無法核對',SOCCER_GAME_NOT_FOUND:'無法核對同場賽事',NOT_A_PREMATCH_SNAPSHOT:'並非賽前資料，不補算賽前機率'};
  return runs.length?<div className="soccerRunHistory"><h4>最近分析嘗試</h4>{runs.map(run=><div className="soccerSavedVersion" key={run.analysisRunId}><p>{clock(run.startedAt)}｜分析：{analysisLabels[run.analysisStatus]||'狀態待確認'}｜篩選：{run.analysisStatus==='COMPLETED'&&run.selectionResult==='RESEARCH_SHADOW'?'研究中':'尚無結果'}</p>{run.qaFlag&&<p className="soccerAvailability">{qaLabels[run.qaFlag]||'檢核狀態待確認'}</p>}{run.reasons?.length>0&&<p className="soccerAvailability">{[...new Set(run.reasons.map(code=>reasons[code]||messages[code]||(/[\u3400-\u9fff]/.test(code)?code:'來源或資料條件仍待核對')))].join('；')}</p>}</div>)}</div>:null;
}
export function SoccerAnalysisProvider({games,children,league=games[0]?.league,date=games[0]?.date}){
  const [states,setStates]=useState({}),[batch,setBatch]=useState(false);
  const queue=useRef([]),active=useRef(0),pending=useRef(new Map()),controllers=useRef(new Set()),alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;for(const c of controllers.current)c.abort();for(const q of queue.current.splice(0))q.resolve(null);};},[]);
  useEffect(()=>{
    if(!league||!date)return;let mounted=true;const controller=new AbortController();
    const dates=[date,...games.map(g=>g.date)].sort(),first=dates[0],last=dates.at(-1);
    async function restore(){try{
      const r=await fetch(`/api/soccer/analysis-board?${new URLSearchParams({league,date:first,through:last})}`,{cache:'no-store',signal:controller.signal}),d=await r.json();
      if(!mounted||!r.ok||!d.ok||d.league!==league||d.date!==first||d.through!==last||!Array.isArray(d.results))return;
      setStates(old=>{const next={...old};for(const result of d.results){const game=games.find(g=>g.id===result.gameId&&g.league===result.league&&g.date===result.date);if(!game||result.executable!==false||result.formalScoringEnabled!==false||!Array.isArray(result.directions)||result.directions.some(d=>d.eligible!==false||d.executable!==false))continue;
        const previous=old[game.id];if(['loading','queued','error'].includes(previous?.status)||previous?.data&&Date.parse(previous.data.observedAt)>Date.parse(result.observedAt))continue;
        next[game.id]={status:'done',data:result,error:''};}return next;});
    }catch{}}
    void restore();const timer=setInterval(restore,30000);return()=>{mounted=false;controller.abort();clearInterval(timer);};
  },[league,date,games]);
  const patch=(id,value)=>{if(alive.current)setStates(old=>({...old,[id]:{...old[id],...value}}));};
  function pump(){
    while(alive.current&&active.current<2&&queue.current.length){const task=queue.current.shift(),game=task.game;active.current++;const controller=new AbortController();controllers.current.add(controller);let timedOut=false;const timer=setTimeout(()=>{timedOut=true;controller.abort();},50000);patch(game.id,{status:'loading',error:''});
      fetch('/api/soccer/analysis',{method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',signal:controller.signal,body:JSON.stringify({league:game.league,date:game.date,eventId:game.sourceId})}).then(async r=>{
        const d=await r.json();if(!r.ok||!d.ok)throw Object.assign(Error(r.status===401?'登入已過期':d.error||'核對失敗'),{analysisStatus:d.analysisStatus,qaFlag:d.qaFlag,analysisRunId:d.analysisRunId});
        if(d.gameId!==game.id||d.league!==game.league||d.date!==game.date||d.executable!==false||d.formalScoringEnabled!==false||!Array.isArray(d.directions)||d.directions.length!==8||d.directions.some(x=>x.executable!==false||x.eligible!==false))throw Error('分析身分核對未通過');
        if(d.analysisStatus!=null&&!['COMPLETED','INSUFFICIENT_DATA'].includes(d.analysisStatus)||d.selectionResult!=null&&(d.analysisStatus!=='COMPLETED'||d.selectionResult!=='RESEARCH_SHADOW'))throw Error('分析狀態核對未通過');
        patch(game.id,{status:'done',data:d,error:''});task.resolve(d);
      }).catch(e=>{patch(game.id,{status:'error',analysisStatus:e.analysisStatus==='INSUFFICIENT_DATA'?'INSUFFICIENT_DATA':'FAILED',qaFlag:e.qaFlag||'BLOCKED',analysisRunId:e.analysisRunId||null,error:timedOut?'核對逾時，請重試':e.name==='AbortError'?'核對已停止':e.message});task.resolve(null);}).finally(()=>{clearTimeout(timer);controllers.current.delete(controller);pending.current.delete(game.id);active.current--;pump();});
    }
  }
  function run(game){if(pending.current.has(game.id))return pending.current.get(game.id);patch(game.id,{status:'queued',error:''});const promise=new Promise(resolve=>queue.current.push({game,resolve}));pending.current.set(game.id,promise);pump();return promise;}
  async function runAll(){if(batch)return;setBatch(true);try{await Promise.all(games.filter(g=>g.status==='scheduled'&&Date.parse(g.startTime)>Date.now()).map(run));}finally{if(alive.current)setBatch(false);}}
  const available=games.some(g=>g.status==='scheduled'&&Date.parse(g.startTime)>Date.now()),counts=soccerAnalysisCounts(games,states);
  return <Context.Provider value={{states,run}}><div className="soccerAnalysisToolbar"><button type="button" className="secondary" disabled={batch||!available} onClick={runAll}>{batch?'正在核對賽前資料…':'一鍵核對賽前資料'}</button><span>研究模式・正式評分尚未啟用</span><a href="/soccer/specification">分析規格 2.2</a></div><div className="soccerAnalysisSummary" role="status" aria-live="polite"><strong>目前候選 {counts.candidates} 場</strong><span>本頁範圍 {counts.total} 場</span><span>待分析／重核 {counts.waiting}</span><span>處理中 {counts.processing}</span><span>完成 {counts.completed}</span><span>資料不足 {counts.insufficient}</span><span>失敗 {counts.failed}</span><span>研究中 {counts.research}</span></div><SoccerWorkspace games={games} states={states} run={run} league={league} date={date}>{children}</SoccerWorkspace></Context.Provider>;
}
export default function SoccerAnalysisPanel({game}){
  const [history,setHistory]=useState({versions:[],runs:[],loading:false,error:'',loaded:false});
  const context=useContext(Context);if(!context)return null;
  const state=context.states[game.id],data=state?.data,e=data?.evidence,prediction=data?.prediction,busy=['queued','loading'].includes(state?.status);
  const presentation=soccerAnalysisPresentation(state),currentAttempt=state?.status==='done'&&(presentation.current||presentation.analysisStatus==='INSUFFICIENT_DATA'),historical=Boolean(data&&!currentAttempt),qaFlag=state?.status==='error'?state.qaFlag:currentAttempt?data?.qaFlag:null;
  const prestart=game.status==='scheduled'&&Date.parse(game.startTime)>Date.now(),stale=data&&Date.now()-Date.parse(data.observedAt)>180000;
  async function loadHistory(){setHistory(old=>({...old,loading:true,error:''}));try{const r=await fetch(`/api/soccer/analysis?${new URLSearchParams({league:game.league,date:game.date,eventId:game.sourceId})}`,{cache:'no-store',signal:AbortSignal.timeout(15000)}),d=await r.json(),runs=d.runs===undefined?[]:d.runs;if(!r.ok||!d.ok||d.gameId!==game.id||d.date!==game.date||d.league!==game.league||!Array.isArray(d.versions)||d.versions.some(v=>v.gameId!==game.id||v.date!==game.date||v.league!==game.league||v.executable!==false)||!Array.isArray(runs)||runs.some(run=>!run||typeof run.analysisRunId!=='string'||!Number.isFinite(Date.parse(run.startedAt))||!['PROCESSING','COMPLETED','FAILED','INSUFFICIENT_DATA'].includes(run.analysisStatus)||run.selectionResult!=null&&(run.analysisStatus!=='COMPLETED'||run.selectionResult!=='RESEARCH_SHADOW')||run.reasons!=null&&(!Array.isArray(run.reasons)||run.reasons.some(reason=>typeof reason!=='string'))))throw Error('版本讀取未通過核對');setHistory({versions:d.versions,runs,loading:false,error:'',loaded:true});}catch{setHistory(old=>({...old,loading:false,error:'已保存版本暫時無法讀取。'}));}}
  return <section className="soccerAnalysis" aria-label={`${game.home.name}對${game.away.name}資料核對`}><button type="button" className="secondary" disabled={busy} onClick={()=>context.run(game)}>{state?.status==='queued'?'等待核對…':busy?'核對中…':prestart?data?'重新核對賽前資料':'核對賽前資料':'檢視賽後資料'}</button>
    <div className="soccerAnalysisStatuses" data-analysis-status={presentation.analysisStatus}><span>分析：<strong>{presentation.analysisLabel}</strong></span><span>篩選：<strong>{presentation.selectionLabel}</strong></span>{qaFlag&&<span>{qaLabels[qaFlag]||'檢核狀態待確認'}</span>}</div>
    {state?.error&&<p className="soccerAnalysisWarning" role="alert">{state.error}{data?'；上次資料僅供歷史查閱，不代表本次完成。':''}</p>}
    {data&&<div className={`soccerAnalysisResult${historical?' soccerHistoricalResult':''}`}><p className="soccerAvailability">{historical?'上次資料・僅供歷史查閱':presentation.analysisStatus==='INSUFFICIENT_DATA'?'本次資料不足・尚無研究分布':data.status==='POSTSTART_AUDIT'?'賽後資料核對':'比分研究・不列入正式排名'}｜{clock(data.observedAt)}{stale?'｜資料待更新':''}{data.persisted?'｜版本已保存':'｜本次未保存'}</p>
      {data.analysisStatus==='COMPLETED'&&data.publishedCurrent===false&&<p className="soccerAnalysisWarning">此版本已失效或被較新資料取代，請重新核對。</p>}
      {!data.persisted&&<p className="soccerAnalysisWarning">{data.persistenceError}</p>}
      {prediction?<><h3>研究比分分布</h3><div className="soccerResearchOutcomes"><span>主勝 <strong>{pct(prediction.outcomes.home)}</strong></span><span>和局 <strong>{pct(prediction.outcomes.draw)}</strong></span><span>客勝 <strong>{pct(prediction.outcomes.away)}</strong></span></div><p className="soccerAvailability">模型平均進球：主 {prediction.homeRate.toFixed(2)}／客 {prediction.awayRate.toFixed(2)}。僅依歷史賽果，尚未加入陣容與 xG。</p></>:<p className="soccerAvailability">{prestart?'此場無適用的已訓練球隊資料。':'比賽開始後不補算賽前機率。'}</p>}
      <details className="soccerDetails"><summary>先發、裁判與待核對資料</summary><div className="soccerLineupGrid">{['home','away'].map(side=>{const t=e.teams[side],l=t.lineup;return <div key={side}><h4>{side==='home'?'主隊':'客隊'}先發</h4><p>{l.starters.length===11?(data.status==='POSTSTART_AUDIT'?'賽後名單':'資料源列出先發 11 人'):'先發尚未完整提供'}{l.formation?`｜${l.formation}`:''}</p>{l.starters.length>0&&<p>{l.starters.map(p=>p.name).join('、')}</p>}<p>替補名單 {l.bench.length} 人；預計分鐘尚未驗證。</p></div>;})}</div><p>裁判：{e.referee.officials?.map(o=>o.name).join('、')||'資料源尚未提供'}。名單公布時間尚無可核對資料。</p><ul>{data.missing.map(x=><li key={x.label}>{x.label}：尚未具備可驗證資料</li>)}</ul><p className="soccerAvailability">{e.source.provider} 取得時間：{clock(e.source.fetchedAt)}。已列出的先發仍需確認公布時點。</p></details>
      <SoccerHalfTimeResearch halfTimePrediction={data.halfTimePrediction} halfTimeResearch={data.halfTimeResearch}/>
      {data.providerPolicy?.rebateRateStatus==='USER_CONFIRMED'&&<p className="soccerAvailability">足球退水：{(data.providerPolicy.rebateRate*100).toFixed(0)}%（{data.providerPolicy.rebateRate}）；{data.providerPolicy.rebateBasis==='TOTAL_PRINCIPAL'&&data.providerPolicy.rebateBasisStatus==='USER_CONFIRMED'?'按投注金額計算；適用條件與結算條款待核對。':'計算基數與結算條款待核對。'}</p>}
      <SoccerWorkloadPanel workload={e.workload}/>
      <SoccerRequirementDetails audit={data.requirements}/>
      <SoccerMarketDirections directions={data.directions} unassignedQuotes={data.unassignedQuotes} game={game} result={data}/>
      <details className="soccerDetails"><summary>名單變動與上場核對</summary>
        {data.personnelComparison?.teams?.length>0?<><p>對照版本：{clock(data.personnelComparison.previousObservedAt)}。{data.personnelComparison.status==='PREMATCH_TO_ACTUAL_AUDIT'?'目前為賽後實際名單核對。':''}</p>{data.personnelComparison.teams.map(t=><div key={t.side}><strong>{t.side==='home'?'主隊':'客隊'}：{lineupChanges[t.status]}</strong>{t.added.length>0&&<p>新增先發：{t.added.map(p=>p.name).join('、')}</p>}{t.removed.length>0&&<p>不在目前先發：{t.removed.map(p=>p.name).join('、')}</p>}{t.formationBefore!==t.formationAfter&&<p>陣型：{t.formationBefore||'未提供'} → {t.formationAfter||'未提供'}</p>}</div>)}</>:<p>尚無可對照的先前完整資料；不把缺少名單當成預估錯誤。</p>}
        {e.minutesAudit?.status==='REGULATION_CLOCK_RECONSTRUCTED'?<><p>正規時鐘上場分鐘，不含補時；不等於實際經過時間，也不作為本場賽前輸入。</p>{['home','away'].map(side=><div key={side}><h4>{side==='home'?'主隊':'客隊'}上場紀錄</h4><div className="soccerTableWrap"><table className="soccerAuditTable"><thead><tr><th>球員</th><th>先發</th><th>時鐘分鐘</th></tr></thead><tbody>{e.minutesAudit.teams[side].players.filter(p=>p.appeared).map(p=><tr key={p.id}><td>{p.name}</td><td>{p.starter?'是':'否'}</td><td>{p.regulationClockMinutes.toFixed(1)}{p.addedTimeOnlyAppearance?'（補時登場）':''}</td></tr>)}</tbody></table></div></div>)}</>:<p>完整換人／上場分鐘尚未核對。賽前預估分鐘仍未啟用。</p>}
        <p className="soccerAvailability">名單變動不會直接加減比分機率；球員影響尚未通過模型驗證。</p>
      </details>
      <details className="soccerDetails"><summary>原盤結算核對表</summary><p>以下僅套用網站現有信用盤計算，供核對原盤文字。足球期間、派彩與退水適用條件尚未完成核對，不代表可下注。</p>{data.settlementReviews?.length?data.settlementReviews.map((m,i)=><div key={i}><h4>{m.kind==='TOTAL'?'大小':'讓球'} {m.rawLine}</h4><div className="soccerTableWrap"><table className="soccerAuditTable"><thead><tr><th>{m.kind==='TOTAL'?'總進球':'主隊淨勝球'}</th><th>{m.rows[0]?.outcomes[0].pick}</th><th>{m.rows[0]?.outcomes[1].pick}</th></tr></thead><tbody>{m.rows.map(r=><tr key={r.value}><td>{r.value}</td>{r.outcomes.map((o,j)=><td key={j}>{shareText(o)}</td>)}</tr>)}</tbody></table></div></div>):<p>尚無已配對原盤，無法產生核對表。</p>}</details>
      <details className="soccerDetails"><summary>歷史研究與限制</summary><p>回顧測試期：2025 年。可評估 {data.researchValidation.test.metrics.count}／{data.researchValidation.test.metrics.total} 場，覆蓋 {pct(data.researchValidation.test.metrics.coverage)}。</p><p>1X2 Log Loss {data.researchValidation.test.metrics.logLoss?.toFixed(3)??'—'}；Brier {data.researchValidation.test.metrics.brier?.toFixed(3)??'—'}（越低越好）。不代表投注勝率或獲利。</p><p>資料為事後補抓，未證明歷史賽前可取得性。歐冠尚未加入國內聯賽強度映射；半場研究不能替代人員影響、足球信用盤結算與正式收益驗收。</p></details>
      {data.researchValidation.rolling&&<details className="soccerDetails"><summary>逐年滾動研究檢查</summary><p>每期只用更早資料選參數。這是事後取得資料的診斷，不是新的未碰過測試或投注績效。</p><div className="soccerTableWrap"><table className="soccerAuditTable"><thead><tr><th>年份</th><th>覆蓋</th><th>低比分模型誤差</th><th>獨立模型誤差</th><th>差異區間</th></tr></thead><tbody>{data.researchValidation.rolling.folds.map(f=><tr key={f.testYear}><td>{f.testYear}</td><td>{f.metrics.count}／{f.metrics.total}</td><td>{f.metrics.logLoss?.toFixed(3)??'—'}</td><td>{f.referenceMetrics.logLoss?.toFixed(3)??'—'}</td><td>{f.comparison.interval?`${f.comparison.interval.lower.toFixed(4)} ～ ${f.comparison.interval.upper.toFixed(4)}`:'樣本不足'}</td></tr>)}</tbody></table></div><p>誤差採 1X2 Log Loss，越低越好。差異為「低比分模型減獨立模型」，區間以 UTC 週為單位重抽樣；不含選模或資料取得偏誤。各年度尚未呈現一致改善，維持研究模式。</p></details>}
    </div>}
    <details className="soccerDetails"><summary>已保存版本與嘗試</summary><button type="button" className="secondary" disabled={history.loading} onClick={loadHistory}>{history.loading?'讀取中…':'讀取最近紀錄'}</button>{history.error&&<p role="alert">{history.error}</p>}{history.loaded&&!history.versions.length&&<p>此場尚無已保存資料版本。</p>}<SoccerRunHistory runs={history.runs||[]}/>{history.versions.map(v=><div className="soccerSavedVersion" key={v.revision}><p>{clock(v.observedAt)}｜{v.analysisStatus==='INSUFFICIENT_DATA'?'資料不足':v.status==='POSTSTART_AUDIT'?'賽後核對':'賽前研究'}</p>{v.prediction&&<p>主 {pct(v.prediction.outcomes.home)}／和 {pct(v.prediction.outcomes.draw)}／客 {pct(v.prediction.outcomes.away)}</p>}<p className="soccerAvailability">當時原盤：{v.readerEvidence.observedAt?clock(v.readerEvidence.observedAt):'無已配對原盤'}；資料與盤口保留原版本。</p></div>)}</details>
  </section>;
}
