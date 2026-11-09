'use client';
import { useEffect,useRef,useState } from 'react';

const messages={SIMULATION_INPUT_INVALID:'請核對期間、球頭與水位格式。',SIMULATION_PREGAME_FORECAST_EXPIRED:'賽前分析已過期或比賽已開始，請先重新核對賽前資料。',SIMULATION_PERIOD_MODEL_UNAVAILABLE:'這個期間尚無適用的比分模型。',SIMULATION_PAYOUT_UNSUPPORTED:'此球頭尚無支援的信用盤派彩試算方式。',SIMULATION_SOURCE_UNAVAILABLE:'原分析暫時讀取失敗，請稍後重試。'};
const pct=value=>typeof value==='number'&&Number.isFinite(value)?`${value>0?'+':''}${(value*100).toFixed(2)}%`:'—';
const clock=value=>Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false}):'—';
const finite=value=>typeof value==='number'&&Number.isFinite(value);
function predictionValid(value,input,game){
  if(value==null)return true;
  if(value.status==='UNAVAILABLE')return value.inputSource==='USER_HYPOTHESIS'&&value.eligiblePrediction===false
    &&value.formalEligible===false&&value.executable===false&&['W','R','S','score'].every(key=>value[key]===null);
  const bounds=range=>finite(range?.lower)&&finite(range?.upper)&&range.lower<=range.upper;
  return value.version==='SOCCER-MODEL-PREDICTION-SCORE-v1'&&value.status==='PREDICTION_RETURN_SUMMARY_AVAILABLE'
    &&value.inputSource==='USER_HYPOTHESIS'&&value.analysisRevision===input.revision&&value.gameId===game.id
    &&value.league===input.league&&value.period===input.period&&value.sourceQuoteKey===null
    &&value.eligiblePrediction===false&&value.formalEligible===false&&value.formalScoringEnabled===false
    &&value.executable===false&&value.totalModelError===null&&value.modelValidation==='UNVERIFIED'
    &&finite(value.score)&&value.score>=1&&value.score<=10&&value.S===value.score
    &&finite(value.W)&&finite(value.R_model)&&value.R===value.R_model
    &&bounds(value.WBounds)&&bounds(value.RBounds)&&bounds(value.scoreBounds)
    &&value.W===value.WBounds.lower&&value.R_model===value.RBounds.lower&&value.score===value.scoreBounds.lower
    &&/^[a-f0-9]{64}$/.test(value.distributionHash||'')&&/^[a-f0-9]{64}$/.test(value.scenarioArtifactHash||'')
    &&/^[a-f0-9]{64}$/.test(value.scenarioProtocolHash||'');
}
export function SoccerManualSimulation({result,game}){
  const [period,setPeriod]=useState('FT'),[kind,setKind]=useState('TOTAL'),[side,setSide]=useState('over'),
    [lineSide,setLineSide]=useState('home'),[line,setLine]=useState(''),[water,setWater]=useState(''),
    [state,setState]=useState({busy:false,value:null,error:''});
  const request=useRef(null),sequence=useRef(0);
  useEffect(()=>{setState({busy:false,value:null,error:''});return()=>{sequence.current++;request.current?.abort();request.current=null;};},[result?.revision,game?.id,game?.startTime,period,kind,side,lineSide,line,water]);
  const saved=result?.evidence?.game,now=Date.now(),cutoff=Date.parse(result?.analysisCutoff||'');
  const available=result?.persisted===true&&/^[a-f0-9]{64}$/.test(result?.revision||'')
    &&game?.id===saved?.id&&game?.league===saved?.league&&game?.date===saved?.date
    &&game?.home?.sourceId===saved?.home?.sourceId&&game?.away?.sourceId===saved?.away?.sourceId
    &&Date.parse(game?.startTime)===Date.parse(saved?.startTime)&&Boolean(game?.neutralSite)===Boolean(saved?.neutralSite)
    &&game?.status==='scheduled'&&Date.parse(game?.startTime)>now&&Number.isFinite(cutoff)&&cutoff<=now&&now-cutoff<180000
    &&Boolean(period==='FT'?result?.prediction:result?.halfTimePrediction);
  async function calculate(event){
    event.preventDefault();if(request.current||!available)return;
    const input={league:game.league,date:game.date,eventId:game.sourceId,revision:result.revision,period,kind,side,
      line:line.trim(),lineSide:kind==='HANDICAP'?lineSide:null,water:Number(water)};
    const controller=new AbortController(),id=++sequence.current;request.current=controller;
    const timeout=setTimeout(()=>controller.abort(),20000);
    setState({busy:true,value:null,error:''});
    try{
      const response=await fetch('/api/soccer/simulation',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),signal:controller.signal});
      const value=await response.json();if(id!==sequence.current)return;
      if(!response.ok||value?.ok!==true)throw Error(messages[value?.reason]||'試算暫時無法完成，請重新分析後再試。');
      if(value.version!=='SOCCER-MANUAL-CONDITIONAL-RETURN-v1'||value.status!=='USER_HYPOTHESIS_ONLY'
        ||value.inputSource!=='USER_HYPOTHESIS'||value.analysisRevision!==input.revision||value.gameId!==game.id
        ||!value.input||Object.keys(input).some(k=>value.input[k]!==input[k])
        ||value.formalScoringEnabled!==false||value.eligible!==false||value.executable!==false
        ||['W','R','S'].some(k=>value[k]!==null)||value.assumption?.accountTermsVerified!==false
        ||value.assumption?.mechanic!=='CREDIT_BOUNDARY'||value.assumption?.rebateRate!==.01
        ||value.assumption?.rebateBasis!=='SETTLED_PRINCIPAL'
        ||typeof value.netReturnBounds?.lower!=='number'||!Number.isFinite(value.netReturnBounds.lower)
        ||typeof value.netReturnBounds?.upper!=='number'||!Number.isFinite(value.netReturnBounds.upper)
        ||value.netReturnBounds.lower>value.netReturnBounds.upper||!predictionValid(value.predictionScore,input,game))throw Error('試算回應的原分析、輸入或範圍不符，請重試。');
      setState({busy:false,value,error:''});
    }catch(error){if(id===sequence.current)setState({busy:false,value:null,error:error.name==='AbortError'?'試算已取消。':error.message});}
    finally{clearTimeout(timeout);if(id===sequence.current)request.current=null;}
  }
  if(!result?.prediction&&!result?.halfTimePrediction)return null;
  return <details className="soccerDetails" open><summary>手動盤口預測評分</summary>
    <p className="soccerMarketNote">輸入球頭與水位，使用目前模型預測收益與 S 分數。手動盤口會清楚標示來源，不列入 Reader 原盤排名，也不會建立下注紀錄。</p>
    {!available&&<p className="soccerMarketCaution">請先重新分析未開賽場次，取得三分鐘內的賽前模型。</p>}
    <form className="soccerForwardFilters" onSubmit={calculate}>
      <label>試算期間 <select value={period} disabled={state.busy} onChange={e=>setPeriod(e.target.value)}><option value="FT" disabled={!result.prediction}>全場</option><option value="HT" disabled={!result.halfTimePrediction}>上半場</option></select></label>
      <label>試算盤種 <select value={kind} disabled={state.busy} onChange={e=>{setKind(e.target.value);setSide(e.target.value==='TOTAL'?'over':'home');}}><option value="TOTAL">大小</option><option value="HANDICAP">讓球／受讓</option></select></label>
      <label>試算方向 <select value={side} disabled={state.busy} onChange={e=>setSide(e.target.value)}>{kind==='TOTAL'?<><option value="over">大球</option><option value="under">小球</option></>:<><option value="home">主隊</option><option value="away">客隊</option></>}</select></label>
      {kind==='HANDICAP'&&<label>讓球方 <select value={lineSide} disabled={state.busy} onChange={e=>setLineSide(e.target.value)}><option value="home">主隊讓球</option><option value="away">客隊讓球</option></select></label>}
      <label>試算球頭 <input required value={line} maxLength={16} disabled={state.busy} onChange={e=>setLine(e.target.value)} placeholder="輸入原始球頭"/></label>
      <label>試算水位 <input required type="number" step="any" min="0.000001" max="1000" value={water} disabled={state.busy} onChange={e=>setWater(e.target.value)}/></label>
      <button type="submit" className="secondary" disabled={!available||state.busy}>{state.busy?'試算中…':'計算預測評分'}</button>
    </form>
    {state.error&&<p role="alert" className="soccerMarketCaution">{state.error}</p>}
    {state.value&&<section aria-label="手動盤口試算結果">
      {finite(state.value.predictionScore?.score)&&<div aria-label="手動盤口預測評分結果"><strong>{available?'預測 S':'歷史預測 S'}：{state.value.predictionScore.score.toFixed(1)}／10</strong>
        <p>預測 W：{pct(state.value.predictionScore.W)}｜模型情境 R：{pct(state.value.predictionScore.R_model)}</p>
        <p className="soccerMarketNote">沿用既定 S 公式；依現有資料及模型情境預測，完整模型誤差尚未估計。此為手動輸入盤口的預測評分。</p></div>}
      {state.value.predictionScore?.status==='UNAVAILABLE'&&<p className="soccerMarketCaution">此版本尚無可重建的預測情境，請重新核對賽前資料後再試。</p>}
      <strong>{available?'假設盤口期望淨收益':'歷史假設盤口期望淨收益'}：{pct(state.value.netReturnBounds.lower)} ～ {pct(state.value.netReturnBounds.upper)}（每元本金）</strong>
      <p className="soccerMarketNote">模型時間：{clock(state.value.analysisCutoff)}｜試算時間：{clock(state.value.calculatedAt)}</p>
      <p className="soccerMarketNote">信用盤比例派彩假設，帳號適用條款尚未確認；退水按實際輸贏本金的 1%，走盤不退。收益範圍不包含完整模型誤差；手動試算不建立正式驗收或原盤排名資格。</p></section>}
  </details>;
}
