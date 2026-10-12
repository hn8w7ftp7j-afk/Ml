import fs from 'node:fs/promises';
import path from 'node:path';
import { fetchNhlGame, fetchNhlSchedule } from './data.js';
import { validateNhlIdentity, validNhlDate, nhlDate } from './identity.js';
import { fitNhlModel, predictNhlDistribution, NHL_MODEL_VERSION } from './model.js';
import { normalizeNhlModelGame, nhlTimestamp } from './model-qa.js';
import { nhlContentHash } from './distribution.js';
import { nhlPersistenceConfigured, loadNhlObservations, saveNhlObservation, loadNhlAnalysesForDate } from './store.js';
import { VERIFIED_NHL_MARKET_MANIFEST } from './contracts.js';
import { validateNhlCapture } from './reader.js';
import { fetchNhlPregameEvidence } from './pregame-evidence.js';
import { NHL_PREGAME_ANALYSIS_VERSION, archiveNhlPregameDistribution,
  nhlPregameModelSummary, nhlPregameSnapshotHash, validateNhlAnalysisObservation } from './pregame-snapshot.js';

const artifacts = new Map();
const pendingArtifacts = new Map();
const injectedFitCaches = new WeakMap();
const pendingAnalyses = new Map();
let historyPromise;
const error = (code, message, status = 422) => Object.assign(new Error(message), { code, status });
const gameIdValid = id => /^(?:19|20)\d{2}0[123]\d{4}$/.test(id || '') && Number(id.slice(6)) > 0;
const clock = dependencies => typeof dependencies.now === 'function' ? dependencies.now : Date.now;
const configured = dependencies => typeof dependencies.persistenceConfigured === 'function'
  ? dependencies.persistenceConfigured() : nhlPersistenceConfigured();
const sourceTimes = row => [row?.source, ...(row?.source?.periodSources || [])].map(source => nhlTimestamp(source?.fetchedAt));

export function validNhlPregameRequest({ date, gameId, force = false, league = 'NHL' } = {}) {
  return league === 'NHL' && validNhlDate(date) && typeof gameId === 'string' && gameIdValid(gameId) && typeof force === 'boolean';
}

export async function loadNhlPregameHistory() {
  if (!historyPromise) historyPromise = (async () => {
    const [coverage, games] = (await Promise.all([
      fs.readFile(path.join(process.cwd(), 'scripts/fixtures/nhl/history-expanded/coverage.json'), 'utf8'),
      fs.readFile(path.join(process.cwd(), 'scripts/fixtures/nhl/history-expanded/period-games.json'), 'utf8'),
    ])).map(JSON.parse);
    const sourceHash = nhlContentHash(games);
    if (coverage.leagueId !== 'NHL' || !Array.isArray(games) || !games.length
      || coverage.periodCorpusHash !== sourceHash || coverage.completePeriodGames !== games.length)
      throw error('NHL_PREGAME_HISTORY_HASH_MISMATCH', 'NHL 官方歷史資料完整性核對失敗。');
    const seen = new Set();
    let acquired = nhlTimestamp(coverage.observedAt);
    for (const row of games) {
      const normalized = normalizeNhlModelGame(row);
      if (!validateNhlIdentity(row).ok || normalized.synthetic || normalized.sourceKind !== 'OFFICIAL_NHL_RECORD'
        || seen.has(normalized.gameId) || row.gameType !== 2 || row.season !== coverage.season
        || row.periodCoverageVerified !== true || !row.source?.contentHash || sourceTimes(row).some(value => value == null))
        throw error('NHL_PREGAME_HISTORY_IDENTITY_INVALID', 'NHL 官方歷史身分或來源核對失敗。');
      seen.add(normalized.gameId);
      acquired = Math.max(acquired ?? 0, ...sourceTimes(row));
    }
    if (!acquired) throw error('NHL_PREGAME_HISTORY_TIME_MISSING', 'NHL 歷史來源取得時間缺失。');
    return { league: 'NHL', games, sourceHash, availableAt: new Date(acquired).toISOString(),
      seasons: [...new Set(games.map(row => row.season))], count: games.length,
      acquisition: 'ARCHIVED_OFFICIAL_SCHEDULE_AND_PERIOD_REPORTS', historicalPointInTimeVerified: false };
  })().catch(cause => { historyPromise = null; throw cause; });
  return historyPromise;
}

