import { canonicalReaderPayload, sanitizeTai888PageUrl } from './parser.js';

export const MARKET_ARCHIVE_SCHEMA = 'READER-CAPTURE-ARCHIVE-v1';
export const MARKET_ARCHIVE_ALARM = 'tai888-reader-market-archive-retry';
const LEAGUES = ['MLB', 'NPB', 'KBO', 'CPBL', 'NBA', 'EPL', 'UCL'];
const DEFAULT_MAX_BYTES = 6 * 1024 * 1024;
const clone = value => JSON.parse(JSON.stringify(value));
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, clone(value[key])]));
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
const scope = payload => [payload.league, payload.boardDate, (payload.periodsCovered || []).join('+')].join(':');

// Whitelist sport fields before writing local storage. In particular, pairing
// tokens, device identifiers, arbitrary DOM fields and URL queries never enter
// an archived payload. The paired owner is stored separately from the payload.
export function marketArchivePayload(input) {
  if (!LEAGUES.includes(input?.league) || !Array.isArray(input?.games) || !input.games.length || input.games.length > 40
    || !timestamp(input.observedAt) || !timestamp(input.pageActivityAt) || !hash(input.payloadHash)) throw Error('MARKET_ARCHIVE_PAYLOAD_INVALID');
  const payload = pick(input, ['version', 'interfaceVersion', 'provider', 'league', 'pageLeagueLabel', 'sourceHost',
    'observedAt', 'pageActivityAt', 'boardDate', 'periodsCovered', 'sourceScope', 'executable', 'readerVersion',
    'expectedGameCount', 'detectedGameCount', 'payloadHash', 'parseIssues']);
  payload.pageUrl = sanitizeTai888PageUrl(input.pageUrl);
  if (!payload.pageUrl) throw Error('MARKET_ARCHIVE_SOURCE_INVALID');
  const marketKeys = ['kind', 'unit', 'line', 'lineSide', 'awayWater', 'homeWater', 'overWater', 'underWater', 'drawWater', 'rawRows', 'period'];
  const periodProof = value => pick(value, ['version', 'status', 'period', 'sectionTitle', 'tableHeaders', 'marketHeader', 'truncated', 'reason']);
  const market = value => {
    if (value == null) return null;
    const result = pick(value, marketKeys);
    if (value.periodEvidence !== undefined) result.periodEvidence = periodProof(value.periodEvidence);
    return result;
  };
  payload.games = input.games.map(game => {
    const result = pick(game, ['league', 'awayCode', 'homeCode', 'awayRaw', 'homeRaw', 'awayKey', 'homeKey', 'boardDate', 'boardTime',
      'marketStatus', 'marketStates', 'periodsCovered', 'periodStates', 'executable']);
    for (const key of ['fullRunline', 'fullTotal', 'first5Runline', 'first5Total', 'firstHalfRunline', 'firstHalfTotal']) {
      if (game[key] !== undefined) result[key] = market(game[key]);
    }
    if (Array.isArray(game.markets)) result.markets = game.markets.map(market);
    return result;
  });
  if (input.sourceCapture) payload.sourceCapture = {
    ...pick(input.sourceCapture, ['league', 'pageLeagueLabel']),
    tables: (input.sourceCapture.tables || []).map(table => ({
      ...pick(table, ['sectionTitle', 'headers', 'periodEvidenceTruncated']),
      rows: (table.rows || []).map(row => ({ cells: (row.cells || []).map(cell => pick(cell, ['pair'])) })),
    })),
  };
  // A schema change must never silently rewrite the evidence covered by the
  // client hash; leave the live request independent if archival validation fails.
  if (canonicalReaderPayload(input) !== canonicalReaderPayload(payload)) throw Error('MARKET_ARCHIVE_CANONICAL_MISMATCH');
  return payload;
}

export async function marketArchiveCaptureId(payload, sha) {
  return sha(JSON.stringify([MARKET_ARCHIVE_SCHEMA, payload.league, payload.boardDate,
    payload.observedAt, payload.pageActivityAt, payload.payloadHash]));
}

function receiptMatches(receipt, item) {
  const p = item.payload;
  return receipt?.ok === true && receipt.durable === true && receipt.archiveOnly === true
    && receipt.currentBoardUpdated === false && receipt.historicalAvailabilityVerified === false && receipt.executable === false
    && receipt.captureId === item.captureId && receipt.payloadHash === p.payloadHash
    && receipt.league === p.league && receipt.boardDate === p.boardDate
    && receipt.observedAt === p.observedAt && receipt.pageActivityAt === p.pageActivityAt
    // Receipt and database clocks are distinct. Neither timestamp may be used
    // to freshen source evidence, and clock skew cannot invalidate an exact ACK.
    && timestamp(receipt.receivedAt) && timestamp(receipt.persistedAt);
}

