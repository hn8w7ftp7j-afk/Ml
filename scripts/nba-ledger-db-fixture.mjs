// Emit the production SQL with synthetic contracts for the PostgreSQL CI job.
import { archiveNbaManualBetRecord, archiveNbaManualSettlement } from '../lib/nba/manual-bet-store.js';
import { saveNbaAnalysisCapture } from '../lib/nba/analysis-journal.js';
import { nbaManualContractHash } from '../lib/nba/manual-bet-settlement.js';
const literal = value => value == null ? 'NULL' : typeof value === 'number' ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
let record, settlement;
const db = async (strings, ...values) => {
  const sql = strings.reduce((text, part, i) => text + part + (i < values.length ? literal(values[i]) : ''), '');
  console.log(`${sql};`);
  if (sql.includes('INSERT INTO nba_manual_bet_records')) { record = JSON.parse(values[3]); return [{ payload: record }]; }
  if (sql.includes('INSERT INTO nba_manual_bet_settlements')) return [{ payload: settlement }];
  if (sql.includes('INSERT INTO nba_analysis_forward')) return [{ revision: values[0], captured_at: new Date() }];
  return [];
};
const input = { alreadyPlaced: true, gameId: 'nba:espn:game:401999001', date: '2026-10-06',
  marketKey: 'fullTotal', side: 'over', line: '220+25', water: .94, stake: 10000,
  away: 'synthetic away', home: 'synthetic home', startTime: '2026-10-06T02:00:00Z' };
await archiveNbaManualBetRecord(input, { db, id: '11111111-1111-4111-8111-111111111111' });
settlement = { status: 'SETTLED', contractHash: nbaManualContractHash(record), profit: 2387.5 };
await archiveNbaManualSettlement(record, settlement, { db });
await archiveNbaManualSettlement(record, { ...settlement, profit: 999999 }, { db });
console.log(`DO $$ BEGIN
 IF (SELECT count(*) FROM nba_manual_bet_settlements_v1) <> 1 THEN RAISE EXCEPTION 'duplicate settlement'; END IF;
 IF (SELECT payload->>'profit' FROM nba_manual_bet_settlements_v1) <> '2387.5' THEN RAISE EXCEPTION 'result overwritten'; END IF;
END $$;`);
console.log(`UPDATE nba_manual_bet_records_v1 SET payload = payload || '{"status":"CANCELLED"}'::jsonb;
DELETE FROM nba_manual_bet_settlements_v1;`);
await archiveNbaManualSettlement(record, settlement, { db });
console.log(`DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM nba_manual_bet_settlements_v1) THEN RAISE EXCEPTION 'cancelled record settled'; END IF;
 IF (SELECT payload->>'line' FROM nba_manual_bet_records_v1) <> '220+25' THEN RAISE EXCEPTION 'original contract changed'; END IF;
END $$;
UPDATE nba_manual_bet_records_v1 SET payload = payload || '{"status":"OPEN"}'::jsonb;`);
await archiveNbaManualSettlement(record, settlement, { db });
console.log(`DO $$ BEGIN
 IF (SELECT count(*) FROM nba_manual_bet_settlements_v1) <> 1 THEN RAISE EXCEPTION 'duplicate settlement'; END IF;
 IF (SELECT payload->>'profit' FROM nba_manual_bet_settlements_v1) <> '2387.5' THEN RAISE EXCEPTION 'result overwritten'; END IF;
END $$;`);
const analysis = { status: 'ready', league: 'NBA', gameId: input.gameId, date: input.date, prediction: { total: 220 }, quoteHash: 'a'.repeat(64),
  game: { status: 'scheduled', completed: false, timeConfirmed: true, startTime: '2200-01-01T00:00:00Z' } };
await saveNbaAnalysisCapture(analysis, { db });
await saveNbaAnalysisCapture({ ...analysis, game: { ...analysis.game, startTime: '2000-01-01T00:00:00Z' } }, { db });
console.log(`DO $$ BEGIN
 IF (SELECT count(*) FROM nba_analysis_forward_v1) <> 1 THEN RAISE EXCEPTION 'post-tipoff capture accepted'; END IF;
END $$;`);