export async function fittedNhlPregameArtifact(history, gameType, asOf, { fit = fitNhlModel } = {}) {
  const modelGameType = gameType === 1 ? 2 : gameType;
  if (!Array.isArray(history?.games) || !history.games.length || nhlTimestamp(history.availableAt) == null
    || nhlTimestamp(history.availableAt) > nhlTimestamp(asOf))
    throw error('NHL_PREGAME_HISTORY_NOT_YET_AVAILABLE', 'NHL 歷史來源在本次分析時間尚不可得。');
  const rows = history.games.filter(row => row.gameType === modelGameType);
  if (!rows.length) throw error('NHL_PREGAME_PHASE_HISTORY_MISSING', '這個 NHL 賽事類型尚無已核對的訓練資料；不套用其他類型模型。');
  const key = `${NHL_MODEL_VERSION}:${history.sourceHash}:${modelGameType}:${history.availableAt}`;
  // An injected test fitter must never seed the live fitted-artifact cache.
  if (typeof fit !== 'function') throw error('NHL_PREGAME_FITTER_INVALID', 'NHL 模型擬合程序無效。');
  if (fit !== fitNhlModel && !injectedFitCaches.has(fit)) injectedFitCaches.set(fit, { artifacts: new Map(), pending: new Map() });
  const cache = fit === fitNhlModel ? { artifacts, pending: pendingArtifacts } : injectedFitCaches.get(fit);
  if (cache.artifacts.has(key)) return cache.artifacts.get(key);
  if (cache.pending.has(key)) return cache.pending.get(key);
  const operation = Promise.resolve().then(() => fit(rows, { gameType: modelGameType,
    trainingCutoff: history.availableAt, availabilityMode: 'RETROSPECTIVE_48H_EMBARGO' })).then(artifact => {
    cache.artifacts.set(key, artifact);
    if (cache.artifacts.size > 4) cache.artifacts.delete(cache.artifacts.keys().next().value);
    return artifact;
  });
  cache.pending.set(key, operation);
  try { return await operation; } finally { cache.pending.delete(key); }
}

function publicGame(game) {
  return { league: 'NHL', leagueId: 'NHL', gameId: game.gameId, officialGameId: game.gameId,
    season: game.season, gameType: game.gameType, taipeiDate: nhlDate(game.startTimeUTC),
    startTimeUTC: new Date(game.startTimeUTC).toISOString(), awayTeamId: game.awayTeamId, homeTeamId: game.homeTeamId,
    away: game.away, home: game.home, awayAbbrev: game.awayAbbrev || game.away?.abbrev,
    homeAbbrev: game.homeAbbrev || game.home?.abbrev, gameState: game.gameState,
    gameScheduleState: game.gameScheduleState, source: game.source };
}

function publicRecord(record, { persisted = false, replay = false, warning = null, revision = null } = {}) {
  const { distributionArchive, ...visible } = structuredClone(record);
  return { ...visible, ...(replay ? { mode: 'SAVED_PREGAME_REPLAY' } : {}),
    persistence: { persisted, revision: revision || record.revision || null,
      ...(warning ? { reason: warning } : {}) },
    ...(warning ? { qa: { ...visible.qa, warnings: [...new Set([...(visible.qa?.warnings || []), warning])] } } : {}) };
}

function unavailableRecord(game, date, now, reason = '開賽前未保存這場的分析；不使用賽後資料回填預測。') {
  return { league: 'NHL', version: NHL_PREGAME_ANALYSIS_VERSION, gameId: game.gameId,
    taipeiDate: date, game: publicGame(game), generatedAt: new Date(now).toISOString(),
    mode: 'NO_PREGAME_RECORD', model: null,
    market: { status: 'NOT_AVAILABLE', missingReason: reason, weightedEV: null, robustEV: null, score: null },
    qa: { status: 'BLOCK', issues: ['NHL_NO_SAVED_PREGAME_ANALYSIS'], warnings: [] },
    readiness: { scoreAnalysis: false, formalRecommendations: false, realBetExecutionEnabled: false },
    persistence: { persisted: false, reason }, missingReason: reason };
}

