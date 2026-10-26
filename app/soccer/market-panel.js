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
const reasonNames={MATCH_ALREADY_STARTED:'比賽已開始，僅供歷史核對',HALF_TIME_MODEL_UNVERIFIED:'上半場研究模型待驗收',SCORE_MODEL_UNAVAILABLE:'缺少適用比分分布',MATCHED_READER_QUOTE_MISSING:'缺少已配對原盤',READER_QUOTE_STALE:'原盤已逾期，請更新',SOCCER_PERIOD_SETTLEMENT_REBATE_UNVERIFIED:'期間、派彩及退水適用條件待核對',SOCCER_MODEL_NOT_PROMOTED:'模型尚未正式驗收',PERIOD_UNVERIFIED:'期間待確認，暫不計算',SOCCER_PERIOD_UNKNOWN:'期間待確認，暫不計算',SOCCER_PERIOD_UNVERIFIED:'期間待確認，暫不計算'};
const textValue=v=>typeof v==='string'||finite(v)?String(v):null;
const rowText=row=>{
  const direct=textValue(row);if(direct!==null)return direct;
  if(Array.isArray(row))return row.map(rowText).filter(Boolean).join(' ／ ');
  if(!row||typeof row!=='object')return null;
  return textValue(row.raw)||textValue(row.text)||(Array.isArray(row.pair)?rowText(row.pair):Array.isArray(row.cells)?rowText(row.cells):null);
};
const readableReasons=list=>[...new Set((Array.isArray(list)?list:[]).map(reason=>reasonNames[reason]||(typeof reason==='string'&&/[\u3400-\u9fff]/.test(reason)?reason:null)).filter(Boolean))];
const scoreStages={READER_QUOTE:'原盤來源與期間',SETTLEMENT_CONTRACT:'實際派彩條款',PER_SCORE_PAYOFF:'逐比分損益',FOOTBALL_UNCERTAINTY:'足球情境與誤差依據',FIXED_S_FORMULA:'固定 S 評分公式',FORMAL_ACCEPTANCE:'正式模型與校準驗收',CURRENT_PUBLICATION:'目前候選資格'};
const scoreStageStatuses={PASS:'已核對',REGISTERED:'已登錄核對依據',CALCULATED_CONDITIONALLY:'已完成條件試算',CONDITIONAL_ONLY:'僅供條件試算',CONDITIONAL_PROTOCOL_ARITHMETIC:'已完成情境算術核對',DIAGNOSTIC_ONLY:'研究分數',MISSING:'尚缺條款',NOT_CALCULABLE:'尚缺計算依據',BLOCKED:'尚未通過',PENDING:'尚待核對',NOT_AUTHORIZED:'尚未授權'};
const readerDiagnosticNames={SOCCER_READER_STORAGE_UNAVAILABLE:'原盤暫時讀取失敗，無法確認是否缺盤。',SOCCER_READER_CAPTURE_MISSING:'此比賽日期尚未收到 Reader 原盤。',SOCCER_READER_CAPTURE_SCOPE_MISMATCH:'原盤的聯盟或日期與本場不符。',SOCCER_READER_GAME_UNMATCHED:'已收到原盤，但本場隊名或開賽時間尚未配對。',SOCCER_READER_NO_OPEN_GOAL_MARKET:'本場已配對，目前沒有開放的讓球或大小盤。',SOCCER_READER_PERIOD_UNCONFIRMED:'本場原盤已配對，但全場／上半場標示尚未確認。',SOCCER_READER_CAPTURE_UNUSABLE_AT_CUTOFF:'本場原盤尚未通過分析時間核對。',SOCCER_READER_MATCH_STARTED:'比賽已開始；原盤僅供歷史核對。',SOCCER_READER_QUOTES_STALE:'本場原盤已配對，但已逾期，請更新原盤。',SOCCER_READER_CAPTURE_READY:'本場已有配對成功的賽前原盤。'};
const readerDiagnosticStatuses={SOCCER_READER_STORAGE_UNAVAILABLE:'UNAVAILABLE',SOCCER_READER_CAPTURE_MISSING:'MISSING',SOCCER_READER_CAPTURE_SCOPE_MISMATCH:'SCOPE_MISMATCH',SOCCER_READER_GAME_UNMATCHED:'UNMATCHED',SOCCER_READER_NO_OPEN_GOAL_MARKET:'NO_OPEN_GOALS',SOCCER_READER_PERIOD_UNCONFIRMED:'PERIOD_UNCONFIRMED',SOCCER_READER_CAPTURE_UNUSABLE_AT_CUTOFF:'UNUSABLE_CAPTURE',SOCCER_READER_MATCH_STARTED:'POSTSTART',SOCCER_READER_QUOTES_STALE:'STALE',SOCCER_READER_CAPTURE_READY:'READY'};
function readerDiagnostic(result,game){
  const d=result?.readerDiagnostics;
  return d?.version==='SOCCER-READER-DIAGNOSTICS-v1'&&d.executable===false&&d.gameId===result?.gameId&&d.league===result?.league&&d.date===result?.date
    &&(!game||game.id===d.gameId&&game.league===d.league&&game.date===d.date)
    &&readerDiagnosticNames[d.code]&&readerDiagnosticStatuses[d.code]===d.status&&d.counts&&typeof d.counts==='object'?d:null;
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
  if(!result||readiness.status==='SCORES_AVAILABLE')return null;
  return <section className="soccerScoringReadiness" role="status" aria-label="S 評分計算狀態" data-scoring-readiness={readiness.status}>
    <strong>{readiness.status==='SCORING_BLOCKED'?'正式評分尚未完成':readiness.status==='PARTIAL'?'部分原盤尚未產生 S 分數':'尚無可確認期間的原盤供評分'}</strong>
    <p>八方向原盤 {readiness.quoteCount} 筆；已有 S 分數 {readiness.scoredQuoteCount} 筆{readiness.unassignedQuoteCount?`；期間待確認 ${readiness.unassignedQuoteCount} 筆`:''}。</p>
    {readiness.status==='SCORING_BLOCKED'&&<p>已收到盤口，但下列評分依據尚未補齊，目前無法產生 S 分數。</p>}
    {blockers.length>0&&<ul>{blockers.map(blocker=><li key={blocker.code}>{blocker.label}</li>)}</ul>}
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
    <p>正式 S 評分另缺派彩適用依據、足球情境與模型誤差驗證；更新盤口或重按分析不會自動補齊。</p>
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
    ||c.assumption?.accountTermsVerified!==false||c.assumption?.mechanic!=='CREDIT_BOUNDARY'
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
  const c=state.analysis,historical=state.status==='HISTORICAL';
  return <section className="soccerConditionalAnalysis" aria-label="條件式收益分析">
    <strong>{historical?'歷史條件式收益分析':'條件式收益分析'}</strong>
    <p>期望淨收益：{returnPct(c.netReturnBounds.lower)} ～ {returnPct(c.netReturnBounds.upper)}（每元本金）</p>
    <p className="soccerMarketNote">依信用盤比例派彩假設試算，尚未確認本帳號適用；足球退水按實際輸贏本金的 1%，走盤不退。</p>
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
    <SoccerAutomaticAnalysisStatus result={result} game={game} now={now}/>
    <SoccerScoringReadiness result={result} game={game} now={now}/>
    {diagnostic&&<p className="soccerMarketNote" role="status" data-reader-status={diagnostic.status}>{readerDiagnosticNames[diagnostic.code]}{Number.isInteger(diagnostic.counts?.assignedQuotes)&&diagnostic.counts.assignedQuotes>0?` 已配入 ${diagnostic.counts.assignedQuotes} 筆方向原盤。`:''}</p>}
    <div className="soccerMarketDirectionGrid">{items.map((direction,index)=>{
      const d=direction||{},quotes=Array.isArray(d.quotes)?d.quotes:[],reasons=readableReasons(d.reasons);
      const emptyReason=Array.isArray(d.unknownPeriodQuotes)&&d.unknownPeriodQuotes.length?'已有原盤，但尚未確認屬全場或上半場。':diagnostic&&diagnostic.status!=='READY'?readerDiagnosticNames[diagnostic.code]:'缺少此方向可確認期間的原盤。';
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
