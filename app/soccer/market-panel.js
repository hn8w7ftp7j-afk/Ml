'use client';
import { SoccerRecordButton } from './bet-records.js';
import { soccerQuoteScorePresentation } from '../../lib/soccer/score-presentation.js';
import { soccerScoringReadiness, soccerQuoteScoringBlockers } from '../../lib/soccer/scoring-readiness.js';

const finite=v=>typeof v==='number'&&Number.isFinite(v);
const pct=v=>finite(v)&&v>=0&&v<=1?`${(v*100).toFixed(1)}%`:'—';
const clock=v=>v&&Number.isFinite(Date.parse(v))?new Date(v).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false}):null;
const returnPct=v=>finite(v)?`${v>0?'+':''}${(v*100).toFixed(2)}%`:'—';
const periods={FT:'全場',HT:'上半場'};
const directionNames={HANDICAP_HOME:'主隊讓／受讓',HANDICAP_AWAY:'客隊讓／受讓',TOTAL_OVER:'大球',TOTAL_UNDER:'小球'};
const reasonNames={MATCH_ALREADY_STARTED:'比賽已開始，僅供歷史核對',HALF_TIME_MODEL_UNVERIFIED:'上半場研究模型待驗收',SCORE_MODEL_UNAVAILABLE:'缺少適用比分分布',MATCHED_READER_QUOTE_MISSING:'缺少已配對原盤',READER_QUOTE_STALE:'原盤已逾期，請更新',SOCCER_PERIOD_SETTLEMENT_REBATE_UNVERIFIED:'系統尚未完成原盤派彩規則綁定與正式登錄',SOCCER_MODEL_NOT_PROMOTED:'模型尚未正式驗收',PERIOD_UNVERIFIED:'期間待確認，暫不計算',SOCCER_PERIOD_UNKNOWN:'期間待確認，暫不計算',SOCCER_PERIOD_UNVERIFIED:'期間待確認，暫不計算'};
const textValue=v=>typeof v==='string'||finite(v)?String(v):null;
const rowText=row=>{
  const direct=textValue(row);if(direct!==null)return direct;
  if(Array.isArray(row))return row.map(rowText).filter(Boolean).join(' ／ ');
  if(!row||typeof row!=='object')return null;
  return textValue(row.raw)||textValue(row.text)||(Array.isArray(row.pair)?rowText(row.pair):Array.isArray(row.cells)?rowText(row.cells):null);
};
const readableReasons=list=>[...new Set((Array.isArray(list)?list:[]).map(reason=>reasonNames[reason]||(typeof reason==='string'&&/[\u3400-\u9fff]/.test(reason)?reason:null)).filter(Boolean))];
const scoreStages={READER_QUOTE:'原盤來源與期間',SETTLEMENT_CONTRACT:'實際派彩條款',PER_SCORE_PAYOFF:'逐比分損益',FOOTBALL_UNCERTAINTY:'足球情境與誤差依據',FIXED_S_FORMULA:'固定 S 評分公式',FORMAL_ACCEPTANCE:'正式模型與校準驗收',CURRENT_PUBLICATION:'目前候選資格'};
const scoreStageStatuses={PASS:'已核對',REGISTERED:'已登錄核對依據',CALCULATED_CONDITIONALLY:'已完成條件試算',CONDITIONAL_ONLY:'僅供條件試算',CONDITIONAL_PROTOCOL_ARITHMETIC:'已完成情境算術核對',DIAGNOSTIC_ONLY:'研究分數',MISSING:'尚未完成規則登錄',NOT_CALCULABLE:'尚缺計算依據',BLOCKED:'尚未通過',PENDING:'尚待核對',NOT_AUTHORIZED:'尚未授權'};
const readerDiagnosticNames={SOCCER_READER_STORAGE_UNAVAILABLE:'原盤暫時讀取失敗，無法確認是否缺盤。',SOCCER_READER_CAPTURE_MISSING:'此分析版本建立時尚無可用原盤；目前保存狀態請看上方原盤與「已保存原盤」。',SOCCER_READER_CAPTURE_SCOPE_MISMATCH:'原盤的聯盟或日期與本場不符。',SOCCER_READER_GAME_UNMATCHED:'已收到原盤，但本場隊名或開賽時間尚未配對。',SOCCER_READER_NO_OPEN_GOAL_MARKET:'本場已配對，目前沒有開放的讓球或大小盤。',SOCCER_READER_PERIOD_UNCONFIRMED:'本場原盤已配對，但全場／上半場標示尚未確認。',SOCCER_READER_CAPTURE_UNUSABLE_AT_CUTOFF:'本場原盤尚未通過分析時間核對。',SOCCER_READER_MATCH_STARTED:'比賽已開始；原盤僅供歷史核對。',SOCCER_READER_QUOTES_STALE:'本場原盤已配對，但已逾期，請更新原盤。',SOCCER_READER_CAPTURE_READY:'本場已有配對成功的賽前原盤。'};
const readerDiagnosticStatuses={SOCCER_READER_STORAGE_UNAVAILABLE:'UNAVAILABLE',SOCCER_READER_CAPTURE_MISSING:'MISSING',SOCCER_READER_CAPTURE_SCOPE_MISMATCH:'SCOPE_MISMATCH',SOCCER_READER_GAME_UNMATCHED:'UNMATCHED',SOCCER_READER_NO_OPEN_GOAL_MARKET:'NO_OPEN_GOALS',SOCCER_READER_PERIOD_UNCONFIRMED:'PERIOD_UNCONFIRMED',SOCCER_READER_CAPTURE_UNUSABLE_AT_CUTOFF:'UNUSABLE_CAPTURE',SOCCER_READER_MATCH_STARTED:'POSTSTART',SOCCER_READER_QUOTES_STALE:'STALE',SOCCER_READER_CAPTURE_READY:'READY'};
function readerDiagnostic(result,game){
  const d=result?.readerDiagnostics;
  return d?.version==='SOCCER-READER-DIAGNOSTICS-v1'&&d.executable===false&&d.gameId===result?.gameId&&d.league===result?.league&&d.date===result?.date
    &&(!game||game.id===d.gameId&&game.league===d.league&&game.date===d.date)
    &&readerDiagnosticNames[d.code]&&readerDiagnosticStatuses[d.code]===d.status&&d.counts&&typeof d.counts==='object'?d:null;
}

