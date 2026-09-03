import { hasActualWater } from './markets.js';
import { ACTUAL_LINE_FRESHNESS_MS, ALLOWED_FUTURE_SKEW_MS } from './market-freshness-v1.js';
import { assessCoreSnapshotFreshnessV109 } from './analysis-refresh-policy-v109.js';
import { analysisHasCalculatedDirections } from './analysis-display-state-v116.js';

const clean = value => String(value || '').replace(/\s+/g, '').trim();

export function readerHashKey(date, payloadHash) {
  const hash = clean(payloadHash);
  return hash ? `${clean(date)}:${hash}` : '';
}

export function bindVerifiedReaderContractForBet(row, currentMarkets, { verified = false } = {}) {
  if (!verified || !row || !Array.isArray(currentMarkets)) return row;
  const expectedWater = Number(row?.water);
  const current = currentMarkets.find(market => (
    clean(market?.market) === clean(row?.market)
    && clean(market?.pick) === clean(row?.pick)
    && Number.isFinite(expectedWater)
    && Number.isFinite(Number(market?.water))
    && Math.abs(Number(market.water) - expectedWater) <= 1e-9
    && clean(market?.sourceType).toUpperCase() === 'ACTUAL_TW_CREDIT'
    && clean(market?.provider).toUpperCase() === 'TAI888_READER_AUTO'
    && market?.executable === true
  ));
  if (!current) return row;
  return {
    ...row,
    sourceType: current.sourceType,
    provider: current.provider,
    executable: true,
    lineAsOf: current.lineAsOf || row.lineAsOf || null,
    readerVersion: current.readerVersion || row.readerVersion || null,
    readerGameMarketHash: current.readerGameMarketHash || row.readerGameMarketHash || null,
    readerPayloadHash: current.readerPayloadHash || row.readerPayloadHash || null,
    readerRawBoardHash: current.readerRawBoardHash || row.readerRawBoardHash || null,
    readerBoardDate: current.readerBoardDate || row.readerBoardDate || null,
    clientVerifiedReaderContract: true,
  };
}

export function bindVerifiedReaderContractsForItem(item, rows) {
  const verified = Boolean(item?.readerPayloadHash)
    && item?.actualSource?.provider === 'TAI888_READER_AUTO'
    && item?.readerProvenance?.provider === 'TAI888_READER_AUTO'
    && item.readerProvenance.payloadHash === item.readerPayloadHash;
  return (Array.isArray(rows) ? rows : []).map(row => bindVerifiedReaderContractForBet(
    row,
    item?.customMarkets,
    { verified },
  ));
}

export function readerCaptureForBet(item, row, fallbackBoardDate = '') {
  const analysis = item?.customData?.analysis || {};
  const provenance = item?.readerProvenance && typeof item.readerProvenance === 'object'
    && !Array.isArray(item.readerProvenance)
    ? item.readerProvenance
    : {};
  const currentPayloadHash = clean(item?.readerPayloadHash);
  const provenancePayloadHash = clean(provenance?.payloadHash);
  const fallbackPayloadHash = clean(row?.readerPayloadHash || analysis?.readerPayloadHash);
  const fallbackRawBoardHash = clean(row?.readerRawBoardHash || analysis?.readerRawBoardHash);
  const fallbackReaderBoardDate = clean(row?.readerBoardDate || analysis?.readerBoardDate || fallbackBoardDate);

  // readerPayloadHash is the client board's current execution authority. When
  // it advances because another game changed, keep its matching provenance
  // ahead of the immutable result row, whose original PIT hashes stay frozen.
  if (currentPayloadHash) {
    if (provenancePayloadHash && provenancePayloadHash !== currentPayloadHash) {
      return { payloadHash: null, rawBoardHash: null, boardDate: null, revision: null };
    }
    const sameAsFallback = !fallbackPayloadHash || fallbackPayloadHash === currentPayloadHash;
    const rawBoardHash = clean(provenance?.rawBoardHash || (sameAsFallback ? fallbackRawBoardHash : ''));
    const boardDate = clean(provenance?.boardDate || (sameAsFallback ? fallbackReaderBoardDate : fallbackBoardDate));
    return {
      payloadHash: currentPayloadHash,
      rawBoardHash: rawBoardHash || null,
      boardDate: boardDate || null,
      revision: boardDate ? readerHashKey(boardDate, currentPayloadHash) : null,
    };
  }

  return {
    payloadHash: fallbackPayloadHash || null,
    rawBoardHash: fallbackRawBoardHash || null,
    boardDate: fallbackReaderBoardDate || null,
    revision: fallbackPayloadHash && fallbackReaderBoardDate
      ? readerHashKey(fallbackReaderBoardDate, fallbackPayloadHash)
      : null,
  };
}

