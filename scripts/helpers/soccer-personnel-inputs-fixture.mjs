import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { soccerLeague } from '../../lib/soccer/contracts.js';
import { normalizeSoccerSchedule } from '../../lib/soccer/data.js';
import { normalizeSoccerPrematch } from '../../lib/soccer/prematch.js';
import { normalizeSoccerPlayerWorkload } from '../../lib/soccer/player-workload.js';

const input = JSON.parse(fs.readFileSync(new URL('../fixtures/soccer/lineup-announced.json', import.meta.url)));
const historical = JSON.parse(fs.readFileSync(new URL('../fixtures/soccer/minutes-past.json', import.meta.url)));
const day = 86400000;
const iso = value => new Date(value).toISOString();
const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const source = (data, league, eventId, now) => ({ provider: 'ESPN',
  url: `https://site.api.espn.com/apis/site/v2/sports/soccer/${soccerLeague(league).espnSlug}/summary?event=${eventId}`,
  requestedAt: iso(now - 2000), fetchedAt: iso(now - 1000), contentHash: digest(data) });

// Controlled provider-shaped documents, not additional real observations or
// historical PIT evidence. Actual source hashes are recomputed for every copy.
export function soccerPersonnelInputsFixture(league = 'epl', now = Date.now(), { transformPayload = null } = {}) {
  const definition = soccerLeague(league), payload = structuredClone(input);
  if (transformPayload) transformPayload(payload);
  const c = payload.header.competitions[0];
  payload.header.league = { id: definition.espnId, slug: definition.espnSlug, uid: `s:600~l:${definition.espnId}` };
  payload.header.uid = `s:600~l:${definition.espnId}~e:${payload.header.id}`;
  c.uid = `s:600~l:${definition.espnId}~e:${payload.header.id}~c:${c.id}`; c.date = iso(now + day);
  const currentSource = source(payload, league, payload.header.id, now);
  const board = normalizeSoccerSchedule({ leagues: [payload.header.league],
    events: [{ ...payload.header, date: c.date, status: c.status }] }, league, currentSource);
  assert.equal(board.ok, true); const game = board.games[0];
  const evidence = normalizeSoccerPrematch(payload, game, currentSource, now);
  assert.equal(evidence.ok, true);
  const prior = structuredClone(payload), pc = prior.header.competitions[0], eventId = '991001';
  prior.header.id = eventId; prior.header.uid = `s:600~l:${definition.espnId}~e:${eventId}`;
  pc.id = eventId; pc.uid = `s:600~l:${definition.espnId}~e:${eventId}~c:${eventId}`;
  pc.date = iso(now - 3 * day); pc.status = { period: 2, type: { name: 'STATUS_FULL_TIME', state: 'post', completed: true } };
  prior.format = { regulation: { periods: 2, clock: 2700 } };
  prior.keyEvents = historical.keyEvents.filter(event => event.type.type === 'end-regular-time').map(event => structuredClone(event));
  for (const roster of prior.rosters) {
    // A current newcomer has no historical forecast and stays null.
    roster.roster = roster.roster.slice(0, -1);
    for (const player of roster.roster) { player.subbedIn = false; player.subbedOut = false; player.stats = [{ name: 'redCards', value: 0 }]; }
  }
  const priorSource = source(prior, league, eventId, now), teams = {};
  for (const side of ['home', 'away']) {
    const teamScope = { ok: true, sourceId: game[side].sourceId, asOf: iso(now - 1000), referenceAt: iso(now - 1000) };
    const record = { eventId, startTime: pc.date, competition: { id: definition.espnId, slug: definition.espnSlug },
      homeAway: side, opponent: { sourceId: game[side === 'home' ? 'away' : 'home'].sourceId }, status: 'COMPLETED', extraTimeReported: false };
    const playerWorkload = normalizeSoccerPlayerWorkload(teamScope,
      [{ ok: true, record, source: priorSource, data: prior, attempted: true }], { asOf: now });
    assert.equal(playerWorkload.ok, true, JSON.stringify(playerWorkload.omissions));
    teams[side] = { ...teamScope, version: 'SOCCER-ALL-COMPETITION-WORKLOAD-v2', playerWorkload };
  }
  evidence.workload = { gameId: game.id, target: structuredClone(game), teams };
  evidence.sourceDocumentArchive = { receiptId: '1'.repeat(64), persisted: true };
  return { evidence, game, now, payload, currentSource };
}
