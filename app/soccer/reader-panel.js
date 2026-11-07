'use client';
import { useEffect, useRef, useState } from 'react';
const READER_VERSION='2.1.57';
const DOWNLOAD='/downloads/Tai888-Reader-v2.1.57-EPL-UCL.zip';
const time=value=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleTimeString('zh-TW',{timeZone:'Asia/Taipei',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}):'—';
const name=value=>String(value||'').replace(/[\[［【(（]\s*主\s*[\]］】)）]/gu,'');
const periodName={FT:'全場',HT:'上半場',UNKNOWN:'期間待確認'};
const validBoardDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(`${value}T00:00:00Z`))&&new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value;
export function soccerReaderBoardDates({league,date,games=[],view='schedule'}={}){
  if(!['EPL','UCL'].includes(league)||!validBoardDate(date))return [];
  if(view!=='upcoming')return [date];
  const limit=Date.parse(`${date}T00:00:00Z`)+13*86400000;
  const dates=Array.isArray(games)?games.filter(game=>game?.league===league.toLowerCase()
    &&typeof game.id==='string'&&game.id.startsWith(`soccer:${league.toLowerCase()}:`)
    &&validBoardDate(game.date)&&game.date>=date&&Date.parse(`${game.date}T00:00:00Z`)<=limit).map(game=>game.date):[];
  return dates.length?[...new Set(dates)].sort():[date];
}
export function SoccerReaderBoards({league,date,games=[],view='schedule'}){
  const dates=soccerReaderBoardDates({league,date,games,view});
  return <div className="soccerReaderBoards" aria-label="本頁賽事原盤核對">
    {view==='upcoming'&&dates.length>0&&<p className="soccerAvailability">按本頁賽事日期核對原盤：{dates.join('、')}。各日期及全場／上半場分開保存；未收到該日原盤不代表沒有歷史紀錄。</p>}
    {dates.map((boardDate,index)=><SoccerReaderPanel key={`${league}:${boardDate}`} league={league} date={boardDate} showDownload={index===0}/>)}
  </div>;
}
const observedIsFresh=(value,now=Date.now())=>{const observed=Date.parse(value||'');return Number.isFinite(observed)&&observed<=now+5000&&now-observed<=180000;};
export function soccerReaderPeriods(data,now=Date.now()){
  const sources=Array.isArray(data?.sourceObservations)?data.sourceObservations:[];
  return sources.filter(source=>source&&typeof source==='object').map(source=>({...source,label:periodName[source.period]||'期間待確認',fresh:observedIsFresh(source.observedAt||source.sourceObservedAt,now)}));
}
const periodBindingReasons={
  CONFIG_MISSING:'尚未設定本來源的全場期間對應。',CONFIG_INVALID:'既有全場期間設定無效，系統需修復設定。',
  LEAGUE_NOT_BOUND:'本聯盟尚未綁定全場期間。',GAME_NOT_MATCHED:'場次尚未與官方賽程配對。',
  MARKET_INVALID:'盤口欄位未通過核對。',HEADER_PROFILE_MISMATCH:'盤面標頭與既有期間設定不符。',
  OBSERVATION_MISSING:'尚缺盤口保存收據。',SOURCE_DEVICE_MISMATCH:'來源裝置與既有期間設定不符，系統需重新綁定。',
  SOURCE_HOST_MISMATCH:'來源網站與既有期間設定不符。',CONFIRMATION_NOT_EFFECTIVE:'期間設定尚未生效。',
  OBSERVATION_BEFORE_CONFIRMATION:'此盤口早於期間設定生效時間，等待生效後的新盤口。',
  OBSERVATION_TIME_INVALID:'盤口來源時間或保存收據未通過核對。',SAME_CAPTURE_HALF_MISSING:'尚缺同一次讀盤的明確上半場標頭。',
  RESOLUTION_NOT_APPLIED:'期間設定符合，但解析結果尚未套用。',
};
export function soccerReaderPeriodBindingMessages(diagnostics){
  return Object.entries(diagnostics?.blockerCounts||{}).filter(([reason,count])=>Object.hasOwn(periodBindingReasons,reason)&&Number.isSafeInteger(count)&&count>0)
    .map(([reason,count])=>`${count} 筆：${periodBindingReasons[reason]}`);
}
export default function SoccerReaderPanel({league,date,showDownload=true}) {
  const [revision,setRevision]=useState(0),[state,setState]=useState({key:'',data:null,error:'',loading:false});
  const [resume,setResume]=useState({key:'',busy:false,message:'',error:''});
  const key=`${league}:${date}`;
  const lastContent=useRef({key:'',hash:null,hasResponse:false});
  const resumeRequest=useRef(null),resumeScope=useRef(key);
  resumeScope.current=key;
  useEffect(()=>{const id=setInterval(()=>{if(document.visibilityState==='visible')setRevision(n=>n+1);},30000);return()=>clearInterval(id);},[]);
  useEffect(()=>{setResume({key,busy:false,message:'',error:''});return()=>{const request=resumeRequest.current;if(request?.key===key){request.controller.abort();resumeRequest.current=null;}};},[key]);
  useEffect(()=>{
    if(!date)return;let active=true;const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),25000);
    setState(old=>({key,data:old.key===key?old.data:null,error:'',loading:true}));
    fetch(`/api/soccer/reader?${new URLSearchParams({league,date})}`,{cache:'no-store',signal:controller.signal}).then(async r=>{
      const d=await r.json();if(!r.ok||!d.ok)throw Error(r.status===401?'登入已過期':d.error||'原盤讀取失敗');
      if(d.league!==league.toLowerCase()||d.date!==date||!Array.isArray(d.games)||d.games.some(g=>g.league!==league||g.boardDate!==date||!Array.isArray(g.markets)||g.markets.some(m=>m.unit!=='GOALS')||(g.officialGameId&&!g.officialGameId.startsWith(`soccer:${league.toLowerCase()}:`))))throw Error('足球原盤身分核對未通過');
      if(active){
        const contentHash=/^[a-f0-9]{64}$/.test(d.contentHash||'')?d.contentHash:null,previous=lastContent.current;
        lastContent.current={key,hash:contentHash,hasResponse:true};
        // Aggregate content excludes observation/heartbeat timestamps. A new
        // price/period state revokes local currentness before showing new rows.
        if(contentHash&&previous.key===key&&previous.hasResponse&&previous.hash!==contentHash&&typeof window!=='undefined')window.dispatchEvent(new CustomEvent('soccer:reader-content-changed',{detail:{league:league.toLowerCase(),date,contentHash}}));
        setState({key,data:d,error:'',loading:false});
      }
    }).catch(e=>{if(active)setState(old=>({...old,key,error:e.name==='AbortError'?'原盤讀取逾時':e.message,loading:false}));}).finally(()=>clearTimeout(timer));
    return()=>{active=false;clearTimeout(timer);controller.abort();};
  },[key,revision]);
  const current=state.key===key?state:null,data=current?.data,games=data?.games||[];
  const periodSources=soccerReaderPeriods(data),fresh=observedIsFresh(data?.observedAt),openMarketCount=games.reduce((count,game)=>count+game.markets.length,0);
  const periodBindingMessages=soccerReaderPeriodBindingMessages(data?.periodBindingDiagnostics);
  const resumeCurrent=resume.key===key?resume:null;
  async function resumeCapture(){
    if(!date||!data||resumeRequest.current?.key===key)return;
    resumeRequest.current?.controller.abort();
    const controller=new AbortController(),request={key,controller};resumeRequest.current=request;
    const active=()=>resumeRequest.current===request&&resumeScope.current===key;
    const timer=setTimeout(()=>controller.abort(),25000);
    setResume({key,busy:true,message:'',error:''});
    try{
      const response=await fetch('/api/soccer/reader-analysis',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({action:'resume',league:league.toLowerCase(),date}),signal:controller.signal});
      const result=await response.json();
      if(!response.ok||result?.ok!==true)throw Error(response.status===401?'登入已過期':result?.error||'背景補存暫時無法啟動');
      if(result.league!==league.toLowerCase()||result.date!==date||result.executable!==false
        ||!['STARTED','FALLBACK_ONLY','UNAVAILABLE'].includes(result.continuation?.status)
        ||result.continuation.executable!==false
        ||(result.continuation.status==='STARTED'
          ?result.continuation.durable!==true||!/^wrun_[0-7][0-9A-HJKMNP-TV-Z]{25}$/i.test(result.continuation.runId||'')
          :result.continuation.durable!==false))throw Error('補存回應的聯盟、日期或工作狀態未通過核對');
      if(result.continuation.status==='UNAVAILABLE')throw Error('背景補存暫時無法啟動，原盤保存不受影響。');
      if(active())setResume({key,busy:false,error:'',message:result.continuation.status==='STARTED'
        ?'已啟動背景補存，是否完成仍須核對封存結果；逾期盤口不會補造預測。'
        :'背景續跑暫時無法啟動，已安排備援處理；這不代表預測已補存完成。'});
    }catch(error){if(active())setResume({key,busy:false,message:'',error:error.name==='AbortError'?'補存啟動回應逾時，是否已啟動仍待核對。':String(error.message||'背景補存暫時無法啟動')});}
    finally{clearTimeout(timer);if(resumeRequest.current===request)resumeRequest.current=null;}
  }
  return <section className="panel soccerReader" aria-label={`足球Tai888原盤 ${date}`}>
    <div className="soccerBoardHeading"><h2>Tai888 足球原盤｜{date}</h2><button type="button" className="secondary" disabled={!date||current?.loading} onClick={()=>setRevision(n=>n+1)}>{current?.loading?'讀取原盤中…':'更新原盤'}</button></div>
    <p className="soccerAvailability">{current?.error?`原盤更新失敗：${current.error}`:!data?`正在核對 ${date} 原盤保存狀態…`:games.length?`${games.length} 場｜${openMarketCount} 筆盤口${openMarketCount?'':'｜此版本沒有開放盤口'}${periodSources.length?'｜按期間分開保存':`｜同步 ${time(data.observedAt)}${fresh?'':'｜原盤已逾期，請重新同步'}`}`:periodSources.length?'原盤來源已保存，此版本沒有開放盤口。':`${date} 尚無原盤；等待 Reader ${READER_VERSION} 同步該日期分頁。其他已保存日期可在「已保存原盤」查看。`}</p>
    {periodSources.length>0&&<p className="soccerAvailability">{periodSources.map(source=>`${source.label} ${time(source.observedAt||source.sourceObservedAt)}${source.fresh?'':'（待更新）'}`).join('｜')}</p>}
    {periodBindingMessages.length>0&&<div className="soccerAvailability" role="status" aria-label="全場期間核對原因">{periodBindingMessages.map(message=><p key={message}>{message}</p>)}</div>}
    {data&&(games.length>0||periodSources.length>0)&&<div className="soccerAvailability"><button type="button" className="secondary" disabled={resumeCurrent?.busy||current?.loading} onClick={resumeCapture}>{resumeCurrent?.busy?'正在啟動補存…':'補存盤口預測'}</button></div>}
    {resumeCurrent&&(resumeCurrent.message||resumeCurrent.error)&&<p className="soccerAvailability" role="status" aria-label="盤口預測補存狀態">{resumeCurrent.error?`補存未確認：${resumeCurrent.error}`:resumeCurrent.message}</p>}
    {showDownload&&<a className="secondary readerDownload" href={DOWNLOAD} download>下載 Reader {READER_VERSION} 足球版</a>}
    {games.length>0&&<p className="soccerAvailability">原始盤口；足球結算規格與模型仍在驗證。</p>}
    {games.map((game,index)=><div className="soccerQuoteGame" key={`${game.boardTime}:${game.homeCode}:${game.awayCode}:${index}`}><h3>{name(game.homeRaw)}（主）對 {name(game.awayRaw)}（客）</h3><p className="soccerAvailability">{game.boardTime}｜{game.matchStatus==='MATCHED'?'來源賽程初步配對，完整性待核對':'場次待核對'}{game.prestart?'':'｜非已確認賽前盤'}</p>
      {game.markets.length===0&&<p className="soccerAvailability">此版本沒有開放盤口；已保留來源場次紀錄。</p>}
      {game.markets.map((m,i)=><div className="soccerQuote" key={`${m.period}:${m.kind}:${m.line||''}:${i}`}><span>{periodName[m.period]||'期間待確認'}</span>{m.kind==='HANDICAP'?<><strong>讓球 {m.line}｜{m.lineSide==='home'?'主隊':'客隊'}讓球</strong><span>主 {m.homeWater}｜客 {m.awayWater}</span></>:m.kind==='TOTAL'?<><strong>大小 {m.line}</strong><span>大 {m.overWater}｜小 {m.underWater}</span></>:<><strong>獨贏</strong><span>主 {m.homeWater}｜和 {m.drawWater}｜客 {m.awayWater}</span></>}</div>)}
    </div>)}
  </section>;
}
