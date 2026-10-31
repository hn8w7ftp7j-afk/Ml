// Client-safe explanation of the exact evidence conditions used by the formal
// scorer. This audit neither approves a source nor changes model/market inputs.
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const instant = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;

function sourceKnown(source, cutoff) {
  if (!source || !sha(source.contentHash) || typeof source.provider !== 'string' || !source.provider.trim()) return false;
  try { const url = new URL(source.url); if (url.protocol !== 'https:' || url.username || url.password) return false; } catch { return false; }
  const times = [source.sourcePublishedAt, source.fetchedAt, source.availableAt].map(instant);
  return times.every(time => Number.isFinite(time) && time <= cutoff) && times[0] <= times[1] && times[1] <= times[2];
}

function sourceReadiness(source, cutoff) {
  const details = [];
  const add = (code, label) => details.push({ code, label });
  if (!source) add('SOURCE_MISSING', '缺少這個欄位的來源收據');
  else {
    if (!sha(source.contentHash)) add('SOURCE_HASH_UNVERIFIED', '來源內容雜湊尚未核對');
    if (typeof source.provider !== 'string' || !source.provider.trim()) add('SOURCE_PROVIDER_MISSING', '缺少來源名稱');
    try {
      const url = new URL(source.url);
      if (url.protocol !== 'https:' || url.username || url.password) add('SOURCE_URL_UNVERIFIED', '來源網址未通過核對');
    } catch { add('SOURCE_URL_UNVERIFIED', '來源網址未通過核對'); }
    const names = { sourcePublishedAt: '來源公布時間', fetchedAt: '取得時間', availableAt: '可供分析使用時間' };
    const times = Object.fromEntries(Object.keys(names).map(field => [field, instant(source[field])]));
    for (const [field, label] of Object.entries(names)) {
      if (!Number.isFinite(times[field])) add(`${field.toUpperCase()}_MISSING_OR_INVALID`, `缺少可核對的${label}`);
      else if (!(times[field] <= cutoff)) add(`${field.toUpperCase()}_AFTER_CUTOFF`, `${label}晚於本次分析時間`);
    }
    if (Number.isFinite(times.sourcePublishedAt) && Number.isFinite(times.fetchedAt) && times.sourcePublishedAt > times.fetchedAt)
      add('SOURCE_TIME_ORDER_INVALID', '來源公布時間晚於取得時間');
    if (Number.isFinite(times.fetchedAt) && Number.isFinite(times.availableAt) && times.fetchedAt > times.availableAt)
      add('SOURCE_AVAILABILITY_ORDER_INVALID', '可供使用時間早於取得時間');
  }
  if (!Number.isFinite(cutoff)) add('ANALYSIS_CUTOFF_INVALID', '本次分析時間無法核對');
  return { ok: sourceKnown(source, cutoff), details };
}

const missingReasonLabels = {
  MINUTES_MODEL_NOT_VALIDATED: '預計上場分鐘模型尚未驗收',
  PREMATCH_FORECAST_NOT_CONNECTED: '尚未接入賽前天氣預報',
  ALL_COMPETITION_TRAVEL_NOT_VERIFIED: '跨賽事行程與旅行資料尚未核對',
  ROUND_AGGREGATE_AND_DOMESTIC_STRENGTH_NOT_VERIFIED: '歐冠回合、總比分與跨聯賽強度尚未核對',
  CONSISTENT_XG_HISTORY_NOT_CONNECTED: '尚未接入一致的逐場 xG 歷史資料',
  INJURY_COVERAGE_NOT_VERIFIED: '傷停名單的完整度尚未確認',
  COMPETITION_ELIGIBILITY_NOT_VERIFIED: '本賽事的停賽與出賽資格尚未確認',
  REFEREE_NOT_PROVIDED: '來源尚未提供本場裁判',
  MATCH_LEVEL_NPXG_HISTORY_AND_SHOT_QUALITY_UNVERIFIED: '逐場非十二碼 xG 與射門品質尚未核對',
};
const statusDetails = observation => {
  if (!observation) return [{ code: 'OBSERVATION_MISSING', label: '尚未接入這個欄位的資料' }];
  if (observation.status === 'VERIFIED') return [];
  if (observation.status === 'UNKNOWN') return [{ code: 'OBSERVATION_UNKNOWN', label: Object.hasOwn(missingReasonLabels, observation.reason)
    ? missingReasonLabels[observation.reason] : '資料仍標記為未取得或未確認' }];
  if (typeof observation.status === 'string' && observation.status.startsWith('PROVIDER_REPORTED'))
    return [{ code: 'PROVIDER_REPORTED_ONLY', label: '目前只有來源回報，尚未完成正式核對' }];
  return [{ code: 'OBSERVATION_NOT_VERIFIED', label: '目前狀態尚未通過正式核對' }];
};

/** Quote-independent audit. Pass the saved analysis cutoff when inspecting an
 * archived version; the live scorer supplies its unchanged current cutoff. */