async function readerEvidence(game, date, now, dependencies) {
  const missing = { status: 'WAITING_REAL_DATA', missingReason: '尚無本場已核對的 NHL Reader 盤口。',
    weightedEV: null, robustEV: null, score: null, verifiedMarketCount: VERIFIED_NHL_MARKET_MANIFEST.length,
    calibrationVerified: false, rows: [] };
  if (!configured(dependencies)) return missing;
  try {
    const rows = await (dependencies.loadObservations || loadNhlObservations)('READER', date, 1);
    const stored = rows[0];
    const verified = stored ? validateNhlCapture(stored, { now }) : null;
    if (!verified?.ok || verified.payload.sourceHash !== stored.sourceHash)
      return { ...missing, missingReason: 'Reader 原始來源或快照完整性未通過核對，盤口不加入分析。' };
    const capture = verified.payload;
    const observed = nhlTimestamp(capture?.observedAt);
    if (!capture || capture.league !== 'NHL' || capture.boardDate !== date || observed == null
      || observed > now || now - observed > 5 * 60_000 || !Array.isArray(capture.games)) return missing;
    const matches = capture.games.filter(row => row.league === 'NHL' && row.boardDate === date
      && Number(row.awayTeamId) === game.awayTeamId && Number(row.homeTeamId) === game.homeTeamId
      && row.awayAbbrev === game.awayAbbrev && row.homeAbbrev === game.homeAbbrev);
    if (matches.length !== 1) return { ...missing, missingReason: 'Reader 客主隊身分未唯一匹配，盤口不加入分析。' };
    const schedule = await (dependencies.fetchSchedule || fetchNhlSchedule)(date, { retry: false });
    const official = schedule?.games?.filter(row => row.awayTeamId === game.awayTeamId && row.homeTeamId === game.homeTeamId);
    if (!schedule?.ok || official?.length !== 1 || !validateNhlIdentity(official[0], game).ok)
      return { ...missing, missingReason: '官方賽程未完成唯一盤口配對，盤口不加入分析。' };
    const matched = matches[0];
    const officialTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(game.startTimeUTC));
    if ((matched.boardTime || matched.startTime) !== officialTime)
      return { ...missing, missingReason: 'Reader 開賽時間與官方賽程衝突或缺失，盤口不加入分析。' };
    if (matched.startTimeUTC != null && matched.startTimeUTC !== game.startTimeUTC)
      return { ...missing, missingReason: 'Reader 開賽時間與官方賽程衝突，盤口不加入分析。' };
    return { ...missing, status: 'CAPTURED_UNVERIFIED',
      missingReason: '本場原始盤口已匹配；OT／Shootout、作廢規則及合約 OOS 校準尚未驗證，W／R／S 保持空值。',
      observedAt: capture.observedAt, sourceHash: capture.sourceHash,
      rows: matched.rawRows || [], parsedMarkets: matched.parsedMarkets || null,
      source: { provider: 'TAI888_READER', observedAt: capture.observedAt, sourceHash: capture.sourceHash } };
  } catch { return { ...missing, missingReason: 'Reader 來源快照暫時無法讀取，比分研究仍可執行。' }; }
}