function readerMessage(d,game,now){
  return d?.status==='STALE'&&game&&(['live','final'].includes(game.status)||Date.parse(game.startTime)<=now)?'比賽已開始，已保存原盤僅供歷史核對；現在更新不能補成當時的賽前盤。':readerDiagnosticNames[d?.code];
}

function SoccerQuoteScoring({scoring}){
  if(!scoring||!Array.isArray(scoring.stages))return null;
  const payoff=scoring.conditionalPayoff;
  return <details className="soccerDetails"><summary>評分計算依據</summary><ul>{scoring.stages.map(stage=><li key={stage.stage}>{scoreStages[stage.stage]||'計算核對'}：{scoreStageStatuses[stage.status]||'尚待核對'}</li>)}</ul>
    {payoff?.ok&&<><p className="soccerMarketNote">依所列派彩條款的條件試算；正式資格仍按各項驗收狀態判定。</p><dl>{Object.entries({FULL_WIN:'全贏',PARTIAL_WIN:'部分贏',PUSH:'走盤',PARTIAL_LOSS:'部分輸',FULL_LOSS:'全輸'}).map(([key,label])=><div key={key}><dt>{label}</dt><dd>{pct(payoff.probabilities?.[key])}</dd></div>)}</dl>{payoff.evBounds?.net&&<p>每元本金期望淨損益範圍：{(payoff.evBounds.net.lower*100).toFixed(4)}% ～ {(payoff.evBounds.net.upper*100).toFixed(4)}%</p>}<p className="soccerMarketNote">範圍保留未展開比分的數值誤差；情境與模型誤差另行核對。</p></>}
    <p className="soccerMarketNote">尚缺派彩、足球誤差或正式驗收依據時，W／R／S 保留待核對。</p></details>;
}

