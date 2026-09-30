function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

function taskInputs(task) {
  if (!task || typeof task !== 'object') return task;
  const { requestId: ignoredRequestId, generation: ignoredGeneration, ...inputs } = task;
  return inputs;
}

function requestInputs(payload) {
  const inputs = { ...payload };
  if (Array.isArray(inputs.tasks)) inputs.tasks = inputs.tasks.map(taskInputs);
  if (Array.isArray(inputs.batches)) inputs.batches = inputs.batches.map(batch => ({
    ...batch, ...(Array.isArray(batch?.tasks) ? { tasks: batch.tasks.map(taskInputs) } : {}),
  }));
  return canonical(inputs);
}

// Bound uncertain starts independently from completed-job receipts. Keep the
// original body as well as its key, so a later click never changes a task request
// identity underneath an already accepted workflow start.
export function createBackgroundStartRequestJournal({
  now = () => Date.now(), maxEntries = 16, maxCharacters = 12_000_000, maxAgeMs = 24 * 60 * 60 * 1000,
} = {}) {
  const entries = new Map();
  const prune = () => {
    for (const [key, entry] of entries) {
      if (now() - entry.createdAt > maxAgeMs) entries.delete(key);
    }
  };
  const trim = () => {
    let characters = [...entries.entries()].reduce((sum, [key, entry]) => sum + key.length + entry.body.length, 0);
    while (entries.size > 1 && (entries.size > maxEntries || characters > maxCharacters)) {
      const key = entries.keys().next().value;
      characters -= key.length + entries.get(key).body.length;
      entries.delete(key);
    }
  };
  return {
    claim(payload, createId) {
      prune();
      const key = JSON.stringify(requestInputs(payload));
      let entry = entries.get(key);
      if (!entry) entry = { key, requestId: createId(), body: JSON.stringify(payload), createdAt: now() };
      entries.delete(key);
      entries.set(key, entry);
      trim();
      return entry;
    },
    release(entry) {
      if (entries.get(entry?.key) === entry) entries.delete(entry.key);
    },
  };
}

export function backgroundStartWasDefinitivelyRejected(error) {
  const status = Number(error?.status);
  return error?.definitiveStartRejected === true
    || (status >= 400 && status < 500 && ![408, 429].includes(status))
    || (status === 503 && error?.code === 'BACKGROUND_JOB_START_FAILED')
    || (error?.code === 'TRANSIENT_BROWSER_LOAD_FAILED'
      && Number(error?.cause?.status) === 503 && error?.cause?.code === 'BACKGROUND_JOB_START_FAILED');
}
