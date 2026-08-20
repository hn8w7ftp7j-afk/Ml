import * as cheerio from 'cheerio';

const url = 'https://baseballsavant.mlb.com/leaderboard/statcast-park-factors?batSide=&condition=All&parks=mlb&rolling=3&stat=index_wOBA&type=year&year=2026';
const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 Baseball-Positive-EV-Audit' } });
const text = await response.text();
console.log(JSON.stringify({ status: response.status, bytes: text.length, url: response.url }, null, 2));
const $ = cheerio.load(text);
console.log(JSON.stringify({ title: $('title').text(), tables: $('table').length, scripts: $('script').length }, null, 2));
const match = text.match(/var data\s*=\s*(\[[\s\S]*?\]);/);
if (!match) throw new Error('Savant var data payload not found');
const data = JSON.parse(match[1]);
const parkMap = Object.fromEntries(data
  .map(row => [String(row.venue_id), {
    venueId: Number(row.venue_id),
    venueName: row.venue_name,
    teamId: Number(row.main_team_id),
    indexRuns: Number(row.index_runs),
    runFactor: Number(row.index_runs) / 100,
    indexWoba: Number(row.index_woba),
    nPa: Number(row.n_pa),
    yearRange: row.year_range,
  }])
  .sort((a, b) => Number(a[0]) - Number(b[0])));
console.log('PARK_MAP_BEGIN');
console.log(JSON.stringify(parkMap, null, 2));
console.log('PARK_MAP_END');
