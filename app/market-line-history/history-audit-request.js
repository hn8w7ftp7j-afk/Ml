'use client';

import { useEffect, useRef, useState } from 'react';

// Each section remains idle until the owner asks for a bounded, read-only query.
export function useHistoryAuditRequest() {
  const [data, setData] = useState({}), [busy, setBusy] = useState(null), [error, setError] = useState('');
  const request = useRef({ sequence: 0, controller: null, timer: null, busy: false, mounted: false });
  const clear = () => {
    ++request.current.sequence;
    request.current.controller?.abort();
    if (request.current.timer !== null) window.clearTimeout(request.current.timer);
    request.current.controller = null; request.current.timer = null; request.current.busy = false;
  };
  function reset() {
    clear();
    if (request.current.mounted) { setData({}); setBusy(null); setError(''); }
  }
  async function run(url, validate, { key = 'result', clearAll = false } = {}) {
    if (!request.current.mounted || request.current.busy) return;
    const sequence = ++request.current.sequence, controller = new AbortController();
    request.current.busy = true; request.current.controller = controller;
    const current = () => request.current.mounted && request.current.sequence === sequence;
    setBusy(key); setError(''); setData(previous => clearAll ? {} : { ...previous, [key]: null });
    request.current.timer = window.setTimeout(() => {
      if (!current()) return;
      clear(); setBusy(null); setError('查詢逾時，結果仍未確認；可再次查詢。');
    }, 30000);
    try {
      const response = await fetch(url, { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      if (!current()) return;
      if (response.status === 401 || response.status === 403) { setError('目前沒有查閱權限，結果仍未確認。'); return; }
      if (response.status === 429) { setError('查詢較密集，請稍後再試；結果仍未確認。'); return; }
      if (!response.ok) { setError('暫時無法查詢，結果仍未確認；請重試。'); return; }
      const value = validate(await response.json());
      if (current()) setData(previous => ({ ...previous, [key]: value }));
    } catch (cause) {
      if (current()) setError(cause?.name === 'AbortError' ? '查詢已中止，結果仍未確認；可再次查詢。' : '回應未通過核對，結果仍未確認；請重試。');
    } finally {
      if (current()) {
        if (request.current.timer !== null) window.clearTimeout(request.current.timer);
        request.current.timer = null; request.current.controller = null; request.current.busy = false; setBusy(null);
      }
    }
  }
  useEffect(() => {
    request.current.mounted = true;
    return () => { request.current.mounted = false; clear(); };
  }, []);
  return { data, busy, error, run, reset };
}
