import { hasActualWater, MARKET_ORDER, parseTaiwanLine, validateMarketPair } from './markets.js';

export const DIRECTION_SLOT_CONTRACT_VERSION = 'BASEBALL-EIGHT-DIRECTION-SLOTS-v1.0.0';

export const DIRECTION_SLOT_DEFINITIONS = Object.freeze([
  Object.freeze({ slotIndex: 1, slotId: 'FULL_RUNLINE_HOME', market: '全場讓分', direction: 'HOME', segment: 'FULL', marketType: 'RUNLINE', directionLabel: '主隊' }),
  Object.freeze({ slotIndex: 2, slotId: 'FULL_RUNLINE_AWAY', market: '全場讓分', direction: 'AWAY', segment: 'FULL', marketType: 'RUNLINE', directionLabel: '客隊' }),
  Object.freeze({ slotIndex: 3, slotId: 'FULL_TOTAL_OVER', market: '全場大小', direction: 'OVER', segment: 'FULL', marketType: 'TOTAL', directionLabel: '大分' }),
  Object.freeze({ slotIndex: 4, slotId: 'FULL_TOTAL_UNDER', market: '全場大小', direction: 'UNDER', segment: 'FULL', marketType: 'TOTAL', directionLabel: '小分' }),
  Object.freeze({ slotIndex: 5, slotId: 'FIRST5_RUNLINE_HOME', market: '上半讓分', direction: 'HOME', segment: 'FIRST5', marketType: 'RUNLINE', directionLabel: '主隊' }),
  Object.freeze({ slotIndex: 6, slotId: 'FIRST5_RUNLINE_AWAY', market: '上半讓分', direction: 'AWAY', segment: 'FIRST5', marketType: 'RUNLINE', directionLabel: '客隊' }),
  Object.freeze({ slotIndex: 7, slotId: 'FIRST5_TOTAL_OVER', market: '上半大小', direction: 'OVER', segment: 'FIRST5', marketType: 'TOTAL', directionLabel: '大分' }),
  Object.freeze({ slotIndex: 8, slotId: 'FIRST5_TOTAL_UNDER', market: '上半大小', direction: 'UNDER', segment: 'FIRST5', marketType: 'TOTAL', directionLabel: '小分' }),
]);

const clean = value => String(value || '').trim();
const normalizedName = value => clean(value).toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]/g, '');
const finiteOrNull = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);

function teamDirection(parsed, game = {}) {
  const team = normalizedName(parsed?.team);
  if (!team) return null;
  const homeNames = [game?.home, game?.homeEnglish].map(normalizedName).filter(Boolean);
  const awayNames = [game?.away, game?.awayEnglish].map(normalizedName).filter(Boolean);
  if (homeNames.some(name => name === team)) return 'HOME';
  if (awayNames.some(name => name === team)) return 'AWAY';
  return null;
}

export function directionIdentityForRow(row, game = {}) {
  const parsed = parseTaiwanLine(row?.pick);
  if (!parsed?.valid) return null;
  if (parsed.isTotal) return parsed.isOver ? 'OVER' : parsed.isUnder ? 'UNDER' : null;
  return teamDirection(parsed, game);
}

function slotFor(market, direction) {
  return DIRECTION_SLOT_DEFINITIONS.find(slot => slot.market === market && slot.direction === direction) || null;
}

function publicCoverageRow(row) {
  return {
    market: row?.market || null,
    pick: clean(row?.pick) || null,
    water: finiteOrNull(row?.water),
    waterEstimated: row?.waterEstimated === true,
    waterMissing: row?.waterMissing === true,
    sourceType: row?.sourceType || null,
    provider: row?.provider || null,
    lineAsOf: row?.lineAsOf || null,
    readerVersion: row?.readerVersion || null,
    readerGameMarketHash: row?.readerGameMarketHash || null,
    readerPayloadHash: row?.readerPayloadHash || null,
    readerRawBoardHash: row?.readerRawBoardHash || null,
    readerBoardDate: row?.readerBoardDate || null,
    integrityError: row?.integrityError || null,
    sourceTemplateVersion: row?.sourceTemplateVersion || null,
    authorizationStatus: row?.authorizationStatus || null,
    integrityOrigin: row?.integrityOrigin || null,
    marketSignatureVersion: row?.marketSignatureVersion || null,
    marketSignature: row?.marketSignature || null,
    directionSlotId: row?.directionSlotId || null,
    direction: row?.direction || null,
  };
}

