export const MARKET_ORDER=['全場讓分','全場大小','上半讓分','上半大小'];
export function normalizeWater(v){const n=Number(v);if(!Number.isFinite(n))return .95;return Math.max(.5,Math.min(1.5,n));}
export function evFromProbability(probability,water){const p=Math.max(0,Math.min(1,Number(probability)));const w=normalizeWater(water);return p*w-(1-p);}
export function scoreFromEV(weightedEv,confidence=.75){const e=Number(weightedEv)||0,c=Math.max(.35,Math.min(1,Number(confidence)||.75));return Math.max(1,Math.min(9.8,5+e*40*c));}
export function resultTag(score){if(score>=8.5)return '最強主推';if(score>=7.2)return '下注候選';return '';}
