export const MARKET_ORDER = ['全場讓分', '全場大小', '上半讓分', '上半大小'];

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const LINE_AT_END = /(\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?)(平|[+-]\d{1,3})?$/;

export function normalizeWater(value, fallback = 0.95) {
  if (value == null || String(value).trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? clamp(n, 0.5, 1.5) : fallback;
}

export function breakEvenProbability(water) { const w = normalizeWater(water); return 1 / (1 + w); }
export function evFromProbability(probability, water) { const p = clamp(Number(probability) || 0, 0, 1), w = normalizeWater(water); return p * w - (1 - p); }

// 5.1: EV is a qualification gate and one component of the rating, not a direct EV->score conversion.
export function scoreFromEV(weightedEV, confidence = 0.75, options = {}) {
  const ev = Number(weightedEV) || 0;
  const robustEV = Number.isFinite(Number(options.robustEV)) ? Number(options.robustEV) : ev;
  const c = clamp(Number(confidence) || 0.75, 0.35, 1);
  const edge = clamp(Number(options.edgeStrength) || 0, -1, 1);
  const stability = clamp(Number(options.stability) || 0.5, 0, 1);
  const quality = clamp(Number(options.dataQuality) || c, 0.35, 1);
  const uncertainty = clamp(Number(options.uncertainty) || 0, 0, 1);

  // Neutral evaluation starts around 5.0. Positive EV, robust EV, model edge,
  // stability and information quality move it gradually instead of polarising it.
  let score = 5.0;
  score += clamp(ev / 0.02, -2.0, 2.0) * 0.55;
  score += clamp(robustEV / 0.015, -2.0, 2.0) * 0.45;
  score += edge * 0.65;
  score += (stability - 0.5) * 0.8;
  score += (quality - 0.7) * 0.8;
  score -= uncertainty * 0.65;

  // Hard eligibility rules from the user's MLB framework.
  let cap = 9.4;
  if (options.integrityWarning || options.distributionInvalid) cap = 6.6;
  else if (ev <= 0) cap = 6.6;
  else if (robustEV <= 0) cap = 7.1;
  else {
    // 7.5+, 8.0+, 8.5+ require progressively stronger EV/robust EV,
    // but passing a threshold does not automatically grant that score.
    if (ev < 0.02 || robustEV < 0.008) cap = Math.min(cap, 7.4);
    if (ev < 0.04 || robustEV < 0.02) cap = Math.min(cap, 7.9);
    if (ev < 0.07 || robustEV < 0.04) cap = Math.min(cap, 8.4);
  }
  if (c < 0.55) cap = Math.min(cap, 6.8);
  else if (c < 0.65) cap = Math.min(cap, 7.4);
  else if (c < 0.75) cap = Math.min(cap, 8.0);
  else if (c < 0.85) cap = Math.min(cap, 8.6);
  else if (c < 0.93) cap = Math.min(cap, 9.0);

  return clamp(Math.min(score, cap), 1, 9.4);
}

export function resultTag(score, candidate = 7.2, strongest = 8.5) {
  if (score >= strongest) return '最強主推';
  if (score >= 8.0) return '主推';
  if (score >= 7.5) return '正常下注';
  if (score >= candidate) return '小注候選';
  return '';
}

export function parseTaiwanLine(pick) {
  const raw = String(pick || '').replace(/\s+/g, '').slice(0, 160);
  const lineMatch = raw.match(LINE_AT_END);
  if (!lineMatch) return { raw, valid:false, isTotal:false, isOver:false, isUnder:false, isGiving:false, isReceiving:false, team:'' };
  const lineText=lineMatch[1], modifier=lineMatch[2]||'', prefix=raw.slice(0,lineMatch.index);
  const totalMarker=prefix.match(/^(大|小|over|under)$/i)?.[1]||'';
  const isOver=/^(大|over)$/i.test(totalMarker), isUnder=/^(小|under)$/i.test(totalMarker), isTotal=Boolean(totalMarker);
  const isReceiving=!isTotal&&prefix.endsWith('受讓'), isGiving=!isTotal&&!isReceiving&&prefix.endsWith('讓');
  const team=isReceiving?prefix.slice(0,-2):isGiving?prefix.slice(0,-1):'';
  const legs=lineText.split('/').map(Number).filter(Number.isFinite);
  return { raw, valid:legs.length>0&&(isTotal?(isOver||isUnder):(isGiving||isReceiving))&&Boolean(isTotal||team), isTotal,isOver,isUnder,isGiving,isReceiving,team,lineText,legs,modifier };
}

function settleStandard(value){if(value>1e-9)return 1;if(value< -1e-9)return -1;return 0}
function exactModifierOutcome(modifier,positiveSide){if(!modifier||modifier==='平')return 0;const sign=modifier[0],fraction=clamp(Number(modifier.slice(1))/100,0,1);if(!Number.isFinite(fraction))return 0;const favoriteOrOver=sign==='-'?fraction:-fraction;return positiveSide?favoriteOrOver:-favoriteOrOver}
function normName(value){return String(value||'').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g,'')}