export function readerRevisionKey(date, payloadHash, pageActivityAt) {
  // pageActivityAt is a Reader liveness signal, not a market-content revision.
  // Treating every heartbeat as a new revision caused completed boards to be
  // repriced and, after one transient failure, replaced by a full-board rerun.
  void pageActivityAt;
  return readerHashKey(date, payloadHash);
}

function touchAnalysisData(data, pageActivityAt) {
  if (!data?.analysis) return data;
  const touchRows = rows => (Array.isArray(rows) ? rows.map(row => (
    row?.sourceType === 'ACTUAL_TW_CREDIT'
      && String(row?.provider || '').toUpperCase() === 'TAI888_READER_AUTO'
      ? { ...row, readerLiveAsOf: pageActivityAt }
      : row
  )) : rows);
  return {
    ...data,
    analysis: {
      ...data.analysis,
      results: touchRows(data.analysis.results),
      directionSlots: touchRows(data.analysis.directionSlots),
      slots: touchRows(data.analysis.slots),
    },
  };
}

export function touchReaderHeartbeat(item, payloadHash, pageActivityAt) {
  const activityTime = Date.parse(pageActivityAt || '');
  if (!item || !clean(payloadHash) || item?.readerPayloadHash !== payloadHash
    || item?.actualSource?.provider !== 'TAI888_READER_AUTO'
    || !Number.isFinite(activityTime)) return item;
  const timestamp = new Date(activityTime).toISOString();
  return {
    ...item,
    actualSource: { ...item.actualSource, pageActivityAt: timestamp },
    customData: touchAnalysisData(item.customData, timestamp),
    referenceData: touchAnalysisData(item.referenceData, timestamp),
  };
}

function readerMarketContent(markets) {
  return (Array.isArray(markets) ? markets : [])
    .map(row => ({
      market: String(row?.market || '').trim(),
      pick: String(row?.pick || '').replace(/\s+/g, '').trim(),
      water: hasActualWater(row?.water) ? Number(row.water).toFixed(3) : '',
    }))
    .sort((left, right) => `${left.market}\u0000${left.pick}`.localeCompare(`${right.market}\u0000${right.pick}`));
}

export function sameReaderGameMarkets(left, right) {
  const a = readerMarketContent(left);
  const b = readerMarketContent(right);
  return a.length > 0 && a.length === b.length
    && a.every((row, index) => row.market === b[index].market
      && row.pick === b[index].pick
      && row.water === b[index].water);
}

export function coreSnapshotReusable(item, now = Date.now()) {
  return item?.restoredFromCache !== true
    && Boolean(item?.customData?.context)
    && assessCoreSnapshotFreshnessV109(item.customData.context, now).fresh === true;
}

export function finalizeReaderBoardAtStart(board, now = Date.now(), { noPrestartGames = false } = {}) {
  const source = Array.isArray(board) ? board : [];
  let changed = false;
  const finalized = [];
  for (const item of source) {
    if (!noPrestartGames && gameIsPrestartNow(item?.game, now)) {
      finalized.push(item);
      continue;
    }
    if (!analysisHasCalculatedDirections(item?.customData)) {
      changed = true;
      continue;
    }
    const statusLabel = noPrestartGames
      ? '目前已無賽前場次｜保留先前分析｜停止記錄新下注'
      : '比賽已開始｜保留賽前分析與排名｜停止記錄新下注';
    if (item?.readerPayloadHash == null
      && item?.latestMarketCoverage == null
      && item?.latestReaderSource == null
      && item?.status === 'done'
      && item?.statusLabel === statusLabel) {
      finalized.push(item);
      continue;
    }
    changed = true;
    finalized.push({
      ...item,
      readerPayloadHash: null,
      latestMarketCoverage: null,
      latestReaderSource: null,
      pendingReaderAnalysis: false,
      preservedCurrentReaderGame: false,
      readerWaitingHandled: false,
      status: 'done',
      statusLabel,
      error: '',
    });
  }
  return changed ? finalized : source;
}

function readerGameEvidenceHash(value) {
  return clean(value?.readerProvenance?.readerGameMarketHash
    || value?.readerGameMarketHash);
}

