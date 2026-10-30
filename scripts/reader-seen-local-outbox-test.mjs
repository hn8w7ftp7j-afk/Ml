// Actual local/outbox modules with Chrome-style recursively sorted dictionary
// keys; real PostgreSQL archive integration. No live website captures are used.
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { createSeenCaptureOutbox } from '../reader/seen-outbox.js';
import { buildReaderSeenCapture, saveReaderSeenCapture, listReaderSeenCaptures } from '../lib/reader-seen-capture.js';

const local = globalThis.Tai888SeenStorage, clone = value => JSON.parse(JSON.stringify(value));
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
const device = 'seen-local-fixture-device', token = 'fixture-reader-token';
function store(seed = {}) {
  const data = sorted({ deviceId: device, readerToken: token, ...clone(seed) });
  let writes = 0;
  const storage = {
    data, beforeSet: null, afterGet: null, beforeRemove: null,
    async get(keys) {
      const names = keys === null ? Object.keys(data) : Array.isArray(keys) ? keys : [keys];
      const result = sorted(Object.fromEntries(names.filter(key => Object.hasOwn(data, key)).map(key => [key, clone(data[key])])));
      return storage.afterGet ? await storage.afterGet(result, keys) : result;
    },
    async set(values) {
      writes += 1;
      if (storage.beforeSet) await storage.beforeSet(values, writes);
      for (const [key, value] of Object.entries(values)) data[key] = sorted(clone(value));
    },
    async remove(keys) {
      if (storage.beforeRemove) await storage.beforeRemove(keys);
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    },
  };
  return storage;
}
function source(league = 'NBA', at = '2026-10-24T22:00:01.000Z') {
  return { version: 'TAI888-DOM-CAPTURE-v2.2.0', readerVersion: '2.1.51', league,
    sourceHost: 'www1.tai888.in', pageUrl: 'https://www1.tai888.in/newapp/#/BS', frameUrl: 'https://www1.tai888.in/newapp/',
    observedAt: at, pageActivityAt: '2026-10-24T22:00:00.000Z', completeCapture: false,
    captureReasons: ['PRE_NORMALIZATION', 'SOURCE_PARTIAL'], pageLeagueLabel: `${league} 聯盟`,
    tables: [{ headers: ['時間', '主客隊伍', '讓球', '大小盤'], sectionTitle: `${league} 全場`, rows: [
      { marketLocked: false, cells: [{ pair: ['not-a-date', '07:00'] }, { pair: ['未知隊名', 'LAL 湖人[主]'] }, { pair: [' 3+50 0.95\n1.5 ', '3+75 0.91'] }] },
      { marketLocked: true, cells: [{ pair: ['10/25', '08:00'] }, { pair: ['鎖盤', ''] }] },
    ] }], diagnostics: { lastMutationAt: '2026-10-24T22:00:00.000Z', sawLeagueMarker: true, recordCount: 2,
      expectedGameCount: null, tableIssues: ['CONFLICTING_ROWS'], conflictingGameKeys: ['07:00|GS|LAL'] } };
}
const validAck = async wire => ({ ok: true, durable: true, schema: local.SCHEMA,
  captureId: await local.sha(local.canonical(wire)), evidenceHash: await local.sha(local.canonical(wire.evidence)),
  league: wire.evidence.league, readerVersion: wire.evidence.readerVersion,
  observedAt: wire.evidence.observedAt, pageActivityAt: wire.evidence.pageActivityAt || null,
  archiveOnly: true, currentBoardUpdated: false, historicalAvailabilityVerified: false, executable: false,
  coverageComplete: false, evidenceStatus: 'EVIDENCE_UNVERIFIED', status: 'EVIDENCE_UNVERIFIED',
  receivedAt: '2026-10-29T22:00:00.000Z', persistedAt: '2026-10-29T22:00:01.000Z' });
