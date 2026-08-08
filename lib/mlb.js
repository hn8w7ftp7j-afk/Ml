import { roofNameZh, statusNameZh, teamNameZh, venueNameZh } from './i18n.js';

const MLB = 'https://statsapi.mlb.com/api';
const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';

const PARKS = {
  1:{lat:33.8003,lon:-117.8827,runFactor:1.00,roof:'open'},2:{lat:39.2839,lon:-76.6217,runFactor:1.02,roof:'open'},3:{lat:42.3467,lon:-71.0972,runFactor:1.04,roof:'open'},
  5:{lat:41.4962,lon:-81.6852,runFactor:0.98,roof:'open'},6:{lat:42.339,lon:-83.0485,runFactor:0.98,roof:'open'},7:{lat:39.0517,lon:-94.4803,runFactor:0.97,roof:'open'},
  8:{lat:40.8296,lon:-73.9262,runFactor:1.03,roof:'open'},10:{lat:47.5914,lon:-122.3325,runFactor:0.96,roof:'retractable'},12:{lat:32.7473,lon:-97.0848,runFactor:1.00,roof:'retractable'},
  13:{lat:43.6414,lon:-79.3894,runFactor:1.01,roof:'retractable'},14:{lat:44.9817,lon:-93.2776,runFactor:0.99,roof:'open'},15:{lat:25.7781,lon:-80.2197,runFactor:0.97,roof:'retractable'},
  16:{lat:33.8908,lon:-84.4678,runFactor:1.01,roof:'open'},17:{lat:41.9484,lon:-87.6553,runFactor:1.01,roof:'open'},18:{lat:39.0979,lon:-84.5082,runFactor:1.06,roof:'open'},
  19:{lat:34.1683,lon:-118.3259,runFactor:1.00,roof:'open'},20:{lat:34.0739,lon:-118.24,runFactor:0.98,roof:'open'},21:{lat:43.028,lon:-87.9712,runFactor:1.00,roof:'retractable'},
  22:{lat:40.7571,lon:-73.8458,runFactor:0.97,roof:'open'},23:{lat:39.9061,lon:-75.1665,runFactor:1.04,roof:'open'},24:{lat:40.4469,lon:-80.0057,runFactor:0.97,roof:'open'},
  25:{lat:32.7073,lon:-117.1573,runFactor:0.96,roof:'open'},26:{lat:37.7786,lon:-122.3893,runFactor:0.95,roof:'open'},27:{lat:38.6226,lon:-90.1928,runFactor:0.99,roof:'open'},
  28:{lat:39.7559,lon:-104.9942,runFactor:1.20,roof:'open'},29:{lat:33.4453,lon:-112.0667,runFactor:1.04,roof:'retractable'},30:{lat:38.873,lon:-77.0074,runFactor:1.00,roof:'open'},
  2394:{lat:38.5802,lon:-121.4997,runFactor:1.00,roof:'open'}
};

const cache = new Map();
const cacheGet = key => { const value = cache.get(key); return value && value.expires > Date.now() ? value.value : null; };
const cacheSet = (key, value, ttl = 300000) => { cache.set(key, { value, expires: Date.now() + ttl }); return value; };

async function json(url, fallback = null, ttl = 300000) {
  const key = String(url), hit = cacheGet(key);
  if (hit) return hit;
  try {
    const response = await fetch(url, { cache:'no-store', headers:{'User-Agent':'MLB-Positive-EV/4.0'} });
    if (!response.ok) return fallback;
    return cacheSet(key, await response.json(), ttl);
  } catch {
    return fallback;
  }
}

export function taipeiDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
}

function isoDate(date){return new Date(date).toISOString().slice(0,10)}
function daysAgo(days){const date=new Date();date.setUTCDate(date.getUTCDate()-days);return isoDate(date)}

