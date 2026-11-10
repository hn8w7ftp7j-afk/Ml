import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { drainRawSeenHistoryIndex } from '../lib/soccer/raw-seen-history-maintenance.js';

// Exercise the shipped candidate SQL, including both date-edge and ordered
// fallback modes. The capture boundary has no database, payloads or secrets.
const captured = [];
const query = (text, params = []) => ({ query: text, params, then(a, b) { return Promise.resolve([]).then(a, b); } });
const capture = (strings, ...params) => query(strings.reduce((s, p, i) => s + (i ? '$' + i : '') + p, ''), params);
capture.query = query;
capture.transaction = async queries => {
  for (const item of queries) if (/WITH eligible AS/.test(item.query)) captured.push(item);
  return queries.map(() => []);
};
await drainRawSeenHistoryIndex({ db: capture, now: Date.parse('2026-11-10T12:00:00Z'), maxBatches: 1 });
assert.equal(captured.length, 4);

// Retry diagnostics retain operational codes, never raw SQL, account text,
// connection URLs, credentials, error messages or stacks.
const privateDetail = 'SELECT private_account FROM private_table; postgres://user:private-password@private-host/db';
const warn = console.warn, warnings = [];
console.warn = (...items) => warnings.push(items);
try {
  for (const [code, expected] of [
    ['57014', '57014'], ['RAW_HISTORY_INDEX_BUDGET_EXHAUSTED', 'RAW_HISTORY_INDEX_BUDGET_EXHAUSTED'],
    [privateDetail, 'UNKNOWN'], ['private-account-name', 'UNKNOWN'], ['42P01\nprivate-password', 'UNKNOWN'],
  ]) {
    const fault = (strings, ...params) => query(strings.reduce((s, p, i) => s + (i ? '$' + i : '') + p, ''), params);
    fault.query = query;
    fault.transaction = async queries => {
      if (queries.some(item => /WITH eligible AS/.test(item.query))) throw Object.assign(new Error(privateDetail), { code, query: privateDetail, stack: privateDetail });
      return queries.map(() => []);
    };
    const start = warnings.length, receipt = await drainRawSeenHistoryIndex({ db: fault, now: Date.parse('2026-11-10T12:00:00Z'), maxBatches: 1 });
    assert.equal(receipt.ok, false); assert.equal(receipt.processedBatches, 0);
    assert.equal(warnings.length - start, 2);
    for (const [label, data] of warnings.slice(start)) {
      assert.equal(label, '[RAW_HISTORY_INDEX_RETRYABLE]');
      assert.deepEqual(Object.keys(data).sort(), ['code', 'league', 'mode', 'stage']);
      assert.equal(data.code, expected); assert.equal(data.stage, 'SELECTION');
      assert.ok(['EPL', 'UCL'].includes(data.league)); assert.ok(['BUCKET_OLDEST', 'BUCKET_NEWEST'].includes(data.mode));
      assert.doesNotMatch(JSON.stringify([label, data]), /private|password|postgres|\bSELECT\b|account|stack|query/);
    }
  }
} finally { console.warn = warn; }

