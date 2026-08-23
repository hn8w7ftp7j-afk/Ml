import assert from 'node:assert/strict';
import { buildSavantAdvancedSnapshotV2, parseCsvV2 } from '../lib/mlb-savant-advanced-v2.js';

assert.deepEqual(parseCsvV2('"a,b",c\n"x,y",2\n'), [{ 'a,b': 'x,y', c: '2' }]);

const responses = new Map([
  ['fielding-run-value', '"name","id","total_runs","framing_runs","outs_total"\n"A",1,9,0,2430\n"C",2,5,2,2430\n"H",11,-4,0,2430\n"HC",12,1,1,2430\n'],
  ['catcher-framing', '"id","name","pitches","rv_tot"\n2,"C",2000,2\n12,"HC",1800,1\n'],
  ['type=batter', '"last_name, first_name","player_id","pitch_type","run_value_per_100","pitches","pitch_usage"\n"A",1,"FF",0.5,1000,50\n"A",1,"CU",-0.5,1000,50\n"C",2,"FF",0.1,900,45\n"C",2,"CU",-0.1,900,55\n"H",11,"FF",-0.2,800,44\n"H",11,"CU",0.2,800,56\n"HC",12,"FF",0.2,700,40\n"HC",12,"CU",-0.2,700,60\n'],
  ['type=pitcher', '"last_name, first_name","player_id","pitch_type","run_value_per_100","pitches","pitch_usage"\n"P",100,"FF",0,1200,80\n"P",100,"CU",0,500,20\n"Q",200,"FF",0,1100,75\n"Q",200,"CU",0,500,25\n'],
]);
const fetchImpl = async url => ({ ok: true, status: 200, text: async () => {
  const key = [...responses.keys()].find(value => String(url).includes(value));
  return responses.get(key) || '';
} });
const lineup = (first, catcher) => ({ official: true, players: Array.from({ length: 9 }, (_, index) => ({ id: index === 1 ? catcher : first, position: index === 1 ? 'C' : 'OF' })) });
const snapshot = await buildSavantAdvancedSnapshotV2({
  game: { gameDate: '2026-08-23T00:00:00Z' },
  away: { lineup: lineup(1, 2), starter: { id: 100, expectedInnings: 5 } },
  home: { lineup: lineup(11, 12), starter: { id: 200, expectedInnings: 5 } },
}, { fetchImpl, ttlMs: 1 });
assert.equal(snapshot.sourceStatus.fielding, 'CONFIRMED');
assert.equal(snapshot.away.fielding.includesCatcherFraming, true);
assert.ok(snapshot.away.fielding.regressedValue.embeddedFramingRuns > 0);
assert.equal(snapshot.away.fielding.catcherFramingRuns, snapshot.away.fielding.regressedValue.embeddedFramingRuns);
assert.ok(snapshot.away.fielding.rawValue.fieldingRunValue > snapshot.away.fielding.regressedValue.fieldingRunValue);
assert.equal(snapshot.away.fielding.appliedValue.nonFramingRunsPerGame, 0);
assert.equal(snapshot.away.catcherFraming.framingRuns, 2);
assert.ok(snapshot.away.pitchTypeMatchup.centeredRunValuePer100 > 0);
assert.ok(snapshot.away.pitchTypeMatchup.rawValue.batterAudit.every(row => Number.isFinite(row.overallBatterRunValuePer100)));
assert.ok(snapshot.away.pitchTypeMatchup.rawValue.centeredRunValuePer100 > snapshot.away.pitchTypeMatchup.regressedValue.centeredRunValuePer100);
assert.equal(snapshot.away.pitchTypeMatchup.appliedValue.runDelta, 0);
assert.equal(snapshot.historicalArchive, false);
console.log('mlb-savant-advanced-v2-test: PASS');
