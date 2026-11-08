'use client';

import { useEffect, useRef, useState } from 'react';
import RawSeenReplay from './raw-seen-replay.js';
import { taipeiHistoryTime } from './history-view.js';
import styles from './raw-seen-history-index.module.css';

const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const instant=v=>typeof v==='string'&&/(?:Z|[+-]\d\d:\d\d)$/.test(v)&&Number.isFinite(Date.parse(v));
const day=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
const safeText=v=>typeof v==='string'&&v.length>0&&v.length<=200&&!/[\u0000-\u001f\u007f]/.test(v);
const readonly=v=>v?.archiveOnly===true&&v.currentBoardUpdated===false&&v.historicalAvailabilityVerified===false&&v.executable===false&&v.coverageComplete===false&&v.closingCoverage==='NOT_VERIFIED'&&v.formalEligible===false&&v.calibrationEligible===false&&v.identityVerified===false;
const time=v=>instant(v)?taipeiHistoryTime(v):'未確認';
function initialFilters() {
  const through=new Date(Date.now()+8*3600000).toISOString().slice(0,10),from=new Date(Date.parse(through+'T00:00:00Z')-6*86400000).toISOString().slice(0,10);
  return {league:'UCL',from,through,gameKey:''};
}
export function validateRawHistoryIndex(value,filters) {
  const invalid=()=>{throw new Error('歷史索引回應未通過核對，未將異常回應當成沒有盤口。');};
  if(value?.ok!==true||value.schema!=='soccer-raw-history-index-v1'||!readonly(value)||!['NOT_INITIALIZED','INDEXED_HISTORY_ONLY'].includes(value.status)
    ||value.indexCoverage!=='NOT_VERIFIED'||!instant(value.until)||!Array.isArray(value.entries)||value.entries.length>50
    ||typeof value.hasMore!=='boolean'||(value.hasMore?typeof value.nextAfter!=='string'||!value.nextAfter:value.nextAfter!==null)
    ||!['league','from','through'].every(k=>value.filters?.[k]===filters[k])||(value.filters.gameKey||'')!==(filters.gameKey||'')
    ||value.status==='NOT_INITIALIZED'&&(value.entries.length>0||value.hasMore))invalid();
  const seen=new Set();
  for(const row of value.entries){
    const id=[row?.boardDate,row?.gameKey,row?.captureBatchId].join('|');
    if(!readonly(row)||row.league!==filters.league||!day(row.boardDate)||row.boardDate<filters.from||row.boardDate>filters.through
      ||!safeText(row.gameKey)||filters.gameKey&&row.gameKey!==filters.gameKey||seen.has(id)
      ||!['awayRaw','homeRaw','awayKey','homeKey'].every(k=>safeText(row[k]))||row.awayKey===row.homeKey
      ||!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(row.boardTime||'')||row.gameKey!==[row.boardTime,row.awayKey,row.homeKey].join('|')
      ||!Number.isSafeInteger(row.marketCount)||row.marketCount<1||row.marketCount>200
      ||!Array.isArray(row.periods)||!row.periods.length||!row.periods.every(v=>['FT','HT','UNKNOWN'].includes(v))
      ||row.identityStatus!=='ORIGINAL_BOARD_IDENTITY_ONLY'||!digest(row.captureBatchId)||!digest(row.derivedHash)||!safeText(row.derivationVersion)
      ||!['observedAt','indexedAt','sourceReceivedAt','sourcePersistedAt'].every(k=>instant(row[k]))
      ||row.capture?.league!==row.league||!digest(row.capture.captureId)||!digest(row.capture.evidenceHash)||!instant(row.capture.observedAt)
      ||Date.parse(row.capture.observedAt)!==Date.parse(row.observedAt)||row.capture.captureBatchId!=null&&row.capture.captureBatchId!==row.captureBatchId)invalid();
    seen.add(id);
  }
  return value;
}
export default function RawSeenHistoryIndexPanel() {
  const [draft,setDraft]=useState(initialFilters),[result,setResult]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [sourceId,setSourceId]=useState(''),[sourceMessage,setSourceMessage]=useState('');
  const request=useRef({sequence:0,controller:null});
  async function load(filters,append=false){
    const seq=++request.current.sequence;request.current.controller?.abort();const controller=new AbortController();request.current.controller=controller;
    const current=()=>request.current.sequence===seq,timeout=window.setTimeout(()=>controller.abort(),30000);
    if(!append)setResult(null);setError('');setBusy(true);
    try{
      const params=new URLSearchParams(Object.entries(filters).filter(([,v])=>v));
      const response=await fetch('/api/soccer/raw-seen-history-index?'+params,{credentials:'same-origin',cache:'no-store',signal:controller.signal});
      const value=await response.json();if(!response.ok)throw new Error('歷史查閱索引暫時無法讀取，請重試；未當成零筆。');
      validateRawHistoryIndex(value,filters);
      if(current())setResult(previous=>append&&previous?{...value,entries:[...previous.entries,...value.entries]}:value);
    }catch(cause){if(current())setError(cause.name==='AbortError'?'歷史查詢逾時，請重試；原始保存仍保留。':cause.message||'歷史查詢失敗。');}
    finally{window.clearTimeout(timeout);if(current())setBusy(false);}
  }
  useEffect(()=>{load(initialFilters());return()=>{++request.current.sequence;request.current.controller?.abort();};},[]);
  function change(key,value){++request.current.sequence;request.current.controller?.abort();setDraft(previous=>({...previous,[key]:value}));setResult(null);setError('');setBusy(false);}
  async function indexSource(event){
    event.preventDefault();if(!digest(sourceId)){setSourceMessage('請輸入 64 碼的原始保存識別。');return;}
    const seq=++request.current.sequence;request.current.controller?.abort();const controller=new AbortController();request.current.controller=controller;
    const current=()=>request.current.sequence===seq,timeout=window.setTimeout(()=>controller.abort(),30000);setBusy(true);setSourceMessage('');setError('');
    try{
      const response=await fetch('/api/soccer/raw-seen-history-index',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'index',captureId:sourceId}),signal:controller.signal});
      const value=await response.json();
      if(!response.ok||value?.ok!==true)throw new Error(value?.code==='RAW_SEEN_RECOVERY_UNSUPPORTED_FORMAT'?'這批來源格式尚未支援辨識，原文仍保留；不能據此認定沒有盤口。':'這批來源未通過索引核對，原文仍保留；請查看原始保存狀態。');
      if(value.schema!=='soccer-raw-history-index-v1'||!readonly(value)||!Number.isSafeInteger(value.indexedGames)||value.indexedGames<1||value.indexedGames>40||!instant(value.indexedAt)||!digest(value.captureBatchId)||!digest(value.derivedHash))throw new Error('索引回條未通過核對，請重新查詢。');
      if(current()){setSourceMessage(`這批來源已核對 ${value.indexedGames} 場原盤對戰，請用對應盤日查詢。索引時間 ${time(value.indexedAt)}，來源時間維持原值。`);await load({...draft});}
    }catch(cause){if(current())setSourceMessage(cause.name==='AbortError'?'索引核對逾時；可用同一保存識別重試。':cause.message||'索引核對失敗。');}
    finally{window.clearTimeout(timeout);if(current())setBusy(false);}
  }
  return <section className={`panel ${styles.panel}`} aria-label="足球原始保存歷史查詢" aria-busy={busy}>
    <h2>英超／歐冠：依盤日查原始保存</h2>
    <p>已核對的原始盤面可依盤日與場次查閱，不論是否下注。每筆保留來源批次、原始時間與盤口文字。</p>
    <p className={styles.notice}>這是原文重播的查閱索引。官方場次身分、當時可分析資格、所有開盤及尾盤完整度尚未確認；索引時間不代表賽前已可使用。</p>
    <form className={styles.filters} onSubmit={event=>{event.preventDefault();const data=new FormData(event.currentTarget),filters=Object.fromEntries(['league','from','through','gameKey'].map(k=>[k,String(data.get(k)||'')]));setDraft(filters);load(filters);}}>
      <label>聯盟<select name="league" value={draft.league} onChange={e=>change('league',e.target.value)}><option value="UCL">歐冠 UCL</option><option value="EPL">英超 EPL</option></select></label>
      <label>起始盤日<input name="from" type="date" required value={draft.from} onChange={e=>change('from',e.target.value)}/></label>
      <label>結束盤日<input name="through" type="date" required value={draft.through} onChange={e=>change('through',e.target.value)}/></label>
      <label>場次識別（選填）<input name="gameKey" value={draft.gameKey} maxLength={200} onChange={e=>change('gameKey',e.target.value)}/></label>
      <button type="submit" className="secondary" disabled={busy}>{busy?'核對中…':'查詢原始歷史盤口'}</button>
    </form>
    {error&&<p role="alert" className={styles.error}>{error}</p>}
    {result&&<>
      <p role="status">已載入 {result.entries.length} 筆來源場次紀錄{result.hasMore?'，尚有下一頁。':'；本次索引查詢已列完。'} 全部來源是否已索引仍未確認。</p>
      {result.status==='NOT_INITIALIZED'?<p className={styles.notice}>歷史查閱索引尚未建立；原始保存仍可查看，不能當成沒有盤口。</p>:result.entries.length===0&&<p className={styles.notice}>這段盤日尚未查到已索引的場次；未辨識或未索引的來源不代表沒有開盤。</p>}
      <ol className={styles.games}>{result.entries.map(row=><li key={[row.boardDate,row.gameKey,row.captureBatchId].join('|')}>
        <h3>{row.boardDate} {row.boardTime}｜{row.awayRaw} → {row.homeRaw}</h3>
        <p>{row.marketCount} 個已辨識進球市場｜僅供查閱，無分析／投注操作</p>
        <p className={styles.meta}>來源讀取 {time(row.observedAt)}<br/>原始接收 {time(row.sourceReceivedAt)}｜原始存入 {time(row.sourcePersistedAt)}<br/>建立查閱索引 {time(row.indexedAt)}</p>
        <button type="button" className="secondary" disabled={busy} onClick={()=>{const filters={...result.filters,gameKey:row.gameKey,from:row.boardDate,through:row.boardDate};setDraft({...filters,gameKey:row.gameKey});load(filters);}}>只查這一場的來源紀錄</button>
        <RawSeenReplay capture={row.capture} gameFilter={{boardDate:row.boardDate,gameKey:row.gameKey}}/>
      </li>)}</ol>
      {result.hasMore&&<button type="button" className="secondary" disabled={busy} onClick={()=>load({...result.filters,after:result.nextAfter},true)}>載入下一頁（最多 50 筆）</button>}
    </>}
    <details className={styles.index}><summary>將已保存來源加入歷史查詢</summary>
      <p>從上方原始保存摘要複製「保存識別」。伺服器會重新核對已存入的完整來源；重複操作不增加同批紀錄。</p>
      <form className={styles.filters} onSubmit={indexSource}><label>原始保存識別<input value={sourceId} maxLength={64} onChange={e=>setSourceId(e.target.value.trim())}/></label><button type="submit" className="secondary" disabled={busy}>核對來源並建立查閱索引</button></form>
      {sourceMessage&&<p role="status">{sourceMessage}</p>}
    </details>
  </section>;
}
