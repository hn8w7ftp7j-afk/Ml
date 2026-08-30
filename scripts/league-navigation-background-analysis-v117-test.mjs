import assert from 'node:assert/strict';
import fs from 'node:fs';

const page = fs.readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');

assert.match(
  page,
  /const itemLeague = String\(analysis\.leagueId \|\| item\?\.game\?\.leagueId \|\| item\?\.game\?\.league \|\| ''\)[\s\S]*?if \(itemLeague !== league\) return \[\]/,
  'ranking and bet-order source must reject cards from every other league',
);
assert.match(
  page,
  /currentLeagueRef\.current = nextLeague;[\s\S]*?boardRef\.current = \[\];[\s\S]*?setBoard\(\[\]\);[\s\S]*?setSchedule\(\[\]\);/,
  'league switch must synchronously detach the previous league board before a fast analyze click',
);

assert.doesNotMatch(
  page,
  /className=\{league === id \? 'active' : ''\} disabled=\{busy\}/,
  'background analysis must not disable league navigation',
);
assert.match(
  page,
  /if \(operationBusyRef\.current\) \{[\s\S]*operationBusyRef\.current = false;[\s\S]*setProgress\(value => \(\{ \.\.\.value, active: false, running: 0 \}\)\);/,
  'switching leagues must detach only the visible screen from the old background poll',
);
assert.match(
  page,
  /finally \{[\s\S]*if \(generation === analysisGenerationRef\.current && currentDateRef\.current === targetDate\) \{[\s\S]*releaseOperation\(\);[\s\S]*setProgress/,
  'an old league run must not release or rewrite the newly selected league operation state',
);

console.log('League navigation remains available during durable background analysis PASS');
