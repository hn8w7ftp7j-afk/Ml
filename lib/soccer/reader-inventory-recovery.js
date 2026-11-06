import { createHmac } from 'node:crypto';
import { soccerJournalQuery } from './journal.js';
import { validSoccerDate } from './contracts.js';
import { continueReaderInventoryScan, SOCCER_READER_INVENTORY_SCAN_VERSION } from './reader-inventory-scan.js';

const validScope = ({ league, date }) => ['epl', 'ucl'].includes(league) && validSoccerDate(date);
export function readerInventoryPublicId(cursor) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || !secret.trim() || !/^[a-f0-9]{48}$/.test(cursor || '')) throw Error('INVALID_PUBLIC_ID_INPUT');
  return createHmac('sha256', secret).update('soccer-reader-inventory-public-id-v1\0', 'utf8').update(cursor, 'utf8').digest('hex');
}
const count = value => { const n = Number(value); if (!Number.isSafeInteger(n) || n < 0) throw Error('INVALID_STATE'); return n; };

// A scope can hold at most 1000 immutable jobs. If that invariant is ever
// violated, report the truncation rather than claiming an exhaustive list.
async function jobs(scope, query) {
  if (!validScope(scope)) throw Error('INVALID_SCOPE');
  const [table] = await query("SELECT to_regclass('sports_soccer_reader_inventory_scans_v1') IS NOT NULL AS present");
  if (!table?.present) return { entries: [], complete: true };
  const rows = await query(`SELECT cursor,lower(league) AS league,board_date::text,version,
    to_char(started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS started_at,
    status,expected_count,verified_count,observed_count,reason_codes
    FROM sports_soccer_reader_inventory_scans_v1 WHERE league=$1 AND board_date=$2::date
    ORDER BY started_at DESC,cursor DESC LIMIT 1001`, [scope.league.toUpperCase(), scope.date]);
  const complete = rows.length <= 1000;
  const entries = rows.slice(0, 1000).map(row => {
    if (row.league !== scope.league || row.board_date !== scope.date || row.version !== SOCCER_READER_INVENTORY_SCAN_VERSION
      || !/^[a-f0-9]{48}$/.test(row.cursor || '') || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(row.started_at || '')) throw Error('INVALID_STATE');
    return { cursor: row.cursor, scanId: readerInventoryPublicId(row.cursor), startedAt: row.started_at,
      report: { version: row.version, cursor: row.cursor, league: row.league, date: row.board_date, status: row.status,
        totalCount: row.expected_count == null ? null : count(row.expected_count), verifiedCount: count(row.verified_count),
        observedCount: count(row.observed_count), reasonCodes: row.reason_codes } };
  });
  return { entries, complete };
}

// The returned internal rows stay inside the route; it validates and strips the
// token before serializing. Dependencies can be substituted in offline tests.
export async function listReaderInventoryScans(scope, { query = soccerJournalQuery } = {}) {
  return jobs(scope, query);
}
export async function resumeReaderInventoryScan({ league, date, scanId }, { query = soccerJournalQuery, resume = continueReaderInventoryScan } = {}) {
  if (!/^[a-f0-9]{64}$/.test(scanId || '')) throw Error('INVALID_SCAN_ID');
  const scope = { league, date }, result = await jobs(scope, query), matches = result.entries.filter(row => row.scanId === scanId);
  if (!matches.length) { if (!result.complete) throw Error('SCOPE_LIMIT_EXCEEDED'); return null; }
  if (matches.length !== 1) throw Error('AMBIGUOUS_SCAN_ID');
  const entry = matches[0];
  const report = await resume({ ...scope, cursor: entry.cursor });
  return { ...entry, report };
}
