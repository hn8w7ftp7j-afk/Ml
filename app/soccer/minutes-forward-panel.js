'use client';
import { useEffect, useRef, useState } from 'react';

const VERSION = 'SOCCER-MINUTES-FORWARD-v1';
const WEIGHTING = 'EQUAL_REAL_GAME_THEN_EQUAL_PRIOR_CANDIDATE_PLAYER';
const SOURCE_SCOPE = 'ESPN_TWO_ENDPOINT_CROSSCHECK_NOT_INDEPENDENT_OFFICIAL_CONFIRMATION';
const count = value => Number.isSafeInteger(value) && value >= 0;
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const instant = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const time = value => instant(value) ? new Date(value).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }) : '尚未取得';
const number = value => finite(value) ? value.toFixed(4) : '—';
const integer = value => count(value) ? value.toLocaleString('zh-TW') : '未知';
const sequence = value => typeof value === 'string' && /^(?:0|[1-9]\d{0,17})$/.test(value);
const reasons = {
  MINUTES_FORWARD_MATCH_NOT_FINISHED: '比賽尚未正常完賽',
  MINUTES_FORWARD_RESULT_NOT_CHECKED: '尚未保存賽後核對',
  MINUTES_FORWARD_RESULT_SOURCE_UNAVAILABLE: '賽後來源暫時無法讀取',
  MINUTES_FORWARD_RESULT_UNVERIFIED: '賽果或上場分鐘尚未通過核對',
  MINUTES_FORWARD_CAPTURE_REPLAY_FAILED: '封存預測與原始資料重播不一致',
  MINUTES_FORWARD_RESULT_CONFLICT: '歷次賽後核對有衝突',
  MINUTES_FORWARD_TARGET_REVISION_CONFLICT: '歷次球員分鐘或角色證據有衝突',
  MINUTES_FORWARD_NO_RESULT_DOCUMENTS: '尚無完整的賽後原始文件',
  RESULT_NORMAL_FINAL_UNCONFIRMED: '尚未確認正常完賽',
  RESULT_PERIOD_SCORE_UNVERIFIED: '期間比分依據尚未齊全',
  RESULT_SCOREBOARD_CROSSCHECK_UNAVAILABLE: '賽程端點暫時無法交叉核對',
  RESULT_ENDPOINTS_DISAGREE: '來源端點的賽果有衝突',
  RESULT_EXTRA_PERIODS_REQUIRE_REVIEW: '加時或其他期間需另行核對',
  CALIBRATION_RESULT_FINAL_WITHDRAWN: '來源後續撤回完賽標記',
  CALIBRATION_RESULT_FT_CORRECTION: '來源後續更正賽果',
};

