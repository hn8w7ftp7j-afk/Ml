import assert from 'node:assert/strict';
import { orderSoccerCollectionGames } from '../lib/soccer/collection-order.js';

const game = (id, hour) => ({ id: `soccer:epl:${id}`, startTime: `2026-11-10T${hour}:00:00Z` });
const early = game('1', '12'), middle = game('2', '13'), late = game('3', '14');
const games = [late, middle, early];
const ids = values => values.map(value => value.id);
assert.deepEqual(ids(orderSoccerCollectionGames(games)), ids([early, middle, late]));
assert.deepEqual(games, [late, middle, early], 'queue ordering must not mutate the schedule');

const attempts = new Map([[early.id, 200], [middle.id, 100]]);
assert.deepEqual(ids(orderSoccerCollectionGames(games, attempts)), ids([late, middle, early]),
  'untouched games precede retries and the oldest retry precedes an earlier kickoff');
attempts.set(late.id, 300);
assert.deepEqual(ids(orderSoccerCollectionGames(games, attempts)), ids([middle, early, late]));

// Reproduce many failed batches, rather than checking just one comparison.
// Kickoff-first retries repeatedly select early and never revisit the others.
const visited = [];
for (let batch = 0; batch < 9; batch++) {
  const next = orderSoccerCollectionGames(games.values(), attempts)[0];
  visited.push(next.id);
  attempts.set(next.id, 400 + batch);
}
assert.deepEqual(visited, ids([middle, early, late, middle, early, late, middle, early, late]));
assert.deepEqual(ids(orderSoccerCollectionGames([late, early, middle], new Map(games.map(g => [g.id, 1])))),
  ids([early, middle, late]), 'equal attempt times use kickoff order');
const tie = { ...early, id: 'soccer:epl:0' };
assert.deepEqual(ids(orderSoccerCollectionGames([early, tie])), ids([tie, early]));
assert.deepEqual(orderSoccerCollectionGames([]), []);
console.log('PASS prospective collection ordering: untouched priority, repeated-failure rotation, deterministic ties and no schedule mutation');