async function performAnalysis(input, dependencies) {
  if (!validNhlPregameRequest(input)) throw error('NHL_INVALID_ANALYSIS_REQUEST', 'NHL 日期或賽事識別無效。', 400);
  const { date, gameId, force = false } = input;
  const now = clock(dependencies);
  let saved = null;
  let recoveryWarning = null;
  if (configured(dependencies)) {
    try {
      const records = await (dependencies.loadObservations || loadNhlObservations)('ANALYSIS', gameId, 1);
      if (records[0]) {
        const validation = validateNhlAnalysisObservation(records[0], gameId, { now: now() });
        if (!validation.ok) throw error('NHL_SNAPSHOT_CORRUPTED', '已保存的 NHL 分析快照未通過完整性檢查。', 503);
        if (records[0].taipeiDate !== date) throw error('NHL_ANALYSIS_DATE_MISMATCH', '已保存的 NHL 賽事日期不符。');
        saved = records[0];
      }
    } catch (cause) {
      if (['NHL_SNAPSHOT_CORRUPTED', 'NHL_ANALYSIS_DATE_MISMATCH'].includes(cause.code)) throw cause;
      recoveryWarning = '先前分析快照讀取失敗；本次不能宣稱已有永久紀錄。';
    }
  }
  const result = await (dependencies.fetchGame || fetchNhlGame)(gameId, { retry: false });
  if (!result?.ok) {
    if (saved && result?.status !== 'BLOCK') return publicRecord(saved, { persisted: true, replay: true,
      warning: '目前官方來源更新失敗；顯示開賽前已保存的原分析。' });
    throw error(result?.code || 'NHL_SOURCE_UNAVAILABLE', 'NHL 官方賽事資料暫時無法取得；未建立新的分析。', result?.status === 'BLOCK' ? 422 : 503);
  }
  const game = result.game;
  if (game?.league !== 'NHL' || !validateNhlIdentity(game, { gameId, taipeiDate: date }).ok)
    throw error('NHL_ANALYSIS_GAME_IDENTITY_MISMATCH', 'NHL 賽事日期或身分不符，已停止分析。');
  if (saved && !validateNhlIdentity(publicGame(game), saved.game).ok)
    throw error('NHL_ANALYSIS_SAVED_IDENTITY_MISMATCH', '官方賽事身分或開賽時間已改變，不能使用原快照。');
  const canAnalyze = () => now() < Date.parse(game.startTimeUTC) && ['FUT', 'PRE'].includes(game.gameState)
    && game.gameScheduleState === 'OK';
  if (!canAnalyze()) return saved ? publicRecord(saved, { persisted: true, replay: true }) : unavailableRecord(game, date, now());
  if (saved && !force) return publicRecord(saved, { persisted: true, replay: true, warning: recoveryWarning });
  const [history, evidence, market] = await Promise.all([
    (dependencies.loadHistory || loadNhlPregameHistory)(),
    (dependencies.fetchEvidence || fetchNhlPregameEvidence)(game, { now }),
    readerEvidence(game, date, now(), dependencies),
  ]);
  if (!canAnalyze()) return saved ? publicRecord(saved, { persisted: true, replay: true }) : unavailableRecord(game, date, now(), '資料取得時已開賽；未建立事後預測。');
  if (evidence?.ok !== true || evidence?.league !== 'NHL' || evidence?.gameId !== gameId
    || nhlTimestamp(evidence.asOf) == null || nhlTimestamp(evidence.asOf) > now()
    || nhlTimestamp(evidence.asOf) >= nhlTimestamp(game.startTimeUTC) || evidence?.status === 'BLOCK'
    || evidence?.personnel?.qa?.status === 'BLOCK' || (evidence?.issues || []).length)
    throw error(evidence?.code || 'NHL_PREGAME_EVIDENCE_INVALID', 'NHL 賽前資料時間或身分檢核未通過；未建立新的分析。');
  const artifact = await fittedNhlPregameArtifact(history, game.gameType, new Date(now()).toISOString(), { fit: dependencies.fitModel || fitNhlModel });
  if (!canAnalyze()) return saved ? publicRecord(saved, { persisted: true, replay: true }) : unavailableRecord(game, date, now(), '模型準備完成時已開賽；未建立事後預測。');
  const generatedAt = new Date(now()).toISOString();
  const query = { ...publicGame(game), features: evidence?.features || {} };
  const predicted = predictNhlDistribution(artifact, query, { asOf: generatedAt });
  const { distribution, archive } = archiveNhlPregameDistribution(predicted);
  if (!canAnalyze()) return saved ? publicRecord(saved, { persisted: true, replay: true }) : unavailableRecord(game, date, now(), '比分計算完成時已開賽；未建立事後預測。');
  const warnings = [...new Set([...(evidence?.warnings || []), ...(distribution.qa.warnings || []),
    'NHL_UNCALIBRATED_SCORE_SHADOW_ONLY', 'NHL_TAI888_CONTRACT_AND_PAYOFF_CALIBRATION_MISSING',
    ...(history.seasons?.includes(game.season) ? [] : ['NHL_TRAINING_SEASON_DIFFERS_FROM_TARGET']),
    ...(recoveryWarning ? [recoveryWarning] : [])])];
  const sources = [game.source, ...(evidence?.sources || [])].filter(Boolean);
  const record = { league: 'NHL', version: NHL_PREGAME_ANALYSIS_VERSION, gameId, taipeiDate: date,
    game: publicGame(game), mode: 'PREGAME_SHADOW', generatedAt, observedAt: generatedAt,
    model: nhlPregameModelSummary(distribution), distributionArchive: archive,
    history: { sourceHash: history.sourceHash, sourceSeasons: history.seasons, sampleCount: artifact.trainingGameIds.length,
      availableAt: history.availableAt, availabilityMode: artifact.availabilityMode,
      historicalPointInTimeVerified: false, productionModelCalibrated: false },
    personnel: evidence?.personnel || null, context: evidence?.context || null,
    missingSources: evidence?.missingSources || [], missingFeatures: distribution.features.missing,
    teamStatistics: evidence?.teamStatistics || null, sources,
    market, qa: { status: 'WARNING', issues: evidence?.issues || [], warnings },
    readiness: { scoreAnalysis: true, marketMatched: market.status === 'CAPTURED_UNVERIFIED',
      weightedEV: false, robustEV: false, score: false, calibrated: false,
      formalRecommendations: false, realBetExecutionEnabled: false },
    persistence: { persisted: false },
  };
  record.snapshotHash = nhlPregameSnapshotHash(record);
  record.snapshotId = `nhl-pregame-${record.snapshotHash.slice(0, 24)}`;
  const validation = validateNhlAnalysisObservation(record, gameId, { now: now() });
  if (!validation.ok) throw error('NHL_ANALYSIS_SNAPSHOT_INVALID', `NHL 賽前快照檢核未通過：${validation.errors.join('、')}`);
  if (!canAnalyze()) return saved ? publicRecord(saved, { persisted: true, replay: true }) : unavailableRecord(game, date, now(), '快照檢核完成時已開賽；未建立事後預測。');
  if (configured(dependencies)) {
    try {
      const persistence = await (dependencies.saveObservation || saveNhlObservation)('ANALYSIS', gameId, record);
      return publicRecord(record, { persisted: persistence.persisted === true, revision: persistence.revision });
    } catch (cause) { return publicRecord(record, { warning: `永久快照保存未完成（${cause.code || 'NHL_DATABASE_WRITE_FAILED'}）；目前僅可查看本次結果。` }); }
  }
  return publicRecord(record, { warning: '永久快照資料庫尚未設定；目前僅可查看本次結果。' });
}

