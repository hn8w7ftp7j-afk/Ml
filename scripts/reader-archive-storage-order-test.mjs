// Synthetic Chrome-storage serialization of actual parser output. No live
// device/database writes, rewritten observations or fabricated production odds.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { parseTai888Capture, canonicalReaderPayload } from '../reader/parser.js';
import { createMarketOutbox, marketArchiveCaptureId, MARKET_ARCHIVE_SCHEMA } from '../reader/market-outbox.js';
import { buildReaderCaptureArchive, saveReaderCaptureArchive } from '../lib/reader-capture-archive.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const observedAt = '2026-10-24T22:00:01.000Z', pageActivityAt = '2026-10-24T22:00:00.000Z';
const now = Date.parse('2026-10-30T00:00:00.000Z');
const deviceId = 'storage-order-fixture-device', version = '2.1.48';
const options = { deviceId, headerVersion: version, now };
const teams = { MLB: ['NYY-洋基', 'BOS-紅襪[主]'], NPB: ['SOF-軟銀鷹', 'NIP-日本火腿[主]'],
  KBO: ['LOG-樂天巨人', 'DOO-斗山熊[主]'], CPBL: ['CTB-中信兄弟', 'UNI-統一獅[主]'], NBA: ['HOU-火箭', 'DAL-獨行俠[主]'] };
