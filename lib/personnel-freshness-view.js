import { assessCoreSnapshotFreshnessV109 } from './analysis-refresh-policy-v109.js';
import { analysisHasCalculatedDirections } from './analysis-display-state-v116.js';
import { gameIsPrestartNow } from './client-analysis-state.js';

export const PERSONNEL_SCHEDULE_POLL_MS = 60_000;
const MAX_OBSERVATION_AGE_MS = 5 * 60_000;
const text = value => value == null ? '' : String(value).trim();
const instant = value => Date.parse(text(value));
const leagueOf = game => text(game?.leagueId || game?.league).toUpperCase();
const same = (a, b) => text(a) !== '' && text(a) === text(b);

// Schedule evidence observes announced starters only. It cannot establish the
// latest batting lineup, umpire assignment, or who eventually played.
export function personnelScheduleObservation(payload, { league, date, now = Date.now() } = {}) {
  const observed = instant(payload?.identityAsOf);
  if (payload?.ok !== true || payload.league !== league || payload.date !== date
    || !Array.isArray(payload.games) || !Number.isFinite(observed)
    || observed > now + 5_000 || now - observed > MAX_OBSERVATION_AGE_MS) return null;
  const fields = ['league', 'leagueId', 'gamePk', 'gameDate', 'gameNumber', 'awayTeamId', 'homeTeamId', 'awayProbableId', 'homeProbableId'];
  return { league, date, observedAt: payload.identityAsOf,
    games: payload.games.map(game => Object.fromEntries(fields.map(key => [key, game?.[key]]))) };
}

function sameGame(left, right, league) {
  return Boolean(league) && leagueOf(left) === league && leagueOf(right) === league
    && ['gamePk', 'awayTeamId', 'homeTeamId'].every(key => same(left?.[key], right?.[key]))
    && Number.isFinite(instant(left?.gameDate)) && instant(left.gameDate) === instant(right?.gameDate)
    && (left?.gameNumber == null || right?.gameNumber == null || same(left.gameNumber, right.gameNumber));
}

export function personnelFreshnessView(item, { observation = null, now = Date.now() } = {}) {
  if (!analysisHasCalculatedDirections(item?.customData) || !gameIsPrestartNow(item?.game, now)) return null;
  const context = item?.customData?.context;
  const league = leagueOf(item.game);
  const contextGame = { ...context?.game, leagueId: context?.leagueId || context?.game?.leagueId };
  const contextMatches = sameGame(contextGame, item.game, league);
  const freshness = contextMatches ? assessCoreSnapshotFreshnessV109(context, now) : null;
  const observedAt = instant(observation?.observedAt);
  const contextAt = instant(context?.fetchedAt);
  const observationCurrent = contextMatches && observation?.league === league
    && Number.isFinite(observedAt) && observedAt <= now + 5_000
    && now - observedAt <= MAX_OBSERVATION_AGE_MS
    && Number.isFinite(contextAt) && observedAt > contextAt;
  const candidates = observationCurrent && Array.isArray(observation.games)
    ? observation.games.filter(game => sameGame(game, item.game, league)) : [];
  const latestGame = candidates.length === 1 ? candidates[0] : null;
  const differences = [];
  for (const side of ['away', 'home']) {
    const savedId = text(context?.[side]?.starter?.id || context?.[side]?.starter?.officialPlayerId);
    const latestId = text(latestGame?.[`${side}ProbableId`]);
    if (savedId && latestId && savedId !== latestId) differences.push({ side, savedId, latestId });
  }
  const base = { differences, needsRecheck: true, latestLineupsChecked: false,
    latestUmpireChecked: false, actualPersonnelChecked: false };
  if (differences.length) return { ...base, status: 'STARTER_DIFFERS', label: '賽程先發與分析不同',
    detail: '較新取得的賽程先發與這份分析不同；打線、主審及實際上場名單尚未重新核對。' };
  if (!freshness || freshness.reasons.some(reason => reason !== 'CORE_SNAPSHOT_TTL_EXPIRED')) {
    return { ...base, status: 'UNVERIFIED', label: '人員時效未核對',
      detail: '這份分析缺少可核對的人員時間或場次資料；盤口同步與快照保存不能確認最新人員。' };
  }
  if (!freshness.fresh) return { ...base, status: 'RECHECK_DUE', label: '人員資料到期待重查',
    detail: '已到核心資料重新檢查時間，尚未證明人員有變；重新分析此場會取得新的資料。' };
  const rows = Array.isArray(item.customData?.analysis?.dataAudit?.rows) ? item.customData.analysis.dataAudit.rows : [];
  const assignments = rows.filter(row => ['starter', 'lineup'].includes(row.category));
  const projected = assignments.some(row => row.assignmentEvidence?.status === 'PROJECTED')
    || ['away', 'home'].some(side => context?.[side]?.starter?.projected === true || context?.[side]?.lineup?.projected === true);
  if (projected) return { ...base, status: 'PROJECTED', label: '分析含預估人員',
    detail: '這份分析使用部分預估人員；賽程輪詢只核對先發，未核對最新打線或主審。' };
  return { ...base, needsRecheck: false, status: 'SNAPSHOT_ONLY', label: '人員依分析時點',
    detail: '顯示的是分析當時保存的人員；快照已保存、盤口已同步，均不等於最新正式名單或實際上場已核對。' };
}