const queued = storage => local.entries(storage), acks = storage => local.entries(storage, local.ACK_PREFIX);
const db = new PGlite();
const sql = (parts, ...values) => {
  const query = parts.reduce((text, part, index) => text + (index ? `$${index}` : '') + part, '');
  return { query, values, then: (resolve, reject) => db.query(query, values).then(result => result.rows).then(resolve, reject) };
};
sql.transaction = queries => db.transaction(async transaction => {
  const rows = []; for (const query of queries) rows.push((await transaction.query(query.query, query.values)).rows); return rows;
});

try {
  assert.ok(local && local.ACK_PREFIX);
  const storage = store();
  const captures = ['MLB', 'NPB', 'KBO', 'CPBL', 'NBA', 'NHL', 'EPL', 'UCL'].map(league => source(league));
  // Content frames store unique keys without a shared-array read/modify/write.
  const saved = await Promise.all(captures.map(evidence => local.persist(evidence, { storage })));
  assert.ok(saved.every(row => row.queued && row.durable)); assert.equal((await queued(storage)).length, 8);
  const same = await Promise.all([local.persist(captures[0], { storage }), local.persist(captures[0], { storage })]);
  assert.deepEqual(same[0].captureIds, same[1].captureIds); assert.equal((await queued(storage)).length, 8);
  for (const row of await queued(storage)) {
    assert.equal(await local.sha(row.wireText), row.captureId);
    const wire = JSON.parse(row.wireText);
    assert.equal(buildReaderSeenCapture(wire, { deviceId: device, headerVersion: '2.1.51' }).captureId, row.captureId,
      'local fragments and backend canonical identities match after Chrome key sorting');
    assert.deepEqual(wire.evidence.tables, captures.find(value => value.league === wire.evidence.league).tables,
      'unknown identities, malformed dates, conflicting quote strings, whitespace and locks are exact');
  }
  let uploads = 0;
  const outbox = createSeenCaptureOutbox({ storage, upload: async (wire, config) => {
    uploads += 1; assert.equal(config.deviceId, device);
    return saveReaderSeenCapture(wire, { deviceId: config.deviceId, headerVersion: wire.evidence.readerVersion, sql });
  } });
  await outbox.flush(); assert.equal(uploads, 8); assert.equal((await queued(storage)).length, 0); assert.equal((await acks(storage)).length, 8);
  assert.equal((await outbox.status()).state, 'sent');
  assert.equal((await outbox.status()).savedCaptureCount, 8);
  const inventory = await listReaderSeenCaptures({}, { sql }); assert.equal(inventory.leagues.length, 8);
  assert.ok(inventory.leagues.every(row => row.captureCount === 1 && row.completePartGroups === 1));
  // Persistent ACK tombstones prevent the same source event being requeued by
  // another frame after delivery or a service-worker restart.
  await local.persist(captures[0], { storage }); assert.equal((await queued(storage)).length, 0);
  const restarted = createSeenCaptureOutbox({ storage, upload: async () => { throw Error('SHOULD_NOT_UPLOAD'); } });
  await restarted.flush(); assert.equal((await restarted.status()).savedCaptureCount, 8);

  const newer = source('MLB', '2026-10-24T22:00:02.000Z');
  await local.persist(newer, { storage }); assert.equal((await queued(storage)).length, 1, 'same prices at a new observation time still persist');
  const newerId = (await queued(storage))[0].captureId;
  await createSeenCaptureOutbox({ storage, upload: validAck }).flush();
  assert.notEqual(newerId, saved[0].captureIds[0]);

  // 2,001 rows cross the per-fragment row limit. No row is omitted and chunks
  // keep exact source evidence even when one intermediate local write fails.
  const many = source('NBA'); many.tables[0].rows = Array.from({ length: 2001 }, (_, index) => ({ marketLocked: false, cells: [{ pair: [`第${index}筆 3+50 0.95`, '1.5 0.93'] }] }));
  const chunks = await local.fragments(many); assert.ok(chunks.length >= 3);
  assert.deepEqual(chunks.flatMap(chunk => JSON.parse(chunk.wireText).evidence.tables.flatMap(table => table.rows)), many.tables[0].rows);
  chunks.forEach(chunk => { assert.ok(local.bytes(chunk.wireText) <= 590000); buildReaderSeenCapture(JSON.parse(chunk.wireText), { deviceId: device, headerVersion: '2.1.51' }); });
  const partial = store(); let chunkWrites = 0;
  partial.beforeSet = values => { if (Object.keys(values).some(key => key.startsWith(local.PREFIX)) && ++chunkWrites === 2) throw Error('QUOTA_EXCEEDED'); };
  const partialOutbox = createSeenCaptureOutbox({ storage: partial, upload: validAck });
  const incomplete = await partialOutbox.enqueue(many);
  assert.equal(incomplete.queued, false); assert.equal(incomplete.durable, false); assert.equal((await queued(partial)).length, 1);
  assert.equal((await partialOutbox.status()).failedCaptureCount, 1);
  partial.beforeSet = null; await local.persist(many, { storage: partial });
  assert.equal((await queued(partial)).length, chunks.length, 'retry resumes missing immutable chunks without evicting the saved part');
  await partialOutbox.flush(); assert.equal((await queued(partial)).length, 0); assert.equal((await acks(partial)).length, chunks.length);
  assert.equal((await partialOutbox.status()).failedCaptureCount, 1, 'a capture-stage loss alert is not cleared by unrelated successful delivery');

  const privacyMutations = [
    value => { value.account = 'private'; }, value => { value.tables[0].rows[0].rawDOM = 'private'; },
    value => { value.tables[0].rows[0].cells[0].cookie = 'private'; },
    value => { value.pageLeagueLabel = '帳號 Kai'; }, value => { value.diagnostics.tableIssues = ['ａｃｃｏｕｎｔ Kai']; },
    value => { value.diagnostics.conflictingGameKeys = ['user-id Kai']; }, value => { value.diagnostics.account = 'private'; },
    value => { value.frameUrl = 'https://www1.tai888.in/newapp/?token=private'; },
    value => { value.pageUrl = 'https://www1.tai888.in/newapp/%61%63%63%6f%75%6e%74'; },
    value => { value.pageUrl = 'https://www1.tai888.in/newapp/%2561%2563%2563%256f%2575%256e%2574'; },
    value => { value.tables[0].rows[0].cells[0].pair = ['帳\u200b號 Kai']; },
    value => { value.tables[0].headers = ['username Kai']; }, value => { value.tables[0].sectionTitle = '<div>NBA</div>'; },
  ];
  for (const mutate of privacyMutations) {
    const privateStorage = store(), value = source(); mutate(value);
    const result = await createSeenCaptureOutbox({ storage: privateStorage, upload: validAck }).enqueue(value);
    assert.equal(result.queued, false); assert.equal((await queued(privateStorage)).length, 0);
    assert.equal(Object.values(privateStorage.data).some(item => typeof item?.wireText === 'string'), false, 'private data never reaches Chrome evidence storage');
    assert.equal(JSON.stringify(privateStorage.data).includes('Kai'), false, 'failure metadata does not repeat secret input');
  }
  const noTables = source(); noTables.tables = [];
  const empty = await local.fragments(noTables); assert.equal(empty.length, 1); assert.equal(JSON.parse(empty[0].wireText).evidence.tables.length, 0);
  const quota = store(); quota.beforeSet = () => { throw Error('QUOTA_EXCEEDED'); };
  const quotaBox = createSeenCaptureOutbox({ storage: quota, upload: validAck });
  assert.equal((await quotaBox.enqueue(source())).queued, false); assert.equal((await quotaBox.status()).state, 'error');
  assert.equal((await queued(quota)).length, 0);
  const corruptReadback = store(); let once = true;
  corruptReadback.afterGet = (result, keys) => {
    if (once && Array.isArray(keys) && keys.some(key => key.startsWith(local.PREFIX)) && Object.keys(result).some(key => key.startsWith(local.PREFIX))) {
      once = false; for (const key of Object.keys(result)) if (key.startsWith(local.PREFIX)) result[key].wireText += ' ';
    }
    return result;
  };
  await assert.rejects(() => local.persist(source(), { storage: corruptReadback }), /READBACK_FAILED/);
  assert.equal((await queued(corruptReadback)).length, 1, 'readback failure retains the original stored item');

  const badAcks = [
    ack => { ack.durable = false; }, ack => { delete ack.evidenceHash; }, ack => { ack.captureId = '0'.repeat(64); },
    ack => { ack.league = 'MLB'; }, ack => { ack.observedAt = '2026-10-24T22:01:01.000Z'; },
    ack => { ack.pageActivityAt = null; }, ack => { ack.archiveOnly = false; }, ack => { ack.currentBoardUpdated = true; },
    ack => { ack.executable = true; }, ack => { ack.historicalAvailabilityVerified = true; }, ack => { ack.coverageComplete = true; },
    ack => { ack.evidenceStatus = 'PASS'; }, ack => { ack.status = 'PASS'; }, ack => { ack.schema = 'another-schema'; }, ack => { ack.readerVersion = '2.1.48'; },
    ack => { ack.persistedAt = 'not-a-time'; }, ack => { ack.receivedAt = '1'; }, ack => { ack.persistedAt = '1'; },
  ];
  for (const mutate of badAcks) {
    const target = store(); await local.persist(source(), { storage: target });
    await createSeenCaptureOutbox({ storage: target, upload: async wire => { const ack = await validAck(wire); mutate(ack); return ack; } }).flush();
    assert.equal((await queued(target)).length, 1, 'a missing/wrong/noncanonical durable ACK cannot remove source evidence');
    assert.equal((await acks(target)).length, 0);
  }
  const ackQuota = store(); await local.persist(source(), { storage: ackQuota });
  ackQuota.beforeSet = values => { if (Object.keys(values).some(key => key.startsWith(local.ACK_PREFIX))) throw Error('QUOTA_EXCEEDED'); };
  await createSeenCaptureOutbox({ storage: ackQuota, upload: validAck }).flush();
  assert.equal((await queued(ackQuota)).length, 1, 'network ACK alone cannot remove source before local ACK persistence succeeds');
  assert.equal((await acks(ackQuota)).length, 0);
  const ackReadback = store(); await local.persist(source(), { storage: ackReadback }); let corruptAckOnce = true;
  ackReadback.afterGet = (result, keys) => {
    if (corruptAckOnce && Array.isArray(keys) && keys.length === 1 && keys[0].startsWith(local.ACK_PREFIX) && result[keys[0]]) {
      corruptAckOnce = false; result[keys[0]].persistedAt = '2020-01-01T00:00:00.000Z';
    }
    return result;
  };
  await createSeenCaptureOutbox({ storage: ackReadback, upload: validAck }).flush();
  assert.equal((await queued(ackReadback)).length, 1, 'failed local ACK readback retains source even after server saved it');
  const removeFailure = store(); await local.persist(source(), { storage: removeFailure }); let removeFailed = false, recoverUploads = 0;
  removeFailure.beforeRemove = key => { if (!removeFailed && String(key).startsWith(local.PREFIX)) { removeFailed = true; throw Error('REMOVE_FAILED'); } };
  const removeBox = createSeenCaptureOutbox({ storage: removeFailure, upload: async wire => { recoverUploads += 1; return validAck(wire); } });
  await removeBox.flush(); assert.equal((await queued(removeFailure)).length, 1); assert.equal((await acks(removeFailure)).length, 1);
  await removeBox.flush({ force: true }); assert.equal((await queued(removeFailure)).length, 0); assert.equal(recoverUploads, 1, 'restart/retry may use its verified local tombstone without re-uploading or deleting another observation');
  const singleChunk = (await local.fragments(source()))[0];
  for (const malformed of [
    { captureId: singleChunk.captureId, ownerDeviceId: device },
    { captureId: singleChunk.captureId, ownerDeviceId: device, durable: false, schema: local.SCHEMA,
      receivedAt: '2026-10-29T22:00:00.000Z', persistedAt: '2026-10-29T22:00:01.000Z' },
    { captureId: singleChunk.captureId, ownerDeviceId: device, durable: true, schema: 'wrong-schema',
      receivedAt: '2026-10-29T22:00:00.000Z', persistedAt: '2026-10-29T22:00:01.000Z' },
    { captureId: singleChunk.captureId, ownerDeviceId: device, durable: true, schema: local.SCHEMA,
      receivedAt: '1', persistedAt: '2026-10-29T22:00:01.000Z' },
  ]) {
    const malformedStorage = store({ [local.ACK_PREFIX + device + ':' + singleChunk.captureId]: malformed });
    await local.persist(source(), { storage: malformedStorage });
    assert.equal((await queued(malformedStorage)).length, 1, 'a malformed tombstone cannot falsely acknowledge local source persistence');
    let repairedUploads = 0;
    await createSeenCaptureOutbox({ storage: malformedStorage, upload: async wire => { repairedUploads += 1; return validAck(wire); } }).flush();
    assert.equal(repairedUploads, 1); assert.equal((await queued(malformedStorage)).length, 0, 'invalid tombstone is repaired only after another exact durable server ACK');
  }
  let testClock = Date.parse('2026-10-29T22:00:00.000Z'), failedUploads = 0;
  const retryStorage = store(); await local.persist(source(), { storage: retryStorage });
  const retryBox = createSeenCaptureOutbox({ storage: retryStorage, now: () => testClock,
    upload: async wire => { failedUploads += 1; if (failedUploads === 1) throw Error('NETWORK_ERROR'); return validAck(wire); } });
  await retryBox.flush(); assert.equal((await queued(retryStorage)).length, 1); assert.equal(failedUploads, 1);
  await retryBox.flush(); assert.equal(failedUploads, 1, 'retry respects persisted backoff');
  testClock += 15000; await retryBox.flush(); assert.equal(failedUploads, 2); assert.equal((await queued(retryStorage)).length, 0);
  assert.equal((await retryBox.status()).state, 'sent');
  const ownership = store(); await local.persist(source(), { storage: ownership }); await ownership.set({ deviceId: 'another-owner-device' });
  let otherUploads = 0; await createSeenCaptureOutbox({ storage: ownership, upload: async wire => { otherUploads += 1; return validAck(wire); } }).flush();
  assert.equal(otherUploads, 0); assert.equal((await queued(ownership)).length, 1, 're-pairing never transmits or discards another owner queue');
  const race = store(); await local.persist(source(), { storage: race });
  await createSeenCaptureOutbox({ storage: race, upload: async wire => { await local.persist(source('NBA', '2026-10-24T22:00:03.000Z'), { storage: race }); return validAck(wire); } }).flush();
  assert.equal((await queued(race)).length, 1, 'ACK for an old observation cannot remove a concurrent new observation');
  assert.equal((await acks(race)).length, 1);
  const corrupt = store(); await local.persist(source(), { storage: corrupt }); const item = (await queued(corrupt))[0];
  corrupt.data[item.key].wireText += ' '; let corruptUploads = 0;
  await createSeenCaptureOutbox({ storage: corrupt, upload: async wire => { corruptUploads += 1; return validAck(wire); } }).flush();
  assert.equal(corruptUploads, 0); assert.equal((await queued(corrupt)).length, 1, 'corrupt source stays retained and visibly failed');
  console.log('PASS local seen-capture/outbox: Chrome-sorted concurrent frame storage, exact raw retention, all8 backend/PGlite integration, resumable chunks, privacy before local writes, quota/readback failures, strict ACK/tombstones, restart/owner/backoff/new observation races; Production NOT VERIFIED');
} finally { await db.close(); }
