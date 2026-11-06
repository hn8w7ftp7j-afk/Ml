'use client';
import { useEffect, useRef, useState } from 'react';

const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
const token=value=>typeof value==='string'&&/^[a-f0-9]{48}$/.test(value);
const count=value=>Number.isSafeInteger(value)&&value>=0;
function savedSnapshots(key){const raw=localStorage.getItem(key);if(!raw)return {items:[],selected:0};const data=JSON.parse(raw);if(!data||!Array.isArray(data.items)||data.items.length>1000||!count(data.selected)||data.items.length&&data.selected>=data.items.length||data.items.some(item=>!token(item.cursor)||!Number.isFinite(item.createdAt)))throw Error('INVALID_STORAGE');return data;}
const reasons={READER_MANIFEST_ROW_BUDGET:'收據筆數超過單次清點上限，清點未完成。',READER_MANIFEST_SCOPE_BUDGET:'此聯盟及盤日的清點次數已達上限。',READER_RECEIPT_BYTE_BUDGET:'單筆收據超過讀取容量，清點未完成。',READER_ORIGINAL_RECEIPT_MISSING:'清單中的原始收據缺失，清點未完成。',READER_MANIFEST_ITEM_MISSING:'清單項目缺失，清點未完成。',READER_MANIFEST_ITEM_MISMATCH:'清單項目核對不一致，清點未完成。',READER_RECEIPT_INVALID_OR_CLOCK_CONFLICT:'收據內容或時間核對不一致，清點未完成。',READER_PAGE_UNAVAILABLE:'本批收據暫時無法讀取。',READER_SOURCE_READ_UNAVAILABLE:'原始收據暫時無法讀取。'};
const statusLabel=status=>status==='RUNNING'?'進行中':status==='COMPLETE'?'已完成':'未完成';
function checkedPublic(report,scope,scanId){
  if(!report||Object.hasOwn(report,'cursor')||!/^[a-f0-9]{64}$/.test(report.scanId)||scanId&&report.scanId!==scanId
    ||typeof report.startedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(report.startedAt)||!Number.isFinite(Date.parse(report.startedAt)))throw Error('INVALID_REPORT');
  // Existing validator also checks scope, counts, eligibility and reason codes.
  const checkedReport=checked({ok:true,report:{...report,cursor:'public-scan'}},scope,'public-scan');
  return {...checkedReport,scanId:report.scanId,startedAt:report.startedAt};
}
function checked(body,scope,cursor){
  const r=body?.report,scopeBudget=r?.status==='PARTIAL'&&r?.cursor===null&&r?.totalCount===null&&r?.observedCount===null&&r?.reasonCodes?.length===1&&r.reasonCodes[0]==='READER_MANIFEST_SCOPE_BUDGET';
  if(body?.ok!==true||r?.version!=='SOCCER-READER-INVENTORY-SCAN-v1'||r.league!==scope.league||r.date!==scope.date
    ||!['RUNNING','COMPLETE','PARTIAL'].includes(r.status)||(!scopeBudget&&r.cursor!==cursor)
    ||!(r.totalCount===null||count(r.totalCount))||!count(r.verifiedCount)||!(r.observedCount===null||count(r.observedCount))
    ||r.totalCount!==null&&r.verifiedCount>r.totalCount||r.status==='COMPLETE'&&(r.totalCount===null||r.verifiedCount!==r.totalCount)
    ||!Array.isArray(r.reasonCodes)||r.reasonCodes.some(code=>!Object.hasOwn(reasons,code))
    ||r.formalEligible!==false||r.identityVerified!==false||r.selectedPairCount!==null)throw Error('INVALID_REPORT');
  return {status:r.status,totalCount:r.totalCount,verifiedCount:r.verifiedCount,reasonCodes:r.reasonCodes};
}
export function SoccerReaderInventoryScanPanel({league,date}){
  const normalized=typeof league==='string'?league.toLowerCase():'';
  const scope=['epl','ucl'].includes(normalized)&&validDate(date)?{league:normalized,date}:null;
  const key=scope?`soccer-reader-inventory-scan-v1:${scope.league}:${scope.date}`:null;
  const current=useRef(key);current.current=key;
  const flight=useRef(null),generation=useRef(0),mounted=useRef(false);
  const [state,setState]=useState({key:null,status:'idle',items:[],selected:0,report:null,error:''});
  const [remote,setRemote]=useState({key:null,status:'idle',reports:[],error:'',selected:null});
  useEffect(()=>{
    mounted.current=true;let saved={items:[],selected:0},error='';
    try{if(key)saved=savedSnapshots(key);}catch{error='此瀏覽器的續讀資料無法讀取，請檢查瀏覽器儲存。';}
    setState({key,status:'idle',...saved,report:null,error});
    setRemote({key,status:'idle',reports:[],error:'',selected:null});
    return()=>{mounted.current=false;generation.current++;if(flight.current){flight.current.abort();flight.current=null;}};
  },[key]);
  async function run(forceNew=false){
    if(!scope||!mounted.current||current.current!==key||flight.current)return;
    let cursor,saved;
    try{
      saved=savedSnapshots(key);
      if(forceNew||!saved.items.length){
        if(saved.items.length>=1000)throw Error('STORAGE_LIMIT');
        const bytes=new Uint8Array(24);crypto.getRandomValues(bytes);
        cursor=Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');
        saved.items.push({cursor,createdAt:Date.now()});saved.selected=saved.items.length-1;
        const record=JSON.stringify(saved);localStorage.setItem(key,record);
        if(localStorage.getItem(key)!==record)throw Error('STORAGE_UNAVAILABLE');
      }else cursor=saved.items[saved.selected].cursor;
    }catch(error){setState(old=>({...old,key,status:'failed',error:error.message==='STORAGE_LIMIT'?'本瀏覽器保存的清單已達上限。':'此瀏覽器無法安全保存續讀資料，請允許瀏覽器儲存後重試。'}));return;}
    const action=!forceNew&&state.key===key&&state.report?.status==='RUNNING'?'continue':'start';
    const controller=new AbortController(),sequence=++generation.current;flight.current=controller;
    setState(old=>({key,status:'loading',...saved,report:!forceNew&&old.key===key?old.report:null,error:''}));
    try{
      let operation=action;
      // Bound each user action, while allowing the server to enforce its own
      // per-page row and byte limits. Reloading can resume the same manifest.
      for(let page=0;page<12;page++){
        const response=await fetch('/api/soccer/reader-inventory-scan',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:operation,...scope,cursor}),signal:controller.signal});
        const body=await response.json();
        if(!mounted.current||current.current!==key||sequence!==generation.current)return;
        if(!response.ok)throw Error(response.status===401?'AUTH':'FAILED');
        const report=checked(body,scope,cursor);
        const more=report.status==='RUNNING'&&page<11;
        setState({key,status:more?'loading':'ready',...saved,report,error:''});
        if(!more)break;
        operation='continue';
      }
    }catch(error){if(mounted.current&&current.current===key&&sequence===generation.current)setState(old=>({key,status:'failed',...saved,report:old.key===key?old.report:null,error:error.message==='AUTH'?'登入已過期，請重新登入網站。':'清點暫時無法完成；可重試並恢復相同清單。'}));}
    finally{if(flight.current===controller)flight.current=null;}
  }
  async function listSaved(){
    if(!scope||!mounted.current||current.current!==key||flight.current)return;
    const controller=new AbortController(),sequence=++generation.current;flight.current=controller;
    setRemote({key,status:'loading',reports:[],error:'',selected:null});
    try{
      const response=await fetch('/api/soccer/reader-inventory-scan',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'list',...scope}),signal:controller.signal});
      const body=await response.json();if(!mounted.current||current.current!==key||sequence!==generation.current)return;
      if(!response.ok||body?.ok!==true||!Array.isArray(body.reports)||body.reports.length>1000||typeof body.complete!=='boolean'||!Array.isArray(body.reasonCodes)||body.reasonCodes.some(code=>code!=='READER_MANIFEST_LIST_TRUNCATED')||body.complete!==!body.reasonCodes.includes('READER_MANIFEST_LIST_TRUNCATED'))throw Error('FAILED');
      const reports=body.reports.map(report=>checkedPublic(report,scope));
      if(new Set(reports.map(report=>report.scanId)).size!==reports.length)throw Error('FAILED');
      setRemote({key,status:'ready',reports,complete:body.complete,error:'',selected:null});
    }catch{if(mounted.current&&current.current===key&&sequence===generation.current)setRemote({key,status:'failed',reports:[],error:'已保存清單暫時無法查詢，數量未知，請稍後重試。',selected:null});}
    finally{if(flight.current===controller)flight.current=null;}
  }
  async function resumeSaved(index){
    if(!scope||!mounted.current||current.current!==key||flight.current||remote.key!==key||remote.status!=='ready'||!count(index)||index>=remote.reports.length)return;
    const selected=remote.reports[index],controller=new AbortController(),sequence=++generation.current;flight.current=controller;
    setRemote(old=>({...old,status:'loading',selected:index,error:''}));
    try{
      for(let page=0;page<12;page++){
        const response=await fetch('/api/soccer/reader-inventory-scan',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'resume',...scope,scanId:selected.scanId}),signal:controller.signal});
        const body=await response.json();if(!mounted.current||current.current!==key||sequence!==generation.current)return;
        if(!response.ok||body?.ok!==true)throw Error('FAILED');
        const report=checkedPublic(body.report,scope,selected.scanId),more=report.status==='RUNNING'&&page<11;
        setRemote(old=>({...old,status:more?'loading':'ready',reports:old.reports.map((item,i)=>i===index?report:item),selected:index,error:''}));
        if(!more)break;
      }
    }catch{if(mounted.current&&current.current===key&&sequence===generation.current)setRemote(old=>({...old,status:'ready',error:'這份清單暫時無法恢復，請重新查詢已保存清單後再試。'}));}
    finally{if(flight.current===controller)flight.current=null;}
  }
  if(!scope)return null;
  const active=state.key===key?state:{status:'idle',items:[],selected:0,report:null,error:''},report=active.report;
  const saved=remote.key===key?remote:{status:'idle',reports:[],error:'',selected:null};
  function selectSnapshot(event){try{const saved=savedSnapshots(key),selected=Number(event.target.value);if(!count(selected)||selected>=saved.items.length)return;saved.selected=selected;const record=JSON.stringify(saved);localStorage.setItem(key,record);if(localStorage.getItem(key)!==record)throw Error('STORAGE');setState({key,status:'idle',...saved,report:null,error:''});}catch{setState(old=>({...old,error:'無法保存所選清單，請檢查瀏覽器儲存。'}));}}
  return <section aria-label="當日收據清點"><h4>當日收據清點｜{scope.date}</h4>
    <p className="soccerAvailability">清點範圍是建立清單當下已提交的收據；之後新增的收據不會加入這份舊清單。這不是賽事配對、收益驗證或正式評分。</p>
    {active.items.length>0&&<label>已保存的清點時點（顯示本機發起時間） <select value={active.selected} onChange={selectSnapshot} disabled={active.status==='loading'}>{active.items.map((item,index)=><option key={index} value={index}>{index+1}｜{new Date(item.createdAt).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false})}</option>)}</select></label>}
    <button type="button" className="secondary" disabled={active.status==='loading'||saved.status==='loading'||report?.status==='COMPLETE'||report?.status==='PARTIAL'} onClick={()=>run()}>{active.status==='loading'?'清點中…':report?.status==='RUNNING'?'繼續清點':active.items.length?'恢復清點':'開始清點'}</button>
    {active.items.length>0&&<button type="button" className="secondary" disabled={active.status==='loading'||saved.status==='loading'} onClick={()=>run(true)}>建立新時點</button>}
    <button type="button" className="secondary" disabled={active.status==='loading'||saved.status==='loading'} onClick={listSaved}>查詢已保存清單</button>
    {saved.status==='loading'&&<p role="status">正在查詢或續讀已保存清單…</p>}
    {saved.error&&<p role="alert" className="soccerAnalysisWarning">{saved.error}</p>}
    {(saved.status==='ready'||saved.status==='loading'&&saved.reports.length>0)&&<div><p>資料庫中可查詢的清單。時間為清單記錄時間，不代表資料截止時間或賽事時間。</p>
      {saved.complete===false&&<p>清單超過 1000 份，僅列出最近的 1000 份，較早清單未列出。</p>}
      {saved.reports.length===0?<p>此聯盟及盤日目前沒有可查詢的清單。</p>:<ul>{saved.reports.map((entry,index)=><li key={index}>
        <p>{new Date(entry.startedAt).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false})}｜{statusLabel(entry.status)}｜已核對 {entry.verifiedCount} 筆｜總數 {entry.totalCount===null?'未知':`${entry.totalCount} 筆`}</p>
        <button type="button" className="secondary" disabled={active.status==='loading'||saved.status==='loading'} onClick={()=>resumeSaved(index)}>{entry.status==='RUNNING'?'繼續這份清單':'查看這份清單'}</button>
        {saved.selected===index&&entry.status==='COMPLETE'&&entry.totalCount===0&&<p>此時點沒有可見的已提交收據，不代表其他時點沒有資料。</p>}
        {saved.selected===index&&entry.reasonCodes.map(reason=><p key={reason}>{reasons[reason]}</p>)}
      </li>)}</ul>}
    </div>}
    {active.status==='loading'&&<p role="status">正在核對收據，請稍候。</p>}
    {active.error&&<p className="soccerAnalysisWarning" role="alert">{active.error}</p>}
    {report&&<div role="status"><p>{report.status==='RUNNING'?'清點進行中':report.status==='COMPLETE'?'清點完成':'清點未完成'}｜已核對 {report.verifiedCount} 筆｜清單總數 {report.totalCount===null?'未知':`${report.totalCount} 筆`}。</p>
      {report.status==='COMPLETE'&&report.totalCount===0&&<p>建立清單時，此聯盟及盤日沒有可見的已提交收據；不代表其他日期或之後沒有資料。</p>}
      {report.reasonCodes.map(reason=><p key={reason}>{reasons[reason]}</p>)}
    </div>}
  </section>;
}
