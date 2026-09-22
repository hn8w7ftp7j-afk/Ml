// In-memory only: never replay financial records automatically after a reload.
export function createBetRecordQueue(onChange = () => {}) {
  const entries = new Map();
  const pending = [];
  let running = false;
  const publish = () => onChange([...entries.values()].map(({ run, ...entry }) => ({ ...entry })));
  async function drain() {
    if (running) return;
    running = true;
    try {
      while (pending.length) {
        const entry = pending.shift();
        entry.status = 'saving';
        publish();
        try {
          const result = await entry.run();
          entry.status = result?.status || 'confirmed';
          entry.message = result?.message || '';
          entry.requiresRecheck = result?.requiresRecheck === true;
          entry.rejectedPitSnapshotId = result?.rejectedPitSnapshotId || null;
        } catch (error) {
          entry.status = 'uncertain';
          entry.message = error?.message || '記錄失敗';
        }
        delete entry.run;
        publish();
      }
    } finally {
      running = false;
    }
  }
  return {
    get running() { return running; },
    confirm(key) {
      const entry = entries.get(key);
      if (entry?.status !== 'uncertain') return;
      entry.status = 'confirmed';
      entry.message = '已從永久帳本確認紀錄存在';
      publish();
    },
    enqueue(key, label, run) {
      const previous = entries.get(key);
      // Uncertain outcomes must be reconciled, not blindly retried.
      if (previous && !['failed', 'confirmed'].includes(previous.status)) return false;
      const entry = { key, label, status: 'queued', message: '', run };
      entries.set(key, entry);
      pending.push(entry);
      publish();
      void drain();
      return true;
    },
  };
}
