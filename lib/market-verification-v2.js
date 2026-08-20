import { hasActualWater, parseTaiwanLine } from './markets.js';
import {
  MAX_CONSENSUS_QUOTE_SPAN_MS,
  MAX_REFERENCE_PROBABILITY_MAD,
  MAX_REFERENCE_PROBABILITY_SPREAD,
  MAX_REFERENCE_QUOTE_AGE_MS,
  MAX_REFERENCE_QUOTE_FUTURE_SKEW_MS,
} from './reference-lines.js';

export const MARKET_VERIFICATION_V2_VERSION = 'INDEPENDENT-EXACT-CONTRACT-CONSENSUS-2026-08-v2.2.0';
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
  const side = parsed.isTotal
    ? parsed.isOver ? 'over' : 'under'
    : `${parsed.isGiving ? 'giving' : 'receiving'}:${normalize(parsed.team)}`;
  return `${row.market}|${side}|${parsed.lineText}|${parsed.modifier || ''}`;
}

function familySignature(row) {
  const parsed = parseTaiwanLine(row?.pick);
  if (!parsed.valid) return '';
  return `${row.market}|${parsed.isTotal ? 'total' : 'spread'}|${parsed.lineText}|${parsed.modifier || ''}`;
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
    && Math.abs(Number(parsed.legs[0]) - Math.round(Number(parsed.legs[0]))) > 1e-9);
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
