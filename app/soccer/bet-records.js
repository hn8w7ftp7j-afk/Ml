'use client';
import { createContext,useContext,useEffect,useRef,useState } from 'react';
import { soccerRecordKey,soccerRecordStats } from '../../lib/soccer/manual-record.js';
import { soccerMarketName } from '../../lib/soccer/ranking.js';
const Ledger=createContext(null);
async function request(url,options={}){
  const r=await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(20000),...options}),d=await r.json();
  if(!r.ok||!d.ok)throw Error(r.status===401?'登入已過期，請重新登入。':d.error||'帳本暫時無法同步。');return d;
}
export function SoccerRecordProvider({league,date,through=date,children}){
  const [records,setRecords]=useState([]),[status,setStatus]=useState('loading'),[error,setError]=useState(''),[pending,setPending]=useState(new Set());
  const generation=useRef(0),flights=useRef(new Set());
  async function load(){const token=++generation.current;setStatus('loading');setError('');try{const d=await request(`/api/soccer/bet-records?${new URLSearchParams({league,date,through})}`);if(token!==generation.current)return;if(d.league!==league||d.date!==date||d.through!==through||!Array.isArray(d.records)||d.records.some(r=>r.league!==league||r.date<date||r.date>through))throw Error('帳本識別不符。');setRecords(d.records);setStatus('ready');}catch(e){if(token===generation.current){setStatus('failed');setError(e.message);}}}
  useEffect(()=>{setRecords([]);void load();return()=>{generation.current++;};},[league,date,through]);
  async function mutate(body,key){
    if(status!=='ready'||flights.current.has(key))return;const token=generation.current;flights.current.add(key);setPending(new Set(flights.current));setError('');
    try{const d=await request('/api/soccer/bet-records',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,league,date:body.date||date})});if(token!==generation.current)return;
      if(d.persistence!=='durable_database'||!d.record?.id||d.record.league!==league||d.record.date<date||d.record.date>through)throw Error('未取得永久保存確認。');
      setRecords(old=>[d.record,...old.filter(r=>soccerRecordKey(r)!==soccerRecordKey(d.record))]);
    }catch(e){if(token===generation.current)setError(e.message);}finally{flights.current.delete(key);setPending(new Set(flights.current));}
  }
  return <Ledger.Provider value={{league,date,records,status,error,pending,load,mutate}}>{error&&<p className="errorBox" role="alert">{error}<button className="mini secondary" onClick={load}>重新同步</button></p>}{children}</Ledger.Provider>;
}
export function SoccerRecordButton({game,result,quote}){
  const ledger=useContext(Ledger);if(!ledger||!game||!quote||!result?.persisted||!result.revision||!['FT','HT'].includes(quote.period)||quote.unit!=='GOALS'||!Number.isFinite(quote.water))return null;
  const key=soccerRecordKey({league:game.league,date:game.date,gameId:game.id,...quote});
  const record=ledger.records.find(r=>soccerRecordKey(r)===key),cancelled=record?.status==='CANCELLED',busy=ledger.pending.has(key);
  return <div className="soccerRecordAction">{record&&<strong>{cancelled?'已取消紀錄':'已下注 ✓'}</strong>}<button className="mini secondary" disabled={ledger.status!=='ready'||busy} title="僅記錄你已自行完成的下注；每筆 10,000 元，不會送單" onClick={()=>ledger.mutate(record?{action:cancelled?'restore':'cancel',id:record.id,date:record.date}:{action:'record',alreadyPlaced:true,date:game.date,gameId:game.id,revision:result.revision,quoteKey:quote.key},key)}>{busy?'儲存中…':ledger.status!=='ready'?'帳本待同步':cancelled?'重新紀錄下注':record?'取消下注':'紀錄實際下注'}</button>{record&&<small>原盤 {record.line}｜水位 {record.water}｜{record.stake.toLocaleString('zh-TW')} 元</small>}</div>;
}
export function SoccerBetRecords(){
  const l=useContext(Ledger);if(!l)return null;const s=soccerRecordStats(l.records);
  return <section className="panel" aria-label="足球下注紀錄"><div className="panelHead"><h2>{l.league==='epl'?'英超':'歐冠'}｜下注紀錄</h2><button className="secondary" disabled={l.status==='loading'} onClick={l.load}>重新讀取</button></div>
    <p>{l.date}｜每筆 10,000 元｜{l.status==='ready'?`已下注 ${s.active} 筆｜已取消 ${s.cancelled} 筆｜投注合計 ${s.stake.toLocaleString('zh-TW')} 元`:'帳本尚未同步完成'}</p>
    <p className="soccerAvailability">僅記錄你已自行完成的下注，不會送單。足球退水 0.01，按投注金額計算；結算適用條款尚待核對，暫不自動結算，損益與勝率顯示待核對。</p>
    <p>已結算：待核對｜勝率：—｜損益：—｜ROI：—</p>
    {l.records.map(r=><article className="soccerSavedVersion" key={r.id}><h3>{r.home}（主）對 {r.away}（客）</h3><p>{r.date}｜{soccerMarketName(r.period,r.kind)}｜{r.label}｜水位 {r.water}</p><p>{r.stake.toLocaleString('zh-TW')} 元｜{r.status==='CANCELLED'?'已取消紀錄':'已下注 ✓'}｜結算待核對</p><button className="mini secondary" disabled={l.status!=='ready'||l.pending.has(soccerRecordKey(r))} onClick={()=>l.mutate({action:r.status==='CANCELLED'?'restore':'cancel',id:r.id,date:r.date},soccerRecordKey(r))}>{r.status==='CANCELLED'?'重新紀錄下注':'取消下注'}</button><small>保存時間 {new Date(r.recordedAt).toLocaleString('zh-TW',{timeZone:'Asia/Taipei'})}</small></article>)}
    {l.status==='ready'&&!l.records.length&&<p>此日期尚無已記錄的下注。</p>}
  </section>;
}
