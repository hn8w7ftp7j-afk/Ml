// Actual source verification. No mocks and no wagering/model evaluation.
import assert from 'node:assert/strict';
import { fetchSoccerJson, fetchSoccerSchedule, fetchSoccerStandings } from '../lib/soccer/data.js';
import { soccerDate, soccerLeague } from '../lib/soccer/contracts.js';

const now = soccerDate();
const historical = { epl: '2025-10-18', ucl: '2025-10-22' }; // UCL evening 10/21 fixtures fall on 10/22 in Taipei.
let failures = 0;
for (const league of ['epl', 'ucl']) {
  for (const [kind, date] of [['historical', historical[league]], ['current', now]]) {
    try {
      const result = await fetchSoccerSchedule(league, date, { timeoutMs: 12000, ttlMs: 0 });
      if (!result.ok && result.upstreamStatus === 400) {
        const singleUrl = `https://site.api.espn.com/apis/site/v2/sports/soccer/${soccerLeague(league).espnSlug}/scoreboard?dates=${date.replaceAll('-', '')}`;
        const probe = await fetchSoccerJson(singleUrl, { timeoutMs: 10000, ttlMs: 0 });
        console.error(`SOCCER_SINGLE_DATE_DIAGNOSTIC ${JSON.stringify({ league, date, ok: probe.ok, code: probe.code, upstreamStatus: probe.upstreamStatus, keys: probe.ok ? Object.keys(probe.data) : null, leagues: probe.data?.leagues?.map(item => ({ id: item.id, slug: item.slug, abbreviation: item.abbreviation })), eventCount: probe.data?.events?.length, firstEvent: probe.data?.events?.[0] ? { id: probe.data.events[0].id, date: probe.data.events[0].date, status: probe.data.events[0].status?.type } : null })}`);
      }
      assert.equal(result.ok, true, JSON.stringify({ code: result.code, upstreamStatus: result.upstreamStatus, source: result.source }));
      assert.equal(result.league.id, league); assert.equal(result.timeZone, 'Asia/Taipei');
      assert.equal(result.source.provider, 'ESPN'); assert.ok(result.source.fetchedAt); assert.ok(result.source.contentHash);
      for (const game of result.games) { assert.equal(game.league, league); assert.equal(game.date, date); assert.ok(game.id.startsWith(`soccer:${league}:`)); assert.notEqual(game.home.id, game.away.id); }
      if (kind === 'historical') { assert.ok(result.games.length > 0, 'Known historical match day must contain games'); assert.ok(result.games.some(game => game.status === 'final'), 'Historical fixtures must have completed results'); }
      console.log(`SOCCER_SOURCE_PASS ${JSON.stringify({ league, slug: soccerLeague(league).espnSlug, kind, date, count: result.games.length, final: result.games.filter(game => game.status === 'final').length, fetchedAt: result.source.fetchedAt, source: result.source.url })}`);
    } catch (error) { failures++; console.error(`SOCCER_SOURCE_FAIL ${JSON.stringify({ league, kind, date, error: error.message })}`); }
  }
  try {
    const result = await fetchSoccerStandings(league, { timeoutMs: 12000, ttlMs: 0 });
    assert.equal(result.ok, true, JSON.stringify({ code: result.code, upstreamStatus: result.upstreamStatus, source: result.source }));
    assert.equal(result.league.id, league); assert.ok(result.standings.length > 0);
    assert.ok(result.standings.some(group => group.rows.length > 0));
    console.log(`SOCCER_STANDINGS_PASS ${JSON.stringify({ league, rows: result.standings.reduce((sum, group) => sum + group.rows.length, 0), fetchedAt: result.source.fetchedAt, source: result.source.url })}`);
  } catch (error) { failures++; console.error(`SOCCER_STANDINGS_FAIL ${JSON.stringify({ league, error: error.message })}`); }
}
if (failures) throw new Error(`Soccer source verification failed in ${failures} actual provider checks`);
