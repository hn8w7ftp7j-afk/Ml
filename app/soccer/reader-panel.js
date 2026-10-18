'use client';
import { useEffect, useState } from 'react';
const DOWNLOAD='/downloads/Tai888-Reader-v2.1.34-FOOTBALL.zip';
const time=value=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleTimeString('zh-TW',{timeZone:'Asia/Taipei',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}):'—';
const name=value=>String(value||'').replace(/[\[［【(（]\s*主\s*[\]］】)）]/gu,'');
export default function SoccerReaderPanel({league,date}) {
  const [revision,setRevision]=useState(0),[state,setState]=useState({key:'',data:null,error:'',loading:false});
  const key=`${league}:${date}`;
  useEffect(()=>{const id=setInterval(()=>{if(document.visibilityState==='visible')setRevision(n=>n+1);},30000);return()=>clearInterval(id);},[]);
  useEffect(()=>{
    if(!date)return;let active=true;const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),25000);
    setState(old=>({key,data:old.key===key?old.data:null,error:'',loading:true}));
    fetch(`/api/soccer/reader?${new URLSearchParams({league,date})}`,{cache:'no-store',signal:controller.signal}).then(async r=>{
      const d=await r.json();if(!r.ok||!d.ok)throw Error(r.status===401?'登入已過期':d.error||'原盤讀取失敗');
      if(d.league!==league.toLowerCase()||d.date!==date||!Array.isArray(d.games)||d.games.some(g=>g.league!==league||g.boardDate!==date||!Array.isArray(g.markets)||g.markets.some(m=>m.unit!=='GOALS')||(g.officialGameId&&!g.officialGameId.startsWith(`soccer:${league.toLowerCase()}:`))))throw Error('足球原盤身分核對未通過');
      if(active)setState({key,data:d,error:'',loading:false});
    }).catch(e=>{if(active)setState(old=>({...old,key,error:e.name==='AbortError'?'原盤讀取逾時':e.message,loading:false}));}).finally(()=>clearTimeout(timer));
    return()=>{active=false;clearTimeout(timer);controller.abort();};
  },[key,revision]);
  const current=state.key===key?state:null,data=current?.data,games=data?.games||[];
  const fresh=data?.observedAt&&Date.now()-Date.parse(data.observedAt)<=180000;
  return <section className="panel soccerReader" aria-label="足球Tai888原盤">
    <div className="soccerBoardHeading"><h2>Tai888 足球原盤</h2><button type="button" className="secondary" disabled={!date||current?.loading} onClick={()=>setRevision(n=>n+1)}>{current?.loading?'讀取原盤中…':'更新原盤'}</button></div>
    <p className="soccerAvailability">{current?.error?`原盤更新失敗：${current.error}`:games.length?`${games.length} 場｜同步 ${time(data.observedAt)}${fresh?'':'｜原盤已逾期，請重新同步'}`:'等待 Reader 2.1.34 同步英超／歐冠分頁。'}</p>
    <a className="secondary readerDownload" href={DOWNLOAD} download>下載 Reader 2.1.34 足球版</a>
    {games.length>0&&<p className="soccerAvailability">原始盤口；足球結算規格與模型仍在驗證。</p>}
    {games.map((game,index)=><div className="soccerQuoteGame" key={`${game.boardTime}:${game.homeCode}:${game.awayCode}:${index}`}><h3>{name(game.homeRaw)}（主）對 {name(game.awayRaw)}（客）</h3><p className="soccerAvailability">{game.boardTime}｜{game.matchStatus==='MATCHED'?'官方場次已配對':'場次待核對'}{game.prestart?'':'｜非已確認賽前盤'}</p>
      {game.markets.map((m,i)=><div className="soccerQuote" key={`${m.kind}:${m.line||''}:${i}`}>{m.kind==='HANDICAP'?<><strong>讓球 {m.line}｜{m.lineSide==='home'?'主隊':'客隊'}讓球</strong><span>主 {m.homeWater}｜客 {m.awayWater}</span></>:m.kind==='TOTAL'?<><strong>大小 {m.line}</strong><span>大 {m.overWater}｜小 {m.underWater}</span></>:<><strong>獨贏</strong><span>主 {m.homeWater}｜和 {m.drawWater}｜客 {m.awayWater}</span></>}</div>)}
    </div>)}
  </section>;
}
