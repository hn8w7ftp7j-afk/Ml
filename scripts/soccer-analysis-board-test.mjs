import assert from 'node:assert/strict';
import { buildSoccerAnalysisBoard, loadSoccerAnalysisBoard } from '../lib/soccer/analysis-board.js';

const now = Date.parse('2026-10-19T02:00:00.000Z'), date = '2026-10-19';
const team = (sourceId, name) => ({ sourceId, name });
const game = (day = '2026-10-20', id = '12345', league = 'epl') => ({ id: `soccer:${league}:${id}`, sourceId: id,
  league, date: day, startTime: `${day}T13:00:00.000Z`, status: 'scheduled',
  home: team('367', 'Tottenham Hotspur'), away: team('388', 'Coventry City') });
const schedule = (games, league = 'epl') => ({ ok: true, league: { id: league }, games, sources: [] });
const reader = (official, { league = 'EPL', offset = 0, reverse = false } = {}) => ({ league,
  observedAt: new Date(now + offset).toISOString(), games: [{ boardDate: official.date, boardTime: '21:00',
    homeKey: globalThis.Tai888SoccerTeams.key(reverse ? official.away.name : official.home.name),
    awayKey: globalThis.Tai888SoccerTeams.key(reverse ? official.home.name : official.away.name),
  }] });

const selected = game(date);
let sourceCalls = 0;
const current = await loadSoccerAnalysisBoard('EPL', date, { now, upcoming: true,
  loadSchedule: async (league, day) => { sourceCalls++; assert.equal(league, 'epl'); assert.equal(day, date); return schedule([selected]); },
  loadReaderDates: async () => [], loadReader: async () => null,
});
assert.equal(sourceCalls, 1); assert.equal(current.date, date); assert.equal(current.requestedDate, date);
assert.equal(current.league, 'EPL'); assert.equal(current.tasks.length, 1);
assert.equal(current.mode, 'RESEARCH_ONLY'); assert.equal(current.formalScoringEnabled, false); assert.equal(current.executable, false);
assert.deepEqual(current.tasks[0].soccerQuery, { league: 'epl', date, eventId: selected.sourceId });
assert.equal(current.tasks[0].game.gamePk, Number(selected.sourceId));
assert.ok(!('body' in current.tasks[0])); assert.ok(!('actualMarkets' in current.tasks[0]));

const activeReaderGame = game('2026-10-20', '12348');
let fallbackWindowRead = false;
const readerPriority = await loadSoccerAnalysisBoard('EPL', date, { now, upcoming: true,
  loadSchedule: async (_league, day, options = {}) => {
    fallbackWindowRead ||= Boolean(options.windowDays);
    return schedule(day === date ? [selected] : [activeReaderGame]);
  }, loadReaderDates: async () => [activeReaderGame.date],
  loadReader: async (_league, day) => day === activeReaderGame.date ? reader(activeReaderGame) : null,
});
assert.equal(readerPriority.date, activeReaderGame.date, 'global upcoming runs follow the fresh, officially joined Reader slate before an unmatched selected slate');
assert.equal(fallbackWindowRead, false);

const hinted = game('2026-10-22', '12346'), earlier = game('2026-10-21', '12347');
async function upcoming(snapshot) {
  const calls = [];
  const result = await loadSoccerAnalysisBoard('EPL', date, { now, upcoming: true,
    loadSchedule: async (league, day, options = {}) => {
      calls.push({ league, day, options });
      if (options.windowDays) return schedule([earlier, hinted]);
      return schedule(day === hinted.date ? [hinted] : []);
    },
    loadReaderDates: async () => [hinted.date, hinted.date, 'invalid', '2026-10-18'],
    loadReader: async () => snapshot,
  });
  return { result, calls };
}
const fresh = await upcoming(reader(hinted));
assert.equal(fresh.result.date, hinted.date, 'a fresh Reader hint must join the same future official event');
assert.equal(fresh.calls.some(call => call.options.windowDays), false);
for (const snapshot of [reader(hinted, { offset: -180001 }), reader(hinted, { league: 'UCL' }), reader(hinted, { reverse: true }), null]) {
  const { result, calls } = await upcoming(snapshot);
  assert.equal(result.date, earlier.date, 'stale, foreign, reversed or absent quotes cannot select a hinted slate');
  assert.ok(calls.some(call => call.options.windowDays === 8));
  assert.equal(result.tasks[0].game.id, earlier.id);
}
const exact = await loadSoccerAnalysisBoard('UCL', date, { now, upcoming: false,
  loadSchedule: async league => schedule([], league),
  loadReaderDates: async () => { throw Error('explicit selected date'); },
});
assert.equal(exact.date, date); assert.equal(exact.emptyReason, 'no_games');
assert.equal(exact.league, 'UCL'); assert.deepEqual(exact.tasks, []);
const past = await loadSoccerAnalysisBoard('EPL', '2026-10-01', { now, upcoming: true,
  loadSchedule: async (_league, day) => { assert.equal(day, date); return schedule([selected]); },
});
assert.equal(past.date, date); assert.equal(past.requestedDate, '2026-10-01');
assert.equal(buildSoccerAnalysisBoard('EPL', date, schedule([game(date, '9007199254740993')]), { now }).tasks.length, 0);
assert.equal(buildSoccerAnalysisBoard('EPL', date, schedule([{ ...selected, status: 'in_progress' }]), { now }).tasks.length, 0);
assert.equal(buildSoccerAnalysisBoard('EPL', date, schedule([{ ...selected, startTime: new Date(now).toISOString() }]), { now }).tasks.length, 0);
assert.equal(buildSoccerAnalysisBoard('EPL', date, schedule([game(date, '12345', 'ucl')]), { now }).tasks.length, 0);
assert.throws(() => buildSoccerAnalysisBoard('EPL', date, schedule([], 'ucl'), { now }), /官方賽程/);
await assert.rejects(() => loadSoccerAnalysisBoard('NHL', date), /聯盟/);
await assert.rejects(() => loadSoccerAnalysisBoard('EPL', '2026-02-30'), /日期/);
await assert.rejects(() => loadSoccerAnalysisBoard('EPL', date, { now, loadSchedule: async () => ({ ok: false, code: 'SOURCE_FAILED' }) }), /官方賽程/);
console.log('PASS soccer analysis board: selected official slate, safe future Reader/official matching, stale/foreign/reversed rejection, attributed upcoming date discovery, strict identities and research-only tasks.');