export function SoccerScoringReadiness({result,game,now=Date.now()}){
  const readiness=soccerScoringReadiness(result,now,game||result?.evidence?.game);
  const blockers=readiness.blockers.filter(item=>!['PER_SCORE_PAYOFF','FIXED_S_FORMULA'].includes(item.code));
  if(!result)return null;
  const owners={CURRENT_DATA:'本場原盤與資料',RULES_EVIDENCE:'本帳戶規則依據',SYSTEM:'系統尚待完成的工作'};
  return <section className="soccerScoringReadiness" role="status" aria-label="S 評分計算狀態" data-scoring-readiness={readiness.status}>
    <strong>{readiness.status==='SCORES_AVAILABLE'?'正式評分已計算':readiness.status==='SCORING_BLOCKED'?'正式評分尚未完成':readiness.status==='PARTIAL'?'部分原盤尚未產生 S 分數':'尚無可確認期間的原盤供評分'}</strong>
    <p>八方向原盤 {readiness.quoteCount} 筆；已有 S 分數 {readiness.scoredQuoteCount} 筆{readiness.unassignedQuoteCount?`；期間待確認 ${readiness.unassignedQuoteCount} 筆`:''}。</p>
    {readiness.status==='SCORING_BLOCKED'&&<p>已收到盤口，但下列評分依據尚未補齊，目前無法產生 S 分數。</p>}
    <p>目前符合排名 {readiness.qualifiedQuoteCount} 筆；未達門檻 {readiness.belowThresholdQuoteCount} 筆；歷史分數 {readiness.historicalScoreCount} 筆；資格待發布 {readiness.unpublishedScoreCount} 筆。</p>
    {Object.entries(owners).map(([owner,label])=>{const items=blockers.filter(item=>item.owner===owner);return items.length?<section key={owner} aria-label={label}><strong>{label}</strong><ul>{items.map(item=><li key={item.code}>{item.label}<p>{item.nextAction}</p></li>)}</ul></section>:null;})}
    {readiness.evidenceReadiness?.blockers?.length>0&&<details className="soccerDetails" aria-label="本次分析的正式資料缺項"><summary>正式模型資料尚缺 {readiness.evidenceReadiness.blockers.length} 項</summary>
      <p>依本次保存資料逐項核對；更新 Reader 不會補齊下列模型資料。已收到來源回報，也不代表已完成正式模型驗證。</p>
      <ul>{readiness.evidenceReadiness.blockers.map(item=><li key={item.code}>{item.label}<ul>{item.details.map(detail=><li key={detail.code}>{detail.label}</li>)}</ul></li>)}</ul>
    </details>}
    {readiness.unpublishedScoreCount>0&&<p>分數已計算，系統仍須核對目前原盤及發布資格；尚不列排名。</p>}
    {readiness.belowThresholdQuoteCount>0&&<p>未同時達到 S ≥ 7.2、W &gt; 0、R &gt; 0 的原盤不列排名。</p>}
    <p className="soccerMarketNote">「紀錄實際下注」只登記你已自行完成的下注，不代表通過排名，也不會送出下注。</p>
    {readiness.status==='SCORING_BLOCKED'&&<p>重新分析會更新比分研究、資料核對與符合條件原盤的收益試算；正式評分仍須完成驗證。</p>}
  </section>;
}

function SoccerThresholdProbabilities({probabilities}){
  const p=probabilities;
  if(!p||!['TOTAL_GOALS','GIVING_TEAM_MARGIN'].includes(p.axis)||!finite(p.boundary))return null;
  const axis=p.axis==='TOTAL_GOALS'?'總進球':'讓球方淨勝球';
  return <div className="soccerMarketThreshold"><p>{axis}門檻 {p.boundary} 球</p><dl><div><dt>高於門檻</dt><dd>{pct(p.above)}</dd></div><div><dt>等於門檻</dt><dd>{pct(p.equal)}</dd></div><div><dt>低於門檻</dt><dd>{pct(p.below)}</dd></div></dl>{finite(p.tailMass)&&p.tailMass>0&&<p className="soccerMarketNote">未展開尾端機率 {pct(p.tailMass)}，以上保留原分布計算值。</p>}</div>;
}

const conditionalFailures={
  SOCCER_SCORE_READER_TIME_INVALID:'原盤已過期、時間未通過核對或比賽已開始，請先更新原盤再重新分析',
  SOCCER_SCORE_READER_SCOPE_INVALID:'原盤與本場比賽或期間不符，須重新配對',
  SOCCER_SCORE_READER_RECEIPT_MISSING:'原盤缺少來源收據，須由 Reader 重新同步',
  SOCCER_SCORE_READER_SOURCE_INVALID:'原盤來源未通過核對，須由 Reader 重新同步',
  SOCCER_SCORE_READER_QUOTE_HASH_MISMATCH:'原盤內容與保存收據不一致，須由 Reader 重新同步',
  SOCCER_SCORE_READER_QUOTE_INVALID:'球頭、水位或方向不完整，須更新原盤',
  CONDITIONAL_MODEL_SCOPE_INVALID:'尚缺適用本場及期間的比分模型，須重新核對賽前資料',
};
function conditionalFailureReason(quote){
  const c=quote?.conditionalAnalysis;
  return !c?'此歷史版本尚未保存收益分析，請重新核對賽前資料':conditionalFailures[c.reason]||'此盤口缺少可用的計算依據，須核對球頭、水位與比分模型';
}

