import './league-registry.js';
import './soccer-teams.js';
const clean=v=>String(v??'').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim();
const homeMarker=/[\[［【(（]\s*主\s*[\]］】)）]/u;
const line=/^(?:\d+(?:\.\d+)?)(?:平|[+-]\d{1,3})?$/;
const locked=v=>/^[-－—]$/.test(clean(v));
export const soccerRowsUnavailable = rows => Array.isArray(rows) && rows.every(v=>!clean(v)||/^(?:(?:主[勝胜]|客[勝胜]|和|大|小)\s*)?[-－—]$/.test(clean(v)));
function split(value) {
  const text=clean(value).replace(/＋/g,'+').replace(/[－–—−]/g,'-').replace(/(\d)\s*([+-])\s*(\d{1,3})(?=\s|$)/g,'$1$2$3').replace(/(\d)\s+平/g,'$1平');
  if(locked(text)||!text)return null;
  const m=text.match(/^(.*?)\s*(\d{1,4}\.\d{1,3})$/);
  if(!m)return null;
  const water=Number(m[2]);
  if(!(water>0&&water<=1000))return null;
  return {head:clean(m[1]),water};
}
export function soccerMarket(key, rows) {
  if(!Array.isArray(rows))return null;
  if(key==='moneyline') {
    if(rows.length!==3||rows.every(locked))return null;
    const parsed=rows.map(split);
    if(parsed.some(x=>!x)||!/^主[勝胜]$/.test(parsed[0].head)||!/^和$/.test(parsed[1].head)||!/^客[勝胜]$/.test(parsed[2].head))return null;
    return {kind:'MONEYLINE',unit:'GOALS',homeWater:parsed[0].water,drawWater:parsed[1].water,awayWater:parsed[2].water,rawRows:rows.map(clean)};
  }
  if(rows.length!==2)return null;
  const parsed=rows.map(split);if(parsed.some(x=>!x))return null;
  if(key==='runline') {
    const present=parsed.map((x,i)=>line.test(x.head)?i:-1).filter(x=>x>=0);
    if(present.length!==1||parsed[1-present[0]].head!=='')return null;
    return {kind:'HANDICAP',unit:'GOALS',line:parsed[present[0]].head,lineSide:present[0]===0?'away':'home',awayWater:parsed[0].water,homeWater:parsed[1].water,rawRows:rows.map(clean)};
  }
  if(key==='total'&&/^大/.test(parsed[0].head)&&line.test(parsed[0].head.slice(1))&&parsed[1].head==='小')return {kind:'TOTAL',unit:'GOALS',line:parsed[0].head.slice(1),overWater:parsed[0].water,underWater:parsed[1].water,rawRows:rows.map(clean)};
  return null;
}
export function soccerMarketKey(m) { return [['FT','HT'].includes(m.period)?m.period:'UNKNOWN',m.kind,m.unit,m.line||'',m.lineSide||''].join(':'); }
function timing(pair, now) {
  if(!Array.isArray(pair)||!/^\d{1,2}[/-]\d{1,2}$/.test(pair[0])||!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(pair[1]))return null;
  const [month,day]=pair[0].split(/[/-]/).map(Number), year=Number(new Intl.DateTimeFormat('en',{timeZone:'Asia/Taipei',year:'numeric'}).format(now));
  const candidates=[year-1,year,year+1].map(y=>`${y}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`).filter(d=>{const x=new Date(`${d}T00:00Z`);return Number.isFinite(x.getTime())&&x.toISOString().slice(0,10)===d;}).sort((a,b)=>Math.abs(Date.parse(`${a}T${pair[1]}:00+08:00`)-now)-Math.abs(Date.parse(`${b}T${pair[1]}:00+08:00`)-now));
  return candidates[0]?{boardDate:candidates[0],boardTime:pair[1]}:null;
}
export function parseSoccerCapture(capture, now=new Date()) {
  const league=['EPL','UCL'].includes(capture?.league)?capture.league:'';
  const label=clean(capture?.pageLeagueLabel||capture?.diagnostics?.pageLeagueLabel);
  const games=new Map(),issues=[];
  if(!league||!globalThis.Tai888LeagueRegistry.standardMarker(label,league))issues.push('SOCCER_LEAGUE_HEADER_UNCONFIRMED');
  if(!issues.length)for(const table of (capture.tables||[]).slice(0,12))for(const row of (table.rows||[]).slice(0,100)) {
    if(globalThis.Tai888LeagueRegistry.identifyAll(table.sectionTitle).some(id=>id!==league)){issues.push('SOCCER_SECTION_LEAGUE_MISMATCH');continue;}
    const cells=row.cells||[],team=cells[1]?.pair;
    if(!Array.isArray(team)||team.length!==2||team.some(x=>/角球|罰牌|罚牌|CORNER|黃牌|黄牌|紅牌|红牌/i.test(x)))continue;
    const away=globalThis.Tai888SoccerTeams.resolve(team[0]),home=globalThis.Tai888SoccerTeams.resolve(team[1]);
    const time=timing(cells[0]?.pair,now);
    if(!away||!home||away.key===home.key||homeMarker.test(team[0])||!homeMarker.test(team[1])||!time){issues.push('SOCCER_GAME_IDENTITY_INVALID');continue;}
    const markets=[],periodsCovered=new Set(),periodStates={};let explicitlyClosed=false;
    for(const [i,key]of [[2,'runline'],[3,'total'],[4,'moneyline']]){
      const raw=cells[i]?.pair;if(!Array.isArray(raw))continue;
      const periodEvidence=globalThis.Tai888LeagueRegistry.soccerPeriodEvidence({sectionTitle:table.sectionTitle||label,headers:table.headers,marketHeader:table.headers?.[i],truncated:table.periodEvidenceTruncated});
      if(periodEvidence.status==='EXCLUDED')continue;
      const lockedRows=soccerRowsUnavailable(raw)&&raw.some(value=>/[-－—]/.test(clean(value)));
      const m=soccerMarket(key,raw);
      if(m){markets.push({...m,period:periodEvidence.period,periodEvidence});periodsCovered.add(periodEvidence.period);periodStates[periodEvidence.period]='open';}
      else if(lockedRows){explicitlyClosed=true;periodsCovered.add(periodEvidence.period);periodStates[periodEvidence.period]||='locked';}
      else if(!soccerRowsUnavailable(raw))issues.push(`SOCCER_MARKET_UNRECOGNIZED:${key}`);
    }
    if(!markets.length&&!explicitlyClosed)continue;
    const id=[time.boardDate,time.boardTime,away.code,home.code].join('|');
    const game=games.get(id)||{league,...time,awayCode:away.code,homeCode:home.code,awayRaw:team[0],homeRaw:team[1],awayKey:away.key,homeKey:home.key,marketStatus:markets.length?'open':'locked',markets:[],periodsCovered:[],periodStates:{},executable:false};
    game.periodsCovered=[...new Set([...game.periodsCovered,...periodsCovered])].sort();
    for(const [period,state]of Object.entries(periodStates))if(game.periodStates[period]!=='open')game.periodStates[period]=state;
    if(markets.length)game.marketStatus='open';
    for(const m of markets){const prior=game.markets.find(x=>soccerMarketKey(x)===soccerMarketKey(m));if(prior&&JSON.stringify(prior)!==JSON.stringify(m))issues.push('SOCCER_CONTRACT_PRICE_CONFLICT');else if(!prior)game.markets.push(m);}
    games.set(id,game);
  }
  const values=[...games.values()].sort((a,b)=>`${a.boardDate}${a.boardTime}${a.awayCode}`.localeCompare(`${b.boardDate}${b.boardTime}${b.awayCode}`));
  return {version:'TAI888-SOCCER-READER-v1',interfaceVersion:'SOCCER-READER-v1',provider:'TAI888_READER',league,pageLeagueLabel:label,sourceHost:capture?.sourceHost||'',pageUrl:capture?.pageUrl||'',observedAt:capture?.observedAt||now.toISOString(),boardDate:values[0]?.boardDate||'',games:values.slice(0,40),periodsCovered:[...new Set(values.slice(0,40).flatMap(game=>game.periodsCovered))].sort(),parseIssues:[...new Set(issues)],sourceCapture:{league,pageLeagueLabel:label,tables:capture?.tables||[]},executable:false};
}
function canonicalMarket(m){
  // Legacy captures did not assert a period. They remain UNKNOWN without a hash migration.
  if(!m.period||m.period==='UNKNOWN'){const{period,periodEvidence,...legacy}=m;return legacy;}
  return m;
}
export function canonicalSoccerPayload(payload){return JSON.stringify({league:payload.league,boardDate:payload.boardDate,pageLeagueLabel:payload.pageLeagueLabel,...(Array.isArray(payload.periodsCovered)?{periodsCovered:[...payload.periodsCovered].sort()}:{}),games:[...(payload.games||[])].map(g=>({...g,markets:[...(g.markets||[])].sort((a,b)=>soccerMarketKey(a).localeCompare(soccerMarketKey(b))).map(canonicalMarket)})).sort((a,b)=>`${a.boardDate}${a.boardTime}${a.awayCode}`.localeCompare(`${b.boardDate}${b.boardTime}${b.awayCode}`))},(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);}
