import { hasActualWater } from './markets.js';
import { ACTUAL_LINE_FRESHNESS_MS, ALLOWED_FUTURE_SKEW_MS } from './market-freshness-v1.js';

const clean = value => String(value || '').replace(/\s+/g, '').trim();

export function readerHashKey(date, payloadHash) {
  const hash = clean(payloadHash);
  return hash ? `${clean(date)}:${hash}` : '';
}

export function readerRevisionKey(date, payloadHash, pageActivityAt) {
  const hashKey = readerHashKey(date, payloadHash);
  const activityTime = Date.parse(pageActivityAt || '');
  return hashKey && Number.isFinite(activityTime)
    ? `${hashKey}:${new Date(activityTime).toISOString()}`
    : '';
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

export function actualLineFreshNow(row, now = Date.now()) {
  const timestamp = Date.parse(row?.lineAsOf || '');
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
  const terminalStatus = /in progress|game over|final|completed|live/.test(status)
    || ['I', 'F', 'O'].includes(String(game?.statusCode || '').toUpperCase());
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
