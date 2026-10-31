import { soccerLeague } from './contracts.js';
import { acceptedSoccerArtifactRegistrations, acceptedSoccerRuntimeBundles } from './scoring-bundle-registry.js';
import { soccerSettlementRegistryStatus } from './settlement-contract.js';

export const SOCCER_SYSTEM_READINESS_VERSION = 'SOCCER-SERVER-SCORING-READINESS-v1';
const periods = ['FT', 'HT'];
const labels = {
  SETTLEMENT_CONTRACT: ['原盤派彩規則尚未登錄', '完成已確認信用盤規則與全場、上半場原盤的綁定；異常賽事保留人工核對。'],
  RUNTIME_INPUTS: ['正式評分輸入尚未接入', '接入適用本聯盟的比分模型、情境、收益誤差與驗收依據。'],
  MODEL_ACCEPTANCE: ['比分模型尚無正式驗收登錄', '完成模型與賽前資料適用範圍的驗證及登錄。'],
  CALIBRATION_ACCEPTANCE: ['機率校準尚無正式驗收登錄', '完成各期間的樣本外機率校準驗證及登錄。'],
  UNCERTAINTY_ACCEPTANCE: ['收益誤差尚無正式驗收登錄', '以實際原盤建立情境與收益誤差驗證，接入 W／R 計算。'],
};

// Read the production authority even when a board has no games or Reader
// quotes. A registry entry is configuration, never evidence that this game has
// passed the scorer. No caller-supplied flags can populate these counts.
export function soccerSystemScoringReadiness(leagueValue, now = Date.now()) {
  const league = soccerLeague(leagueValue)?.id;
  if (!league || !Number.isFinite(now) || Math.abs(now) > 8.64e15) throw Error('SOCCER_SYSTEM_READINESS_SCOPE_INVALID');
  const bundles = acceptedSoccerRuntimeBundles.filter(value => value?.league === league);
  const countByPeriod = rows => Object.fromEntries(periods.map(period => [period, rows.filter(value => value?.period === period).length]));
  const counts = {
    SETTLEMENT_CONTRACT: soccerSettlementRegistryStatus(league),
    RUNTIME_INPUTS: countByPeriod(bundles),
  };
  for (const kind of ['model', 'calibration', 'uncertainty']) {
    const artifacts = acceptedSoccerArtifactRegistrations.filter(value => value?.league === league && value.kind === kind);
    // Reviewed factories are an alternative server-owned acceptance authority;
    // the runtime resolver still validates their exact source/hash/time scope.
    const factories = bundles.filter(value => value.factoryVersion && value.reviewReceipt?.status === 'REVIEWED'
      && typeof value.reviewReceipt?.manifestHashes?.[kind === 'uncertainty' ? 'uncertaintyTemplate' : kind] === 'string');
    counts[`${kind.toUpperCase()}_ACCEPTANCE`] = countByPeriod([...artifacts, ...factories]);
  }
  const dependencies = Object.entries(labels).map(([code, [label, nextAction]]) => {
    const registrations = counts[code], missingPeriods = periods.filter(period => registrations[period] === 0);
    return { code, label, nextAction, owner: 'SYSTEM', registrations, missingPeriods,
      status: missingPeriods.length ? 'MISSING_REGISTRATION' : 'REGISTERED_REQUIRES_RUNTIME_VALIDATION' };
  });
  const blockers = dependencies.filter(value => value.status === 'MISSING_REGISTRATION');
  return { version: SOCCER_SYSTEM_READINESS_VERSION, league, checkedAt: new Date(now).toISOString(),
    scope: 'SERVER_CONFIGURATION_ONLY', status: blockers.length ? 'BLOCKED' : 'RUNTIME_VALIDATION_REQUIRED',
    dependencies, blockers, formalScoringEnabled: false, executable: false,
    runtimeEvidenceRequired: [
      '每筆原盤的來源、期間、時間與比賽身分',
      '先發、傷停、停賽、預計分鐘及人員模型的可追溯賽前依據',
      '攻守資料、天氣、旅行及裁判依據',
      ...(league === 'ucl' ? ['歐冠跨聯賽強度與回合情境依據'] : []),
      '逐比分收益、足球誤差及目前候選資格的實際核對',
    ] };
}