// Production-size metadata, with real PostgreSQL indexes and statistics:
// 88,680 fragments, 54,190 batches, 26,217 prior successes, 27,973 prior
// failures. No original payload or account data is needed to choose a batch.
const db = new PGlite();
try {
  await db.exec(`
    CREATE TABLE sports_reader_seen_captures_v1(capture_id CHAR(64) PRIMARY KEY,league VARCHAR(5) NOT NULL,
      capture_batch_id CHAR(64),part_index INT,source_observed_at TIMESTAMPTZ NOT NULL,persisted_at TIMESTAMPTZ NOT NULL);
    CREATE INDEX sports_reader_seen_captures_scope_v1 ON sports_reader_seen_captures_v1(league,source_observed_at DESC);
    CREATE INDEX sports_reader_seen_captures_batch_v1 ON sports_reader_seen_captures_v1(league,capture_batch_id,part_index) WHERE capture_batch_id IS NOT NULL;
    CREATE INDEX sports_reader_seen_captures_persisted_v1 ON sports_reader_seen_captures_v1(persisted_at DESC);
    CREATE TABLE soccer_raw_seen_history_batches_v1(batch_hash CHAR(64),derivation_version TEXT,league TEXT,
      observed_at TIMESTAMPTZ,indexed_at TIMESTAMPTZ,metadata JSONB,PRIMARY KEY(batch_hash,derivation_version));
    CREATE TABLE soccer_raw_seen_history_attempts_v1(capture_id CHAR(64),derivation_version TEXT,batch_hash CHAR(64),
      league TEXT,reason TEXT,status TEXT,attempted_at TIMESTAMPTZ,PRIMARY KEY(capture_id,derivation_version));
    INSERT INTO sports_reader_seen_captures_v1
      SELECT lpad((n*2+p)::text,64,'0'),CASE WHEN n%4=0 THEN 'UCL' ELSE 'EPL' END,lpad(n::text,64,'0'),p,
        '2026-10-01T00:00:00Z'::timestamptz+(n%35)*interval '1 day'+n*interval '1 second',
        '2026-10-01T00:00:00Z'::timestamptz+n*interval '1 second'
      FROM generate_series(1,54190) n CROSS JOIN generate_series(0,1) p WHERE p=0 OR n<=34490;
    INSERT INTO soccer_raw_seen_history_batches_v1
      SELECT capture_batch_id,'SOCCER-RAW-CREDIT-TABLE-HISTORY-v2',league,min(source_observed_at),
        '2026-11-09T00:00:00Z'::timestamptz,jsonb_build_object('parts',jsonb_agg(jsonb_build_object('captureId',btrim(capture_id))))
      FROM sports_reader_seen_captures_v1 WHERE capture_batch_id<=lpad('26217',64,'0') GROUP BY capture_batch_id,league;
    INSERT INTO soccer_raw_seen_history_attempts_v1
      SELECT capture_id,'SOCCER-RAW-CREDIT-TABLE-HISTORY-v2',capture_batch_id,league,
        CASE WHEN part_index=1 THEN 'RAW_SEEN_RECOVERY_BUDGET_EXCEEDED' ELSE 'RAW_SEEN_RECOVERY_UNSUPPORTED_FORMAT' END,
        'SOURCE_UNINDEXED','2026-11-09T00:00:00Z'::timestamptz
      FROM sports_reader_seen_captures_v1 WHERE capture_batch_id>lpad('26217',64,'0');
    ANALYZE;
  `);
  assert.equal(Number((await db.query('SELECT count(*) n FROM sports_reader_seen_captures_v1')).rows[0].n), 88680);
  const flatten = node => [node, ...(node.Plans || []).flatMap(flatten)];
  const timings = [];
  for (const item of captured) {
    const start = performance.now();
    const result = await db.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + item.query, item.params);
    const elapsed = performance.now() - start, report = result.rows[0]['QUERY PLAN'][0], nodes = flatten(report.Plan);
    assert.equal(report.Plan['Actual Rows'], 1, 'each league/mode returns a pending retained batch');
    const statements = await db.query(item.query, item.params);
    const selected = statements.rows[0], n = Number(selected.capture_batch_id.trim());
    assert.ok(n >= 1 && n <= 26217, 'compatible old failures cannot be selected, while prior successes need current revalidation');
    assert.equal(n % 4 === 0 ? 'UCL' : 'EPL', item.params[0], 'selection remains league scoped');
    // A measured 88k-row query must fit its existing per-statement budget;
    // the old correlated ORDER BY plan took over a minute at this size.
    assert.ok(elapsed < 5000, `candidate exceeds the existing SQL budget: ${Math.round(elapsed)} ms`);
    if (/attempted_days/.test(item.query)) {
      const dayAggregate = nodes.find(node => node['Subplan Name'] === 'CTE attempted_days');
      assert.ok(dayAggregate, 'date attempt counts must be evaluated as one reusable aggregate');
      assert.equal(dayAggregate['Actual Loops'], 1, 'date attempts are not recomputed for each eligible source');
      assert.ok(!nodes.some(node => node['Relation Name'] === 'sports_reader_seen_captures_v1' && node['Actual Loops'] > 1),
        'coverage ordering cannot rescan the full source table per candidate');
    }
    timings.push({ league: item.params[0], mode: /attempted_days/.test(item.query) ? 'DATE_EDGE' : 'ORDERED_FALLBACK', milliseconds: Math.round(elapsed) });
  }
  console.log('PASS production-size candidate SQL: 88,680 fragments/54,190 batches, exact migration eligibility and league scope, one date aggregate, no per-candidate source rescan, each query below existing 5s budget; ' + JSON.stringify(timings));
} finally { await db.close(); }
