import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { defaultTraining } from '../lib/nba/analysis-training.js';
import { preseasonTraining } from '../lib/nba/preseason-training.js';
import { taipeiDate } from '../lib/nba/identity.js';

const destination = process.argv[2];
if (!destination) throw Error('Supply a scratch output path');
const hash = value => createHash('sha256').update(value).digest('hex');
const expected = new Map();
for (const row of [...preseasonTraining.history, ...defaultTraining.history].filter(r => r.seasonType === 'regular')) {
  const old = expected.get(row.gameId);
  if (old && ['date','year','homeId','awayId','homeScore','awayScore','neutralSite'].some(k => old[k] !== row[k])) throw Error(`Frozen history conflict ${row.gameId}`);
  expected.set(row.gameId, row);
}
// ESPN scoreboard dates follow US calendar days. Fetch both days bracketing
// each Taipei date rather than mistaking the event's UTC day for board day.
const days = [...new Set([...expected.values()].flatMap(r => [r.date,new Date(Date.parse(r.date+'T00:00:00Z')-86400000).toISOString().slice(0,10)]))].sort();
let cached=null;
try{cached=JSON.parse(await fs.readFile(destination,'utf8'));}catch{}
const sources = cached?.sources??[], rows = new Map((cached?.history??[]).map(r=>[r.gameId,r]));
const completed=new Set(sources.map(r=>r.url));
let cursor = 0;
await Promise.all(Array.from({length: 10}, async () => {
  while (cursor < days.length) {
    const day = days[cursor++];
    const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${day.replaceAll('-','')}&limit=1000`;
    if(completed.has(url))continue;
    const response = await fetch(url,{signal:AbortSignal.timeout(30000)});
    if (!response.ok) throw Error(`Source ${response.status}: ${day}`);
    const raw = await response.text(), body = JSON.parse(raw), sourceHash = hash(raw);
    if (body.leagues?.[0]?.id !== '46' || !Array.isArray(body.events) || body.events.length >= 1000) throw Error(`Source schema/truncation: ${day}`);
    sources.push({url,sha256:sourceHash,retrievedAt:new Date().toISOString(),events:body.events.length});
    for (const event of body.events) {
      const gameId = `nba:espn:game:${event.id}`, archived = expected.get(gameId);
      if (!archived) continue;
      const c = event.competitions?.[0], home = c?.competitors?.find(t=>t.homeAway==='home'), away = c?.competitors?.find(t=>t.homeAway==='away');
      if (event.uid !== `s:40~l:46~e:${event.id}` || c?.status?.type?.completed !== true
        || event.season?.year !== archived.year || event.season?.type !== 2 || taipeiDate(event.date) !== archived.date
        || `nba:espn:team:${home?.team?.id}` !== archived.homeId || `nba:espn:team:${away?.team?.id}` !== archived.awayId
        || Number(home?.score) !== archived.homeScore || Number(away?.score) !== archived.awayScore
        || c.neutralSite !== archived.neutralSite) throw Error(`Schedule/score identity mismatch ${gameId}`);
      const half = (side,total) => {
        const q=side.linescores;
        if (!Array.isArray(q)||q.length<4||q.some((r,i)=>r.period!==i+1||!Number.isInteger(r.value)||r.value<0)
          ||q.reduce((s,r)=>s+r.value,0)!==total) throw Error(`Quarter sum mismatch ${gameId}`);
        return q[0].value+q[1].value;
      };
      const row={...archived,homeHalf:half(home,archived.homeScore),awayHalf:half(away,archived.awayScore),checkpointSha256:sourceHash};
      const prior=rows.get(gameId);
      if(prior&&['homeHalf','awayHalf'].some(k=>prior[k]!==row[k]))throw Error(`Conflicting quarters ${gameId}`);
      rows.set(gameId,row);
    }
    if(cursor%25===0)console.log(`${day}: verified ${rows.size}/${expected.size} (${cursor}/${days.length} source dates)`);
  }
}));
const missing=[...expected.keys()].filter(k=>!rows.has(k));
const history=[...rows.values()].sort((a,b)=>a.date.localeCompare(b.date)||a.gameId.localeCompare(b.gameId));
const archive={kind:'NBA_OPENING_VERIFIED_REGULAR_ARCHIVE',retrievedAt:new Date().toISOString(),sourceRole:'ESPN_scoreboard_quarters_crosschecked_against_frozen_team_schedules_not_historical_pregame_capture',sources:sources.sort((a,b)=>a.url.localeCompare(b.url)),history,missing};
await fs.writeFile(destination,JSON.stringify(archive));
if(missing.length)throw Error(`Missing ${missing.length}: ${missing.slice(0,10)}`);
console.log(JSON.stringify({saved:destination,games:history.length,sources:sources.length,sha256:hash(JSON.stringify(archive))}));