/** Display-only validation: this never supplies acceptance or source authority. */
export function minutesForwardReportValid(report, league) {
  const c = report?.counts, coverage = report?.coverage;
  if (report?.version !== VERSION || report.league !== league || !['epl', 'ucl'].includes(league)
    || report.metricWeighting !== WEIGHTING || report.sourceScope !== SOURCE_SCOPE || typeof report.completeWithinRequestedScope !== 'boolean'
    || !['accepted', 'formalEligible', 'executable'].every(key => report[key] === false)
    || !['W', 'R', 'S'].every(key => report[key] === null)
    || !c || !['captures', 'evaluated', 'pending', 'quarantined', 'upcoming'].every(key => count(c[key]))
    || c.captures !== c.evaluated + c.pending + c.quarantined || c.upcoming > c.captures - c.evaluated) return false;
  const p = report.protocol;
  if (p === null ? c.captures !== 0 : p?.status !== 'DATABASE_FROZEN' || !hash(p.protocolId)
    || !hash(p.protocolHash) || !instant(p.registeredAt) || !hash(p.protocol?.modelHash) || !hash(p.protocol?.artifactHash)
    || p.protocol.version !== VERSION || p.protocol.league !== league || p.protocol.metricWeighting !== WEIGHTING
    || p.protocol.clockBasis !== 'PROVIDER_REGULATION_MINUTES_EXCLUDES_ADDED_TIME'
    || p.protocol.zeroProbabilityPolicy !== 'POSITIVE_INFINITY_WITHOUT_PROBABILITY_CLIPPING'
    || p.protocol.baselineMethod !== 'PRIOR_THREE_MATCH_MEAN_MINUTES_AND_ROLE_FREQUENCIES_WITH_ONE_TRAINING_GLOBAL_PSEUDO_OBSERVATION'
    || p.protocol.sourceScope !== SOURCE_SCOPE || !instant(p.protocol.modelCreatedAt) || !instant(p.protocol.trainingBefore)
    || Date.parse(p.protocol.trainingBefore) >= Date.parse(p.protocol.modelCreatedAt)
    || Date.parse(p.protocol.modelCreatedAt) > Date.parse(p.registeredAt)) return false;
  let playerTargets = null;
  for (const arm of ['model', 'baseline']) {
    const m = report.metrics?.[arm];
    if (!m || m.games !== c.evaluated || !count(m.playerTargets) || m.games === 0 && m.playerTargets !== 0
      || m.games > 0 && m.playerTargets < m.games || playerTargets !== null && playerTargets !== m.playerTargets) return false;
    playerTargets = m.playerTargets;
    if (m.games === 0) {
      if (!['minuteMAE', 'minuteRMSE', 'logLoss', 'brier'].every(key => m[key] === null) || m.logLossState !== 'UNAVAILABLE') return false;
    } else {
      if (!['minuteMAE', 'minuteRMSE', 'brier'].every(key => finite(m[key]))) return false;
      // Same nonnegative weights imply MAE <= RMSE. Both use 0–90-minute
      // targets/predictions and the three-role Brier is at most two. This
      // validates the declared metric contract; it never clips model values.
      const rounding = Number.EPSILON * 64 * Math.max(1, m.games, m.playerTargets);
      if (m.minuteMAE > m.minuteRMSE + rounding * 90 || m.minuteMAE > 90 + rounding * 90
        || m.minuteRMSE > 90 + rounding * 90 || m.brier > 2 + rounding * 2) return false;
      if (m.logLossState === 'POSITIVE_INFINITY' ? m.logLoss !== null : m.logLossState !== 'FINITE' || !finite(m.logLoss)) return false;
    }
  }
  if (!coverage || coverage.evaluatedGames !== c.evaluated || coverage.modeledPlayerTargets !== playerTargets
    || !['unmodeledCurrentRosterPlayers', 'unseenAppearingPlayers'].every(key => count(coverage[key]))
    || !(coverage.unseenRegulationMinutes === null || finite(coverage.unseenRegulationMinutes))) return false;
  const keys = values => Array.isArray(values) && new Set(values).size === values.length
    && values.every(key => typeof key === 'string' && new RegExp(`^soccer:${league}:\\d{1,16}$`).test(key));
  if (!['readCaptureGameKeys', 'evaluatedGameKeys', 'quarantinedGameKeys'].every(key => keys(report[key]))
    || report.readCaptureGameKeys.length > c.captures || report.evaluatedGameKeys.length !== c.evaluated
    || report.quarantinedGameKeys.length !== c.quarantined
    || [...report.evaluatedGameKeys, ...report.quarantinedGameKeys].some(key => !report.readCaptureGameKeys.includes(key))
    || report.evaluatedGameKeys.some(key => report.quarantinedGameKeys.includes(key))) return false;
  return Array.isArray(report.reasons) && report.reasons.length <= 200 && new Set(report.reasons.map(row => row?.code)).size === report.reasons.length
    && report.reasons.every(row => /^[A-Z][A-Z0-9_]{1,100}$/.test(row?.code || '') && count(row.count));
}

