import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseNhlLineupArticle, mergeNhlPersonnelIdentitySources } from '../lib/nhl/personnel-feed.js';
import { makeNhlPersonnelObservation, validateNhlPersonnelObservation } from '../lib/nhl/personnel-observation.js';

// Synthetic name-collision scenarios derived from the existing parser fixture.
// These are not historical personnel evidence and never access network or DB.
const facts = JSON.parse(readFileSync(new URL('./fixtures/nhl/personnel-official-20260614-facts.json', import.meta.url), 'utf8'));
const now = Date.parse('2026-09-06T20:00:00Z');
const AMBIGUOUS = 'NHL_PERSONNEL_GOALIE_CONFIRMATION_IDENTITY_AMBIGUOUS';
const INVALID = 'NHL_PERSONNEL_GOALIE_CONFIRMATION_CATALOG_INVALID';
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function rename(data, side, oldName, newName) {
  for (const key of ['rosterPlayers', 'additionalClubPlayers']) {
    for (const player of data[side][key]) if (player[1] === oldName) player[1] = newName;
  }
  data[side].goalies = data[side].goalies.map(name => name === oldName ? newName : name);
  for (const key of ['lines', 'pairs']) data[side][key] = data[side][key].map(group => group.map(name => name === oldName ? newName : name));
}

function run(report, { names, editData, editRosters } = {}) {
  const data = structuredClone(facts);
  for (const side of ['away', 'home']) {
    data[side].injured = []; data[side].scratched = [];
    if (names?.[side]) rename(data, side, data[side].goalies[0], names[side]);
  }
  editData?.(data);
  const rosters = Object.fromEntries(['away', 'home'].map(side => {
    const teamId = data.game[`${side}TeamId`];
    const roster = { ok: true, teamId, source: data[side].rosterSource,
      players: data[side].rosterPlayers.map(([playerId, name, position]) => ({ playerId, teamId, name, position })) };
    const club = { ok: true, teamId, season: data.game.season, gameType: data.game.gameType, source: data[side].clubSource, skaters: [], goalies: [] };
    for (const [playerId, name, position] of data[side].additionalClubPlayers) {
      const words = name.split(' ');
      club[position === 'G' ? 'goalies' : 'skaters'].push({ playerId, firstName: { default: words.shift() }, lastName: { default: words.join(' ') }, positionCode: position });
    }
    return [side, mergeNhlPersonnelIdentitySources(roster, club, data.game, side)];
  }));
  editRosters?.(rosters);
  const team = side => `<p>${data[side].heading} projected lineup</p>${[...data[side].lines, ...data[side].pairs].map(group => `<p>${escape(group.join(' -- '))}</p>`).join('')}${data[side].goalies.map(name => `<p>${escape(name)}</p>`).join('')}<p>Scratched: None</p><p>Injured: None</p>`;
  const html = `<html><head><link rel="canonical" href="${data.sourceUrl}"><script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle', datePublished: data.sourcePublishedAt, dateModified: data.sourceUpdatedAt })}</script></head><body><article class="nhl-c-article"><div class="oc-c-markdown-stories"><h2>(1M) HURRICANES at (1P) GOLDEN KNIGHTS</h2>${team('away')}${team('home')}<p>Status report</p><p>${escape(report)}</p></div></article></body></html>`;
  return parseNhlLineupArticle(html, { game: data.game, rosters, sourceUrl: data.sourceUrl, observedAt: new Date(now).toISOString(), now });
}

function projected(result, side, reason) {
  assert.equal(result.goalies[side].status, 'PROJECTED');
  assert.equal(result.goalies[side].confirmationExplicit, false);
  if (reason) {
    assert.equal(result.goalies[side].confirmationStatusReason, reason);
    assert.ok(result.qa.warnings.includes(reason));
    assert.ok(result.teams[side].unresolvedGoalieConfirmations.some(row => row.code === reason));
  }
}

