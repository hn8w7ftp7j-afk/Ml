import { parseTaiwanContract,settleTaiwanContract,SETTLEMENT_RULE_VERSION } from '../taiwan-settlement-v9.js';
// A review of existing credit arithmetic, not approval of a provider's soccer rules.
export function soccerSettlementReview(market){
  if(!market||market.unit!=='GOALS'||!['HANDICAP','TOTAL'].includes(market.kind)||typeof market.line!=='string'||!/^\d+(?:\.\d+)?(?:平|[+-]\d{1,3})?$/.test(market.line)||Number(market.line.match(/[+-](\d+)$/)?.[1]||0)>100)throw Error('SOCCER_REVIEW_MARKET_INVALID');
  const total=market.kind==='TOTAL',homeGives=market.lineSide==='home';if(!total&&!['home','away'].includes(market.lineSide))throw Error('SOCCER_REVIEW_SIDE_INVALID');
  const picks=total?[`大${market.line}`,`小${market.line}`]:homeGives?[`主隊讓${market.line}`,`客隊受讓${market.line}`]:[`主隊受讓${market.line}`,`客隊讓${market.line}`];
  const waters=total?[market.overWater,market.underWater]:[market.homeWater,market.awayWater];if(waters.some(w=>!Number.isFinite(w)||w<=0))throw Error('SOCCER_REVIEW_PRICE_INVALID');
  const contracts=picks.map(p=>parseTaiwanContract(p));if(contracts.some(c=>!c.valid))throw Error('SOCCER_REVIEW_CONTRACT_INVALID');
  const boundary=Number(market.line.match(/^\d+(?:\.\d+)?/)[0]),values=new Set(Array.from({length:9},(_,i)=>total?i:i-4));
  for(const value of [Math.floor(boundary)-1,Math.floor(boundary),Math.ceil(boundary),Math.ceil(boundary)+1]){if(value>=0)values.add(value);if(!total)values.add(-value);}
  const rows=[...values].sort((a,b)=>a-b).map(value=>{
    const home=total?value:Math.max(value,0),away=total?0:Math.max(-value,0),outcomes=contracts.map((c,i)=>{const s=settleTaiwanContract(c,away,home,'客隊','主隊');if(!s||s.coverage!==1)throw Error('SOCCER_REVIEW_COVERAGE_INVALID');return{pick:picks[i],water:waters[i],winFraction:s.winFraction,lossFraction:s.lossFraction,pushFraction:s.pushFraction,netWithoutRebate:s.winFraction*waters[i]-s.lossFraction};});
    if(Math.abs(outcomes[0].winFraction-outcomes[1].lossFraction)>1e-12||Math.abs(outcomes[0].lossFraction-outcomes[1].winFraction)>1e-12)throw Error('SOCCER_REVIEW_MIRROR_FAILED');return{value,outcomes};
  });
  return{kind:market.kind,rawLine:market.line,rawRows:market.rawRows||null,ruleVersion:SETTLEMENT_RULE_VERSION,status:'PROVIDER_RULES_UNVERIFIED',period:null,rebateRate:null,assumption:'EXISTING_CREDIT_RULE_ARITHMETIC_ONLY',rows,executable:false};
}
