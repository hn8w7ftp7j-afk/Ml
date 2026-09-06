import { parseTaiwanContract, SETTLEMENT_RULE_VERSION } from '../taiwan-settlement-v9.js';

export const NHL_CONTRACT_VERSION = 'NHL-READER-CONTRACT-v1';

// No Tai888 NHL market has been authenticated in this release. This registry
// must only be changed after examining actual Reader captures and book rules.
// It is server-owned: HTTP request bodies must never supply a manifest.
export const VERIFIED_NHL_MARKET_MANIFEST = Object.freeze([]);

const text = value => typeof value === 'string' && value.trim().length > 0;
const id = value => (typeof value === 'string' && value.trim() !== '')
  || (Number.isSafeInteger(value) && value > 0);
export const nhlFiniteNumber = value => typeof value === 'number' && Number.isFinite(value);
const time = value => text(value) && /(Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;

export function nhlSeasonType(value) {
  return value === 1 || value === 'PRESEASON' ? 'PRESEASON'
    : value === 2 || value === 'REGULAR' ? 'REGULAR'
      : value === 3 || value === 'PLAYOFF' ? 'PLAYOFF' : null;
}

export function nhlGameIdentity(game) {
  return game && game.league === 'NHL' && id(game.gameId) && id(game.awayTeamId)
    && id(game.homeTeamId) && String(game.awayTeamId) !== String(game.homeTeamId)
    ? `NHL:${game.gameId}:${game.awayTeamId}:${game.homeTeamId}` : null;
}

export function nhlContractScopeKey(row) {
  return JSON.stringify([row?.marketType, row?.scoreScope, row?.period ?? null,
    row?.includesOvertime, row?.shootoutRule, row?.voidRuleId, row?.moneylineRuleId ?? null]);
}

function evidenceMatches(entry, row) {
  return entry?.verified === true && entry.book === 'TAI888' && entry.league === 'NHL'
    && text(entry.evidenceVersion) && entry.evidenceVersion === row.evidenceVersion
    && text(entry.evidenceSourceHash) && time(entry.evidenceObservedAt) != null
    && text(entry.ruleSourceUrl) && /^https:\/\//.test(entry.ruleSourceUrl)
    && entry.settlementRuleVersion === SETTLEMENT_RULE_VERSION
    && nhlContractScopeKey(entry) === nhlContractScopeKey(row);
}

/**
 * Validate a future authenticated Reader quote without inventing available
 * NHL markets. TOTAL/SPREAD are capabilities of the shared settlement engine,
 * not a claim that Tai888 offers those scopes. MONEYLINE needs its own rule.
 * Numeric strings, missing scores, unknown OT/SO/void rules never become zero.
 */
export function validateNhlMarket(row, {
  manifest = VERIFIED_NHL_MARKET_MANIFEST, game, now = Date.now(), maxAgeMs = null,
} = {}) {
  const errors = [];
  if (!row || typeof row !== 'object') return { ok: false, status: 'BLOCK', errors: ['MARKET_MISSING'], contract: null };
  if (!nhlFiniteNumber(now)) errors.push('VALIDATION_TIME_INVALID');
  if (!nhlGameIdentity(row)) errors.push('NHL_GAME_IDENTITY_INVALID');
  if (game && (!nhlGameIdentity(game) || nhlGameIdentity(game) !== nhlGameIdentity(row))) errors.push('NHL_GAME_IDENTITY_MISMATCH');
  if (row.book !== 'TAI888') errors.push('BOOK_NOT_TAI888');
  for (const field of ['marketId', 'lineVersion', 'sourceHash', 'evidenceVersion', 'voidRuleId']) {
    if (!text(row[field])) errors.push(`${field.toUpperCase()}_MISSING`);
  }
  if (time(row.observedAt) == null) errors.push('READER_TIMESTAMP_INVALID');
  else if (nhlFiniteNumber(now) && Date.parse(row.observedAt) > now) errors.push('READER_TIMESTAMP_IN_FUTURE');
  if (maxAgeMs != null && (!nhlFiniteNumber(maxAgeMs) || maxAgeMs < 0)) errors.push('READER_MAX_AGE_INVALID');
  else if (maxAgeMs != null && time(row.observedAt) != null && now - Date.parse(row.observedAt) > maxAgeMs) errors.push('READER_QUOTE_STALE');
  if (!['TOTAL', 'SPREAD', 'MONEYLINE'].includes(row.marketType)) errors.push('MARKET_TYPE_UNKNOWN');
  if (!['REGULATION', 'PERIOD', 'GAME'].includes(row.scoreScope)) errors.push('SCORE_SCOPE_UNKNOWN');
  if (typeof row.includesOvertime !== 'boolean') errors.push('OVERTIME_RULE_UNKNOWN');
  if (!['EXCLUDED', 'OFFICIAL_ONE_GOAL'].includes(row.shootoutRule)) errors.push('SHOOTOUT_RULE_UNKNOWN');
  if (row.scoreScope === 'PERIOD' && ![1, 2, 3].includes(row.period)) errors.push('PERIOD_UNKNOWN');
  if (row.scoreScope !== 'PERIOD' && row.period != null) errors.push('PERIOD_SCOPE_CONFLICT');
  if (['PERIOD', 'REGULATION'].includes(row.scoreScope)
    && (row.includesOvertime !== false || row.shootoutRule !== 'EXCLUDED')) errors.push('REGULATION_OT_SO_CONFLICT');
  if (row.scoreScope === 'GAME' && row.includesOvertime !== true) errors.push('GAME_OVERTIME_RULE_CONFLICT');
  const waters = Array.isArray(row.water) ? row.water : [row.water];
  if (!waters.length || waters.some(water => !nhlFiniteNumber(water) || water <= 0)) errors.push('WATER_INVALID');
  let taiwanContract = null;
  if (['TOTAL', 'SPREAD'].includes(row.marketType)) {
    taiwanContract = parseTaiwanContract(row.pick);
    if (!taiwanContract.valid) errors.push('TAIWAN_CONTRACT_INVALID');
    if (taiwanContract.valid && (taiwanContract.isTotal !== (row.marketType === 'TOTAL'))) errors.push('MARKET_PICK_TYPE_CONFLICT');
    // The shared legacy parser clamps malformed tails; NHL rejects them before
    // reaching that parser rather than silently changing the actual contract.
    const tail = String(row.pick || '').replace(/\s+/g, '').match(/[+-](\d+)$/);
    if (tail && Number(tail[1]) > 100) errors.push('TAIWAN_TAIL_OUT_OF_RANGE');
    if (taiwanContract.legs.length > 2 || ![1, taiwanContract.legs.length].includes(waters.length)) errors.push('TAIWAN_LEG_WATER_MISMATCH');
    if (row.marketType === 'TOTAL' && !['over', 'under'].includes(row.selection)) errors.push('TOTAL_SELECTION_UNKNOWN');
    if (row.marketType === 'TOTAL' && taiwanContract.direction !== row.selection) errors.push('TOTAL_SELECTION_CONFLICT');
    if (row.marketType === 'SPREAD') {
      if (!['away', 'home'].includes(row.selection)) errors.push('TEAM_SELECTION_UNKNOWN');
      const expectedTeam = row.selection === 'away' ? row.awayName : row.homeName;
      if (!text(row.awayName) || !text(row.homeName) || row.awayName === row.homeName) errors.push('TEAM_LABELS_INVALID');
      if (taiwanContract.team !== expectedTeam) errors.push('TEAM_SELECTION_CONFLICT');
    }
  }
  if (row.marketType === 'MONEYLINE') {
    if (!['away', 'home', 'draw'].includes(row.selection)) errors.push('MONEYLINE_SELECTION_UNKNOWN');
    if (!text(row.moneylineRuleId)) errors.push('MONEYLINE_RULE_UNVERIFIED');
    // No implicit conversion of moneyline into spread zero is permitted.
    errors.push('MONEYLINE_SETTLEMENT_NOT_IMPLEMENTED');
  }
  const evidence = Array.isArray(manifest) ? manifest.find(entry => evidenceMatches(entry, row)) : null;
  if (!evidence) errors.push('WAITING_REAL_TAI888_MARKET_VERIFICATION');
  const uniqueErrors = [...new Set(errors)];
  return {
    ok: uniqueErrors.length === 0, status: uniqueErrors.length ? 'BLOCK' : 'PASS', errors: uniqueErrors,
    contract: uniqueErrors.length ? null : {
      ...row, version: NHL_CONTRACT_VERSION, taiwanContract,
      identity: `${nhlGameIdentity(row)}:${row.marketId}:${row.selection}:${row.lineVersion}:${row.sourceHash}`,
      evidence: { evidenceVersion: evidence.evidenceVersion, evidenceSourceHash: evidence.evidenceSourceHash,
        evidenceObservedAt: evidence.evidenceObservedAt, ruleSourceUrl: evidence.ruleSourceUrl },
      settlementRuleVersion: SETTLEMENT_RULE_VERSION,
    },
  };
}

export function normalizeNhlReaderMarkets(snapshot, options = {}) {
  if (!snapshot || snapshot.league !== 'NHL' || snapshot.book !== 'TAI888' || !Array.isArray(snapshot.markets)) {
    return { version: NHL_CONTRACT_VERSION, status: 'BLOCK', markets: [], errors: ['NHL_READER_ENVELOPE_INVALID'] };
  }
  const identities = new Set();
  const markets = snapshot.markets.map(row => {
    const validated = validateNhlMarket(row, options);
    const identity = validated.contract?.identity;
    if (identity && identities.has(identity)) return { ...validated, ok: false, status: 'BLOCK', contract: null, errors: ['DUPLICATE_READER_MARKET'] };
    if (identity) identities.add(identity);
    return { marketId: row?.marketId ?? null, ...validated };
  });
  return {
    version: NHL_CONTRACT_VERSION, status: markets.some(row => !row.ok) ? 'BLOCK' : markets.length ? 'PASS' : 'WAITING_REAL_DATA',
    markets, errors: markets.length ? [] : ['WAITING_REAL_TAI888_MARKET_VERIFICATION'],
  };
}
