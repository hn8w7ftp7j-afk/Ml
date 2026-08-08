from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected one match, found {count}')
    return text.replace(old, new, 1)

path = Path('app/page.js')
text = path.read_text()
text = text.replace("const VERSION = '7.1.0';", "const VERSION = '7.2.0';")
old_batch = '''      {latestBatchRows.length > 0 && <div className="card">
        <h2>本次上傳：全部盤口評分總覽</h2>
        <p className="note">已自動完成 {latestBatchLocks.length} 場；下方先依評分由高到低一次列出所有實際開盤方向，再顯示各場完整分析。</p>
        <div className="portfolio">{latestBatchRows.map(({ lock, result }, index) => <div className="portfolioRow" key={`${lock.id}-${result.market}-${result.pick}-${index}`}>
          <b>{result.score == null ? '—' : result.score.toFixed(1)}</b>
          <span>{matchup(lock.game)}｜{result.market}｜{translateTeamText(result.pick)}</span>
          <strong>{result.tag}</strong>
          <span>{result.water == null ? '水位未提供' : Number(result.water).toFixed(3)}{result.waterEstimated ? ' 暫估' : ''}</span>
        </div>)}</div>
        {batchReport?.issues?.length > 0 && <div className="warnings"><b>需核對項目</b>{batchReport.issues.slice(0, 12).map(item => <div key={item}>• {item}</div>)}</div>}
      </div>}'''
new_batch = '''      {latestBatchRows.length > 0 && <div className="batchStrip">
        <div><span>本次分析完成</span><b>{latestBatchLocks.length} 場</b></div>
        <div><span>最高評分</span><b>{Math.max(...latestBatchRows.map(row => Number(row.result.score) || 0)).toFixed(1)}</b></div>
        <div><span>下注候選</span><b>{latestBatchRows.filter(row => Number(row.result.score) >= store.settings.candidateThreshold && row.result.betEligible).length}</b></div>
      </div>}'''
text = replace_once(text, old_batch, new_batch, 'compact batch strip')
old_analysis_body = '''            <Context context={data.context} analysis={data.analysis}/><AlignmentAudit audit={data.analysis.alignmentAudit}/>
            {data.analysis.portfolio?.length > 0 && <div className="market"><h3>同場主選／次選與總曝險</h3><div className="portfolio">{data.analysis.portfolio.map((row, index) => <div className="portfolioRow" key={`${row.market}-${row.pick}`}><b>{index + 1}</b><span>{row.role}｜{row.market}｜{translateTeamText(row.pick)}</span><strong>{row.score.toFixed(1)}</strong><span>{row.recommendedUnit} Unit{index > 0 ? `｜與主選相關 ${pct(row.correlationToPrimary)}` : ''}</span></div>)}</div></div>}
            {MARKET_ORDER.map(market => {
              const rows = data.analysis.results.filter(result => result.market === market).sort((left, right) => (right.score ?? -1) - (left.score ?? -1));
              return <div className="market results" key={market}><h3>{market}</h3>{!rows.length ? <Empty text="未開盤"/> : rows.map((result, index) => <ResultCard key={`${result.pick}-${index}`} result={result} analysis={data.analysis} game={lock.game} settings={store.settings} onBet={() => addBet(lock.game, result, data.analysis)}/>)}</div>;
            })}'''
