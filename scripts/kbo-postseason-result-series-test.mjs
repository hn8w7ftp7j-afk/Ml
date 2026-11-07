import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { asianLeagueConfig, fetchAsianFinalResult, parseKboOfficialSchedulePayload, resolveKboResultSeries } from '../lib/asian-baseball.js';
import { parseKboResultLinescore } from '../lib/kbo-result-linescore.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/kbo-postseason-result-official-202610.json', import.meta.url), 'utf8'));

function replay(sample, daily = sample.daily) {
  const requests = [];
  return { requests, fetchImpl: async (url, options) => {
    const body = new URLSearchParams(options.body);
    requests.push({ url: String(url), body });
    let payload;
    if (String(url).endsWith('/GetScheduleList')) payload = sample.monthly;
    else if (String(url).endsWith('/GetKboGameList')) payload = daily;
    else if (String(url).endsWith('/GetScoreBoardScroll')) {
      assert.equal(body.get('gameId'), sample.providerGameId);
      payload = body.get('srId') === '3' ? sample.scoreboard : sample.wrongSeriesScoreboard;
    } else throw new Error(`Unexpected source: ${url}`);
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  } };
}

for (const [index, sample] of fixture.cases.entries()) {
  const date = `${sample.providerGameId.slice(0, 4)}-${sample.providerGameId.slice(4, 6)}-${sample.providerGameId.slice(6, 8)}`;
  const [schedule] = parseKboOfficialSchedulePayload(sample.monthly, date);
  assert.equal(schedule.providerGameId, sample.providerGameId);
  assert.equal(schedule.gamePk, sample.ledgerGamePk, 'retain the existing production game identity');
  assert.equal(schedule.statusCode, 'F');
  assert.throws(() => parseKboResultLinescore(sample.wrongSeriesScoreboard, schedule), /尚未完賽或主客隊識別不一致/,
    'the actual regular-season lookup fails for these completed postseason games');

  const mock = replay(sample);
  const result = await fetchAsianFinalResult('KBO', sample.ledgerGamePk, date, { fetchImpl: mock.fetchImpl });
  assert.equal(result.final, true);
  assert.equal(result.gamePk, sample.ledgerGamePk);
  assert.equal(result.providerGameId, sample.providerGameId);
  assert.equal(result.innings, 9);
  assert.equal(result.first5Complete, true);
  assert.deepEqual([result.awayRuns, result.homeRuns, result.awayFirst5, result.homeFirst5],
    index === 0 ? [3, 6, 2, 5] : [13, 1, 8, 0]);
  assert.equal(mock.requests.length, 3);
  assert.match(mock.requests[1].url, /GetKboGameList$/);
  assert.equal(mock.requests[1].body.get('date'), sample.providerGameId.slice(0, 8));
  assert.equal(mock.requests[2].body.get('srId'), '3', 'series comes from the unique official daily identity');
  assert.equal(result.game.resultSeriesIdentity.seriesId, 3);
  assert.equal(result.game.resultSeriesIdentity.sourcePath, '$.game[0]');
  assert.equal(result.game.identitySourceEvidence.sourceEventIds.length, 1);
  const evidence = result.game.resultSourceEvidence;
  assert.equal(evidence.complete, true);
  assert.equal(evidence.sourceEventIds.length, 2);
  assert.equal(evidence.events.every(event => event.success && event.method === 'POST'), true);
  assert.equal(Object.keys(evidence.contents).length, 2, 'retain both official response bodies for replay');
  assert.equal(evidence.events[1].requestBodyHash,
    createHash('sha256').update(String(mock.requests[2].body)).digest('hex'));
  const content = evidence.contents[evidence.events[1].contentHash];
  assert.deepEqual(JSON.parse(gunzipSync(Buffer.from(content.data, 'base64')).toString()), sample.scoreboard);

  const original = structuredClone(sample.daily);
  for (const seriesId of [0, 1, 3, 4, 5, 6, 7, 8, 9]) {
    const daily = { game: [{ ...sample.daily.game[0], SR_ID: seriesId }] };
    assert.equal(resolveKboResultSeries(schedule, daily, date).resultSeriesIdentity.seriesId, seriesId,
      'do not replace one assumed series with another assumed series');
  }
  const badDaily = [
    {}, { game: [] }, { game: [sample.daily.game[0], sample.daily.game[0]] },
    ...[{ SR_ID: undefined }, { SR_ID: null }, { SR_ID: '' }, { SR_ID: '3,0' }, { SR_ID: 2 },
      { LE_ID: 2 }, { SEASON_ID: 2025 }, { G_DT: '20261017' }, { G_ID: '20261018HTLG0' },
      { AWAY_ID: sample.daily.game[0].HOME_ID, HOME_ID: sample.daily.game[0].AWAY_ID },
      { HEADER_NO: 1 }].map(patch => ({ game: [{ ...sample.daily.game[0], ...patch }] })),
  ];
  for (const daily of badDaily) {
    const invalid = replay(sample, daily);
    await assert.rejects(() => fetchAsianFinalResult('KBO', sample.ledgerGamePk, date, { fetchImpl: invalid.fetchImpl }),
      error => error.code === 'KBO_RESULT_SERIES_IDENTITY_UNAVAILABLE');
    assert.equal(invalid.requests.some(request => request.url.endsWith('/GetScoreBoardScroll')), false,
      'missing or conflicting identity must never fall back to a default series');
  }
  assert.throws(() => resolveKboResultSeries({ ...schedule, league: 'NPB' }, sample.daily, date),
    error => error.code === 'KBO_RESULT_SERIES_IDENTITY_UNAVAILABLE');
  assert.deepEqual(sample.daily, original, 'lookup must not mutate official identity evidence');
}

