import assert from 'node:assert/strict';
import {adaptV6HistoricalTeams} from '../lib/nba/opening-v6-history-acquisition.js';
const fixture=(id,abbreviation,displayName,year,date)=>({requestedSeason:{year,type:2},events:[{season:{year,type:2},date,competitions:[{competitors:[{team:{id,abbreviation,displayName}}]}]}]});
for(const [id,abbr,name,year,date,expected] of [
  ['17','NJ','New Jersey Nets',2007,'2006-11-01T00:00:00.000Z','BKN'],
  ['17','NJ','New Jersey Nets',2011,'2010-11-01T00:00:00.000Z','BKN'],
  ['25','SEA','Seattle SuperSonics',2008,'2007-11-01T00:00:00.000Z','OKC'],
]){
  const raw=fixture(id,abbr,name,year,date),snapshot=structuredClone(raw),adapted=adaptV6HistoricalTeams(raw);
  assert.deepEqual(raw,snapshot,'raw checkpoint data must remain byte-equivalent');
  assert.equal(adapted.events[0].competitions[0].competitors[0].team.abbreviation,expected);
  assert.equal(adapted.events[0].competitions[0].competitors[0].team.id,id);
}
for(const args of [
  ['17','NJ','Different Name',2007,'2006-11-01T00:00:00.000Z'],
  ['17','NJ','New Jersey Nets',2013,'2012-11-01T00:00:00.000Z'],
  ['25','SEA','Seattle SuperSonics',2009,'2008-11-01T00:00:00.000Z'],
  ['17','SEA','Seattle SuperSonics',2007,'2006-11-01T00:00:00.000Z'],
  ['25','SEA','Seattle SuperSonics',2008,'2011-11-01T00:00:00.000Z'],
  ['25','SEA','Seattle SuperSonics','2008','2007-11-01T00:00:00.000Z'],
])assert.throws(()=>adaptV6HistoricalTeams(fixture(...args)),/ALIAS_UNVERIFIED/);
console.log('PASS V6 historical team alias allowlist: exact provider ID/name/season/date only; raw sources untouched; no unknown or future-era repair');