export function mergeMinutesForwardPage(previous, report, afterSequence) {
  const fail = () => { throw Error('MINUTES_FORWARD_PAGE_INVALID'); }, p = report.page;
  if (!minutesForwardReportValid(report, report.league) || !sequence(afterSequence)
    || !p || p.afterSequence !== afterSequence || !hash(p.revision) || typeof p.complete !== 'boolean' || typeof p.reachedEnd !== 'boolean'
    || (p.nextSequence !== null && !sequence(p.nextSequence)) || p.reachedEnd !== (p.nextSequence === null)
    || p.reachedEnd && !p.complete || p.complete && !p.reachedEnd && BigInt(p.nextSequence) <= BigInt(afterSequence)
    || p.complete && !p.reachedEnd && report.readCaptureGameKeys.length === 0
    || !p.complete && (p.nextSequence !== afterSequence || report.readCaptureGameKeys.length !== 0)) fail();
  if (previous ? previous.league !== report.league || previous.page.revision !== p.revision || previous.page.nextSequence !== afterSequence
    || previous.counts.captures !== report.counts.captures || JSON.stringify(previous.protocol) !== JSON.stringify(report.protocol)
    : afterSequence !== '0') fail();
  if (previous?.readCaptureGameKeys.some(key => report.readCaptureGameKeys.includes(key))) fail();
  const combinedKeys = key => [...(previous?.[key] || []), ...report[key]];
  const readCaptureGameKeys = combinedKeys('readCaptureGameKeys'), evaluatedGameKeys = combinedKeys('evaluatedGameKeys'), quarantinedGameKeys = combinedKeys('quarantinedGameKeys');
  if (readCaptureGameKeys.length > report.counts.captures || p.reachedEnd && readCaptureGameKeys.length !== report.counts.captures) fail();
  const metrics = {};
  for (const arm of ['model', 'baseline']) {
    const left = previous?.metrics[arm], right = report.metrics[arm], a = left?.games || 0, b = right.games, games = a + b;
    const infinite = games > 0 && [left?.logLossState, right.logLossState].includes('POSITIVE_INFINITY');
    metrics[arm] = { games, playerTargets: (left?.playerTargets || 0) + right.playerTargets,
      minuteMAE: games ? ((a ? left.minuteMAE * a : 0) + (b ? right.minuteMAE * b : 0)) / games : null,
      minuteRMSE: games ? Math.sqrt(((a ? left.minuteRMSE ** 2 * a : 0) + (b ? right.minuteRMSE ** 2 * b : 0)) / games) : null,
      logLoss: !games || infinite ? null : ((a ? left.logLoss * a : 0) + (b ? right.logLoss * b : 0)) / games,
      logLossState: !games ? 'UNAVAILABLE' : infinite ? 'POSITIVE_INFINITY' : 'FINITE',
      brier: games ? ((a ? left.brier * a : 0) + (b ? right.brier * b : 0)) / games : null };
  }
  const coverage = Object.fromEntries(['evaluatedGames', 'modeledPlayerTargets', 'unmodeledCurrentRosterPlayers', 'unseenAppearingPlayers', 'unseenRegulationMinutes'].map(key =>
    [key, key === 'unseenRegulationMinutes' && (report.coverage[key] === null || previous?.coverage[key] === null) ? null : (previous?.coverage[key] || 0) + report.coverage[key]]));
  const reasonsByCode = new Map((previous?.reasons || []).map(row => [row.code, row.count]));
  for (const row of report.reasons) reasonsByCode.set(row.code, (reasonsByCode.get(row.code) || 0) + row.count);
  const evaluated = evaluatedGameKeys.length, quarantined = quarantinedGameKeys.length;
  const combined = { ...report, counts: { ...report.counts, evaluated, quarantined, pending: report.counts.captures - evaluated - quarantined },
    metrics, coverage, readCaptureGameKeys, evaluatedGameKeys, quarantinedGameKeys,
    reasons: [...reasonsByCode].map(([code, count]) => ({ code, count })), completeWithinRequestedScope: p.reachedEnd };
  if (!minutesForwardReportValid(combined, report.league)) fail();
  return combined;
}

