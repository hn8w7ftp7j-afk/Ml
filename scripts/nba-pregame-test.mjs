import assert from 'node:assert/strict';
import { validateNbaPregame, buildNbaPregame } from '../lib/nba/pregame-store.js';
import { archivedNbaInjuryReport } from '../lib/nba/injury-archive.js';
import fs from 'node:fs';
const now = Date.parse('2026-10-01T10:00:00Z');
const game = { id: 'nba:espn:game:123', sourceId: '123', league: 'NBA', status: 'scheduled', timeConfirmed: true, startTime: '2026-10-01T11:00:00Z', home: { id: 'nba:espn:team:5' }, away: { id: 'nba:espn:team:18' } };
const result = { status: 'ready', qa: { status: 'WARNING' }, data: { game, lineups: [{ teamId: game.home.id, players: [] }, { teamId: game.away.id, players: [] }] }, sources: [{ url: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=123', hash: 'a'.repeat(64), fetchedAt: new Date(now).toISOString(), status: 'ready' }] };
const p = buildNbaPregame(result, null, now); assert.equal(validateNbaPregame(p, now), true); assert.equal(p.lineupStatus, 'unconfirmed'); assert.equal(p.injuryStatus, 'source_missing');
for (const mutate of [p => p.league = 'NHL', p => p.game.status = 'final', p => p.capturedAt = '2026-10-01T11:00:00Z', p => p.sources[0].fetchedAt = '2026-10-01T09:54:00Z', p => p.sources[0].hash = '', p => p.sources[0].url = 'https://example.com/', p => p.officialLineupConfirmed = true, p => p.modelInputEnabled = true, p => p.game.timeConfirmed = false, p => p.lineups.push(p.lineups[0]), p => p.sources[0].url = p.sources[0].url.replace('123', '456')]) { const bad = structuredClone(p); mutate(bad); assert.throws(() => validateNbaPregame(bad, now)); }
assert.throws(() => buildNbaPregame({ ...result, qa: { status: 'BLOCK' } }, null, now));
console.log('NBA pregame: clock, source, identity, missing-value, postgame and model-isolation tests passed');
const real = JSON.parse(fs.readFileSync(new URL('./fixtures/nba-onoff-401811042.json', import.meta.url)));
const archive = archivedNbaInjuryReport(real.game, real.players); assert.equal(archive.rows.length, 19); assert.equal(archive.capturedPregame, false); assert.equal(archive.modelInputEnabled, false); assert.equal(archive.source.publishedAt, null);
assert.equal(archivedNbaInjuryReport({ ...real.game, startTime: '2026-04-12T23:00:00Z' }, real.players), null);
assert.equal(archivedNbaInjuryReport({ ...real.game, league: 'NHL' }, real.players), null);
assert.ok(archivedNbaInjuryReport(real.game, []).rows.every(row => row.playerId === null));
