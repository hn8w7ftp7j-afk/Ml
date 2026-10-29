import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalReaderPayload } from '../reader/parser.js';
import { createMarketOutbox, MARKET_ARCHIVE_ALARM } from '../reader/market-outbox.js';

const schema = 'READER-CAPTURE-ARCHIVE-v1';
const digest = value => createHash('sha256').update(value).digest('hex');

// The existing worker regressions exercise live-ingest behavior independently
// of this additional historical HTTP sink. They still run the actual durable
// market outbox; only the network response is synthetic, as for live receipts.
export function readerArchiveReceiptFixture(input) {
  assert.equal(input?.schema, schema);
  const payload = input.payload;
  assert.ok(['MLB', 'NPB', 'KBO', 'CPBL', 'NBA', 'EPL', 'UCL'].includes(payload?.league));
  assert.equal(payload.payloadHash, digest(canonicalReaderPayload(payload)));
  assert.ok(Number.isFinite(Date.parse(payload.observedAt)));
  assert.ok(Number.isFinite(Date.parse(payload.pageActivityAt)));
  const captureId = digest(JSON.stringify([schema, payload.league, payload.boardDate,
    payload.observedAt, payload.pageActivityAt, payload.payloadHash]));
  const receivedAt = new Date(Math.max(Date.now(), Date.parse(payload.observedAt))).toISOString();
  return { ok: true, durable: true, archiveOnly: true, currentBoardUpdated: false,
    historicalAvailabilityVerified: false, executable: false, schema,
    captureId, payloadHash: payload.payloadHash, league: payload.league,
    boardDate: payload.boardDate, observedAt: payload.observedAt,
    pageActivityAt: payload.pageActivityAt, receivedAt, persistedAt: receivedAt };
}

export function installSeenWorkerFixture(worker) {
  if (!worker.chrome.storage) {
    const values = {};
    worker.chrome.storage = { local: {
      get: async () => structuredClone(values),
      set: async input => Object.assign(values, structuredClone(input)),
      remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]; },
    } };
  }
  // These legacy regressions exercise the live board selection/ingest path.
  // The raw seen-evidence transport is tested independently with its actual
  // durable store in reader-seen-local-outbox-test.mjs.
  worker.SEEN_CAPTURE_ALARM = 'tai888-reader-seen-retry';
  worker.createSeenCaptureOutbox = () => ({
    enqueue: async () => ({ queued: true, durable: true, captureIds: [] }),
    flush: async () => {}, failure: async () => {},
    status: async () => ({ state: 'sent', pendingCount: 0, pendingBytes: 0,
      savedCaptureCount: 0, failedCaptureCount: 0, code: '', lastPersistedAt: null,
      updatedAt: new Date().toISOString() }),
  });
}

export function installArchiveWorkerFixture(worker) {
  installSeenWorkerFixture(worker);
  worker.createMarketOutbox = createMarketOutbox;
  worker.MARKET_ARCHIVE_ALARM = MARKET_ARCHIVE_ALARM;
  const fetchLive = worker.fetch;
  worker.fetch = async (url, options) => {
    if (!url.endsWith('/api/reader/archive')) return fetchLive(url, options);
    const body = JSON.parse(options.body);
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['X-Device-Id'], body.payload.deviceId);
    assert.ok(options.headers.Authorization?.startsWith('Bearer '));
    const receipt = readerArchiveReceiptFixture(body);
    return { ok: true, status: 200, text: async () => JSON.stringify(receipt) };
  };
}