function MinutesForwardReport({ report }) {
  const c = report.counts, v = report.coverage;
  return <>
    <p>方案封存：{report.protocol ? time(report.protocol.registeredAt) : '尚未啟用；下一次核對賽前資料時先封存新方案。'}</p>
    {!report.completeWithinRequestedScope && <p role="status">本次範圍尚未完整讀取，已讀 {integer(report.readCaptureGameKeys.length)}／{integer(c.captures)} 場；以下核對與指標只涵蓋已完整重播的場次，其餘尚待核對。</p>}
    <p>已封存不同賽事 {integer(c.captures)} 場｜已核對 {integer(c.evaluated)} 場｜尚待核對 {integer(c.pending)} 場｜衝突隔離 {integer(c.quarantined)} 場。</p>
    {c.captures === 0 && <p className="soccerAvailability">尚無符合方案且完成賽前封存的場次；不能據此判定全部賽程已蒐集或沒有比賽。</p>}
    <p>依封存開賽時間，尚未開賽 {integer(c.upcoming)} 場。尚待核對包含未完賽、缺少依據或本次尚未完整讀取的場次。</p>
    <p>已核對範圍：模型與基準共同評估 {integer(v.modeledPlayerTargets)} 個球員目標，來自 {integer(v.evaluatedGames)} 場。當場名單未有預測 {integer(v.unmodeledCurrentRosterPlayers)} 人次；另有未納入預測但實際出場 {integer(v.unseenAppearingPlayers)} 人次，其正規時鐘分鐘 {v.unseenRegulationMinutes === null ? '未知' : number(v.unseenRegulationMinutes)}。</p>
    <div className="soccerTableWrap"><table className="soccerAuditTable"><caption>預計分鐘與出場角色的前瞻比較</caption>
      <thead><tr><th scope="col">模型</th><th scope="col">不同賽事</th><th scope="col">球員目標</th><th scope="col">分鐘 MAE</th><th scope="col">分鐘 RMSE</th><th scope="col">角色 Log Loss</th><th scope="col">角色 Brier</th></tr></thead>
      <tbody>{[['model', '封存分鐘模型'], ['baseline', '封存基準']].map(([arm, label]) => {
        const m = report.metrics[arm];
        return <tr key={arm}><th scope="row">{label}</th><td>{integer(m.games)}</td><td>{integer(m.playerTargets)}</td><td>{number(m.minuteMAE)}</td><td>{number(m.minuteRMSE)}</td><td>{m.logLossState === 'POSITIVE_INFINITY' ? '+∞（實際角色曾被預估為零機率）' : number(m.logLoss)}</td><td>{number(m.brier)}</td></tr>;
      })}</tbody></table></div>
    {c.evaluated === 0 && <p className="soccerAvailability">目前沒有可評估的前瞻場次；0 樣本不代表誤差為 0 或模型通過。</p>}
    <p className="soccerAvailability">每場先對共同球員目標平均，再對不同賽事等權平均；球員人次不能當成獨立比賽數。分鐘採正規時鐘、不含補時；模型與基準使用相同目標及分母。基準沿用前三場平均分鐘及既定角色頻率算法。缺少預測的人員另外列出，不補成 0 分鐘預測。</p>
    <p className="soccerAvailability">賽果由 ESPN 兩個端點交叉核對，並非獨立官方來源確認。</p>
    {report.reasons.length > 0 && <details className="soccerDetails"><summary>分鐘驗證待核對與隔離原因</summary><p>以下是核對原因計數，不能合併當成不同賽事數。</p><ul>{report.reasons.map(row => <li key={row.code}>{reasons[row.code] || '來源、時間或資料範圍未通過核對'}：{integer(row.count)} 筆 <small>{row.code}</small></li>)}</ul></details>}
  </>;
}

