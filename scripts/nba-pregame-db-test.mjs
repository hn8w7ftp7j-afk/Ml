// Executes the actual store against a deterministic SQL transport double.
// This is NOT a live Neon/PostgreSQL integration or production capture test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const records = new Map(); const statements = [];
process.env.DATABASE_V2_URL = 'postgresql://synthetic:synthetic@localhost/synthetic';
globalThis.__nbaTestNeon = () => async (parts, ...values) => {
  const query = parts.join('?'); statements.push(query);
  if (query.startsWith('CREATE TABLE')) return [];
  if (query.startsWith('INSERT')) {
    const [gameId, revision, , serialized] = values; const key = `${gameId}:${revision}`;
    if (records.has(key)) return [];
    const row = { revision, payload: JSON.parse(serialized) }; records.set(key, row); return [structuredClone(row)];
  }
  if (query.startsWith('SELECT')) return [...records.values()].filter(row => row.payload.gameId === values[0] && (!values[1] || row.revision === values[1])).map(row => structuredClone(row));
  throw new Error('Unexpected SQL');
};
const sourceUrl = new URL('../lib/nba/pregame-store.js', import.meta.url);
const source = fs.readFileSync(sourceUrl, 'utf8').replace("import { neon } from '@neondatabase/serverless';", 'const neon = globalThis.__nbaTestNeon;').replace("'../database-url.js'", JSON.stringify(new URL('../database-url.js', sourceUrl).href)).replace("'./identity.js'", JSON.stringify(new URL('./identity.js', sourceUrl).href));
const { buildNbaPregame, saveNbaPregame, loadNbaPregame } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const now = Date.now() - 1000;
const game = { id: 'nba:espn:game:123', sourceId: '123', league: 'NBA', status: 'scheduled', timeConfirmed: true, startTime: new Date(now + 3600000).toISOString(), home: { id: 'nba:espn:team:5' }, away: { id: 'nba:espn:team:18' } };
const payload = buildNbaPregame({ status: 'ready', qa: { status: 'WARNING' }, data: { game, lineups: [game.home, game.away].map(team => ({ teamId: team.id, players: [] })) }, sources: [{ url: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=123', hash: 'a'.repeat(64), fetchedAt: new Date(now).toISOString(), status: 'ready' }] }, null, now);
const first = await saveNbaPregame(payload);
const repeated = await saveNbaPregame({ ...payload, capturedAt: new Date(now + 100).toISOString() });
assert.equal(first.inserted, true); assert.equal(repeated.inserted, false);
assert.equal(repeated.revision, first.revision); assert.equal(repeated.capturedAt, payload.capturedAt);
assert.equal(records.size, 1);
const newer = { ...payload, sources: [{ ...payload.sources[0], hash: 'b'.repeat(64) }] };
assert.equal((await saveNbaPregame(newer)).inserted, true);
assert.equal((await loadNbaPregame(game.id)).length, 2);
assert.ok(statements.every(sql => sql.includes('sports_nba_pregame_v1') && !/\b(?:UPDATE|DELETE|TRUNCATE)\b/.test(sql)));
records.values().next().value.payload.injuryStatus = 'tampered';
await assert.rejects(() => loadNbaPregame(game.id));
delete globalThis.__nbaTestNeon;
console.log('NBA SQL transport-double: append-only, duplicate durable timestamp, readback and tamper rejection PASS (not live DB)');
