// Positive Poisson-series convolution gives the independent Skellam law;
// Dixon–Coles modifies only (0,0), (0,1), (1,0), (1,1).
// https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.skellam.html
// https://dlmf.nist.gov/4.2 (exponential power series)
// Every basic arithmetic operation below rounds its enclosure outwards. exp is
// enclosed by a positive Taylor series + geometric remainder, never Math.exp.
export const SOCCER_DIFFERENCE_INTERVAL_VERSION = 'SOCCER-DC-DIFFERENCE-PAYOFF-INTERVAL-v1';
const view = new DataView(new ArrayBuffer(8));
function next(value, up) {
  if (Number.isNaN(value) || value === (up ? Infinity : -Infinity)) return value;
  if (value === 0) return up ? Number.MIN_VALUE : -Number.MIN_VALUE;
  view.setFloat64(0, value); let bits = view.getBigUint64(0);
  bits += (value > 0) === up ? 1n : -1n;
  view.setBigUint64(0, bits); return view.getFloat64(0);
}
const down = value => next(value, false), up = value => next(value, true);
const point = value => [value, value], zero = () => [0, 0];
const add = (a, b) => [down(a[0] + b[0]), up(a[1] + b[1])];
const sub = (a, b) => [down(a[0] - b[1]), up(a[1] - b[0])];
function mul(a, b) {
  const corners = [a[0]*b[0], a[0]*b[1], a[1]*b[0], a[1]*b[1]];
  return [down(Math.min(...corners)), up(Math.max(...corners))];
}
function div(a, b) {
  if (!(b[0] > 0)) throw Error('SOCCER_DIFFERENCE_INTERVAL_DIVISOR_INVALID');
  return mul(a, [down(1/b[1]), up(1/b[0])]);
}
const positive = a => [Math.max(0, a[0]), Math.max(0, a[1])];
const bounds = a => ({ lower: a[0], upper: a[1] });
const finite = value => typeof value === 'number' && Number.isFinite(value);
const cache = new Map();
function expNegative(rate) {
  let term = point(1), sum = point(1);
  for (let n=1;n<=300;n++) {
    term = div(mul(term, point(rate)), point(n)); sum = add(sum, term);
    const ratio = div(point(rate), point(n+2));
    if (ratio[1] >= 1) continue;
    const following = div(mul(term, point(rate)), point(n+1));
    const remainder = div(following, sub(point(1), ratio));
    // Error in terminating the infinite series is distinct from arithmetic
    // enclosure width, and remains included after reciprocal evaluation.
    if (remainder[1] <= sum[0] * 2**-70) {
      return div(point(1), [sum[0], up(sum[1] + remainder[1])]);
    }
  }
  throw Error('SOCCER_DIFFERENCE_EXP_NOT_CONVERGED');
}
function poisson(rate) {
  const probabilities = [expNegative(rate)];
  for (let n=1;n<=300;n++) {
    probabilities.push(positive(div(mul(probabilities[n-1], point(rate)), point(n))));
    const ratio = div(point(rate), point(n+2));
    if (ratio[1] >= 1) continue;
    const following = div(mul(probabilities[n], point(rate)), point(n+1));
    const remainder = positive(div(following, sub(point(1), ratio)));
    if (remainder[1] <= 1e-22) return { probabilities, remainder };
  }
  throw Error('SOCCER_DIFFERENCE_TAIL_NOT_CONVERGED');
}
function tau(h, a, hr, ar, rho) {
  if (h===0 && a===0) return sub(point(1), mul(mul(point(hr), point(ar)), point(rho)));
  if (h===0 && a===1) return add(point(1), mul(point(hr), point(rho)));
  if (h===1 && a===0) return add(point(1), mul(point(ar), point(rho)));
  if (h===1 && a===1) return sub(point(1), point(rho));
  return point(1);
}
/** Parameters are the exact real values represented by the supplied binary64
 * numbers. This is a numerical model-law enclosure, not model acceptance,
 * source verification, bookmaker verification or uncertainty about true EV. */
export function encloseSoccerDifferenceDistribution({ homeRate, awayRate, rho=0 }={}) {
  if (![homeRate,awayRate].every(value=>finite(value)&&value>0&&value<=30) || !finite(rho))
    throw Error('SOCCER_DIFFERENCE_PARAMETERS_INVALID');
  for(const [h,a] of [[0,0],[0,1],[1,0],[1,1]])if(!(tau(h,a,homeRate,awayRate,rho)[0]>0))
    throw Error('SOCCER_DIFFERENCE_DEPENDENCE_UNCERTAIN');
  const key=JSON.stringify([homeRate,awayRate,rho]);
  if(cache.has(key))return structuredClone(cache.get(key));
  const home=poisson(homeRate),away=poisson(awayRate),margins=new Map();
  for(let h=0;h<home.probabilities.length;h++)for(let a=0;a<away.probabilities.length;a++) {
    const p=positive(mul(mul(home.probabilities[h],away.probabilities[a]),tau(h,a,homeRate,awayRate,rho)));
    margins.set(h-a,positive(add(margins.get(h-a)||zero(),p)));
  }
  // DC changes no cell outside the first 2x2 block. The union bound accounts
  // for both infinite Poisson tails, including their intersection, safely.
  const omittedProbabilityUpper=Math.min(1,up(home.remainder[1]+away.remainder[1]));
  const rows=[...margins].sort((a,b)=>a[0]-b[0]).map(([difference,probability])=>({difference,...bounds(probability)}));
  const result={version:SOCCER_DIFFERENCE_INTERVAL_VERSION,
    method:'OUTWARD_BINARY64_POISSON_CONVOLUTION_WITH_DC_LOW_SCORE_CORRECTION',
    parameterInterpretation:'EXACT_REAL_VALUES_OF_BINARY64_INPUT_PARAMETERS',
    homeRate,awayRate,rho,rows,omittedProbabilityUpper,
    scoreRectangle:{maxHome:home.probabilities.length-1,maxAway:away.probabilities.length-1},
    infiniteSeriesRemainderIncluded:true,arithmeticRoundingIncluded:true,
    normalization:'NO_RENORMALIZATION_OR_OMITTED_MASS_DISCARD',
    accepted:false,formalEligible:false,executable:false};
  if(cache.size>=64)cache.delete(cache.keys().next().value);cache.set(key,result);
  return structuredClone(result);
}

