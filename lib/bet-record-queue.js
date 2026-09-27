import { betPositionIdentity, betPriceMatches } from './bet-ledger.js';
import { findConfirmedRecordedBet, requireCloudLedgerResponse } from './cloud-ledger-receipt.js';
import { MAX_BET_ATTEMPTS, sanitizeBetAttemptCandidate, sanitizeBetAttemptEntry } from './bet-attempt-journal.js';

// Runners remain in memory only. Restored metadata can request ledger readback,
// but can never replay a financial write or assert a successful record.
export function createBetRecordQueue(onChange = () => {}) {
  const entries = new Map();
  const pending = [];
  let running = false;
  let lastError = null;
  const snapshot = () => [...entries.values()].map(({ run, ...entry }) => ({ ...entry, ...(entry.candidate ? { candidate: { ...entry.candidate } } : {}) }));
  const publish = () => onChange(snapshot());
  const updateTime = entry => { entry.updatedAt = Math.max(entry.createdAt, Date.now()); };
  function confirmEntry(entry, ledgerData) {
    if (!entry?.candidate) return false;
    let matched;
    try { matched = findConfirmedRecordedBet(ledgerData, entry.candidate); } catch { return false; }
    if (!matched) return false;
    entry.status = 'confirmed';
    entry.confirmedBetId = matched.id;
    entry.message = '已從永久帳本確認紀錄存在';
    updateTime(entry);
    return true;
  }
  async function drain() {
    if (running) return;
    running = true;
    try {
      while (pending.length) {
        const entry = pending.shift();
        entry.status = 'saving';
        updateTime(entry);
        publish();
        try {
          const result = await entry.run();
          entry.status = result?.status || 'confirmed';
          entry.message = result?.message || '';
          entry.requiresRecheck = result?.requiresRecheck === true;
          entry.rejectedPitSnapshotId = result?.rejectedPitSnapshotId || null;
          entry.confirmedBetId = typeof result?.betId === 'string' && result.betId.length > 0 && result.betId.length <= 120 ? result.betId : null;
        } catch (error) {
          entry.status = 'uncertain';
          entry.message = error?.message || '記錄失敗';
        }
        delete entry.run;
        updateTime(entry);
        publish();
      }
    } finally {
      running = false;
    }
  }
  return {
    get running() { return running; },
    get lastError() { return lastError; },
    restore(values) {
      if (running || entries.size || !Array.isArray(values)) return { ok: false, code: 'BET_ATTEMPT_RESTORE_UNSAFE', message: '下注隊列已啟動，不能覆蓋目前操作。' };
      const restored = new Map();
      for (const value of values) {
        const entry = sanitizeBetAttemptEntry(value);
        if (!entry || restored.has(entry.key) || restored.size >= MAX_BET_ATTEMPTS) return { ok: false, code: 'BET_ATTEMPT_JOURNAL_INVALID', message: '下注操作紀錄無法驗證，未加入隊列。' };
        if (entry.status === 'queued') {
          entry.status = 'failed';
          entry.message = '上次排隊操作未送出；請核對目前盤口後手動重試。';
        } else if (['saving', 'confirmed'].includes(entry.status)) {
          entry.status = 'uncertain';
          entry.message = '已復原上次操作，正在回讀永久帳本確認；不會自動重送。';
        }
        restored.set(entry.key, entry);
      }
      for (const [key, entry] of restored) entries.set(key, entry);
      if (entries.size) publish();
      return { ok: true, restored: entries.size, entries: snapshot() };
    },
    confirm(key, ledgerData) {
      const entry = entries.get(key);
      if (entry?.status !== 'uncertain' || !entry.candidate) return false;
      if (!confirmEntry(entry, ledgerData)) return false;
      publish();
      return true;
    },
    reconcile(ledgerData) {
      try { requireCloudLedgerResponse(ledgerData); } catch { return false; }
      let changed = false;
      for (const entry of entries.values()) {
        if (['queued', 'saving'].includes(entry.status) || !entry.candidate) continue;
        if (entry.status !== 'confirmed' && confirmEntry(entry, ledgerData)) { changed = true; continue; }
        const candidate = entry.candidate;
        const expectedId = entry.confirmedBetId || candidate.id;
        // A canceled older attempt at identical prices must not release a
        // newer ambiguous write. Cancellation needs this exact record ID.
        if (!expectedId) continue;
        const records = ledgerData.bets.filter(bet => bet?.id === expectedId);
        if (records.length !== 1) continue;
        const cancelled = records[0];
        if (cancelled.status !== 'CANCELLED' || cancelled.league !== candidate.league
          || cancelled.date !== candidate.date || Number(cancelled.gamePk) !== candidate.gamePk
          || cancelled.market !== candidate.market || Number(cancelled.stake) !== candidate.stake
          || !betPriceMatches(cancelled, candidate.date, candidate.gamePk, candidate, candidate.league)
          || !['SERVER_VERIFIED_CURRENT_READER', 'SERVER_VERIFIED_CAPTURED_READER'].includes(cancelled.readerEvidenceStatus)
          || cancelled.pitEvidenceVerified !== true || cancelled.pitPredictionStatus !== 'IMMUTABLE_PIT_VERIFIED') continue;
        const message = '上次紀錄已從永久帳本確認取消；核對目前盤口後可手動重新記錄。';
        if (entry.status === 'failed' && entry.message === message) continue;
        entry.status = 'failed';
        entry.message = message;
        entry.requiresRecheck = false;
        entry.rejectedPitSnapshotId = null;
        updateTime(entry);
        changed = true;
      }
      if (changed) publish();
      return changed;
    },
    enqueue(key, label, run, capturedCandidate) {
      lastError = null;
      const previous = entries.get(key);
      // Uncertain outcomes must be reconciled, not blindly retried.
      if (previous && !['failed', 'confirmed'].includes(previous.status)) return false;
      const candidate = capturedCandidate == null ? null : sanitizeBetAttemptCandidate(capturedCandidate);
      if (typeof run !== 'function' || (capturedCandidate != null && (!candidate
        || key !== betPositionIdentity(candidate.date, candidate.gamePk, candidate, candidate.league)))) {
        lastError = { code: 'BET_ATTEMPT_IDENTITY_INVALID', message: '下注操作的聯盟、比賽或盤口識別不一致，尚未送出。' };
        return false;
      }
      if (!previous && entries.size >= MAX_BET_ATTEMPTS) {
        const oldestConfirmed = [...entries.values()].filter(entry => entry.status === 'confirmed').sort((a, b) => a.updatedAt - b.updatedAt)[0];
        if (oldestConfirmed) entries.delete(oldestConfirmed.key);
        else {
          lastError = { code: 'BET_ATTEMPT_JOURNAL_FULL', message: '待確認的下注操作紀錄已滿；請先回讀帳本確認，尚未新增。' };
          return false;
        }
      }
      const now = Date.now();
      const entry = { key, label, status: 'queued', message: '', createdAt: now, updatedAt: now, ...(candidate ? { candidate } : {}), run };
      entries.set(key, entry);
      pending.push(entry);
      publish();
      void drain();
      return true;
    },
  };
}
