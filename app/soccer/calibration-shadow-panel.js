'use client';
import { useEffect, useRef, useState } from 'react';

const count = value => Number.isSafeInteger(value) && value >= 0;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const time = value => Number.isFinite(Date.parse(value))
  ? new Date(value).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }) : '尚未取得';
const reasonLabels = {
  CALIBRATION_MATCH_NOT_FINISHED: '比賽尚未完成',
  CALIBRATION_NO_SAVED_RESULT_CHECK: '尚未保存賽果查核紀錄',
  CALIBRATION_HALF_TIME_RESULT_PENDING: '半場賽果依據尚未齊備',
  CALIBRATION_RESULT_DOCUMENTS_UNAVAILABLE: '賽果來源尚未取得',
  CALIBRATION_SAVED_PREDICTION_RECOMPUTE_FAILED: '保存的預測與固定模型重算結果不一致',
  CALIBRATION_VALIDATION_RESULT_SCOPE_INVALID: '賽果與原預測的場次或球隊未通過配對',
  CALIBRATION_DURABLE_FREEZE_NOT_VERIFIED: '模型封存憑據未通過核對',
  CALIBRATION_PREGAME_DATABASE_RECEIPT_NOT_VERIFIED: '賽前預測保存憑據未通過核對',
  RESULT_NORMAL_FINAL_UNCONFIRMED: '尚未確認正常完賽',
};
export function calibrationCheckReasons(report) {
  const v=report?.validation;
  if(v?.checkReasonUnit!=='CHECKS_AND_VALIDATION_RECORDS_NOT_UNIQUE_GAMES'
    ||!v.checkReasons||typeof v.checkReasons!=='object'||Array.isArray(v.checkReasons))return [];
  return Object.entries(v.checkReasons).filter(([code,n])=>/^(?:CALIBRATION|RESULT)_[A-Z0-9_]{1,100}$/.test(code)
    &&count(n)&&n>0).slice(0,100).map(([code,n])=>({code,count:n,label:reasonLabels[code]||'此項校準檢查未通過'}));
}
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

// Display-only aggregation. Every page has already replayed all source history
// for its capture. No aggregate is submitted as a model acceptance artifact.
export function mergeCalibrationReportPage(previous, report, afterSequence) {
  const page=report.validationPage, coverage=report.validationCoverage, value=report.validation;
  const invalid=()=>{throw Error('校準分批核對範圍不一致，筆數未知。');};
  if (!page || page.afterSequence!==afterSequence || !hash(page.revision)
    || typeof page.complete!=='boolean' || typeof page.reachedEnd!=='boolean'
    || (page.nextSequence!==null && !/^[1-9]\d{0,17}$/.test(page.nextSequence))
    || page.reachedEnd !== (page.nextSequence===null) || page.reachedEnd && !page.complete
    || page.complete && !page.reachedEnd && BigInt(page.nextSequence)<=BigInt(afterSequence)
    || !coverage || !count(coverage.readResultCheckRows) || !count(report.quarantinedGames)
    || !value || !count(value.untouchedVerifiedGames) || value.untouchedVerifiedGames!==report.untouchedValidatedGames
    || report.quarantinedGames+report.untouchedValidatedGames>coverage.readCaptures
    || !page.complete && coverage.readCaptures!==0) invalid();
  if (previous ? previous.validationPage.revision!==page.revision || previous.validationPage.nextSequence!==afterSequence
    || previous.league!==report.league || previous.captureGames!==report.captureGames
    || JSON.stringify(previous.freeze)!==JSON.stringify(report.freeze)
    : afterSequence!=='0') invalid();
  const readCaptures=(previous?.validationCoverage.readCaptures||0)+coverage.readCaptures;
  if (readCaptures>report.captureGames || page.reachedEnd && readCaptures!==report.captureGames) invalid();
  const merged={...value,checkReasons:{...(previous?.validation.checkReasons||{})},before:{},after:{}};
  for(const [key,n]of Object.entries(value.checkReasons||{})){
    if(!count(n))invalid();merged.checkReasons[key]=(merged.checkReasons[key]||0)+n;
  }
  for(const arm of ['before','after'])for(const period of ['FT','HT']){
    const left=previous?.validation[arm]?.[period],right=value[arm]?.[period];
    if(!right || right.games!==report.untouchedValidatedGames)invalid();
    const a=left?.games||0,b=right.games,games=a+b,metric={games};
    for(const key of ['scoreLogLoss','logLoss','brier']){
      const state=key==='brier'?null:`${key}State`,infinite=state&&[left?.[state],right[state]].includes('POSITIVE_INFINITY');
      if(b && !(state&&right[state]==='POSITIVE_INFINITY') && !Number.isFinite(right[key]))invalid();
      metric[key]=!games||infinite?null:((a?left[key]*a:0)+(b?right[key]*b:0))/games;
      if(state)metric[state]=!games?'UNAVAILABLE':infinite?'POSITIVE_INFINITY':'FINITE';
    }
    merged[arm][period]=metric;
  }
  const verified=(previous?.untouchedValidatedGames||0)+report.untouchedValidatedGames;
  const quarantined=(previous?.quarantinedGames||0)+report.quarantinedGames;
  return {...report,untouchedValidatedGames:verified,fullTimeValidatedGames:verified,halfTimeValidatedGames:verified,
    quarantinedGames:quarantined,pendingValidationGames:report.captureGames-verified-quarantined,
    validationStatus:!page.reachedEnd?'PARTIAL_HISTORY_READ':quarantined?'CONFLICTS_QUARANTINED':verified?'PROSPECTIVE_OBSERVATIONS_AVAILABLE':report.captureGames?'PENDING_RESULTS':'AWAITING_PREGAME_CAPTURES',
    validationCoverage:{...coverage,readCaptures,readResultCheckRows:(previous?.validationCoverage.readResultCheckRows||0)+coverage.readResultCheckRows,completeWithinRequestedScope:page.reachedEnd},
    validation:{...merged,untouchedVerifiedGames:verified,quarantinedGames:quarantined,completeWithinRequestedScope:page.reachedEnd}};
}

