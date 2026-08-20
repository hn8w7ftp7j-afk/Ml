import { hasActualWater, parseTaiwanLine } from './markets.js';

export const MARKET_VERIFICATION_V2_VERSION = 'INDEPENDENT-EXACT-CONTRACT-PRIOR-2026-08-v2.0.0';

const normalize = value => String(value || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
const clean = value => String(value || '').trim();

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
    .filter(reference => {
      const sameEvent = clean(match.providerEventId) && clean(reference.providerEventId)
        ? clean(match.providerEventId) === clean(reference.providerEventId)
        : true;
      return sameEvent && timeDistance(match, reference) <= toleranceMs;
    })
    .sort((left, right) => timeDistance(match, left) - timeDistance(match, right))[0] || null;
}

export function applyIndependentMarketVerification(actualMarkets, referenceMarkets, toleranceMs = 30 * 60 * 1000) {
  const references = Array.isArray(referenceMarkets) ? referenceMarkets : [];
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
    const verified = sources.length >= 2 && groups.size >= 2;

    const matchImplied = impliedProbability(match?.water);
    const oppositeImplied = impliedProbability(opposite?.water);
    const pairTotal = Number.isFinite(matchImplied) && Number.isFinite(oppositeImplied)
      ? matchImplied + oppositeImplied
      : null;
    const noVigProbability = pairTotal > 0 ? matchImplied / pairTotal : null;
    const priorEligible = Boolean(
      isBinaryNoPush(row)
      && match
      && opposite
      && providerGroup(match) === 'THE_ODDS_API'
      && Number.isFinite(noVigProbability),
    );

    return {
      ...row,
      marketVerification: {
        version: MARKET_VERIFICATION_V2_VERSION,
        verified,
        sources,
        policyStatus: verified ? 'TWO_INDEPENDENT_EXACT_CONTRACTS' : 'EXACT_SECOND_SOURCE_NOT_FOUND',
        reference: rowDetails(match),
        referenceOpposite: rowDetails(opposite),
        referencePairMargin: pairTotal == null ? null : pairTotal - 1,
        referenceNoVigProbability: priorEligible ? noVigProbability : null,
        referencePriorEligible: priorEligible,
        referencePriorSource: priorEligible ? 'THE_ODDS_API_EXACT_BINARY_NO_VIG' : null,
        priorIneligibleReason: priorEligible ? ''
          : !isBinaryNoPush(row) ? '整數／拆分盤含走水或部分輸贏，單一去水機率不可作先驗'
            : providerGroup(match) !== 'THE_ODDS_API' ? '缺少獨立國際市場同合約價格'
              : !opposite ? '缺少獨立市場反方向價格，無法去水'
                : '獨立市場先驗不可用',
      },
    };
  });
}
