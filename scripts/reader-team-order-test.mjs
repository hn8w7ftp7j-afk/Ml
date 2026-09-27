import assert from 'node:assert/strict';
import { parseTai888Capture } from '../reader/parser.js';

const cell = pair => ({ pair, lines: pair });
const now = new Date('2026-09-27T07:00:00Z');
let checks = 0;
for (const league of ['MLB', 'NPB', 'KBO', 'CPBL']) {
  for (const favorite of [0, 1]) {
    function capture(homeFirst) {
      const teams = ['AAA - 客隊', 'BBB - 主隊 [主]'];
      const full = favorite === 0 ? ['1-75 0.980', '0.920'] : ['0.980', '1-75 0.920'];
      const half = favorite === 0 ? ['0.940', '0+50 0.960'] : ['0+50 0.940', '0.960'];
      if (homeFirst) { teams.reverse(); full.reverse(); half.reverse(); }
      return { league, tables: [{ headers: ['時間', '隊伍', '讓球', '大小盤', '上半讓球', '上半大小'], rows: [{ cells: [
        cell(['09-27', '16:00']), cell(teams), cell(full),
        cell(['9平 大 0.900', '小 0.940']), cell(half), cell(['5平 大 0.910', '小 0.950']),
      ] }] }] };
    }
    const a = parseTai888Capture(capture(false), now).games[0];
    const b = parseTai888Capture(capture(true), now).games[0];
    assert.ok(a && b);
    assert.deepEqual(b, a, `${league}: visual row order must not change team, price, or direction`);
    assert.equal(b.fullRunline.lineSide, favorite === 0 ? 'away' : 'home');
    assert.equal(b.fullRunline.awayWater, 0.980);
    assert.equal(b.fullRunline.homeWater, 0.920);
    assert.equal(b.first5Runline.lineSide, favorite === 0 ? 'home' : 'away');
    checks += 6;
  }
}
console.log(`Reader team-order regression: ${checks} assertions PASS`);