export function soccerFormalEvidenceReadiness({ evidence, game = evidence?.game, now = Date.now() } = {}) {
  const checks = [];
  const add = (code, field, label, passed, details, extra = {}) => checks.push({
    code, field, label, status: passed ? 'PASS' : 'BLOCKED', details, ...extra,
  });
  const rootSource = sourceReadiness(evidence?.source, now), rootDetails = [...rootSource.details];
  if (evidence?.ok !== true) rootDetails.unshift({ code: 'EVIDENCE_NOT_ACCEPTED', label: '賽事來源資料尚未通過基本核對' });
  if (evidence?.phase !== 'PREMATCH_OBSERVATION') rootDetails.push({ code: 'NOT_PREMATCH_EVIDENCE', label: '這份資料不是賽前觀察' });
  if (evidence?.game?.id !== game?.id || evidence?.game?.league !== game?.league)
    rootDetails.push({ code: 'EVIDENCE_GAME_SCOPE_MISMATCH', label: '來源資料與本場或聯盟身分不符' });
  if (evidence?.pointInTimeAvailabilityVerified !== true)
    rootDetails.push({ code: 'PUBLISHED_AVAILABILITY_UNVERIFIED', label: '尚未確認這份資料在分析時間已公布可用' });
  const rootPassed = !(evidence?.ok !== true || evidence.phase !== 'PREMATCH_OBSERVATION' || evidence.game?.id !== game?.id
    || evidence.game?.league !== game?.league || evidence.pointInTimeAvailabilityVerified !== true || !rootSource.ok);
  add('SOCCER_SCORE_PREMATCH_PIT_EVIDENCE_INCOMPLETE', 'evidence', '賽前資料的來源與時間', rootPassed, rootDetails,
    { observedStatus: evidence?.phase || null });

  // Keep the scorer's original short-circuit/Set behavior: an invalid XI does
  // not add later players to the cross-team identity set.
  const playerIds = new Set();
  for (const side of ['home', 'away']) {
    const team = evidence?.teams?.[side], name = side === 'home' ? '主隊' : '客隊';
    const identityPassed = team?.sourceId === game?.[side]?.sourceId;
    add(`SOCCER_SCORE_${side.toUpperCase()}_IDENTITY_UNVERIFIED`, `teams.${side}.sourceId`, `${name}身分`, identityPassed,
      identityPassed ? [] : [{ code: 'TEAM_IDENTITY_MISMATCH', label: '資料中的球隊 ID 與賽事不一致' }]);
    const fieldNames = { lineup: '先發', injuries: '傷停', suspensions: '停賽', minutes: '預計上場時間' };
    for (const [field, fieldName] of Object.entries(fieldNames)) {
      const observation = team?.[field], source = sourceReadiness(observation?.source, now);
      add(`SOCCER_SCORE_${side.toUpperCase()}_${field.toUpperCase()}_UNVERIFIED`, `teams.${side}.${field}`, `${name}${fieldName}`,
        observation?.status === 'VERIFIED' && source.ok, [...statusDetails(observation), ...source.details],
        { observedStatus: observation?.status || null, reportedReason: typeof observation?.reason === 'string' ? observation.reason : null });
    }
    const starters = team?.lineup?.starters;
    const xiPassed = !(!Array.isArray(starters) || starters.length !== 11 || starters.some(player => typeof player?.id !== 'string'
      || !/^\d{1,16}$/.test(player.id) || playerIds.has(player.id) || (playerIds.add(player.id), false)));
    add(`SOCCER_SCORE_${side.toUpperCase()}_STARTING_XI_UNVERIFIED`, `teams.${side}.lineup.starters`, `${name}十一人先發身分`, xiPassed,
      xiPassed ? [] : [{ code: !Array.isArray(starters) || starters.length !== 11 ? 'STARTING_XI_COUNT_INVALID' : 'STARTING_XI_PLAYER_IDENTITY_INVALID',
        label: !Array.isArray(starters) || starters.length !== 11 ? '尚無完整十一人先發名單' : '先發球員 ID 無效、重複或與另一隊衝突' }],
      { starterCount: Array.isArray(starters) ? starters.length : 0 });
    const effectPassed = team?.minutes?.modelEffectApplied === true;
    add(`SOCCER_SCORE_${side.toUpperCase()}_PERSONNEL_MODEL_EFFECT_UNVERIFIED`, `teams.${side}.minutes.modelEffectApplied`, `${name}人員模型接入`, effectPassed,
      effectPassed ? [] : [{ code: 'PERSONNEL_EFFECT_NOT_APPLIED', label: '人員與預計分鐘尚未通過驗證並接入正式模型' }],
      { modelEffectApplied: effectPassed });
  }
  const fieldNames = { xg: '攻守 xG', travel: '旅行與體能', weather: '比賽天氣', referee: '裁判', ...(game?.league === 'ucl' ? { uclContext: '歐冠回合與跨聯賽情境' } : {}) };
  for (const [field, label] of Object.entries(fieldNames)) {
    const observation = evidence?.[field], source = sourceReadiness(observation?.source, now);
    add(`SOCCER_SCORE_${field.toUpperCase()}_UNVERIFIED`, field, label, observation?.status === 'VERIFIED' && source.ok,
      [...statusDetails(observation), ...source.details],
      { observedStatus: observation?.status || null, reportedReason: typeof observation?.reason === 'string' ? observation.reason : null });
  }
  const blockers = checks.filter(check => check.status === 'BLOCKED');
  return { version: 'SOCCER-FORMAL-EVIDENCE-READINESS-v1', status: blockers.length ? 'BLOCKED' : 'READY', ok: !blockers.length,
    reasons: blockers.map(check => check.code), checks, blockers };
}
