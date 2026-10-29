'use client';
import { useEffect,useRef,useState } from 'react';

const VERSION='SOCCER-READER-INVENTORY-v1';
const PERIODS={FT:'全場',HT:'上半場',UNKNOWN:'期間待確認'};
const count=value=>Number.isSafeInteger(value)&&value>=0;
const date=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
const time=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(value)&&date(value.slice(0,10))&&/(?:Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value));
const clock=value=>time(value)?new Date(value).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false}):'未知';
const number=value=>count(value)?value.toLocaleString('zh-TW'):'未知';
const shift=(value,days)=>new Date(Date.parse(value)+days*86400000).toISOString().slice(0,10);
function requestScope(leagueValue,dateValue,throughValue){
  const league=typeof leagueValue==='string'?leagueValue.toLowerCase():'';
  const selected=dateValue==null||dateValue===''?new Date(Date.now()+8*3600000).toISOString().slice(0,10):dateValue;
  if(!['epl','ucl'].includes(league)||!date(selected)||throughValue!=null&&throughValue!==''&&!date(throughValue))return null;
  const from=shift(selected,-30),through=throughValue&&throughValue>selected?throughValue:selected;
  if(Date.parse(through)-Date.parse(from)>366*86400000)return null;
  return{league,from,through};
}
const keyCount=value=>typeof value.gameKeysComplete==='boolean'&&(value.gameKeysComplete?count(value.distinctBoardGameKeys):value.distinctBoardGameKeys===null);
const receiptTimes=value=>['lastObservedAt','lastReceivedAt','lastPersistedAt'].every(key=>time(value[key]));
function validCurrent(value){
  if(!value||!['AVAILABLE','NO_ACTIVE_HEAD','UNAVAILABLE'].includes(value.status)||!Array.isArray(value.periods)||!Array.isArray(value.periodCounts))return false;
  if(value.periods.length>3||new Set(value.periods).size!==value.periods.length||value.periods.some(period=>!Object.hasOwn(PERIODS,period)))return false;
  if(value.status==='NO_ACTIVE_HEAD')return value.gameCount===0&&value.marketCount===0&&value.periods.length===0&&value.periodCounts.length===0;
  if(value.status==='UNAVAILABLE')return value.gameCount===null&&value.marketCount===null&&value.periodCounts.length===0;
  if(!count(value.gameCount)||!count(value.marketCount)||value.periods.length>3||new Set(value.periods).size!==value.periods.length
    ||value.periods.some(period=>!Object.hasOwn(PERIODS,period))||value.periodCounts.length!==value.periods.length)return false;
  const seen=new Set();let markets=0,games=0;
  for(const row of value.periodCounts){
    if(!row||!value.periods.includes(row.period)||seen.has(row.period)||!count(row.gameCount)||!count(row.marketCount)
      ||row.gameCount>value.gameCount||row.gameCount===0&&row.marketCount!==0||!['observedAt','receivedAt','persistedAt'].every(key=>time(row[key])))return false;
    seen.add(row.period);markets+=row.marketCount;games+=row.gameCount;
  }
  return count(markets)&&count(games)&&markets===value.marketCount&&games>=value.gameCount;
}
function checkedLegacy(value,scope){
  if(!value||!['AVAILABLE','EMPTY','ABSENT','UNAVAILABLE'].includes(value.status)||!Array.isArray(value.days)||value.days.length>31
    ||typeof value.truncated!=='boolean'||value.historicalAvailabilityVerified!==false||value.formalEligible!==false||value.executable!==false)throw Error('舊版盤日清單的狀態或保存依據尚未通過核對。');
  if(value.status==='UNAVAILABLE'){
    if(value.snapshotCount!==null||value.boardDateCount!==null||value.lastObservedAt!==null||value.readAt!==null||value.days.length||value.truncated)throw Error('舊版盤日清單的未知狀態尚未通過核對。');
    return;
  }
  if(value.status==='ABSENT'||value.status==='EMPTY'){
    if(value.snapshotCount!==0||value.boardDateCount!==0||value.lastObservedAt!==null||value.days.length||value.truncated
      ||(value.status==='ABSENT'?value.readAt!==null:!time(value.readAt)))throw Error('舊版盤日空清單的統計尚未通過核對。');
    return;
  }
  if(!count(value.snapshotCount)||value.snapshotCount<1||!count(value.boardDateCount)||value.boardDateCount<1||value.boardDateCount>value.snapshotCount
    ||value.boardDateCount>Math.floor((Date.parse(scope.through)-Date.parse(scope.from))/86400000)+1||!time(value.lastObservedAt)||!time(value.readAt)
    ||value.days.length!==Math.min(31,value.boardDateCount)||value.truncated!==(value.boardDateCount>value.days.length))throw Error('舊版盤日清單的日期或筆數尚未通過核對。');
  const seen=new Set();let previous=null,total=0;
  for(const row of value.days){
    if(!row||!date(row.date)||row.date<scope.from||row.date>scope.through||seen.has(row.date)||previous!==null&&row.date>=previous
      ||!count(row.snapshotCount)||row.snapshotCount<1||!time(row.lastObservedAt)||Date.parse(row.lastObservedAt)>Date.parse(value.lastObservedAt)
      ||row.receiptStatus!=='LEGACY_ACQUISITION_UNKNOWN')throw Error('舊版盤日的日期或未確認接收狀態尚未通過核對。');
    seen.add(row.date);previous=row.date;total+=row.snapshotCount;
  }
  if(!count(total)||total>value.snapshotCount||!value.truncated&&total!==value.snapshotCount)throw Error('舊版盤日的累計筆數尚未通過核對。');
}
function checkedInventory(value,scope){
  const summary=value?.summary,rows=value?.days;
  if(value?.ok!==true||value.version!==VERSION||value.league!==scope.league||value.scope?.from!==scope.from||value.scope?.through!==scope.through
    ||!time(value.scope.readAt)||value.scope.dateLimit!==31||value.formalEligible!==false||value.executable!==false
    ||value.gameKeyDefinition!=='BOARD_DATE_TIME_AWAY_HOME_SOURCE_KEYS_NOT_OFFICIAL_GAME_IDENTITIES'
    ||value.observationDefinition!=='IMMUTABLE_V2_READER_RECEIPTS_HEARTBEATS_INCLUDED'
    ||typeof value.truncated!=='boolean'||!summary||!count(summary.observationCount)||!count(summary.boardDateCount)||!keyCount(summary)
    ||summary.boardDateCount>Math.floor((Date.parse(scope.through)-Date.parse(scope.from))/86400000)+1
    ||!Array.isArray(rows)||rows.length>31||rows.length!==Math.min(31,summary.boardDateCount)
    ||value.truncated!==(summary.boardDateCount>rows.length))throw Error('已保存原盤清單的聯盟、日期範圍或統計尚未通過核對。');
  checkedLegacy(value.legacy,scope);
  if(summary.boardDateCount===0){
    if(summary.observationCount!==0||summary.distinctBoardGameKeys!==0||summary.gameKeysComplete!==true
      ||['firstBoardDate','lastBoardDate','lastObservedAt','lastReceivedAt','lastPersistedAt'].some(key=>summary[key]!==null))throw Error('已保存原盤空清單的統計尚未通過核對。');
    return value;
  }
  if(summary.observationCount<summary.boardDateCount||!date(summary.firstBoardDate)||!date(summary.lastBoardDate)
    ||summary.firstBoardDate<scope.from||summary.lastBoardDate>scope.through||summary.firstBoardDate>summary.lastBoardDate||!receiptTimes(summary))throw Error('已保存原盤清單的日期或收據尚未通過核對。');
  const seen=new Set();let observations=0,keys=0,previous=null;
  for(const row of rows){
    if(!row||!date(row.date)||row.date<scope.from||row.date>scope.through||seen.has(row.date)||previous!==null&&row.date>=previous
      ||!count(row.observationCount)||row.observationCount<1||!keyCount(row)||!receiptTimes(row)||!validCurrent(row.current))throw Error('已保存原盤清單的盤日、保存場次或期間尚未通過核對。');
    if(summary.gameKeysComplete&&(!row.gameKeysComplete||row.distinctBoardGameKeys>summary.distinctBoardGameKeys))throw Error('已保存原盤保存場次統計尚未通過核對。');
    if(['lastObservedAt','lastReceivedAt','lastPersistedAt'].some(key=>Date.parse(row[key])>Date.parse(summary[key])))throw Error('已保存原盤收據累計尚未通過核對。');
    seen.add(row.date);previous=row.date;observations+=row.observationCount;if(row.gameKeysComplete)keys+=row.distinctBoardGameKeys;
  }
  if(!count(observations)||!count(keys)||rows[0].date!==summary.lastBoardDate||rows.at(-1).date<summary.firstBoardDate||observations>summary.observationCount
    ||summary.gameKeysComplete&&keys>summary.distinctBoardGameKeys
    ||!value.truncated&&(rows.at(-1).date!==summary.firstBoardDate||observations!==summary.observationCount
      ||summary.gameKeysComplete&&keys!==summary.distinctBoardGameKeys))throw Error('已保存原盤清單的累計統計尚未通過核對。');
  return value;
}

