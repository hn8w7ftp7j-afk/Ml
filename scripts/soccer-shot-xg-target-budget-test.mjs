import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';

// Real PostgreSQL/WASM local credit reservations, synthetic HTTP only.
const fixture = await soccerSqlFixture();
const keys = ['DATABASE_URL', 'DATABASE_V2_URL'];
const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
process.env.DATABASE_URL = 'postgres://fixture.invalid/shot-target-budget';
delete process.env.DATABASE_V2_URL;
try {
  const { ensureStrikerCreditBudgetStore, createStrikerCreditBudget } = await import('../lib/soccer/striker-credit-budget.js');
  const { fetchStrikerShotMapResearch: capture, auditStrikerShotMapCapture: audit } = await import('../lib/soccer/shot-xg-target-adapter.js');
  await ensureStrikerCreditBudgetStore();
  const scope = { league: 'epl', gameId: '740916', homeTeamId: '382', awayTeamId: '359',
    homeAbbreviation: 'MNC', awayAbbreviation: 'ARS' };
  const budget = { budgetId: randomUUID(), windowStart: new Date(Date.now() + 300).toISOString() };
  const windowEnd = new Date(Date.parse(budget.windowStart) + 10000).toISOString();
  const created = await createStrikerCreditBudget({ enabled: true, ...budget, windowEnd, maxCredits: 10 });
  assert.equal(created.status, 'CREATED');
  let requests = 0;
  const options = { enabled: true, scope, budget, apiKey: 'synthetic-target-ledger-key',
    fetchImpl: async (_url, request) => {
      requests++;
      assert.deepEqual(JSON.parse(request.body), { game_id: '740916', league: 'soccer', include_shots: true });
      return new Response(JSON.stringify({ data: { shots_total: 1, totals: { shots: 1, located: 1 }, shots: [
        { game_id: '740916', team: 'MNC', minute: 47, penalty: false, x: 1.1, y: 0.5,
          outcome: 'blocked', body_part: 'right_foot' },
      ] } }));
    } };
  assert.equal((await capture(options)).code, 'STRIKER_SHOT_MAP_CREDIT_RESERVATION_REJECTED', 'Future window cannot spend');
  assert.equal(requests, 0);
  await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(budget.windowStart) - Date.now() + 25)));
  const calls = await Promise.all([capture(options), capture(options)]);
  assert.equal(calls.filter(item => item.ok).length, 1);
  assert.equal(calls.filter(item => item.code === 'STRIKER_SHOT_MAP_CREDIT_RESERVATION_REJECTED').length, 1);
  assert.equal(requests, 1, 'Concurrent captures cannot overrun the shared atomic 10-credit budget');
  const handle = calls.find(item => item.ok);
  assert.equal(handle.transport, 'SYNTHETIC_CUSTOM_IMPLEMENTATION_NOT_AUTHENTIC');
  assert.equal(handle.sourceAuthenticationVerified, false);
  const audited = audit(handle);
  assert.equal(audited.observedShots[0].locationHypothesis.nativeX, 1.1);
  assert.equal(audited.observedShots[0].period, null);
  assert.equal(audited.completenessVerified, false);
  const row = (await fixture.db.query('SELECT reserved_credits FROM sports_soccer_striker_credit_windows_v1 WHERE budget_id=$1', [budget.budgetId])).rows[0];
  assert.equal(row.reserved_credits, 10);
  console.log('soccer shot xG target budget: PASS (PostgreSQL/WASM ledger + synthetic HTTP; no provider call)');
} finally {
  for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  await fixture.close();
}
