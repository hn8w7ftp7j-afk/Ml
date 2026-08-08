export const MARKET_ORDER = ['全場讓分', '全場大小', '上半讓分', '上半大小'];

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

export function normalizeWater(value, fallback = 0.95) {
  if (value == null || String(value).trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? clamp(n, 0.5, 1.5) : fallback;
}

export function breakEvenProbability(water) { const w=normalizeWater(water); return 1/(1+w); }
export function evFromProbability(probability, water) { const p=clamp(Number(probability)||0,0,1),w=normalizeWater(water); return p*w-(1-p); }
export function scoreFromEV(weightedEV, confidence=.75) { const ev=Number(weightedEV)||0,c=clamp(Number(confidence)||.75,.35,1),raw=ev>=0?5+ev*50*c:5+ev*30; return clamp(raw,1,9.6); }
export function resultTag(score,candidate=7.2,strongest=8.5){if(score>=strongest)return'最強主推';if(score>=candidate)return'下注候選';return''}

export function parseTaiwanLine(pick) {
  const raw=String(pick||'').replace(/\s+/g,''),isTotal=/大|小|over|under/i.test(raw),isOver=/大|over/i.test(raw),isUnder=/小|under/i.test(raw),isGiving=/讓/.test(raw)&&!/受讓/.test(raw),isReceiving=/受讓/.test(raw);
  const team=raw.replace(/受讓|讓|大|小|over|under/gi,'').replace(/\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?(?:平|[+-]\d{1,3})?/g,'');
  const match=raw.match(/(\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?)(平|[+-]\d{1,3})?/);
  if(!match)return{raw,valid:false,isTotal,isOver,isUnder,isGiving,isReceiving,team};
  const lineText=match[1],modifier=match[2]||'',legs=lineText.split('/').map(Number).filter(Number.isFinite);
  return{raw,valid:legs.length>0&&(isTotal?isOver||isUnder:isGiving||isReceiving),isTotal,isOver,isUnder,isGiving,isReceiving,team,lineText,legs,modifier};
}
function settleStandard(v){return v>1e-9?1:v<-1e-9?-1:0}
function exactModifierOutcome(modifier,positiveSide){if(!modifier||modifier==='平')return 0;const sign=modifier[0],fraction=clamp(Number(modifier.slice(1))/100,0,1);if(!Number.isFinite(fraction))return 0;const x=sign==='-'?fraction:-fraction;return positiveSide?x:-x}
export function outcomeFractionForScore(pick,awayRuns,homeRuns,awayName='',homeName=''){
 const p=typeof pick==='string'?parseTaiwanLine(pick):pick;if(!p?.valid)return null;if(awayRuns==null||homeRuns==null||String(awayRuns).trim()===''||String(homeRuns).trim()==='')return null;const ar=Number(awayRuns),hr=Number(homeRuns);if(!Number.isFinite(ar)||!Number.isFinite(hr))return null;const total=ar+hr;let chosenMargin=0;
 if(!p.isTotal){const norm=v=>String(v||'').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g,''),t=norm(p.team),a=norm(awayName),h=norm(homeName),isAway=t&&a&&(a.includes(t)||t.includes(a)),isHome=t&&h&&(h.includes(t)||t.includes(h));if(!isAway&&!isHome)return null;chosenMargin=isAway?ar-hr:hr-ar}
 const leg=line=>{if(p.isTotal){const d=p.isOver?total-line:line-total;return Math.abs(d)<1e-9?exactModifierOutcome(p.modifier,p.isOver):settleStandard(d)}if(p.isGiving){const d=chosenMargin-line;return Math.abs(d)<1e-9?exactModifierOutcome(p.modifier,true):settleStandard(d)}const d=chosenMargin+line;return Math.abs(d)<1e-9?exactModifierOutcome(p.modifier,false):settleStandard(d)};
 return p.legs.reduce((s,l)=>s+leg(l),0)/p.legs.length;
}
export function resultLabel(f){if(f==null||!Number.isFinite(Number(f)))return'無法結算';f=Number(f);if(Math.abs(f-1)<1e-9)return'勝';if(Math.abs(f+1)<1e-9)return'敗';if(Math.abs(f)<1e-9)return'走水';if(Math.abs(f-.5)<1e-9)return'半勝';if(Math.abs(f+.5)<1e-9)return'半敗';return`${f>0?'贏':'輸'}${Math.round(Math.abs(f)*100)}%`}
export function calculateProfit({stake,water,fraction,rebateRate=.015}){const s=Math.max(0,Number(stake)||0),w=normalizeWater(water),f=clamp(Number(fraction)||0,-1,1);if(Math.abs(f)<1e-9||s===0)return{profit:0,rebate:0,settledAmount:0};const settledAmount=s*Math.abs(f),rebate=settledAmount*Math.max(0,Number(rebateRate)||0),profit=f>0?settledAmount*w+rebate:-settledAmount+rebate;return{profit,rebate,settledAmount}}
export function priceCLV(openWater,closeWater){return breakEvenProbability(closeWater)-breakEvenProbability(openWater)}
export function extractLineToken(pick){const p=parseTaiwanLine(pick);return p.valid?`${p.lineText}${p.modifier}`:''}