// Acknowledgement merges with the current queue under a short storage lock;
// network requests never hold this lock or block a newly captured price.
// Unlike diagnostics, markets have no expiry or eviction path.
export function createMarketOutbox({ storage, upload, sha, now = Date.now, maxBytes = DEFAULT_MAX_BYTES }) {
  let chain = Promise.resolve(), flushing;
  const locked = task => { const result = chain.then(task); chain = result.catch(() => {}); return result; };
  const queueFrom = stored => Array.isArray(stored.marketArchiveOutbox) ? stored.marketArchiveOutbox : [];
  const read = () => storage.get(['marketArchiveOutbox', 'marketArchiveDelivery', 'readerToken', 'deviceId']);
  const delivery = (stored, queue, extra = {}) => ({ ...stored.marketArchiveDelivery,
    state: queue.length ? 'pending' : 'sent', pendingCount: queue.length, pendingBytes: bytes(queue), ...extra });
  async function fail(code) {
    return locked(async () => {
      const stored = await read(), queue = queueFrom(stored);
      await storage.set({ marketArchiveDelivery: delivery(stored, queue, { state: 'error', code,
        failedCaptureCount: Number(stored.marketArchiveDelivery?.failedCaptureCount || 0) + 1 }) });
    });
  }
  return {
    async enqueue(input, ownerDeviceId) {
      try {
        const payload = marketArchivePayload(input);
        if (typeof ownerDeviceId !== 'string' || !ownerDeviceId) throw Error('MARKET_ARCHIVE_OWNER_INVALID');
        if (await sha(canonicalReaderPayload(payload)) !== payload.payloadHash) throw Error('MARKET_ARCHIVE_HASH_INVALID');
        const captureId = await marketArchiveCaptureId(payload, sha);
        return await locked(async () => {
          const stored = await read(), queue = queueFrom(stored);
          const exact = queue.find(item => item.ownerDeviceId === ownerDeviceId && item.captureId === captureId);
          if (exact) return { queued: true, duplicate: true, captureId: exact.captureId };
          const previous = queue.filter(item => item.ownerDeviceId === ownerDeviceId && scope(item.payload) === scope(payload)).at(-1);
          if (previous?.payload.payloadHash === payload.payloadHash) return { queued: true, duplicate: true, captureId: previous.captureId };
          const item = { captureId, ownerDeviceId, payload, queuedAt: now(), attempts: 0, nextAttemptAt: 0 };
          if (bytes([...queue, item]) > maxBytes) throw Error('MARKET_ARCHIVE_QUEUE_FULL');
          queue.push(item);
          await storage.set({ marketArchiveOutbox: queue, marketArchiveDelivery: delivery(stored, queue, { code: '' }) });
          return { queued: true, captureId };
        });
      } catch (error) {
        try { await fail(error?.message === 'MARKET_ARCHIVE_QUEUE_FULL' ? 'QUEUE_FULL' : 'LOCAL_SAVE_FAILED'); } catch {}
        return { queued: false, code: error?.message === 'MARKET_ARCHIVE_QUEUE_FULL' ? 'QUEUE_FULL' : 'LOCAL_SAVE_FAILED' };
      }
    },
    flush() {
      if (flushing) return flushing;
      flushing = (async () => {
        const initial = await locked(read), initialQueue = queueFrom(initial);
        if (!initialQueue.length) return;
        if (!initial.readerToken || !initial.deviceId) {
          await locked(async () => { const stored = await read(), queue = queueFrom(stored);
            await storage.set({ marketArchiveDelivery: delivery(stored, queue, { code: 'PAIR_REQUIRED' }) }); });
          return;
        }
        const due = initialQueue.filter(item => item.ownerDeviceId === initial.deviceId && Number(item.nextAttemptAt || 0) <= now()).slice(0, 10);
        if (!due.length && initialQueue.some(item => item.ownerDeviceId !== initial.deviceId)) {
          await locked(async () => { const stored = await read(), queue = queueFrom(stored);
            await storage.set({ marketArchiveDelivery: delivery(stored, queue, { code: 'DEVICE_MISMATCH' }) }); });
        }
        const started = now();
        for (const item of due) {
          if (now() - started >= 18000) break;
          let receipt, failure;
          const stored = await locked(read);
          if (!stored.readerToken || stored.deviceId !== item.ownerDeviceId) break;
          try {
            receipt = await upload(item.payload, stored);
            if (!receiptMatches(receipt, item)) throw Error('INVALID_RECEIPT');
          } catch (error) { failure = error; }
          await locked(async () => {
            const latest = await read(), queue = queueFrom(latest), index = queue.findIndex(row => row.captureId === item.captureId && row.ownerDeviceId === item.ownerDeviceId);
            if (index < 0) return;
            if (!failure) {
              queue.splice(index, 1);
              await storage.set({ marketArchiveOutbox: queue, marketArchiveDelivery: delivery(latest, queue, {
                code: latest.marketArchiveDelivery?.code === 'QUEUE_FULL' ? 'QUEUE_FULL' : '',
                savedCaptureCount: Number(latest.marketArchiveDelivery?.savedCaptureCount || 0) + 1,
                lastCaptureId: item.captureId, lastReceivedAt: receipt.receivedAt, lastPersistedAt: receipt.persistedAt,
              }) });
            } else {
              const attempts = Math.min(Number(queue[index].attempts || 0) + 1, 20);
              queue[index] = { ...queue[index], attempts, nextAttemptAt: now() + Math.min(60000 * 2 ** (attempts - 1), 900000) };
              await storage.set({ marketArchiveOutbox: queue, marketArchiveDelivery: delivery(latest, queue,
                { code: failure.status === 401 ? 'PAIR_REQUIRED' : failure.message === 'INVALID_RECEIPT' ? 'INVALID_RECEIPT' : 'RETRY_PENDING' }) });
            }
          });
          if (failure?.status === 401) break;
        }
      })().finally(() => { flushing = null; });
      return flushing;
    },
  };
}
