'use client';
import { SoccerRecordButton } from './bet-records.js';

const finite=v=>typeof v==='number'&&Number.isFinite(v);
const pct=v=>finite(v)&&v>=0&&v<=1?`${(v*100).toFixed(1)}%`:'—';
const clock=v=>v&&Number.isFinite(Date.parse(v))?new Date(v).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false}):null;
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

function SoccerQuoteScoring({scoring}){
  if(!scoring||!Array.isArray(scoring.stages))return null;
  const payoff=scoring.conditionalPayoff;
  return <details className="soccerDetails"><summary>評分計算依據</summary><ul>{scoring.stages.map(stage=><li key={stage.stage}>{scoreStages[stage.stage]||'計算核對'}：{scoreStageStatuses[stage.status]||'尚待核對'}</li>)}</ul>
    {payoff?.ok&&<><p className="soccerMarketNote">依所列派彩條款的條件試算；正式資格仍按各項驗收狀態判定。</p><dl>{Object.entries({FULL_WIN:'全贏',PARTIAL_WIN:'部分贏',PUSH:'走盤',PARTIAL_LOSS:'部分輸',FULL_LOSS:'全輸'}).map(([key,label])=><div key={key}><dt>{label}</dt><dd>{pct(payoff.probabilities?.[key])}</dd></div>)}</dl>{payoff.evBounds?.net&&<p>每元本金期望淨損益範圍：{(payoff.evBounds.net.lower*100).toFixed(4)}% ～ {(payoff.evBounds.net.upper*100).toFixed(4)}%</p>}<p className="soccerMarketNote">範圍保留未展開比分的數值誤差；情境與模型誤差另行核對。</p></>}
    <p className="soccerMarketNote">尚缺派彩、足球誤差或正式驗收依據時，W／R／S 保留待核對。</p></details>;
}

function SoccerThresholdProbabilities({probabilities}){
  const p=probabilities;
  if(!p||!['TOTAL_GOALS','GIVING_TEAM_MARGIN'].includes(p.axis)||!finite(p.boundary))return null;
  const axis=p.axis==='TOTAL_GOALS'?'總進球':'讓球方淨勝球';
  return <div className="soccerMarketThreshold"><p>{axis}門檻 {p.boundary} 球</p><dl><div><dt>高於門檻</dt><dd>{pct(p.above)}</dd></div><div><dt>等於門檻</dt><dd>{pct(p.equal)}</dd></div><div><dt>低於門檻</dt><dd>{pct(p.below)}</dd></div></dl>{finite(p.tailMass)&&p.tailMass>0&&<p className="soccerMarketNote">未展開尾端機率 {pct(p.tailMass)}，以上保留原分布計算值。</p>}</div>;
}

function SoccerRawMarketQuote({quote,unassigned=false,expectedPeriod=null,index=0,game,result}){
  const q=quote||{},provenance=q.provenance||{},rawRows=(Array.isArray(q.rawRows)?q.rawRows:[]).map(rowText).filter(Boolean);
  const observed=clock(provenance.observedAt||q.observedAt||provenance.receivedAt);
  const periodConfirmed=!unassigned&&Boolean(periods[q.period])&&(!expectedPeriod||q.period===expectedPeriod);
  const period=periodConfirmed?periods[q.period]:null;
  const line=textValue(q.line),water=textValue(q.water);
  return <article className="soccerMarketQuote" data-quote-key={q.key||undefined}>
    <div className="soccerMarketQuoteHeading"><strong>{textValue(q.label)||`原盤 ${index+1}`}</strong><span className="soccerMarketResearchTag">{period||'期間待確認'}</span></div>
    <p className="soccerMarketPrice">球頭 <strong>{line||'未提供'}</strong><span>水位 <strong>{water??'未提供'}</strong></span></p>
    <p className="soccerMarketNote">S —｜W —｜R —｜正式評分待驗證</p>
    <SoccerQuoteScoring scoring={q.scoring}/>
    {rawRows.length>0&&<p className="soccerMarketRaw"><span>原始標示：</span>{rawRows.join(' ／ ')}</p>}
    {observed&&<p className="soccerMarketNote">原盤時間：{observed}</p>}
    {!periodConfirmed?<p className="soccerMarketCaution">期間待確認，暫不計算</p>:<><SoccerThresholdProbabilities probabilities={q.thresholdProbabilities}/>{!q.thresholdProbabilities&&<p className="soccerMarketNote">尚無適用的進球門檻機率。</p>}</>}
    {periodConfirmed&&<SoccerRecordButton game={game} result={result} quote={q}/>}
  </article>;
}

export function SoccerMarketDirections({directions=[],unassignedQuotes=[],game,result}){
  const items=Array.isArray(directions)?directions:[],unknown=Array.isArray(unassignedQuotes)?unassignedQuotes:[];
  return <details className="soccerDetails soccerMarketDirections"><summary>八方向與實際原盤</summary><p className="soccerMarketCaution">進球門檻機率僅描述比分分布，不是過盤率或獲利勝率。結算、退水與模型仍待驗收，正式 S／W／R 及候選尚未啟用。</p>
    <div className="soccerMarketDirectionGrid">{items.map((direction,index)=>{
      const d=direction||{},quotes=Array.isArray(d.quotes)?d.quotes:[],reasons=readableReasons(d.reasons);
      return <section className="soccerMarketDirection" key={`${d.period}:${d.direction}:${index}`}><h4>{periods[d.period]||'期間待確認'} {directionNames[d.direction]||'盤口方向待確認'}</h4><p className="soccerMarketNote">研究・契約待核對</p>{quotes.length>1&&<p className="soccerMarketNote">共 {quotes.length} 筆原盤，保留全部替代盤；未指定主盤。</p>}{quotes.length?quotes.map((quote,i)=><SoccerRawMarketQuote quote={quote} expectedPeriod={d.period} index={i} game={game} result={result} key={`${quote.key||i}:${i}`}/>):<p className="soccerMarketEmpty">缺少此方向可確認期間的原盤。</p>}{reasons.length>0&&<p className="soccerMarketNote">{reasons.join('；')}。</p>}</section>;
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
