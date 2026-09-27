// Display-only derivation from saved settlement evidence. Never substitute
// equivalent settlement shares for event probabilities or change model outputs.
import Decimal from 'decimal.js';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const unavailable = reason => ({ available: false, reason, profit: null, loss: null, flat: null });

export function netProfitProbabilities(row) {
  const events = row?.settlementEvents;
  if (!Array.isArray(events) || events.length === 0) return unavailable('缺少完整結算事件');
  let total = new Decimal(0), profit = new Decimal(0), loss = new Decimal(0), flat = new Decimal(0), ev = new Decimal(0);
  for (const event of events) {
    const p = event?.modelEventProbability;
    const payoff = event?.calculation?.profit;
    if (!finite(p) || p < 0 || p > 1 || !finite(payoff)) return unavailable('結算事件數值異常');
    total = total.plus(p);
    ev = ev.plus(new Decimal(p).times(payoff));
    // Saved payoff includes rebate and partial/split settlement, per unit stake.
    if (payoff > 0) profit = profit.plus(p);
    else if (payoff < 0) loss = loss.plus(p);
    else flat = flat.plus(p);
  }
  if (total.minus(1).abs().gt(1e-9)) return unavailable('結算事件機率不完整');
  const savedEV = [row?.modelEV, row?.modelEv, row?.rawWeightedEV, row?.weightedEV].find(finite);
  if (savedEV === undefined || ev.minus(savedEV).abs().gt(1e-9)) return unavailable('結算事件與預期淨報酬不一致');
  return { available: true, reason: null, profit: profit.toNumber(), loss: loss.toNumber(), flat: flat.toNumber() };
}

export function probabilityPercent(value) {
  return finite(value) && value >= 0 && value <= 1 + 1e-9 ? `${(value * 100).toFixed(1)}%` : '—';
}

export function profitProbabilityText(row) {
  const value = netProfitProbabilities(row);
  return value.available ? probabilityPercent(value.profit) : `無法計算（${value.reason}）`;
}

export const PROBABILITY_DISCLAIMER = '以上是模型估計，不是歷史命中率；顯示正確不代表盤口已核對或模型已校準。';
export const RETURN_DEFINITION = 'W 是每投注 100 元的模型平均預期淨報酬；例如 +10% 表示預期淨賺 10 元，不是勝率多 10%。R 是保守情境估計，不是保證報酬或統計信賴下限。';