export function SoccerScenarioResearch({result,game,now=Date.now()}){
  const r=result?.scenarioResearch,saved=result?.evidence?.game;
  if(!r||r.version!=='SOCCER-SOURCE-TRAINED-SCENARIO-RESEARCH-v1'||r.formalEnabled!==false||r.executable!==false
    ||!saved||!game||r.gameId!==result.gameId||r.league!==result.league||r.date!==result.date
    ||r.gameId!==saved.id||r.league!==saved.league||r.date!==saved.date
    ||Boolean(game.neutralSite)!==Boolean(saved.neutralSite)
    ||game.id!==saved.id||game.league!==saved.league||game.date!==saved.date
    ||game.sourceId!==saved.sourceId||game.home?.sourceId!==saved.home?.sourceId||game.away?.sourceId!==saved.away?.sourceId
    ||Date.parse(game.startTime)!==Date.parse(saved.startTime)||r.startTime!==saved.startTime)return null;
  const reasons={SOCCER_SCENARIO_NOT_PREMATCH:'此版本不是開賽前情境計算，不能補成當時已知的資料。',
    SOCCER_SCENARIO_ARTIFACT_NOT_AVAILABLE_AT_CUTOFF:'這份情境模型在當時尚未產生；歷史分析不會套用後來的模型。',
    SOCCER_SCENARIO_MODEL_AFTER_CUTOFF:'情境模型晚於本次適用時間，不能套用。',
    SOCCER_SCENARIO_GAME_IDENTITY_INVALID:'賽事身分尚未通過核對。'};
  if(r.status!=='RESEARCH_ONLY')return <section className="soccerScoringReadiness" aria-label="足球研究情境"><strong>參數變動研究尚無適用結果</strong><p>{reasons[r.reason]||'系統尚未取得適用本場與期間的情境計算，未補入預設情境。'}</p></section>;
  const cutoff=Date.parse(result.analysisCutoff||result.observedAt),created=Date.parse(r.createdAt),trained=Date.parse(r.trainingCutoff);
  if(!['artifactHash','protocolHash','baselineModelHash'].every(key=>/^[a-f0-9]{64}$/.test(r[key]||''))
    ||![now,cutoff,created,trained].every(finite)||trained>created||created>cutoff||cutoff>now||cutoff>=Date.parse(saved.startTime)
    ||r.pointInTimeAvailabilityVerified!==false)return null;
  const historical=['live','final'].includes(game.status)||Date.parse(game.startTime)<=now||now-cutoff>=180000;
  const validRange=v=>finite(v?.min)&&finite(v?.max)&&v.min>=0&&v.min<=v.max;
  return <section className="soccerScoringReadiness" aria-label="足球研究情境"><strong>{historical?'已保存的參數變動研究':'本場參數變動研究'}</strong>
    {['FT','HT'].map(period=>{const p=r.periods?.[period],ranges=p?.parameterRanges;
      if(!p||p.formalEnabled!==false||!Number.isSafeInteger(p.count)||!Number.isSafeInteger(p.attempted)||!Number.isSafeInteger(p.failed)
        ||p.count<0||p.failed<0||p.attempted>1000||p.count+p.failed!==p.attempted)return null;
      const available=p.count>0&&['RESEARCH_SCENARIOS_AVAILABLE','PARTIAL_RESEARCH_SCENARIOS'].includes(p.status)
        &&p.weightsRenormalized===false&&validRange(ranges?.homeRate)&&validRange(ranges?.awayRate);
      return <div key={period}><p>{periods[period]}：已計算 {p.count}／{p.attempted} 組；未完成 {p.failed} 組。</p>
        {available?<p>主隊平均進球參數 {ranges.homeRate.min.toFixed(3)} ～ {ranges.homeRate.max.toFixed(3)}；客隊 {ranges.awayRate.min.toFixed(3)} ～ {ranges.awayRate.max.toFixed(3)}。</p>:<p>尚無可展示的適用參數範圍；失敗組別不會重分配權重。</p>}</div>;
    })}
    <p>以已保存歷史資料重新加權擬合，計算不同參數下的比分分布。範圍是成功計算組別的最小與最大值，不是信賴區間，也不是不同陣容發生的機率。</p>
    <p className="soccerMarketNote">研究情境已計算，不代表正式收益誤差與 W／R／S 已驗證；正式評分仍依下方缺項判定。{historical?'此為原分析保存的研究結果。':''}</p>
  </section>;
}

export function SoccerAutomaticAnalysisStatus({result,game,now=Date.now()}){
  if(!result)return null;
  const quotes=(Array.isArray(result.directions)?result.directions:[]).flatMap(d=>(Array.isArray(d?.quotes)?d.quotes:[]).filter(q=>q&&q.period===d.period&&['FT','HT'].includes(d.period)));
  if(!quotes.length)return null;
  const counts={CURRENT:0,HISTORICAL:0,UNAVAILABLE:0};
  for(const quote of quotes)counts[soccerConditionalState({quote,result,game,now}).status]++;
  return <section className="soccerScoringReadiness" role="status" aria-label="自動原盤收益分析狀態">
    <strong>自動原盤收益分析</strong>
    <p>可用試算 {counts.CURRENT} 筆；歷史或過期 {counts.HISTORICAL} 筆；未完成 {counts.UNAVAILABLE} 筆。</p>
    {counts.CURRENT>0&&<p>有效原盤已自動計算條件收益，展開下方原盤即可查看；無須再手動輸入。</p>}
    {counts.HISTORICAL>0&&<p>歷史試算不代表目前價格；未開賽場次須更新 Reader 原盤並重新核對賽前資料。</p>}
    {counts.UNAVAILABLE>0&&<p>{game?.status!=='scheduled'||Date.parse(game?.startTime)<=now?'此場已開賽，現在同步的盤口不能補成當時的賽前分析；僅能查閱已保存版本。':'請查看下方盤口的來源、期間與計算核對結果；重新同步原盤可修復來源或時間問題。'}</p>}
    {soccerScoringReadiness(result,now,game).status!=='SCORES_AVAILABLE'&&<p>正式 S 評分仍待系統完成原盤派彩規則綁定、足球情境與模型誤差驗證；更新盤口或重按分析不會自動補齊，也不需重報已確認的算法。</p>}
  </section>;
}