export function advanceUnchangedReaderGame(
  item,
  markets,
  payloadHash,
  pageActivityAt,
  now = Date.now(),
  currentRevision = {},
) {
  const previousEvidenceHash = readerGameEvidenceHash(item);
  const currentEvidenceHash = readerGameEvidenceHash(currentRevision);
  if (!item?.customData || item?.actualSource?.provider !== 'TAI888_READER_AUTO'
    || !coreSnapshotReusable(item, now)
    || !previousEvidenceHash
    || previousEvidenceHash !== currentEvidenceHash
    || !sameReaderGameMarkets(item?.customMarkets, markets)) return null;
  return touchReaderHeartbeat({
    ...item,
    actualSource: currentRevision?.actualSource || item.actualSource,
    marketCoverage: currentRevision?.marketCoverage || item.marketCoverage || null,
    readerProvenance: currentRevision?.readerProvenance || item.readerProvenance || null,
    readerPayloadHash: payloadHash,
    latestMarketCoverage: null,
    latestReaderSource: null,
    analysisFailure: null,
    pendingReaderAnalysis: false,
    preservedCurrentReaderGame: false,
    readerWaitingHandled: false,
    customMarkets: markets,
    restoredFromCache: false,
    status: 'done',
    statusLabel: 'Tai888盤口未變｜最新驗證完成',
    error: '',
  }, payloadHash, pageActivityAt);
}

function readerStatusTime(value) {
  return Math.max(
    ...[value?.receivedAt, value?.observedAt, value?.pageActivityAt]
      .map(timestamp => Date.parse(timestamp || ''))
      .filter(Number.isFinite),
    Number.NEGATIVE_INFINITY,
  );
}

export function shouldAcceptReaderStatus(current, next) {
  if (!current || next?.fresh !== true) return true;
  return readerStatusTime(next) >= readerStatusTime(current);
}

export function mergeReaderStatusHighWater(current, next) {
  if (!current) return { ...(next || {}) };
  if (readerStatusTime(next) < readerStatusTime(current)) return current;
  const merged = { ...current, ...(next || {}) };
  for (const key of ['boardDate', 'payloadHash', 'rawBoardHash', 'observedAt', 'receivedAt', 'pageActivityAt']) {
    if (next?.[key] == null || next[key] === '') merged[key] = current[key];
  }
  return merged;
}

export function liveReaderHashMatches(date, status, payloadHash) {
  const expected = readerHashKey(date, payloadHash);
  return status?.fresh === true
    && Boolean(expected)
    && clean(status?.boardDate) === clean(date)
    && readerHashKey(date, status?.payloadHash) === expected;
}

export function liveReaderRevisionMatches(date, status, payloadHash, pageActivityAt) {
  const expected = readerRevisionKey(date, payloadHash, pageActivityAt);
  return status?.fresh === true
    && Boolean(expected)
    && readerRevisionKey(status?.boardDate, status?.payloadHash, status?.pageActivityAt) === expected;
}

export function shouldAcknowledgeReaderHash({ payloadHash, expectedCount, completedCount, failedCount = 0 } = {}) {
  return Boolean(clean(payloadHash))
    && Number(expectedCount) > 0
    && Number(completedCount) === Number(expectedCount)
    && Number(failedCount) === 0;
}

function nonnegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

export function readerCoverageCounts(value = {}) {
  const open = nonnegativeInteger(value?.matchedGameCount);
  const schedule = nonnegativeInteger(value?.scheduleGameCount);
  const raw = nonnegativeInteger(value?.rawGameCount);
  const explicitWaiting = nonnegativeInteger(value?.unopenedGameCount);
  const total = schedule || Math.max(raw, open + explicitWaiting, open);
  const waiting = Math.max(explicitWaiting, total - open, 0);
  const captured = Math.min(total, Math.max(raw, open));
  const locked = Math.max(0, captured - open);
  const notRendered = Math.max(0, total - captured);
  return { total, captured, open, waiting, locked, notRendered };
}

export function actualLineFreshNow(row, now = Date.now()) {
  const timestamp = Date.parse(row?.readerLiveAsOf || row?.lineAsOf || '');
  const age = Number(now) - timestamp;
  return row?.lineFresh === true
    && Number.isFinite(timestamp)
    && Number.isFinite(age)
    && age >= -ALLOWED_FUTURE_SKEW_MS
    && age <= ACTUAL_LINE_FRESHNESS_MS;
}