export async function fetchSchedule(date) {
  const url = new URL(`${MLB}/v1/schedule`);
  url.searchParams.set('sportId','1');
  url.searchParams.set('date',date);
  url.searchParams.set('hydrate','probablePitcher,team,venue,linescore');
  const payload = await json(url, {dates:[]}, 60000);
  return (payload?.dates||[]).flatMap(day=>day.games||[]).map(game=>{
    const awayEnglish = game.teams?.away?.team?.name || '';
    const homeEnglish = game.teams?.home?.team?.name || '';
    const venueEnglish = game.venue?.name || '';
    const statusEnglish = game.status?.detailedState || '';
    return {
      gamePk:game.gamePk,
      gameDate:game.gameDate,
      status:statusNameZh(statusEnglish),
      statusEnglish,
      statusCode:game.status?.statusCode||'',
      away:teamNameZh(awayEnglish),
      home:teamNameZh(homeEnglish),
      awayEnglish,
      homeEnglish,
      awayTeamId:game.teams?.away?.team?.id,
      homeTeamId:game.teams?.home?.team?.id,
      awayProbable:game.teams?.away?.probablePitcher?.fullName||'',
      homeProbable:game.teams?.home?.probablePitcher?.fullName||'',
      awayProbableId:game.teams?.away?.probablePitcher?.id||null,
      homeProbableId:game.teams?.home?.probablePitcher?.id||null,
      venue:venueNameZh(venueEnglish),
      venueEnglish,
      venueId:game.venue?.id||null,
      awayScore:game.teams?.away?.score??null,
      homeScore:game.teams?.home?.score??null,
      innings:game.linescore?.currentInning||null,
    };
  });
}

function statBlock(payload, group) {
  const blocks = (payload?.stats||[]).filter(item=>!group || item.group?.displayName?.toLowerCase()===group || item.group?.displayName===group);
  const split = blocks.flatMap(item=>item.splits||[])[0];
  const stat = split?.stat||{};
  const games = Number(stat.gamesPlayed||stat.gamesPitched||0);
  const inningsPitched = Number.parseFloat(stat.inningsPitched||0)||0;
  return {
    available:!!split,
    gamesPlayed:games,
    inningsPitched,
    runsPerGame:games?Number(stat.runs||0)/games:4.35,
    ops:Number(stat.ops||0.72)||0.72,
    avg:Number(stat.avg||0.25)||0.25,
    obp:Number(stat.obp||0.32)||0.32,
    slg:Number(stat.slg||0.4)||0.4,
    era:Number(stat.era||4.2)||4.2,
    whip:Number(stat.whip||1.3)||1.3,
    strikeOuts:Number(stat.strikeOuts||0),
    baseOnBalls:Number(stat.baseOnBalls||0),
    battersFaced:Number(stat.battersFaced||0),
    kMinusBB:Number(stat.battersFaced||0)?(Number(stat.strikeOuts||0)-Number(stat.baseOnBalls||0))/Number(stat.battersFaced):0.14,
  };
}

async function statsEndpoint(path, params) {
  const url = new URL(`${MLB}${path}`);
  Object.entries(params).forEach(([key,value])=>value!=null&&url.searchParams.set(key,String(value)));
  return json(url,null,300000);
}

export async function fetchTeamData(teamId, season) {
  const recentStart=daysAgo(14), recentEnd=isoDate(new Date());
  const [seasonH,seasonP,recentH,recentP,vsL,vsR,injuries] = await Promise.all([
    statsEndpoint(`/v1/teams/${teamId}/stats`,{stats:'season',group:'hitting',season}),
    statsEndpoint(`/v1/teams/${teamId}/stats`,{stats:'season',group:'pitching',season}),
    statsEndpoint(`/v1/teams/${teamId}/stats`,{stats:'byDateRange',group:'hitting',startDate:recentStart,endDate:recentEnd,season}),
    statsEndpoint(`/v1/teams/${teamId}/stats`,{stats:'byDateRange',group:'pitching',startDate:recentStart,endDate:recentEnd,season}),
    statsEndpoint(`/v1/teams/${teamId}/stats`,{stats:'season',group:'hitting',sitCodes:'vl',season}),
    statsEndpoint(`/v1/teams/${teamId}/stats`,{stats:'season',group:'hitting',sitCodes:'vr',season}),
    statsEndpoint('/v1/injuries',{teamId}),
  ]);
  return {
    seasonHitting:statBlock(seasonH,'hitting'),
    seasonPitching:statBlock(seasonP,'pitching'),
    recentHitting:statBlock(recentH,'hitting'),
    recentPitching:statBlock(recentP,'pitching'),
    vsLeft:statBlock(vsL,'hitting'),
    vsRight:statBlock(vsR,'hitting'),
    injuriesAvailable:Array.isArray(injuries?.injuries),
    injuries:Array.isArray(injuries?.injuries)?injuries.injuries.map(item=>({player:item.player?.fullName||'',status:item.status||item.description||'',date:item.date||''})):[],
  };
}

