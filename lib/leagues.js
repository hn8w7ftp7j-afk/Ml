export const LEAGUE_REGISTRY_VERSION = 'SPORTS-LEAGUE-REGISTRY-2026-08-v1.0.0';

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
    scheduleEndpoint: '/api/mlb',
    readerPageHint: '美棒 → 讓分＆大小',
    capabilities: Object.freeze({ schedule: true, reader: true, analysis: true, ranking: true, bets: true }),
  }),
  NPB: Object.freeze({
    id: 'NPB',
    label: '日本職棒',
    shortLabel: '日棒',
    status: 'setup',
    statusLabel: '待接正式資料',
    scheduleProvider: null,
    readerProvider: null,
    modelFamily: 'NPB_ISOLATED_PENDING',
    scheduleEndpoint: null,
    readerPageHint: '日棒 → 讓分＆大小',
    capabilities: Object.freeze({ schedule: false, reader: false, analysis: false, ranking: false, bets: true }),
  }),
  KBO: Object.freeze({
    id: 'KBO',
    label: '韓國職棒',
    shortLabel: '韓棒',
    status: 'setup',
    statusLabel: '待接正式資料',
    scheduleProvider: null,
    readerProvider: null,
    modelFamily: 'KBO_ISOLATED_PENDING',
    scheduleEndpoint: null,
    readerPageHint: '韓棒 → 讓分＆大小',
    capabilities: Object.freeze({ schedule: false, reader: false, analysis: false, ranking: false, bets: true }),
  }),
  CPBL: Object.freeze({
    id: 'CPBL',
    label: '中華職棒',
    shortLabel: '中職',
    status: 'setup',
    statusLabel: '待接正式資料',
    scheduleProvider: null,
    readerProvider: null,
    modelFamily: 'CPBL_ISOLATED_PENDING',
    scheduleEndpoint: null,
    readerPageHint: '中職 → 讓分＆大小',
    capabilities: Object.freeze({ schedule: false, reader: false, analysis: false, ranking: false, bets: true }),
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