export function SoccerCalibrationShadowPanel({ league }) {
  const supported = ['epl', 'ucl'].includes(league);
  const [collection, setCollection] = useState(null);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState({ league: '', loading: true, report: null, error: '' });
  const [evaluating, setEvaluating] = useState(false);
  const evaluationScope = useRef(null);
  useEffect(() => {
    const scope = { league, active: true, request: null };
    evaluationScope.current = scope;
    setEvaluating(false);
    setCollection(null);
    return () => {
      scope.active = false;
      if (scope.request) { clearTimeout(scope.request.timer); scope.request.controller.abort(); }
      if (evaluationScope.current === scope) evaluationScope.current = null;
    };
  }, [league, supported]);
  useEffect(() => {
    if (!supported) return;
    let active = true;
    const controller = new AbortController(); let timer;
    setState({ league, loading: true, report: null, error: '' });
    (async()=>{
      let afterSequence='0',aggregate=null,restarts=0;
      while(active){
        timer=setTimeout(()=>controller.abort(),25000);
        const params=new URLSearchParams({league,page:'1',afterSequence});
        if(aggregate)params.set('revision',aggregate.validationPage.revision);
        const response=await fetch(`/api/soccer/calibration-shadow?${params}`,{cache:'no-store',signal:controller.signal});
        const body = await response.json();
        clearTimeout(timer);
        if(!active)return;
        if(response.status===409 && body.code==='CALIBRATION_HISTORY_CHANGED_DURING_READ' && restarts++<1){
          afterSequence='0';aggregate=null;setState({league,loading:true,report:null,error:''});continue;
        }
        if (!response.ok || body.ok !== true) throw Error(response.status === 401 ? '登入已過期，請重新登入。' : body.error || '校準預測保存狀態暫時無法讀取。');
        if (!calibrationShadowReportValid(body.report, league)) throw Error('校準預測保存狀態尚未通過核對，筆數未知。');
        if(!body.report.validationPage){setState({league,loading:false,report:body.report,error:''});return;}
        aggregate=mergeCalibrationReportPage(aggregate,body.report,afterSequence);
        const continuing=body.report.validationPage.complete && !body.report.validationPage.reachedEnd;
        setState({league,loading:continuing,report:aggregate,error:''});
        if(!continuing)return;
        afterSequence=body.report.validationPage.nextSequence;
      }
    })().catch(error => {
        if (active) setState({ league, loading: false, report: null, error: error.name === 'AbortError' ? '校準預測保存狀態讀取逾時，筆數未知。' : error.message });
      }).finally(() => clearTimeout(timer));
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [league, supported, revision]);
  async function evaluate(action = 'evaluate') {
    const scope = evaluationScope.current;
    if (evaluating || !supported || !scope?.active || scope.league !== league || scope.request) return;
    setEvaluating(true);
    if (action === 'collect') setCollection(null);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), action === 'collect' ? 85000 : 28000);
    const request = { controller, timer };
    scope.request = request;
    const currentRequest = () => evaluationScope.current === scope && scope.active && scope.request === request;
    try {
      const response = await fetch('/api/soccer/calibration-shadow', { method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ league, action }) });
      const body = await response.json();
      if (!response.ok || body.ok !== true) throw Error(response.status === 401 ? '登入已過期，請重新登入。' : body.error || '校準預測賽果暫時無法核對。');
      if (currentRequest()) {
        if (action === 'collect') {
          if (body.summary?.league !== league || body.summary.formalEligible !== false || body.summary.executable !== false
            || !['capturedGames','alreadyCapturedGames','deferredGames','failedGames','scheduleFailures'].every(key => count(body.summary[key])))
            throw Error('補存結果尚未通過核對，請重新讀取保存狀態。');
          setCollection(body.summary);
        }
        setRevision(value => value + 1);
      }
    } catch (error) {
      if (currentRequest()) setState({ league, loading: false, report: null, error: error.name === 'AbortError' ? '校準預測賽果核對逾時，請重新讀取保存狀態。' : error.message });
    } finally {
      clearTimeout(timer);
      if (currentRequest()) { scope.request = null; setEvaluating(false); }
    }
  }
  if (!supported) return null;
  const current = state.league === league, report = current ? state.report : null;
  return <section aria-label="校準候選前瞻保存" className="soccerCalibrationShadow">
    <h3>校準候選前瞻保存</h3>
    <p>系統每小時補存未來 24 小時內尚未開賽的全場與上半場校準預測，不需等待 Reader 盤口。每批最多兩場，後續批次接續；已保存的預測不會覆寫。手動分析也會保存預測。</p>
    <button type="button" className="secondary" disabled={!current || state.loading || evaluating} onClick={() => setRevision(value => value + 1)}>更新保存狀態</button>{' '}
    <button type="button" className="secondary" disabled={!current || state.loading || evaluating} onClick={() => evaluate('collect')}>補存未開賽預測</button>{' '}
    <button type="button" className="secondary" disabled={!current || state.loading || evaluating || !report?.freeze} onClick={() => evaluate()}>{evaluating ? '處理中…' : '核對校準預測賽果'}</button>
    {collection?.league === league && <p role="status">本批新增 {collection.capturedGames} 場｜原已保存 {collection.alreadyCapturedGames} 場｜待接續 {collection.deferredGames} 場｜未成功 {collection.failedGames} 場。{collection.scheduleFailures > 0 ? '部分賽程讀取失敗，涵蓋範圍尚未完整。' : ''}</p>}
    {(!current || state.loading) && <p role="status">{report ? '正在接續核對下一批校準預測…' : '正在讀取校準預測保存狀態…'}</p>}
    {current && state.error && <p role="alert">{state.error}</p>}
    {report && <>
      {report.validationCoverage?.completeWithinRequestedScope === false && <p role="status">賽果核對尚未讀完，已讀 {report.validationCoverage.readCaptures}／{report.validationCoverage.totalCaptures} 場；核對筆數僅代表已讀範圍。</p>}
      <p>不同賽事 {report.captureGames} 場｜全場預測 {report.fullTimeCaptures} 筆｜上半場預測 {report.halfTimeCaptures} 筆｜{report.validationCoverage?.completeWithinRequestedScope === false ? '已讀範圍核對賽果' : '已核對前瞻賽果'} {report.untouchedValidatedGames} 場。</p>
      {calibrationCheckReasons(report).length>0&&<details className="soccerDetails"><summary>校準查核尚未通過的原因</summary>
        <p>以下計數為查核紀錄，包含歷次未通過紀錄，不等於不同賽事數，也不代表目前有效樣本已被排除。</p>
        <ul>{calibrationCheckReasons(report).map(row=><li key={row.code}>{row.label}：{row.count} 筆（{row.code}）</li>)}</ul>
      </details>}
      {count(report.quarantinedGames) && report.quarantinedGames > 0 && <p className="soccerAvailability">賽果衝突隔離 {report.quarantinedGames} 場，未列入已核對樣本。</p>}
      <p className="soccerAvailability">{report.freeze ? `方案封存：${time(report.freeze.frozenAt)}。` : '方案會在首次補存或分析時封存，只保存封存後的未開賽預測。'}{report.latestCapturedAt ? `最近保存：${time(report.latestCapturedAt)}。` : '尚無符合本方案的賽前預測。'}</p>
      <p className="soccerAvailability">已保存的預測筆數不等於模型驗收通過；正式評分仍須完成原盤規則、人員模型與收益誤差驗證。</p>
    </>}
  </section>;
}