function readerLineage(readerProvenance) {
  if (!readerProvenance || typeof readerProvenance !== 'object' || Array.isArray(readerProvenance)) return {};
  return {
    readerVersion: clean(readerProvenance.readerVersion) || null,
    readerPayloadHash: clean(readerProvenance.payloadHash) || null,
    readerRawBoardHash: clean(readerProvenance.rawBoardHash) || null,
    readerGameMarketHash: clean(readerProvenance.readerGameMarketHash) || null,
    readerBoardDate: clean(readerProvenance.boardDate) || null,
    lineAsOf: clean(readerProvenance.lineAsOf) || null,
    sourceType: 'ACTUAL_TW_CREDIT',
    provider: 'TAI888_READER_AUTO',
    authorizationStatus: clean(readerProvenance.authorizationStatus) || null,
    integrityOrigin: clean(readerProvenance.integrityOrigin) || null,
    readerProvenanceSignatureVersion: clean(readerProvenance.provenanceSignatureVersion) || null,
    readerProvenanceSignature: clean(readerProvenance.provenanceSignature) || null,
  };
}

/**
 * Validate each market independently. Only rows from an OPEN market may enter
 * EV evaluation; malformed or duplicate markets remain explicit BLOCKED slots.
 */
export function assessEightDirectionMarketCoverage(markets, game = {}) {
  const source = Array.isArray(markets) ? markets : [];
  const coverage = MARKET_ORDER.map(market => {
    const rows = source.filter(row => row?.market === market);
    const integrityErrors = rows.map(row => clean(row?.integrityError)).filter(Boolean);
    if (!rows.length) return { market, status: 'UNOPENED', rowCount: 0, errors: [], rows: [] };

    const errors = [...integrityErrors, ...validateMarketPair(market, rows)];
    const identified = rows.map(row => ({ row, direction: directionIdentityForRow(row, game) }));
    if (identified.some(item => !item.direction)) errors.push('\u76e4口方向無法對應本場主客隊\uff0f大小方向');
    const directionIds = identified.map(item => item.direction).filter(Boolean);
    if (new Set(directionIds).size !== directionIds.length) errors.push('\u540c市場方向重複');
    if (identified.some(item => !hasActualWater(item.row?.water))) errors.push('\u5df2開盤方向必須有合法水位');

    const uniqueErrors = [...new Set(errors)];
    if (uniqueErrors.length) {
      return {
        market,
        status: 'BLOCKED',
        rowCount: rows.length,
        errors: uniqueErrors,
        rows: rows.map(publicCoverageRow),
      };
    }

    const taggedRows = identified.map(({ row, direction }) => {
      const slot = slotFor(market, direction);
      return { ...row, direction, directionSlotId: slot?.slotId || null, directionSlotIndex: slot?.slotIndex || null };
    });
    return {
      market,
      status: 'OPEN',
      rowCount: taggedRows.length,
      errors: [],
      rows: taggedRows,
    };
  });
  return {
    version: DIRECTION_SLOT_CONTRACT_VERSION,
    markets: coverage,
    validRows: coverage.filter(item => item.status === 'OPEN').flatMap(item => item.rows),
    blockedMarkets: coverage.filter(item => item.status === 'BLOCKED').map(item => item.market),
    unopenedMarkets: coverage.filter(item => item.status === 'UNOPENED').map(item => item.market),
  };
}

function qaForResult(row) {
  const reasons = [
    ...(Array.isArray(row?.evCalibration?.reasons) ? row.evCalibration.reasons : []),
    ...(Array.isArray(row?.scoreAudit?.baseQa?.failures) ? row.scoreAudit.baseQa.failures : []),
    ...(Array.isArray(row?.scoreAudit?.plausibility?.failures) ? row.scoreAudit.plausibility.failures : []),
    ...(row?.integrityMessage ? [row.integrityMessage] : []),
  ].map(clean).filter(Boolean);
  return {
    status: row?.scoreAudit?.ok === true && row?.integrityWarning !== true ? 'PASS' : 'BLOCK',
    reasons: [...new Set(reasons)],
  };
}

