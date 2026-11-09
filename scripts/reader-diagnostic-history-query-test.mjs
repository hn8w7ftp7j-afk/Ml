import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { parseReaderDiagnosticQuery, listReaderDiagnostics } from '../lib/reader-diagnostic-store.js';

const now = Date.parse('2026-11-09T02:00:00.000Z');
const parse = query => parseReaderDiagnosticQuery(new URLSearchParams(query), { now });
for (const query of ['from=2026-02-30', 'from=2026-11-09&through=2026-11-08',
  'until=2026-11-10T00:00:00.000Z', 'until=2026-02-30T00:00:00.000Z',
  'league=NBA&league=EPL', 'from=2026-11-08&from=2026-11-09', 'other=value', 'league=NFL']) {
  assert.throws(() => parse(query), error => error.status === 400);
}
const db = new PGlite();
const statements = [];
const sql = async (parts, ...values) => {
  const statement = parts.reduce((text, part, index) => text + (index ? `$${index}` : '') + part, '');
  statements.push(statement);
  return (await db.query(statement, values)).rows;
};
try {
  await db.exec(`CREATE TABLE sports_reader_diagnostics_v1 (
    report_id uuid primary key, device_id text, received_at timestamptz,
    expires_at timestamptz, payload jsonb);`);
  for (const [index, at, league] of [
    [1, '2026-11-07T15:59:59.999Z', 'NBA'],
    [2, '2026-11-07T16:00:00.000Z', 'NBA'],
    [3, '2026-11-08T00:58:16.000Z', 'NBA'],
    [4, '2026-11-08T01:00:00.000Z', 'NBA'],
    [5, '2026-11-08T16:00:00.000Z', 'NBA'],
    [6, '2026-11-08T00:57:00.000Z', 'EPL'],
  ]) await db.query(`INSERT INTO sports_reader_diagnostics_v1 VALUES ($1,$2,$3,now()+interval '1 day',$4)`,
    [`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, 'history-diagnostic-device', at,
      JSON.stringify({ leagues: { [league]: { state: 'synced' } } })]);
  const filters = parse('league=NBA&from=2026-11-08&through=2026-11-08&until=2026-11-08T00:59:00.000Z');
  const rows = await listReaderDiagnostics(filters, { sql });
  assert.deepEqual(rows.map(row => row.report_id.slice(-1)), ['3', '2'], 'Taipei date and original server receipt cutoff select historical reports without newer reports hiding them');
  assert.ok(statements.some(statement => /AT TIME ZONE 'Asia\/Taipei'/.test(statement)));
  assert.ok(statements.every(statement => !/\b(?:INSERT|UPDATE|DELETE|ALTER|DROP)\b/i.test(statement)), 'historical diagnostic lookup does not mutate source data');
  assert.equal((await listReaderDiagnostics({}, { sql })).length, 6, 'existing unfiltered query remains compatible');
} finally { await db.close(); }
console.log('Reader historical diagnostics: validated filters, Taipei boundary, original receipt cutoff and league isolation PASS');
