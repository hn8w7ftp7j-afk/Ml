import assert from 'node:assert/strict';
import { deriveNbaOnOff } from '../lib/nba/on-off.js';
// Synthetic, deliberately simple low-scoring fixtures, never real-game data.
function fixture() {
  const side = (id, score) => ({ id: `nba:espn:team:${id}`, sourceId: id, score: score * 4, periodScores: [1, 2, 3, 4].map(period => ({ period, score })), statistics: [] });
  const game = { id: 'nba:espn:game:900001', sourceId: '900001', league: 'NBA', status: 'final', completed: true, home: side('5', 2), away: side('18', 1) };
  const players = ['5', '18'].flatMap((team, side) => Array.from({ length: 6 }, (_, i) => {
    const id = String(100 + side * 10 + i);
    return { id: `nba:espn:player:${id}`, sourceId: id, name: `Synthetic Player ${id}`, teamId: `nba:espn:team:${team}`, starter: i < 5, didNotPlay: false, statistics: [{ name: 'plusMinus', displayValue: String(i < 5 ? side ? -4 : 4 : 0) }] };
  }));
  let seq = 0; let homeScore = 0; let awayScore = 0; const plays = [];
  const add = (period, clock, type, homeDelta = 0, awayDelta = 0) => {
    seq++; homeScore += homeDelta; awayScore += awayDelta;
    plays.push({ id: `900001${seq}`, sequenceNumber: String(seq), period: { number: period }, clock: { displayValue: clock }, type: { text: type }, homeScore, awayScore });
  };
  for (let period = 1; period <= 4; period++) { add(period, '11:00', 'Jump Shot', 2); add(period, '10:00', 'Free Throw - 1 of 1', 0, 1); add(period, '0.0', 'End Period'); }
  add(4, '0.0', 'End Game'); return { game, players, plays };
}
const run = f => deriveNbaOnOff(f.game, f.players, f.plays);
let count = 0; function test(name, action) { action(); count++; console.log(`PASS ${name}`); }
test('exact five-player time, on/off totals, and boxscore plus-minus reconcile', () => {
  const f = fixture(); const r = run(f); assert.equal(r.status, 'ready'); assert.equal(r.qa.status, 'PASS');
  const player = r.players[0]; assert.equal(player.onSeconds, 2880); assert.equal(player.offSeconds, 0); assert.equal(player.onPointsFor, 8); assert.equal(player.onPointsAgainst, 4); assert.equal(player.offNetPer48, null);
  assert.equal(r.players[5].onNetPer48, null); assert.equal(r.players[5].offNetPer48, 4); assert.equal(r.officialMetric, false); assert.equal(r.pointInTimeReplay, false);
});
test('substitution reassigns subsequent time and points, never earlier events', () => {
  const f = fixture(); f.plays.splice(3, 0, { id: '90000199', sequenceNumber: '99', period: { number: 2 }, clock: { displayValue: '12:00' }, type: { text: 'Substitution' }, homeScore: 2, awayScore: 1, team: { id: '5' }, participants: [{ athlete: { id: '105' } }, { athlete: { id: '100' } }], text: 'Synthetic Player 105 enters the game for Synthetic Player 100' });
  f.players[0].statistics[0].displayValue = '1'; f.players[5].statistics[0].displayValue = '3';
  const r = run(f); assert.equal(r.status, 'ready'); assert.equal(r.players[0].onSeconds, 720); assert.equal(r.players[5].onSeconds, 2160); assert.equal(r.players[0].plusMinus, 1); assert.equal(r.substitutions, 1);
  // A late event ID must not move a correctly positioned event after the game.
  assert.equal(r.events, 14);
  f.plays[3].participants.reverse(); assert.equal(run(f).status, 'blocked');
});
test('missing data and live games remain unavailable, not fabricated zeros', () => {
  const f = fixture(); assert.equal(deriveNbaOnOff(f.game, f.players, []).status, 'unavailable');
  f.game.status = 'live'; assert.equal(run(f).status, 'unavailable');
});
test('conflicting game/team/player identity blocks all reconstructed rows', () => {
  for (const mutate of [f => { f.game.league = 'MLB'; }, f => { f.players[0].teamId = 'nba:espn:team:27'; }, f => { f.players.push(f.players[0]); }, f => { f.plays[0].id = '7771'; }]) {
    const f = fixture(); mutate(f); const r = run(f); assert.equal(r.status, 'blocked'); assert.deepEqual(r.players, []);
  }
});
test('identical event duplicates deduplicate, conflicting revisions BLOCK', () => {
  const f = fixture(); f.plays.splice(1, 0, structuredClone(f.plays[0])); assert.equal(run(f).events, 13);
  f.plays[1].homeScore++; assert.equal(run(f).status, 'blocked');
});
test('clock order and actual period length cannot be repaired by sorting identifiers', () => {
  for (const clock of ['13:00', '1:60', '-1', '10:00:00']) { const f = fixture(); f.plays[0].clock.displayValue = clock; assert.equal(run(f).status, 'blocked'); }
  const f = fixture(); [f.plays[0], f.plays[1]] = [f.plays[1], f.plays[0]]; assert.equal(run(f).status, 'blocked');
});
test('truncated events and score corrections cannot become complete On/Off', () => {
  const f = fixture(); f.plays.pop(); assert.equal(run(f).status, 'blocked');
  const g = fixture(); g.plays.splice(2, 1); assert.equal(run(g).status, 'blocked');
  const h = fixture(); h.plays[4].homeScore--; assert.equal(run(h).status, 'blocked');
});
test('known boxscore mismatch remains BLOCK even by a single point', () => {
  const f = fixture(); f.players[0].statistics[0].displayValue = '5'; const r = run(f);
  assert.equal(r.status, 'blocked'); assert.equal(r.qa.code, 'SCORE_INVALID'); assert.deepEqual(r.players, []);
});
test('missing independent plus-minus is disclosed without claiming reconciliation', () => {
  const f = fixture(); f.players[0].statistics = []; const r = run(f);
  assert.equal(r.status, 'ready'); assert.equal(r.qa.status, 'WARNING'); assert.equal(r.players[0].plusMinusVerified, false);
});
test('uncertain starting lineup and DNP contradiction do not infer a replacement', () => {
  const f = fixture(); f.players[0].starter = false; assert.equal(run(f).status, 'unavailable');
  const g = fixture(); g.players[0].didNotPlay = true; assert.equal(run(g).status, 'blocked');
});
test('overtime uses five actual extra minutes rather than a regulation-only denominator', () => {
  const f = fixture(); f.game.home.score = 10; f.game.away.score = 9;
  f.game.home.periodScores.push({ period: 5, score: 2 });
  f.game.away.periodScores = [1, 2, 3, 4].map(period => ({ period, score: 2 })).concat({ period: 5, score: 1 });
  f.plays.pop();
  for (let i = 0; i < f.plays.length; i++) f.plays[i].awayScore = Math.floor((i + 2) / 3) * 2;
  // Before each quarter's away score, only previous quarters have scored.
  for (let i = 0; i < 4; i++) f.plays[i * 3].awayScore = i * 2;
  for (const [i, clock, type, homeScore, awayScore] of [[14, '4:00', 'Jump Shot', 10, 8], [15, '3:00', 'Free Throw - 1 of 1', 10, 9], [16, '0.0', 'End Period', 10, 9], [17, '0.0', 'End Game', 10, 9]]) f.plays.push({ id: `900001${i}`, sequenceNumber: String(i), period: { number: 5 }, clock: { displayValue: clock }, type: { text: type }, homeScore, awayScore });
  for (const player of f.players) player.statistics[0].displayValue = String(player.starter ? player.teamId === f.game.home.id ? 1 : -1 : 0);
  const r = run(f); assert.equal(r.status, 'ready'); assert.equal(r.durationSeconds, 3180); assert.equal(r.players[0].onNetPer48, 48 / 53);
});
console.log(`NBA observed On/Off: ${count} groups passed; synthetic fixtures are not real source verification.`);
