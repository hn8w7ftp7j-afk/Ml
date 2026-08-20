import * as cheerio from 'cheerio';

const url = 'https://baseballsavant.mlb.com/leaderboard/statcast-park-factors?batSide=&condition=All&parks=mlb&rolling=3&stat=index_wOBA&type=year&year=2026';
const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 Baseball-Positive-EV-Audit' } });
const text = await response.text();
console.log(JSON.stringify({ status: response.status, bytes: text.length, url: response.url }, null, 2));
const $ = cheerio.load(text);
console.log(JSON.stringify({ title: $('title').text(), tables: $('table').length, scripts: $('script').length }, null, 2));
for (const [index, table] of $('table').toArray().entries()) {
  const headers = $(table).find('thead th').map((_, el) => $(el).text().replace(/\s+/g, ' ').trim()).get();
  const rows = $(table).find('tbody tr').slice(0, 35).map((_, tr) => $(tr).find('th,td').map((__, td) => $(td).text().replace(/\s+/g, ' ').trim()).get()).get();
  console.log(`TABLE ${index}`, JSON.stringify({ headers, rows }, null, 2));
}
const needles = ['Great American Ball Park', 'Coors Field', 'park_name', 'venue_name', 'index_wOBA'];
for (const needle of needles) {
  const at = text.indexOf(needle);
  console.log(`NEEDLE ${needle} @ ${at}`);
  if (at >= 0) console.log(text.slice(Math.max(0, at - 600), Math.min(text.length, at + 1400)));
}