export function outcomeFractionForScore(pick,awayRuns,homeRuns,awayName='',homeName=''){
  const p=typeof pick==='string'?parseTaiwanLine(pick):pick;if(!p?.valid)return null;
  if(awayRuns==null||homeRuns==null||String(awayRuns).trim()===''||String(homeRuns).trim()==='')return null;
  const ar=Number(awayRuns),hr=Number(homeRuns);if(!Number.isFinite(ar)||!Number.isFinite(hr))return null;const total=ar+hr;let chosenMargin=0;
  if(!p.isTotal){const team=normName(p.team),away=normName(awayName),home=normName(homeName);const isAway=team&&away&&(away.includes(team)||team.includes(away));const isHome=team&&home&&(home.includes(team)||team.includes(home));if((isAway&&isHome)||(!isAway&&!isHome))return null;chosenMargin=isAway?ar-hr:hr-ar}
  const settleLeg=line=>{if(p.isTotal){const delta=p.isOver?total-line:line-total;if(Math.abs(delta)<1e-9)return exactModifierOutcome(p.modifier,p.isOver);return settleStandard(delta)}if(p.isGiving){const delta=chosenMargin-line;if(Math.abs(delta)<1e-9)return exactModifierOutcome(p.modifier,true);return settleStandard(delta)}const delta=chosenMargin+line;if(Math.abs(delta)<1e-9)return exactModifierOutcome(p.modifier,false);return settleStandard(delta)};
  return p.legs.reduce((sum,leg)=>sum+settleLeg(leg),0)/p.legs.length;
}
export function resultLabel(fraction){if(fraction==null||!Number.isFinite(Number(fraction)))return'無法結算';const f=Number(fraction);if(Math.abs(f-1)<1e-9)return'勝';if(Math.abs(f+1)<1e-9)return'敗';if(Math.abs(f)<1e-9)return'走水';if(Math.abs(f-.5)<1e-9)return'半勝';if(Math.abs(f+.5)<1e-9)return'半敗';return`${f>0?'贏':'輸'}${Math.round(Math.abs(f)*100)}%`}
export function calculateProfit({stake,water,fraction,rebateRate=.015}){const s=Math.max(0,Number(stake)||0),w=normalizeWater(water),f=clamp(Number(fraction)||0,-1,1);if(Math.abs(f)<1e-9||s===0)return{profit:0,rebate:0,settledAmount:0};const settledAmount=s*Math.abs(f),rebate=settledAmount*Math.max(0,Number(rebateRate)||0),profit=f>0?settledAmount*w+rebate:-settledAmount+rebate;return{profit,rebate,settledAmount}}
export function priceCLV(openWater,closeWater){return breakEvenProbability(closeWater)-breakEvenProbability(openWater)}
export function extractLineToken(pick){const p=parseTaiwanLine(pick);return p.valid?`${p.lineText}${p.modifier}`:''}
export function marketIsOpen(directions){return(Array.isArray(directions)?directions:[]).some(d=>String(d?.pick||'').trim()!=='')}
export function validateMarketPair(market,directions){const ds=Array.isArray(directions)?directions.slice(0,2):[],errors=[];if(!marketIsOpen(ds))return errors;if(ds.length!==2)errors.push('已開盤市場必須有兩個方向');for(const d of ds){const pick=String(d?.pick||'').trim();if(!pick)errors.push('已開盤市場的方向＋盤口不可空白');else if(pick.length>120)errors.push('盤口文字過長');else if(!parseTaiwanLine(pick).valid)errors.push(`盤口格式無法辨識：${pick}`);if(pick&&(d?.water==null||String(d.water).trim()===''||!Number.isFinite(Number(d.water))))errors.push('已開盤市場的水位不可空白');else if(pick&&(Number(d.water)<.5||Number(d.water)>1.5))errors.push('水位範圍應為 0.500～1.500')}if(ds.length===2&&ds[0]?.pick&&ds[1]?.pick){const a=parseTaiwanLine(ds[0].pick),b=parseTaiwanLine(ds[1].pick);if(market.includes('大小')){if(!((a.isOver&&b.isUnder)||(a.isUnder&&b.isOver)))errors.push('大小盤必須是一大一小');if(extractLineToken(ds[0].pick)!==extractLineToken(ds[1].pick))errors.push('大小盤兩邊總分線不一致')}else{if(!((a.isGiving&&b.isReceiving)||(a.isReceiving&&b.isGiving)))errors.push('讓分盤必須是一讓一受讓');if(extractLineToken(ds[0].pick)!==extractLineToken(ds[1].pick))errors.push('讓分盤兩邊盤口不一致');if(normName(a.team)&&normName(a.team)===normName(b.team))errors.push('讓分盤兩個方向不可是同一隊')}}return[...new Set(errors)]}
export function normalizeVisionGame(raw,scheduleGame=null,defaultWater=.95){const away=scheduleGame?.away||String(raw?.away||'').slice(0,80),home=scheduleGame?.home||String(raw?.home||'').slice(0,80);const marketMap=[['全場讓分',raw?.fullRunline],['全場大小',raw?.fullTotal],['上半讓分',raw?.first5Runline],['上半大小',raw?.first5Total]];const markets=marketMap.map(([market,value])=>{if(market.includes('大小')){const line=String(value?.line||'').slice(0,20);return{market,directions:[{pick:line?`大${line}`:'',water:normalizeWater(value?.overWater,defaultWater),confidence:clamp(Number(value?.confidence||0),0,1)},{pick:line?`小${line}`:'',water:normalizeWater(value?.underWater,defaultWater),confidence:clamp(Number(value?.confidence||0),0,1)}]}}const line=String(value?.line||'').slice(0,20),favoriteSide=value?.favoriteSide,favorite=favoriteSide==='away'?away:favoriteSide==='home'?home:'',underdog=favoriteSide==='away'?home:favoriteSide==='home'?away:'';return{market,directions:[{pick:line&&favorite?`${favorite}讓${line}`:'',water:normalizeWater(value?.favoriteWater,defaultWater),confidence:clamp(Number(value?.confidence||0),0,1)},{pick:line&&underdog?`${underdog}受讓${line}`:'',water:normalizeWater(value?.underdogWater,defaultWater),confidence:clamp(Number(value?.confidence||0),0,1)}]}});return{away,home,gamePk:scheduleGame?.gamePk||raw?.gamePk||null,confidence:clamp(Number(raw?.confidence||0),0,1),markets}}