export async function fetchPitcherData(personId, season) {
  if (!personId) return {available:false};
  const recentStart=daysAgo(35),recentEnd=isoDate(new Date());
  const [person,seasonStats,recentStats] = await Promise.all([
    json(`${MLB}/v1/people/${personId}`,null,3600000),
    statsEndpoint(`/v1/people/${personId}/stats`,{stats:'season',group:'pitching',season}),
    statsEndpoint(`/v1/people/${personId}/stats`,{stats:'byDateRange',group:'pitching',startDate:recentStart,endDate:recentEnd,season}),
  ]);
  const player=person?.people?.[0]||{};
  return {available:true,id:personId,name:player.fullName||'',throws:player.pitchHand?.code||'',season:statBlock(seasonStats,'pitching'),recent:statBlock(recentStats,'pitching')};
}

export async function fetchFeed(gamePk) {
  if (!gamePk) return null;
  return json(`${MLB}/v1.1/game/${gamePk}/feed/live`,null,30000);
}

function parseLineup(feed, side) {
  const team=feed?.liveData?.boxscore?.teams?.[side];
  const players=team?.players||{};
  const rows=Object.values(players).filter(player=>player?.battingOrder).sort((a,b)=>Number(a.battingOrder)-Number(b.battingOrder));
  const catcher=Object.values(players).find(player=>player?.position?.abbreviation==='C'&&player?.battingOrder);
  return {official:rows.length>=8,players:rows.map(player=>({name:player.person?.fullName||'',position:player.position?.abbreviation||'',battingOrder:Number(player.battingOrder)})),catcher:catcher?.person?.fullName||'',missingCoreCount:0};
}

function parseUmpire(feed){return (feed?.liveData?.boxscore?.officials||[]).find(item=>item.officialType==='Home Plate')?.official?.fullName||''}

async function fetchRecentSchedule(teamId, beforeDate) {
  const end=new Date(beforeDate);end.setUTCDate(end.getUTCDate()-1);
  const start=new Date(end);start.setUTCDate(start.getUTCDate()-6);
  const url=new URL(`${MLB}/v1/schedule`);
  url.searchParams.set('sportId','1');url.searchParams.set('teamId',teamId);url.searchParams.set('startDate',isoDate(start));url.searchParams.set('endDate',isoDate(end));url.searchParams.set('hydrate','venue,linescore');
  const payload=await json(url,{dates:[]},120000);
  return (payload?.dates||[]).flatMap(day=>day.games||[]).filter(game=>game.status?.abstractGameState==='Final').sort((a,b)=>new Date(b.gameDate)-new Date(a.gameDate));
}

function haversine(a,b){if(!a||!b)return 0;const radius=6371,rad=value=>value*Math.PI/180,dlat=rad(b.lat-a.lat),dlon=rad(b.lon-a.lon),value=Math.sin(dlat/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dlon/2)**2;return 2*radius*Math.asin(Math.sqrt(value))}

async function restData(teamId, gameDate, venueId) {
  const rows=await fetchRecentSchedule(teamId,gameDate);
  const previous=rows[0];
  if(!previous)return {days:2,travelKm:0,previousExtraInnings:false,lastGame:null};
  const days=Math.max(0,Math.floor((new Date(gameDate)-new Date(previous.gameDate))/86400000));
  const from=PARKS[Number(previous.venue?.id)],to=PARKS[Number(venueId)];
  const venueEnglish=previous.venue?.name||'';
  return {days,travelKm:Math.round(haversine(from,to)),previousExtraInnings:Number(previous.linescore?.currentInning||9)>9,lastGame:{gamePk:previous.gamePk,venue:venueNameZh(venueEnglish),innings:previous.linescore?.currentInning||9}};
}