export function SoccerMinutesForwardPanel({ league }) {
  const supported = ['epl', 'ucl'].includes(league), scopeRef = useRef(null);
  const [state, setState] = useState({ league: '', status: 'loading', report: null, error: '' });
  async function request(scope, evaluate = false) {
    if (!scope?.active || scope.league !== league || scopeRef.current !== scope || scope.request) return;
    const current = { controller: null, timer: null };
    scope.request = current;
    const active = () => scope.active && scopeRef.current === scope && scope.request === current;
    setState({ league, status: evaluate ? 'evaluating' : 'loading', report: null, error: '' });
    const armTimer = milliseconds => {
      clearTimeout(current.timer); current.controller = new AbortController();
      current.timer = setTimeout(() => {
        if (!active()) return;
        current.controller.abort(); scope.request = null;
        setState({ league, status: 'failed', report: null, error: '分鐘驗證讀取逾時，結果與筆數仍未知，請重新讀取。' });
      }, milliseconds);
    };
    let failureMessage = '分鐘驗證暫時無法讀取，筆數未知。';
    try {
      const checked = (response, body) => {
        if (response.ok && body.ok === true) return;
        failureMessage = response.status === 401 || response.status === 403 ? '登入已過期或沒有查閱權限，分鐘驗證筆數未知。'
          : response.status === 429 ? '分鐘驗證查詢較密集，請稍後重試；本次筆數未知。' : failureMessage;
        throw Error('MINUTES_FORWARD_REQUEST_FAILED');
      };
      if (evaluate) {
        armTimer(30000);
        const response = await fetch('/api/soccer/minutes-forward', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ league, action: 'evaluate' }), signal: current.controller.signal });
        const body = await response.json(); clearTimeout(current.timer);
        if (!active()) return; checked(response, body);
      }
      let afterSequence = '0', aggregate = null, restarts = 0;
      while (active()) {
        armTimer(25000);
        const params = new URLSearchParams({ league, afterSequence });
        if (aggregate) params.set('revision', aggregate.page.revision);
        const response = await fetch(`/api/soccer/minutes-forward?${params}`, { credentials: 'same-origin', cache: 'no-store', signal: current.controller.signal });
        const body = await response.json(); clearTimeout(current.timer);
        if (!active()) return;
        if (response.status === 409 && body.code === 'MINUTES_FORWARD_HISTORY_CHANGED_DURING_READ' && restarts++ < 1) {
          afterSequence = '0'; aggregate = null; setState({ league, status: 'loading', report: null, error: '' }); continue;
        }
        checked(response, body);
        failureMessage = '分鐘驗證回應未通過範圍與數值核對，筆數未知。';
        if (!minutesForwardReportValid(body.report, league)) throw Error('MINUTES_FORWARD_REPORT_INVALID');
        aggregate = mergeMinutesForwardPage(aggregate, body.report, afterSequence);
        const continuing = body.report.page.complete && !body.report.page.reachedEnd;
        setState({ league, status: continuing ? 'loading' : 'ready', report: aggregate, error: '' });
        if (!continuing) return;
        afterSequence = body.report.page.nextSequence;
        failureMessage = '分鐘驗證暫時無法讀取，筆數未知。';
      }
    } catch (error) {
      if (active()) setState({ league, status: 'failed', report: null, error: error?.name === 'AbortError'
        ? '分鐘驗證已中止，筆數未知。' : failureMessage });
    } finally { clearTimeout(current.timer); if (active()) scope.request = null; }
  }
  useEffect(() => {
    const scope = { league, active: true, request: null }; scopeRef.current = scope;
    if (supported) void request(scope);
    return () => { scope.active = false; if (scope.request) { clearTimeout(scope.request.timer); scope.request.controller?.abort(); scope.request = null; } if (scopeRef.current === scope) scopeRef.current = null; };
  }, [league]);
  if (!supported) return null;
  const current = state.league === league, busy = !current || ['loading', 'evaluating'].includes(state.status), report = current ? state.report : null;
  return <section aria-label="預計上場分鐘前瞻驗證" className="soccerMinutesForward">
    <h3>預計上場分鐘前瞻驗證</h3>
    <p>核對賽前資料時先封存分鐘模型、基準預測及來源；正常完賽後，用保存的賽果與逐人正規時鐘分鐘重新核對。舊的賽後回補資料不補成這個新方案的賽前樣本。</p>
    <p className="soccerAvailability">沿用目前分鐘模型，只使用同聯盟最近 14 日、距開賽至少 24 小時且分鐘已核對的歷史名單候選；不保證所有賽程都有可用預測，缺少名單或歷史資料時不補值。</p>
    <p className="soccerAvailability">本項按本聯盟分鐘方案累計，不套用下方比分驗證的日期範圍。</p>
    <button type="button" className="secondary" disabled={busy} onClick={() => request(scopeRef.current)}>更新分鐘驗證</button>{' '}
    <button type="button" className="secondary" disabled={busy || !report?.protocol} onClick={() => request(scopeRef.current, true)}>核對已封存分鐘</button>
    {busy && <p role="status">{current && state.status === 'evaluating' ? '正在核對已封存分鐘…' : '正在讀取分鐘前瞻驗證，筆數尚未確認…'}</p>}
    {current && state.error && <p role="alert">{state.error}</p>}
    {report && <MinutesForwardReport report={report}/>}
    <p className="soccerAvailability">這是人員預測的前瞻研究核對，不代表人員模型、比分影響或正式 S 已通過驗收，也不會自動放行下注。</p>
  </section>;
}
