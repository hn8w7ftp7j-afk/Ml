// Source terms are deliberately server-owned. A request body, an analysis flag,
// or a caller-supplied provenance.status cannot approve a provider contract.
// No complete Tai888 football contract has been verified yet.
const approvedContracts = Object.freeze([]);
export const SOCCER_SETTLEMENT_CONTRACT_GAPS = Object.freeze([
  'PERIOD_AND_STOPPAGE_EXTRA_TIME_SCOPE', 'INTEGER_AND_CREDIT_BOUNDARY_PAYOFF',
  'QUARTER_SPLIT_OR_PROPORTIONAL_MECHANIC', 'REBATE_ELIGIBLE_SETTLEMENT_STATES',
  'CANCELLATION_POSTPONEMENT_ABANDONMENT_AND_CORRECTION_TERMS',
  'EFFECTIVE_INTERVAL_AND_ACCOUNT_CONTRACT_BINDING',
]);
export const SOCCER_SETTLEMENT_MISSING_TERMS = Object.freeze([
  { code: 'PERIOD_AND_STOPPAGE_EXTRA_TIME_SCOPE', label: '普通上半場前 45 分鐘是否含補時；全場 90 分鐘含補時、排除加時及點球已有公開條文', status: 'PARTIAL' },
  { code: 'INTEGER_AND_CREDIT_BOUNDARY_PAYOFF', label: '非 ±50 尾碼的實際比例派彩；整數退款及 ±50 換算已有公開例證', status: 'PARTIAL' },
  { code: 'QUARTER_SPLIT_OR_PROPORTIONAL_MECHANIC', label: '原始盤口與公開拆盤／換算表的適用契約連結', status: 'PARTIAL' },
  { code: 'REBATE_ELIGIBLE_SETTLEMENT_STATES', label: '2026/10/20 17:11:48 已確認：實際輸贏本金比例乘 1%；半輸贏 0.5%、贏20%退0.2%、走盤不退', status: 'USER_CONFIRMED', confirmedAt: '2026-10-20T09:11:48Z' },
  { code: 'CANCELLATION_POSTPONEMENT_ABANDONMENT_AND_CORRECTION_TERMS', label: '已完成上半場後全場腰斬、復賽及無效注單退水等尚未明確細節', status: 'PARTIAL' },
  { code: 'EFFECTIVE_INTERVAL_AND_ACCOUNT_CONTRACT_BINDING', label: '公開條款對本帳號及原下注時點的適用證據；公開版本未提供生效日期', status: 'UNKNOWN' },
]);
export function soccerSettlementMissingTerms(asOf=Date.now()){
  const cutoff=typeof asOf==='number'?asOf:Date.parse(asOf);
  return SOCCER_SETTLEMENT_MISSING_TERMS.map(term=>term.confirmedAt&&!(cutoff>=Date.parse(term.confirmedAt))
    ?{...term,status:'UNKNOWN',label:'實際輸贏本金比例與走盤退水尚待確認'}:{...term})
    .filter(term=>term.status!=='USER_CONFIRMED');
}
// Public source observations are useful evidence, but do not establish member
// account rebate terms or historical applicability of a newly fetched version.
export const SOCCER_PUBLIC_TERM_EVIDENCE = Object.freeze({
  status:'PUBLIC_SOURCE_PARTIALLY_REVIEWED',completeContractVerified:false,
  sourceUrl:'https://globe.hgd0988.com/newRule/index.html?lang=zh-tw&path=25',
  sourceSha256:'8cd7d7b5803844a3fb3b53029f2830cf4415532bd1ffa417ea6508c4ccb14dcd',
  capturedAt:'2026-10-19T17:46:39.393368Z',publishedAt:null,effectiveFrom:null,effectiveUntil:null,
  evidenceRef:'research/soccer/provider-rules/tai888-20261020/findings.json',
  facts:[
    {field:'FT_PERIOD',status:'SOURCE_CONFIRMED',markets:['FT_HANDICAP','FT_TOTAL'],label:'全場 90 分鐘含補時，不含加時及點球',offsets:[443611,444685]},
    {field:'HT_PERIOD',status:'PARTIAL',markets:['HT_HANDICAP','HT_TOTAL'],label:'普通上半場條文為前 45 分鐘法定時間；含補時尚待同市場確認',offsets:[492609,497084]},
    {field:'HANDICAP_SPLIT',status:'SOURCE_CONFIRMED',markets:['FT_HANDICAP','HT_HANDICAP'],label:'來源所列兩個讓球盤各分配一半本金',offsets:[451412,494711]},
    {field:'INTEGER_BOUNDARY_REFUND',status:'SOURCE_EXAMPLES_CONFIRMED',markets:['FT_HANDICAP','HT_HANDICAP','FT_TOTAL','HT_TOTAL'],label:'整數大小相等退款；讓一球贏一球退款有來源例證',offsets:[453775,496727,472908,514355]},
    {field:'DISPLAY_CONVERSION_50',status:'SOURCE_TABLE_CONFIRMED',label:'0-50 對應 0/0.5、1+50 對應 0.5/1、1平對應 1、1-50 對應 1/1.5；不外推任意比例',offsetRanges:[[18081,22103],[22382,26286]]},
    {field:'FT_CANCEL_DELAY',status:'SOURCE_TEXT_FOUND',markets:['FT_HANDICAP','FT_TOTAL'],label:'未滿法定時間終止、延遲超過 12 小時或取消，全場注單無效退款',offsets:[444129]},
  ],
});
export function soccerVerifiedSettlementContract(record) {
  return approvedContracts.find(c => c.league === record?.league && c.period === record?.period
    && c.kind === record?.kind && c.line === record?.line
    && soccerSettlementContractComplete(c,record) && soccerSettlementContractBound(c,record)) || null;
}