export async function fetchWeather(game) {
  const park=PARKS[Number(game.venueId)];
  if(!park)return {available:false};
  const url=new URL(OPEN_METEO);
  url.searchParams.set('latitude',park.lat);url.searchParams.set('longitude',park.lon);url.searchParams.set('hourly','temperature_2m,precipitation_probability,wind_speed_10m,wind_direction_10m');url.searchParams.set('forecast_days','3');url.searchParams.set('timezone','UTC');
  const payload=await json(url,null,900000);
  if(!payload?.hourly?.time)return {available:false};
  const target=new Date(game.gameDate).getTime();let best=0,difference=Infinity;
  payload.hourly.time.forEach((value,index)=>{const current=Math.abs(new Date(`${value}Z`).getTime()-target);if(current<difference){difference=current;best=index}});
  return {available:true,temperature:payload.hourly.temperature_2m?.[best]??null,precipitationProbability:payload.hourly.precipitation_probability?.[best]??null,windSpeed:payload.hourly.wind_speed_10m?.[best]??null,windDirection:payload.hourly.wind_direction_10m?.[best]??null,time:payload.hourly.time?.[best]||''};
}

export async function buildGameContext(game) {
  const season=new Date(game.gameDate||Date.now()).getUTCFullYear();
  const [awayTeam,homeTeam,awayStarter,homeStarter,feed,weather,awayRest,homeRest] = await Promise.all([
    fetchTeamData(game.awayTeamId,season),fetchTeamData(game.homeTeamId,season),
    fetchPitcherData(game.awayProbableId,season),fetchPitcherData(game.homeProbableId,season),
    fetchFeed(game.gamePk),fetchWeather(game),restData(game.awayTeamId,game.gameDate,game.venueId),restData(game.homeTeamId,game.gameDate,game.venueId),
  ]);
  const parkBase=PARKS[Number(game.venueId)]||{runFactor:1,roof:'unknown'};
  const park={...parkBase,name:game.venue||venueNameZh(game.venueEnglish),nameEnglish:game.venueEnglish||'',roofZh:roofNameZh(parkBase.roof)};
  const away={...awayTeam,starter:awayStarter,lineup:parseLineup(feed,'away'),rest:awayRest,bullpen:{fatigueIndex:awayRest.previousExtraInnings?0.65:awayRest.days<=0?0.45:0.15}};
  const home={...homeTeam,starter:homeStarter,lineup:parseLineup(feed,'home'),rest:homeRest,bullpen:{fatigueIndex:homeRest.previousExtraInnings?0.65:homeRest.days<=0?0.45:0.15}};
  const warnings=[];
  if(!awayStarter.available||!homeStarter.available)warnings.push('先發投手資料未完整');
  if(!away.lineup.official||!home.lineup.official)warnings.push('正式打線尚未完整公布，採用中性情境');
  if(!weather.available)warnings.push('天氣資料暫時無法取得');
  return {game,away,home,weather,park,umpire:parseUmpire(feed),warnings,fetchedAt:new Date().toISOString()};
}

export async function fetchFinalResult(gamePk) {
  const feed=await fetchFeed(gamePk);
  const state=feed?.gameData?.status?.abstractGameState||'';
  const away=feed?.liveData?.linescore?.teams?.away?.runs;
  const home=feed?.liveData?.linescore?.teams?.home?.runs;
  const innings=feed?.liveData?.linescore?.innings||[];
  const awayFirst5=innings.slice(0,5).reduce((sum,inning)=>sum+Number(inning?.away?.runs||0),0);
  const homeFirst5=innings.slice(0,5).reduce((sum,inning)=>sum+Number(inning?.home?.runs||0),0);
  const statusEnglish=feed?.gameData?.status?.detailedState||state;
  return {final:state==='Final'&&Number.isFinite(Number(away))&&Number.isFinite(Number(home)),awayRuns:Number(away),homeRuns:Number(home),awayFirst5,homeFirst5,status:statusNameZh(statusEnglish),statusEnglish};
}
