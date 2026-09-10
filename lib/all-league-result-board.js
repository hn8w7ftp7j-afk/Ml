import { preserveCompletedReaderResult } from './all-league-analysis-v117.js';
import { sameAnalysisGame } from './analysis-game-identity-v1.js';

// Display immutable server results independently of current Reader availability.
// No current Reader hash is granted: execution still requires its existing checks.
export function materializeAllLeagueResult(batch, previous = [], compact = value => value) {
  const rows = batch?.results;
  if (!Array.isArray(rows) || rows.length !== Number(batch.total)) throw new Error('背景結果筆數不完整');
  const byPk = new Map(previous.map(item => [Number(item?.game?.gamePk), item]));
  const seen = new Set();
  for (const row of rows) {
    const game = row?.task?.game;
    const pk = Number(game?.gamePk);
    if (!Number.isSafeInteger(pk) || pk <= 0 || seen.has(pk)) throw new Error('背景結果賽事識別無效或重複');
    seen.add(pk);
    const old = byPk.get(pk);
    if (old && !sameAnalysisGame(old.game, game)) throw new Error('背景結果賽事身分衝突');
    if (row.ok === true) {
      if (!(row.payload?.analysis?.results?.length || row.payload?.analysis?.directionSlots?.length) || !sameAnalysisGame(game, row.payload.game)) throw new Error('已完成結果缺少有效分析或賽事身分');
      const item = preserveCompletedReaderResult(old, row, null, compact(row.payload));
      if (!item?.customData?.analysis) throw new Error('分析結果無法顯示');
      byPk.set(pk, { ...item, statusLabel: '已載入伺服器分析｜盤口尚未重新核對｜停止下注' });
    } else {
      const blocked = row.blocked === true || row.code === 'CORE_DATA_MISSING' || Number(row.status) === 422;
      byPk.set(pk, {
        ...(old || {}), game, readerPayloadHash: null,
        pendingReaderAnalysis: false, preservedCurrentReaderGame: false,
        status: blocked ? 'blocked' : 'failed',
        statusLabel: blocked ? '資料不足｜QA BLOCK｜不評分' : '分析失敗',
        analysisFailure: { code: row.code, status: row.status, blocked, blocking: row.blocking || [], warnings: row.warnings || [] },
        error: String(row.error || row.message || '伺服器未產出有效分析'),
      });
    }
  }
  return [...byPk.values()].sort((a, b) => Date.parse(a.game.gameDate) - Date.parse(b.game.gameDate));
}
