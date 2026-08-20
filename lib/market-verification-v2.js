import { hasActualWater, parseTaiwanLine } from './markets.js';
import {
  MAX_CONSENSUS_QUOTE_SPAN_MS,
  MAX_REFERENCE_PROBABILITY_MAD,
  MAX_REFERENCE_PROBABILITY_SPREAD,
  MAX_REFERENCE_QUOTE_AGE_MS,
  MAX_REFERENCE_QUOTE_FUTURE_SKEW_MS,
} from './reference-lines.js';

export const MARKET_VERIFICATION_V2_VERSION = 'INDEPENDENT-PAYOFF-VECTOR-CONSENSUS-2026-08-v2.4.0';
export const MINIMUM_CONSENSUS_BOOKS = 3;
export const MAX_ACTUAL_REFERENCE_DISTANCE_MS = 5 * 60 * 1000;

const normalize = value => String(value || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
const clean = value => String(value || '').trim();
const finiteNumber = value => value == null || value === '' ? Number.NaN : Number(value);

function evaluationTime(value) {
  const parsed = value instanceof Date ? value.getTime()
    : typeof value === 'string' ? Date.parse(value)
      : Number(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function providerGroup(row) {
  const provider = String(row?.provider || row?.sourceLabel || '').toUpperCase();
  if (provider.includes('TAI888')) return 'TAI888';
  if (provider.includes('THE_ODDS_API')) return 'THE_ODDS_API';
  if (provider.includes('JBOT')) return 'JBOT';
  return provider || '';
}

function sideSignature(row) {
  const parsed = parseTaiwanLine(row?.pick);
  if (!parsed.valid) return '';
  const zeroFullGameSpread = row?.market === '全場讓分'
    && parsed.legs?.length === 1
    && Math.abs(Number(parsed.legs[0])) <= 1e-9;
  const side = parsed.isTotal
    ? parsed.isOver ? 'over' : 'under'
    : zeroFullGameSpread
      ? `moneyline:${normalize(parsed.team)}`
      : `${parsed.isGiving ? 'giving' : 'receiving'}:${normalize(parsed.team)}`;
  // Tail modifiers only change the payoff at an exact integer result. They do
  // not change the underlying international line used to infer that result.
  return `${row.market}|${side}|${parsed.lineText}`;
}

function familySignature(row) {
  const parsed = parseTaiwanLine(row?.pick);
  if (!parsed.valid) return '';
  return `${row.market}|${parsed.isTotal ? 'total' : 'spread'}|${parsed.lineText}`;
}

function source(row, contractKey) {
  const provider = String(row?.provider || row?.sourceLabel || '').slice(0, 80);
  const independentGroup = providerGroup(row);
  const observedAt = String(row?.lineAsOf || '').slice(0, 40);
  if (!provider || !independentGroup || !Number.isFinite(Date.parse(observedAt))) return null;
  return { provider, independentGroup, observedAt, contractKey };
}

function isBinaryNoPush(row) {
  const parsed = parseTaiwanLine(row?.pick);
  return Boolean(parsed.valid
    && Array.isArray(parsed.legs)
    && parsed.legs.length === 1
    && (Math.abs(Number(parsed.legs[0]) - Math.round(Number(parsed.legs[0]))) > 1e-9
      // MLB full-game zero run line settles identically to moneyline because
      // an official MLB game cannot finish tied. F5 zero lines are excluded.
      || (row?.market === '全場讓分' && Math.abs(Number(parsed.legs[0])) <= 1e-9)));
}

function impliedProbability(water) {
  return hasActualWater(water) ? 1 / (1 + Number(water)) : null;
}

function bookKeys(row) {
  return [...new Set((Array.isArray(row?.consensusBookKeys) ? row.consensusBookKeys : [])
    .map(clean).filter(Boolean))].sort();
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function rowDetails(row) {
  if (!row) return null;
  return {
    pick: clean(row.pick),
    market: clean(row.market),
    water: hasActualWater(row.water) ? Number(row.water) : null,
    rawDecimalOdds: Number.isFinite(Number(row.rawDecimalOdds)) ? Number(row.rawDecimalOdds) : null,
    provider: clean(row.provider || row.sourceLabel),
    independentGroup: providerGroup(row),
    observedAt: clean(row.lineAsOf),
    providerEventId: clean(row.providerEventId),
    referenceNoVigProbability: Number.isFinite(Number(row.referenceNoVigProbability)) ? Number(row.referenceNoVigProbability) : null,
    referenceRobustProbability: Number.isFinite(Number(row.referenceRobustProbability)) ? Number(row.referenceRobustProbability) : null,
    referenceProbabilityMinimum: Number.isFinite(Number(row.referenceProbabilityMinimum)) ? Number(row.referenceProbabilityMinimum) : null,
    referenceProbabilityMaximum: Number.isFinite(Number(row.referenceProbabilityMaximum)) ? Number(row.referenceProbabilityMaximum) : null,
    referenceProbabilitySpread: Number.isFinite(Number(row.referenceProbabilitySpread)) ? Number(row.referenceProbabilitySpread) : null,
    referenceProbabilityMad: Number.isFinite(Number(row.referenceProbabilityMad)) ? Number(row.referenceProbabilityMad) : null,
    referenceEvidenceEligible: row.referenceEvidenceEligible === true,
    consensusBookCount: Number.isFinite(Number(row.consensusBookCount)) ? Number(row.consensusBookCount) : null,
    consensusBookKeys: bookKeys(row),
    consensusOldestObservedAt: clean(row.consensusOldestObservedAt),
    consensusNewestObservedAt: clean(row.consensusNewestObservedAt),
    consensusTimeSpanMs: Number.isFinite(Number(row.consensusTimeSpanMs)) ? Number(row.consensusTimeSpanMs) : null,
    consensusFreshnessMaxMs: Number.isFinite(Number(row.consensusFreshnessMaxMs)) ? Number(row.consensusFreshnessMaxMs) : null,
    consensusSnapshotId: clean(row.consensusSnapshotId),
  };
}

function timeDistance(left, right) {
  const a = Date.parse(left?.lineAsOf || '');
  const b = Date.parse(right?.lineAsOf || '');
  return Number.isFinite(a) && Number.isFinite(b) ? Math.abs(a - b) : Infinity;
}

function bestExactMatch(actual, references, toleranceMs) {
  const contractKey = sideSignature(actual);
  return references
    .filter(reference => ['REFERENCE', 'INTERNATIONAL'].includes(reference?.sourceType))
    .filter(reference => sideSignature(reference) === contractKey)
    .filter(reference => timeDistance(actual, reference) <= toleranceMs)
    .sort((left, right) => {
      const leftPriority = providerGroup(left) === 'THE_ODDS_API' ? 0 : providerGroup(left) === 'JBOT' ? 1 : 2;
      const rightPriority = providerGroup(right) === 'THE_ODDS_API' ? 0 : providerGroup(right) === 'JBOT' ? 1 : 2;
      return leftPriority - rightPriority || timeDistance(actual, left) - timeDistance(actual, right);
    })[0] || null;
}

function oppositeReference(match, references, toleranceMs) {
  if (!match) return null;
  const family = familySignature(match);
  const side = sideSignature(match);
  const group = providerGroup(match);
  return references
    .filter(reference => ['REFERENCE', 'INTERNATIONAL'].includes(reference?.sourceType))
    .filter(reference => familySignature(reference) === family && sideSignature(reference) !== side)
    .filter(reference => providerGroup(reference) === group)
    .filter(reference => Boolean(clean(match.providerEventId)
      && clean(reference.providerEventId)
      && clean(match.providerEventId) === clean(reference.providerEventId)
      && timeDistance(match, reference) <= toleranceMs))
    .sort((left, right) => timeDistance(match, left) - timeDistance(match, right))[0] || null;
}

const median = values => {
  const rows = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!rows.length) return null;
  const middle = Math.floor(rows.length / 2);
  return rows.length % 2 ? rows[middle] : (rows[middle - 1] + rows[middle]) / 2;
};

const medianAbsoluteDeviation = values => {
  const centre = median(values);
  return Number.isFinite(centre) ? median(values.map(value => Math.abs(Number(value) - centre))) : null;
};

function referenceThreshold(parsed) {
  if (!parsed?.valid || parsed.isTotal || parsed.legs?.length !== 1) return null;
  const line = Number(parsed.legs[0]);
  if (!Number.isFinite(line)) return null;
  return parsed.isGiving ? line : -line;
}

function referenceBookRows(row) {
  const byBook = new Map();
  for (const item of Array.isArray(row?.referenceBookProbabilities) ? row.referenceBookProbabilities : []) {
    const bookmakerKey = clean(item?.bookmakerKey);
    const probability = Number(item?.probability);
    const observedAt = clean(item?.observedAt);
    const observedTime = Date.parse(observedAt);
    if (!bookmakerKey || !(probability > 0 && probability < 1) || !Number.isFinite(observedTime)) continue;
    const previous = byBook.get(bookmakerKey);
    if (!previous || observedTime > previous.observedTime) {
      byBook.set(bookmakerKey, { bookmakerKey, probability, observedAt, observedTime });
    }
  }
  return byBook;
}

function sameLine(left, right, tolerance = 1e-8) {
  return Number.isFinite(Number(left)) && Number.isFinite(Number(right))
    && Math.abs(Number(left) - Number(right)) <= tolerance;
}

function payoffReferenceCandidates(actual, references, toleranceMs) {
  const parsed = parseTaiwanLine(actual?.pick);
  if (!parsed.valid) return [];
  const team = normalize(parsed.team);
  return references.filter(reference => {
    if (reference?.sourceType !== 'INTERNATIONAL' || providerGroup(reference) !== 'THE_ODDS_API') return false;
    if (reference?.market !== actual?.market || timeDistance(actual, reference) > toleranceMs) return false;
    const candidate = parseTaiwanLine(reference?.pick);
    if (!candidate.valid || candidate.isTotal !== parsed.isTotal || candidate.legs?.length !== 1) return false;
    return parsed.isTotal || normalize(candidate.team) === team;
  });
}

function findTotalReference(candidates, parsed, line) {
  return candidates.find(row => {
    const candidate = parseTaiwanLine(row?.pick);
    return candidate.valid
      && candidate.isTotal
      && candidate.isOver === parsed.isOver
      && candidate.isUnder === parsed.isUnder
      && sameLine(candidate.legs?.[0], line);
  }) || null;
}

function findSpreadReference(candidates, threshold) {
  return candidates.find(row => sameLine(referenceThreshold(parseTaiwanLine(row?.pick)), threshold)) || null;
}

function exactOutcomeFraction(parsed) {
  if (!parsed?.modifier || parsed.modifier === '平' || !parsed.tailPercent) return 0;
  const raw = (parsed.tailSign === 'positive' ? 1 : -1) * Number(parsed.tailPercent) / 100;
  return parsed.isOver || parsed.isGiving ? raw : -raw;
}

function requiredReferencesForContract(actual, candidates) {
  const parsed = parseTaiwanLine(actual?.pick);
  const required = [];
  const legs = [];
  for (const line of parsed.legs || []) {
    const integer = Math.abs(Number(line) - Math.round(Number(line))) <= 1e-9;
    if (!integer) {
      const direct = parsed.isTotal
        ? findTotalReference(candidates, parsed, line)
        : findSpreadReference(candidates, parsed.isGiving ? line : -line);
      if (!direct) return { ok: false, reason: '缺少同一賽事、同一期間、同一方向的獨立國際市場半分盤', required };
      required.push(direct);
      legs.push({ integer: false, direct });
      continue;
    }

    let fullWin;
    let winOrExact;
    if (parsed.isTotal) {
      fullWin = findTotalReference(candidates, parsed, parsed.isOver ? line + 0.5 : line - 0.5);
      winOrExact = findTotalReference(candidates, parsed, parsed.isOver ? line - 0.5 : line + 0.5);
    } else {
      const threshold = parsed.isGiving ? line : -line;
      fullWin = findSpreadReference(candidates, threshold + 0.5);
      winOrExact = findSpreadReference(candidates, threshold - 0.5);
    }
    if (!fullWin || !winOrExact) {
      return { ok: false, reason: '缺少推導走水／部分輸贏所需的相鄰半分盤', required: [fullWin, winOrExact].filter(Boolean) };
    }
    required.push(fullWin, winOrExact);
    legs.push({ integer: true, fullWin, winOrExact });
  }
  return { ok: true, parsed, required: [...new Set(required)], legs };
}

function intersectBookKeys(rows) {
  const maps = rows.map(referenceBookRows);
  if (!maps.length || maps.some(map => map.size === 0)) return { maps, keys: [] };
  const keys = [...maps[0].keys()].filter(key => maps.every(map => map.has(key))).sort();
  return { maps, keys };
}

function buildPayoffEvidence(actual, references, toleranceMs, verifiedAtMs) {
  const parsed = parseTaiwanLine(actual?.pick);
  if (!parsed.valid) return { attempted: false };
  // Let a full-game MLB zero run line use the exact h2h three-book path. It
  // has no push state and therefore does not need adjacent +/-0.5 lines.
  if (actual?.market === '全場讓分'
    && parsed.legs?.length === 1
    && Math.abs(Number(parsed.legs[0])) <= 1e-9) return { attempted: false };
  const candidates = payoffReferenceCandidates(actual, references, toleranceMs);
  const hasPayoffLattice = candidates.some(row => referenceBookRows(row).size > 0);
  const requiresPayoffLattice = parsed.legs.length > 1
    || parsed.legs.some(line => Math.abs(Number(line) - Math.round(Number(line))) <= 1e-9);
  if (!hasPayoffLattice && !requiresPayoffLattice) return { attempted: false };
  if (!candidates.length) {
    return { attempted: true, eligible: false, reason: '缺少5分鐘內獨立國際市場同賽事同期間價格', candidates: [] };
  }

  const contract = requiredReferencesForContract(actual, candidates);
  if (!contract.ok) {
    return { attempted: true, eligible: false, reason: contract.reason, candidates, required: contract.required || [] };
  }
  const eventIds = [...new Set(contract.required.map(row => clean(row?.providerEventId)).filter(Boolean))];
  if (eventIds.length !== 1) {
    return { attempted: true, eligible: false, reason: '相鄰盤不是同一場賽事，禁止合併機率', candidates, required: contract.required };
  }
  if (contract.required.some(row => row?.referenceEvidenceEligible !== true)) {
    return { attempted: true, eligible: false, reason: '相鄰半分盤未通過三莊鮮度或分散安全門檻', candidates, required: contract.required };
  }

  const { keys } = intersectBookKeys(contract.required);
  if (keys.length < MINIMUM_CONSENSUS_BOOKS) {
    return {
      attempted: true,
      eligible: false,
      reason: `完成全部相鄰盤的共同獨立莊家僅${keys.length}家，至少需要${MINIMUM_CONSENSUS_BOOKS}家`,
      candidates,
      required: contract.required,
      keys,
    };
  }

  const requiredMaps = new Map(contract.required.map(row => [row, referenceBookRows(row)]));
  const vectors = [];
  let monotonicFailure = false;
  for (const bookmakerKey of keys) {
    let equivalentWin = 0;
    let equivalentLoss = 0;
    let equivalentPush = 0;
    const observedTimes = [];
    const legWeight = 1 / contract.legs.length;
    for (const leg of contract.legs) {
      let fullWin;
      let winOrExact;
      if (leg.integer) {
        const full = requiredMaps.get(leg.fullWin)?.get(bookmakerKey);
        const inclusive = requiredMaps.get(leg.winOrExact)?.get(bookmakerKey);
        fullWin = Number(full?.probability);
        winOrExact = Number(inclusive?.probability);
        observedTimes.push(full?.observedTime, inclusive?.observedTime);
        if (!Number.isFinite(fullWin) || !Number.isFinite(winOrExact) || winOrExact + 1e-6 < fullWin) {
          monotonicFailure = true;
          equivalentWin = Number.NaN;
          break;
        }
      } else {
        const direct = requiredMaps.get(leg.direct)?.get(bookmakerKey);
        fullWin = Number(direct?.probability);
        winOrExact = fullWin;
        observedTimes.push(direct?.observedTime);
      }
      const exact = Math.max(0, winOrExact - fullWin);
      const fullLoss = Math.max(0, 1 - winOrExact);
      const exactFraction = exactOutcomeFraction(parsed);
      equivalentWin += legWeight * (fullWin + exact * Math.max(0, exactFraction));
      equivalentLoss += legWeight * (fullLoss + exact * Math.max(0, -exactFraction));
      equivalentPush += legWeight * exact * (1 - Math.abs(exactFraction));
    }
    const coverage = equivalentWin + equivalentLoss + equivalentPush;
    if (![equivalentWin, equivalentLoss, equivalentPush, coverage].every(Number.isFinite)
      || equivalentWin < -1e-9 || equivalentLoss < -1e-9 || equivalentPush < -1e-9
      || Math.abs(coverage - 1) > 1e-8) continue;
    const oldest = Math.min(...observedTimes.filter(Number.isFinite));
    const newest = Math.max(...observedTimes.filter(Number.isFinite));
    vectors.push({
      bookmakerKey,
      observedAt: new Date(newest).toISOString(),
      oldestObservedAt: new Date(oldest).toISOString(),
      equivalentWin: Number(equivalentWin.toFixed(10)),
      equivalentLoss: Number(equivalentLoss.toFixed(10)),
      equivalentPush: Number(equivalentPush.toFixed(10)),
      effectiveWinProbability: equivalentWin + equivalentLoss > 0 ? Number((equivalentWin / (equivalentWin + equivalentLoss)).toFixed(10)) : null,
      settlementRate: Number((equivalentWin + equivalentLoss).toFixed(10)),
    });
  }
  if (monotonicFailure || vectors.length < MINIMUM_CONSENSUS_BOOKS) {
    return {
      attempted: true,
      eligible: false,
      reason: monotonicFailure ? '相鄰半分盤機率不單調，無法建立有效的勝／走／負分布' : `有效共同莊家僅${vectors.length}家，至少需要${MINIMUM_CONSENSUS_BOOKS}家`,
      candidates,
      required: contract.required,
      keys,
    };
  }

  const allOldest = vectors.map(row => Date.parse(row.oldestObservedAt));
  const allNewest = vectors.map(row => Date.parse(row.observedAt));
  const oldest = Math.min(...allOldest);
  const newest = Math.max(...allNewest);
  const freshnessMaxMs = verifiedAtMs - oldest;
  const futureSkewMs = newest - verifiedAtMs;
  const spanMs = newest - oldest;
  if (freshnessMaxMs < -MAX_REFERENCE_QUOTE_FUTURE_SKEW_MS
    || futureSkewMs > MAX_REFERENCE_QUOTE_FUTURE_SKEW_MS
    || freshnessMaxMs > MAX_REFERENCE_QUOTE_AGE_MS
    || spanMs > MAX_CONSENSUS_QUOTE_SPAN_MS) {
    return { attempted: true, eligible: false, reason: '獨立市場報價超過5分鐘、來自未來，或完整相鄰盤時間差超過3分鐘', candidates, required: contract.required, keys };
  }

  const effective = vectors.map(row => row.effectiveWinProbability);
  const minimum = Math.min(...effective);
  const maximum = Math.max(...effective);
  const spread = maximum - minimum;
  const mad = medianAbsoluteDeviation(effective);
  if (spread > MAX_REFERENCE_PROBABILITY_SPREAD || mad > MAX_REFERENCE_PROBABILITY_MAD) {
    return { attempted: true, eligible: false, reason: '逐莊勝／走／負推導分散超過安全門檻', candidates, required: contract.required, keys };
  }

  const ordered = [...vectors].sort((a, b) => a.effectiveWinProbability - b.effectiveWinProbability);
  const middle = Math.floor(ordered.length / 2);
  const centreRows = ordered.length % 2 ? [ordered[middle]] : [ordered[middle - 1], ordered[middle]];
  const centre = centreRows.reduce((result, row) => ({
    equivalentWin: result.equivalentWin + row.equivalentWin / centreRows.length,
    equivalentLoss: result.equivalentLoss + row.equivalentLoss / centreRows.length,
    equivalentPush: result.equivalentPush + row.equivalentPush / centreRows.length,
  }), { equivalentWin: 0, equivalentLoss: 0, equivalentPush: 0 });
  const centreResolved = centre.equivalentWin + centre.equivalentLoss;
  return {
    attempted: true,
    eligible: true,
    candidates,
    required: contract.required,
    keys,
    eventId: eventIds[0],
    vectors,
    vector: {
      equivalentWin: centre.equivalentWin,
      equivalentLoss: centre.equivalentLoss,
      equivalentPush: centre.equivalentPush,
      effectiveWinProbability: centreResolved > 0 ? centre.equivalentWin / centreResolved : null,
      settlementRate: centreResolved,
    },
    consensusTimeSpanMs: spanMs,
    consensusFreshnessMaxMs: freshnessMaxMs,
    consensusOldestObservedAt: new Date(oldest).toISOString(),
    consensusNewestObservedAt: new Date(newest).toISOString(),
    probabilityMinimum: minimum,
    probabilityMaximum: maximum,
    probabilitySpread: spread,
    probabilityMad: mad,
  };
}

function payoffVerification(row, actualSource, contractKey, evidence) {
  const match = evidence.required?.[0] || evidence.candidates?.[0] || null;
  const referenceSource = match ? source(match, contractKey) : null;
  const sources = [actualSource, referenceSource].filter(Boolean);
  const eligible = evidence.eligible === true;
  const expiresAt = Number.isFinite(Date.parse(evidence.consensusOldestObservedAt || ''))
    ? new Date(Date.parse(evidence.consensusOldestObservedAt) + MAX_REFERENCE_QUOTE_AGE_MS).toISOString()
    : null;
  return {
    version: MARKET_VERIFICATION_V2_VERSION,
    verified: eligible,
    exactSecondSourceFound: sources.length >= 2 && new Set(sources.map(item => item.independentGroup)).size >= 2,
    sources,
    policyStatus: eligible ? 'THREE_BOOK_FRESH_SYNCHRONIZED_PAYOFF_VECTOR_CONSENSUS'
      : sources.length >= 2 ? 'PAYOFF_VECTOR_SOURCE_INELIGIBLE' : 'PAYOFF_VECTOR_SOURCE_NOT_FOUND',
    reference: rowDetails(match),
    referenceOpposite: null,
    referencePairMargin: null,
    referenceProbabilityComplementError: null,
    referenceNoVigProbability: eligible ? evidence.vector.effectiveWinProbability : null,
    referenceRobustProbability: eligible ? evidence.vector.effectiveWinProbability : null,
    referencePayoffVector: eligible ? evidence.vector : null,
    referenceBookPayoffVectors: eligible ? evidence.vectors : [],
    referenceConsensusBookCount: eligible ? evidence.vectors.length : Number(evidence.keys?.length || 0),
    referenceConsensusBookKeys: eligible ? evidence.vectors.map(item => item.bookmakerKey).sort() : [],
    referenceConsensusSnapshotId: eligible ? `THE_ODDS_API:${evidence.eventId}:PAYOFF:${contractKey}:${evidence.vectors.map(item => item.bookmakerKey).sort().join(',')}:${evidence.consensusNewestObservedAt}` : null,
    referenceConsensusTimeSpanMs: eligible ? evidence.consensusTimeSpanMs : null,
    referenceConsensusFreshnessMaxMs: eligible ? evidence.consensusFreshnessMaxMs : null,
    referenceConsensusExpiresAt: eligible ? expiresAt : null,
    referenceProbabilitySpread: eligible ? Number(evidence.probabilitySpread.toFixed(10)) : null,
    referenceProbabilityMad: eligible ? Number(evidence.probabilityMad.toFixed(10)) : null,
    referenceProbabilityRange: eligible ? { minimum: evidence.probabilityMinimum, maximum: evidence.probabilityMaximum } : null,
    referencePriorEligible: eligible,
    referencePriorSource: eligible ? 'THE_ODDS_API_PAYOFF_VECTOR_THREE_BOOK_NO_VIG' : null,
    priorIneligibleReason: eligible ? '' : evidence.reason || '獨立市場勝／走／負向量不可用',
  };
}

export function applyIndependentMarketVerification(
  actualMarkets,
  referenceMarkets,
  toleranceMs = MAX_ACTUAL_REFERENCE_DISTANCE_MS,
  options = {},
) {
  const references = Array.isArray(referenceMarkets) ? referenceMarkets : [];
  const verifiedAtMs = evaluationTime(options && typeof options === 'object' && !Array.isArray(options) ? options.now : options);
  return (Array.isArray(actualMarkets) ? actualMarkets : []).map(row => {
    if (row?.sourceType !== 'ACTUAL_TW_CREDIT') return row;
    const contractKey = sideSignature(row);
    if (!contractKey) return { ...row, marketVerification: null };

    const actualSource = source(row, contractKey);
    const payoffEvidence = buildPayoffEvidence(row, references, toleranceMs, verifiedAtMs);
    if (payoffEvidence.attempted) {
      return {
        ...row,
        marketVerification: payoffVerification(row, actualSource, contractKey, payoffEvidence),
      };
    }
    const match = bestExactMatch(row, references, toleranceMs);
    const opposite = oppositeReference(match, references, toleranceMs);
    const referenceSource = match ? source(match, contractKey) : null;
    const sources = [actualSource, referenceSource].filter(Boolean);
    const groups = new Set(sources.map(item => item.independentGroup));
    const exactSecondSourceFound = sources.length >= 2 && groups.size >= 2;

    const matchImplied = impliedProbability(match?.water);
    const oppositeImplied = impliedProbability(opposite?.water);
    const pairTotal = Number.isFinite(matchImplied) && Number.isFinite(oppositeImplied)
      ? matchImplied + oppositeImplied
      : null;
    const pricePairProbability = pairTotal > 0 ? matchImplied / pairTotal : null;
    const consensusProbability = Number.isFinite(Number(match?.referenceNoVigProbability))
      ? Number(match.referenceNoVigProbability)
      : pricePairProbability;
    const consensusRobustProbability = Number.isFinite(Number(match?.referenceRobustProbability))
      ? Number(match.referenceRobustProbability)
      : Number.isFinite(consensusProbability) ? Math.max(0, consensusProbability - 0.0075) : null;
    const oppositeConsensusProbability = Number.isFinite(Number(opposite?.referenceNoVigProbability))
      ? Number(opposite.referenceNoVigProbability)
      : null;
    const consensusBookCount = Number.isFinite(Number(match?.consensusBookCount)) ? Number(match.consensusBookCount) : 0;
    const oppositeBookCount = Number.isFinite(Number(opposite?.consensusBookCount)) ? Number(opposite.consensusBookCount) : 0;
    const matchBookKeys = bookKeys(match);
    const oppositeBookKeys = bookKeys(opposite);
    const sameBookSnapshot = matchBookKeys.length >= MINIMUM_CONSENSUS_BOOKS
      && sameStrings(matchBookKeys, oppositeBookKeys)
      && consensusBookCount === matchBookKeys.length
      && oppositeBookCount === oppositeBookKeys.length;
    const sameSnapshot = Boolean(clean(match?.consensusSnapshotId)
      && clean(opposite?.consensusSnapshotId)
      && clean(match.consensusSnapshotId) === clean(opposite.consensusSnapshotId));
    const quoteSpanMs = finiteNumber(match?.consensusTimeSpanMs);
    const oppositeQuoteSpanMs = finiteNumber(opposite?.consensusTimeSpanMs);
    const signedFreshnessMaxMs = finiteNumber(match?.consensusFreshnessMaxMs);
    const oppositeSignedFreshnessMaxMs = finiteNumber(opposite?.consensusFreshnessMaxMs);
    const matchOldestObservedMs = Date.parse(match?.consensusOldestObservedAt || '');
    const oppositeOldestObservedMs = Date.parse(opposite?.consensusOldestObservedAt || '');
    const freshnessMaxMs = Number.isFinite(matchOldestObservedMs) ? verifiedAtMs - matchOldestObservedMs : Number.NaN;
    const oppositeFreshnessMaxMs = Number.isFinite(oppositeOldestObservedMs) ? verifiedAtMs - oppositeOldestObservedMs : Number.NaN;
    const probabilitySpread = finiteNumber(match?.referenceProbabilitySpread);
    const oppositeProbabilitySpread = finiteNumber(opposite?.referenceProbabilitySpread);
    const probabilityMad = finiteNumber(match?.referenceProbabilityMad);
    const oppositeProbabilityMad = finiteNumber(opposite?.referenceProbabilityMad);
    const probabilityComplementError = Number.isFinite(consensusProbability) && Number.isFinite(oppositeConsensusProbability)
      ? Math.abs(consensusProbability + oppositeConsensusProbability - 1)
      : null;
    const timestampEvidenceValid = [
      quoteSpanMs,
      oppositeQuoteSpanMs,
      signedFreshnessMaxMs,
      oppositeSignedFreshnessMaxMs,
      freshnessMaxMs,
      oppositeFreshnessMaxMs,
    ].every(Number.isFinite)
      && quoteSpanMs <= MAX_CONSENSUS_QUOTE_SPAN_MS
      && oppositeQuoteSpanMs <= MAX_CONSENSUS_QUOTE_SPAN_MS
      && signedFreshnessMaxMs <= MAX_REFERENCE_QUOTE_AGE_MS
      && oppositeSignedFreshnessMaxMs <= MAX_REFERENCE_QUOTE_AGE_MS
      && freshnessMaxMs >= -MAX_REFERENCE_QUOTE_FUTURE_SKEW_MS
      && oppositeFreshnessMaxMs >= -MAX_REFERENCE_QUOTE_FUTURE_SKEW_MS
      && freshnessMaxMs <= MAX_REFERENCE_QUOTE_AGE_MS
      && oppositeFreshnessMaxMs <= MAX_REFERENCE_QUOTE_AGE_MS;
    const dispersionValid = [probabilitySpread, oppositeProbabilitySpread, probabilityMad, oppositeProbabilityMad].every(Number.isFinite)
      && probabilitySpread <= MAX_REFERENCE_PROBABILITY_SPREAD
      && oppositeProbabilitySpread <= MAX_REFERENCE_PROBABILITY_SPREAD
      && probabilityMad <= MAX_REFERENCE_PROBABILITY_MAD
      && oppositeProbabilityMad <= MAX_REFERENCE_PROBABILITY_MAD;
    const pairMarginValid = Number.isFinite(pairTotal) && pairTotal >= 0.98 && pairTotal <= 1.12;
    const priorEligible = Boolean(
      isBinaryNoPush(row)
      && match
      && opposite
      && providerGroup(match) === 'THE_ODDS_API'
      && consensusBookCount >= MINIMUM_CONSENSUS_BOOKS
      && sameBookSnapshot
      && sameSnapshot
      && match.referenceEvidenceEligible === true
      && opposite.referenceEvidenceEligible === true
      && timestampEvidenceValid
      && dispersionValid
      && pairMarginValid
      && Number.isFinite(consensusProbability)
      && Number.isFinite(consensusRobustProbability)
      && consensusProbability > 0
      && consensusProbability < 1
      && consensusRobustProbability > 0
      && consensusRobustProbability <= consensusProbability
      && probabilityComplementError != null
      && probabilityComplementError <= 1e-6
    );

    const priorIneligibleReason = priorEligible ? ''
      : !isBinaryNoPush(row) ? '整數／拆分盤含走水或部分輸贏，單一去水機率不可作先驗'
        : !match || providerGroup(match) !== 'THE_ODDS_API' ? '缺少5分鐘內獨立國際市場同合約價格'
          : !opposite ? '缺少同一賽事、同一快照的獨立市場反方向價格，無法去水'
            : consensusBookCount < MINIMUM_CONSENSUS_BOOKS || oppositeBookCount < MINIMUM_CONSENSUS_BOOKS ? `獨立市場同合約僅${Math.min(consensusBookCount, oppositeBookCount)}家不同莊家，至少需要${MINIMUM_CONSENSUS_BOOKS}家`
              : !sameBookSnapshot || !sameSnapshot ? '正反方向不是同一組莊家或同一時間快照'
                : !timestampEvidenceValid ? '獨立市場報價超過5分鐘或三家報價時間差超過3分鐘'
                  : !dispersionValid ? '獨立市場去水機率分散超過安全門檻'
                    : !pairMarginValid ? '獨立市場正反價格水位結構異常'
                      : probabilityComplementError == null || probabilityComplementError > 1e-6 ? '獨立市場正反方向中心機率未互補'
                        : '獨立市場先驗不可用';

    return {
      ...row,
      marketVerification: {
        version: MARKET_VERIFICATION_V2_VERSION,
        verified: priorEligible,
        exactSecondSourceFound,
        sources,
        policyStatus: priorEligible ? 'THREE_BOOK_FRESH_SYNCHRONIZED_EXACT_CONTRACT_CONSENSUS'
          : exactSecondSourceFound ? 'EXACT_SECOND_SOURCE_INELIGIBLE' : 'EXACT_SECOND_SOURCE_NOT_FOUND',
        reference: rowDetails(match),
        referenceOpposite: rowDetails(opposite),
        referencePairMargin: pairTotal == null ? null : pairTotal - 1,
        referenceProbabilityComplementError: probabilityComplementError,
        referenceNoVigProbability: priorEligible ? consensusProbability : null,
        referenceRobustProbability: priorEligible ? consensusRobustProbability : null,
        referenceConsensusBookCount: Math.min(consensusBookCount, oppositeBookCount),
        referenceConsensusBookKeys: sameBookSnapshot ? matchBookKeys : [],
        referenceConsensusSnapshotId: sameSnapshot ? clean(match?.consensusSnapshotId) : null,
        referenceConsensusTimeSpanMs: timestampEvidenceValid ? Math.max(quoteSpanMs, oppositeQuoteSpanMs) : null,
        referenceConsensusFreshnessMaxMs: timestampEvidenceValid ? Math.max(signedFreshnessMaxMs, oppositeSignedFreshnessMaxMs) : null,
        referenceConsensusExpiresAt: Number.isFinite(matchOldestObservedMs) && Number.isFinite(oppositeOldestObservedMs)
          ? new Date(Math.min(matchOldestObservedMs, oppositeOldestObservedMs) + MAX_REFERENCE_QUOTE_AGE_MS).toISOString()
          : null,
        referenceProbabilitySpread: dispersionValid ? Math.max(probabilitySpread, oppositeProbabilitySpread) : null,
        referenceProbabilityMad: dispersionValid ? Math.max(probabilityMad, oppositeProbabilityMad) : null,
        referenceProbabilityRange: priorEligible ? {
          minimum: Number(match.referenceProbabilityMinimum),
          maximum: Number(match.referenceProbabilityMaximum),
        } : null,
        referencePriorEligible: priorEligible,
        referencePriorSource: priorEligible ? 'THE_ODDS_API_EXACT_BINARY_THREE_BOOK_NO_VIG' : null,
        priorIneligibleReason,
      },
    };
  });
}
