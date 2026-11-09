'use client';
import { useEffect, useRef, useState } from 'react';

const version = 'SOCCER-MODEL-FAMILY-DURABLE-REPLAY-v1';
const count = value => Number.isSafeInteger(value) && value >= 0;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const cursorValid = value => typeof value === 'string' && /^[a-f0-9]{48}$/.test(value);
const time = value => Number.isFinite(Date.parse(value))
  ? new Date(value).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }) : '尚未取得';
const number = value => Number.isFinite(value) ? value.toFixed(3) : '尚未取得';
const reasonLabels = {
  MODEL_FAMILY_CAPTURE_WITHOUT_VERIFIED_RESULT: '賽果尚未通過原始來源核對',
  MODEL_FAMILY_CAPTURE_OUTSIDE_WINDOW: '不在本次驗證期間',
  MODEL_FAMILY_GAME_RESULT_OR_CONTEXT_QUARANTINED: '賽果或比賽條件有更正，已隔離',
  MODEL_FAMILY_DATA_DUPLICATE_CAPTURE_CONFLICT: '同場保存版本衝突，已隔離',
  MODEL_FAMILY_FROZEN_MODEL_SCOPE_INVALID: '保存預測與固定模型不一致',
  MODEL_FAMILY_RESULT_UNAVAILABLE: '尚未取得有效賽果',
};
const blank = () => ({ loading: true, report: null, error: '', notice: '', freeze: null });
export function soccerModelFamilyReportValid(report, league, period) {
  if (report?.version !== version || report.league !== league || report.period !== period
    || report.formalEligible !== false || report.executable !== false
    || !['W', 'R', 'S'].every(key => report[key] === null)) return false;
  if (report.status === 'NOT_STARTED') return true;
  if (!['REPLAY_PARTIAL', 'REPLAY_BUSY', 'REPLAY_COMPLETE'].includes(report.status) || !cursorValid(report.cursor)
    || !hash(report.sourceRevision) || !Number.isFinite(Date.parse(report.asOf))
    || !count(report.processedCaptures) || !count(report.totalCaptures) || report.processedCaptures > report.totalCaptures
    || !count(report.quarantinedGames) || typeof report.sourceModelFreezeVerified !== 'boolean'
    || !report.excludedReasons || typeof report.excludedReasons !== 'object' || Array.isArray(report.excludedReasons)
    || Object.entries(report.excludedReasons).some(([code, n]) => !/^[A-Z][A-Z0-9_]{1,120}$/.test(code) || !count(n))) return false;
  const complete = report.status === 'REPLAY_COMPLETE';
  if (report.completeWithinRequestedScope !== complete || report.nextCursor !== (complete ? null : report.cursor)) return false;
  if (!complete) return report.confidenceSet === null && report.diagnostics === null;
  const artifact = report.confidenceSet;
  return report.processedCaptures === report.totalCaptures && count(artifact?.independentRealGames)
    && artifact.independentRealGames <= report.processedCaptures && hash(artifact.contentHash)
    && artifact.baseline?.league === league && artifact.baseline.period === period
    && hash(artifact.baseline.modelHash) && hash(artifact.baseline.trainingHash)
    && hash(artifact.protocolHash) && artifact.formalEligible === false
    && artifact.coverageAssumptionsVerified === false
    && ['W', 'R', 'S'].every(key => artifact[key] === null);
}
export function soccerModelFamilyFreezeValid(freeze, report) {
  return freeze?.status === 'DATABASE_FROZEN_FAMILY_RESEARCH' && freeze.league === report?.league
    && freeze.period === report.period && freeze.modelHash === report.confidenceSet?.baseline?.modelHash
    && freeze.trainingHash === report.confidenceSet.baseline.trainingHash
    && freeze.protocolHash === report.confidenceSet.protocolHash && hash(freeze.freezeId) && hash(freeze.parameterHash)
    && [freeze.frozenAt, freeze.testFrom, freeze.testBefore].every(value => Number.isFinite(Date.parse(value)))
    && Date.parse(freeze.frozenAt) < Date.parse(freeze.testFrom) && Date.parse(freeze.testFrom) < Date.parse(freeze.testBefore)
    && freeze.formalEligible === false && freeze.coverageAssumptionsVerified === false;
}
const stopped = () => Object.assign(Error('aborted'), { name: 'AbortError' });
function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(stopped()); return; }
    const cancel = () => { clearTimeout(timer); reject(stopped()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
    signal.addEventListener('abort', cancel, { once: true });
  });
}
async function requestFamily(scope, params, action, signal) {
  const controller = new AbortController(), cancel = () => controller.abort();
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) controller.abort();
  scope.controllers.add(controller);
  const timer = setTimeout(() => controller.abort(), 75000);
  try {
    const response = await fetch(action ? '/api/soccer/model-family' : `/api/soccer/model-family?${new URLSearchParams(params)}`, {
      cache: 'no-store', signal: controller.signal,
      ...(action ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...params, action }) } : {}),
    });
    let body;
    try { body = await response.json(); } catch { throw Error('核對回應無法讀取，結果未知。'); }
    return { response, body };
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', cancel); scope.controllers.delete(controller);
  }
}
const failure = response => response.status === 401 ? '登入已過期，請重新登入。'
  : response.status === 409 ? '來源或驗證狀態已改變，請重新核對。' : '模型誤差核對暫時無法完成，結果未知。';

