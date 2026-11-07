'use client';
import { createContext,useContext,useEffect,useRef,useState } from 'react';
import { soccerRecordKey,soccerRecordStats } from '../../lib/soccer/manual-record.js';
import { soccerMarketName } from '../../lib/soccer/ranking.js';
import { summarizeSoccerHighScoreBets } from '../../lib/soccer/league-bet-status.js';
import { soccerReaderIdentityVerified } from '../../lib/soccer/reader-identity-proof.js';
const Ledger=createContext(null);
const SETTLEMENT_CHECK_KEY='__settlement_check__';
const providerScopedRecord=record=>record?.sourceIdentityStatus==='PROVIDER_SCOPED_UNIQUE_MATCH'
  &&record.sourceIdentityEvidence?.version==='SOCCER-PROVIDER-SCOPED-IDENTITY-v1'
  &&/^[a-f0-9]{64}$/.test(record.sourceIdentityEvidence?.contentHash||'');
async function request(url,options={}){
  const r=await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(20000),...options}),d=await r.json();
  if(!r.ok||!d.ok)throw Error(r.status===401?'登入已過期，請重新登入。':d.error||'帳本暫時無法同步。');return d;
}
export function SoccerRecordProvider({league,date,through=date,children,summaryDate=date,candidates=[],analysisReady=true,onHighScoreStatusChange}){
  const [records,setRecords]=useState([]),[status,setStatus]=useState('loading'),[error,setError]=useState(''),[pending,setPending]=useState(new Set());
  const [loadedScope,setLoadedScope]=useState('');
  const [settlementPolicy,setSettlementPolicy]=useState(null),[settlementSummary,setSettlementSummary]=useState(null),[settlementError,setSettlementError]=useState('');
  const generation=useRef(0),flights=useRef(new Set());
  const scope=`${league}|${date}|${through}`,ledgerStatus=loadedScope===scope?status:'loading';
  async function load(){if(flights.current.size)return;const token=++generation.current;setStatus('loading');setError('');try{const d=await request(`/api/soccer/bet-records?${new URLSearchParams({league,date,through})}`);if(token!==generation.current)return;if(d.league!==league||d.date!==date||d.through!==through||!Array.isArray(d.records)||d.records.some(r=>r.league!==league||r.date<date||r.date>through))throw Error('帳本識別不符。');setRecords(d.records);setSettlementPolicy(d.settlementPolicy||null);setLoadedScope(scope);setStatus('ready');}catch(e){if(token===generation.current){setLoadedScope(scope);setStatus('failed');setError(e.message);}}}
  useEffect(()=>{flights.current.clear();setPending(new Set());setRecords([]);setSettlementPolicy(null);setSettlementSummary(null);setSettlementError('');setLoadedScope('');void load();return()=>{generation.current++;};},[league,date,through]);
  const summary=onHighScoreStatusChange?summarizeSoccerHighScoreBets(candidates,{records,league,date:summaryDate,ledgerReady:ledgerStatus==='ready',analysisReady}):null;
  const callback=useRef(onHighScoreStatusChange);callback.current=onHighScoreStatusChange;
  const published=useRef('');
  useEffect(()=>{if(!callback.current||!summary)return;const signature=JSON.stringify(summary);if(published.current===signature)return;published.current=signature;callback.current(summary);},[league,summaryDate,summary?.state,summary?.label,summary?.total,summary?.recorded,summary?.unbet]);
  async function mutate(body,key){
    if(ledgerStatus!=='ready'||flights.current.has(key)||flights.current.has(SETTLEMENT_CHECK_KEY))return;const token=generation.current;flights.current.add(key);setPending(new Set(flights.current));setError('');
    try{const d=await request('/api/soccer/bet-records',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,league,date:body.date||date})});if(token!==generation.current)return;
      if(d.persistence!=='durable_database'||!d.record?.id||d.record.league!==league||d.record.date<date||d.record.date>through)throw Error('未取得永久保存確認。');
      setRecords(old=>[{...old.find(r=>r.id===d.record.id),...d.record},...old.filter(r=>soccerRecordKey(r)!==soccerRecordKey(d.record))]);
    }catch(e){if(token===generation.current)setError(e.message);}finally{if(token===generation.current){flights.current.delete(key);setPending(new Set(flights.current));}}
  }
  async function checkSettlement(){
    if(ledgerStatus!=='ready'||flights.current.size)return;
    const token=generation.current;flights.current.add(SETTLEMENT_CHECK_KEY);setPending(new Set(flights.current));setError('');setSettlementError('');setSettlementSummary(null);
    try{const d=await request('/api/soccer/bet-records',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'check-settlement',league,date})});
      if(token!==generation.current)return;
      if(d.league!==league||d.date!==date||!d.summary||!['checked','resultVerified','settled','pending','deferred'].every(k=>Number.isSafeInteger(d.summary[k])&&d.summary[k]>=0))throw Error('賽果核對回應不完整。');
      setSettlementSummary(d.summary);
    }catch(e){if(token===generation.current)setSettlementError(['AbortError','TimeoutError'].includes(e.name)?'結算核對逾時，結果尚未確認。':e.message||'結算核對未完成。');}
    finally{if(token===generation.current){flights.current.delete(SETTLEMENT_CHECK_KEY);setPending(new Set(flights.current));}}
    if(token===generation.current)await load();
  }
  const scopeMatches=loadedScope===scope,ledgerError=scopeMatches?error:'',checkError=scopeMatches?settlementError:'';
  return <Ledger.Provider value={{league,date,records:scopeMatches?records:[],status:ledgerStatus,error:[ledgerError,checkError].filter(Boolean).join('；'),pending,load,mutate,checkSettlement,settlementPolicy,settlementSummary:scopeMatches?settlementSummary:null}}>{ledgerError&&<p className="errorBox" role="alert">{ledgerError}<button className="mini secondary" onClick={load}>重新同步</button></p>}{checkError&&<p className="errorBox" role="alert">{checkError}<button className="mini secondary" disabled={ledgerStatus!=='ready'||pending.size>0} onClick={checkSettlement}>重新核對結算</button></p>}{children}</Ledger.Provider>;
}
export function SoccerRecordButton({game,result,quote,provisional=false}){
  const ledger=useContext(Ledger);if(!ledger||!game||!quote||!result?.persisted||!result.revision||!['FT','HT'].includes(quote.period)||quote.unit!=='GOALS'||!Number.isFinite(quote.water))return null;
  provisional=provisional||!soccerReaderIdentityVerified(result);
  const key=soccerRecordKey({league:game.league,date:game.date,gameId:game.id,...quote});
  const record=ledger.records.find(r=>soccerRecordKey(r)===key),cancelled=record?.status==='CANCELLED',busy=ledger.pending.has(key);
  return <div className="soccerRecordAction">{record&&<strong>{cancelled?'已取消紀錄':'已下注 ✓'}</strong>}<button className="mini secondary" disabled={ledger.status!=='ready'||busy} title={provisional?'僅記錄你自行核對且已完成的下注；場次身分未驗證，結算待核對，不會送單':'僅記錄你已自行完成的下注；每筆 10,000 元，不會送單'} onClick={()=>ledger.mutate(record?{action:cancelled?'restore':'cancel',id:record.id,date:record.date}:{action:'record',alreadyPlaced:true,...(provisional?{identityUnverifiedAcknowledged:true}:{}),date:game.date,gameId:game.id,revision:result.revision,quoteKey:quote.key},key)}>{busy?'儲存中…':ledger.status!=='ready'?'帳本待同步':cancelled?'重新紀錄下注':record?'取消下注':provisional?'自行核對後記錄已下注':'紀錄實際下注'}</button>{record&&<small>原盤 {record.line}｜水位 {record.water}｜{record.stake.toLocaleString('zh-TW')} 元</small>}</div>;
}
function AccountSettlementConfirm({record,ledger}){
  const [amount,setAmount]=useState(''),[confirmed,setConfirmed]=useState(false),[finalAmount,setFinalAmount]=useState(false);
  const key=soccerRecordKey(record),busy=ledger.pending.has(key);
  return <details className="soccerDetails"><summary>自行確認帳戶結算</summary>
    <p>請先核對帳戶中這筆注單的實際淨損益，金額必須包含退水；退水尚未結算時請先不要確認。這是自行申報，不代表系統已驗證場次或派彩規則。</p>
    <label>帳戶淨損益（元，含退水；虧損請輸入負數）<input type="number" step="0.01" value={amount} onChange={e=>{setAmount(e.target.value);setConfirmed(false);setFinalAmount(false);}}/></label>
    <label><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>我已核對這筆注單及含退水的實際淨損益</label>
    <label><input type="checkbox" checked={finalAmount} onChange={e=>setFinalAmount(e.target.checked)}/>我再次確認金額；送出後如有錯誤須另留修正紀錄，取消或重新紀錄不會清除結算</label>
    <button className="mini secondary" disabled={ledger.status!=='ready'||busy||!confirmed||!finalAmount||!amount} onClick={()=>ledger.mutate({action:'confirm-account-settlement',id:record.id,date:record.date,netProfit:amount,rebateTreatment:'INCLUDED',confirmedAccountSettlement:true,confirmedFinalAmount:true},key)}>確認帳戶結算</button>
  </details>;
}
function AccountSettlementAmend({record,ledger}){
  const [changeType,setChangeType]=useState('CORRECT'),[amount,setAmount]=useState(''),[reason,setReason]=useState(''),[confirmed,setConfirmed]=useState(false);
  const key=soccerRecordKey(record),history=record.accountSettlement;
  const reset=()=>setConfirmed(false);
  return <details className="soccerDetails"><summary>修正或撤銷自行申報</summary>
    <p>原始申報不會更改；每次修正或撤銷都會保留時間與原因。修正金額必須是帳戶已結算、含退水的實際淨損益。</p>
    <label>操作<select value={changeType} onChange={e=>{setChangeType(e.target.value);reset();}}><option value="CORRECT">修正或恢復金額</option><option value="REVOKE">撤銷申報</option></select></label>
    {changeType==='CORRECT'&&<label>帳戶淨損益（元，含退水）<input type="number" step="0.01" value={amount} onChange={e=>{setAmount(e.target.value);reset();}}/></label>}
    <label>原因<input value={reason} maxLength={200} onChange={e=>{setReason(e.target.value);reset();}}/></label>
    <label><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>我已核對這筆注單、操作及{changeType==='CORRECT'?'含退水金額':'撤銷原因'}</label>
    <button className="mini secondary" disabled={ledger.status!=='ready'||ledger.pending.has(key)||!confirmed||!reason.trim()||(changeType==='CORRECT'&&!amount)} onClick={()=>ledger.mutate({action:'amend-account-settlement',id:record.id,date:record.date,revision:history.revision,changeType,netProfit:amount,reason,confirmedAccountSettlement:true,confirmedFinalAmount:true},key)}>確認{changeType==='CORRECT'?'修正':'撤銷'}</button>
  </details>;
}
export function SoccerBetRecords(){
  const l=useContext(Ledger);if(!l)return null;const s=soccerRecordStats(l.records);
  const outcomes={FULL_WIN:'全贏',PARTIAL_WIN:'部分贏',PUSH:'走盤',PARTIAL_LOSS:'部分輸',FULL_LOSS:'全輸'};
  const checkReasons={SOCCER_SOURCE_CONTRACT_UNVERIFIED:'賽果已確認，系統尚未完成原盤適用規則的證據與登錄',RESULT_NOT_STARTED:'尚未開賽',RESULT_NORMAL_FINAL_UNCONFIRMED:'尚未核對正常完賽',RESULT_PERIOD_SCORE_UNVERIFIED:'本筆期間的比分尚未核對',RESULT_ORIGINAL_TEAM_IDENTITIES_UNVERIFIED:'原紀錄的隊伍識別尚未核對',ORIGINAL_CONTRACT_INVALID:'原始盤口依據尚未核對',RESULT_ENDPOINTS_DISAGREE:'兩個賽果來源回應不一致',RESULT_SUMMARY_SOURCE_UNVERIFIED:'詳細賽果來源尚未核對',RESULT_SCOREBOARD_CROSSCHECK_UNAVAILABLE:'賽程賽果交叉核對暫不可用',RESULT_SOURCE_UNAVAILABLE:'賽果來源暫時無法讀取',RECORD_CHANGED:'紀錄狀態已變更，請重新核對'};
  const money=value=>Number.isFinite(value)?value.toLocaleString('zh-TW',{maximumFractionDigits:2}):'—';
  const confirmed=l.settlementPolicy?.creditRuleConfirmation;
  const examples=confirmed?.version==='SOCCER-USER-CREDIT-EXAMPLES-v1'&&confirmed.status==='USER_CONFIRMED'
    &&Array.isArray(confirmed.examples)?confirmed.examples:[];
  return <section className="panel" aria-label="足球下注紀錄"><div className="panelHead"><h2>{l.league==='epl'?'英超':'歐冠'}｜下注紀錄</h2><button className="secondary" disabled={l.status==='loading'||l.pending.size>0} onClick={l.load}>重新讀取</button><button className="secondary" disabled={l.status!=='ready'||l.pending.size>0} onClick={l.checkSettlement}>{l.pending.has(SETTLEMENT_CHECK_KEY)?'核對中…':`核對 ${l.date} 結算狀態`}</button></div>
    <p>{l.date}｜每筆 10,000 元｜{l.status==='ready'?`已下注 ${s.active} 筆｜已取消 ${s.cancelled} 筆｜投注合計 ${s.stake.toLocaleString('zh-TW')} 元`:'帳本尚未同步完成'}</p>
    <p className="soccerAvailability">僅記錄你已自行完成的下注，不會送單。已確認足球退水為實際輸贏本金的 1%：全輸贏退 1%、半輸贏退 0.5%、輸贏 20% 退 0.2%，走盤不退。具備原分析場次核對依據的紀錄，仍須通過正常完賽及原盤規則核對才可自動結算。其他紀錄可自行核對帳戶並申報結算，未確認的損益不填零。</p>
    {examples.length>0&&<details className="soccerDetails"><summary>已確認的信用盤派彩例子</summary><ul>{examples.map(example=><li key={example.line}>讓球方 {example.line}，剛好贏 {example.winningMargin} 球；本金 {money(example.stake)} 元、水位 {example.water}：毛損益 {money(example.grossProfit)} 元＋退水 {money(example.rebate)} 元＝淨損益 {money(example.netProfit)} 元。</li>)}</ul><p className="soccerAvailability">這三個例子已確認，不需重複提供。正式 S 評分的模型校準與誤差驗證仍由系統完成。</p></details>}
    <p>已結算：{s.settled}（含自行申報 {s.selfReportedSettled} 筆）｜待核對：{s.pending}｜正毛損益票率：{s.winRate==null?'—':`${(s.winRate*100).toFixed(1)}%`}｜損益：{money(s.profit)}｜ROI：{s.roi==null?'—':`${(s.roi*100).toFixed(2)}%`}</p>
    <p className="soccerAvailability">票率分母為有結果分類、排除走盤的已結算紀錄；未提供結果分類的自行申報不計入票率。ROI 分母為已結算本金，取消與未結算不納入；損益與 ROI 包含自行申報金額。</p>
    {l.settlementSummary&&<p role="status">本次檢查 {l.settlementSummary.checked} 筆｜完成自動結算 {l.settlementSummary.settled} 筆｜待核對 {l.settlementSummary.pending} 筆｜尚待處理 {l.settlementSummary.deferred} 筆</p>}
    {l.settlementPolicy?.sourceEvidence?.facts?.length>0&&<details className="soccerDetails"><summary>已取得的足球派彩條文</summary><ul>{l.settlementPolicy.sourceEvidence.facts.map(t=><li key={t.field}>{t.label}</li>)}</ul><p className="soccerAvailability">公開來源取得時間：{new Date(l.settlementPolicy.sourceEvidence.capturedAt).toLocaleString('zh-TW',{timeZone:'Asia/Taipei'})}；系統另保存原下注適用版本，已確認退水不需重報。</p></details>}
    {l.settlementPolicy?.missingTerms?.length>0&&<details className="soccerDetails"><summary>系統證據與登錄待完成</summary><ul>{l.settlementPolicy.missingTerms.map(t=><li key={t.code}>{t.label}</li>)}</ul></details>}
    {l.records.map(r=><article className="soccerSavedVersion" key={r.id}><h3>{r.home}（主）對 {r.away}（客）</h3><p>{r.date}｜{soccerMarketName(r.period,r.kind)}｜{r.label}｜水位 {r.water}</p>{providerScopedRecord(r)&&<p>原分析已在供應商來源範圍內唯一配對；完整賽程及獨立來源核對仍未驗證。{r.status==='OPEN'&&!r.settlement&&!r.accountSettlement?'通過原分析、正常賽果與原盤規則核對後可自動結算。':''}</p>}{r.settlement?.source==='SELF_REPORTED_USER_CONFIRMED'||r.accountSettlement?<p>本筆損益由帳戶自行申報；不代表系統已核對賽果或派彩，修正與撤銷均保留紀錄。</p>:!providerScopedRecord(r)&&(r.sourceIdentityStatus==='SELF_ASSERTED_UNVERIFIED'||!r.settlement)&&<p>原分析未保存可核對的場次身分依據，須自行核對；不會自動結算。</p>}<p>{r.stake.toLocaleString('zh-TW')} 元｜{r.status==='CANCELLED'?'已取消紀錄':'已下注 ✓'}｜{r.settlement?.status==='SETTLED'?`${r.settlement.source==='SELF_REPORTED_USER_CONFIRMED'?'帳戶自行申報（含退水）':outcomes[r.settlement.outcome]||'已結算'}｜損益 ${money(r.settlement.profit)}`:r.accountSettlement?'自行申報已撤銷':checkReasons[r.settlementCheck?.reason]||'結算待核對'}</p>{r.settlementCheck?.resultEvidence?.verified&&<p>賽果已核對｜全場 {r.settlementCheck.resultEvidence.fullTime?.home}：{r.settlementCheck.resultEvidence.fullTime?.away}{r.settlementCheck.resultEvidence.halfTime?`｜上半 ${r.settlementCheck.resultEvidence.halfTime.home}：${r.settlementCheck.resultEvidence.halfTime.away}`:''}</p>}{r.accountSettlement&&<details className="soccerDetails"><summary>自行申報與修正紀錄</summary><p>原始申報：{money(r.accountSettlement.original.profit)} 元（含退水）｜{new Date(r.accountSettlement.original.settledAt).toLocaleString('zh-TW',{timeZone:'Asia/Taipei'})}</p>{r.accountSettlement.amendments.map(a=><p key={a.revision}>{a.action==='REVOKE'?'撤銷申報':`修正為 ${money(a.profit)} 元（含退水）`}｜{a.reason}｜{new Date(a.recordedAt).toLocaleString('zh-TW',{timeZone:'Asia/Taipei'})}</p>)}</details>}{r.status==='OPEN'&&(r.accountSettlement?<AccountSettlementAmend record={r} ledger={l}/>:!r.settlement&&<AccountSettlementConfirm record={r} ledger={l}/>)}<button className="mini secondary" disabled={l.status!=='ready'||l.pending.has(soccerRecordKey(r))||l.pending.has(SETTLEMENT_CHECK_KEY)} onClick={()=>l.mutate({action:r.status==='CANCELLED'?'restore':'cancel',id:r.id,date:r.date},soccerRecordKey(r))}>{r.status==='CANCELLED'?'重新紀錄下注':'取消下注'}</button><small>保存時間 {new Date(r.recordedAt).toLocaleString('zh-TW',{timeZone:'Asia/Taipei'})}</small></article>)}
    {l.status==='ready'&&!l.records.length&&<p>此日期尚無已記錄的下注。</p>}
  </section>;
}
