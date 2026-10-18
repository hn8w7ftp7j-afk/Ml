import { SOCCER_REQUIREMENTS_VERSION,SOCCER_REQUIREMENT_LAYERS,SOCCER_REQUIREMENTS_GATES } from '../../../lib/soccer/requirements.js';
import { soccerProviderPolicy } from '../../../lib/soccer/provider-policy.js';

export const metadata={title:'英超・歐冠 UCL｜完整分析規格 2.2'};

export default function SoccerSpecificationPage(){
  const policy=soccerProviderPolicy();
  return <main className="appShell soccerApp soccerSpec">
    <header className="appHeader"><div><div className="eyebrow">FOOTBALL ANALYSIS</div><h1>英超・歐冠分析規格 {SOCCER_REQUIREMENTS_VERSION}</h1><p>完整整理資料，驗證後再決定哪些因素進入模型。</p></div></header>
    <nav className="soccerSpecActions" aria-label="規格導航"><a href="/soccer">返回足球賽程</a><a href="https://github.com/hn8w7ftp7j-afk/Ml/blob/main/docs/SOCCER_ANALYSIS_2_2.md" target="_blank" rel="noreferrer">閱讀完整規格與驗收附錄</a></nav>
    <section className="panel"><h2>目前使用範圍</h2><p>現有足球功能提供資料核對、先發變動與歷史比分研究。六層核對會區分資料已取得、部分取得及待補，也會逐項說明是否已用於研究基準。資料有取得，不等於已驗證或已納入正式模型。</p><p className="soccerSpecNote">目前正式評分、候選排名及下注尚未啟用；研究分布不代表盤口獲利機率或已提高實際勝率。完整規格中的實作與驗收附錄仍須逐項核對。</p></section>
    <section className="panel"><h2>八方向與低頻篩選</h2><p>全場及上半場，各分析讓球主／客與大／小，共八方向。勝平負作為比分分布輸出；晉級、加時及其他市場須有各自契約。</p><p>不設最低入選場數，可以零候選。既有 S ≥ 7.2、W &gt; 0、R &gt; 0 與 QA 保留；未驗證項目不靠任意百分比、折扣或勝率保證補齊。</p></section>
    <section className="panel"><h2>足球退水與實際盤口</h2><p>足球退水已依使用者確認設為 {policy.rebateRate}（1%，每萬100），不沿用 NBA 的 0.015。{policy.rebateBasis==='TOTAL_PRINCIPAL'&&policy.rebateBasisStatus==='USER_CONFIRMED'?'已確認按投注金額計算，例如投注10,000元，退水100元；適用結算狀態、邊界派彩與取消條款仍須核對。':'退水計算基數、邊界派彩與取消條款仍須核對。'}</p><p>每筆原盤保留球頭、水位與期間證據；替代盤全部列出，未知期間不猜全場。進球門檻機率與正式過盤率分開，契約不足時不填入假收益。</p></section>
    {SOCCER_REQUIREMENT_LAYERS.map(layer=><section className="panel" key={layer.key}><h2>{layer.title}</h2><ul>{layer.items.map(item=><li key={item.key}>{item.label}</li>)}</ul></section>)}
    <section className="panel"><h2>正式使用前的必要檢核</h2>{SOCCER_REQUIREMENTS_GATES.map(gate=><div className="soccerSpecGate" key={gate.code}><strong>{gate.label}</strong><p>{gate.reason}</p></div>)}</section>
    <section className="panel"><h2>狀態與歷史紀錄</h2><p>分析狀態與篩選結果分開。處理中、失敗及資料不足不顯示候選；成功算出的未驗證模型結果列為研究中。重新核對失敗時，上次資料只供歷史查閱，不代表本次完成。</p><p>每個版本保留原盤、來源時點及分析依據。比較準度與收益時，同時揭露原始範圍、資料可評估範圍、入選比例及失敗原因；同場八方向不能當成八場獨立證據。</p></section>
  </main>;
}
