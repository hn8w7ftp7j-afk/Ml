'use client';
import { useEffect,useRef,useState } from 'react';
import { SoccerCalibrationPanel } from './calibration-panel.js';
import { SoccerCalibrationShadowPanel } from './calibration-shadow-panel.js';

const VERSION='SOCCER-PROSPECTIVE-SAVED-PREDICTION-v1';
const periods={REGULATION_FT:'全場',REGULATION_HT:'上半場'};
const variants={BASELINE:'基準模型',PERSONNEL_CHALLENGER:'人員研究挑戰模型'};
const validCount=value=>Number.isSafeInteger(value)&&value>=0;
const count=value=>validCount(value)?value.toLocaleString('zh-TW'):'未知';
const metric=(value,n)=>validCount(n)&&n>0&&Number.isFinite(value)&&value>=0?value.toFixed(4):'—';
const clock=value=>Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false}):'尚未取得';
const retryDelay=(value,now)=>{
  const seconds=Number(value),at=typeof value==='string'?Date.parse(value):NaN;
  return value!==null&&String(value).trim()!==''&&Number.isFinite(seconds)&&seconds>=0
    ?Math.max(1000,Math.min(8.64e15-now,Math.ceil(seconds*1000))):Number.isFinite(at)?Math.max(1000,at-now):60000;
};
const reasonNames={
  FORWARD_MATCH_NOT_STARTED:'尚未開賽',FORWARD_RESULT_NOT_CHECKED:'賽果尚未核對',FORWARD_RESULT_SOURCE_UNAVAILABLE:'賽果來源暫時無法讀取',
  FORWARD_RESULT_SOURCES_UNVERIFIED:'賽果來源證據不足',FORWARD_CONFLICTING_RESULT_EVIDENCE:'賽果證據互相矛盾',FORWARD_RESULT_PERSISTENCE_FAILED:'賽果核對尚未取得永久保存確認',
  FORWARD_DATABASE_RECEIPT_UNVERIFIED:'缺少可核對的資料庫封存憑據',FORWARD_PERSISTENCE_TIME_UNVERIFIED:'啟用、分析或封存時序不符',FORWARD_FIRST_CAPTURE_NOT_PREGAME:'首次封存未早於開賽',
  FORWARD_LATER_VALID_REANALYSIS_NOT_SELECTED:'同一場與模型的後續重分析未選用',FORWARD_DISTRIBUTION_UNVERIFIED:'比分分布尚未通過核對',FORWARD_MODEL_VERSION_UNVERIFIED:'模型版本證據不足',
  FORWARD_PERSONNEL_MODEL_UNVERIFIED:'人員模型版本證據不足',FORWARD_PERSONNEL_PREGAME_XI_UNVERIFIED:'兩隊賽前先發證據不足',FORWARD_OMITTED_MASS_EXCEEDS_TOLERANCE:'未展開尾端機率超出報表容許值',
  RESULT_NORMAL_FINAL_UNCONFIRMED:'尚未確認正常完賽',RESULT_PERIOD_SCORE_UNVERIFIED:'缺少可核對的期間比分',RESULT_ENDPOINTS_DISAGREE:'兩個賽果端點不一致',
  RESULT_SCOREBOARD_CROSSCHECK_UNAVAILABLE:'賽程端點無法交叉核對',RESULT_EXTRA_PERIODS_REQUIRE_REVIEW:'涉及加時或其他額外期間',
  SOCCER_SOURCE_CONTRACT_UNVERIFIED:'系統尚未完成原盤適用派彩規則的綁定與正式登錄',
  MARKET_RETURN_NOT_CHECKED:'尚未核對原盤收益',NO_ORIGINAL_QUOTES:'此封存版本沒有可核對的原盤',
  MARKET_RETURN_ORIGINAL_QUOTES_UNAVAILABLE:'此封存版本未保存原盤明細',
  MARKET_RETURN_RESULT_HISTORY_INCOMPLETE:'賽果核對歷程未完整讀取',
  MARKET_RETURN_PREDICTED_PAYOFF_UNRESOLVED:'原盤收益仍為數值範圍，尚不能當成精確收益誤差樣本',
  MARKET_RETURN_CONTRACT_LOOKUP_FAILED:'系統讀取結算條款失敗',
  MARKET_RETURN_CONTRACT_CALCULATION_MISMATCH:'系統計算的條款版本與保存依據不一致',
  FORWARD_INPUT_SOURCE_AVAILABILITY_UNVERIFIED:'分析輸入的來源時間證據不足',
  RETURN_ERROR_NOT_CHECKED:'原盤收益尚未核對，暫不能加入誤差研究',
  RETURN_ERROR_NOT_OBSERVED:'尚無可驗證的原盤收益觀測',
  RETURN_ERROR_ORIGINAL_CAPTURE_UNAVAILABLE:'原始封存預測尚未完整讀取',
  RETURN_ERROR_ORIGINAL_RESULT_EVIDENCE_MISSING:'原始賽果核對依據缺失',
  RETURN_ERROR_INCOMPLETE_REQUESTED_SCOPE:'本次誤差研究資料範圍尚未完整處理',
  RETURN_ERROR_TERMS_NOT_KNOWN_AT_PREDICTION:'當時適用的派彩條款證據不足',
  RETURN_ERROR_EXACT_RETURN_RECOMPUTE_FAILED:'無法從原始資料重算精確收益',
  RETURN_ERROR_GAME_RESULT_OR_TERMS_QUARANTINED:'賽果或條款有衝突，整場排除',
  RETURN_ERROR_CHECK_HASH_INVALID:'收益核對內容與保存版本不一致',
  RETURN_ERROR_RESULT_SCOPE_MISMATCH:'收益核對與原始賽事或模型範圍不符',
  RETURN_ERROR_DATASET_HASH_INVALID:'誤差研究資料內容與保存版本不一致',
  RETURN_ERROR_DIAGNOSTIC_SUMMARY_INVALID:'誤差研究統計未通過核對',
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
function RetrospectivePayoffReplay({value}){
  if(!value)return null;
  const restrictions=['accountSettlementVerified','historicalContractVerified','verifiedAtOriginalCutoff','formalEligible','calibrationEligible','promotionEligible','executable'];
  const safe=value.version==='SOCCER-RETROSPECTIVE-CONFIRMED-RULE-PAYOFF-v1'
    &&restrictions.every(key=>value[key]===false)&&['W','R','S','empiricalErrorMargin'].every(key=>value[key]===null);
  if(safe&&value.status==='NOT_VERIFIED_LEGACY_SCAN')return <section aria-label="已確認算法收益重播"><h3>已確認算法收益重播</h3><p>此舊批次尚未核對收益重播。請重新讀取範圍，從原始保存資料建立新的重播批次。</p></section>;
  const counts=['selectedQuoteObservations','replayedQuoteObservations','exactPredictedQuoteReturns','boundedPredictedQuoteReturns','pendingQuoteObservations','quarantinedQuoteObservations','uniqueReplayedGames','invalidOriginalQuotes'];
  const verified=safe&&counts.every(key=>validCount(value[key]))
    &&value.selectedQuoteObservations===value.replayedQuoteObservations+value.pendingQuoteObservations+value.quarantinedQuoteObservations
    &&value.replayedQuoteObservations===value.exactPredictedQuoteReturns+value.boundedPredictedQuoteReturns
    &&value.uniqueReplayedGames<=value.replayedQuoteObservations;
  if(!verified)return <section aria-label="已確認算法收益重播"><h3>已確認算法收益重播</h3><p>本次重播資料尚未通過核對，未顯示未確認的筆數。</p></section>;
  return <section aria-label="已確認算法收益重播"><h3>已確認算法收益重播</h3>
    <p>有效原盤 {count(value.selectedQuoteObservations)} 筆｜已重播 {count(value.replayedQuoteObservations)} 筆｜待核對 {count(value.pendingQuoteObservations)} 筆｜衝突隔離 {count(value.quarantinedQuoteObservations)} 筆｜不同賽事 {count(value.uniqueReplayedGames)} 場。</p>
    <p>預測收益可精確計算 {count(value.exactPredictedQuoteReturns)} 筆；保留收益區間 {count(value.boundedPredictedQuoteReturns)} 筆。另有原始盤口未通過核對 {count(value.invalidOriginalQuotes)} 筆，不列入有效原盤。</p>
    <p>{value.completeWithinRequestedScope===true?'本次範圍已完成重播核對。':'本次重播範圍尚未完整，請繼續處理或重新讀取範圍。'}</p>
    <p className="soccerAvailability">用現在已確認的信用盤算法與 1% 比例退水，對照已保存的預測、原盤及賽果試算。這些是假設收益，尚未確認為帳戶實際派彩；同場多盤不當成多場獨立樣本，也不直接作為正式 R 或 S。</p>
  </section>;
}
function ForwardReport({report,league,summary}){
  const returns=report.marketReturnValidation,errorResearch=report.returnErrorResearch;
  const pending=validCount(report.selectedGameModelPeriods)&&validCount(report.evaluatedGameModelPeriods)&&report.selectedGameModelPeriods>=report.evaluatedGameModelPeriods?report.selectedGameModelPeriods-report.evaluatedGameModelPeriods:null;
  return <div className="soccerForwardReport">
    <p>前瞻方案啟用：{clock(report.protocol?.activatedAt)}。每場、每期間、每模型版本採資料庫最早有效封存憑據；方案須在分析前啟用，封存必須早於開賽。</p>
    <p>收到快照期間 {count(report.capturedSnapshotPeriods)} 筆｜有效封存 {count(report.selectedGameModelPeriods)} 筆｜已評估 {count(report.evaluatedGameModelPeriods)} 筆｜待賽果 {count(pending)} 筆｜不同賽事 {count(report.uniqueSelectedGames)} 場</p>
    <p className="soccerAvailability">同場的全場、上半場及人員模型分開列示，不能當成多場獨立比賽；分母是已選用的開賽前封存預測，不是所有賽程或下注。</p>
    <RetrospectivePayoffReplay value={report.retrospectivePayoffReplay}/>
    {returns&&<section aria-label="原盤收益驗證">
      <h3>原盤收益驗證</h3>
      <p>保存原盤 {count(returns.quoteObservations)} 筆｜已核對收益 {count(returns.observedQuoteReturns)} 筆｜待核對 {count(returns.pendingQuoteReturns)} 筆｜衝突排除 {count(returns.conflictingQuoteReturns)} 筆｜不同已核對賽事 {count(returns.uniqueObservedGames)} 場</p>
      {returns.boundedQuoteReturns>0&&<p>另已保存收益區間 {count(returns.boundedQuoteReturns)} 筆，來自 {count(returns.uniqueBoundedGames)} 場。原盤與賽果已核對，但比分尾端仍有未定收益；上下界分開保留，不算入上方精確收益筆數。</p>}
      <p className="soccerAvailability">將開賽前保存的原始盤口、預測及結算結果逐筆對照。同場不同方向不是獨立賽事；這是收益觀察資料，尚未取得正式 R，也不代表模型驗收通過。</p>
      <ReasonList reasons={returns.pendingReasons} label="收益待核對原因"/>
      <ReasonList reasons={returns.predictionPeriodReasons} label="封存版本待核對原因"/>
    </section>}
    {errorResearch&&<section aria-label="收益誤差研究資料"><h3>收益誤差研究資料</h3>
      <p>已選原盤 {count(errorResearch.selectedQuoteObservations)} 筆｜已核對 {count(errorResearch.checkedQuoteObservations)} 筆｜未核對 {count(errorResearch.uncheckedQuoteObservations)} 筆。</p>
      <p>可用收益觀測 {count(errorResearch.observedQuoteReturns)} 筆｜不同賽事 {count(errorResearch.observedGames)} 場｜衝突隔離 {count(errorResearch.quarantinedGames)} 場。</p>
      {errorResearch.boundedQuoteReturns>0&&<p>另保存誤差區間 {count(errorResearch.boundedQuoteReturns)} 筆，來自 {count(errorResearch.boundedGames)} 場；未取中點，也未加入單一數值的誤差擬合。這些區間不是正式 R 或 S。</p>}
      <p>{errorResearch.observedQuoteReturns===0?'誤差研究資料尚不足：目前沒有可供單一數值誤差擬合的精確收益觀測。':'已取得可供誤差研究的觀測，但研究方法、分組與樣本外驗收尚未完成。'} 這些筆數不是 R，也不代表正式評分已通過。</p>
      <p>{errorResearch.completeWithinRequestedScope===true&&report.complete===true?'本次誤差研究資料已涵蓋目前查詢範圍；範圍完整不等於模型已驗收。':report.scan?.nextCursor?'目前只統計已處理批次；後續批次完成前，尚不能當成完整驗證資料。':'本次誤差研究資料仍有完整性缺口，尚不能當成完整驗證資料。'}</p>
      <p className="soccerAvailability">同一場的多個方向不當成多場獨立樣本；實現損益誤差包含賽果本身的變動，不能直接當成期望收益的信賴下限。下一步由系統完成資料核對、誤差擬合與驗收。</p>
      <ReasonList reasons={errorResearch.excludedReasons} label="誤差研究待補與排除原因"/>
    </section>}
    {returns?.pendingReasons?.SOCCER_SOURCE_CONTRACT_UNVERIFIED>0&&<p className="soccerAvailability">下一步：系統須完成原盤、期間與派彩規則版本的綁定及正式登錄。已確認的信用盤算法與 1% 實際輸贏本金退水不需重報；異常賽事保留人工核對。</p>}
    {returns?.pendingReasons?.MARKET_RETURN_PREDICTED_PAYOFF_UNRESOLVED>0&&<p className="soccerAvailability">下一步由系統完成收益區間與誤差樣本的計算；反覆同步 Reader 不會排除此項。</p>}
    {summary&&<p role="status">本次核對 {count(summary.checkedGameModelPeriods)} 筆｜完成評估 {count(summary.evaluated)} 筆｜待核對 {count(summary.pending)} 筆｜尚待處理 {count(summary.deferred)} 筆。</p>}
    {report.scan&&<p role="status">已處理 {count(report.scan.processedGames)}／{count(report.scan.totalGames)} 場；{report.scan.complete?(report.complete===true?'本次範圍已掃描完成':'批次已結束，但本次資料仍不完整'):'尚有後續批次；系統會自動接續，暫停後可按「繼續處理下一批」恢復'}。以上筆數為累計結果，各批次不重複加總。</p>}
    {(report.truncated===true||report.complete===false)&&<p className="soccerAnalysisWarning" role="status">{report.scan?.nextCursor?'本次範圍尚未處理完整，累計數字不能當成完整驗收。':'本次讀取有截斷，只能查看已載入範圍，不能當成完整驗收結果；請用上方日期範圍縮小查詢。'}</p>}
    <ReasonList reasons={report.excludedReasons} label={`整體排除原因（${count(report.excludedSnapshotPeriods)} 筆）`}/>
    {summary&&<ReasonList reasons={summary.reasons} label="本次核對待處理原因"/>}
    {report.groups.length?report.groups.map((group,i)=><ForwardGroup key={`${group.modelHash}:${group.period}:${group.variant}:${i}`} group={group} league={league}/>):<p className="soccerAvailability">尚無方案啟用後的合格封存樣本，請等待開賽前分析封存與賽後核對；不以既有 2025 年資料補成新的 OOS。</p>}
    <details className="soccerDetails"><summary>方案與資料範圍</summary><p>觀察規則：<code>{report.canonicalRule?.observation||'尚未取得'}</code></p><p>封存順序：<code>{report.canonicalRule?.order||'尚未取得'}</code></p><p>讀取時間：{clock(report.readAt)}</p><p>原始來源位元組未完整保留供獨立重算；已保存正規化來源識別與封存憑據。此報表不宣稱嚴格歷史 PIT 已驗證。</p></details>
  </div>;
}
function checkedReport(value,league,range={from:'',through:''}){
  if(!value||value.version!==VERSION||!Array.isArray(value.groups)||value.formalEligible!==false||value.promotionEligible!==false||value.executable!==false
    ||value.groups.some(g=>g.league!==league||!Object.hasOwn(periods,g.period)||!Object.hasOwn(variants,g.variant))
    ||value.marketReturnValidation&&(value.marketReturnValidation.version!=='SOCCER-SAVED-QUOTE-RETURN-OBSERVATION-v1'
      ||value.marketReturnValidation.formalEligible!==false||value.marketReturnValidation.calibrationEligible!==false
      ||value.marketReturnValidation.promotionEligible!==false||value.marketReturnValidation.executable!==false
      ||['W','R','S','empiricalErrorMargin'].some(key=>value.marketReturnValidation[key]!==null)))throw Error('前瞻驗證回應的聯盟或範圍不符。');
  if(value.returnErrorResearch){
    const e=value.returnErrorResearch,fields=['selectedQuoteObservations','checkedQuoteObservations','uncheckedQuoteObservations','observedQuoteReturns','observedGames','quarantinedGames'];
    if(e.version!=='SOCCER-GAME-BLOCK-RETURN-ERROR-RESEARCH-v1'||e.accepted!==false||e.formalEligible!==false||e.calibrationEligible!==false
      ||e.promotionEligible!==false||e.executable!==false||fields.some(key=>!validCount(e[key]))
      ||['boundedQuoteReturns','boundedGames'].some(key=>e[key]!==undefined&&!validCount(e[key]))
      ||(e.boundedGames??0)>(e.boundedQuoteReturns??0)
      ||e.checkedQuoteObservations>e.selectedQuoteObservations||e.observedQuoteReturns+(e.boundedQuoteReturns??0)>e.checkedQuoteObservations||e.observedGames>e.observedQuoteReturns
      ||e.uncheckedQuoteObservations!==e.selectedQuoteObservations-e.checkedQuoteObservations||typeof e.completeWithinRequestedScope!=='boolean'
      ||e.completeWithinRequestedScope===true&&value.complete!==true
      ||['W','R','S','empiricalErrorMargin'].some(key=>e[key]!==null))throw Error('收益誤差研究回應的範圍、統計或資格狀態不符。');
  }
  if(value.scan){
    const s=value.scan, date=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
    const token=v=>typeof v==='string'&&v.length>=16&&v.length<=256&&/^[A-Za-z0-9_-]+$/.test(v);
    if(s.version!=='SOCCER-FORWARD-SCAN-v1'||!['read','evaluate'].includes(s.purpose)||s.scope?.league!==league
      ||!date(s.scope?.from)||!date(s.scope?.through)||s.scope.from>s.scope.through
      ||range.from&&(s.scope.from!==range.from||s.scope.through!==range.through)
      ||!validCount(s.processedGames)||!validCount(s.totalGames)||s.processedGames>s.totalGames
      ||typeof s.complete!=='boolean'||!token(s.cursor)||s.nextCursor!==null&&!token(s.nextCursor)
      ||s.complete&&s.nextCursor!==null||!s.complete&&s.nextCursor===null
      ||!Number.isFinite(Date.parse(s.frozenAt))||value.complete===true&&!s.complete)throw Error('前瞻驗證接續資料的範圍或處理狀態不符。');
  }
  return value;
}
export function SoccerForwardValidationPanel({league}){
  const supported=['epl','ucl'].includes(league);
  const [state,setState]=useState({scopeKey:null,status:'loading',report:null,summary:null,error:''});
  const [range,setRange]=useState({from:'',through:''}),[draft,setDraft]=useState({from:'',through:''}),[filterError,setFilterError]=useState('');
  const [automatic,setAutomatic]=useState({enabled:true,waitingUntil:null});
  const scopeKey=`${league}|${range.from}|${range.through}`;
  const generation=useRef(0),flight=useRef(null),mounted=useRef(false),continuation=useRef(null),scope=useRef(scopeKey);scope.current=scopeKey;
  const auto=useRef({enabled:true,timer:null,retry:null,blockedUntil:0,postStarts:[]});
  function clearAutomaticTimer(){if(auto.current.timer!==null)clearTimeout(auto.current.timer);auto.current.timer=null;}
  function nextAllowed(evaluate){
    const now=Date.now();auto.current.postStarts=auto.current.postStarts.filter(at=>now-at<60000);
    return Math.max(now,auto.current.blockedUntil,evaluate&&auto.current.postStarts.length>=4?auto.current.postStarts[0]+60050:0);
  }
  function scheduleAutomatic(request,minimumDelay=1000){
    clearAutomaticTimer();
    if(!auto.current.enabled||!mounted.current||scope.current!==scopeKey)return;
    const waitingUntil=Math.max(Date.now()+minimumDelay,nextAllowed(request.evaluate));
    setAutomatic({enabled:true,waitingUntil});
    auto.current.timer=setTimeout(()=>{auto.current.timer=null;if(auto.current.enabled&&mounted.current&&scope.current===scopeKey)void load(request.evaluate,request.cursor);},Math.min(2147483647,Math.max(0,waitingUntil-Date.now())));
  }
  function pauseAutomatic(){
    auto.current.enabled=false;auto.current.retry=null;clearAutomaticTimer();setAutomatic({enabled:false,waitingUntil:null});
    if(flight.current){const active=flight.current;generation.current++;clearTimeout(active.timer);active.controller.abort();flight.current=null;
    }
    setState(old=>old.scopeKey===scopeKey?{...old,status:'paused',error:''}:old);
  }
  async function load(evaluate=false,cursor=null){
    if(!supported||!mounted.current||scope.current!==scopeKey)return;
    if(flight.current)return flight.current.promise;
    const previousScan=cursor?continuation.current?.scan:null;
    if(cursor&&(continuation.current?.scopeKey!==scopeKey||previousScan?.nextCursor!==cursor||previousScan?.purpose!==(evaluate?'evaluate':'read')))return;
    clearAutomaticTimer();
    if(Date.now()<nextAllowed(evaluate)){auto.current.enabled=true;auto.current.retry={evaluate,cursor};scheduleAutomatic({evaluate,cursor},0);return;}
    auto.current.enabled=true;auto.current.retry=null;setAutomatic({enabled:true,waitingUntil:null});
    if(evaluate)auto.current.postStarts.push(Date.now());
    const token=++generation.current,controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),25000);
    setState(old=>({scopeKey,status:evaluate?'evaluating':'loading',report:old.scopeKey===scopeKey?old.report:null,summary:null,error:''}));
    const active={token,controller,timer,promise:null};flight.current=active;
    const promise=(async()=>{
      try{
        const query={league,...(cursor?{from:previousScan.scope.from,through:previousScan.scope.through,cursor}:range.from&&range.through?range:{})};
        const options={cache:'no-store',credentials:'same-origin',signal:controller.signal,...(evaluate?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'evaluate',...query,limit:25})}:{})};
        const response=await fetch(`/api/soccer/forward-validation${evaluate?'':`?${new URLSearchParams(query)}`}`,options),body=await response.json();
        if(!mounted.current||scope.current!==scopeKey||token!==generation.current)return;
        if(response.status===429){
          auto.current.blockedUntil=Date.now()+retryDelay(response.headers?.get?.('Retry-After')??null,Date.now());
          auto.current.retry={evaluate,cursor};
          setState(old=>({...old,scopeKey,status:'waiting',error:''}));return;
        }
        if(!response.ok||body.ok!==true)throw Error(response.status===401?'登入已過期，請重新登入網站。':body.error||'前瞻驗證暫時無法讀取。');
        const report=checkedReport(body.report,league,range);
        if(report.scan&&report.scan.purpose!==(evaluate?'evaluate':'read'))throw Error('前瞻驗證接續工作已改變，請重新讀取。');
        if(cursor&&(report.scan?.cursor!==cursor||Date.parse(report.scan?.frozenAt)!==Date.parse(previousScan.frozenAt)
          ||report.scan?.totalGames!==previousScan.totalGames||report.scan?.processedGames<previousScan.processedGames))throw Error('前瞻驗證接續工作已改變，請重新讀取。');
        continuation.current=report.scan?{scopeKey,scan:report.scan}:null;
        if(cursor&&report.scan?.nextCursor&&report.scan.processedGames===previousScan.processedGames){
          auto.current.enabled=false;setAutomatic({enabled:false,waitingUntil:null});
          setState({scopeKey,status:'failed',report,summary:evaluate?body.summary||null:null,error:'本批尚未取得新進度，已暫停自動處理；已完成結果保留，可稍後從同一進度重試。'});return;
        }
        setState({scopeKey,status:'ready',report,summary:evaluate?body.summary||null:null,error:''});
      }catch(error){
        if(mounted.current&&scope.current===scopeKey&&token===generation.current){auto.current.enabled=false;setAutomatic({enabled:false,waitingUntil:null});setState(old=>({...old,scopeKey,status:'failed',error:error.name==='AbortError'?'核對逾時，請重試；尚未確認的結果不列入評分。':error.message||'前瞻驗證暫時無法讀取。'}));}
      }finally{
        clearTimeout(timer);if(flight.current?.token===token)flight.current=null;
        if(mounted.current&&scope.current===scopeKey&&token===generation.current&&auto.current.enabled){
          const retry=auto.current.retry,next=continuation.current;
          if(retry)scheduleAutomatic(retry,0);
          else if(next?.scopeKey===scopeKey&&next.scan.nextCursor)scheduleAutomatic({evaluate:next.scan.purpose==='evaluate',cursor:next.scan.nextCursor});
          else{auto.current.enabled=false;setAutomatic({enabled:false,waitingUntil:null});}
        }
      }
    })();
    active.promise=promise;return promise;
  }
  useEffect(()=>{
    mounted.current=true;auto.current.enabled=true;auto.current.retry=null;continuation.current=null;setAutomatic({enabled:true,waitingUntil:null});if(supported)void load();
    return()=>{mounted.current=false;generation.current++;clearAutomaticTimer();if(flight.current){clearTimeout(flight.current.timer);flight.current.controller.abort();flight.current=null;}};
  },[league,range.from,range.through]);
  function applyRange(event){
    event.preventDefault();if(flight.current)return;
    const valid=value=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
    if(!valid(draft.from)||!valid(draft.through)||draft.through<draft.from||Date.parse(draft.through)-Date.parse(draft.from)>366*86400000){setFilterError('請填寫有效的開始與結束日期，範圍最多 367 天。');return;}
    setFilterError('');if(draft.from===range.from&&draft.through===range.through)void load();else setRange({...draft});
  }
  function resetRange(){if(flight.current)return;setFilterError('');setDraft({from:'',through:''});if(!range.from&&!range.through)void load();else setRange({from:'',through:''});}
  const current=state.scopeKey===scopeKey,busy=!current||['loading','evaluating','waiting'].includes(state.status)||automatic.waitingUntil!==null;
  return <section className="panel soccerForwardValidation" aria-label="足球前瞻驗證"><div className="panelHead"><h2>{league==='ucl'?'歐冠':'英超'}｜前瞻驗證</h2><button className="secondary" disabled={!supported||busy} onClick={()=>load()}>重新讀取</button><button className="secondary" disabled={!supported||busy} onClick={()=>load(true)}>{current&&state.status==='evaluating'?'核對中…':'核對已封存賽果'}</button></div>
    <SoccerCalibrationShadowPanel key={league} league={league}/>
    <p>預設查詢今天及前 30 天。系統會自動接續全部批次，可隨時暫停。只核對伺服器已封存的預測與賽果，不會新增下注。</p>
    <form className="soccerForwardFilters" onSubmit={applyRange}><label>開始日期 <input type="date" name="from" value={draft.from} onChange={event=>{const value=event.target.value;setDraft(old=>({...old,from:value}));}}/></label> <label>結束日期 <input type="date" name="through" value={draft.through} onChange={event=>{const value=event.target.value;setDraft(old=>({...old,through:value}));}}/></label> <button type="submit" className="secondary" disabled={!supported||busy}>讀取日期範圍</button> <button type="button" className="secondary" disabled={!supported||busy} onClick={resetRange}>恢復預設範圍</button></form>
    {filterError&&<p role="alert">{filterError}</p>}<p className="soccerAvailability">目前範圍：{range.from&&range.through?`${range.from} ～ ${range.through}`:'今天及前 30 天（依伺服器台灣日期）'}。</p>
    <p className="soccerAvailability">既有 2025 年回顧診斷不算新的未用 OOS。賽果採 ESPN 兩個端點交叉核對，並非獨立官方來源確認；模型放行維持關閉，不能據此宣稱勝率提高。</p>
    {!supported?<p role="alert">只提供英超與歐冠前瞻驗證。</p>:<>
      {(!current||['loading','evaluating'].includes(state.status))&&<p role="status">{current&&state.status==='evaluating'?'正在核對封存預測的賽果…':'正在讀取前瞻封存資料…'}</p>}
      {automatic.waitingUntil!==null&&<p role="status">已保留目前進度，將於 {clock(new Date(automatic.waitingUntil).toISOString())} 自動接續；遇到請求上限會依伺服器指定時間等待。</p>}
      {automatic.enabled&&busy&&<button className="secondary" onClick={pauseAutomatic}>暫停自動處理</button>}
      {current&&state.status==='paused'&&<p role="status">已暫停，已完成結果保留。可接續目前批次，或重新讀取範圍。</p>}
      {current&&state.error&&<p className="soccerAnalysisWarning" role="alert">{state.error}</p>}
      {current&&state.report&&<>{state.status==='failed'&&<p className="soccerAvailability">以下為上次成功讀取的資料，本次更新尚未完成。</p>}<ForwardReport report={state.report} league={league} summary={state.summary}/>{state.report.scan?.nextCursor&&<button className="secondary" disabled={busy} onClick={()=>load(state.report.scan.purpose==='evaluate',state.report.scan.nextCursor)}>繼續處理下一批</button>}</>}
    </>}
  </section>;
}
