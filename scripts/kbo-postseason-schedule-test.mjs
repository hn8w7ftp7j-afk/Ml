import assert from 'node:assert/strict';
import { fetchAsianTaipeiSlate } from '../lib/asian-baseball.js';
import { filterLeaguePrestartGames } from '../lib/league-provider.js';

// Retained Text/Class fields from the actual official 2026-10-18 schedule
// response fetched on that morning. Regular-series query returned no rows for
// this date; the combined regular/postseason query returned this scheduled row.
const monthly = { rows: [{ row: [
  { Text: '10.18(일)', Class: 'day' },
  { Text: '<b>14:00</b>', Class: 'time' },
  { Text: '<span>LG</span><em><span class="same">0</span><span>vs</span><span class="same">0</span></em><span>KIA</span>', Class: 'play' },
  { Text: '', Class: 'relay' }, { Text: '' }, { Text: 'S-T' }, { Text: '' }, { Text: '광주' }, { Text: '-' },
] }] };
// Synthetic daily-feed envelope exercises existing strict ID reconciliation.
const daily = { game: [{ LE_ID: 1, SEASON_ID: 2026, G_DT: '20261018',
  G_ID: '20261018LGHT0', HEADER_NO: 0, AWAY_ID: 'LG', HOME_ID: 'HT', G_TM: '14:00' }] };
const requests = [];
const fetchImpl = async (url, options) => {
  const params = new URLSearchParams(options.body);
  requests.push({ url, params });
  const ids = new Set((params.get('srIdList') || '').split(','));
  const payload = String(url).endsWith('/GetKboGameList') ? daily
    : ['3', '4', '5', '7'].every(id => ids.has(id)) ? monthly : { rows: [] };
  return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
};
const games = await fetchAsianTaipeiSlate('KBO', '2026-10-18', { fetchImpl });
assert.equal(games.length, 1, 'postseason games must reach Reader identity matching');
assert.equal(games[0].providerGameId, '20261018LGHT0');
assert.equal(games[0].awayCode, 'LGT');
assert.equal(games[0].homeCode, 'KIA');
assert.equal(games[0].statusCode, 'S', 'scheduled 0 vs 0 placeholders are not a final');
assert.equal(games[0].gameDate, '2026-10-18T05:00:00.000Z');
assert.equal(filterLeaguePrestartGames('KBO', games, Date.parse('2026-10-18T04:34:00Z')).length, 1);
assert.equal(filterLeaguePrestartGames('KBO', games, Date.parse('2026-10-18T05:00:00Z')).length, 0);
assert.equal(requests.length, 2, 'monthly query plus unique daily identity resolution');
for (const id of ['0', '9', '6']) assert.ok(requests[0].params.get('srIdList').split(',').includes(id), 'regular games remain included');
assert.equal(requests[0].params.get('leId'), '1', 'no Futures League mixing');
assert.equal(requests[0].params.get('seasonId'), '2026');
assert.equal(games[0].identitySourceEvidence.sourceEventIds.length, 2);
const wrongDaily = async (url, options) => String(url).endsWith('/GetKboGameList')
  ? { ok: true, status: 200, text: async () => JSON.stringify({ game: [{ ...daily.game[0], G_TM: '18:30' }] }) }
  : fetchImpl(url, options);
await assert.rejects(() => fetchAsianTaipeiSlate('KBO', '2026-10-18', { fetchImpl: wrongDaily }), error => error.code === 'KBO_OFFICIAL_IDENTITY_UNAVAILABLE');
console.log('KBO postseason schedule → unique official identity → Taipei prestart boundary PASS (actual monthly row excerpt; synthetic transport/daily envelope)');
