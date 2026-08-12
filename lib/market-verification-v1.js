import { parseTaiwanLine } from './markets.js';

const normalize = value => String(value || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');

function providerGroup(row) {
  const provider = String(row?.provider || row?.sourceLabel || '').toUpperCase();
  if (provider.includes('TAI888')) return 'TAI888';
  if (provider.includes('THE_ODDS_API')) return 'THE_ODDS_API';
  if (provider.includes('JBOT')) return 'JBOT';
  return provider || '';
}

function signature(row) {
  const parsed = parseTaiwanLine(row?.pick);
  if (!parsed.valid) return '';
  const side = parsed.isTotal
    ? parsed.isOver ? 'over' : 'under'
    : `${parsed.isGiving ? 'giving' : 'receiving'}:${normalize(parsed.team)}`;
  return `${row.market}|${side}|${parsed.lineText}|${parsed.modifier || ''}`;
}

function source(row, contractKey) {
  const provider = String(row?.provider || row?.sourceLabel || '').slice(0, 80);
  const independentGroup = providerGroup(row);
  const observedAt = String(row?.lineAsOf || '').slice(0, 40);
  if (!provider || !independentGroup || !Number.isFinite(Date.parse(observedAt))) return null;
  return { provider, independentGroup, observedAt, contractKey };
}

export function applyIndependentMarketVerification(actualMarkets, referenceMarkets, toleranceMs = 30 * 60 * 1000) {
  const references = Array.isArray(referenceMarkets) ? referenceMarkets : [];
  return (Array.isArray(actualMarkets) ? actualMarkets : []).map(row => {
    if (row?.sourceType !== 'ACTUAL_TW_CREDIT') return row;
    const contractKey = signature(row);
    if (!contractKey) return { ...row, marketVerification: null };

    const actualSource = source(row, contractKey);
    const match = references.find(reference => {
      if (!['REFERENCE', 'INTERNATIONAL'].includes(reference?.sourceType)) return false;
      if (signature(reference) !== contractKey) return false;
      const actualTime = Date.parse(row.lineAsOf || '');
      const referenceTime = Date.parse(reference.lineAsOf || '');
      return Number.isFinite(actualTime)
        && Number.isFinite(referenceTime)
        && Math.abs(actualTime - referenceTime) <= toleranceMs;
    });
    const referenceSource = match ? source(match, contractKey) : null;
    const sources = [actualSource, referenceSource].filter(Boolean);
    const groups = new Set(sources.map(item => item.independentGroup));
    const verified = sources.length >= 2 && groups.size >= 2;

    return {
      ...row,
      marketVerification: {
        verified,
        sources,
        policyStatus: verified ? 'TWO_INDEPENDENT_EXACT_CONTRACTS' : 'EXACT_SECOND_SOURCE_NOT_FOUND',
      },
    };
  });
}
