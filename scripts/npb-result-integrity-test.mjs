import assert from 'node:assert/strict';
import {
  normalizeAsianFinalResult,
  parseNpbGameDetailHtml,
  parseNpbScheduleHtml,
} from '../lib/asian-baseball.js';

const date = '2026-09-02';
const [game] = parseNpbScheduleHtml(`
  <a href="/bis/eng/2026/games/s2026090200001.html"><div class="unit">
    <div class="team_name">DeNA</div><div class="round">Yokohama<br>18:00</div>
    <div class="team_name">Yomiuri</div>
  </div></a>`, date);
const awayLine = [1, 1, 0, 0, 1, 0, 0, 0, 0];
const homeLine = [2, 0, 0, 0, 1, 0, 0, 1, 'X'];
const detailHtml = ({
  away = awayLine, home = homeLine, awayRuns = 3, homeRuns = 4,
  separator = true, duplicate = false, endClock = true, headlines = [homeRuns, awayRuns],
  layoutSpacers = false, spacerContent = '<br>',
} = {}) => {
  const row = (team, innings, runs) => `<tr><th class="gmscoreteam">${team}</th>${innings.map((value, index) =>
    `<td class="gmscore">${value ?? ''}</td>${layoutSpacers && [3, 6, 9].includes(index + 1) ? `<td class="gmscspan">${spacerContent}</td>` : ''}`,
  ).join('')}${[...(separator ? ['-'] : []), runs, 10, 0]
    .map(value => `<td class="gmscore">${value}</td>`).join('')}</tr>`;
  const rows = row('Yomiuri', away, awayRuns) + row('DeNA', home, homeRuns);
  return `<div id="gmdivinfo">${endClock ? '( 18:00 - 21:00 )' : '18:00'}</div>
    <div id="gmdivscore">${headlines.map(value => `<span class="gmboxrun">${value}</span>`).join('')}</div>
    <div id="gmdivresult"><table>${rows}${duplicate ? rows : ''}</table></div>`;
};
const parse = options => parseNpbGameDetailHtml(detailHtml(options), game);
const invalid = (name, options) => assert.throws(
  () => parse(options),
  error => error?.code === 'OFFICIAL_FINAL_RESULT_INVALID',
  name,
);

// Both observed layouts, responsive duplicates and an unplayed bottom ninth
// retain the same independently calculated full-game/F5 scores.
for (const separator of [true, false]) {
  for (const duplicate of [true, false]) {
    const result = parse({ separator, duplicate });
    assert.deepEqual(
      [result.awayScore, result.homeScore, result.awayFirst5, result.homeFirst5, result.innings],
      [3, 4, 3, 3, 9],
    );
    assert.equal(result.first5Complete, true);
    assert.equal(normalizeAsianFinalResult('NPB', game.gamePk, date, result).final, true);
  }
  const omittedBottom = parse({ separator, home: homeLine.slice(0, -1) });
  assert.equal(omittedBottom.innings, 9);
  assert.equal(omittedBottom.homeFirst5, 3);
}

const walkoff = parse({ home: [2, 0, 0, 0, 1, 0, 0, 0, '1X'] });
assert.equal(walkoff.homeScore, 4);
assert.equal(walkoff.homeFirst5, 3);
const awayWinner = parse({
  away: [4, 0, 0, 0, 0, 0, 0, 0, 0], awayRuns: 4,
  home: [3, 0, 0, 0, 0, 0, 0, 0, 0], homeRuns: 3,
});
assert.equal(awayWinner.innings, 9);
assert.equal(awayWinner.first5Complete, true);

// Official s2026090401413 uses empty gmscspan cells after innings 3/6/9.
// These fixtures retain that observed DOM structure without treating a blank
// gmscore cell as a spacer or changing the published draw-length rule.
const spacedNine = parse({ layoutSpacers: true });
assert.deepEqual([spacedNine.innings, spacedNine.awayFirst5, spacedNine.homeFirst5], [9, 3, 3]);
assert.equal(normalizeAsianFinalResult('NPB', game.gamePk, date, spacedNine).final, true);
const tenInningTie = [1, ...Array(9).fill(0)];
const spacedTen = parse({
  layoutSpacers: true, away: tenInningTie, home: tenInningTie, awayRuns: 1, homeRuns: 1,
});
assert.deepEqual([spacedTen.innings, spacedTen.awayScore, spacedTen.homeScore, spacedTen.first5Complete], [10, 1, 1, true]);
assert.throws(() => normalizeAsianFinalResult('NPB', game.gamePk, date, spacedTen),
  error => error?.code === 'OFFICIAL_FINAL_RESULT_INVALID');
