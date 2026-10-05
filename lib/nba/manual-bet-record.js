import { validDate } from './identity.js';
import { parseCreditLine } from './analysis-core/credit-total.js';

const markets = new Set(['fullTotal', 'fullRunline', 'firstHalfTotal', 'firstHalfRunline']);
const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
// An archive of transactions the user reports already completed. No model,
// Reader, PIT, eligibility or settlement evidence is inferred from this input.
export function normalizeNbaManualBetRecord(value) {
  if (value?.alreadyPlaced !== true) fail('請確認這筆是你已自行完成的下注；此功能只保存紀錄。');
  const gameId = text(value.gameId, 60), date = value.date, marketKey = value.marketKey;
  if (!/^nba:espn:game:[1-9]\d{0,14}$/.test(gameId) || !validDate(date) || !markets.has(marketKey)) fail('場次、日期或盤口類型不正確。');
  const total = marketKey.endsWith('Total'), side = value.side;
  if (!(total ? ['over', 'under'] : ['away', 'home']).includes(side)) fail('下注方向不正確。');
  const line = text(value.line, 30), parsed = parseCreditLine(line, total ? 'total' : 'spread');
  if (!parsed || parsed.base > (total ? 400 : 100)) fail('實際下注盤口格式不正確。');
  const water = Number(value.water), stake = Number(value.stake);
  if (!Number.isFinite(water) || water <= 0 || water > 5 || !Number.isFinite(stake) || stake <= 0 || stake > 1e9 || Math.abs(stake * 100 - Math.round(stake * 100)) > 1e-5) fail('請輸入有效的實際水位與金額。');
  const away = text(value.away, 80), home = text(value.home, 80);
  if (!away || !home || away === home) fail('球隊名稱不完整。');
  const lineSide = total ? null : value.lineSide;
  if (!total && !['away', 'home'].includes(lineSide)) fail('請確認實際讓分球隊。');
  return { gameId, date, marketKey, side, line, lineSide, water, stake, away, home,
    startTime: Number.isFinite(Date.parse(value.startTime || '')) ? new Date(value.startTime).toISOString() : null,
    note: text(value.note, 300), source: 'USER_REPORTED_ALREADY_PLACED',
    evidenceStatus: 'MANUAL_UNVERIFIED', settlementStatus: 'NOT_SETTLED',
    executable: false, formalEligible: false, calibrationEligible: false,
  };
}