function soccerConditionalState({quote,result,game,now=Date.now()}){
  const c=quote?.conditionalAnalysis,saved=result?.evidence?.game;
  const distribution=quote?.period==='FT'?result?.prediction:result?.halfTimePrediction;
  if(result?.qaFlag==='BLOCKED'||c?.version!=='SOCCER-CREDIT-ASSUMPTION-RETURN-v1'||c.status!=='CONDITIONAL_RESEARCH'
    ||c.gameId!==result?.gameId||c.league!==result?.league||c.sourceQuoteKey!==quote.key||c.period!==quote.period
    ||c.formalScoringEnabled!==false||c.eligible!==false||c.executable!==false
    ||['W','R','S'].some(key=>c[key]!==null)||!saved||!game
    ||game.id!==saved.id||game.league!==saved.league||game.date!==saved.date
    ||game.sourceId!==saved.sourceId||Date.parse(game.startTime)!==Date.parse(saved.startTime)
    ||game.home?.sourceId!==saved.home?.sourceId||game.away?.sourceId!==saved.away?.sourceId
    ||Boolean(game.neutralSite)!==Boolean(saved.neutralSite)
    ||![true,false].includes(c.assumption?.accountTermsVerified)||c.assumption?.mechanic!=='CREDIT_BOUNDARY'
    ||c.assumption.accountTermsVerified===true&&!(c.ruleBinding?.accountTermsVerified===true
      &&c.ruleBinding.periodTermsVerified===true&&c.ruleBinding.sourceQuoteKey===quote.key
      &&c.ruleBinding.authority==='ACCOUNT_OWNER_INSTRUCTION'
      &&Date.parse(c.ruleBinding.accountRuleConfirmation?.confirmedAt)<=Date.parse(c.quoteObservedAt))
    ||c.assumption?.rebateRate!==.01||c.assumption?.rebateBasis!=='SETTLED_PRINCIPAL'
    ||c.modelVersion!==distribution?.modelVersion||c.trainingHash!==distribution?.trainingHash
    ||c.distributionHash!==quote.scoring?.provenance?.distributionHash
    ||c.quoteObservedAt!==quote.provenance?.observedAt
    ||c.assumption?.period!==quote.period||c.assumption?.extraTimeIncluded!==false
    ||quote.period!==({REGULATION_FT:'FT',REGULATION_HT:'HT'})[distribution?.period]
    ||distribution?.league!==result.league||distribution?.gameId!==result.gameId
    ||!finite(c.unresolvedTailMass)||c.unresolvedTailMass<0||c.unresolvedTailMass>1
    ||!['FULL_WIN','PARTIAL_WIN','PUSH','PARTIAL_LOSS','FULL_LOSS'].every(key=>finite(c.probabilities?.[key])&&c.probabilities[key]>=0&&c.probabilities[key]<=1)
    ||!Number.isFinite(Date.parse(c.quoteObservedAt))||Date.parse(c.quoteObservedAt)>Date.parse(c.calculatedAt)
    ||!finite(c.netReturnBounds?.lower)||!finite(c.netReturnBounds?.upper)||c.netReturnBounds.lower>c.netReturnBounds.upper
    ||!finite(now)||!Number.isFinite(Date.parse(c.calculatedAt))||Date.parse(c.calculatedAt)>now
    ||Date.parse(c.calculatedAt)>=Date.parse(saved.startTime))return {status:'UNAVAILABLE'};
  const historical=!Number.isFinite(Date.parse(result.observedAt))||Date.parse(result.observedAt)>now
    ||now-Date.parse(result.observedAt)>=180000
    ||result.validUntil!=null&&!(Date.parse(result.validUntil)>now)
    ||result.status==='POSTSTART_AUDIT'||result.persisted===true&&result.publishedCurrent===false
    ||game.status!=='scheduled'||Date.parse(game.startTime)<=now||now-Date.parse(c.calculatedAt)>=180000
    ||!Number.isFinite(Date.parse(c.quoteObservedAt))||now-Date.parse(c.quoteObservedAt)>=180000;
  return {status:historical?'HISTORICAL':'CURRENT',analysis:c};
}

