import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { MAIN_SOCCER_LEAGUES, mainSportHref, mainSportSelection } from '../lib/main-sport-navigation.js';
import { allLeagueBoardDate } from '../lib/all-league-analysis-v117.js';
import { soccerAnalysisResultHref } from '../lib/soccer/analysis-link.js';

for (const sport of ['NBA', ...MAIN_SOCCER_LEAGUES]) {
  const href = mainSportHref(sport, { date: '2026-10-22', view: 'upcoming', runId: 'workflow-navigation-101' });
  assert.equal(new URL(href, 'https://fixture.invalid').pathname, '/');
  assert.equal(mainSportSelection(new URL(href, 'https://fixture.invalid').search), sport);
  if (sport === 'NBA') assert.doesNotMatch(href, /view|runId/);
}
assert.equal(mainSportSelection('?league=epl'), 'EPL');
assert.equal(mainSportSelection('?sport=ucl'), 'UCL');
assert.equal(mainSportSelection('?sport=unknown&league=KBO'), 'BASEBALL');
assert.equal(mainSportSelection('?sport=NBA&league=EPL'), 'NBA');
assert.equal(mainSportHref('BASEBALL', { league: 'NPB', date: '2026-10-23', view: 'standings', runId: 'foreign-football-run' }), '/?league=NPB&date=2026-10-23');
assert.equal(mainSportHref('EPL', { date: '2026-02-30', runId: '<script>bad</script>', view: 'foreign' }), '/?sport=EPL');
assert.equal(mainSportHref('NHL'), null);
assert.equal(soccerAnalysisResultHref('UCL', '2026-10-22', 'workflow-navigation-101'), '/?sport=UCL&date=2026-10-22&runId=workflow-navigation-101');

const source = fs.readFileSync('app/page.js', 'utf8');
function handler(name) {
  const start = source.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, `shipped ${name} handler exists`);
  const end = source.indexOf('\n  }', start);
  return source.slice(start, end + 4);
}
const writes = [], scopes = {};
let selected = '', nba = false, opened = [], entries = {}, baseball = '';
const ctx = vm.createContext({
  MAIN_SOCCER_LEAGUES, mainSportHref, allLeagueBoardDate,
  nbaDate: '2026-10-21', date: '2026-10-19', taipeiDate: () => '2026-10-19',
  allLeagueRunRef: { current: { runId: 'workflow-navigation-101', leagues: { EPL: { boardDate: '2026-10-20' }, UCL: { boardDate: '2026-10-22' }, KBO: { boardDate: '2026-10-23' } } } },
  leagueDatesRef: { current: {} }, soccerScopesRef: { current: scopes },
  setNbaSelected: value => { nba = value; }, setSoccerSelected: value => { selected = value; },
  setSoccerOpened: update => { opened = update(opened); }, setSoccerEntryScopes: update => { entries = update(entries); },
  selectLeague: value => { baseball = value; },
  window: { history: { replaceState: (_state, _title, href) => writes.push(href) } },
});
vm.runInContext(['selectSoccer', 'selectNba', 'selectBaseball'].map(handler).join('\n'), ctx);
ctx.selectSoccer('EPL'); assert.equal(selected, 'EPL'); assert.equal(nba, false);
assert.equal(writes.at(-1), '/?sport=EPL&date=2026-10-20&runId=workflow-navigation-101');
scopes.EPL = { date: '2026-10-25', view: 'standings', runId: '' };
ctx.selectSoccer('UCL'); assert.equal(writes.at(-1), '/?sport=UCL&date=2026-10-22&runId=workflow-navigation-101');
ctx.selectSoccer('EPL'); assert.equal(writes.at(-1), '/?sport=EPL&date=2026-10-25&view=standings', 'returning to a league retains its manual date/view');
ctx.selectSoccer('EPL', { date: '2026-10-20', runId: 'workflow-navigation-101' });
assert.equal(entries.EPL.date, '2026-10-20'); assert.match(writes.at(-1), /runId=workflow-navigation-101/);
ctx.selectNba(); assert.equal(nba, true); assert.equal(selected, ''); assert.equal(writes.at(-1), '/?sport=NBA&date=2026-10-21');
ctx.selectBaseball('KBO'); assert.equal(nba, false); assert.equal(selected, ''); assert.equal(baseball, 'KBO');
assert.equal(writes.at(-1), '/?league=KBO&date=2026-10-23');
assert.deepEqual(Array.from(opened), ['EPL', 'UCL']);
const count = writes.length; ctx.selectSoccer('MLB'); assert.equal(writes.length, count, 'football dispatch never accepts baseball scope');
assert.doesNotMatch(handler('selectSoccer'), /location\.(?:href|assign|replace)|\/soccer/);
assert.match(source, /hidden=\{nbaSelected \|\| Boolean\(soccerSelected\)\}/);
console.log('PASS root sport navigation, shipped in-page selection handlers, independent dates, explicit saved-result restoration and scope boundaries');