/** Settle every possible retained score difference and enclose the infinite
 * remainder. The supplied settlement function must depend on difference only;
 * production calls this only after validating a HANDICAP settlement engine. */
export function encloseSoccerDifferencePayoff({ homeRate,awayRate,rho=0,water,rebate,settle }={}) {
  if(!finite(water)||water<=0||water>1000||!rebate||!finite(rebate.rate)||rebate.rate<0||rebate.rate>1
    ||!['NONE','TOTAL_PRINCIPAL','SETTLED_PRINCIPAL','LOSS_PRINCIPAL'].includes(rebate.basis)
    ||rebate.basis==='NONE'&&rebate.rate!==0
    ||typeof settle!=='function')throw Error('SOCCER_DIFFERENCE_PAYOFF_INPUT_INVALID');
  const d=encloseSoccerDifferenceDistribution({homeRate,awayRate,rho});
  const outcomes=Object.fromEntries(['FULL_WIN','PARTIAL_WIN','PUSH','PARTIAL_LOSS','FULL_LOSS'].map(key=>[key,zero()]));
  const totals={gross:zero(),rebate:zero(),net:zero()};
  const value=fractions=>{
    const w=point(fractions.winFraction),l=point(fractions.lossFraction);
    const gross=sub(mul(w,point(water)),l);
    const basis=rebate.basis==='TOTAL_PRINCIPAL'?point(1):rebate.basis==='SETTLED_PRINCIPAL'?add(w,l)
      :rebate.basis==='LOSS_PRINCIPAL'?l:zero();
    const r=mul(point(rebate.rate),basis);
    return{gross,rebate:r,net:add(gross,r)};
  };
  for(const row of d.rows) {
    const fractions=settle({home:Math.max(0,row.difference),away:Math.max(0,-row.difference)});
    if(!fractions||!['winFraction','lossFraction','pushFraction'].every(key=>finite(fractions[key])&&fractions[key]>=0&&fractions[key]<=1)
      ||Math.abs(fractions.winFraction+fractions.lossFraction+fractions.pushFraction-1)>1e-12)
      throw Error('SOCCER_DIFFERENCE_SETTLEMENT_INVALID');
    const outcome=fractions.winFraction===1?'FULL_WIN':fractions.lossFraction===1?'FULL_LOSS':fractions.pushFraction===1?'PUSH'
      :fractions.winFraction>0&&fractions.lossFraction===0?'PARTIAL_WIN':fractions.lossFraction>0&&fractions.winFraction===0?'PARTIAL_LOSS':null;
    if(!outcome)throw Error('SOCCER_DIFFERENCE_SETTLEMENT_UNSUPPORTED');
    const p=[row.lower,row.upper];outcomes[outcome]=positive(add(outcomes[outcome],p));
    const pay=value(fractions);for(const field of Object.keys(totals))totals[field]=add(totals[field],mul(p,pay[field]));
  }
  const extremes=[{winFraction:1,lossFraction:0},{winFraction:0,lossFraction:1},{winFraction:0,lossFraction:0}].map(value);
  const remainder=point(d.omittedProbabilityUpper);
  const evBounds=Object.fromEntries(Object.entries(totals).map(([field,total])=>{
    const low=Math.min(0,...extremes.map(item=>item[field][0]));
    const high=Math.max(0,...extremes.map(item=>item[field][1]));
    return[field,bounds(add(total,[down(remainder[1]*low),up(remainder[1]*high)]))];
  }));
  return {...Object.fromEntries(Object.entries(d).filter(([key])=>key!=='rows')),
    status:'CERTIFIED_NUMERICAL_MODEL_LAW_INTERVAL',settlementScope:'HANDICAP_DEPENDS_ONLY_ON_HOME_MINUS_AWAY',
    settlementFractionInterpretation:'EXACT_REAL_VALUES_OF_BINARY64_SETTLEMENT_ENGINE_OUTPUTS',
    probabilityBounds:Object.fromEntries(Object.entries(outcomes).map(([key,p])=>[key,{lower:Math.max(0,p[0]),upper:Math.min(1,up(p[1]+d.omittedProbabilityUpper))}])),
    evBounds,netEV:null,grossEV:null,W:null,R:null,S:null,
    interpretation:'NUMERICAL_INTEGRATION_ERROR_ONLY_NOT_CALIBRATION_OR_TRUE_EV_UNCERTAINTY'};
}
