import assert from 'node:assert/strict';
import fs from 'node:fs';

const route = fs.readFileSync(new URL('../app/api/credit-lines/route.js', import.meta.url), 'utf8');
const parser = fs.readFileSync(new URL('../lib/tai888-reader-parser-v2.js', import.meta.url), 'utf8');

assert.match(
  route,
  /const requestNow = Date\.now\(\);[\s\S]*const currentPrestartPks = new Set\(filterLeaguePrestartGames\([\s\S]*requestNow,[\s\S]*const currentSchedule = schedule\.filter/,
  'credit-lines must re-evaluate official prestart games at request time, not only at Reader capture time',
);
assert.match(route, /const requestedGamePks = new Set\(currentSchedule\.map/, 'all signed rows must be scoped to games that are still prestart now');
assert.match(route, /if \(!currentSchedule\.length\)[\s\S]*code: 'NO_PRESTART_GAMES'[\s\S]*games: \[\],[\s\S]*unopenedGames: \[\]/, 'post-start slates must return an explicit empty result');
assert.match(route, /games\.length \+ unopenedGames\.length === currentSchedule\.length/, 'Reader completeness must use the current prestart subset');
assert.match(route, /scheduleGameCount: currentSchedule\.length/, 'responses must not claim post-start games as pending Reader work');
assert.match(parser, /officialPrestartSlate\(officialSchedule, captureTime\)\.length !== officialSchedule\.length/, 'the parser must reject writable slates contaminated with post-start games');

console.log('Reader current-prestart boundary v11.6.1 PASS');