export function gameIsPrestartNow(game, now = Date.now()) {
  const start = Date.parse(game?.gameDate || '');
  const current = Number(now);
  const status = `${game?.statusCode || ''} ${game?.statusEnglish || ''} ${game?.status || ''}`.toLowerCase();
  const terminalStatus = /in progress|game over|final|completed|live|postponed|cancelled/.test(status)
    || ['I', 'F', 'O', 'D', 'C'].includes(String(game?.statusCode || '').toUpperCase());
  return Number.isFinite(start)
    && Number.isFinite(current)
    && current < start
    && !terminalStatus;
}

export function formalBetEligibility(row, threshold = 7.2, now = Date.now()) {
  const score = Number(row?.score);
  const checks = {
    actualSource: row?.sourceType === 'ACTUAL_TW_CREDIT',
    actualWater: hasActualWater(row?.water) && row?.waterEstimated !== true,
    executable: row?.executable === true,
    fresh: actualLineFreshNow(row, now),
    finiteCandidateScore: Number.isFinite(score) && score >= Number(threshold),
    scoreAudit: row?.scoreAudit?.ok === true,
    pairAudit: row?.pairAudit?.passed === true,
    thirdAudit: row?.thirdAudit?.passed === true,
    serverEligible: row?.betEligible === true,
  };
  const failures = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  return { passed: failures.length === 0, checks, failures };
}

function rowIdentity(row) {
  return `${clean(row?.market)}|||${clean(row?.pick)}`;
}

function mergeSameDirection(left, right) {
  const leftHasWater = hasActualWater(left?.water);
  const rightHasWater = hasActualWater(right?.water);
  const leftActual = leftHasWater && left?.waterEstimated !== true;
  const rightActual = rightHasWater && right?.waterEstimated !== true;
  if (leftActual && rightActual && Math.abs(Number(left.water) - Number(right.water)) > 1e-9) {
    return { conflict: '同一方向在不同圖片出現不同水位' };
  }
  const selectedWater = rightActual ? right : leftActual ? left : rightHasWater ? right : left;
  const executable = leftActual && rightActual
    ? left?.executable !== false && right?.executable !== false
    : selectedWater?.executable !== false;
  return {
    value: {
      ...left,
      ...right,
      water: selectedWater?.water ?? null,
      waterEstimated: selectedWater?.waterEstimated === true,
      waterMissing: !hasActualWater(selectedWater?.water),
      executable,
      confidence: Math.min(Number(left?.confidence ?? 1), Number(right?.confidence ?? 1)),
      lineAsOf: [left?.lineAsOf, right?.lineAsOf].filter(Boolean).sort()[0] || '',
    },
  };
}

export function mergeRecognizedGameInputs(inputs = []) {
  const grouped = new Map();
  const conflicts = [];

  for (const input of Array.isArray(inputs) ? inputs : []) {
    const gamePk = Number(input?.game?.gamePk);
    if (!Number.isSafeInteger(gamePk) || gamePk <= 0) continue;
    if (!grouped.has(gamePk)) grouped.set(gamePk, { game: input.game, markets: new Map(), blockedMarkets: new Set() });
    const target = grouped.get(gamePk);

    for (const row of Array.isArray(input?.markets) ? input.markets : []) {
      const market = clean(row?.market);
      const pick = clean(row?.pick);
      if (!market || !pick || target.blockedMarkets.has(market)) continue;
      if (!target.markets.has(market)) target.markets.set(market, new Map());
      const directions = target.markets.get(market);
      const key = rowIdentity(row);

      if (directions.has(key)) {
        const merged = mergeSameDirection(directions.get(key), row);
        if (merged.conflict) {
          conflicts.push({ gamePk, market, reason: merged.conflict });
          target.markets.delete(market);
          target.blockedMarkets.add(market);
        } else {
          directions.set(key, merged.value);
        }
        continue;
      }

      directions.set(key, row);
      if (directions.size > 2) {
        conflicts.push({ gamePk, market, reason: '同一市場出現超過兩個不同方向或盤口' });
        target.markets.delete(market);
        target.blockedMarkets.add(market);
      }
    }
  }

  const games = [...grouped.values()].map(group => ({
    game: group.game,
    markets: [...group.markets.values()].flatMap(directions => [...directions.values()]),
  })).filter(group => group.markets.length > 0);

  return { games, conflicts };
}