const ties = JSON.parse(await readFile(new URL('./fixtures/kbo-tie-schedule-official-20260910.json', import.meta.url), 'utf8'));
for (const [index, sample] of ties.cases.entries()) {
  const result = parseKboOfficialSchedulePayload(sample.monthly, sample.date)
    .find(game => game.providerGameId === sample.providerGameId);
  assert.ok(result, 'each archived official tie retains its exact published identity');
  assert.equal(result.statusCode, 'F', 'the official same/same Review row is a completed tie');
  assert.deepEqual([result.awayScore, result.homeScore], [[2, 2], [6, 6], [4, 4]][index]);

  const targetRow = sample.monthly.rows.find(row => row.row.some(cell => cell.Text?.includes(sample.providerGameId)));
  const target = { row: structuredClone(targetRow.row) };
  if (!target.row.some(cell => cell.Class === 'day')) target.row.unshift({ Class: 'day', Text: sample.date.slice(5).replace('-', '.') });
  const parseChanged = change => {
    const clone = structuredClone(target);
    change(clone.row);
    return parseKboOfficialSchedulePayload({ rows: [clone] }, sample.date)[0];
  };
  const changeReview = replacement => cells => {
    const cell = cells.find(item => item.Class === 'relay');
    cell.Text = replacement(cell.Text);
  };
  for (const change of [
    changeReview(() => ''),
    changeReview(html => html + html),
    changeReview(html => html.replace('section=REVIEW', 'section=PREVIEW')),
    changeReview(html => html.replace('gameDate=', 'gameDate=20250101&unused=')),
    changeReview(html => html.replace(sample.providerGameId, '20250101HTLG0')),
    changeReview(html => html.replace('/Schedule/GameCenter/Main.aspx', 'https://other.example/Schedule/GameCenter/Main.aspx')),
    changeReview(html => html.replace('section=REVIEW', 'section=REVIEW&section=PREVIEW')),
    cells => { cells.find(cell => cell.Text?.includes('btnHighlight')).Text = '<a href="?gameId=20250101HTLG0">highlight</a>'; },
    cells => { cells.find(cell => cell.Class === 'play').Text = '<span>LG</span><em><span class="same">2</span>vs<span class="same">2</span></em><span>KIA</span>'; },
    cells => { cells.find(cell => cell.Class === 'play').Text = '<span>롯데</span><em><span class="same">2</span>vs<span class="same">3</span></em><span>KT</span>'; },
  ]) {
    const guarded = parseChanged(change);
    assert.equal(guarded.statusCode, 'S', 'conflicting or missing official Review identity never proves a tie');
    assert.equal(guarded.awayScore, null);
    assert.equal(guarded.homeScore, null);
  }
  const placeholder = parseChanged(cells => {
    cells.find(cell => cell.Class === 'relay').Text = '';
    cells.find(cell => cell.Class === 'play').Text = '<span>롯데</span><em><span class="same">0</span>vs<span class="same">0</span></em><span>KT</span>';
  });
  assert.equal(placeholder.statusCode, 'S', 'scheduled same/same 0-0 remains a placeholder');
  assert.equal(placeholder.awayScore, null);
}

const tie = ties.cases[0];
const tieGame = parseKboOfficialSchedulePayload(tie.monthly, tie.date).find(game => game.providerGameId === tie.providerGameId);
const verifiedTie = parseKboResultLinescore(tie.scoreboard, tieGame);
assert.equal(verifiedTie.innings, 11, 'retain the actual official inning count');
assert.equal(asianLeagueConfig('KBO').rules.extraInningsLimit, 12, 'the locked rule must remain unchanged');
await assert.rejects(() => fetchAsianFinalResult('KBO', tieGame.gamePk, tie.date, {
  fetchImpl: async url => ({ ok: true, status: 200, text: async () => JSON.stringify(
    String(url).endsWith('/GetScheduleList') ? tie.monthly
      : String(url).endsWith('/GetKboGameList') ? tie.daily : tie.scoreboard) }),
}), error => error.code === 'OFFICIAL_FINAL_RESULT_INVALID' && /和局局數不符合/.test(error.message),
'an official 11-inning tie remains held for rule review; never reinterpret it as an ordinary 12-inning final');

console.log('KBO official postseason and tie replay, Review/series identity guards, placeholder exclusion, source evidence and unchanged rule holds PASS');
