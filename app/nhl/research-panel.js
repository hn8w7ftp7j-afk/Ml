'use client';

const number = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 6 }) : '—';
const percent = value => typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : '—';
function Stat({ label, value }) { return <div className="nhlStat"><span>{label}</span><strong>{number(value)}</strong></div>; }
function Reliability({ rows, predictedKey = 'predicted', observedKey = 'observed' }) {
  return <div className="nhlTableWrap"><table className="nhlTable"><thead><tr><th>機率區間</th><th>樣本</th><th>平均預測</th><th>實際發生率</th></tr></thead><tbody>{(rows || []).filter(row => row.count > 0).map(row => <tr key={row.lower}><td>{percent(row.lower)}–{percent(row.upper)}</td><td>{row.count}</td><td>{percent(row[predictedKey])}</td><td>{percent(row[observedKey])}</td></tr>)}</tbody></table></div>;
}

export default function NhlResearchPanel({ history, shots }) {
  const coverage = history?.coverage;
  const benchmark = history?.benchmark;
  const model = history?.model;
  return <>
    <section className="panel" aria-label="完整球季歷史驗證"><h3>完整球季資料與時間序列驗證</h3>
      {!history?.ok ? <p className="nhlWarning">完整球季驗證報告目前未能載入：{history?.code || '尚未取得'}。下方小樣本不能代替完整球季驗證。</p> : <>
        <p className="nhlNote">賽季 {coverage.season}｜{coverage.completeOfficialRecordedRegularSeasonCoverage ? '官方例行賽比分覆蓋核對完成' : '官方例行賽比分尚有缺漏'}。比分覆蓋、逐節模型與人員資料覆蓋分開判定。</p>
        <div className="nhlStats"><Stat label="官方例行賽場數" value={coverage.requestedRegularGames}/><Stat label="已核對例行賽" value={coverage.acquiredRegularOutcomes}/><Stat label="已取得球隊賽程" value={coverage.acquiredTeams}/><Stat label="完整逐節資料" value={model?.completePeriodGames}/></div>
        <p className="nhlNote">{history.message} 隔離 48 小時結果可得窗口；同時開賽與未到訓練截止時間的比賽不進入訓練。</p>
        <div className="nhlTableWrap"><table className="nhlTable"><thead><tr><th>分區</th><th>場次</th><th>REG</th><th>OT</th><th>Shootout</th></tr></thead><tbody>{Object.entries(coverage.phases || {}).map(([key, value]) => <tr key={key}><td>{key === 'REGULAR' ? '例行賽' : key === 'PLAYOFFS' ? '季後賽（分開驗證）' : '季前賽（Shadow，不混入訓練）'}</td><td>{number(value.games)}</td><td>{number(value.outcomes?.REG)}</td><td>{number(value.outcomes?.OT)}</td><td>{number(value.outcomes?.SO)}</td></tr>)}</tbody></table></div>
        <h4>比分基準分布｜歷史校準診斷</h4><p className="nhlNote">只用先前比賽結果的基準分布，用於比較與數學 QA；不是已認證的 NHL 預測模型。</p>
        <div className="nhlTableWrap"><table className="nhlTable"><thead><tr><th>驗證範圍</th><th>場次</th><th>聯合比分 Brier</th><th>比分平方誤差</th></tr></thead><tbody>{[['逐場 Walk-forward', benchmark?.walkForward], ['固定訓練後驗證集', benchmark?.fixedHoldout?.validation], ['未參與調參保留集', benchmark?.fixedHoldout?.untouchedTest], ['既有 NHL 逐節模型', model]].map(([label, value]) => <tr key={label}><td>{label}</td><td>{number(value?.folds)}</td><td>{number(value?.regulationBrier)}</td><td>{number(value?.regulationSquaredError)}</td></tr>)}</tbody></table></div>
        <p className="nhlNote">固定訓練截止 {benchmark?.fixedHoldout?.validationCutoff}；保留測試起點 {benchmark?.fixedHoldout?.testCutoff}。Brier／平方誤差越低越好，不把單一數字自動標為模型 PASS。</p>
        <details><summary>保留集主隊正規時間勝率校準分箱</summary><Reliability rows={benchmark?.fixedHoldout?.untouchedTest?.reliability}/></details>
        <details><summary>逐隊覆蓋與來源證據</summary><div className="nhlTableWrap"><table className="nhlTable"><thead><tr><th>球隊</th><th>官方場數</th><th>已核對</th><th>核對</th></tr></thead><tbody>{coverage.teamCoverage?.map(row => <tr key={row.teamId}><td>{row.abbrev}（{row.teamId}）</td><td>{number(row.officialRecordedGames)}</td><td>{number(row.acquiredRegularOutcomes)}</td><td>{row.matchesOfficialRecordedGames ? '相符' : '有缺漏'}</td></tr>)}</tbody></table></div><p className="nhlSource">{coverage.registrySource?.url && <a href={coverage.registrySource.url} target="_blank" rel="noreferrer">官方球隊場數依據</a>}<br/>資料版本 {coverage.outcomeCorpusHash}</p></details>
        <details><summary>逐節模型驗證範圍</summary><pre>{JSON.stringify(model, null, 2)}</pre></details>
        <p className="nhlWarning nhlNote">完整歷史比分不代表擁有當時的傷病、陣容與確認門將快照。嚴格賽前人員 PIT、正式模型校準認證及 Tai888 歷史投注驗證仍分別保留未通過狀態。</p>
      </>}
    </section>
    <section className="panel" aria-label="射門 xG 研究"><h3>官方射門座標｜獨立 xG 研究</h3>
      {!shots ? <p className="nhlNote">尚未載入已保存的射門研究。</p> : <>
        <p className="nhlNote">依實際發生的未被封阻射門位置與情境估計進球機率。這是事後射門品質研究，不是賽前射門量、比分或投注推薦；不使用該次射門是否進球作為輸入特徵。</p>
        <div className="nhlStats"><Stat label="目標例行賽" value={shots.requestedGames}/><Stat label="已取得事件回應" value={shots.retainedOfficialResponses}/><Stat label="研究資料場次" value={shots.coverageGameCount}/></div>
        <p className={shots.completeSeasonCoverage ? 'nhlNote' : 'nhlNote nhlWarning'}>{shots.completeSeasonCoverage ? '全季來源與事件 QA 覆蓋核對完成。' : '全季事件 QA 尚未完全通過；取得回應不等於全部可用，缺漏及矛盾資料另列。'} 報告更新 {shots.generatedAt}。</p>
        <div className="nhlTableWrap"><table className="nhlTable"><thead><tr><th>情境</th><th>資料場數</th><th>驗證場次</th><th>保留射門</th><th>Brier</th><th>基準 Brier</th><th>Log loss</th></tr></thead><tbody>{Object.entries(shots.reports || {}).map(([key, value]) => <tr key={key}><td>{key}</td><td>{number(value.corpusGames)}</td><td>{number(value.foldCount)}</td><td>{number(value.evaluatedShots)}</td><td>{number(value.brier)}</td><td>{number(value.baselineBrier)}</td><td>{number(value.logLoss)}</td></tr>)}</tbody></table></div>
        <p className="nhlNote">5v5、PP、PK、其他均勢分開評估；空門、Shootout、點球與無法核對事件不混用。樣本不足顯示「—」，結果比基準差也照實保留。</p>
        {Object.entries(shots.reports || {}).map(([key, value]) => <details key={key}><summary>{key}｜校準分箱及最近驗證場次</summary><Reliability rows={value.reliability} predictedKey="meanProbability" observedKey="observedGoalRate"/><div className="nhlTableWrap"><table className="nhlTable"><thead><tr><th>Game ID</th><th>客 xGF／xGA</th><th>主 xGF／xGA</th><th>客 xGF%</th><th>覆蓋射門</th></tr></thead><tbody>{(value.folds || []).slice(-10).map(row => <tr key={row.gameId}><td>{row.gameId}</td><td>{number(row.teamResearch?.[0]?.researchXGF)}／{number(row.teamResearch?.[0]?.researchXGA)}{row.teamResearch?.[0] && <small>（球隊 {row.teamResearch[0].teamId}）</small>}</td><td>{number(row.teamResearch?.[1]?.researchXGF)}／{number(row.teamResearch?.[1]?.researchXGA)}{row.teamResearch?.[1] && <small>（球隊 {row.teamResearch[1].teamId}）</small>}</td><td>{percent(row.teamResearch?.[0]?.researchXGFShare)}</td><td>{number(row.testedShots)}</td></tr>)}</tbody></table></div><p className="nhlNote">xGF／xGA 只涵蓋通過 QA 的實際射門；不當成完整比賽的官方 xG，也不推算每 60 分鐘或 High-Danger 定義。</p></details>)}
        <details><summary>射門來源覆蓋與未通過項目</summary><pre>{JSON.stringify({ ...shots, reports: undefined }, null, 2)}</pre></details>
      </>}
    </section>
  </>;
}