export function SoccerModelFamilyPanel({ league }) {
  const supported = ['epl', 'ucl'].includes(league), current = useRef(null);
  const [state, setState] = useState({ league, FT: blank(), HT: blank() });
  const [running, setRunning] = useState(null);
  useEffect(() => {
    const scope = { league, active: true, running: false, controllers: new Set(), generations: { FT: 0, HT: 0 } };
    current.current = scope; setRunning(null); setState({ league, FT: blank(), HT: blank() });
    if (supported) for (const period of ['FT', 'HT']) {
      const controller = new AbortController(); scope.controllers.add(controller);
      const generation = scope.generations[period];
      (async () => {
        try {
          const { response, body } = await requestFamily(scope, { league, period }, null, controller.signal);
          if (!response.ok || body.ok !== true) throw Error(failure(response));
          if (!soccerModelFamilyReportValid(body.report, league, period)) throw Error('核對範圍不一致，結果未知。');
          const freeze = soccerModelFamilyFreezeValid(body.report.freeze, body.report) ? body.report.freeze : null;
          if (scope.active && scope.generations[period] === generation)
            setState(old => ({ ...old, [period]: { loading: false, report: body.report, freeze, error: '', notice: '' } }));
        } catch (error) {
          if (scope.active && scope.generations[period] === generation)
            setState(old => ({ ...old, [period]: { ...blank(), loading: false, error: error.name === 'AbortError'
              ? '讀取逾時，結果未知，可重新核對。' : error.message } }));
        } finally { scope.controllers.delete(controller); }
      })();
    }
    return () => { scope.active = false; for (const controller of scope.controllers) controller.abort(); if (current.current === scope) current.current = null; };
  }, [league, supported]);
  async function run(period, action = 'replay') {
    const scope = current.current;
    if (!scope?.active || scope.league !== league || scope.running) return;
    scope.running = true; scope.generations[period]++; setRunning(period);
    const controller = new AbortController(); scope.controllers.add(controller);
    let report = state.league === league ? state[period].report : null;
    let cursor = action === 'freeze' || report?.completeWithinRequestedScope === false ? report?.cursor : null;
    let restarts = 0, throttles = 0, noProgress = 0;
    const update = patch => { if (scope.active) setState(old => ({ ...old, [period]: { ...old[period], ...patch } })); };
    update({ error: '', notice: '', loading: true });
    try {
      // Each response materializes one source capture on the server. Progress
      // is the durable whole scan; the browser never fits or submits results.
      for (let batch = 0; batch < 1005; batch++) {
        const { response, body } = await requestFamily(scope, { league, period, ...(cursor ? { cursor } : {}) }, action, controller.signal);
        if (!scope.active) return;
        if (response.status === 429 && throttles++ < 3) {
          const seconds = Number(response.headers.get('Retry-After'));
          update({ notice: '等待請求額度後自動繼續核對。' });
          await pause(Math.max(1, Math.min(60, Number.isFinite(seconds) ? seconds : 60)) * 1000, controller.signal); continue;
        }
        if (response.status === 409 && action === 'replay'
          && ['MODEL_FAMILY_SCAN_SOURCE_CHANGED', 'MODEL_FAMILY_DATA_SOURCE_CHANGED', 'MODEL_FAMILY_DATA_SOURCE_AFTER_AS_OF'].includes(body.code)
          && restarts++ < 2) {
          cursor = null; report = null; noProgress = 0;
          update({ report: null, freeze: null, notice: '來源新增或更正，重新核對完整範圍。' });
          await pause(1100, controller.signal); continue;
        }
        if (!response.ok || body.ok !== true) throw Error(failure(response));
        if (action === 'freeze') {
          if (!soccerModelFamilyFreezeValid(body.freeze, report)) throw Error('固定版本的時間或範圍尚未通過核對。');
          update({ freeze: body.freeze, notice: '已固定後續驗證版本，等待獨立驗證結果。' }); return;
        }
        if (!soccerModelFamilyReportValid(body.report, league, period)
          || cursor && body.report.cursor !== cursor
          || cursor && report && (body.report.sourceRevision !== report.sourceRevision || body.report.processedCaptures < report.processedCaptures))
          throw Error('核對範圍或進度不一致，結果未知。');
        noProgress = report && body.report.processedCaptures <= report.processedCaptures ? noProgress + 1 : 0;
        report = body.report; cursor = report.cursor;
        const freeze = soccerModelFamilyFreezeValid(report.freeze, report) ? report.freeze : null;
        update({ report, freeze, notice: report.status === 'REPLAY_BUSY' ? '另一項核對正在執行，稍後自動繼續。' : '' });
        if (report.completeWithinRequestedScope) return;
        if (noProgress >= 3) throw Error('本次來源尚未讀完，已保留進度，可稍後繼續核對。');
        await pause(report.status === 'REPLAY_BUSY' ? 10000 : 1100, controller.signal);
      }
      throw Error('本次核對已保留進度，可繼續核對。');
    } catch (error) {
      if (scope.active) update({ error: error.name === 'AbortError' ? '核對逾時，已保存的進度可繼續。' : error.message });
    } finally {
      scope.controllers.delete(controller); scope.running = false;
      if (scope.active) { setRunning(null); update({ loading: false }); }
    }
  }
  if (!supported) return null;
  return <section className="soccerCalibrationGroup" aria-label="正式評分模型誤差核對">
    <h3>正式評分｜模型誤差核對</h3>
    <p>用保存的賽前預測與原始賽果核對。來源讀完後，仍需確認模型適用性與後續獨立驗證，才能放行正式 R 與 S。</p>
    {['FT', 'HT'].map(period => {
      const entry = state.league === league ? state[period] : blank(), report = entry.report;
      const complete = report?.completeWithinRequestedScope === true, artifact = complete ? report.confidenceSet : null;
      const freeze = entry.freeze, label = period === 'FT' ? '全場' : '上半場';
      const reasons = Object.entries(report?.excludedReasons || {}).filter(([, n]) => n > 0);
      return <article key={period} aria-label={`${label}模型誤差核對`}>
        <h4>{label}</h4>
        {entry.loading && !report && <p role="status">正在讀取核對紀錄</p>}
        {report?.status === 'NOT_STARTED' && <p>NOT VERIFIED｜尚未建立本期間的誤差核對。</p>}
        {report && report.status !== 'NOT_STARTED' && <p role="status">{complete ? '來源讀取完成' : 'PARTIAL'}｜已核對 {report.processedCaptures}／{report.totalCaptures} 筆保存預測</p>}
        {artifact && <p>有效獨立賽事 {artifact.independentRealGames} 場｜隔離 {report.quarantinedGames} 場<br/>原模型封存憑據：{report.sourceModelFreezeVerified ? '已核對' : '待核對'}｜正式 R／S：尚未驗收</p>}
        {complete && artifact.independentRealGames === 0 && <p>尚無符合條件的完整賽果，誤差不可當成 0。</p>}
        {report?.asOf && <p>資料截點 {time(report.asOf)}</p>}
        {reasons.length > 0 && <details><summary>未納入原因（檢查次數）</summary><ul>{reasons.map(([code, n]) => <li key={code}>{reasonLabels[code] || '來源、時間或比賽範圍未通過核對'}：{n}</li>)}</ul></details>}
        {artifact?.independentRealGames > 0 && <details><summary>研究診斷</summary><p>以下區間只適用於原比分模型假設，不能直接當成正式 R 的誤差。</p>
          <div className="soccerTableWrap"><table className="soccerAuditTable"><thead><tr><th>方向</th><th>進球倍率區間</th><th>每場 Pearson 殘差</th></tr></thead><tbody>{[['home', '主隊'], ['away', '客隊']].map(([side, name]) => <tr key={side}><td>{name}</td><td>{number(artifact.marginals?.[side]?.multiplier?.lower)} ～ {number(artifact.marginals?.[side]?.multiplier?.upper)}</td><td>{number(report.diagnostics?.calibration?.sides?.[side]?.pearsonPerGame?.value)}</td></tr>)}</tbody></table></div>
          <p>獨立性、條件穩定性、人員影響及模型以外的誤差：NOT VERIFIED。</p></details>}
        {freeze && <p>{freeze.sourceArtifactHash === artifact?.contentHash ? '後續驗證版本已固定' : '已有固定版本，本次來源版本不同'}：{time(freeze.frozenAt)}<br/>驗證期間 {time(freeze.testFrom)} ～ {time(freeze.testBefore)}<br/>目前尚未代表後續驗證通過。</p>}
        {entry.notice && <p role="status">{entry.notice}</p>}{entry.error && <p role="alert">{entry.error}</p>}
        <div className="rankingViewTabs"><button disabled={Boolean(running) || entry.loading} onClick={() => run(period)}>{running === period ? '核對中' : report && !complete && report.status !== 'NOT_STARTED' ? `繼續核對${label}` : `核對${label}模型誤差`}</button>
          {complete && artifact.independentRealGames > 0 && !freeze && <button className="secondary" disabled={Boolean(running) || entry.loading} onClick={() => run(period, 'freeze')}>固定後續驗證版本</button>}</div>
      </article>;
    })}
  </section>;
}
