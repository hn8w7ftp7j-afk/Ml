export const LEAGUE_REGISTRY_VERSION = 'SPORTS-LEAGUE-REGISTRY-2026-08-v2.0.0';

export const LEAGUE_IDS = Object.freeze(['MLB', 'NPB', 'KBO', 'CPBL']);

const REGISTRY = Object.freeze({
  MLB: Object.freeze({
    id: 'MLB',
    label: '美國職棒',
    shortLabel: '美棒',
    status: 'active',
    statusLabel: '正式使用',
    scheduleProvider: 'MLB_STATS_API',
    readerProvider: 'TAI888_READER_AUTO',
    modelFamily: 'MLB_JOINT_SCORE_DISTRIBUTION',
    scheduleEndpoint: '/api/schedule',
    readerPageHint: '美棒 → 讓分＆大小',
    capabilities: Object.freeze({ schedule: true, reader: true, analysis: true, ranking: true, bets: true }),
  }),
  NPB: Object.freeze({
    id: 'NPB',
    label: '日本職棒',
    shortLabel: '日棒',
    status: 'shadow',
    statusLabel: '影子分析｜不可下注',
    scheduleProvider: 'NPB_OFFICIAL_BIS',
    readerProvider: 'TAI888_READER_AUTO',
    modelFamily: 'NPB_SHADOW_JOINT_SCORE_DISTRIBUTION',
    scheduleEndpoint: '/api/schedule',
    readerPageHint: '日棒 → 讓分＆大小',
    capabilities: Object.freeze({ schedule: true, reader: true, analysis: true, ranking: true, bets: false }),
  }),
  KBO: Object.freeze({
    id: 'KBO',
    label: '韓國職棒',
    shortLabel: '韓棒',
    status: 'shadow',
    statusLabel: '影子分析｜不可下注',
    scheduleProvider: 'KBO_OFFICIAL_SCHEDULE',
    readerProvider: 'TAI888_READER_AUTO',
    modelFamily: 'KBO_SHADOW_JOINT_SCORE_DISTRIBUTION',
    scheduleEndpoint: '/api/schedule',
    readerPageHint: '韓棒 → 讓分＆大小',
    capabilities: Object.freeze({ schedule: true, reader: true, analysis: true, ranking: true, bets: false }),
  }),
  CPBL: Object.freeze({
    id: 'CPBL',
    label: '中華職棒',
    shortLabel: '中職',
    status: 'shadow',
    statusLabel: '影子分析｜不可下注',
    scheduleProvider: 'CPBL_OFFICIAL_STATS',
    readerProvider: 'TAI888_READER_AUTO',
    modelFamily: 'CPBL_SHADOW_JOINT_SCORE_DISTRIBUTION',
    scheduleEndpoint: '/api/schedule',
    readerPageHint: '中職 → 讓分＆大小',
    capabilities: Object.freeze({ schedule: true, reader: true, analysis: true, ranking: true, bets: false }),
  }),
});

export function normalizeLeagueId(value) {
  const id = String(value || '').trim().toUpperCase();
  return LEAGUE_IDS.includes(id) ? id : 'MLB';
}

export function isLeagueId(value) {
  return typeof value === 'string' && LEAGUE_IDS.includes(value.trim().toUpperCase());
}

export function requestedLeagueId(value) {
  if (value == null) return 'MLB';
  if (typeof value !== 'string') return null;
  const id = value.trim().toUpperCase();
  if (!id) return 'MLB';
  return LEAGUE_IDS.includes(id) ? id : null;
}

export function leagueConfig(value) {
  return REGISTRY[normalizeLeagueId(value)];
}

export function publicLeagueRegistry() {
  return LEAGUE_IDS.map(id => {
    const item = REGISTRY[id];
    return {
      ...item,
      capabilities: { ...item.capabilities },
    };
  });
}

export function leagueCanAnalyze(value) {
  return isLeagueId(value) && leagueConfig(value).capabilities.analysis === true;
}