// A market is considered unopened when neither side has a pick. Unopened markets are valid and are skipped.
export function marketIsOpen(directions){return (Array.isArray(directions)?directions:[]).some(d=>String(d?.pick||'').trim()!=='')}
export function validateMarketPair(market,directions){
 const ds=Array.isArray(directions)?directions.slice(0,2):[];
 if(!marketIsOpen(ds)) return [];
 const errors=[];
 if(ds.length!==2)errors.push('已開盤市場必須有兩個方向');
 for(const d of ds){if(!d?.pick)errors.push('已開盤市場的方向＋盤口不可空白');else if(!parseTaiwanLine(d.pick).valid)errors.push(`盤口格式無法辨識：${d.pick}`);if(d?.pick&&(d?.water==null||String(d.water).trim()===''||!Number.isFinite(Number(d.water))))errors.push('已開盤市場的水位不可空白');else if(d?.pick&&(Number(d.water)<.5||Number(d.water)>1.5))errors.push('水位範圍應為 0.500～1.500')}
 if(ds.length===2&&ds[0]?.pick&&ds[1]?.pick){const a=parseTaiwanLine(ds[0].pick),b=parseTaiwanLine(ds[1].pick);if(market.includes('大小')){if(!(a.isOver&&b.isUnder)&&!(a.isUnder&&b.isOver))errors.push('大小盤必須是一大一小');if(extractLineToken(ds[0].pick)!==extractLineToken(ds[1].pick))errors.push('大小盤兩邊總分線不一致')}else{if(!(a.isGiving&&b.isReceiving)&&!(a.isReceiving&&b.isGiving))errors.push('讓分盤必須是一讓一受讓');if(extractLineToken(ds[0].pick)!==extractLineToken(ds[1].pick))errors.push('讓分盤兩邊盤口不一致')}}
 return[...new Set(errors)];
}

export function normalizeVisionGame(raw,scheduleGame=null,defaultWater=.95){
 const away=scheduleGame?.away||String(raw?.away||''),home=scheduleGame?.home||String(raw?.home||'');
 const marketMap=[['全場讓分',raw?.fullRunline],['全場大小',raw?.fullTotal],['上半讓分',raw?.first5Runline],['上半大小',raw?.first5Total]];
 const markets=marketMap.map(([market,value])=>{if(market.includes('大小')){const line=String(value?.line||'');return{market,directions:[{pick:line?`大${line}`:'',water:normalizeWater(value?.overWater,defaultWater),confidence:Number(value?.confidence||0)},{pick:line?`小${line}`:'',water:normalizeWater(value?.underWater,defaultWater),confidence:Number(value?.confidence||0)}]}}const line=String(value?.line||''),favoriteSide=value?.favoriteSide,favorite=favoriteSide==='away'?away:favoriteSide==='home'?home:'',underdog=favoriteSide==='away'?home:favoriteSide==='home'?away:'';return{market,directions:[{pick:line&&favorite?`${favorite}讓${line}`:'',water:normalizeWater(value?.favoriteWater,defaultWater),confidence:Number(value?.confidence||0)},{pick:line&&underdog?`${underdog}受讓${line}`:'',water:normalizeWater(value?.underdogWater,defaultWater),confidence:Number(value?.confidence||0)}]}});
 return{away,home,gamePk:scheduleGame?.gamePk||raw?.gamePk||null,confidence:Number(raw?.confidence||0),markets};
}
