import { sanitizeDiagnosticReport } from './diagnostic-schema.js';

export const DIAGNOSTIC_ALARM = 'tai888-reader-diagnostic-retry';
const MAX_PENDING = 20;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
// The same helper handles both queued mutations and retries. Storage writes
// are serialized so a late ACK cannot delete a newly enqueued report.
export function createDiagnosticOutbox({ storage, upload, now = Date.now }) {
  let chain = Promise.resolve();
  function locked(task) { const result = chain.then(task); chain = result.catch(() => {}); return result; }
  const readQueue = stored => (Array.isArray(stored.diagnosticOutbox) ? stored.diagnosticOutbox : [])
    .filter(row => now() - Date.parse(row.report?.createdAt) < MAX_AGE_MS);
  return {
    enqueue(input) { return locked(async () => {
      const report = sanitizeDiagnosticReport(input);
      const stored = await storage.get(['diagnosticOutbox', 'diagnosticLastSignature', 'diagnosticLastQueuedAt', 'diagnosticDelivery']);
      const { reportId, createdAt, ...fingerprint } = report;
      const signature = JSON.stringify(fingerprint);
      const interval = report.exceptionCode || Object.values(report.leagues).some(row => ['error', 'disconnected'].includes(row.state)) ? 60000 : 300000;
      if (signature === stored.diagnosticLastSignature && now() - Number(stored.diagnosticLastQueuedAt || 0) < interval) return;
      const queue = readQueue(stored);
      queue.push({ report, attempts: 0, nextAttemptAt: 0 });
      const overflow = Math.max(0, queue.length - MAX_PENDING);
      await storage.set({ diagnosticOutbox: queue.slice(-MAX_PENDING), diagnosticLastSignature: signature,
        diagnosticLastQueuedAt: now(), diagnosticDelivery: { ...stored.diagnosticDelivery, state: 'pending', pendingCount: Math.min(queue.length, MAX_PENDING),
          latestReportId: reportId, ...(overflow ? { droppedCount: overflow } : {}) } });
    }); },
    flush() { return locked(async () => {
      const stored = await storage.get(['diagnosticOutbox', 'readerToken', 'deviceId', 'diagnosticDelivery']);
      const queue = readQueue(stored);
      if (!stored.readerToken || !stored.deviceId || !queue.length) return;
      let acknowledged = stored.diagnosticDelivery?.lastReceivedAt || null;
      let acknowledgedId = stored.diagnosticDelivery?.lastReportId || null;
      let deliveryCode = '';
      for (let count = 0; queue.length && count < 3; count++) {
        const item = queue[0];
        if (item.nextAttemptAt > now()) break;
        try {
          const receipt = await upload(item.report, stored);
          if (receipt?.ok !== true || receipt?.durable !== true || receipt?.reportId !== item.report.reportId) throw new Error('INVALID_RECEIPT');
          acknowledged = receipt.receivedAt; acknowledgedId = receipt.reportId; queue.shift();
        } catch (error) {
          item.attempts = Math.min((item.attempts || 0) + 1, 20);
          item.nextAttemptAt = now() + Math.min(60000 * 2 ** (item.attempts - 1), 900000);
          deliveryCode = error?.status === 401 ? 'PAIR_REQUIRED' : 'RETRY_PENDING';
          break;
        }
      }
      await storage.set({ diagnosticOutbox: queue, diagnosticDelivery: { state: queue.length ? 'pending' : 'sent',
        pendingCount: queue.length, code: deliveryCode, lastReceivedAt: acknowledged, lastReportId: acknowledgedId } });
    }); },
  };
}
