import quarterAudit from '../../docs/nba-quarter-validation.json';
import audit from '../../data/four-league-validation-20261006.json';
import { APP_VERSION } from '../../lib/app-version.js';
import {openingTotalsV6Independent,openingTotalsV6Development} from '../../lib/nba/opening-totals-v6-evidence.js';

export const metadata = { title: '四聯盟模型驗證｜Sports Analysis' };
const pct = value => value == null ? '尚無可比樣本' : `${(value * 100).toFixed(2)}%`;
export default function ModelValidationPage() {
  return <main><header className="topbar"><div><div className="eyebrow">MODEL VALIDATION</div><h1>日棒、韓棒、台棒與 NBA 驗證</h1></div><span className="version">v{APP_VERSION}</span></header>
    <div style={{margin: '24px 0'}}><a className="secondary" href="/">回到分析主站</a></div>
    <section className="panel"><h2>目前尚未全部通過完整驗證</h2><p>功能上線、歷史重播與新比賽驗證是三個不同階段。下表只列保存原盤口與可核對賽前資料的樣本；不把缺資料的場次當成有效回測。</p>
      <p>驗證日期 {audit.date}｜引擎來源 {audit.engineVersion}｜原始程式 {audit.sourceCommit.slice(0, 7)}。這是固定版本的回測紀錄，後續改版須重新驗證。</p>
      <div style={{ overflowX: 'auto' }}><table><thead><tr><th>聯盟</th><th>可重播場次／已結算選定方向</th><th>勝率</th><th>含退水 ROI</th><th>與原回測比較</th></tr></thead><tbody>{audit.leagues.map(row => <tr key={row.league}><td>{row.label}</td><td>{row.games == null ? '尚待驗證' : `${row.games} 場／${row.settled} 筆`}</td><td>{pct(row.winRate)}</td><td>{pct(row.roi)}</td><td>{row.comparison}</td></tr>)}</tbody></table></div>
      <small>勝率＝正結算筆數÷正負結算筆數，走水排除；部分輸贏依原信用盤比例結算。ROI 使用結算方向的原水位與本金，退水 1.5%。同場多個方向有相關性，不能當成獨立場次。</small>
    </section>
    {audit.leagues.map(row => <section className="panel" key={row.league}><h2>{row.label}</h2><p>{row.coverage}</p><p>{row.limitation}</p></section>)}
    <section className="panel" id="nba-opening-totals"><h2>NBA 開季大小分｜新版歷史驗證</h2>
      <p>全場及上半場大小分已通過 2021–2026 各球季檢查，另通過鎖定模型後才評估的 2011 球季外部驗證，共 1,230 場，其中開季 145 場。</p>
      <p>開季兩隊皆未滿 10 場時，比分沿用已核對的上季與當季基準；開季比分誤差與基準相同，不宣稱開季比分預測更準。大小分機率另外使用此版本的誤差分布與當季較早比賽校準。</p>
      <div style={{overflowX:'auto'}}><table><thead><tr><th>市場</th><th>全季平均誤差：模型／基準</th><th>開季平均誤差：模型／基準</th><th>Brier：模型／基準</th><th>Log Loss：模型／基準</th><th>結果</th></tr></thead>
        <tbody>{[['fullTotal','全場大小'],['halfTotal','上半大小']].map(([key,label])=>{
          const r=openingTotalsV6Independent.targets[key],m=r.metrics,pair=(a,b,d=3)=>`${m[a].toFixed(d)}／${m[b].toFixed(d)}`;
          return <tr key={key}><th>{label}</th><td>{pair('modelMAE','baselineMAE')}</td><td>{pair('earlyModelMAE','earlyBaselineMAE')}</td><td>{pair('modelBrier','baselineBrier',5)}</td><td>{pair('modelLogLoss','baselineLogLoss',5)}</td><td>{r.passed?'通過':'未通過'}</td></tr>;
        })}</tbody></table></div>
      <p>近年核對球季：{openingTotalsV6Development.protocol.developmentYears.join('、')}。原始門檻維持整季至少 1,000 場、開季至少 100 場，以及四項誤差不得高於基準；機率另需至少 1,000 場。</p>
      <p>2011 是較早年代的外部回溯驗證，不能當成未來賽事成績。此處使用比分參考門檻，不是歷史盤口下注勝率或獲利證明；實際賽前原盤口成績仍由下方前瞻紀錄累積。讓分仍使用原模型與驗證。</p>
    </section>
    <section className="panel"><h2>NBA 新版四盤口的歷史誤差</h2><p>核對 {quarterAudit.verifiedGames} 場分節比分。固定沿用既有比分模型規格；每場只使用同球季、同賽制、較早日期的資料。</p><p>{quarterAudit.validation.from} 起共 {quarterAudit.validation.samples} 場例行賽：上半總分平均絕對誤差 {quarterAudit.validation.quarterTotalMAE.toFixed(2)} 分；全場底模除二比較值 {quarterAudit.validation.fullScoreDividedByTwoTotalMAE.toFixed(2)} 分；上半分差平均絕對誤差 {quarterAudit.validation.quarterMarginMAE.toFixed(2)} 分。</p><p>這是單季歷史時間切分檢查，不能換算為原盤口下注勝率，也未證明獨立前瞻改善。</p></section>
    <section className="panel"><h2>NBA 已補上的驗證基礎</h2><p>新分析會永久保存伺服器產生的預測、原盤口及當時的 S／W／R，資料庫核對保存時間早於開賽。每場每盤口採最後完整賽前版本；赛後以 NBA 官方與 ESPN 核對比分，獨立統計模型成績。</p><p>每小時排程更新已完賽比分與分節歷史；只供較晚日期的預測使用。同季樣本不足不分析，資料衝突或永久保存失敗不假裝更新完成。</p><p><a className="secondary" href="/nba/validation">查看 NBA 原盤口前瞻成績與資料更新</a></p><p>本人申報下注的勝率與損益只代表實際紀錄，不作模型驗證樣本。未保存的舊預測、賽前傷停或陣容資料不能事後補成當時已知；人員觀測目前尚未校正納入比分。</p></section>
  </main>;
}
