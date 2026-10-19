'use client';
import { createContext,useContext,useEffect,useRef,useState } from 'react';
import { SoccerMarketDirections, SoccerHalfTimeResearch } from './market-panel.js';
import { SoccerWorkloadPanel } from './workload-panel.js';
import SoccerWorkspace from './workspace.js';
import { SOCCER_ALL_LEAGUE_STORAGE, validateSoccerAnalysisPayload, soccerSavedAnalysisState, findSoccerBackgroundJob, soccerBackgroundStates } from '../../lib/soccer/background-client.js';

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
// This checks a recent read-time receipt, not the historical publication flag.
// Conservatively add the entire client request age to the server clock. This
// includes transport/processing latency, so a delayed receipt cannot extend it.
export function soccerResearchIsCurrent(state,now=Date.now()){
  const data=state?.data,status=Object.hasOwn(state||{},'currentResearch')?state.currentResearch:data?.currentResearch;
  const receivedAt=state?.currentResearchReceivedAt,requestedAt=state?.currentResearchRequestedAt,checkedAt=Date.parse(status?.checkedAt||''),deadline=Date.parse(status?.validUntil||''),observedAt=Date.parse(data?.observedAt||'');
  const elapsed=now-requestedAt;
  return Boolean(state?.status==='done'&&data?.analysisStatus==='COMPLETED'&&status?.publishedCurrent===true&&status.reason==='ACTIVE'
    &&typeof data.revision==='string'&&status.revision===data.revision&&status.analysisRunId===data.analysisRunId
    &&status.formalScoringEnabled===false&&status.executable===false
    &&Number.isFinite(receivedAt)&&Number.isFinite(requestedAt)&&requestedAt<=receivedAt&&receivedAt<=now&&Number.isFinite(checkedAt)&&Number.isFinite(deadline)
    &&elapsed>=0&&elapsed<=45000&&checkedAt+elapsed<deadline
    &&Number.isFinite(observedAt)&&observedAt<=checkedAt+elapsed+5000&&checkedAt+elapsed-observedAt<180000);
}
export function soccerAnalysisPresentation(state,now=Date.now()){
  let analysisStatus='NOT_STARTED';
  if(['queued','loading'].includes(state?.status))analysisStatus='PROCESSING';
  else if(state?.status==='error')analysisStatus=state.analysisStatus==='INSUFFICIENT_DATA'?'INSUFFICIENT_DATA':'FAILED';
  else if(state?.status==='done')analysisStatus=state.data?.analysisStatus==='INSUFFICIENT_DATA'?'INSUFFICIENT_DATA':soccerResearchIsCurrent(state,now)?'COMPLETED':'UNVERIFIED';
  const current=analysisStatus==='COMPLETED';
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
export function SoccerPersonnelResearch({prediction,research,baseline,league,analysisCutoff}){
  const decimal=(value,digits=3)=>Number.isFinite(value)?value.toFixed(digits):'—';
  const count=value=>Number.isInteger(value)&&value>=0?value:null;
  const unavailableAtCutoff=research?.status==='NOT_AVAILABLE_AT_CUTOFF'||research?.reason==='PERSONNEL_ARTIFACT_NOT_AVAILABLE_AT_CUTOFF';
  const available=Boolean(research&&!unavailableAtCutoff&&/^[a-f0-9]{64}$/.test(research.artifactHash||'')
    &&research.defaultDistribution==='UNCHANGED_BASELINE'&&research.challengerDisplayOnly===true&&research.formalEnabled===false);
  const cutoff=Date.parse(analysisCutoff||''),observed=Date.parse(prediction?.personnelObservation?.fetchedAt||''),modelCutoff=Date.parse(prediction?.cutoff||''),trainedThrough=Date.parse(prediction?.trainedThrough||'');
  const valuesValid=value=>[value?.homeRate,value?.awayRate].every(rate=>Number.isFinite(rate)&&rate>0)
    &&['home','draw','away'].every(key=>Number.isFinite(value?.outcomes?.[key])&&value.outcomes[key]>=0&&value.outcomes[key]<=1);
  const current=Boolean(available&&research.status==='RESEARCH_CHALLENGER_AVAILABLE'&&prediction&&prediction.league===league
    &&prediction.period==='REGULATION_FT'&&prediction.mode==='CURRENT_PREMATCH'&&prediction.status==='RESEARCH_ONLY'
    &&prediction.formalEnabled===false&&prediction.executable===false&&prediction.personnelObservation?.availability==='OBSERVED_PREMATCH_XI'
    &&/^[a-f0-9]{64}$/.test(prediction.personnelObservation?.sourceHash||'')&&valuesValid(prediction)
    &&[cutoff,observed,modelCutoff,trainedThrough].every(Number.isFinite)&&observed<=cutoff&&modelCutoff<=cutoff&&trainedThrough<=cutoff);
  const messages={PERSONNEL_ARTIFACT_NOT_AVAILABLE_AT_CUTOFF:'此分析時間尚無可用的人員研究版本，不帶入較晚模型或研究數字。',
    PERSONNEL_XI_INCOMPLETE:'兩隊先發尚未完整核對，本場不計算人員研究進球率。',PERSONNEL_PREMATCH_LINEUP_UNVERIFIED:'兩隊賽前先發尚未完整核對，本場不計算人員研究進球率。',
    PERSONNEL_PLAYER_NOT_TRAINED:'目前先發含缺少訓練資料的球員，本場不猜測球員影響。',PERSONNEL_CLUB_NOT_TRAINED:'本場球隊不在可用的人員訓練範圍。',SOCCER_TEAM_NOT_TRAINED:'本場球隊不在可用的比分訓練範圍。',
    PERSONNEL_XI_SOURCE_UNVERIFIED:'先發來源尚未通過核對，暫不計算本場人員機率。',PERSONNEL_XI_IDENTITY_INVALID:'先發球員身分尚未通過核對，暫不計算本場人員機率。',
    PERSONNEL_PREMATCH_AVAILABILITY_UNVERIFIED:'尚無符合分析時間的有效賽前先發觀察，暫不計算本場人員機率。',NOT_A_PREMATCH_SNAPSHOT:'賽後資料不補算本場賽前人員機率。',
    SCORE_MODEL_UNAVAILABLE:'本場缺少適用的比分基準，無法計算人員研究。',PERSONNEL_MODEL_NOT_APPLICABLE:'本場尚無適用的人員研究版本。'};
  const message=unavailableAtCutoff?messages.PERSONNEL_ARTIFACT_NOT_AVAILABLE_AT_CUTOFF:!research?'此歷史版本尚未保存先發人員研究，請重新核對目前資料。'
    :messages[research.reason]||'本場的人員、模型範圍或分析時間尚未完整核對，暫不顯示人員研究機率。';
  const validation=available?research.validation:null,diagnostic=available?research.diagnostic:null,collection=available?research.collection:null;
  const common=count(validation?.commonCount),population=count(validation?.originalPopulation);
  const paired=common>0&&population>=common&&validation?.reference?.count===common&&validation?.challenger?.count===common;
  const diagnosticCount=count(diagnostic?.count),diagnosticSample=count(diagnostic?.sample);
  const diagnosticPaired=diagnosticCount>0&&diagnosticSample>=diagnosticCount&&diagnostic?.baseline?.count===diagnosticCount;
  const interval=diagnostic?.comparison?.interval;
  return <details className="soccerDetails soccerPersonnelResearch"><summary>先發人員模型研究</summary>
    <p className="soccerAvailability">估計先發組合與進球率的關聯；僅供研究比較，尚未估計傷停、預計分鐘、替補差距或因果影響。</p>
    {current?<div className="soccerTableWrap"><table className="soccerAuditTable"><caption>本場全場比分研究比較</caption><thead><tr><th>模型</th><th>主隊平均進球</th><th>客隊平均進球</th><th>主勝</th><th>和局</th><th>客勝</th></tr></thead><tbody>
      <tr><th scope="row">原比分基準（目前採用）</th><td>{decimal(baseline?.homeRate,2)}</td><td>{decimal(baseline?.awayRate,2)}</td><td>{pct(baseline?.outcomes?.home)}</td><td>{pct(baseline?.outcomes?.draw)}</td><td>{pct(baseline?.outcomes?.away)}</td></tr>
      <tr><th scope="row">先發人員研究</th><td>{decimal(prediction.homeRate,2)}</td><td>{decimal(prediction.awayRate,2)}</td><td>{pct(prediction.outcomes.home)}</td><td>{pct(prediction.outcomes.draw)}</td><td>{pct(prediction.outcomes.away)}</td></tr>
    </tbody></table></div>:<p className="soccerAvailability">{message}</p>}
    {collection&&count(collection.accepted)!==null&&count(collection.total)!==null&&collection.accepted<=collection.total&&<p>歷史先發可核對 {collection.accepted}／{collection.total} 場；資料為賽後補抓，不證明當時已取得賽前名單。</p>}
    {available&&<>
      <h4>2024 年共同樣本選模</h4>{paired?<><p>共同可比較 {common}／原始母體 {population} 場；兩模型只比較相同賽事。</p><div className="soccerTableWrap"><table className="soccerAuditTable"><thead><tr><th>模型</th><th>Log Loss</th><th>Brier</th></tr></thead><tbody><tr><th scope="row">原比分基準</th><td>{decimal(validation.reference.logLoss)}</td><td>{decimal(validation.reference.brier)}</td></tr><tr><th scope="row">先發人員研究</th><td>{decimal(validation.challenger.logLoss)}</td><td>{decimal(validation.challenger.brier)}</td></tr></tbody></table></div><p>{validation.preferredModel==='UNCHANGED_BASELINE'?'2024 年選模保留原比分基準。':validation.preferredModel==='XI_CHALLENGER'?'2024 年共同樣本偏向先發人員研究；網站預設仍保留原比分基準。':'選模結果尚待核對；網站預設維持原比分基準。'}</p></>:<p>2024 年尚無可核對的共同樣本比較。</p>}
      <h4>2025 年回顧診斷</h4><p className="soccerAvailability">2025 年資料已用於先前開發，這不是新的未用樣本外測試（OOS），也不代表投注勝率或收益。</p>
      {diagnosticPaired?<><p>共同可評估 {diagnosticCount}／原始母體 {diagnosticSample} 場。Log Loss：原基準 {decimal(diagnostic.baseline.logLoss)}／人員研究 {decimal(diagnostic.logLoss)}；Brier：原基準 {decimal(diagnostic.baseline.brier)}／人員研究 {decimal(diagnostic.brier)}。</p>{Number.isFinite(diagnostic.comparison?.meanDifference)&&<p>Log Loss 差異（人員研究減原基準）：{decimal(diagnostic.comparison.meanDifference,4)}{interval&&[interval.lower,interval.upper].every(Number.isFinite)&&interval.lower<=interval.upper?`；週區塊重抽樣範圍 ${decimal(interval.lower,4)} ～ ${decimal(interval.upper,4)}`:''}。此回顧比較不作正式升級依據。</p>}</>:<p>2025 年尚無可核對的共同樣本診斷。</p>}
    </>}
    <p className="soccerAvailability">目前預設比分分布維持原基準；人員研究未啟用正式 W／R／S、候選或下注。</p>
  </details>;
}
export function SoccerRunHistory({runs=[]}){
  const messages={SOCCER_SOURCE_UNAVAILABLE:'資料來源暫時無法讀取',SOCCER_SOURCE_TIMEOUT:'資料來源讀取逾時',SOCCER_SCHEDULE_UNAVAILABLE:'賽程資料暫時無法核對',SOCCER_GAME_NOT_FOUND:'無法核對同場賽事',NOT_A_PREMATCH_SNAPSHOT:'並非賽前資料，不補算賽前機率'};
  return runs.length?<div className="soccerRunHistory"><h4>最近分析嘗試</h4>{runs.map(run=><div className="soccerSavedVersion" key={run.analysisRunId}><p>{clock(run.startedAt)}｜分析：{analysisLabels[run.analysisStatus]||'狀態待確認'}｜篩選：{run.analysisStatus==='COMPLETED'&&run.selectionResult==='RESEARCH_SHADOW'?'研究中':'尚無結果'}</p>{run.qaFlag&&<p className="soccerAvailability">{qaLabels[run.qaFlag]||'檢核狀態待確認'}</p>}{run.reasons?.length>0&&<p className="soccerAvailability">{[...new Set(run.reasons.map(code=>reasons[code]||messages[code]||(/[\u3400-\u9fff]/.test(code)?code:'來源或資料條件仍待核對')))].join('；')}</p>}</div>)}</div>:null;
}
export function SoccerAnalysisProvider({games,children,league=games[0]?.league,date=games[0]?.date||'',runId='',onHighScoreStatusChange,onBusyChange,externalBusy=false}){
  const [states,setStates]=useState({}),[batch,setBatch]=useState(false),[,setClockTick]=useState(0);
  const queue=useRef([]),active=useRef(0),pending=useRef(new Map()),controllers=useRef(new Set()),alive=useRef(true);
  const epochs=useRef(new Map()),refreshSaved=useRef(null),gamesRef=useRef(games);gamesRef.current=games;
  const latestStates=useRef(states);latestStates.current=states;
  const externalBusyRef=useRef(externalBusy);externalBusyRef.current=externalBusy;
  // One scope epoch fences both a delayed POST and its later status GETs.
  const statusEpoch=useRef(new Map()),needsCurrentCheck=useRef(false);
  const scopeKey=game=>`${game.league}:${game.date}:${game.id}`;
  const epochFor=game=>statusEpoch.current.get(scopeKey(game))||0;
  const receiptSequences=useRef(new Map());
  const beginReceipt=game=>{const key=scopeKey(game),seq=(receiptSequences.current.get(key)||0)+1;receiptSequences.current.set(key,seq);return{key,seq};};
  const receiptCurrent=receipt=>receiptSequences.current.get(receipt.key)===receipt.seq;
  const displayedCurrent=useRef({});displayedCurrent.current=Object.fromEntries(Object.entries(states).map(([id,state])=>[id,soccerResearchIsCurrent(state)]));
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;for(const c of controllers.current)c.abort();for(const q of queue.current.splice(0))q.resolve(null);};},[]);
  const patch=(id,value,guard=null)=>{if(alive.current)setStates(old=>guard&&!guard(old[id])?old:({...old,[id]:{...old[id],...(typeof value==='function'?value(old[id]):value)}}));};
  const recoveryScope=games.map(game=>`${game.id}:${game.date}`).join('|');
  useEffect(()=>{
    if(!games.length)return undefined;
    let stopped=false,historyTimer,pollTimer,reading=false,polling=false,job=null,jobKey='';
    const reads=new Set(),queuedHistory=new Set(),settled=new Map();let jobEpochs=new Map();
    const current=()=>!stopped&&alive.current;
    const recoverPatch=(id,value,epoch,source='saved',receipt=null)=>{if(current()&&!pending.current.has(id)&&(epochs.current.get(id)||0)===epoch)setStates(old=>{
      const previous=old[id];
      if(!current()||pending.current.has(id)||(epochs.current.get(id)||0)!==epoch)return old;
      if(source==='saved'&&previous?.data&&value.data&&Date.parse(previous.data.observedAt)>Date.parse(value.data.observedAt))return old;
      if(source==='background'&&previous?.data?.publishedCurrent===true&&previous.data.analysisRunId!==(value.data?.analysisRunId||value.analysisRunId))return old;
      if(source==='empty'&&(previous?.status==='error'||job&&['queued','loading'].includes(previous?.status)))return old;
      let update=value;
      if(receipt&&!receiptCurrent(receipt)){
        if(!value.data)return old;
        // An older head can supply history, never overwrite a newer receipt from
        // another head, lightweight status read or completed manual request.
        update={...value,currentResearch:previous?.currentResearch||null,currentResearchRequestedAt:previous?.currentResearchRequestedAt??null,currentResearchReceivedAt:previous?.currentResearchReceivedAt??null};
        needsCurrentCheck.current=true;
      }
      return{...old,[id]:{...previous,...update}};
    });};
    async function json(url){
      const controller=new AbortController();reads.add(controller);const timer=setTimeout(()=>controller.abort(),20000);
      try{const response=await fetch(url,{cache:'no-store',signal:controller.signal});const body=await response.json();
        if(!response.ok||body.ok!==true)throw Object.assign(Error(response.status===401?'登入已過期':body.error||'已保存分析暫時無法讀取'),{status:response.status});return body;
      }finally{clearTimeout(timer);reads.delete(controller);}
    }
    async function loadSaved(ids=null){
      if(!current())return;const requested=new Set(ids||gamesRef.current.map(game=>game.id));
      if(reading){for(const id of requested)queuedHistory.add(id);return;}reading=true;clearTimeout(historyTimer);let index=0,nextExpiry=Infinity;const processing=[];
      const targets=gamesRef.current.filter(game=>requested.has(game.id));
      async function worker(){while(current()&&index<targets.length){const game=targets[index++];if(pending.current.has(game.id))continue;const epoch=epochs.current.get(game.id)||0,requestedAt=Date.now(),receipt=beginReceipt(game);
        try{const body=await json(`/api/soccer/analysis?${new URLSearchParams({league:game.league,date:game.date,eventId:game.sourceId})}`);
          if(!current())return;const saved=soccerSavedAnalysisState(body,game,Date.now());
          if(saved?.data){saved.currentResearch=body.currentResearch||null;saved.currentResearchRequestedAt=requestedAt;saved.currentResearchReceivedAt=Date.now();if(!saved.currentResearch)needsCurrentCheck.current=true;}
          if(saved?.status==='loading')processing.push(game.id);
          if(saved?.data?.publishedCurrent){const expiry=Date.parse(saved.data.qualificationValidUntil||saved.data.validUntil||'');if(Number.isFinite(expiry))nextExpiry=Math.min(nextExpiry,expiry);}
          if(saved)recoverPatch(game.id,saved,epoch,'saved',receipt);
          else recoverPatch(game.id,{status:'idle',data:undefined,error:'',recoveryError:''},epoch,'empty',receipt);
        }catch(error){if(current()&&error.name!=='AbortError')recoverPatch(game.id,{recoveryError:error.message},epoch);}
      }}
      try{await Promise.all([worker(),worker()]);}finally{reading=false;if(current()){
        if(queuedHistory.size){const next=[...queuedHistory];queuedHistory.clear();void loadSaved(next);}
        else{let delay=Math.min(60000,Math.max(250,nextExpiry-Date.now()+20)),ids=null;
          const processingDelay=Math.max(10000,processing.length*2000);
          if(!job&&processing.length&&processingDelay<delay){delay=processingDelay;ids=processing;}
          historyTimer=setTimeout(()=>loadSaved(ids),delay);}
      }}
    }
    function discover(){
      let saved=null;try{if(typeof window!=='undefined')saved=JSON.parse(window.localStorage.getItem(SOCCER_ALL_LEAGUE_STORAGE)||'null');}catch{}
      return findSoccerBackgroundJob(gamesRef.current,runId,saved,date);
    }
    async function poll(){
      if(!current()||polling||!job)return;polling=true;const expected=job,changed=[];
      try{const response=await json(`/api/analysis-jobs?${new URLSearchParams({runId:expected.runId,league:expected.league})}`);
        if(!current()||job?.runId!==expected.runId)return;
        const updates=soccerBackgroundStates(response,expected,gamesRef.current);
        for(const [id,value]of Object.entries(updates)){
          if(['done','error'].includes(value.status)){
            const fingerprint=JSON.stringify([value.status,value.data?.analysisRunId,value.data?.revision,value.data?.observedAt,value.analysisRunId,value.analysisStatus,value.error]);
            if(settled.get(id)===fingerprint)continue;settled.set(id,fingerprint);changed.push(id);
          }
          recoverPatch(id,value,jobEpochs.get(id)||0,'background');
        }
        const finished=response.status==='completed'||response.progress&&response.progress.results?.length===response.progress.total&&!response.progress.runningGamePks?.length;
        if(['failed','cancelled'].includes(response.status))throw Object.assign(Error('足球背景工作未完成，可重新分析'),{terminal:true});
        patch('__soccerJob',{status:finished?'completed':'running',message:finished?'背景分析已完成，正在載入已保存結果':'足球背景分析中，結果將逐場載入',error:''});
        if(finished)void loadSaved(gamesRef.current.filter(game=>game.date===expected.date).map(game=>game.id));
        else if(changed.length)void loadSaved(changed);
        if(finished){job=null;return;}
      }catch(error){if(current()){
        const terminal=error.terminal||[401,404].includes(error.status);
        patch('__soccerJob',{status:terminal?'failed':'running',message:'',error:error.message});
        if(terminal){
          // A stopped workflow must release its queued rows before parent busy
          // guards can permit a deliberate retry. Never alter local POSTs.
          for(const game of gamesRef.current.filter(row=>row.date===expected.date))patch(game.id,{status:'error',analysisStatus:'FAILED',qaFlag:'BLOCKED',error:'背景工作已停止，可重新核對'},previous=>!pending.current.has(game.id)&&['queued','loading'].includes(previous?.status)&&(epochs.current.get(game.id)||0)===(jobEpochs.get(game.id)||0));
          job=null;
        }
      }}
      finally{polling=false;if(current()&&job)pollTimer=setTimeout(poll,2500);}
    }
    function reconnect(){if(!current())return;clearTimeout(pollTimer);const next=discover();if(next){
      const key=`${next.runId}:${next.league}:${next.date}`;if(key!==jobKey){jobKey=key;settled.clear();jobEpochs=new Map(epochs.current);}
      job=next;void poll();}void loadSaved();}
    refreshSaved.current=reconnect;reconnect();
    if(typeof window!=='undefined'){window.addEventListener('focus',reconnect);window.addEventListener('storage',reconnect);}
    return()=>{stopped=true;refreshSaved.current=null;clearTimeout(historyTimer);clearTimeout(pollTimer);for(const controller of reads)controller.abort();if(typeof window!=='undefined'){window.removeEventListener('focus',reconnect);window.removeEventListener('storage',reconnect);}};
  },[recoveryScope,runId,date]);
  useEffect(()=>{
    let polling=false,lastPoll=Date.now(),cancelled=false,recheckNeeded=false;
    const refreshClockBoundary=()=>{if(Object.entries(latestStates.current).some(([id,state])=>soccerResearchIsCurrent(state)!==Boolean(displayedCurrent.current[id])))setClockTick(value=>value+1);};
    async function pollCurrent(){
      if(cancelled||polling||!alive.current||typeof document!=='undefined'&&document.visibilityState!=='visible')return;
      const targets=games.filter(game=>latestStates.current[game.id]?.status==='done'&&latestStates.current[game.id]?.data?.analysisStatus==='COMPLETED');
      if(!targets.length)return;
      polling=true;let index=0;
      async function worker(){while(!cancelled&&alive.current&&index<targets.length){const game=targets[index++],runId=latestStates.current[game.id]?.data?.analysisRunId,epoch=epochFor(game);
        const controller=new AbortController(),requestedAt=Date.now(),receipt=beginReceipt(game);controllers.current.add(controller);const timer=setTimeout(()=>controller.abort(),10000);
        try{const r=await fetch(`/api/soccer/analysis?${new URLSearchParams({league:game.league,date:game.date,eventId:game.sourceId,view:'current'})}`,{cache:'no-store',signal:controller.signal}),d=await r.json(),status=d.currentResearch;
          if(!r.ok||!d.ok||d.gameId!==game.id||d.league!==game.league||d.date!==game.date||!status||typeof status.publishedCurrent!=='boolean'||status.executable!==false||status.formalScoringEnabled!==false||!Number.isFinite(Date.parse(status.checkedAt)))throw Error('CURRENT_STATUS_UNVERIFIED');
          patch(game.id,{currentResearch:status,currentResearchRequestedAt:requestedAt,currentResearchReceivedAt:Date.now()},previous=>!cancelled&&epochFor(game)===epoch&&receiptCurrent(receipt)&&previous?.data?.analysisRunId===runId);
        }catch{patch(game.id,{currentResearch:null,currentResearchRequestedAt:requestedAt,currentResearchReceivedAt:Date.now()},previous=>!cancelled&&epochFor(game)===epoch&&receiptCurrent(receipt)&&previous?.data?.analysisRunId===runId);}
        finally{clearTimeout(timer);controllers.current.delete(controller);}
      }}
      try{await Promise.all([worker(),worker()]);}finally{polling=false;if(recheckNeeded&&!cancelled){recheckNeeded=false;void pollCurrent();}}
    }
    const id=setInterval(()=>{if(typeof document!=='undefined'&&document.visibilityState!=='visible')return;
      // Check cheap metadata each second; redraw the result tree only when its
      // current/historical classification crosses a deadline or clock boundary.
      refreshClockBoundary();
      if(needsCurrentCheck.current&&!polling){needsCurrentCheck.current=false;lastPoll=Date.now();void pollCurrent();}
      else if(Date.now()-lastPoll>=30000){lastPoll=Date.now();void pollCurrent();}
    },1000);
    const onVisible=()=>{if(document.visibilityState==='visible'){refreshClockBoundary();lastPoll=Date.now();void pollCurrent();}};
    const onReaderChange=event=>{
      const detail=event?.detail;if(!detail||!['epl','ucl'].includes(detail.league)||!/^[a-f0-9]{64}$/.test(detail.contentHash||''))return;
      const affected=games.filter(game=>game.league===detail.league&&game.date===detail.date);
      if(!affected.length)return;
      for(const game of affected){epochs.current.set(game.id,(epochs.current.get(game.id)||0)+1);statusEpoch.current.set(scopeKey(game),epochFor(game)+1);if(latestStates.current[game.id])patch(game.id,{currentResearch:null,currentResearchRequestedAt:Date.now(),currentResearchReceivedAt:Date.now()});}
      lastPoll=Date.now();if(polling)recheckNeeded=true;else void pollCurrent();
    };
    if(typeof document!=='undefined')document.addEventListener('visibilitychange',onVisible);
    if(typeof window!=='undefined')window.addEventListener('soccer:reader-content-changed',onReaderChange);
    return()=>{cancelled=true;clearInterval(id);if(typeof document!=='undefined')document.removeEventListener('visibilitychange',onVisible);if(typeof window!=='undefined')window.removeEventListener('soccer:reader-content-changed',onReaderChange);};
  },[games]);
  function pump(){
    while(alive.current&&active.current<2&&queue.current.length){const task=queue.current.shift(),game=task.game;active.current++;const controller=new AbortController(),requestedAt=Date.now(),epoch=epochFor(game),receipt=beginReceipt(game);controllers.current.add(controller);let timedOut=false;const timer=setTimeout(()=>{timedOut=true;controller.abort();},50000);patch(game.id,{status:'loading',error:''});
      fetch('/api/soccer/analysis',{method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',signal:controller.signal,body:JSON.stringify({league:game.league,date:game.date,eventId:game.sourceId})}).then(async r=>{
        const d=await r.json();if(!r.ok||!d.ok)throw Object.assign(Error(r.status===401?'登入已過期':d.error||'核對失敗'),{analysisStatus:d.analysisStatus,qaFlag:d.qaFlag,analysisRunId:d.analysisRunId});
        validateSoccerAnalysisPayload(d,game);
        patch(game.id,()=>{const invalidated=epochFor(game)!==epoch||!receiptCurrent(receipt);if(invalidated)needsCurrentCheck.current=true;
          return{status:'done',data:d,currentResearch:invalidated?null:d.currentResearch||null,currentResearchRequestedAt:requestedAt,currentResearchReceivedAt:Date.now(),error:''};});
        task.resolve(d);
      }).catch(e=>{patch(game.id,{status:'error',analysisStatus:e.analysisStatus==='INSUFFICIENT_DATA'?'INSUFFICIENT_DATA':'FAILED',qaFlag:e.qaFlag||'BLOCKED',analysisRunId:e.analysisRunId||null,error:timedOut?'核對逾時，請重試':e.name==='AbortError'?'核對已停止':e.message});task.resolve(null);}).finally(()=>{clearTimeout(timer);controllers.current.delete(controller);pending.current.delete(game.id);active.current--;pump();});
    }
  }
  function run(game){if(pending.current.has(game.id))return pending.current.get(game.id);if(externalBusyRef.current)return Promise.resolve(null);epochs.current.set(game.id,(epochs.current.get(game.id)||0)+1);patch(game.id,{status:'queued',error:'',recoveryError:''});const promise=new Promise(resolve=>queue.current.push({game,resolve}));pending.current.set(game.id,promise);pump();return promise;}
  async function runAll(){if(batch||externalBusyRef.current)return;setBatch(true);try{await Promise.all(games.filter(g=>g.status==='scheduled'&&Date.parse(g.startTime)>Date.now()).map(run));}finally{if(alive.current)setBatch(false);}}
  const available=games.some(g=>g.status==='scheduled'&&Date.parse(g.startTime)>Date.now()),counts=soccerAnalysisCounts(games,states);
  const background=states.__soccerJob;
  const busy=Boolean(batch||Object.values(states).some(state=>['queued','loading'].includes(state?.status))||background?.status==='running');
  const busyCallback=useRef(onBusyChange),reportedBusy=useRef(null);busyCallback.current=onBusyChange;
  const busyLeague=String(league||'').toUpperCase();
  useEffect(()=>()=>{
    if(reportedBusy.current?.league===busyLeague&&reportedBusy.current?.date===date&&reportedBusy.current.busy){
      const value={league:busyLeague,date,busy:false};reportedBusy.current=value;busyCallback.current?.(value);
    }
  },[busyLeague,date]);
  useEffect(()=>{
    const value={league:busyLeague,date,busy},previous=reportedBusy.current;
    if(previous?.league===value.league&&previous?.date===value.date&&previous.busy===value.busy)return;
    reportedBusy.current=value;busyCallback.current?.(value);
  },[busyLeague,date,busy]);
  const workspaceStates=Object.fromEntries(Object.entries(states).map(([id,state])=>[id,state.data?{...state,data:{...state.data,publishedCurrent:soccerResearchIsCurrent(state)}}:state]));
  return <Context.Provider value={{states,run,externalBusy}}><div className="soccerAnalysisToolbar"><button type="button" className="secondary" disabled={batch||externalBusy||!available} onClick={runAll}>{batch?'正在核對賽前資料…':'一鍵核對賽前資料'}</button><button type="button" className="secondary" onClick={()=>refreshSaved.current?.()}>載入已保存分析</button><span>研究模式・正式評分尚未啟用</span><a href="/soccer/specification">分析規格 2.2</a></div>{background?.message&&<p className="soccerAvailability" role="status">{background.message}</p>}{background?.error&&<p className="soccerAnalysisWarning" role="alert">{background.error}；可按「載入已保存分析」重試。</p>}<div className="soccerAnalysisSummary" role="status" aria-live="polite"><strong>目前候選 {counts.candidates} 場</strong><span>本頁範圍 {counts.total} 場</span><span>待分析／重核 {counts.waiting}</span><span>處理中 {counts.processing}</span><span>完成 {counts.completed}</span><span>資料不足 {counts.insufficient}</span><span>失敗 {counts.failed}</span><span>研究中 {counts.research}</span></div><SoccerWorkspace games={games} states={workspaceStates} run={run} league={league} date={date} analysisReady={!batch&&background?.status!=='running'} onHighScoreStatusChange={onHighScoreStatusChange} externalBusy={externalBusy}>{children}</SoccerWorkspace></Context.Provider>;
}
export default function SoccerAnalysisPanel({game}){
  const [history,setHistory]=useState({versions:[],runs:[],loading:false,error:'',loaded:false});
  const context=useContext(Context);if(!context)return null;
  const state=context.states[game.id],data=state?.data,e=data?.evidence,prediction=data?.prediction,busy=['queued','loading'].includes(state?.status);
  const presentation=soccerAnalysisPresentation(state),currentAttempt=state?.status==='done'&&(presentation.current||presentation.analysisStatus==='INSUFFICIENT_DATA'),historical=Boolean(data&&!currentAttempt),qaFlag=state?.status==='error'?state.qaFlag:currentAttempt?data?.qaFlag:null;
  const prestart=game.status==='scheduled'&&Date.parse(game.startTime)>Date.now(),stale=data&&Date.now()-Date.parse(data.observedAt)>180000;
  async function loadHistory(){setHistory(old=>({...old,loading:true,error:''}));try{const r=await fetch(`/api/soccer/analysis?${new URLSearchParams({league:game.league,date:game.date,eventId:game.sourceId})}`,{cache:'no-store',signal:AbortSignal.timeout(15000)}),d=await r.json(),runs=d.runs===undefined?[]:d.runs;if(!r.ok||!d.ok||d.gameId!==game.id||d.date!==game.date||d.league!==game.league||!Array.isArray(d.versions)||d.versions.some(v=>v.gameId!==game.id||v.date!==game.date||v.league!==game.league||v.executable!==false)||!Array.isArray(runs)||runs.some(run=>!run||typeof run.analysisRunId!=='string'||!Number.isFinite(Date.parse(run.startedAt))||!['PROCESSING','COMPLETED','FAILED','INSUFFICIENT_DATA'].includes(run.analysisStatus)||run.selectionResult!=null&&(run.analysisStatus!=='COMPLETED'||run.selectionResult!=='RESEARCH_SHADOW')||run.reasons!=null&&(!Array.isArray(run.reasons)||run.reasons.some(reason=>typeof reason!=='string'))))throw Error('版本讀取未通過核對');setHistory({versions:d.versions,runs,loading:false,error:'',loaded:true});}catch{setHistory(old=>({...old,loading:false,error:'已保存版本暫時無法讀取。'}));}}
  return <section className="soccerAnalysis" aria-label={`${game.home.name}對${game.away.name}資料核對`}><button type="button" className="secondary" disabled={busy||Boolean(context.externalBusy)} onClick={()=>context.run(game)}>{state?.status==='queued'?'等待核對…':busy?'核對中…':prestart?data?'重新核對賽前資料':'核對賽前資料':'檢視賽後資料'}</button>
    <div className="soccerAnalysisStatuses" data-analysis-status={presentation.analysisStatus}><span>分析：<strong>{presentation.analysisLabel}</strong></span><span>篩選：<strong>{presentation.selectionLabel}</strong></span>{qaFlag&&<span>{qaLabels[qaFlag]||'檢核狀態待確認'}</span>}</div>
    {state?.error&&<p className="soccerAnalysisWarning" role="alert">{state.error}{data?'；上次資料僅供歷史查閱，不代表本次完成。':''}</p>}
    {state?.recoveryError&&<p className="soccerAnalysisWarning" role="alert">已保存分析載入失敗：{state.recoveryError}；可按「載入已保存分析」重試。</p>}
    {data&&<div className={`soccerAnalysisResult${historical?' soccerHistoricalResult':''}`}><p className="soccerAvailability">{historical?'上次資料・僅供歷史查閱':presentation.analysisStatus==='INSUFFICIENT_DATA'?'本次資料不足・尚無研究分布':data.status==='POSTSTART_AUDIT'?'賽後資料核對':'比分研究・不列入正式排名'}｜{clock(data.observedAt)}{stale?'｜資料待更新':''}{data.persisted?'｜版本已保存':'｜本次未保存'}</p>
      {data.analysisStatus==='COMPLETED'&&!presentation.current&&<p className="soccerAnalysisWarning">目前有效狀態待重新核對；此版本僅供歷史查閱。</p>}
      {!data.persisted&&<p className="soccerAnalysisWarning">{data.persistenceError}</p>}
      {prediction?<><h3>研究比分分布</h3><div className="soccerResearchOutcomes"><span>主勝 <strong>{pct(prediction.outcomes.home)}</strong></span><span>和局 <strong>{pct(prediction.outcomes.draw)}</strong></span><span>客勝 <strong>{pct(prediction.outcomes.away)}</strong></span></div><p className="soccerAvailability">模型平均進球：主 {prediction.homeRate.toFixed(2)}／客 {prediction.awayRate.toFixed(2)}。僅依歷史賽果，尚未加入陣容與 xG。</p></>:<p className="soccerAvailability">{prestart?'此場無適用的已訓練球隊資料。':'比賽開始後不補算賽前機率。'}</p>}
      <SoccerPersonnelResearch prediction={data.personnelPrediction} research={data.personnelResearch} baseline={prediction} league={game.league} analysisCutoff={data.analysisCutoff||data.observedAt}/>
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