export function SoccerConditionalAnalysis({quote,result,game,now=Date.now()}){
  const state=soccerConditionalState({quote,result,game,now});
  if(state.status==='UNAVAILABLE'){
    if(quote?.conditionalAnalysis&&quote.conditionalAnalysis.status!=='UNAVAILABLE')return null;
    const reason=game?.status!=='scheduled'||Date.parse(game?.startTime)<=now?'此場已開賽，無法用目前盤口重建賽前收益；請查閱已保存版本':conditionalFailureReason(quote);
    return <p className="soccerMarketCaution" role="status">自動收益分析未完成：{reason}。</p>;
  }
  const c=state.analysis,historical=state.status==='HISTORICAL',trial=quote?.scenarioScore;
  const showTrial=trial?.version==='SOCCER-PARAMETER-STRESS-SCORE-v1'&&trial.status==='PARAMETER_SENSITIVITY_ONLY'
    &&trial.formalEligible===false&&trial.executable===false&&['W','R','S'].every(key=>trial[key]===null)
    &&trial.gameId===c.gameId&&trial.league===c.league&&trial.period===c.period&&trial.sourceQuoteKey===quote.key
    &&trial.calculatedAt===c.calculatedAt&&trial.baselineDistributionHash===c.distributionHash
    &&trial.artifactHash===result?.scenarioResearch?.artifactHash&&trial.protocolHash===result?.scenarioResearch?.protocolHash
    &&finite(trial.scoreLower)&&finite(trial.scoreUpper)&&trial.scoreLower>=1&&trial.scoreUpper<=10&&trial.scoreLower<=trial.scoreUpper&&finite(trial.meanNetReturn)&&finite(trial.stressReturn)
    &&trial.stressReturn<=trial.meanNetReturn&&trial.modelErrorMargin===null;

  return <section className="soccerConditionalAnalysis" aria-label="條件式收益分析">
    <strong>{historical?'歷史條件式收益分析':'條件式收益分析'}</strong>
    {showTrial&&<section aria-label="情境試算分數" className="soccerScoringReadiness">
      <strong>{historical?'歷史情境試算分數':'情境試算分數'} {trial.scoreLower===trial.scoreUpper?trial.scoreLower.toFixed(1):`${trial.scoreLower.toFixed(1)} ～ ${trial.scoreUpper.toFixed(1)}`}／10</strong>
      <p>{trial.scenarioCount} 組參數情境｜平均收益下界 {returnPct(trial.meanNetReturn)}｜壓力收益下界 {returnPct(trial.stressReturn)}</p>
      <p>沿用固定評分公式，僅比較參數變動；不是正式 S、不列正式排名。尚未計入經驗證的完整模型誤差。</p>
      <details className="soccerDetails"><summary>試算分數計算依據</summary><p>全組情境保留原權重；平均收益為加權平均，壓力收益取平均與加權第 10 百分位較低值。此百分位不是信賴下限。未展開比分保留收益區間，兩端分數不同時顯示分數區間。</p><p>計算時間：{clock(trial.calculatedAt)}｜公式：{trial.formulaVersion}</p></details>
    </section>}
    <p>期望淨收益：{returnPct(c.netReturnBounds.lower)} ～ {returnPct(c.netReturnBounds.upper)}（每元本金）</p>
    <p className="soccerMarketNote">{c.assumption.accountTermsVerified?'依你確認的帳戶規則計算，正常全場／半場均含補時，全場不含加時及PK；':'依信用盤比例派彩假設試算，尚未確認本帳號適用；'}足球退水按實際輸贏本金的 1%，走盤不退。</p>
    {c.ruleBinding?.status==='ARITHMETIC_BOUND'&&c.ruleBinding.sourceQuoteKey===quote.key
      &&c.ruleBinding.gameId===c.gameId&&c.ruleBinding.league===c.league
      &&c.ruleBinding.quote?.period===quote.period&&c.ruleBinding.quote?.sourceLine===quote.line
      &&c.ruleBinding.quote?.direction===quote.side?.toUpperCase()&&c.ruleBinding.quote?.water===quote.water
      &&c.ruleBinding.quote?.kind===quote.kind&&c.ruleBinding.quote?.lineSide===(quote.lineSide??null)
      &&c.ruleBinding.accountTermsVerified===c.assumption.accountTermsVerified&&c.ruleBinding.formalScoringEnabled===false
      &&/^[a-f0-9]{64}$/.test(c.ruleBinding.bindingHash||'')
      &&<details className="soccerDetails"><summary>已確認算式已綁定本筆原盤</summary>
        <p>球頭、方向、全場／半場、水位及原盤來源已分別綁定；退水為實際輸贏本金 × 1%，走盤不退。</p>
        <p>規則：{c.ruleBinding.ruleVersion}｜套用時間：{clock(c.ruleBinding.appliedAt)}</p>
        <p>綁定憑據：{c.ruleBinding.bindingHash}</p>
        <p>{c.ruleBinding.accountTermsVerified?'帳戶與正常期間規則依你這次確認登錄，僅套用確認後的原盤；':'這是計算規則綁定；帳號與期間條款仍待核對，'}異常賽事保留人工核對，並未取得正式評分資格。</p>
      </details>}
    <dl>{Object.entries({FULL_WIN:'全贏',PARTIAL_WIN:'部分贏',PUSH:'走盤',PARTIAL_LOSS:'部分輸',FULL_LOSS:'全輸'}).map(([key,label])=><div key={key}><dt>{label}</dt><dd>{pct(c.probabilities?.[key])}</dd></div>)}</dl>
    <p className="soccerMarketNote">範圍僅保留未展開比分的損益界線，不包含模型誤差。正式 W／R／S 與排名資格仍待驗證。{historical?'此為已保存試算，價格已過期或比賽已開始。':''}</p>
  </section>;
}