const spacedWalkoff = parse({
  layoutSpacers: true, away: [...tenInningTie, 0], home: [...tenInningTie, '1X'], awayRuns: 1, homeRuns: 2,
});
assert.deepEqual([spacedWalkoff.innings, spacedWalkoff.awayFirst5, spacedWalkoff.homeFirst5], [11, 1, 1]);
assert.equal(normalizeAsianFinalResult('NPB', game.gamePk, date, spacedWalkoff).final, true);
invalid('An actual blank gmscore remains missing even next to layout spacers', {
  layoutSpacers: true, away: [1, '', 1, 0, 1, 0, 0, 0, 0],
});
for (const spacerContent of ['0', '?']) {
  invalid('Nonempty explicit layout spacers must fail closed', { layoutSpacers: true, spacerContent });
}

// These four corruptions previously certified a final F5 result.
invalid('Inning sums must agree with the official total', { away: [9, 0, 0, 0, 0, 0, 0, 0, 0] });
invalid('An away inning cannot use X', { away: ['X', 1, 1, 1, 0, 0, 0, 0, 0] });
invalid('A nine-inning away line cannot validate a five-inning home line', {
  home: [4, 0, 0, 0, 0],
});
for (const separator of [true, false]) {
  invalid('Blank interior cells must not shift later innings into the first five', {
    separator, away: [1, '', 1, 0, 1, 0, 0, 0, 0],
  });
  invalid('Unknown interior cells must not be filtered out', {
    separator, away: [1, '?', 1, 0, 1, 0, 0, 0, 0],
  });
  invalid('Interior separator cannot truncate the inning sequence', {
    separator, away: [1, '-', 1, 0, 1, 0, 0, 0, 0],
  });
}
invalid('Home X must be the final inning', { home: ['X', 0, 0, 0, 4, 0, 0, 0, 0] });
invalid('Home X requires a home lead', { homeRuns: 3, home: [3, 0, 0, 0, 0, 0, 0, 0, 'X'] });
invalid('Omitted home inning requires a home lead', { homeRuns: 3, home: [3, 0, 0, 0, 0, 0, 0, 0] });
invalid('Home cannot have more innings than away', { home: [2, 0, 0, 0, 1, 0, 0, 1, 0, 'X'] });
invalid('Headline totals must match as a pair, including draws', {
  homeRuns: 3, home: [3, 0, 0, 0, 0, 0, 0, 0, 0], headlines: [3, 4],
});
invalid('Unsafe integer inning values cannot certify a result', {
  away: ['9007199254740992', 0, 0, 0, 0, 0, 0, 0, 0],
});

// No end-time means no final result, even when a live line is incomplete.
assert.equal(parse({ endClock: false, away: [1, '', '', '', ''] }), game);
assert.equal(game.statusCode, 'S');

// Keep the published draw rules unchanged: parsing official innings does not
// authorize a shorter draw to bypass the existing final-result validator.
for (const innings of [10, 12]) {
  const tiedLine = [1, ...Array(innings - 1).fill(0)];
  const tied = parse({ away: tiedLine, home: tiedLine, awayRuns: 1, homeRuns: 1 });
  if (innings === 12) {
    assert.equal(normalizeAsianFinalResult('NPB', game.gamePk, date, tied).final, true);
  } else {
    assert.throws(
      () => normalizeAsianFinalResult('NPB', game.gamePk, date, tied),
      error => error?.code === 'OFFICIAL_FINAL_RESULT_INVALID',
    );
  }
}

console.log('NPB result integrity: exact inning cells, totals, legal X, valid layouts, live exclusion and locked draw rules PASS');