const cell = pair => ({ pair, lines: pair });
const sortedStorageValue = value => Array.isArray(value) ? value.map(sortedStorageValue)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortedStorageValue(value[key])])) : value;
function sourcePayload(league, forceV22 = false) {
  const soccer = ['EPL', 'UCL'].includes(league);
  const label = league === 'EPL' ? '英超英格蘭超級聯賽' : '歐冠歐洲冠軍聯賽';
  const capture = { league, sourceHost: 'tai888.in', pageUrl: 'https://tai888.in/newapp/', observedAt,
    ...(soccer ? { pageLeagueLabel: label } : {}),
    tables: [{ ...(soccer ? { sectionTitle: `${label} 全場` } : {}),
      headers: soccer ? ['時間', '主客隊伍', '讓球', '大小', '獨贏'] : ['時間', '主客隊伍', '全場讓分', '全場大小', '獨贏', '一輸二贏', '上半場讓分', '上半場大小'],
      rows: ['22:05', '20:05'].map(time => ({ cells: soccer ? [cell(['10-25', time]),
        cell(league === 'EPL' ? ['利物浦', '兵工廠[主]'] : ['皇家馬德里', '巴塞隆納[主]']),
        cell(['2平 0.950', '0.950']), cell(['大2.5 0.940', '小 0.940']), cell(['主勝 1.200', '和 2.200', '客勝 1.800'])]
        : [cell(['10-25', time]), cell(teams[league]), cell(['2平 0.950', '0.950']),
          cell([`${league === 'NBA' ? '225+50' : '7+50'} 大 0.940`, '小 0.940']), cell([]), cell([]),
          cell(['1平 0.930', '0.930']), cell([`${league === 'NBA' ? '115.5' : '3.5'} 大 0.920`, '小 0.920'])] })) }],
    diagnostics: { gameCount: 2, expectedGameCount: 2, lastMutationAt: pageActivityAt } };
  const parsed = parseTai888Capture(capture, new Date(observedAt));
  assert.deepEqual(parsed.parseIssues, [], league);
  assert.equal(parsed.games.length, 2);
  // Actual baseball48 still emits v2.1; separately exercise the supported
  // v2.2 wire projection on those same actual parsed quote values.
  if (forceV22) parsed.version = 'TAI888-READER-DOM-v2.2.0';
  const payload = { ...parsed, readerVersion: version, deviceId, pageActivityAt, expectedGameCount: 2, detectedGameCount: 2 };
  payload.payloadHash = sha(canonicalReaderPayload(payload));
  return payload;
}
const wrap = payload => ({ schema: MARKET_ARCHIVE_SCHEMA, payload });
const build = payload => buildReaderCaptureArchive(wrap(payload), options);
const db = new PGlite();
const sql = (parts, ...values) => {
  const query = parts.reduce((text, part, index) => text + (index ? `$${index}` : '') + part, '');
  return { query, values, then: (resolve, reject) => db.query(query, values).then(result => result.rows).then(resolve, reject) };
};
sql.transaction = queries => db.transaction(async transaction => {
  const rows = []; for (const query of queries) rows.push((await transaction.query(query.query, query.values)).rows); return rows;
});
try {
  const cases = ['NBA', 'MLB', 'NPB', 'KBO', 'CPBL', 'EPL', 'UCL'].map(league => ({ league, forceV22: false }))
    .concat(['MLB', 'NPB', 'KBO', 'CPBL'].map(league => ({ league, forceV22: true })));
  for (const { league, forceV22 } of cases) {
    const original = sourcePayload(league, forceV22), originalText = JSON.stringify(original);
    const identity = await marketArchiveCaptureId(original, sha);
    const storedPayload = sortedStorageValue(original);
    assert.equal(storedPayload.payloadHash, original.payloadHash);
    assert.equal(storedPayload.observedAt, original.observedAt);
    assert.equal(storedPayload.pageActivityAt, original.pageActivityAt);
    const soccer = ['EPL', 'UCL'].includes(league);
    const orderSensitive = !soccer && original.version === 'TAI888-READER-DOM-v2.2.0';
    assert.equal(sha(canonicalReaderPayload(storedPayload)) === original.payloadHash, !orderSensitive,
      `${league}: actual standard v2.2 hashes reproduce reordered storage mismatch; soccer already recursively canonicalizes keys`);
    assert.equal(await marketArchiveCaptureId(storedPayload, sha), identity, 'capture identity remains the old queued identity');
    const recovered = build(storedPayload);
    assert.equal(recovered.captureId, identity); assert.equal(recovered.payloadHash, original.payloadHash);
    assert.equal(recovered.observedAt, observedAt); assert.equal(recovered.pageActivityAt, pageActivityAt);
    assert.equal(sha(canonicalReaderPayload(recovered.payload)), original.payloadHash, 'stored quote must independently reproduce original claimed digest');
    assert.equal(JSON.stringify(original), originalText, 'server compatibility never mutates caller or old evidence');
    const reverseGames = structuredClone(storedPayload); reverseGames.games.reverse();
    assert.equal(build(reverseGames).captureId, identity, 'original games may arrive in reverse order');

    let state = { readerToken: 'synthetic-pair-token', deviceId }, uploadError = null;
    const storage = { get: async () => sortedStorageValue(state), set: async value => { state = sortedStorageValue({ ...state, ...value }); } };
    const outbox = createMarketOutbox({ storage, sha, now: () => now,
      upload: async payload => {
        try { return await saveReaderCaptureArchive(wrap(payload), { ...options, sql }); }
        catch (error) { uploadError = error; throw error; }
      } });
    assert.equal((await outbox.enqueue(original, deviceId)).queued, true);
    assert.equal(state.marketArchiveOutbox[0].captureId, identity);
    assert.equal(state.marketArchiveOutbox[0].payload.payloadHash, original.payloadHash);
    await outbox.flush();
    assert.equal(state.marketArchiveOutbox.length, 0, `${league}: old Reader48 pending capture must drain without reinstall; ${uploadError?.code || uploadError?.message || ''}`);
    assert.equal(state.marketArchiveDelivery.lastCaptureId, identity);
    const first = await saveReaderCaptureArchive(wrap(storedPayload), { ...options, sql });
    const retry = await saveReaderCaptureArchive(wrap(storedPayload), { ...options, sql, now: now + 3600000 });
    assert.equal(first.captureId, retry.captureId); assert.equal(first.receivedAt, retry.receivedAt); assert.equal(first.persistedAt, retry.persistedAt);

    if (!soccer) {
      for (const mutate of [
        p => { p.games[0].fullRunline.line = '3平'; },
        p => { p.games[0].fullTotal.overWater = 0.99; },
        p => { p.games[0].marketStates[Object.keys(p.games[0].marketStates)[0]] = 'UNAVAILABLE'; },
        p => { p.games[0].marketStates.injectedUnknown = 'AVAILABLE'; },
        ...(orderSensitive ? [p => { delete p.games[0].marketStates[Object.keys(p.games[0].marketStates)[0]]; }] : []),
        p => { p.payloadHash = '0'.repeat(64); },
      ]) {
        const changed = structuredClone(storedPayload); mutate(changed);
        assert.throws(() => build(changed), `${league}: recovery cannot change content or discard unknown/missing market state keys to satisfy old SHA`);
      }
      const arbitrary = structuredClone(original);
      for (const game of arbitrary.games) game.marketStates = Object.fromEntries(Object.entries(game.marketStates).reverse());
      arbitrary.payloadHash = sha(canonicalReaderPayload(arbitrary));
      assert.equal(arbitrary.payloadHash !== original.payloadHash, orderSensitive);
      const unchanged = build(arbitrary);
      assert.equal(unchanged.payloadHash, arbitrary.payloadHash);
      assert.equal(sha(canonicalReaderPayload(unchanged.payload)), arbitrary.payloadHash,
        'direct valid hashes keep their existing market-state order rather than being migrated');
    }
  }
  assert.equal((await db.query('SELECT count(*)::int AS n FROM sports_reader_capture_archive_v1')).rows[0].n, 11);
  console.log('Reader archive storage-order regression PASS: actual seven-league parser → recursively sorted local storage → existing Reader48 outbox → strict original-SHA recovery → immutable PostgreSQL/readback ACK; price/state/hash tampering rejected, capture IDs/source clocks preserved, no reinstall or live/model changes');
} finally { await db.close(); }