function SoccerRawMarketQuote({quote,unassigned=false,expectedPeriod=null,index=0,game,result,direction,now}){
  const q=quote||{},provenance=q.provenance||{},rawRows=(Array.isArray(q.rawRows)?q.rawRows:[]).map(rowText).filter(Boolean);
  const observed=clock(provenance.observedAt||q.observedAt||provenance.receivedAt);
  const periodConfirmed=!unassigned&&Boolean(periods[q.period])&&(!expectedPeriod||q.period===expectedPeriod);
  const period=periodConfirmed?periods[q.period]:null;
  const line=textValue(q.line),water=textValue(q.water);
  const presentation=soccerQuoteScorePresentation({result,direction,quote:q,displayGame:game,periodConfirmed,now});
  const blockers=periodConfirmed&&presentation.score==null?soccerQuoteScoringBlockers(q.scoring):[];
  return <article className="soccerMarketQuote" data-quote-key={q.key||undefined}>
    <div className="soccerQuoteScoreRow"><div className={`soccerQuoteScore ${presentation.tone}`} aria-label={presentation.score==null?'尚未產生 S 分數':`S 分數 ${presentation.score.toFixed(1)}`}><span>S 分數</span><strong>{presentation.score==null?'—':presentation.score.toFixed(1)}</strong><small>10 分制</small></div><div className="soccerQuoteScoreBody">
      <div className="soccerMarketQuoteHeading"><strong>{textValue(q.label)||`原盤 ${index+1}`}</strong><span className="soccerMarketResearchTag">{period||'期間待確認'}</span></div>
      <p className="soccerMarketPrice">球頭 <strong>{line||'未提供'}</strong><span>水位 <strong>{water??'未提供'}</strong></span></p>
      <p className="soccerMarketNote">W {returnPct(presentation.W)}｜R {returnPct(presentation.R)}</p>
      <p className="soccerScoreStatus" data-score-status={presentation.status}>{presentation.status==='UNAVAILABLE'&&periodConfirmed?'正式評分尚未完成':presentation.label}</p>
      {blockers.length>0&&<p className="soccerMarketCaution">無法評分：{blockers.slice(0,1).map(item=>item.label).join('；')}。</p>}
    </div></div>
    {periodConfirmed&&<SoccerConditionalAnalysis quote={q} result={result} game={game} now={now}/>}
    <SoccerQuoteScoring scoring={q.scoring}/>
    {rawRows.length>0&&<p className="soccerMarketRaw"><span>原始標示：</span>{rawRows.join(' ／ ')}</p>}
    {observed&&<p className="soccerMarketNote">原盤時間：{observed}</p>}
    {!periodConfirmed?<p className="soccerMarketCaution">期間待確認，暫不計算</p>:<details className="soccerDetails"><summary>比分門檻研究（不是 S 分數）</summary><SoccerThresholdProbabilities probabilities={q.thresholdProbabilities}/>{!q.thresholdProbabilities&&<p className="soccerMarketNote">尚無適用的進球門檻機率。</p>}</details>}
    {periodConfirmed&&<SoccerRecordButton game={game} result={result} quote={q}/>}
  </article>;
}

