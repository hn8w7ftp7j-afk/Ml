// Provider-shaped, explicitly synthetic weather/venue transport for offline
// provenance and isolation tests. These coordinates/values are not production data.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { normalizeSoccerSchedule } from '../../lib/soccer/data.js';
import { normalizeSoccerPrematch } from '../../lib/soccer/prematch.js';
export function soccerWeatherFixture(league='epl') {
  const summary=JSON.parse(readFileSync(new URL(`../fixtures/soccer/${league}-summary.json`,import.meta.url),'utf8'));
  const c=summary.header.competitions[0],game=normalizeSoccerSchedule({leagues:[summary.header.league],events:[{...summary.header,date:c.date,status:c.status}]},league,{}).games[0];
  const now=Date.parse(game.startTime)-3600000,iso=new Date(now).toISOString(),slug=league==='epl'?'eng.1':'uefa.champions';
  const source={provider:'ESPN',url:`https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/summary?event=${game.sourceId}`,
    requestedAt:iso,fetchedAt:iso,availableAt:iso,contentHash:createHash('sha256').update(JSON.stringify(summary)).digest('hex')};
  const evidence=normalizeSoccerPrematch(summary,game,source,now),rawVenue=summary.gameInfo.venue;
  const venue={venueId:String(rawVenue.id),name:rawVenue.fullName,city:rawVenue.address.city,country:rawVenue.address.country};
  const country=venue.country==='England'?'United Kingdom':venue.country,point=league==='epl'?{latitude:52.94,longitude:-1.13278}:{latitude:45.818,longitude:9.07};
  const value=id=>({rank:'normal',mainsnak:{snaktype:'value',datavalue:{type:'wikibase-entityid',value:{id}}}});
  const item=(id,label,claims={})=>({type:'item',id,labels:{en:{language:'en',value:label}},aliases:{},claims});
  const entities={Q1:item('Q1',venue.name,{P625:[{rank:'normal',mainsnak:{snaktype:'value',datavalue:{type:'globecoordinate',value:{...point,precision:0.0001,globe:'http://www.wikidata.org/entity/Q2'}}}}],P276:[value('Q3')],P17:[value('Q4')]}),Q3:item('Q3',venue.city,{P17:[value('Q4')]}),Q4:item('Q4',country)};
  const first=Math.floor(now/86400000)*86400,times=Array.from({length:72},(_,i)=>first+i*3600);
  const forecast={latitude:point.latitude,longitude:point.longitude,generationtime_ms:123,utc_offset_seconds:0,timezone:'GMT',timezone_abbreviation:'GMT',elevation:45,
    hourly_units:{time:'unixtime',temperature_2m:'°C',precipitation:'mm',wind_speed_10m:'km/h',relative_humidity_2m:'%',weather_code:'wmo code'},
    hourly:{time:times,temperature_2m:times.map((_,i)=>8+i/10),precipitation:times.map(()=>0),wind_speed_10m:times.map(()=>12),relative_humidity_2m:times.map(()=>74),weather_code:times.map(()=>3)}};
  const requests=[];
  const fetchImpl=async url=>{requests.push(String(url));const u=new URL(url);let data;
    if(u.hostname==='api.open-meteo.com')data=forecast;
    else if(u.searchParams.get('action')==='wbsearchentities')data={search:[{id:'Q1',label:venue.name,description:'synthetic offline stadium fixture'}],success:1};
    else data={entities:Object.fromEntries(u.searchParams.get('ids').split('|').map(id=>{const entity=structuredClone(entities[id]);if(entity&&!u.searchParams.get('props').split('|').includes('claims'))delete entity.claims;return [id,entity];})),success:1};
    return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
  };
  return {game,evidence,source,summary,venue,point,entities,forecast,requests,now,fetchImpl};
}