export function SoccerReaderInventoryPanel({league,date:boardDate,throughDate,onSelectDate,active=true}){
  const scope=requestScope(league,boardDate,throughDate),key=scope?`${scope.league}|${scope.from}|${scope.through}`:'INVALID';
  const [state,setState]=useState({key:null,status:'idle',data:null,error:''});
  const mounted=useRef(false),generation=useRef(0),flight=useRef(null),currentScope=useRef(key),selection=useRef(null);currentScope.current=key;
  const current=state.key===key,data=current&&state.status==='ready'?state.data:null;
  selection.current=data?{key,days:[...data.days,...(data.legacy.status==='AVAILABLE'?data.legacy.days:[])]}:null;
  async function load(){
    if(!active||!scope||!mounted.current||currentScope.current!==key)return;
    if(flight.current)return flight.current.promise;
    const token=++generation.current,controller=new AbortController(),timer=setTimeout(()=>controller.abort(),25000);
    selection.current=null;setState({key,status:'loading',data:null,error:''});
    const request={token,controller,timer,promise:null};flight.current=request;
    const promise=(async()=>{
      try{
        const response=await fetch(`/api/soccer/reader-inventory?${new URLSearchParams(scope)}`,{cache:'no-store',credentials:'same-origin',signal:controller.signal});
        const body=await response.json();
        if(!mounted.current||currentScope.current!==key||token!==generation.current)return;
        if(!response.ok||body?.ok!==true)throw Error(response.status===401?'登入已過期，請重新登入網站。':'已保存原盤清單暫時無法讀取，盤日與筆數仍待核對。');
        const value=checkedInventory(body,scope);setState({key,status:'ready',data:value,error:''});
      }catch(error){
        if(mounted.current&&currentScope.current===key&&token===generation.current){selection.current=null;setState({key,status:'failed',data:null,error:error.name==='AbortError'?'已保存原盤清單讀取逾時，盤日與筆數仍待核對。':error.message||'已保存原盤清單暫時無法讀取。'});}
      }finally{clearTimeout(timer);if(flight.current?.token===token)flight.current=null;}
    })();request.promise=promise;return promise;
  }
  useEffect(()=>{
    mounted.current=true;if(active&&scope)void load();
    return()=>{mounted.current=false;selection.current=null;generation.current++;if(flight.current){clearTimeout(flight.current.timer);flight.current.controller.abort();flight.current=null;}};
  },[active,key]);
  function selectDate(value){
    const latest=selection.current;
    if(!active||flight.current||currentScope.current!==key||latest?.key!==key||!latest.days.some(row=>row.date===value)||typeof onSelectDate!=='function')return;
    onSelectDate(value);
  }
  if(!active)return null;
  const busy=scope&&(!current||['idle','loading'].includes(state.status));
  const legacy=data?.legacy,lastDate=data?[data.summary.lastBoardDate,...(legacy.status==='AVAILABLE'?[legacy.days[0].date]:[])].filter(value=>date(value)).sort().at(-1):null;
  return <details className="soccerDetails soccerReaderInventory"><summary>已保存原盤{data?`｜收據 ${number(data.summary.boardDateCount)} 盤日${legacy.status==='AVAILABLE'?`｜舊版 ${number(legacy.boardDateCount)} 盤日`:legacy.status==='UNAVAILABLE'?'｜舊版待核對':''}${lastDate?`｜最近 ${lastDate}`:''}`:busy?'｜讀取中':'｜盤日數量待核對'}</summary>
    {scope?<p className="soccerAvailability">查詢範圍：{scope.from} ～ {scope.through}。</p>:<p className="soccerAnalysisWarning" role="alert">原盤清單的聯盟或日期範圍尚未通過核對。</p>}
    {scope&&<button type="button" className="secondary" disabled={busy} onClick={()=>load()}>重新核對清單</button>}
    {busy&&<p role="status">正在讀取本聯盟已保存的盤日與收據…</p>}
    {current&&state.error&&<p className="soccerAnalysisWarning" role="alert">{state.error}</p>}
    {data&&<>
      <p className="soccerAvailability">已保存 {number(data.summary.observationCount)} 筆來源收據｜保存場次 {number(data.summary.distinctBoardGameKeys)} 筆｜最後接收：{clock(data.summary.lastReceivedAt)}。</p>
      <p className="soccerAvailability">這是歷史保存清單。保存場次依原始日期、時間及隊名去重，尚未全數核對官方賽程。目前保存版本的盤數不代表尾盤完整，也不代表仍有效或已有 S 評分；原盤數包含來源各種盤別，不等於八方向評分筆數。</p>
      {!data.summary.gameKeysComplete&&<p className="soccerAvailability">保存場次尚未完整核對，數量顯示未知。</p>}
      {data.truncated&&<p className="soccerAnalysisWarning" role="status">本範圍超過 31 個盤日，先列最近 31 盤日；上方累計含完整查詢範圍。可選其他日期再查詢。</p>}
      {data.days.length?<ul>{data.days.map(row=><li key={row.date}>
        <button type="button" className="secondary" disabled={typeof onSelectDate!=='function'} onClick={()=>selectDate(row.date)}>查看 {row.date} 當日賽程</button>
        <p>保存場次 {number(row.distinctBoardGameKeys)} 筆｜來源收據 {number(row.observationCount)} 筆。</p>
        {row.current.status==='AVAILABLE'?<p className="soccerAvailability">目前保存版本：保存場次 {number(row.current.gameCount)} 筆、{number(row.current.marketCount)} 個原盤。{row.current.periodCounts.map(period=>`${PERIODS[period.period]} ${number(period.marketCount)} 個原盤`).join('｜')}</p>:<p className="soccerAvailability">目前保存版本：{row.current.status==='NO_ACTIVE_HEAD'?'已確認沒有目前期間版本（0 個原盤）；歷史收據仍保存。':'尚未完成核對，盤數未知。'}</p>}
        <p className="soccerAvailability">最後接收：{clock(row.lastReceivedAt)}｜最後封存：{clock(row.lastPersistedAt)}。</p>
      </li>)}</ul>:<p className="soccerAvailability">此查詢範圍尚未找到有接收收據的盤日；舊版保存另列於下方。其他日期是否有保存仍需另查。</p>}
      <section aria-label="舊版盤日（接收時間未確認）"><h4>舊版盤日（接收時間未確認）</h4>
        {legacy.status==='AVAILABLE'?<>
          <p className="soccerAvailability">舊版保存 {number(legacy.snapshotCount)} 筆、{number(legacy.boardDateCount)} 盤日。這是日期索引，原盤內容尚未重新核對；接收時間與歷史可得性未確認，不計入上方來源收據、保存場次或評分。</p>
          {legacy.truncated&&<p className="soccerAnalysisWarning" role="status">舊版超過 31 個盤日，先列最近 31 盤日；舊版累計含完整查詢範圍。</p>}
          <ul>{legacy.days.map(row=><li key={row.date}><button type="button" className="secondary" disabled={typeof onSelectDate!=='function'} onClick={()=>selectDate(row.date)}>切換至 {row.date} 當日賽程</button><p className="soccerAvailability">舊版保存 {number(row.snapshotCount)} 筆｜來源回報時間（未核對）：{clock(row.lastObservedAt)}。</p></li>)}</ul>
        </>:<p className="soccerAvailability">{legacy.status==='ABSENT'?'目前沒有可讀取的舊版保存來源；這不代表其他保存來源沒有資料。':legacy.status==='EMPTY'?'此查詢範圍尚未找到舊版盤日。':'舊版盤日讀取失敗，保存筆數與日期未知，不能判定沒有保存。'}</p>}
      </section>
    </>}
  </details>;
}