export function SoccerMarketDirections({directions=[],unassignedQuotes=[],game,result,now=Date.now()}){
  const items=Array.isArray(directions)?directions:[],unknown=Array.isArray(unassignedQuotes)?unassignedQuotes:[];
  const diagnostic=readerDiagnostic(result,game);
  return <details className="soccerDetails soccerMarketDirections" open><summary>八方向與實際原盤｜S 評分</summary><p className="soccerMarketNote">正式評分完成後，每筆原盤將獨立顯示 S 分數，沿用 MLB 現有評分公式及上限規則；不是把勝率換成分數。排名另須通過 S ≥ 7.2、W &gt; 0、R &gt; 0 與正式資格核對。</p><p className="soccerMarketCaution">尚無有效計算依據時不產生分數。進球門檻機率僅描述比分分布，不是過盤率或獲利勝率。</p>
    <SoccerScenarioResearch result={result} game={game} now={now}/>
    <SoccerAutomaticAnalysisStatus result={result} game={game} now={now}/>
    <SoccerScoringReadiness result={result} game={game} now={now}/>
    {diagnostic&&<p className="soccerMarketNote" role="status" data-reader-status={diagnostic.status}>{readerMessage(diagnostic,game,now)}{Number.isInteger(diagnostic.counts?.assignedQuotes)&&diagnostic.counts.assignedQuotes>0?` 已配入 ${diagnostic.counts.assignedQuotes} 筆方向原盤。`:''}</p>}
    <div className="soccerMarketDirectionGrid">{items.map((direction,index)=>{
      const d=direction||{},quotes=Array.isArray(d.quotes)?d.quotes:[],reasons=readableReasons(d.reasons).map(reason=>game&&(['live','final'].includes(game.status)||Date.parse(game.startTime)<=now)&&reason===reasonNames.READER_QUOTE_STALE?'此為歷史原盤，現在更新不能重建當時的賽前價格':reason);
      const emptyReason=Array.isArray(d.unknownPeriodQuotes)&&d.unknownPeriodQuotes.length?'已有原盤，但尚未確認屬全場或上半場。':diagnostic&&diagnostic.status!=='READY'?readerMessage(diagnostic,game,now):'缺少此方向可確認期間的原盤。';
      const shownReasons=diagnostic&&diagnostic.status!=='READY'?reasons.filter(reason=>reason!==reasonNames.MATCHED_READER_QUOTE_MISSING):reasons;
      return <section className="soccerMarketDirection" key={`${d.period}:${d.direction}:${index}`}><h4>{periods[d.period]||'期間待確認'} {directionNames[d.direction]||'盤口方向待確認'}</h4>{quotes.length>1&&<p className="soccerMarketNote">共 {quotes.length} 筆原盤，保留全部替代盤；未指定主盤。</p>}{quotes.length?quotes.map((quote,i)=><SoccerRawMarketQuote quote={quote} expectedPeriod={d.period} index={i} game={game} result={result} direction={d} now={now} key={`${quote.key||i}:${i}`}/>):<div className="soccerQuoteScoreRow"><div className="soccerQuoteScore pending" aria-label="尚未產生 S 分數"><span>S 分數</span><strong>—</strong><small>10 分制</small></div><div className="soccerQuoteScoreBody"><strong>尚無此方向評分</strong><p className="soccerMarketEmpty">{emptyReason}</p></div></div>}{shownReasons.length>0&&<p className="soccerMarketNote">{shownReasons.join('；')}。</p>}</section>;
    })}</div>
    {!items.length&&<p className="soccerMarketEmpty">尚無八方向分析，請先核對賽前資料。</p>}
    {unknown.length>0&&<section className="soccerMarketUnassigned"><h4>期間待確認的原盤</h4><p className="soccerMarketCaution">以下原盤未能確認屬全場或上半場，暫不配入八方向。</p>{unknown.map((quote,i)=><SoccerRawMarketQuote quote={quote} unassigned index={i} key={`${quote.key||i}:${i}`}/>)}</section>}
  </details>;
}

export function SoccerHalfTimeResearch({halfTimePrediction,halfTimeResearch}){
  const p=halfTimePrediction,r=halfTimeResearch;
  if(!p&&!r)return null;
  const outcomes=p?.outcomes,available=outcomes&&[outcomes.home,outcomes.draw,outcomes.away].every(finite);
  const reasons=readableReasons(r?.reasons||(r?.reason?[r.reason]:[]));
  return <section className="soccerHalfTimeResearch"><h3>上半場比分研究</h3>{available?<><div className="soccerHalfTimeOutcomes"><span>主勝 <strong>{pct(outcomes.home)}</strong></span><span>和局 <strong>{pct(outcomes.draw)}</strong></span><span>客勝 <strong>{pct(outcomes.away)}</strong></span></div>{finite(p.homeRate)&&finite(p.awayRate)&&<p className="soccerMarketNote">模型平均進球：主 {p.homeRate.toFixed(2)}／客 {p.awayRate.toFixed(2)}。</p>}</>:<p className="soccerMarketEmpty">尚無適用的上半場研究分布。</p>}<p className="soccerMarketCaution">上半場模型尚未正式驗收，僅供研究；不列入候選排名。</p>{reasons.length>0&&<p className="soccerMarketNote">{reasons.join('；')}。</p>}</section>;
}
