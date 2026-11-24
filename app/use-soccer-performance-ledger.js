'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { loadSoccerPerformanceLedger } from '../lib/performance-ledger-client.js';
import { CLOUD_LEDGER_VISIBLE_REFRESH_MS } from '../lib/cloud-ledger-sync-policy.js';

export function useSoccerPerformanceLedger(league, requestJSON) {
  const [ledger, setLedger] = useState({ bets: [], state: 'loading', error: '', invalidRecords: 0 });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const mounted = useRef(false), inFlight = useRef(false);
  const read = useCallback(async () => {
    const result = await loadSoccerPerformanceLedger(requestJSON, league);
    if (mounted.current) setLedger({ bets: result.bets, state: 'ready', error: '', invalidRecords: result.pagination.invalidRecords });
    return result;
  }, [league, requestJSON]);
  const load = useCallback(async ({ settle = false } = {}) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true);
    try {
      if (settle) {
        const result = await requestJSON('/api/soccer/performance', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'settle', league: league.toLowerCase() }),
        }, 60000);
        if (result.league !== league.toLowerCase() || !result.summary || !['checked', 'settled', 'pending', 'deferred'].every(key => Number.isSafeInteger(result.summary[key]) && result.summary[key] >= 0)) throw new Error('足球結算核對回應不完整。');
        if (mounted.current) setNotice(`${league}：本次核對 ${result.summary.checked} 筆，新增結算 ${result.summary.settled} 筆，待確認 ${result.summary.pending} 筆，待下次核對 ${result.summary.deferred} 筆。`);
      }
      return await read();
    } catch (cause) {
      if (mounted.current) setLedger(old => ({ ...old, state: 'unavailable', error: cause?.message || `${league} 永久帳本暫時無法讀取。` }));
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [league, read, requestJSON]);
  useEffect(() => {
    mounted.current = true; void load();
    const refresh = () => { if (document.visibilityState === 'visible') void load(); };
    const timer = window.setInterval(refresh, CLOUD_LEDGER_VISIBLE_REFRESH_MS);
    document.addEventListener('visibilitychange', refresh);
    return () => { mounted.current = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, [load]);
  const changeStatus = async (bet, action) => {
    if (inFlight.current || ledger.state !== 'ready' || bet.league !== league || !['cancel', 'restore'].includes(action)) return;
    if (!window.confirm(`確定${action === 'cancel' ? '取消' : '重新紀錄'}這筆 ${league} 網站紀錄？\n${bet.pick}`)) return;
    inFlight.current = true; setBusy(true);
    try {
      const receipt = await requestJSON('/api/soccer/bet-records', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, league: league.toLowerCase(), date: bet.date, id: bet.nativeRecordId }),
      }, 30000);
      const status = action === 'cancel' ? 'CANCELLED' : 'OPEN';
      if (receipt.persistence !== 'durable_database' || receipt.record?.id !== bet.nativeRecordId || receipt.record?.league !== league.toLowerCase() || receipt.record?.date !== bet.date || receipt.record?.status !== status) throw new Error('足球紀錄狀態尚未確認。');
      const result = await loadSoccerPerformanceLedger(requestJSON, league);
      if (!result.bets.some(row => row.id === bet.id && row.nativeStatus === status)) throw new Error('足球永久帳本尚未讀回更新狀態。');
      if (mounted.current) setLedger({ bets: result.bets, state: 'ready', error: '', invalidRecords: result.pagination.invalidRecords });
    } catch (cause) {
      if (mounted.current) setLedger(old => ({ ...old, state: 'unavailable', error: cause.message }));
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return { ...ledger, busy, notice, load, changeStatus };
}
