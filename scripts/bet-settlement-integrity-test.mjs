import assert from 'node:assert/strict';
import fs from 'node:fs';
import { settleBetTicket, settleBetTickets } from '../lib/bet-settlement-service.js';

for (const route of ['app/api/analyze/route.js', 'app/api/reprice/route.js']) {
  const source = fs.readFileSync(new URL(`../${route}`, import.meta.url), 'utf8');
  assert.match(source, /rebateRate:\s*TAIWAN_CREDIT_REBATE_RATE/,
    `${route} must use the server-owned rebate contract`);
  assert.doesNotMatch(source, /body\.settings\?\.rebateRate/,
    `${route} must ignore client-provided rebate settings`);
}

const originalFetch = globalThis.fetch;
const gamePk = 987654321;
let fetchCalls = 0;

try {
  globalThis.fetch = async url => {
    fetchCalls += 1;
    assert.match(String(url), new RegExp(`/game/${gamePk}/feed/live$`));
    return new Response(JSON.stringify({
      gamePk,
      gameData: {
        game: { pk: gamePk, gameNumber: 1, scheduledInnings: 9 },
        datetime: { officialDate: '2099-08-21' },
        teams: {
          away: { id: 147, name: 'New York Yankees' },
          home: { id: 141, name: 'Toronto Blue Jays' },
        },
        status: { abstractGameState: 'Final', detailedState: 'Final' },
      },
      liveData: {
        linescore: {
          teams: { away: { runs: 3 }, home: { runs: 2 } },
          innings: [
            { away: { runs: 1 }, home: { runs: 0 } },
            { away: { runs: 0 }, home: { runs: 1 } },
            { away: { runs: 1 }, home: { runs: 0 } },
            { away: { runs: 0 }, home: { runs: 1 } },
            { away: { runs: 1 }, home: { runs: 0 } },
            { away: { runs: 0 }, home: { runs: 0 } },
            { away: { runs: 0 }, home: { runs: 0 } },
            { away: { runs: 0 }, home: { runs: 0 } },
            { away: { runs: 0 }, home: { runs: 0 } },
          ],
        },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const batchSettled = await settleBetTickets([
    {
      id: 'same-game-full', league: 'MLB', gamePk, officialDate: '2099-08-21',
      market: '全場大小', pick: '小6平', away: '客隊', home: '主隊', water: 0.95, stake: 10_000, status: 'OPEN',
    },
    {
      id: 'same-game-first5', league: 'MLB', gamePk, officialDate: '2099-08-21',
      market: '上半大小', pick: '大4平', away: '客隊', home: '主隊', water: 0.94, stake: 10_000, status: 'OPEN',
    },
  ]);
  assert.equal(fetchCalls, 1, '同一場所有方向必須共用一次官方賽果請求');
  assert.equal(batchSettled.length, 2);
  assert.ok(batchSettled.every(bet => bet.status === 'SETTLED'));

  const settled = await settleBetTicket({
    id: 'forged-rebate-ticket', league: 'MLB', gamePk,
    // Asia/Taipei board date can be the next calendar day for an MLB game.
    date: '2099-08-22', officialDate: '2099-08-21',
    market: '上半大小', pick: '大4平', away: '客隊', home: '主隊',
    water: 0.94, stake: 10_000, rebateRate: 0.10, status: 'OPEN',
  });

  assert.equal(settled.status, 'SETTLED',
    'MLB settlement must validate against officialDate instead of the Taipei board date');
  assert.equal(settled.resultSnapshot.officialDate, '2099-08-21');
  assert.equal(settled.resultSnapshot.selectedPeriod, 'FIRST5');
  assert.equal(settled.resultSnapshot.selectedAwayRuns, 3);
  assert.equal(settled.resultSnapshot.selectedHomeRuns, 2);
  assert.equal(settled.settlement.outcome, 'WIN');
  assert.equal(settled.settlement.rebate, 150,
    'A forged 10% ticket rebate must still settle at NT$150 per NT$10,000');
  assert.equal(settled.settlement.netProfit, 9_550);
  assert.equal(settled.settlement.roi, 0.955);

  const legacySettled = await settleBetTicket({
    id: 'legacy-without-official-date', league: 'MLB', gamePk,
    date: '2099-08-22',
    market: '上半大小', pick: '大4平', away: '客隊', home: '主隊',
    water: 0.94, stake: 10_000, status: 'OPEN',
  });
  assert.equal(legacySettled.status, 'SETTLED',
    'Legacy MLB tickets without officialDate must resolve by official gamePk instead of the Taipei board date');
  assert.equal(legacySettled.resultSnapshot.officialDate, '2099-08-21');

} finally {
  globalThis.fetch = originalFetch;
}

console.log('Server-owned analysis, reprice and settlement rebate/date integrity PASS');