new_analysis_body = '''            <div className="starterLine">先發：{data.context?.away?.starter?.name || lock.game?.awayProbable || '未公布'} 對 {data.context?.home?.starter?.name || lock.game?.homeProbable || '未公布'}</div>
            {MARKET_ORDER.map(market => {
              const rows = data.analysis.results.filter(result => result.market === market).sort((left, right) => (right.score ?? -1) - (left.score ?? -1));
              return <div className="classicMarket" key={market}><h3>{market}</h3>{!rows.length ? <div className="unopened">未開盤</div> : rows.map((result, index) => <ClassicResultRow key={`${result.pick}-${index}`} result={result} settings={store.settings} onBet={() => addBet(lock.game, result, data.analysis)}/>)}</div>;
            })}
            <details className="analysisDetails"><summary>查看完整分析細節</summary><Context context={data.context} analysis={data.analysis}/><AlignmentAudit audit={data.analysis.alignmentAudit}/>{data.analysis.portfolio?.length > 0 && <div className="market"><h3>同場主選／次選與總曝險</h3><div className="portfolio">{data.analysis.portfolio.map((row, index) => <div className="portfolioRow" key={`${row.market}-${row.pick}`}><b>{index + 1}</b><span>{row.role}｜{row.market}｜{translateTeamText(row.pick)}</span><strong>{row.score.toFixed(1)}</strong><span>{row.recommendedUnit} Unit{index > 0 ? `｜與主選相關 ${pct(row.correlationToPrimary)}` : ''}</span></div>)}</div></div>}</details>'''
text = replace_once(text, old_analysis_body, new_analysis_body, 'classic game results')
marker = '''      })}
    </section>}

    {tab === 'bets' &&'''
candidate = '''      })}
      {latestBatchRows.some(row => Number(row.result.score) >= store.settings.candidateThreshold && row.result.betEligible) && <div className="card candidateList"><h2>今日下注候選</h2><p className="note">只列本次上傳中達 {store.settings.candidateThreshold.toFixed(1)} 分以上且可進下注池的方向。</p>{latestBatchRows.filter(row => Number(row.result.score) >= store.settings.candidateThreshold && row.result.betEligible).map(({ lock, result }, index) => <div className={`candidateRow ${Number(result.score) >= store.settings.strongestThreshold ? 'strongestRow' : ''}`} key={`${lock.id}-${result.market}-${result.pick}-${index}`}><b>{Number(result.score).toFixed(1)}</b><span>{matchup(lock.game)}｜{result.market}｜{translateTeamText(result.pick)}｜{Number(result.water).toFixed(3)}</span><strong>{Number(result.score) >= store.settings.strongestThreshold ? '最強主推' : '下注候選'}</strong></div>)}</div>}
      {batchReport?.issues?.length > 0 && <details className="card analysisDetails"><summary>本次辨識需核對 {batchReport.issues.length} 項</summary><div className="warnings">{batchReport.issues.slice(0, 12).map(item => <div key={item}>• {item}</div>)}</div></details>}
    </section>}

    {tab === 'bets' &&'''
text = replace_once(text, marker, candidate, 'candidate list')
component_marker = 'function ResultCard({ result, analysis, settings, onBet }) {'
classic_component = r'''function ClassicResultRow({ result, settings, onBet }) {
  const score = Number.isFinite(Number(result.score)) ? Number(result.score) : null;
  const strongest = score != null && score >= settings.strongestThreshold && result.betEligible;
  const candidate = score != null && score >= settings.candidateThreshold && result.betEligible;
  const icon = strongest ? '🟡' : candidate ? '🟢' : '⚪';
  const unit = result.portfolioUnit || result.unitSuggestion || 0;
  return <div className={`classicResult ${strongest ? 'classicStrongest' : candidate ? 'classicCandidate' : ''}`}>
    <div className="classicPrimary"><span className="classicIcon">{icon}</span><b className="classicScore">{score == null ? '—' : score.toFixed(1)}</b><span className="classicPick">｜{translateTeamText(result.pick)}｜{result.water == null ? '水位未提供' : Number(result.water).toFixed(3)}{result.waterEstimated ? ' 暫估' : ''}</span>{strongest && <span className="classicTag">最強主推</span>}{candidate && !strongest && <span className="classicTag">下注候選</span>}</div>
    {score != null && <div className="classicMeta">穩健 EV {pct(result.robustEV)}｜建議 {unit} Unit</div>}
    {result.betEligible && <button className="classicBet" onClick={onBet}>記錄下注</button>}
  </div>;
}

'''
text = replace_once(text, component_marker, classic_component + component_marker, 'classic result component')
path.write_text(text)

