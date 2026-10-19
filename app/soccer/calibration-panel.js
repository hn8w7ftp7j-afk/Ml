'use client';

const outcomeNames={home:'主勝',draw:'和局',away:'客勝'};
const periodNames={FT:'全場',HT:'上半場'};
const periodCodes={FT:'REGULATION_FT',HT:'REGULATION_HT'};
const count=value=>Number.isInteger(value)&&value>=0?String(value):'未知';
const metric=value=>Number.isFinite(value)&&value>=0?value.toFixed(4):'—';
const pct=value=>Number.isFinite(value)&&value>=0&&value<=1?`${(value*100).toFixed(1)}%`:'—';
const reasonNames={
  INVALID_PROBABILITIES:'預估機率未通過檢查',
  MISSING_OUTCOME:'缺少可核對比分',
  INVALID_OUTCOME:'比分未通過檢查',
  DUPLICATE_GAME:'重複賽事',
  LEAGUE_MISMATCH:'聯賽範圍不符',
  PERIOD_MISMATCH:'比賽期間不符',
  MODEL_MISMATCH:'模型版本不符',
};
function binRange(bin){
  if(!Number.isFinite(bin?.lower)||!Number.isFinite(bin?.upper))return '區間待核對';
  return `${(bin.lower*100).toFixed(0)}–${bin.upperInclusive?'':'<'}${(bin.upper*100).toFixed(0)}%`;
}

/** Display a frozen audit only. This component never calibrates or changes predictions. */
export function SoccerCalibrationPanel({audit,period='FT',league,label='',evidenceMode='RETROSPECTIVE'}){
  const name=periodNames[period]||'期間待核對';
  const compatible=audit&&audit.period===periodCodes[period]&&(!league||audit.league===league)&&audit.classes&&audit.cohort;
  const cohort=compatible?audit.cohort:null;
  const coverage=cohort&&Number.isInteger(cohort.sample)&&cohort.sample>0&&Number.isInteger(cohort.used)?cohort.used/cohort.sample:null;
  return <details className="soccerDetails soccerCalibration"><summary>{label?`${label}｜`:''}{name}勝平負校準核對</summary>
    {compatible?<>
      <p className="soccerCalibrationScope">可評估 {count(cohort.used)}／{count(cohort.sample)} 筆（{pct(coverage)}）；排除 {count(cohort.excluded)} 筆。原始不同賽事 {count(cohort.uniqueGames)} 場；可評估不同賽事 {count(cohort.usedUniqueGames)} 場。</p>
      {cohort.duplicateRecords>0&&<p className="soccerAvailability">含重複賽事紀錄 {count(cohort.duplicateRecords)} 筆；樣本數不等同獨立比賽數。</p>}
      <p className="soccerAvailability">主勝、和局、客勝各自核對；同一場的三種結果不計為三場比賽。少樣本分箱的實際比例波動較大。</p>
      {Array.isArray(cohort.reasons)&&cohort.reasons.length>0&&<details className="soccerDetails"><summary>排除原因</summary><ul>{cohort.reasons.map((reason,index)=><li key={`${reason.code}-${index}`}>{typeof reason.label==='string'&&reason.label.trim()?reason.label:reasonNames[reason.code]||'資料或範圍未通過檢查'}：{count(reason.count)} 筆<small className="soccerCalibrationReasonCode">{reason.code}</small></li>)}</ul></details>}
      <div className="soccerTableWrap"><table className="soccerAuditTable soccerCalibrationTable"><caption>{name}分事件校準指標</caption><thead><tr><th scope="col">事件</th><th scope="col">樣本數</th><th scope="col">ECE（絕對差）</th><th scope="col">REL（平方差）</th></tr></thead><tbody>{Object.entries(outcomeNames).map(([key,title])=>{
        const value=audit.classes[key];
        return <tr key={key}><th scope="row">{title}</th><td>{count(value?.count)}</td><td>{metric(value?.ECE_L1)}</td><td>{metric(value?.REL_L2)}</td></tr>;
      })}</tbody></table></div>
      {Object.entries(outcomeNames).map(([key,title])=>{
        const value=audit.classes[key],bins=Array.isArray(value?.bins)?value.bins:[];
        return <details className="soccerDetails soccerCalibrationClass" key={key}><summary>{title}｜分箱預估與實際比例</summary>
          <p className="soccerAvailability">可評估 {count(value?.count)} 筆，其中實際{title} {count(value?.positiveCount)} 筆。空分箱不填 0% 結果。</p>
          {bins.length>0?<div className="soccerTableWrap"><table className="soccerAuditTable soccerCalibrationTable"><caption>{name}{title}分箱</caption><thead><tr><th scope="col">預測區間</th><th scope="col">樣本數</th><th scope="col">平均預估</th><th scope="col">實際比例</th></tr></thead><tbody>{bins.map((bin,index)=><tr key={bin.index??index}><th scope="row">{binRange(bin)}</th><td>{count(bin.count)}</td><td>{bin.count>0?pct(bin.meanPredicted):'—'}</td><td>{bin.count>0?pct(bin.observedFrequency):'—'}</td></tr>)}</tbody></table></div>:<p className="soccerAvailability">尚無分箱資料。</p>}
        </details>;
      })}
      <p className="soccerAvailability">ECE 以 0–1 機率的絕對差表示；REL 是該差的平方，兩欄不可當成相同百分比單位。ECE_L1 與 REL_L2 是原始分箱估計，尚未去偏，也不等於完整 Brier 分解；跨入選比例的比較仍須處理樣本與選擇差異。</p>
    </>:<p className="soccerAvailability">此版本尚無可核對的分事件校準資料；不以主勝、和局與客勝混合後的分箱代替。</p>}
    <p className="soccerCalibrationCaution">{evidenceMode==='PROSPECTIVE'?'資料來自開賽前已封存的預測與賽後核對；樣本有限，尚未完成模型放行。不代表正式驗收通過、下注勝率提高或正收益。':'資料為事後回補的研究診斷，尚未證明歷史賽前可取得性；不代表正式驗收通過、下注勝率提高或正收益。'}</p>
  </details>;
}
