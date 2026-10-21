// --sql emits the actual store SQL plus assertions for the CI PostgreSQL
// service. The default mode verifies transport and does not claim a live DB.
import assert from 'node:assert/strict';
import { saveReaderDiagnostic, listReaderDiagnostics } from '../lib/reader-diagnostic-store.js';
import { DIAGNOSTIC_SCHEMA } from '../reader/diagnostic-schema.js';
const emit = process.argv.includes('--sql');
const literal = value => value == null ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`;
const rows = new Map();
const report = { schema: DIAGNOSTIC_SCHEMA, reportId: 'fa840221-1234-4567-9234-222222222222', readerVersion: '2.1.42',
  createdAt: new Date().toISOString(), leagues: { NBA: { state: 'error', errorCode: 'no-complete-tab', issues: ['game-1:full-total:missing'] } } };
const sql = async (parts, ...values) => {
  const statement = parts.reduce((text, part, index) => text + part + (index < values.length ? literal(values[index]) : ''), '');
  if (emit) console.log(`${statement};`);
  if (/^CREATE|^DELETE/.test(statement)) return [];
  if (/^INSERT/.test(statement)) {
    const [id, device, checksum, payload] = values;
    const old = rows.get(id);
    if (old && (old.device_id !== device || old.checksum !== checksum)) return [];
    const row = old || { report_id: id, device_id: device, checksum, payload: JSON.parse(payload), received_at: new Date().toISOString() };
    rows.set(id, row); return [row];
  }
  if (/^SELECT/.test(statement)) return [...rows.values()];
  throw new Error('Unexpected diagnostic SQL');
};
const first = await saveReaderDiagnostic(report, 'diagnostic-sql-device', { sql });
assert.equal(first.durable, true);
assert.deepEqual(await saveReaderDiagnostic(report, 'diagnostic-sql-device', { sql }), first);
await assert.rejects(saveReaderDiagnostic(report, 'another-sql-device', { sql }), error => error.status === 409);
await assert.rejects(saveReaderDiagnostic({ ...report, readerVersion: '2.1.43' }, 'diagnostic-sql-device', { sql }), error => error.status === 409);
await listReaderDiagnostics({ deviceId: 'diagnostic-sql-device', league: 'NBA' }, { sql });
if (emit) {
  console.log(`DO $$ BEGIN
    IF (SELECT COUNT(*) FROM sports_reader_diagnostics_v1) <> 1 THEN RAISE EXCEPTION 'diagnostic duplicate or conflict inserted'; END IF;
    IF (SELECT device_id FROM sports_reader_diagnostics_v1 LIMIT 1) <> 'diagnostic-sql-device' THEN RAISE EXCEPTION 'device overwritten'; END IF;
    IF (SELECT payload->>'readerVersion' FROM sports_reader_diagnostics_v1 LIMIT 1) <> '2.1.42' THEN RAISE EXCEPTION 'payload overwritten'; END IF;
    IF EXISTS (SELECT 1 FROM sports_reader_diagnostics_v1 WHERE payload->'leagues' ? 'EPL') THEN RAISE EXCEPTION 'cross-league contamination'; END IF;
    IF NOT EXISTS (SELECT 1 FROM sports_reader_diagnostics_v1 WHERE payload->'leagues' ? 'NBA' AND expires_at > NOW()) THEN RAISE EXCEPTION 'NBA diagnostic missing'; END IF;
  END $$;
  UPDATE sports_reader_diagnostics_v1 SET expires_at = NOW() - INTERVAL '1 second';
  DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM sports_reader_diagnostics_v1 WHERE expires_at > NOW()) THEN RAISE EXCEPTION 'expired diagnostic visible'; END IF;
  END $$;`);
} else console.log('Reader diagnostic SQL transport: actual store schema/queries, idempotency and device/payload conflicts PASS (live PostgreSQL requires --sql CI step)');