path = Path('app/globals.css')
css = path.read_text()
css += r'''

/* 7.2 classic compact analysis results */
.batchStrip{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin:13px 0}.batchStrip>div{background:#0c1a2b;border:1px solid #213a56;border-radius:13px;padding:12px 14px}.batchStrip span{display:block;color:#849bb4;font-size:11px}.batchStrip b{display:block;font-size:20px;margin-top:3px}.starterLine{color:#a9bed2;font-size:13px;margin:-3px 0 12px}.classicMarket{border-top:1px solid #263f5b;padding-top:13px;margin-top:10px}.classicMarket h3{font-size:15px;margin:0 0 6px;color:#dcecff}.classicResult{position:relative;padding:9px 90px 9px 2px;border-top:1px solid rgba(50,75,101,.45);min-height:50px}.classicResult:first-of-type{border-top:0}.classicPrimary{display:flex;align-items:center;min-width:0;line-height:1.45}.classicIcon{font-size:13px;width:22px;flex:0 0 22px}.classicScore{font-size:19px;min-width:34px}.classicPick{font-size:14px;font-weight:700;overflow-wrap:anywhere}.classicTag{margin-left:8px;border-radius:999px;padding:3px 7px;font-size:10px;background:#15334f;color:#acd8fa;white-space:nowrap}.classicMeta{margin:3px 0 0 56px;color:#7f98b1;font-size:11px}.classicBet{position:absolute;right:0;top:10px;background:#15314d;color:#eef6ff;border:1px solid #315579;border-radius:8px;padding:7px 8px;font-size:11px}.classicCandidate .classicScore{color:#83e2b0}.classicStrongest .classicScore{color:#ffd071}.unopened{color:#738ba3;font-size:12px;padding:3px 0 8px}.analysisDetails{margin-top:15px;border-top:1px solid #29445f;padding-top:12px}.analysisDetails summary{cursor:pointer;color:#8fb4d6;font-size:12px;font-weight:700;list-style:none}.analysisDetails summary::-webkit-details-marker{display:none}.analysisDetails summary:after{content:' ▼';font-size:9px}.analysisDetails[open] summary:after{content:' ▲'}.candidateList{margin-top:18px}.candidateRow{display:grid;grid-template-columns:48px 1fr auto;gap:8px;align-items:center;padding:10px 0;border-top:1px solid #263f5b}.candidateRow:first-of-type{border-top:0}.candidateRow>b{font-size:20px;color:#83e2b0}.candidateRow span{font-size:13px}.candidateRow strong{font-size:11px;color:#8be1b3}.strongestRow>b,.strongestRow strong{color:#ffd071}
@media(max-width:620px){.batchStrip{grid-template-columns:repeat(3,1fr)}.batchStrip>div{padding:10px}.batchStrip b{font-size:18px}.classicResult{padding-right:0}.classicBet{position:static;margin:7px 0 0 56px}.classicTag{display:none}.candidateRow{grid-template-columns:42px 1fr}.candidateRow strong{grid-column:2}.candidateRow span{font-size:12px}}
'''
path.write_text(css)

path = Path('app/api/health/route.js'); text = path.read_text().replace("version: '7.1.0'", "version: '7.2.0'"); path.write_text(text)
path = Path('package.json'); text = path.read_text().replace('"version": "7.1.0"', '"version": "7.2.0"'); path.write_text(text)
Path('DEPLOYMENT_VERSION').write_text('7.2.0-classic-compact-results\n')
path = Path('README.md'); text = path.read_text().replace('# MLB 長期正期望值分析｜第 7.1.0 版', '# MLB 長期正期望值分析｜第 7.2.0 版', 1); text += '''\n\n### 7.2.0 經典分析結果顯示\n\n保留 7.1 的一次上傳全部自動分析流程，但結果頁回到原本每日 GPT 分析的閱讀方式：先顯示簡短完成摘要，再逐場依全場讓分、全場大小、上半讓分、上半大小列出「評分｜方向＋盤口｜水位」。第一層只補充穩健 EV 與 Unit；完整 GPT、情境、資料來源與風險改為點擊展開。最後另列本次 7.2 分以上的下注候選。\n'''; path.write_text(text)
print('classic results v7.2 applied')