export function buildEightDirectionSlots({ analysis, marketCoverage, game = {}, readerProvenance = null } = {}) {
  const coverageRows = Array.isArray(marketCoverage?.markets) ? marketCoverage.markets : [];
  const results = Array.isArray(analysis?.results) ? analysis.results : [];
  const lineage = readerLineage(readerProvenance);
  const slots = DIRECTION_SLOT_DEFINITIONS.map(definition => {
    const coverage = coverageRows.find(item => item.market === definition.market)
      || { market: definition.market, status: 'UNOPENED', rowCount: 0, errors: [], rows: [] };
    const result = results.find(row => row?.directionSlotId === definition.slotId)
      || results.find(row => row?.market === definition.market && directionIdentityForRow(row, game) === definition.direction);
    const modelEV = finiteOrNull(result?.modelEV ?? result?.rawWeightedEV ?? result?.weightedEV);
    const robustEV = finiteOrNull(result?.robustEV ?? result?.rawRobustEV);
    // R is a downstream conservative layer. A temporary R failure must be
    // visible as QA, but may never erase an otherwise complete raw model W.
    const mathematicallyComplete = Boolean(result)
      && modelEV != null
      && Number(result?.distributionCoverage) >= 1 - 1e-9
      && result?.evDoubleCheck?.passed === true
      && result?.mathematicalIntegrityPassed !== false;

    if (coverage.status === 'OPEN' && mathematicallyComplete) {
      return {
        ...result,
        ...lineage,
        ...definition,
        status: 'CALCULATED',
        coverageStatus: 'OPEN',
        coverageErrors: [],
        modelEV,
        weightedEV: modelEV,
        rawWeightedEV: modelEV,
        robustEV,
        rawRobustEV: robustEV,
        qa: robustEV == null
          ? { status: 'BLOCK', reasons: [...new Set([...qaForResult(result).reasons, '穩健EV（R）未成功產生；模型EV（W）保留'])] }
          : qaForResult(result),
        distributionId: result?.distributionId || analysis?.distributionId || null,
        distributionHash: result?.distributionHash || analysis?.distributionHash || null,
      };
    }

    const matchingInput = (coverage.rows || []).find(row => row?.directionSlotId === definition.slotId)
      || (coverage.rows || []).find(row => directionIdentityForRow(row, game) === definition.direction)
      || (coverage.rows || []).find(row => clean(row?.integrityError))
      || null;
    const status = coverage.status === 'UNOPENED' ? 'UNOPENED' : 'BLOCKED';
    const errors = coverage.status === 'OPEN'
      ? ['\u9010分比\uff0f逐腿EV數學完整性未通過']
      : coverage.errors || [];
    return {
      ...(matchingInput || {}),
      ...lineage,
      ...definition,
      status,
      coverageStatus: coverage.status,
      coverageErrors: [...new Set(errors)],
      pick: clean(matchingInput?.pick) || '',
      water: finiteOrNull(matchingInput?.water),
      modelEV: null,
      weightedEV: null,
      rawWeightedEV: null,
      robustEV: null,
      rawRobustEV: null,
      qa: { status: status === 'UNOPENED' ? 'UNOPENED' : 'BLOCK', reasons: [...new Set(errors)] },
      score: null,
      formulaDiagnosticScore: null,
      rankingQualified: false,
      betEligible: false,
      distributionId: analysis?.distributionId || null,
      distributionHash: analysis?.distributionHash || null,
    };
  });

  if (slots.length !== 8 || new Set(slots.map(slot => slot.slotId)).size !== 8) {
    throw new Error('\u516b方向輸出契約不完整');
  }
  return slots;
}

export function attachEightDirectionContract(analysis, marketCoverage, game = {}, readerProvenance = null) {
  const directionSlots = buildEightDirectionSlots({ analysis, marketCoverage, game, readerProvenance });
  const lineage = readerLineage(readerProvenance);
  return {
    ...analysis,
    readerVersion: lineage.readerVersion || analysis?.readerVersion || null,
    readerPayloadHash: lineage.readerPayloadHash || analysis?.readerPayloadHash || null,
    readerRawBoardHash: lineage.readerRawBoardHash || analysis?.readerRawBoardHash || null,
    readerGameMarketHash: lineage.readerGameMarketHash || analysis?.readerGameMarketHash || null,
    readerBoardDate: lineage.readerBoardDate || analysis?.readerBoardDate || null,
    readerProvenance: readerProvenance || analysis?.readerProvenance || null,
    directionSlotContractVersion: DIRECTION_SLOT_CONTRACT_VERSION,
    marketCoverage: {
      version: marketCoverage?.version || DIRECTION_SLOT_CONTRACT_VERSION,
      markets: (marketCoverage?.markets || []).map(item => ({
        market: item.market,
        status: item.status,
        rowCount: item.rowCount,
        errors: item.errors || [],
        rows: (item.rows || []).map(publicCoverageRow),
      })),
    },
    directionSlots,
    calculatedDirectionCount: directionSlots.filter(slot => slot.status === 'CALCULATED' && Number.isFinite(slot.modelEV)).length,
    directionSlotCount: 8,
  };
}
