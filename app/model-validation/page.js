import quarterAudit from '../../docs/nba-quarter-validation.json';
import audit from '../../data/four-league-validation-20261006.json';
import { APP_VERSION } from '../../lib/app-version.js';

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
    <section className="panel"><h2>NBA 新版四盤口的歷史誤差</h2><p>核對 {quarterAudit.verifiedGames} 場分節比分。固定沿用既有比分模型規格；每場只使用同球季、同賽制、較早日期的資料。</p><p>{quarterAudit.validation.from} 起共 {quarterAudit.validation.samples} 場例行賽：上半總分平均絕對誤差 {quarterAudit.validation.quarterTotalMAE.toFixed(2)} 分；全場底模除二比較值 {quarterAudit.validation.fullScoreDividedByTwoTotalMAE.toFixed(2)} 分；上半分差平均絕對誤差 {quarterAudit.validation.quarterMarginMAE.toFixed(2)} 分。</p><p>這是單季歷史時間切分檢查，不能換算為原盤口下注勝率，也未證明獨立前瞻改善。</p></section>
    <section className="panel"><h2>NBA 已補上的驗證基礎</h2><p>新分析會永久保存伺服器產生的預測與原盤口，資料庫核對保存時間早於開賽。本人申報下注可依 NBA 官方與 ESPN 交叉核對的賽果結算，支援全場與上半場大小、讓分。</p><p>本人申報下注的勝率與損益只代表實際紀錄，不作模型驗證樣本。未保存的舊預測、賽前傷停或陣容資料不能事後補成當時已知。</p></section>
  </main>;
}
