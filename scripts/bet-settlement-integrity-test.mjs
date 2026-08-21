import assert from 'node:assert/strict';
import fs from 'node:fs';
import { settleBetTicket } from '../lib/bet-settlement-service.js';

for (const route of ['app/api/analyze/route.js', 'app/api/reprice/route.js']) {
  const source = fs.readFileSync(new URL(`../${route}`, import.meta.url), 'utf8');
  assert.match(source, /rebateRate:\s*TAIWAN_CREDIT_REBATE_RATE/,
    `${route} must use the server-owned rebate contract`);
  assert.doesNotMatch(source, /body\.settings\?\.rebateRate/,
    `${route} must ignore client-provided rebate settings`);
}

const originalFetch = globalThis.fetch;
const gamePk = 987654321;

try {
  globalThis.fetch = async url => {
    assert.match(String(url), new RegExp(`/game/${gamePk}/feed/live$`));
    return new Response(JSON.stringify({
      gameData: { status: { abstractGameState: 'Final', detailedState: 'Final' } },
      liveData: {
        linescore: {
          teams: { away: { runs: 3 }, home: { runs: 2 } },
          innings: [
            { away: { runs: 1 }, home: { runs: 0 } },
            { away: { runs: 0 }, home: { runs: 1 } },
            { away: { runs: 1 }, home: { runs: 0 } },
            { away: { runs: 0 }, home: { runs: 1 } },
            { away: { runs: 1 }, home: { runs: 0 } },
          ],
        },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const settled = await settleBetTicket({
    id: 'forged-rebate-ticket', league: 'MLB', gamePk, date: '2099-08-21',
    market: '上半大小', pick: '大4平', away: '客隊', home: '主隊',
    water: 0.94, stake: 10_000, rebateRate: 0.10, status: 'OPEN',
  });

  assert.equal(settled.status, 'SETTLED');
  assert.equal(settled.settlement.outcome, 'WIN');
  assert.equal(settled.settlement.rebate, 150,
    'A forged 10% ticket rebate must still settle at NT$150 per NT$10,000');
  assert.equal(settled.settlement.netProfit, 9_550);
  assert.equal(settled.settlement.roi, 0.955);
} finally {
  globalThis.fetch = originalFetch;
}

console.log('Server-owned analysis, reprice and settlement rebate integrity PASS');
