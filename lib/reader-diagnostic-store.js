import { createHash } from 'node:crypto';
import { durableDatabaseConfigured, durableDatabaseUrl } from './database-url.js';
import { sanitizeDiagnosticReport } from '../reader/diagnostic-schema.js';

const schemas = new WeakMap();
let client;
const failure = (message, status = 503) => Object.assign(new Error(message), { status });
async function database(options) {
  if (options.sql) return options.sql;
  if (!durableDatabaseConfigured()) throw failure('診斷資料庫尚未設定，Reader 將保留待補傳紀錄');
  if (!client) { const { neon } = await import('@neondatabase/serverless'); client = neon(durableDatabaseUrl()); }
  return client;
}
export async function diagnosticSchema(sql) {
  if (!schemas.has(sql)) schemas.set(sql, sql`CREATE TABLE IF NOT EXISTS sports_reader_diagnostics_v1 (
    report_id UUID PRIMARY KEY, device_id TEXT NOT NULL, received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '14 days'),
    checksum TEXT NOT NULL, payload JSONB NOT NULL
  )`.catch(error => { schemas.delete(sql); throw error; }));
  await schemas.get(sql);
}
export async function saveReaderDiagnostic(input, deviceId, options = {}) {
  if (!/^[a-zA-Z0-9._:-]{8,100}$/.test(deviceId || '')) throw failure('診斷裝置無效', 400);
  const report = sanitizeDiagnosticReport(input);
  const serialized = JSON.stringify(report);
  const checksum = createHash('sha256').update(serialized).digest('hex');
  const sql = await database(options); await diagnosticSchema(sql);
  const rows = await sql`INSERT INTO sports_reader_diagnostics_v1 (report_id, device_id, checksum, payload)
    VALUES (${report.reportId}::uuid, ${deviceId}, ${checksum}, ${serialized}::jsonb)
    ON CONFLICT (report_id) DO UPDATE SET report_id=EXCLUDED.report_id
      WHERE sports_reader_diagnostics_v1.device_id=EXCLUDED.device_id
        AND sports_reader_diagnostics_v1.checksum=EXCLUDED.checksum
    RETURNING report_id, received_at`;
  if (rows.length !== 1) throw failure('診斷回報識別碼衝突', 409);
  // Retention is enforced on reads even if cleanup fails. An acknowledged
  // insert remains acknowledged; cleanup must never turn it into a false failure.
  await sql`DELETE FROM sports_reader_diagnostics_v1 WHERE report_id IN (
    SELECT report_id FROM sports_reader_diagnostics_v1 WHERE expires_at <= NOW() LIMIT 100
  )`.catch(() => {});
  return { ok: true, durable: true, reportId: String(rows[0].report_id), receivedAt: new Date(rows[0].received_at).toISOString() };
}
export async function listReaderDiagnostics({ deviceId = '', league = '' } = {}, options = {}) {
  const sql = await database(options); await diagnosticSchema(sql);
  return sql`SELECT report_id, device_id, received_at, payload FROM sports_reader_diagnostics_v1
    WHERE expires_at > NOW() AND (${deviceId} = '' OR device_id = ${deviceId})
      AND (${league} = '' OR payload->'leagues' ? ${league})
    ORDER BY received_at DESC LIMIT 30`;
}
