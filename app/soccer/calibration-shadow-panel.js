'use client';
import { useEffect, useState } from 'react';

const count = value => Number.isSafeInteger(value) && value >= 0;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const time = value => Number.isFinite(Date.parse(value))
  ? new Date(value).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }) : '尚未取得';
export function calibrationShadowReportValid(report, league) {
  const common = report?.version === 'SOCCER-CALIBRATION-SHADOW-v1' && report.league === league
    && ['captureGames', 'fullTimeCaptures', 'halfTimeCaptures', 'untouchedValidatedGames'].every(key => count(report[key]))
    && report.fullTimeCaptures >= report.captureGames && report.halfTimeCaptures >= report.captureGames
    && report.untouchedValidatedGames <= report.captureGames
    && ['accepted', 'formalEligible', 'promotionEligible', 'baselineChanged', 'executable'].every(key => report[key] === false)
    && ['W', 'R', 'S'].every(key => report[key] === null);
  if (!common) return false;
  if (report.validationCoverage !== undefined) {
    const coverage = report.validationCoverage;
    if (typeof coverage?.completeWithinRequestedScope !== 'boolean' || !count(coverage.readCaptures)
      || coverage.totalCaptures !== report.captureGames || coverage.readCaptures > coverage.totalCaptures
      || report.untouchedValidatedGames > coverage.readCaptures) return false;
  }
  if (report.status === 'AWAITING_FIRST_ANALYSIS') return report.freeze === null
    && ['captureGames', 'fullTimeCaptures', 'halfTimeCaptures', 'untouchedValidatedGames'].every(key => report[key] === 0);
  return report.status === 'SHADOW_COLLECTION_ACTIVE' && report.freeze?.status === 'DATABASE_FROZEN'
    && ['candidateHash', 'planHash', 'modelHash', 'halfTimeModelHash'].every(key => hash(report.freeze[key]))
    && Number.isFinite(Date.parse(report.freeze.frozenAt));
}

export function SoccerCalibrationShadowPanel({ league }) {
  const supported = ['epl', 'ucl'].includes(league);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState({ league: '', loading: true, report: null, error: '' });
  const [evaluating, setEvaluating] = useState(false);
  useEffect(() => {
    if (!supported) return;
    let active = true;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 25000);
    setState({ league, loading: true, report: null, error: '' });
    fetch(`/api/soccer/calibration-shadow?${new URLSearchParams({ league })}`, { cache: 'no-store', signal: controller.signal })
      .then(async response => {
        const body = await response.json();
        if (!response.ok || body.ok !== true) throw Error(response.status === 401 ? '登入已過期，請重新登入。' : body.error || '校準預測保存狀態暫時無法讀取。');
        if (!calibrationShadowReportValid(body.report, league)) throw Error('校準預測保存狀態尚未通過核對，筆數未知。');
        if (active) setState({ league, loading: false, report: body.report, error: '' });
      }).catch(error => {
        if (active) setState({ league, loading: false, report: null, error: error.name === 'AbortError' ? '校準預測保存狀態讀取逾時，筆數未知。' : error.message });
      }).finally(() => clearTimeout(timer));
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [league, supported, revision]);
  async function evaluate() {
    if (evaluating || !supported) return;
    setEvaluating(true);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 28000);
    try {
      const response = await fetch('/api/soccer/calibration-shadow', { method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ league, action: 'evaluate' }) });
      const body = await response.json();
      if (!response.ok || body.ok !== true) throw Error(response.status === 401 ? '登入已過期，請重新登入。' : body.error || '校準預測賽果暫時無法核對。');
      setRevision(value => value + 1);
    } catch (error) {
      setState({ league, loading: false, report: null, error: error.name === 'AbortError' ? '校準預測賽果核對逾時，請重新讀取保存狀態。' : error.message });
    } finally { clearTimeout(timer); setEvaluating(false); }
  }
  if (!supported) return null;
  const current = state.league === league, report = current ? state.report : null;
  return <section aria-label="校準候選前瞻保存" className="soccerCalibrationShadow">
    <h3>校準候選前瞻保存</h3>
    <p>分析本聯盟未開賽場次時，系統會另存固定校準候選的全場與上半場預測，供賽後比較。</p>
    <button type="button" className="secondary" disabled={!current || state.loading || evaluating} onClick={() => setRevision(value => value + 1)}>更新保存狀態</button>{' '}
    <button type="button" className="secondary" disabled={!current || state.loading || evaluating || !report?.freeze} onClick={evaluate}>{evaluating ? '核對中…' : '核對校準預測賽果'}</button>
    {(!current || state.loading) && <p role="status">正在讀取校準預測保存狀態…</p>}
    {current && state.error && <p role="alert">{state.error}</p>}
    {report && <>
      {report.validationCoverage?.completeWithinRequestedScope === false && <p role="status">賽果核對尚未讀完，已讀 {report.validationCoverage.readCaptures}／{report.validationCoverage.totalCaptures} 場；核對筆數僅代表已讀範圍。</p>}
      <p>不同賽事 {report.captureGames} 場｜全場預測 {report.fullTimeCaptures} 筆｜上半場預測 {report.halfTimeCaptures} 筆｜{report.validationCoverage?.completeWithinRequestedScope === false ? '已讀範圍核對賽果' : '已核對前瞻賽果'} {report.untouchedValidatedGames} 場。</p>
      {count(report.quarantinedGames) && report.quarantinedGames > 0 && <p className="soccerAvailability">賽果衝突隔離 {report.quarantinedGames} 場，未列入已核對樣本。</p>}
      <p className="soccerAvailability">{report.freeze ? `方案封存：${time(report.freeze.frozenAt)}。` : '方案會在首次分析時封存，只保存封存後的未開賽預測。'}{report.latestCapturedAt ? `最近保存：${time(report.latestCapturedAt)}。` : '尚無符合本方案的賽前預測。'}</p>
      <p className="soccerAvailability">已保存的預測筆數不等於模型驗收通過；正式評分仍須完成原盤規則、人員模型與收益誤差驗證。</p>
    </>}
  </section>;
}
