import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./next-route-test-loader.mjs', import.meta.url);

process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'runtime-provider-test-password';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'runtime-provider-test-secret-that-is-long-and-isolated';

const { createSessionToken } = await import('../lib/security.js');
const { GET: getSchedule } = await import('../app/api/schedule/route.js');
const { GET: getResult } = await import('../app/api/result/route.js');
const session = await createSessionToken(600);
const authHeaders = { cookie: `mlb_session=${encodeURIComponent(session)}`, 'x-forwarded-for': '203.0.113.196' };

const npbHtml = `<div class="unit"><span class="link_box">
  <div class="team_name">DeNA</div><div class="score_text score_left">&nbsp;</div>
  <div class="round">Yokohama<br>17:45</div>
  <div class="score_text score_right">&nbsp;</div><div class="team_name">Yomiuri</div>
</span></div>`;
const kboPayload = { rows: [{ row: [
  { Text: '08.18(화)', Class: 'day' },
  { Text: '<b>18:30</b>', Class: 'time' },
  { Text: '<span>LG</span><em><span>vs</span></em><span>두산</span>', Class: 'play' },
  { Text: "<a href='/Schedule/GameCenter/Main.aspx?gameDate=20990818&gameId=20990818LGOB0&section=PREVIEW'>프리뷰</a>", Class: 'relay' },
  { Text: '' }, { Text: '' }, { Text: '잠실' }, { Text: '-' },
] }] };
const cpblPayload = { Data: { Games: [{
  GameId: '2099-A-201', KindCode: 'A', GameStatus: 'SCHEDULED', PreExeDate: '2099-08-18T18:35:00', GameSno: 201, InningSeq: 0,
  Visiting: { Team: { Code: 'AJL011', Name: '樂天桃猿' }, Score: 0 },
  Home: { Team: { Code: 'AAA011', Name: '味全龍' }, Score: 0 }, Field: { Abbe: '大巨蛋' },
}] } };

const originalFetch = globalThis.fetch;
try {
  const fixtures = { NPB: npbHtml, KBO: kboPayload, CPBL: cpblPayload };
  for (const league of ['NPB', 'KBO', 'CPBL']) {
    let requestedUrl = '';
    globalThis.fetch = async url => {
      requestedUrl = String(url);
      return {
        ok: true,
        status: 200,
        text: async () => fixtures[league],
        json: async () => fixtures[league],
      };
    };
    const response = await getSchedule(new Request(`https://app.test/api/schedule?league=${league}&date=2099-08-18`, { headers: authHeaders }));
    const body = await response.json();
    assert.equal(response.status, 200, `${league} runtime schedule route 應成功`);
    assert.equal(body.ok, true);
    assert.equal(body.league, league);
    assert.equal(body.analysisMode, 'EXPERIMENTAL_SHADOW');
    assert.equal(body.betEligible, false);
    assert.equal(body.games.length, 1);
    assert.equal(body.games[0].league, league);
    assert.equal(Number.isSafeInteger(body.games[0].gamePk), true);
    if (league === 'NPB') assert.match(requestedUrl, /npb\.jp/);
    if (league === 'KBO') assert.match(requestedUrl, /www\.koreabaseball\.com\/ws\/Schedule\.asmx\/GetScheduleList/);
    if (league === 'CPBL') assert.match(requestedUrl, /stats\.cpbl\.com\.tw/);
  }

  globalThis.fetch = async () => { throw new Error('未知聯盟不得呼叫官方來源'); };
  const unknownResponse = await getSchedule(new Request('https://app.test/api/schedule?league=NFL&date=2099-08-18', { headers: authHeaders }));
  assert.equal(unknownResponse.status, 400);
  assert.equal((await unknownResponse.json()).code, 'UNKNOWN_LEAGUE');

  const missingDateResult = await getResult(new Request(`https://app.test/api/result?league=NPB&gamePk=${Number.MAX_SAFE_INTEGER}`, { headers: authHeaders }));
  const resultBody = await missingDateResult.json();
  assert.equal(missingDateResult.status, 400);
  assert.equal(resultBody.code, 'RESULT_DATE_REQUIRED');
} finally {
  globalThis.fetch = originalFetch;
}

console.log('Runtime schedule dispatch for NPB/KBO/CPBL and Asian result date boundary PASS');
