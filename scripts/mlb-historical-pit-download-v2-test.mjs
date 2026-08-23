import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./mlb-historical-pit-download-v2.mjs', import.meta.url), 'utf8');
assert.match(source, /createGzip\(\{ level: 9 \}\)/);
assert.match(source, /sha256File/);
assert.match(source, /\.csv\.gz/);
assert.match(source, /AbortSignal\.timeout\(120000\)/);
assert.match(source, /game_type: 'R'/);
assert.match(source, /statsapi\.mlb\.com\/api\/v1\/schedule/);
assert.match(source, /officialSchedule/);
assert.match(source, /scheduleFiles/);
assert.match(source, /previous\?\.sha256.*existsSync.*sha256File/s, 'resume must verify content, not merely trust filename');
assert.doesNotMatch(source, /coefficient|candidateAway|actualAway/, 'raw downloader must not train or use outcomes');
console.log('Resumable immutable Statcast PIT downloader PASS');
