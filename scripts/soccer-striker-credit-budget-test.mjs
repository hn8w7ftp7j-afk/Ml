import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';

const fixture = await soccerSqlFixture(), { db } = fixture;
const keys = ['DATABASE_URL', 'DATABASE_V2_URL'], old = Object.fromEntries(keys.map(k => [k, process.env[k]]));
process.env.DATABASE_URL = 'postgres://fixture.invalid/striker-budget'; delete process.env.DATABASE_V2_URL;
try {
  const { createStrikerCreditBudget: create, reserveStrikerCredits: reserve, ensureStrikerCreditBudgetStore } = await import('../lib/soccer/striker-credit-budget.js');
  await ensureStrikerCreditBudgetStore();
  const budgetId = randomUUID(), otherId = randomUUID(), missingId = randomUUID(), crossA = randomUUID(), crossB = randomUUID();
  const startMs = Date.now() + 1500, endMs = startMs + 3000;
  const windowStart = new Date(startMs).toISOString(), windowEnd = new Date(endMs).toISOString();
  const config = { enabled: true, budgetId, windowStart, windowEnd, maxCredits: 30 };
  const call = (requestId = randomUUID(), credits = 10) => ({ enabled: true, budgetId, windowStart, requestId, credits });
  assert.equal((await create({ ...config, enabled: false })).status, 'DISABLED');
  assert.equal((await create({ ...config, apiKey: 'must-not-be-stored' })).status, 'CONFIG_INVALID');
  assert.equal((await create({ ...config, maxCredits: 9 })).status, 'CONFIG_INVALID');
  assert.equal((await create({ ...config, budgetId: 'key-not-an-identifier' })).status, 'CONFIG_INVALID');
  assert.equal((await create({ ...config, windowStart: new Date(Date.now() - 1000).toISOString() })).status, 'WINDOW_NOT_FUTURE');
  assert.equal((await create(config)).status, 'CREATED');
  assert.equal((await create(config)).status, 'EXISTING');
  assert.equal((await create({ ...config, maxCredits: 40 })).status, 'CONFIG_CONFLICT');
  assert.equal((await create({ ...config, windowStart: new Date(startMs + 500).toISOString(), windowEnd: new Date(endMs + 500).toISOString() })).status, 'WINDOW_OVERLAP');
  assert.equal((await create({ ...config, budgetId: otherId, maxCredits: 10 })).status, 'CREATED');
  assert.equal((await create({ ...config, budgetId: crossA, maxCredits: 10 })).status, 'CREATED');
  assert.equal((await create({ ...config, budgetId: crossB, maxCredits: 10 })).status, 'CREATED');
  const overlapId = randomUUID();
  const competingWindows = await Promise.all([
    create({ ...config, budgetId: overlapId }),
    create({ ...config, budgetId: overlapId, windowStart: new Date(startMs + 250).toISOString() }),
  ]);
  assert.deepEqual(competingWindows.map(row => row.status).sort(), ['CREATED', 'WINDOW_OVERLAP']);
  assert.equal((await reserve({ ...call(), enabled: false })).status, 'DISABLED');
  assert.equal((await reserve({ ...call(), apiKey: 'must-not-be-stored' })).status, 'RESERVATION_INVALID');
  assert.equal((await reserve(call(randomUUID(), 9))).status, 'RESERVATION_INVALID');
  assert.equal((await reserve({ ...call(), budgetId: missingId })).status, 'BUDGET_NOT_FOUND');
  assert.equal((await reserve(call())).status, 'WINDOW_INACTIVE');
  await new Promise(resolve => setTimeout(resolve, Math.max(0, startMs - Date.now() + 40)));
  // Competing calls share one database budget; each accepted response is one
  // send permission, independent of whether a later network operation succeeds.
  const ids = Array.from({ length: 20 }, () => randomUUID());
  const competing = await Promise.all(ids.map(id => reserve(call(id))));
  assert.equal(competing.filter(row => row.allowed).length, 3);
  assert.equal(competing.filter(row => row.status === 'BUDGET_EXHAUSTED').length, 17);
  const successful = ids[competing.findIndex(row => row.allowed)];
  assert.equal((await reserve(call(successful))).status, 'REQUEST_REPLAY');
  assert.equal((await reserve(call(successful))).allowed, false, 'a timeout retry must never grant another send');
  const sameId = randomUUID();
  const otherOptions = { enabled: true, budgetId: otherId, windowStart, requestId: sameId, credits: 10 };
  const replays = await Promise.all(Array.from({ length: 6 }, () => reserve(otherOptions)));
  assert.equal(replays.filter(row => row.allowed).length, 1);
  assert.equal(replays.filter(row => row.status === 'REQUEST_REPLAY').length, 5);
  const shared = randomUUID();
  const acrossBudgets = await Promise.all([crossA, crossB].map(id => reserve({ ...call(shared), budgetId: id })));
  assert.equal(acrossBudgets.filter(row => row.allowed).length, 1);
  assert.equal(acrossBudgets.filter(row => row.status === 'REQUEST_REPLAY').length, 1);
  assert.equal((await reserve({ ...call(successful), budgetId: otherId })).status, 'REQUEST_REPLAY', 'request IDs are global across budgets');
  const windows = (await db.query('SELECT budget_id::text,reserved_credits FROM sports_soccer_striker_credit_windows_v1 ORDER BY budget_id')).rows;
  assert.equal(windows.find(row => row.budget_id === budgetId).reserved_credits, 30);
  assert.equal(windows.find(row => row.budget_id === otherId).reserved_credits, 10);
  assert.equal((await db.query('SELECT count(*)::integer AS count FROM sports_soccer_striker_credit_reservations_v1')).rows[0].count, 5);
  await assert.rejects(() => db.query('UPDATE sports_soccer_striker_credit_windows_v1 SET reserved_credits=0'), /STRIKER_BUDGET_IMMUTABLE/);
  await assert.rejects(() => db.query('DELETE FROM sports_soccer_striker_credit_reservations_v1'), /SOCCER_IMMUTABLE_HISTORY/);
  await new Promise(resolve => setTimeout(resolve, Math.max(0, endMs - Date.now() + 40)));
  assert.equal((await reserve(call())).status, 'WINDOW_INACTIVE');
  assert.equal((await create({ ...config, budgetId: randomUUID() })).status, 'WINDOW_NOT_FUTURE', 'no retroactive budget window');
  assert.equal((await reserve({ ...call(), budgetId: otherId })).allowed, false);
  console.log('soccer Striker credit budget: PASS (PGlite, no upstream calls)');
} finally {
  for (const key of keys) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; }
  await fixture.close();
}