export async function analyzeNhlPregame(input, dependencies = {}) {
  // Injected adapters are isolated test contexts and never share live requests.
  if (Object.keys(dependencies).length) return performAnalysis(input, dependencies);
  const key = `${input?.date}:${input?.gameId}:${Boolean(input?.force)}`;
  if (pendingAnalyses.has(key)) return structuredClone(await pendingAnalyses.get(key));
  const operation = performAnalysis(input, dependencies);
  pendingAnalyses.set(key, operation);
  try { return structuredClone(await operation); } finally { pendingAnalyses.delete(key); }
}

export async function listNhlPregameAnalyses(date, dependencies = {}) {
  if (!validNhlDate(date)) throw error('NHL_INVALID_ANALYSIS_DATE', 'NHL 台灣日期無效。', 400);
  if (!configured(dependencies)) return { league: 'NHL', date, analyses: [],
    persistence: { persisted: false, reason: '永久快照資料庫尚未設定。' } };
  const records = await (dependencies.loadDate || loadNhlAnalysesForDate)(date);
  const now = clock(dependencies)();
  return { league: 'NHL', date, analyses: records.map(record => {
    if (record.taipeiDate !== date || !validateNhlAnalysisObservation(record, record.gameId, { now }).ok)
      throw error('NHL_SNAPSHOT_CORRUPTED', 'NHL 分析快照身分、時間或數學檢核未通過。', 503);
    return publicRecord(record, { persisted: true, replay: true });
  }), persistence: { persisted: true } };
}
