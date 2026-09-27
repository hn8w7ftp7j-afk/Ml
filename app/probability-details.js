import { netProfitProbabilities, probabilityPercent as pct, PROBABILITY_DISCLAIMER, RETURN_DEFINITION } from '../lib/probability-display.js';

export default function ProbabilityDetails({ row }) {
  const net = netProfitProbabilities(row);
  return <details className="rankingDetails">
    <summary>機率與報酬如何解讀</summary>
    <p>預估獲利機率：結算後淨損益大於 0 的事件機率，包含原分析退水及分盤結算。</p>
    <p>{net.available ? `淨獲利 ${pct(net.profit)}／淨虧損 ${pct(net.loss)}／淨損益為零 ${pct(net.flat)}` : `無法計算：${net.reason}；不以等效比例代替。`}</p>
    <p>{RETURN_DEFINITION}</p>
    <p>等效輸贏比例 {pct(row?.modelProbability)}（等效贏 ÷ 等效贏輸合計，排除等效走水；不是獲利機率）</p>
    <p>等效結算份額：等效贏 {pct(row?.equivalentWinProbability)}／等效輸 {pct(row?.equivalentLossProbability)}／等效走水 {pct(row?.equivalentPushProbability)}</p>
    <p>結算事件機率：全贏 {pct(row?.fullWinProbability)}／部分贏 {pct(row?.partialWinProbability)}／純走水 {pct(row?.pushProbability)}／混合中性 {pct(row?.mixedNeutralProbability)}／部分輸 {pct(row?.partialLossProbability)}／全輸 {pct(row?.fullLossProbability)}</p>
    <p>結算分類不等於淨損益分類；退水可能改變淨損益正負。分項顯示四捨五入，總和可能略差。</p>
    <p>{PROBABILITY_DISCLAIMER}</p>
  </details>;
}
