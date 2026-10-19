'use client';
import { useEffect,useRef,useState } from 'react';
import { SoccerCalibrationPanel } from './calibration-panel.js';

const VERSION='SOCCER-PROSPECTIVE-SAVED-PREDICTION-v1';
const periods={REGULATION_FT:'全場',REGULATION_HT:'上半場'};
const variants={BASELINE:'基準模型',PERSONNEL_CHALLENGER:'人員研究挑戰模型'};
const validCount=value=>Number.isSafeInteger(value)&&value>=0;
const count=value=>validCount(value)?value.toLocaleString('zh-TW'):'未知';
const metric=(value,n)=>validCount(n)&&n>0&&Number.isFinite(value)&&value>=0?value.toFixed(4):'—';
const clock=value=>Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false}):'尚未取得';
const reasonNames={
  FORWARD_MATCH_NOT_STARTED:'尚未開賽',FORWARD_RESULT_NOT_CHECKED:'賽果尚未核對',FORWARD_RESULT_SOURCE_UNAVAILABLE:'賽果來源暫時無法讀取',
  FORWARD_RESULT_SOURCES_UNVERIFIED:'賽果來源證據不足',FORWARD_CONFLICTING_RESULT_EVIDENCE:'賽果證據互相矛盾',FORWARD_RESULT_PERSISTENCE_FAILED:'賽果核對尚未取得永久保存確認',
  FORWARD_DATABASE_RECEIPT_UNVERIFIED:'缺少可核對的資料庫封存憑據',FORWARD_PERSISTENCE_TIME_UNVERIFIED:'啟用、分析或封存時序不符',FORWARD_FIRST_CAPTURE_NOT_PREGAME:'首次封存未早於開賽',
  FORWARD_LATER_VALID_REANALYSIS_NOT_SELECTED:'同一場與模型的後續重分析未選用',FORWARD_DISTRIBUTION_UNVERIFIED:'比分分布尚未通過核對',FORWARD_MODEL_VERSION_UNVERIFIED:'模型版本證據不足',
  FORWARD_PERSONNEL_MODEL_UNVERIFIED:'人員模型版本證據不足',FORWARD_PERSONNEL_PREGAME_XI_UNVERIFIED:'兩隊賽前先發證據不足',FORWARD_OMITTED_MASS_EXCEEDS_TOLERANCE:'未展開尾端機率超出報表容許值',
  RESULT_NORMAL_FINAL_UNCONFIRMED:'尚未確認正常完賽',RESULT_PERIOD_SCORE_UNVERIFIED:'缺少可核對的期間比分',RESULT_ENDPOINTS_DISAGREE:'兩個賽果端點不一致',
  RESULT_SCOREBOARD_CROSSCHECK_UNAVAILABLE:'賽程端點無法交叉核對',RESULT_EXTRA_PERIODS_REQUIRE_REVIEW:'涉及加時或其他額外期間',
};
function ReasonList({reasons={},label}){
  const rows=Object.entries(reasons||{});
  return <details className="soccerDetails"><summary>{label}（{rows.length} 類）</summary>{rows.length?<ul>{rows.map(([code,n])=><li key={code}>{reasonNames[code]||'資料或範圍尚待核對'}：{count(n)} 筆 <small>{code}</small></li>)}</ul>:<p className="soccerAvailability">本次報表未列出此類原因。</p>}</details>;
}
function ForwardGroup({group,league}){
  const g=group,s=g.properScores||{},period=g.period==='REGULATION_HT'?'HT':'FT';
  const observations=Array.isArray(g.observations)?g.observations:[];
  const logLoss=validCount(s.count)&&s.count>0&&s.logLossState==='POSITIVE_INFINITY'?'+∞（實際結果曾被預估為零機率）':metric(s.logLoss,s.count);
  return <details className="soccerDetails soccerForwardGroup"><summary>{periods[g.period]||'期間待核對'}｜{variants[g.variant]||'模型待核對'}｜已封存 {count(g.capturedGames)}、已評估 {count(g.evaluatedGames)}、待賽果 {count(g.pendingGames)}</summary>
    <p>模型 {g.modelVersion||'版本尚未取得'}｜收到 {count(g.receivedSnapshotPeriods)} 筆快照期間；排除 {count(g.excludedSnapshotPeriods)} 筆；後續重分析未選用 {count(g.laterReanalysesNotSelected)} 筆。</p>
    <div className="soccerTableWrap"><table className="soccerAuditTable"><caption>{periods[g.period]||'期間待核對'}｜{variants[g.variant]||'模型待核對'}機率評分</caption><thead><tr><th scope="col">已評估樣本</th><th scope="col">Brier</th><th scope="col">1X2 Log Loss</th><th scope="col">比分 Log Loss</th></tr></thead><tbody><tr><td>{count(s.count)}</td><td>{metric(s.brier,s.count)}</td><td>{logLoss}</td><td>{metric(s.scoreLogLoss,s.exactScoreCount)}</td></tr></tbody></table></div>
    <p className="soccerAvailability">誤差越低越好。比分誤差可用 {count(s.exactScoreCount)} 筆、排除 {count(s.exactScoreExcluded)} 筆；沒有樣本時顯示「—」。不同期間、模型版本與人員模型分開計算。</p>
    <ReasonList reasons={g.pendingReasons} label="待核對原因"/><ReasonList reasons={g.excludedReasons} label="排除原因"/>
    <SoccerCalibrationPanel audit={g.probabilityAudit} league={league} period={period} label="開賽前封存樣本" evidenceMode="PROSPECTIVE"/>
    <details className="soccerDetails"><summary>版本與已評估紀錄（{count(observations.length)} 筆）</summary><p>模型識別：<code>{g.modelHash||'尚未取得'}</code></p>
      {observations.length?<ul>{observations.slice(0,25).map((o,i)=><li key={o.captureId||i}>{o.gameId||'場次待核對'}｜比分 {validCount(o.actualScore?.home)?o.actualScore.home:'—'}：{validCount(o.actualScore?.away)?o.actualScore.away:'—'}<br/>封存 {clock(o.capturedAt)}｜開賽 {clock(o.startTime)}<details><summary>核對依據</summary><p>分析版本：<code>{o.revision||'尚未取得'}</code></p><p>封存識別：<code>{o.captureId||'尚未取得'}</code></p><p>賽果識別：<code>{o.resultHash||'尚未取得'}</code></p></details></li>)}</ul>:<p>尚無已評估紀錄。</p>}
      {observations.length>25&&<p>此處先展開前 25 筆；上方指標依本次報表的全部可評估紀錄計算。</p>}
    </details>
  </details>;
}
function ForwardReport({report,league,summary}){
  const pending=validCount(report.selectedGameModelPeriods)&&validCount(report.evaluatedGameModelPeriods)&&report.selectedGameModelPeriods>=report.evaluatedGameModelPeriods?report.selectedGameModelPeriods-report.evaluatedGameModelPeriods:null;
  return <div className="soccerForwardReport">
    <p>前瞻方案啟用：{clock(report.protocol?.activatedAt)}。每場、每期間、每模型版本採資料庫最早有效封存憑據；方案須在分析前啟用，封存必須早於開賽。</p>
    <p>收到快照期間 {count(report.capturedSnapshotPeriods)} 筆｜有效封存 {count(report.selectedGameModelPeriods)} 筆｜已評估 {count(report.evaluatedGameModelPeriods)} 筆｜待賽果 {count(pending)} 筆｜不同賽事 {count(report.uniqueSelectedGames)} 場</p>
    <p className="soccerAvailability">同場的全場、上半場及人員模型分開列示，不能當成多場獨立比賽；分母是已選用的開賽前封存預測，不是所有賽程或下注。</p>
    {summary&&<p role="status">本次核對 {count(summary.checkedGameModelPeriods)} 筆｜完成評估 {count(summary.evaluated)} 筆｜待核對 {count(summary.pending)} 筆｜尚待處理 {count(summary.deferred)} 筆。</p>}
    {(report.truncated===true||report.complete===false)&&<p className="soccerAnalysisWarning" role="status">本次讀取有截斷，只能查看已載入範圍，不能當成完整驗收結果；請用上方日期範圍縮小查詢。</p>}
    <ReasonList reasons={report.excludedReasons} label={`整體排除原因（${count(report.excludedSnapshotPeriods)} 筆）`}/>
    {summary&&<ReasonList reasons={summary.reasons} label="本次核對待處理原因"/>}
    {report.groups.length?report.groups.map((group,i)=><ForwardGroup key={`${group.modelHash}:${group.period}:${group.variant}:${i}`} group={group} league={league}/>):<p className="soccerAvailability">尚無方案啟用後的合格封存樣本，請等待開賽前分析封存與賽後核對；不以既有 2025 年資料補成新的 OOS。</p>}
    <details className="soccerDetails"><summary>方案與資料範圍</summary><p>觀察規則：<code>{report.canonicalRule?.observation||'尚未取得'}</code></p><p>封存順序：<code>{report.canonicalRule?.order||'尚未取得'}</code></p><p>讀取時間：{clock(report.readAt)}</p><p>原始來源位元組未完整保留供獨立重算；已保存正規化來源識別與封存憑據。此報表不宣稱嚴格歷史 PIT 已驗證。</p></details>
  </div>;
}
function checkedReport(value,league){
  if(!value||value.version!==VERSION||!Array.isArray(value.groups)||value.formalEligible!==false||value.promotionEligible!==false||value.executable!==false
    ||value.groups.some(g=>g.league!==league||!Object.hasOwn(periods,g.period)||!Object.hasOwn(variants,g.variant)))throw Error('前瞻驗證回應的聯盟或範圍不符。');
  return value;
}
export function SoccerForwardValidationPanel({league}){
  const supported=['epl','ucl'].includes(league);
  const [state,setState]=useState({scopeKey:null,status:'loading',report:null,summary:null,error:''});
  const [range,setRange]=useState({from:'',through:''}),[draft,setDraft]=useState({from:'',through:''}),[filterError,setFilterError]=useState('');
  const scopeKey=`${league}|${range.from}|${range.through}`;
  const generation=useRef(0),flight=useRef(null),mounted=useRef(false),scope=useRef(scopeKey);scope.current=scopeKey;
  async function load(evaluate=false){
    if(!supported||!mounted.current||scope.current!==scopeKey)return;
    if(flight.current)return flight.current.promise;
    const token=++generation.current,controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),25000);
    setState(old=>({scopeKey,status:evaluate?'evaluating':'loading',report:old.scopeKey===scopeKey?old.report:null,summary:null,error:''}));
    const active={token,controller,timer,promise:null};flight.current=active;
    const promise=(async()=>{
      try{
        const query={league,...(range.from&&range.through?range:{})};
        const options={cache:'no-store',credentials:'same-origin',signal:controller.signal,...(evaluate?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'evaluate',...query,limit:25})}:{})};
        const response=await fetch(`/api/soccer/forward-validation${evaluate?'':`?${new URLSearchParams(query)}`}`,options),body=await response.json();
        if(!mounted.current||scope.current!==scopeKey||token!==generation.current)return;
        if(!response.ok||body.ok!==true)throw Error(response.status===401?'登入已過期，請重新登入網站。':body.error||'前瞻驗證暫時無法讀取。');
        const report=checkedReport(body.report,league);
        setState({scopeKey,status:'ready',report,summary:evaluate?body.summary||null:null,error:''});
      }catch(error){
        if(mounted.current&&scope.current===scopeKey&&token===generation.current)setState(old=>({...old,scopeKey,status:'failed',error:error.name==='AbortError'?'核對逾時，請重試；尚未確認的結果不列入評分。':error.message||'前瞻驗證暫時無法讀取。'}));
      }finally{clearTimeout(timer);if(flight.current?.token===token)flight.current=null;}
    })();
    active.promise=promise;return promise;
  }
  useEffect(()=>{
    mounted.current=true;if(supported)void load();
    return()=>{mounted.current=false;generation.current++;if(flight.current){clearTimeout(flight.current.timer);flight.current.controller.abort();flight.current=null;}};
  },[league,range.from,range.through]);
  function applyRange(event){
    event.preventDefault();if(flight.current)return;
    const valid=value=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
    if(!valid(draft.from)||!valid(draft.through)||draft.through<draft.from||Date.parse(draft.through)-Date.parse(draft.from)>366*86400000){setFilterError('請填寫有效的開始與結束日期，範圍最多 367 天。');return;}
    setFilterError('');if(draft.from===range.from&&draft.through===range.through)void load();else setRange({...draft});
  }
  function resetRange(){if(flight.current)return;setFilterError('');setDraft({from:'',through:''});if(!range.from&&!range.through)void load();else setRange({from:'',through:''});}
  const current=state.scopeKey===scopeKey,busy=!current||['loading','evaluating'].includes(state.status);
  return <section className="panel soccerForwardValidation" aria-label="足球前瞻驗證"><div className="panelHead"><h2>{league==='ucl'?'歐冠':'英超'}｜前瞻驗證</h2><button className="secondary" disabled={!supported||busy} onClick={()=>load()}>重新讀取</button><button className="secondary" disabled={!supported||busy} onClick={()=>load(true)}>{current&&state.status==='evaluating'?'核對中…':'核對已封存賽果'}</button></div>
    <p>預設查詢今天及前 30 天。只核對伺服器已封存的預測與賽果，不會新增下注。</p>
    <form className="soccerForwardFilters" onSubmit={applyRange}><label>開始日期 <input type="date" name="from" value={draft.from} onChange={event=>{const value=event.target.value;setDraft(old=>({...old,from:value}));}}/></label> <label>結束日期 <input type="date" name="through" value={draft.through} onChange={event=>{const value=event.target.value;setDraft(old=>({...old,through:value}));}}/></label> <button type="submit" className="secondary" disabled={!supported||busy}>讀取日期範圍</button> <button type="button" className="secondary" disabled={!supported||busy} onClick={resetRange}>恢復預設範圍</button></form>
    {filterError&&<p role="alert">{filterError}</p>}<p className="soccerAvailability">目前範圍：{range.from&&range.through?`${range.from} ～ ${range.through}`:'今天及前 30 天（依伺服器台灣日期）'}。</p>
    <p className="soccerAvailability">既有 2025 年回顧診斷不算新的未用 OOS。賽果採 ESPN 兩個端點交叉核對，並非獨立官方來源確認；模型放行維持關閉，不能據此宣稱勝率提高。</p>
    {!supported?<p role="alert">只提供英超與歐冠前瞻驗證。</p>:<>
      {busy&&<p role="status">{current&&state.status==='evaluating'?'正在核對封存預測的賽果…':'正在讀取前瞻封存資料…'}</p>}
      {current&&state.error&&<p className="soccerAnalysisWarning" role="alert">{state.error}</p>}
      {current&&state.report&&<>{state.status==='failed'&&<p className="soccerAvailability">以下為上次成功讀取的資料，本次更新尚未完成。</p>}<ForwardReport report={state.report} league={league} summary={state.summary}/></>}
    </>}
  </section>;
}