const names = { away: 'Alan Example', home: 'Brian Example' };
const sharedSurname = run('Example will start in goal tonight.', { names });
for (const side of ['away', 'home']) {
  projected(sharedSurname, side, AMBIGUOUS);
  const evidence = sharedSurname.teams[side].unresolvedGoalieConfirmations[0];
  assert.equal(evidence.statement, 'example will start in goal tonight');
  assert.equal(evidence.mentionedName, 'example');
  assert.deepEqual(evidence.candidates.map(player => player.teamId).sort(), [12, 54]);
}
assert.equal(sharedSurname.goalies.away.playerId, 8483548);
assert.equal(sharedSurname.goalies.home.playerId, 8479394);
const observation = makeNhlPersonnelObservation(facts.game, sharedSurname, { now });
assert.equal(validateNhlPersonnelObservation(observation, facts.game.gameId, { now }).ok, true);
assert.equal(observation.personnel.teams.away.unresolvedGoalieConfirmations[0].code, AMBIGUOUS);

const sharedFullName = run('Same Example will start in net today.', { names: { away: 'Same Example', home: 'Same Example' } });
for (const side of ['away', 'home']) projected(sharedFullName, side, AMBIGUOUS);

const uniqueFullName = run('Alan Example will start in goal tonight.', { names });
assert.equal(uniqueFullName.goalies.away.status, 'CONFIRMED');
assert.equal(uniqueFullName.goalies.away.playerId, 8483548);
projected(uniqueFullName, 'home');

const uniqueSurname = run('Bussi will start in goal tonight.');
assert.equal(uniqueSurname.goalies.away.status, 'CONFIRMED');
assert.equal(uniqueSurname.goalies.away.playerId, 8483548);
projected(uniqueSurname, 'home');

const tradedSkater = run('Bussi will start in goal tonight.', { editRosters: rosters => {
  const player = rosters.away.players.find(row => row.position !== 'G');
  rosters.home.players.push({ ...player, teamId: rosters.home.teamId });
} });
assert.equal(tradedSkater.goalies.away.status, 'CONFIRMED');
assert.equal(tradedSkater.goalies.away.playerId, 8483548);
assert.ok(!tradedSkater.qa.warnings.includes(INVALID));

const sharedGoalieMembership = run('Bussi will start in goal tonight.', { editRosters: rosters => {
  const player = rosters.away.players.find(row => row.playerId === 8483548);
  rosters.home.players.push({ ...player, teamId: rosters.home.teamId });
} });
projected(sharedGoalieMembership, 'away', AMBIGUOUS);
const assignments = sharedGoalieMembership.teams.away.unresolvedGoalieConfirmations[0].candidates;
assert.equal(new Set(assignments.map(row => row.playerId)).size, 1);
assert.equal(new Set(assignments.map(row => row.teamId)).size, 2);

for (const conflict of [{ name: 'Contradictory Person' }, { position: 'G' }]) {
  projected(run('Bussi will start in goal tonight.', { editRosters: rosters => {
    const player = rosters.away.players.find(row => row.position !== 'G');
    rosters.home.players.push({ ...player, ...conflict, teamId: rosters.home.teamId });
  } }), 'away', INVALID);
}

const skaterCollision = run('Example will start tonight.', {
  names: { away: 'Alan Example' },
  editData: data => rename(data, 'home', data.home.lines[0][0], 'Brian Example'),
});
projected(skaterCollision, 'away', AMBIGUOUS);
assert.ok(skaterCollision.teams.away.unresolvedGoalieConfirmations[0].candidates.some(player => player.position !== 'G'));

for (const editRosters of [
  rosters => { rosters.home.teamId = 999; },
  rosters => { rosters.home.identitySources[0].contentHash = null; },
  rosters => { rosters.home.players[0].playerId = null; },
  rosters => { rosters.home.players[0].name = null; },
  rosters => { rosters.home.players[0].name = 123; },
  rosters => { rosters.home.players[0].position = null; },
  rosters => { rosters.home.players = []; },
  rosters => { rosters.home.players.push({ ...rosters.home.players[0] }); },
]) projected(run('Bussi will start in goal tonight.', { editRosters }), 'away', INVALID);

const twoUniqueNames = run('Alan Example starts in goal today. Brian Example will get the start tonight.', { names });
assert.equal(twoUniqueNames.goalies.away.status, 'CONFIRMED');
assert.equal(twoUniqueNames.goalies.home.status, 'CONFIRMED');
assert.notEqual(twoUniqueNames.goalies.away.playerId, twoUniqueNames.goalies.home.playerId);

console.log('PASS NHL confirmation identity: ambiguous names/goalie assignments stay projected, traded skaters preserve unique confirmations, identity conflicts reject, ambiguity evidence survives validation');
