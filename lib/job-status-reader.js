// Share only concurrent GETs. Settled responses are never cached, so the next
// poll always sees current server state. Query scope and timeout remain distinct.
export function createJobStatusReader(read) {
  const pending = new Map();
  return function readStatus(url, timeoutMs) {
    const parsed = new URL(url, 'https://status.invalid');
    if (parsed.origin !== 'https://status.invalid' || parsed.pathname !== '/api/analysis-jobs') {
      return read(url, timeoutMs);
    }
    parsed.searchParams.delete('t');
    parsed.searchParams.sort();
    const key = `${parsed.pathname}${parsed.search}|${timeoutMs}`;
    let request = pending.get(key);
    if (!request) {
      request = Promise.resolve().then(() => read(url, timeoutMs));
      pending.set(key, request);
      const clear = () => { if (pending.get(key) === request) pending.delete(key); };
      request.then(clear, clear);
    }
    // UI consumers may enrich their copy; one consumer must not alter another.
    return request.then(value => structuredClone(value));
  };
}