// A newly verified rule must not silently become the applicable rule of an
// older quote. Effective dates require their own source evidence and the quote
// must retain its original Reader source/time/observation identity.
export function soccerSettlementContractBound(contract,record){
  try{
    const p=record.sourceQuote?.provenance,at=Date.parse(p?.observedAt),from=Date.parse(contract.effectiveFrom),until=Date.parse(contract.effectiveUntil);
    const url=new URL(p.sourceUrl),host=p.sourceHost;
    return contract.provider==='TAI888' && typeof contract.bindingEvidenceRef==='string' && contract.bindingEvidenceRef.length>0
      && Number.isFinite(at)&&Number.isFinite(from)&&Number.isFinite(until)&&from<=at&&at<until
      && typeof p.readerObservationId==='string'&&p.readerObservationId.length>0
      && url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&url.hostname===host
      && (host==='tai888.in'||host.endsWith('.tai888.in'))
      && (contract.quoteKey===undefined||contract.quoteKey===record.quoteKey);
  }catch{return false;}
}

/** Validation of an explicitly supplied, trusted-server contract for arithmetic.
 * This does not promote that contract into the production approval registry. */
export function soccerSettlementContractComplete(contract, record) {
  const outcomes = ['FULL_WIN', 'PARTIAL_WIN', 'PUSH', 'PARTIAL_LOSS', 'FULL_LOSS'];
  return Boolean(contract && contract.status === 'SOURCE_TERMS_VERIFIED'
    && typeof contract.version === 'string' && contract.version.length > 0
    && typeof contract.evidenceRef === 'string' && contract.evidenceRef.length > 0
    && Number.isFinite(Date.parse(contract.verifiedAt))
    && contract.league === record.league && contract.period === record.period
    && contract.kind === record.kind && contract.line === record.line
    && ['CREDIT_BOUNDARY', 'ASIAN_SPLIT'].includes(contract.type)
    && contract.scope === (record.period === 'HT' ? 'REGULATION_HT_WITH_STOPPAGE' : 'REGULATION_FT_WITH_STOPPAGE_NO_EXTRA_TIME_OR_PENALTIES')
    && contract.normalFinalOnly === true && contract.abnormalStatusPolicy === 'MANUAL_REVIEW'
    && contract.rebate?.rate === 0.01 && ['TOTAL_PRINCIPAL','SETTLED_PRINCIPAL'].includes(contract.rebate.basis)
    && outcomes.every(key => typeof contract.rebate.appliesTo?.[key] === 'boolean')
    && (contract.rebate.basis!=='SETTLED_PRINCIPAL'||outcomes.every(key=>contract.rebate.appliesTo[key]===(key!=='PUSH'))));
}
