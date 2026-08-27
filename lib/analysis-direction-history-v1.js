import { createHash } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { durableDatabaseConfigured, durableDatabaseUrl } from './database-url.js';
import { isLeagueId } from './leagues.js';
import {
  parseTaiwanContract,
  settleTaiwanContract,
  settlementProfit,
  SETTLEMENT_RULE_VERSION,
  TAIWAN_CREDIT_REBATE_RATE,
} from './taiwan-settlement-v9.js';

export const ANALYSIS_DIRECTION_HISTORY_VERSION = 'BASEBALL-ANALYSIS-DIRECTION-HISTORY-v1.0.0';
export const ANALYSIS_DIRECTION_SETTLEMENT_VERSION = 'BASEBALL-ANALYSIS-DIRECTION-SETTLEMENT-v1.0.0';
export const ANALYSIS_DIRECTION_STAKE_BASIS = 10_000;

export const ANALYSIS_DIRECTION_SLOTS = Object.freeze([
  Object.freeze({ slotId: 'FULL_RUNLINE_HOME', slotIndex: 1, market: '全場讓分', period: 'FULL_GAME', marketFamily: 'RUNLINE', direction: 'home' }),
  Object.freeze({ slotId: 'FULL_RUNLINE_AWAY', slotIndex: 2, market: '全場讓分', period: 'FULL_GAME', marketFamily: 'RUNLINE', direction: 'away' }),
  Object.freeze({ slotId: 'FULL_TOTAL_OVER', slotIndex: 3, market: '全場大小', period: 'FULL_GAME', marketFamily: 'TOTAL', direction: 'over' }),
  Object.freeze({ slotId: 'FULL_TOTAL_UNDER', slotIndex: 4, market: '全場大小', period: 'FULL_GAME', marketFamily: 'TOTAL', direction: 'under' }),
  Object.freeze({ slotId: 'FIRST5_RUNLINE_HOME', slotIndex: 5, market: '上半讓分', period: 'FIRST5', marketFamily: 'RUNLINE', direction: 'home' }),
  Object.freeze({ slotId: 'FIRST5_RUNLINE_AWAY', slotIndex: 6, market: '上半讓分', period: 'FIRST5', marketFamily: 'RUNLINE', direction: 'away' }),
  Object.freeze({ slotId: 'FIRST5_TOTAL_OVER', slotIndex: 7, market: '上半大小', period: 'FIRST5', marketFamily: 'TOTAL', direction: 'over' }),
  Object.freeze({ slotId: 'FIRST5_TOTAL_UNDER', slotIndex: 8, market: '上半大小', period: 'FIRST5', marketFamily: 'TOTAL', direction: 'under' }),
]);

const SLOT_BY_ID = new Map(ANALYSIS_DIRECTION_SLOTS.map(slot => [slot.slotId, slot]));
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const VALID_STATUSES = new Set(['CALCULATED', 'UNOPENED', 'BLOCKED']);
let sqlClient;
let schemaReady;

const clean = (value, maximum = 500) => String(value ?? '').trim().slice(0, maximum);
const finite = value => value != null && String(value).trim() !== '' && Number.isFinite(Number(value))
  ? Number(value)
  : null;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  if (typeof value === 'number') return Number.isFinite(value) ? Number(value.toPrecision(15)) : null;
  return value;
}

function jsonClone(value, label = '內容') {
  let text;
  try { text = JSON.stringify(value ?? null); }
  catch (error) { throw new Error(`八方向${label}無法序列化：${clean(error?.message || error)}`); }
  if (Buffer.byteLength(text, 'utf8') > 1_000_000) throw new Error(`八方向${label}超過安全大小上限`);
  return JSON.parse(text);
}

function sha256(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(canonical(value));
  return createHash('sha256').update(text).digest('hex');
}

function requiredHash(value, label) {
  const result = clean(value, 64).toLowerCase();
  if (!HASH_PATTERN.test(result)) throw new Error(`八方向${label}不是有效SHA-256`);
  return result;
}

function optionalHash(value, label) {
  const result = clean(value, 64).toLowerCase();
  if (!result) return null;
  if (!HASH_PATTERN.test(result)) throw new Error(`八方向${label}不是有效SHA-256`);
  return result;
}

function iso(value, label) {
  const time = Date.parse(value || '');
  if (!Number.isFinite(time)) throw new Error(`八方向${label}時間無效`);
  return new Date(time).toISOString();
}

function leagueId(value) {
  const result = clean(value, 8).toUpperCase();
  if (!isLeagueId(result)) throw new Error('八方向缺少有效聯盟');
  return result;
}

function normalizeDirection(value) {
  const direction = clean(value, 20).toLowerCase();
  if (['home', 'away', 'over', 'under'].includes(direction)) return direction;
  return null;
}

function sameTeam(left, right) {
  const normalize = value => clean(value, 120).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
  const a = normalize(left);
  const b = normalize(right);
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

function inferredDirection(row, game) {
  const direct = normalizeDirection(row?.direction);
  if (direct) return direct;
  const contract = parseTaiwanContract(row?.pick);
  if (!contract.valid) return null;
  if (contract.isOver) return 'over';
  if (contract.isUnder) return 'under';
  if (sameTeam(contract.team, game?.home)) return 'home';
  if (sameTeam(contract.team, game?.away)) return 'away';
  return null;
}

function coverageByMarket(analysis) {
  const rows = Array.isArray(analysis?.marketCoverage)
    ? analysis.marketCoverage
    : Array.isArray(analysis?.marketCoverage?.markets) ? analysis.marketCoverage.markets : [];
  return new Map(rows.map(row => [clean(row?.market, 40), {
    status: clean(row?.status, 40).toUpperCase(),
    errors: [...new Set((Array.isArray(row?.errors) ? row.errors : []).map(value => clean(value, 300)).filter(Boolean))],
  }]));
}

function fallbackDirectionSlots(analysis, game) {
  const results = Array.isArray(analysis?.results) ? analysis.results : [];
  const coverage = coverageByMarket(analysis);
  return ANALYSIS_DIRECTION_SLOTS.map(definition => {
    const candidates = results.filter(row => clean(row?.market, 40) === definition.market
      && inferredDirection(row, game) === definition.direction);
    const marketRows = results.filter(row => clean(row?.market, 40) === definition.market);
    const marketCoverage = coverage.get(definition.market);
    if (candidates.length === 1) return {
      ...candidates[0],
      ...definition,
      status: Number.isFinite(finite(candidates[0]?.modelEV ?? candidates[0]?.rawWeightedEV ?? candidates[0]?.weightedEV))
        ? 'CALCULATED' : 'BLOCKED',
      coverageStatus: marketCoverage?.status || 'OPEN',
      coverageErrors: marketCoverage?.errors || [],
    };
    const explicitlyUnopened = marketCoverage?.status === 'UNOPENED' || (!marketRows.length && !marketCoverage);
    return {
      ...definition,
      status: explicitlyUnopened ? 'UNOPENED' : 'BLOCKED',
      coverageStatus: explicitlyUnopened ? 'UNOPENED' : (marketCoverage?.status || 'BLOCKED'),
      coverageErrors: marketCoverage?.errors?.length
        ? marketCoverage.errors
        : [candidates.length > 1 ? '同一方向重複' : '已開盤市場缺少對應方向'],
      pick: null,
      water: null,
      modelEV: null,
      robustEV: null,
    };
  });
}

export function normalizeAnalysisDirectionSlots(analysis, game = {}) {
  const supplied = Array.isArray(analysis?.directionSlots) ? analysis.directionSlots : null;
  const slots = supplied || fallbackDirectionSlots(analysis, game);
  if (slots.length !== 8) throw new Error(`八方向coverage錯誤：期待8個槽位，實際${slots.length}個`);
  const byId = new Map();
  for (const raw of slots) {
    const slotId = clean(raw?.slotId, 80).toUpperCase();
    if (!SLOT_BY_ID.has(slotId)) throw new Error(`八方向slotId無效：${slotId || '空白'}`);
    if (byId.has(slotId)) throw new Error(`八方向duplicate錯誤：${slotId}`);
    byId.set(slotId, raw);
  }
  return ANALYSIS_DIRECTION_SLOTS.map(definition => {
    const raw = byId.get(definition.slotId);
    if (!raw) throw new Error(`八方向coverage錯誤：缺少${definition.slotId}`);
    const status = clean(raw?.status, 20).toUpperCase();
    if (!VALID_STATUSES.has(status)) throw new Error(`八方向狀態無效：${definition.slotId}`);
    if (Number(raw?.slotIndex) !== definition.slotIndex
      || clean(raw?.market, 40) !== definition.market
      || normalizeDirection(raw?.direction) !== definition.direction) {
      throw new Error(`八方向槽位契約不一致：${definition.slotId}`);
    }
    return { ...raw, ...definition, status };
  });
}

function lineType(contract) {
  if (!contract?.valid) return null;
  if (!contract.isTotal && contract.legs.every(leg => Math.abs(leg) < 1e-12)) return 'FLAT_ZERO';
  if (contract.legs.length > 1) return 'SPLIT_LINE';
  if (contract.modifier && contract.modifier !== '平') return 'TAIL_LINE';
  return 'STANDARD';
}

function qaReasons(slot) {
  return [...new Set([
    ...(Array.isArray(slot?.qaReasons) ? slot.qaReasons : []),
    ...(Array.isArray(slot?.qa?.reasons) ? slot.qa.reasons : []),
    ...(Array.isArray(slot?.coverageErrors) ? slot.coverageErrors : []),
    ...(Array.isArray(slot?.primaryRisks) ? slot.primaryRisks : []),
    ...(slot?.integrityMessage ? [slot.integrityMessage] : []),
    ...(Array.isArray(slot?.evCalibration?.reasons) ? slot.evCalibration.reasons : []),
  ].map(value => clean(value, 500)).filter(Boolean))];
}

function sourceMetadata(slot, analysis, readerSnapshot) {
  return {
    readerVersion: clean(slot?.readerVersion || analysis?.readerVersion || readerSnapshot?.readerVersion, 180) || null,
    readerPayloadHash: optionalHash(slot?.readerPayloadHash || analysis?.readerPayloadHash || readerSnapshot?.payloadHash, 'Reader payload hash'),
    readerRawBoardHash: optionalHash(slot?.readerRawBoardHash || slot?.rawBoardHash || analysis?.readerRawBoardHash || readerSnapshot?.rawBoardHash, 'Reader raw board hash'),
    readerGameMarketHash: optionalHash(slot?.readerGameMarketHash || analysis?.readerGameMarketHash
      || readerSnapshot?.readerGameMarketHash || readerSnapshot?.gameMarketHash, 'Reader game market hash'),
    readerBoardDate: clean(slot?.readerBoardDate || analysis?.readerBoardDate || readerSnapshot?.boardDate, 20) || null,
    readerLineAsOf: (slot?.lineAsOf || analysis?.readerLineAsOf || readerSnapshot?.lineAsOf
      || readerSnapshot?.capturedAt || readerSnapshot?.fetchedAt)
      ? iso(slot?.lineAsOf || analysis?.readerLineAsOf || readerSnapshot?.lineAsOf
        || readerSnapshot?.capturedAt || readerSnapshot?.fetchedAt, 'Reader盤口')
      : null,
    readerSourceType: clean(slot?.sourceType || analysis?.marketSource, 100) || null,
    marketProvider: clean(slot?.provider || analysis?.marketProvider || readerSnapshot?.provider, 100) || null,
    marketSignatureVersion: clean(slot?.marketSignatureVersion, 180) || null,
    marketSignature: clean(slot?.marketSignature, 500) || null,
    authorizationStatus: clean(slot?.authorizationStatus, 100) || null,
    integrityOrigin: clean(slot?.integrityOrigin, 100) || null,
  };
}

function recordHashPayload(record) {
  const { recordHash, ...payload } = record;
  return payload;
}

export function validateAnalysisDirectionRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('八方向歷史列格式無效');
  const definition = SLOT_BY_ID.get(record.slotId);
  if (!definition || definition.slotIndex !== Number(record.slotIndex)
    || definition.market !== record.market || definition.direction !== record.direction
    || definition.period !== record.period || definition.marketFamily !== record.marketFamily) {
    throw new Error(`八方向歷史列槽位契約不一致：${clean(record.slotId)}`);
  }
  leagueId(record.leagueId);
  if (record.historySchemaVersion !== ANALYSIS_DIRECTION_HISTORY_VERSION) throw new Error('八方向歷史列schema版本不相容');
  if (!Number.isSafeInteger(Number(record.gamePk)) || Number(record.gamePk) <= 0
    || !Number.isSafeInteger(Number(record.gameNumber)) || Number(record.gameNumber) <= 0
    || !Number.isSafeInteger(Number(record.awayTeamId)) || Number(record.awayTeamId) <= 0
    || !Number.isSafeInteger(Number(record.homeTeamId)) || Number(record.homeTeamId) <= 0) {
    throw new Error('八方向歷史列賽事或隊伍識別無效');
  }
  if (!clean(record.officialDate, 20) || !clean(record.away, 120) || !clean(record.home, 120)) {
    throw new Error('八方向歷史列缺少正式日期或球隊名稱');
  }
  requiredHash(record.directionResultId, '列識別');
  requiredHash(record.recordHash, '列內容');
  requiredHash(record.inputHash, 'input hash');
  requiredHash(record.priceFingerprint, 'price fingerprint');
  requiredHash(record.distributionHash, 'distribution hash');
  for (const [value, label] of [
    [record.readerPayloadHash, 'Reader payload hash'],
    [record.readerRawBoardHash, 'Reader raw board hash'],
    [record.readerGameMarketHash, 'Reader game market hash'],
  ]) optionalHash(value, label);
  if (!VALID_STATUSES.has(record.status)) throw new Error('八方向歷史列狀態無效');
  if (record.directionResultId !== sha256(`${clean(record.snapshotId, 500)}|${record.slotId}`)) {
    throw new Error(`八方向列識別無法從快照重播：${record.slotId}`);
  }
  const gameStart = Date.parse(record.gameStart || '');
  const analysisAsOf = Date.parse(record.analysisAsOf || '');
  const dataAsOf = Date.parse(record.dataAsOf || '');
  const lineAsOf = Date.parse(record.lineAsOf || '');
  if (![gameStart, analysisAsOf, dataAsOf, lineAsOf].every(Number.isFinite)
    || dataAsOf > analysisAsOf || lineAsOf > analysisAsOf || analysisAsOf >= gameStart) {
    throw new Error('八方向歷史列不是完整賽前PIT資料');
  }
  if (record.status === 'CALCULATED') {
    if (!clean(record.pick) || finite(record.water) == null || finite(record.modelEV) == null) {
      throw new Error(`CALCULATED槽位缺少盤口、水位或W：${record.slotId}`);
    }
    if (!parseTaiwanContract(record.pick).valid) throw new Error(`CALCULATED槽位盤口無法結算：${record.slotId}`);
    if (record.robustStatus === 'CALCULATED') {
      if (finite(record.robustEV) == null || !Array.isArray(record.robustScenarioSource) || !record.robustScenarioSource.length) {
        throw new Error(`CALCULATED槽位缺少R或保守情境來源：${record.slotId}`);
      }
      requiredHash(record.robustScenarioHash, '穩健情境 hash');
      const expectedScenarioHash = sha256({
        robustEvVersion: record.robustEvVersion,
        uncertaintySetVersion: record.uncertaintySetVersion,
        robustEV: record.robustEV,
        variants: record.robustScenarioSource,
      });
      if (record.robustScenarioHash !== expectedScenarioHash) throw new Error(`CALCULATED槽位R情境雜湊不一致：${record.slotId}`);
      const lower = Math.min(...record.robustScenarioSource.map(item => finite(item?.value)).filter(value => value != null));
      if (!Number.isFinite(lower) || Math.abs(lower - Number(record.robustEV)) > 1e-9) {
        throw new Error(`CALCULATED槽位R與保守情境下界不一致：${record.slotId}`);
      }
    } else if (record.robustStatus !== 'BLOCKED' || record.robustEV != null || record.robustScenarioHash != null) {
      throw new Error(`穩健EV狀態不一致：${record.slotId}`);
    }
  } else if (record.modelEV != null || record.robustEV != null) {
    throw new Error(`${record.status}槽位的W/R必須為空：${record.slotId}`);
  }
  const readerClaimed = /TAI888_(?:READER|READ_ONLY)/i.test(`${record.marketProvider || ''} ${record.readerSourceType || ''}`)
    || Boolean(record.readerVersion || record.readerPayloadHash || record.readerRawBoardHash || record.readerGameMarketHash);
  if (readerClaimed) {
    if (!clean(record.readerVersion, 180) || !clean(record.readerBoardDate, 20) || !record.readerLineAsOf) {
      throw new Error(`Tai888 Reader方向缺少版本或時間溯源：${record.slotId}`);
    }
    const readerLineAsOf = Date.parse(record.readerLineAsOf);
    if (!Number.isFinite(readerLineAsOf) || readerLineAsOf > analysisAsOf || readerLineAsOf >= gameStart) {
      throw new Error(`Tai888 Reader方向的盤口時間不符合PIT：${record.slotId}`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(record.readerBoardDate)
      || !Number.isFinite(Date.parse(`${record.readerBoardDate}T00:00:00.000Z`))) {
      throw new Error(`Tai888 Reader方向的boardDate無效：${record.slotId}`);
    }
    requiredHash(record.readerPayloadHash, 'Reader payload hash');
    requiredHash(record.readerRawBoardHash, 'Reader raw board hash');
    requiredHash(record.readerGameMarketHash, 'Reader game market hash');
  }
  if (record.status === 'CALCULATED' && record.marketProvider === 'USER_MANUAL_ENTRY') {
    if (!record.marketSignatureVersion || !record.marketSignature
      || record.authorizationStatus !== 'USER_CONFIRMED_MANUAL' || record.integrityOrigin !== 'USER_MANUAL_ENTRY') {
      throw new Error(`手動方向缺少可驗證盤口來源：${record.slotId}`);
    }
  }
  if (record.distributionId == null || clean(record.distributionId, 300) === '') throw new Error('八方向歷史列缺少distribution ID');
  for (const [value, label] of [
    [record.modelVersion, '模型版本'],
    [record.rulesVersion, '規則版本'],
    [record.dataVersion, '資料版本'],
    [record.scoreFormulaVersion, '評分公式版本'],
    [record.settlementRuleVersion, '結算版本'],
    [record.uncertaintySetVersion, '不確定性版本'],
    [record.modelEvFormulaVersion, '模型EV公式版本'],
    [record.robustEvVersion, '穩健EV版本'],
    [record.directionSlotContractVersion, '八方向槽位契約版本'],
  ]) {
    if (!clean(value, 180)) throw new Error(`八方向歷史列缺少${label}`);
  }
  if (record.stakeBasis !== ANALYSIS_DIRECTION_STAKE_BASIS || Math.abs(record.rebateRate - TAIWAN_CREDIT_REBATE_RATE) > 1e-12) {
    throw new Error('八方向歷史列本金或退水契約不一致');
  }
  if (sha256(recordHashPayload(record)) !== record.recordHash) throw new Error(`八方向歷史列內容雜湊不一致：${record.slotId}`);
  return record;
}

export function buildAnalysisDirectionHistory({ snapshotRecord, analysis, readerSnapshot = null }) {
  if (!snapshotRecord || !analysis) throw new Error('八方向歷史缺少PIT快照或分析');
  const game = snapshotRecord.gameIdentity || {};
  const league = leagueId(snapshotRecord.leagueId);
  const slots = normalizeAnalysisDirectionSlots(analysis, game);
  const analysisAsOf = iso(snapshotRecord.analysisAsOf, '分析');
  const gameStart = iso(snapshotRecord.gameStart, '開打');
  const dataAsOf = iso(snapshotRecord.dataAsOf, '資料截點');
  const defaultLineAsOf = iso(snapshotRecord.lineAsOf, '盤口截點');
  const leadMinutes = Math.max(0, (Date.parse(gameStart) - Date.parse(analysisAsOf)) / 60_000);
  const records = slots.map(slot => {
    const status = slot.status;
    const contract = status === 'CALCULATED' ? parseTaiwanContract(slot.pick) : null;
    const modelEV = status === 'CALCULATED'
      ? finite(slot.modelEV ?? slot.rawWeightedEV ?? slot.weightedEV)
      : null;
    const robustEV = status === 'CALCULATED'
      ? finite(slot.robustEV ?? slot.rawRobustEV ?? slot.conservativeEV)
      : null;
    // The immutable direction row is a child of the PIT snapshot, so its PIT
    // cutoff must be identical to the parent. A market-specific Reader time is
    // retained separately as readerLineAsOf.
    const lineAsOf = defaultLineAsOf;
    const reasons = qaReasons(slot);
    const qaStatus = clean(slot?.qaStatus || slot?.qa?.status, 80).toUpperCase()
      || (status === 'UNOPENED' ? 'UNOPENED'
        : status === 'BLOCKED' || slot?.integrityWarning === true || slot?.dataGateV10?.passedForShadowScore === false ? 'BLOCK' : 'PASS');
    const source = sourceMetadata(slot, analysis, readerSnapshot);
    const base = {
      historySchemaVersion: ANALYSIS_DIRECTION_HISTORY_VERSION,
      snapshotId: clean(snapshotRecord.snapshotId, 500),
      parentSnapshotId: clean(snapshotRecord.parentSnapshotId, 500) || null,
      analysisType: clean(snapshotRecord.analysisType, 40).toUpperCase(),
      leagueId: league,
      gamePk: Number(game.gamePk),
      gameNumber: Math.max(1, Number(game.gameNumber) || 1),
      awayTeamId: Number.isSafeInteger(Number(game.awayTeamId)) && Number(game.awayTeamId) > 0 ? Number(game.awayTeamId) : null,
      homeTeamId: Number.isSafeInteger(Number(game.homeTeamId)) && Number(game.homeTeamId) > 0 ? Number(game.homeTeamId) : null,
      gameStart,
      officialDate: clean(game.officialDate, 20) || null,
      away: clean(game.away, 120) || null,
      home: clean(game.home, 120) || null,
      slotId: slot.slotId,
      slotIndex: slot.slotIndex,
      market: slot.market,
      period: slot.period,
      marketFamily: slot.marketFamily,
      direction: slot.direction,
      status,
      coverageStatus: clean(slot?.coverageStatus, 80).toUpperCase() || status,
      coverageErrors: [...new Set((Array.isArray(slot?.coverageErrors) ? slot.coverageErrors : []).map(value => clean(value, 500)).filter(Boolean))],
      pick: status === 'CALCULATED' ? clean(slot.pick, 240) : null,
      lineText: contract?.lineText || null,
      lineModifier: contract?.modifier || null,
      lineLegs: contract?.legs || [],
      lineType: lineType(contract),
      water: status === 'CALCULATED' ? finite(slot.water) : null,
      stakeBasis: ANALYSIS_DIRECTION_STAKE_BASIS,
      rebateRate: TAIWAN_CREDIT_REBATE_RATE,
      modelEV,
      robustEV,
      robustStatus: robustEV == null ? 'BLOCKED' : 'CALCULATED',
      robustScenarioSource: robustEV == null ? [] : jsonClone(
        Array.isArray(slot?.robustVariants) ? slot.robustVariants : [],
        '穩健EV情境來源',
      ),
      qaStatus,
      qaReasons: reasons,
      score: finite(slot?.score ?? slot?.formulaDiagnosticScore),
      rankingEligible: slot?.rankingEligible === true || slot?.rankingQualified === true || slot?.ranking?.eligible === true,
      betEligible: slot?.betEligible === true,
      ...source,
      modelVersion: clean(snapshotRecord?.versions?.modelVersion, 180),
      rulesVersion: clean(snapshotRecord?.versions?.rulesVersion, 180),
      dataVersion: clean(snapshotRecord?.versions?.dataVersion, 180),
      scoreFormulaVersion: clean(snapshotRecord?.versions?.scoreFormulaVersion, 180),
      settlementRuleVersion: clean(snapshotRecord?.versions?.settlementRuleVersion, 180),
      uncertaintySetVersion: clean(snapshotRecord?.versions?.uncertaintySetVersion, 180),
      modelEvFormulaVersion: clean(snapshotRecord?.versions?.modelEvFormulaVersion || slot?.modelEVFormulaVersion, 180),
      robustEvVersion: clean(snapshotRecord?.versions?.robustEvVersion || slot?.robustEVVersion, 180),
      directionSlotContractVersion: clean(snapshotRecord?.versions?.directionSlotContractVersion || analysis?.directionSlotContractVersion, 180),
      repriceVersion: clean(snapshotRecord?.versions?.repriceVersion, 180) || null,
      distributionId: clean(snapshotRecord.distributionId, 300),
      distributionHash: requiredHash(snapshotRecord.distributionHash, 'distribution hash'),
      inputHash: requiredHash(snapshotRecord.inputHash, 'input hash'),
      priceFingerprint: requiredHash(snapshotRecord.priceFingerprint, 'price fingerprint'),
      analysisAsOf,
      dataAsOf,
      lineAsOf,
      leadMinutes,
      resultPayload: jsonClone(slot, '原始方向分析'),
    };
    base.robustScenarioHash = robustEV == null ? null : sha256({
      robustEvVersion: base.robustEvVersion,
      uncertaintySetVersion: base.uncertaintySetVersion,
      robustEV: base.robustEV,
      variants: base.robustScenarioSource,
    });
    base.directionResultId = sha256(`${base.snapshotId}|${base.slotId}`);
    base.recordHash = sha256(base);
    return validateAnalysisDirectionRecord(base);
  });
  const bundle = {
    historySchemaVersion: ANALYSIS_DIRECTION_HISTORY_VERSION,
    snapshotId: clean(snapshotRecord.snapshotId, 500),
    leagueId: league,
    gamePk: Number(game.gamePk),
    distributionId: clean(snapshotRecord.distributionId, 300),
    distributionHash: requiredHash(snapshotRecord.distributionHash, 'distribution hash'),
    records,
  };
  bundle.historyHash = sha256(records.map(record => record.recordHash));
  return validateAnalysisDirectionHistory(bundle);
}

export function validateAnalysisDirectionHistory(bundle) {
  if (!bundle || !Array.isArray(bundle.records) || bundle.records.length !== 8) throw new Error('八方向歷史必須精確包含8列');
  if (bundle.historySchemaVersion !== ANALYSIS_DIRECTION_HISTORY_VERSION) throw new Error('八方向歷史schema版本不相容');
  const ordered = [...bundle.records].sort((left, right) => left.slotIndex - right.slotIndex);
  const first = ordered[0];
  ordered.forEach((record, index) => {
    validateAnalysisDirectionRecord(record);
    if (record.slotId !== ANALYSIS_DIRECTION_SLOTS[index].slotId) throw new Error('八方向歷史次序或唯一性錯誤');
    if (record.snapshotId !== bundle.snapshotId || record.leagueId !== bundle.leagueId
      || Number(record.gamePk) !== Number(bundle.gamePk)
      || record.distributionId !== bundle.distributionId || record.distributionHash !== bundle.distributionHash) {
      throw new Error('八方向歷史的快照或分布識別不一致');
    }
    if (record.directionResultId !== sha256(`${record.snapshotId}|${record.slotId}`)) throw new Error('八方向列識別無法從快照重播');
    for (const key of [
      'parentSnapshotId', 'analysisType', 'gameNumber', 'gameStart', 'officialDate',
      'awayTeamId', 'homeTeamId', 'away', 'home', 'inputHash', 'priceFingerprint',
      'analysisAsOf', 'dataAsOf', 'lineAsOf', 'modelVersion', 'rulesVersion', 'dataVersion',
      'scoreFormulaVersion', 'settlementRuleVersion', 'uncertaintySetVersion',
      'modelEvFormulaVersion', 'robustEvVersion', 'directionSlotContractVersion',
    ]) {
      if (String(record[key] ?? '') !== String(first[key] ?? '')) throw new Error(`八方向快照契約不一致：${key}`);
    }
  });
  if (sha256(ordered.map(record => record.recordHash)) !== bundle.historyHash) throw new Error('八方向歷史雜湊不一致');
  return { ...bundle, records: ordered };
}

export function replayAnalysisDirectionHistory(bundle) {
  const validated = validateAnalysisDirectionHistory(bundle);
  return {
    historySchemaVersion: validated.historySchemaVersion,
    historyHash: validated.historyHash,
    snapshotId: validated.snapshotId,
    leagueId: validated.leagueId,
    gamePk: validated.gamePk,
    distributionId: validated.distributionId,
    distributionHash: validated.distributionHash,
    directionSlots: validated.records.map(record => ({
      ...jsonClone(record.resultPayload, '重播方向分析'),
      slotId: record.slotId,
      slotIndex: record.slotIndex,
      market: record.market,
      direction: record.direction,
      status: record.status,
      coverageStatus: record.coverageStatus,
      coverageErrors: record.coverageErrors,
      pick: record.pick,
      water: record.water,
      modelEV: record.modelEV,
      robustEV: record.robustEV,
      distributionId: record.distributionId,
      distributionHash: record.distributionHash,
    })),
  };
}

function settlementOutcome(settlement) {
  const win = finite(settlement?.winFraction) || 0;
  const loss = finite(settlement?.lossFraction) || 0;
  const push = finite(settlement?.pushFraction) || 0;
  if (win >= 1 - 1e-9) return 'WIN';
  if (loss >= 1 - 1e-9) return 'LOSS';
  if (push >= 1 - 1e-9) return 'PUSH';
  if (win > 0 && loss <= 1e-9) return 'HALF_WIN';
  if (loss > 0 && win <= 1e-9) return 'HALF_LOSS';
  return 'MIXED';
}

function abnormalOfficialResult(result) {
  return /cancel|postpon|suspend|forfeit|called|shortened|complete(?:d)? early|abandon|取消|延期|提早結束|中斷|沒收/.test(
    `${result?.statusEnglish || ''} ${result?.status || ''}`.toLowerCase(),
  );
}

function officialResultHash(result) {
  return sha256({
    league: clean(result?.league || result?.game?.leagueId || result?.game?.league, 8).toUpperCase(),
    gamePk: finite(result?.gamePk ?? result?.game?.gamePk),
    gameNumber: finite(result?.gameNumber ?? result?.game?.gameNumber),
    officialDate: clean(result?.officialDate || result?.game?.officialDate, 20),
    awayTeamId: finite(result?.awayTeamId ?? result?.game?.awayTeamId),
    homeTeamId: finite(result?.homeTeamId ?? result?.game?.homeTeamId),
    away: clean(result?.away || result?.game?.away, 120),
    home: clean(result?.home || result?.game?.home, 120),
    final: result?.final === true,
    status: clean(result?.status, 120),
    statusEnglish: clean(result?.statusEnglish, 120),
    awayRuns: finite(result?.awayRuns),
    homeRuns: finite(result?.homeRuns),
    awayFirst5: finite(result?.awayFirst5),
    homeFirst5: finite(result?.homeFirst5),
    innings: finite(result?.innings),
    first5Complete: result?.first5Complete === true,
    provider: clean(result?.provider || result?.source, 180),
    providerRevision: clean(result?.providerRevision, 300),
    // Missing provenance must not hash to the same value as an explicitly
    // supplied source record. Otherwise a MANUAL_REVIEW row could never be
    // superseded when the provider later repairs only that field.
    sourceRecord: clean(result?.sourceRecord, 300),
  });
}

function officialIdentityFailures(record, result) {
  const resultLeague = clean(result?.league || result?.game?.leagueId || result?.game?.league, 8).toUpperCase();
  const resultGamePk = finite(result?.gamePk ?? result?.game?.gamePk);
  const resultGameNumber = finite(result?.gameNumber ?? result?.game?.gameNumber);
  const resultDate = clean(result?.officialDate || result?.game?.officialDate, 20);
  const resultAwayTeamId = finite(result?.awayTeamId ?? result?.game?.awayTeamId);
  const resultHomeTeamId = finite(result?.homeTeamId ?? result?.game?.homeTeamId);
  const resultAway = clean(result?.away || result?.game?.away, 120);
  const resultHome = clean(result?.home || result?.game?.home, 120);
  const failures = [];
  if (!resultLeague || resultLeague !== record.leagueId) failures.push('正式賽果聯盟識別不一致');
  if (!Number.isSafeInteger(resultGamePk) || resultGamePk !== Number(record.gamePk)) failures.push('正式賽果gamePk識別不一致');
  if (!Number.isSafeInteger(resultGameNumber) || resultGameNumber !== Number(record.gameNumber)) failures.push('正式賽果場次識別不一致');
  if (!resultDate || resultDate !== record.officialDate) failures.push('正式賽果日期不一致');
  if (!Number.isSafeInteger(resultAwayTeamId) || resultAwayTeamId !== Number(record.awayTeamId)) failures.push('正式賽果客隊識別不一致');
  if (!Number.isSafeInteger(resultHomeTeamId) || resultHomeTeamId !== Number(record.homeTeamId)) failures.push('正式賽果主隊識別不一致');
  if (!resultAway || !sameTeam(record.away, resultAway)) failures.push('正式賽果客隊名稱不一致');
  if (!resultHome || !sameTeam(record.home, resultHome)) failures.push('正式賽果主隊名稱不一致');
  if (!clean(result?.provider || result?.source, 180) || !clean(result?.sourceRecord, 300)) failures.push('正式賽果缺少provider或source record');
  return failures;
}

export function settleAnalysisDirectionRecord(record, result, {
  settledAt = new Date().toISOString(),
  supersedesSettlementId = null,
} = {}) {
  validateAnalysisDirectionRecord(record);
  if (record.status !== 'CALCULATED' || result?.final !== true) return null;
  const officialHash = officialResultHash(result);
  const selectedPeriod = record.period;
  const awayRuns = finite(selectedPeriod === 'FIRST5' ? result?.awayFirst5 : result?.awayRuns);
  const homeRuns = finite(selectedPeriod === 'FIRST5' ? result?.homeFirst5 : result?.homeRuns);
  const settledAtIso = iso(settledAt, '結算');
  const common = {
    settlementSchemaVersion: ANALYSIS_DIRECTION_SETTLEMENT_VERSION,
    directionResultId: record.directionResultId,
    supersedesSettlementId: optionalHash(supersedesSettlementId, '被取代結算') || null,
    officialResultHash: officialHash,
    selectedPeriod,
    selectedAwayRuns: awayRuns,
    selectedHomeRuns: homeRuns,
    stake: ANALYSIS_DIRECTION_STAKE_BASIS,
    settlementRuleVersion: SETTLEMENT_RULE_VERSION,
    resultProvider: clean(result?.provider || result?.source, 180) || null,
    resultSnapshot: jsonClone(result, '正式賽果'),
    settledAt: settledAtIso,
  };
  const settlementId = sha256(`${record.directionResultId}|${officialHash}|${SETTLEMENT_RULE_VERSION}|${common.supersedesSettlementId || 'ROOT'}`);
  const identityFailures = officialIdentityFailures(record, result);
  const first5Incomplete = selectedPeriod === 'FIRST5' && result?.first5Complete !== true;
  if (identityFailures.length || abnormalOfficialResult(result) || first5Incomplete || awayRuns == null || homeRuns == null) {
    const event = {
      ...common,
      status: 'MANUAL_REVIEW',
      outcome: null,
      winFraction: null,
      lossFraction: null,
      pushFraction: null,
      legOutcomes: [],
      grossWin: null,
      grossLoss: null,
      rebate: null,
      netProfit: null,
      roi: null,
      settlementError: identityFailures.length
        ? identityFailures.join('；')
        : abnormalOfficialResult(result)
          ? '賽事不是正常完賽，不自動判定void'
          : (selectedPeriod === 'FIRST5' ? '缺少可驗證的前五局正式賽果' : '缺少可驗證的全場正式賽果'),
    };
    event.settlementId = settlementId;
    return event;
  }
  const settlement = settleTaiwanContract(record.pick, awayRuns, homeRuns, record.away || '', record.home || '');
  if (!settlement) {
    const event = {
      ...common,
      status: 'MANUAL_REVIEW',
      outcome: null,
      winFraction: null,
      lossFraction: null,
      pushFraction: null,
      legOutcomes: [],
      grossWin: null,
      grossLoss: null,
      rebate: null,
      netProfit: null,
      roi: null,
      settlementError: '盤口合約與正式賽果無法進行確定性結算',
    };
    event.settlementId = settlementId;
    return event;
  }
  const profit = settlementProfit({
    stake: ANALYSIS_DIRECTION_STAKE_BASIS,
    water: record.water,
    settlement,
    rebateRate: TAIWAN_CREDIT_REBATE_RATE,
  });
  const event = {
    ...common,
    status: 'SETTLED',
    outcome: settlementOutcome(settlement),
    winFraction: settlement.winFraction,
    lossFraction: settlement.lossFraction,
    pushFraction: settlement.pushFraction,
    legOutcomes: profit.legs,
    grossWin: profit.grossWin,
    grossLoss: profit.grossLoss,
    rebate: profit.rebate,
    netProfit: profit.profit,
    roi: profit.profit / ANALYSIS_DIRECTION_STAKE_BASIS,
    settlementError: null,
  };
  event.settlementId = settlementId;
  return event;
}

function wBand(value) {
  const w = finite(value);
  if (w == null) return 'MISSING';
  if (w < 0) return 'NEGATIVE';
  if (w < 0.02) return '0_TO_2_PERCENT';
  if (w < 0.05) return '2_TO_5_PERCENT';
  if (w < 0.10) return '5_TO_10_PERCENT';
  return '10_PERCENT_PLUS';
}

function leadBand(value) {
  const minutes = finite(value);
  if (minutes == null) return 'MISSING';
  if (minutes < 60) return 'UNDER_1_HOUR';
  if (minutes < 180) return '1_TO_3_HOURS';
  if (minutes < 720) return '3_TO_12_HOURS';
  if (minutes < 1440) return '12_TO_24_HOURS';
  return '24_HOURS_PLUS';
}

function emptyStats(key, dimensions = {}) {
  return {
    key,
    ...dimensions,
    sampleSize: 0,
    wins: 0,
    losses: 0,
    pushes: 0,
    halfWins: 0,
    halfLosses: 0,
    mixed: 0,
    totalStake: 0,
    totalProfit: 0,
    roi: null,
  };
}

function addSettlement(summary, event) {
  if (event?.status !== 'SETTLED') return;
  summary.sampleSize += 1;
  const outcome = clean(event.outcome, 40).toUpperCase();
  if (outcome === 'WIN') summary.wins += 1;
  else if (outcome === 'LOSS') summary.losses += 1;
  else if (outcome === 'PUSH') summary.pushes += 1;
  else if (outcome === 'HALF_WIN') summary.halfWins += 1;
  else if (outcome === 'HALF_LOSS') summary.halfLosses += 1;
  else summary.mixed += 1;
  summary.totalStake += finite(event.stake) || 0;
  summary.totalProfit += finite(event.netProfit) || 0;
}

function finishStats(summary) {
  summary.totalStake = Math.round(summary.totalStake * 100) / 100;
  summary.totalProfit = Math.round(summary.totalProfit * 100) / 100;
  summary.roi = summary.totalStake > 0 ? summary.totalProfit / summary.totalStake : null;
  return summary;
}

export function summarizeAnalysisDirectionHistory(values = []) {
  const rows = Array.isArray(values) ? values : [];
  const overall = emptyStats('ALL');
  const groups = new Map();
  for (const value of rows) {
    const record = value?.record || value;
    const settlement = value?.settlement || record?.settlement;
    if (record?.status !== 'CALCULATED' || settlement?.status !== 'SETTLED') continue;
    const dimensions = {
      league: clean(record.leagueId, 8).toUpperCase(),
      market: clean(record.market, 40),
      wBand: wBand(record.modelEV),
      rSign: finite(record.robustEV) == null ? 'MISSING'
        : finite(record.robustEV) > 0 ? 'POSITIVE' : 'NON_POSITIVE',
      qaStatus: clean(record.qaStatus, 80).toUpperCase() || 'UNKNOWN',
      lineType: clean(record.lineType, 40).toUpperCase() || 'UNKNOWN',
      leadBand: leadBand(record.leadMinutes),
    };
    const key = [dimensions.league, dimensions.market, dimensions.wBand, dimensions.rSign,
      dimensions.qaStatus, dimensions.lineType, dimensions.leadBand].join('|||');
    if (!groups.has(key)) groups.set(key, emptyStats(key, dimensions));
    addSettlement(overall, settlement);
    addSettlement(groups.get(key), settlement);
  }
  return {
    version: ANALYSIS_DIRECTION_SETTLEMENT_VERSION,
    overall: finishStats(overall),
    groups: [...groups.values()].map(finishStats).sort((left, right) => left.key.localeCompare(right.key, 'zh-Hant')),
  };
}

export function analysisDirectionHistoryDatabaseConfigured() {
  return durableDatabaseConfigured();
}

function sql() {
  if (!sqlClient) sqlClient = neon(durableDatabaseUrl());
  return sqlClient;
}

export async function ensureAnalysisDirectionHistorySchema() {
  if (!analysisDirectionHistoryDatabaseConfigured()) throw new Error('八方向歷史需要DATABASE_URL');
  if (!schemaReady) schemaReady = (async () => {
    await sql()`
      CREATE TABLE IF NOT EXISTS baseball_analysis_direction_results (
        direction_result_id CHAR(64) PRIMARY KEY, record_hash CHAR(64) NOT NULL,
        history_schema_version TEXT NOT NULL,
        snapshot_id TEXT NOT NULL REFERENCES baseball_analysis_pit_snapshots(snapshot_id) ON DELETE RESTRICT,
        parent_snapshot_id TEXT REFERENCES baseball_analysis_pit_snapshots(snapshot_id) ON DELETE RESTRICT,
        analysis_type TEXT NOT NULL CHECK (analysis_type IN ('FULL', 'PRICE_ONLY_REPRICE')),
        league_id TEXT NOT NULL CHECK (league_id IN ('MLB', 'NPB', 'KBO', 'CPBL')),
        external_game_id BIGINT NOT NULL, game_number INTEGER NOT NULL, away_team_id BIGINT NOT NULL, home_team_id BIGINT NOT NULL,
        game_start TIMESTAMPTZ NOT NULL,
        official_date TEXT NOT NULL, away_team TEXT NOT NULL, home_team TEXT NOT NULL,
        slot_id TEXT NOT NULL, slot_index SMALLINT NOT NULL CHECK (slot_index BETWEEN 1 AND 8),
        market TEXT NOT NULL CHECK (market IN ('全場讓分', '全場大小', '上半讓分', '上半大小')),
        period TEXT NOT NULL CHECK (period IN ('FULL_GAME', 'FIRST5')),
        market_family TEXT NOT NULL CHECK (market_family IN ('RUNLINE', 'TOTAL')),
        direction TEXT NOT NULL CHECK (direction IN ('home', 'away', 'over', 'under')),
        status TEXT NOT NULL CHECK (status IN ('CALCULATED', 'UNOPENED', 'BLOCKED')),
        coverage_status TEXT NOT NULL, coverage_errors JSONB NOT NULL DEFAULT '[]'::jsonb,
        pick TEXT, line_text TEXT, line_modifier TEXT, line_legs JSONB NOT NULL DEFAULT '[]'::jsonb,
        line_type TEXT, water NUMERIC, stake_basis NUMERIC NOT NULL DEFAULT 10000 CHECK (stake_basis = 10000),
        rebate_rate NUMERIC NOT NULL DEFAULT 0.015 CHECK (rebate_rate = 0.015), model_ev NUMERIC, robust_ev NUMERIC,
        qa_status TEXT NOT NULL, qa_reasons JSONB NOT NULL DEFAULT '[]'::jsonb, score NUMERIC,
        ranking_eligible BOOLEAN NOT NULL DEFAULT FALSE, bet_eligible BOOLEAN NOT NULL DEFAULT FALSE,
        reader_version TEXT, reader_payload_hash CHAR(64), reader_raw_board_hash CHAR(64),
        reader_game_market_hash CHAR(64), reader_board_date TEXT, reader_line_as_of TIMESTAMPTZ, reader_source_type TEXT,
        market_provider TEXT, market_signature_version TEXT, market_signature TEXT,
        authorization_status TEXT, integrity_origin TEXT,
        model_version TEXT NOT NULL, rules_version TEXT NOT NULL, data_version TEXT NOT NULL,
        score_formula_version TEXT NOT NULL, settlement_rule_version TEXT NOT NULL,
        uncertainty_set_version TEXT NOT NULL, reprice_version TEXT,
        model_ev_formula_version TEXT NOT NULL, robust_ev_version TEXT NOT NULL,
        direction_slot_contract_version TEXT NOT NULL,
        robust_status TEXT NOT NULL CHECK (robust_status IN ('CALCULATED', 'BLOCKED')),
        robust_scenario_source JSONB NOT NULL DEFAULT '[]'::jsonb, robust_scenario_hash CHAR(64),
        distribution_id TEXT NOT NULL, distribution_hash CHAR(64) NOT NULL,
        input_hash CHAR(64) NOT NULL, price_fingerprint CHAR(64) NOT NULL,
        analysis_as_of TIMESTAMPTZ NOT NULL, data_as_of TIMESTAMPTZ NOT NULL, line_as_of TIMESTAMPTZ NOT NULL,
        lead_minutes NUMERIC NOT NULL, result_payload JSONB NOT NULL, record_payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (snapshot_id, slot_id), UNIQUE (snapshot_id, slot_index),
        CHECK (data_as_of <= analysis_as_of), CHECK (line_as_of <= analysis_as_of),
        CHECK (analysis_as_of < game_start), CHECK (created_at < game_start), CHECK (lead_minutes >= 0),
        CHECK ((status = 'CALCULATED' AND pick IS NOT NULL AND water IS NOT NULL AND model_ev IS NOT NULL)
          OR (status IN ('UNOPENED', 'BLOCKED') AND model_ev IS NULL AND robust_ev IS NULL)),
        CHECK ((robust_status = 'CALCULATED' AND robust_ev IS NOT NULL AND robust_scenario_hash IS NOT NULL)
          OR (robust_status = 'BLOCKED' AND robust_ev IS NULL AND robust_scenario_hash IS NULL))
      )
    `;
    await sql()`
      ALTER TABLE baseball_analysis_direction_results
        ADD COLUMN IF NOT EXISTS model_ev_formula_version TEXT NOT NULL DEFAULT 'SCORE-PMF-X-TAIWAN-LEG-PAYOFF-v1.0.0',
        ADD COLUMN IF NOT EXISTS robust_ev_version TEXT NOT NULL DEFAULT 'MODEL-SCENARIO-Q10-CONTINUOUS-PLAUSIBILITY-v3.1.0',
        ADD COLUMN IF NOT EXISTS direction_slot_contract_version TEXT NOT NULL DEFAULT 'BASEBALL-EIGHT-DIRECTION-SLOTS-v1.0.0',
        ADD COLUMN IF NOT EXISTS away_team_id BIGINT,
        ADD COLUMN IF NOT EXISTS home_team_id BIGINT,
        ADD COLUMN IF NOT EXISTS market_provider TEXT,
        ADD COLUMN IF NOT EXISTS market_signature_version TEXT,
        ADD COLUMN IF NOT EXISTS market_signature TEXT,
        ADD COLUMN IF NOT EXISTS authorization_status TEXT,
        ADD COLUMN IF NOT EXISTS integrity_origin TEXT,
        ADD COLUMN IF NOT EXISTS robust_status TEXT NOT NULL DEFAULT 'BLOCKED',
        ADD COLUMN IF NOT EXISTS robust_scenario_source JSONB NOT NULL DEFAULT '[]'::jsonb,
        ADD COLUMN IF NOT EXISTS robust_scenario_hash CHAR(64)
    `;
    await sql()`
      CREATE TABLE IF NOT EXISTS baseball_analysis_direction_settlements (
        settlement_id CHAR(64) PRIMARY KEY, settlement_schema_version TEXT NOT NULL,
        direction_result_id CHAR(64) NOT NULL REFERENCES baseball_analysis_direction_results(direction_result_id) ON DELETE RESTRICT,
        supersedes_settlement_id CHAR(64) REFERENCES baseball_analysis_direction_settlements(settlement_id) ON DELETE RESTRICT,
        official_result_hash CHAR(64) NOT NULL, status TEXT NOT NULL CHECK (status IN ('SETTLED', 'MANUAL_REVIEW')),
        selected_period TEXT NOT NULL CHECK (selected_period IN ('FULL_GAME', 'FIRST5')),
        selected_away_runs NUMERIC, selected_home_runs NUMERIC, outcome TEXT,
        win_fraction NUMERIC, loss_fraction NUMERIC, push_fraction NUMERIC,
        leg_outcomes JSONB NOT NULL DEFAULT '[]'::jsonb, stake NUMERIC NOT NULL CHECK (stake = 10000),
        gross_win NUMERIC, gross_loss NUMERIC, rebate NUMERIC, net_profit NUMERIC, roi NUMERIC,
        settlement_rule_version TEXT NOT NULL, result_provider TEXT, result_snapshot JSONB NOT NULL,
        settlement_error TEXT, settled_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK ((status = 'SETTLED' AND outcome IS NOT NULL AND selected_away_runs IS NOT NULL AND selected_home_runs IS NOT NULL AND net_profit IS NOT NULL AND roi IS NOT NULL)
          OR (status = 'MANUAL_REVIEW' AND settlement_error IS NOT NULL))
      )
    `;
    await sql()`CREATE INDEX IF NOT EXISTS idx_analysis_direction_game ON baseball_analysis_direction_results(league_id, external_game_id, analysis_as_of DESC)`;
    await sql()`CREATE INDEX IF NOT EXISTS idx_analysis_direction_snapshot ON baseball_analysis_direction_results(snapshot_id, slot_index)`;
    await sql()`CREATE INDEX IF NOT EXISTS idx_analysis_direction_market_w ON baseball_analysis_direction_results(league_id, market, model_ev DESC) WHERE status = 'CALCULATED'`;
    await sql()`CREATE INDEX IF NOT EXISTS idx_analysis_direction_dimensions ON baseball_analysis_direction_results(league_id, market, qa_status, line_type, lead_minutes) WHERE status = 'CALCULATED'`;
    await sql()`CREATE INDEX IF NOT EXISTS idx_analysis_direction_distribution ON baseball_analysis_direction_results(league_id, distribution_hash, snapshot_id)`;
    await sql()`CREATE INDEX IF NOT EXISTS idx_analysis_direction_settlement_latest ON baseball_analysis_direction_settlements(direction_result_id, settled_at DESC, created_at DESC)`;
    await sql()`CREATE INDEX IF NOT EXISTS idx_analysis_direction_settlement_outcome ON baseball_analysis_direction_settlements(status, outcome, settled_at DESC)`;
    await sql()`CREATE UNIQUE INDEX IF NOT EXISTS idx_analysis_direction_settlement_root ON baseball_analysis_direction_settlements(direction_result_id) WHERE supersedes_settlement_id IS NULL`;
    await sql()`CREATE UNIQUE INDEX IF NOT EXISTS idx_analysis_direction_settlement_child ON baseball_analysis_direction_settlements(supersedes_settlement_id) WHERE supersedes_settlement_id IS NOT NULL`;
    await sql()`
      DO $direction_settlement_legacy_unique$
      DECLARE legacy_name TEXT;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtext('baseball_analysis_direction_settlement_legacy_unique'));
        SELECT constraint_row.conname INTO legacy_name
        FROM pg_constraint constraint_row
        WHERE constraint_row.conrelid = 'baseball_analysis_direction_settlements'::regclass
          AND constraint_row.contype = 'u'
          AND (
            SELECT array_agg(attribute_row.attname::text ORDER BY key_row.ordinality)
            FROM unnest(constraint_row.conkey) WITH ORDINALITY AS key_row(attnum, ordinality)
            JOIN pg_attribute attribute_row
              ON attribute_row.attrelid = constraint_row.conrelid
             AND attribute_row.attnum = key_row.attnum
          ) = ARRAY['direction_result_id', 'official_result_hash', 'settlement_rule_version']::text[]
        LIMIT 1;
        IF legacy_name IS NOT NULL THEN
          EXECUTE format('ALTER TABLE baseball_analysis_direction_settlements DROP CONSTRAINT %I', legacy_name);
        END IF;
      END
      $direction_settlement_legacy_unique$
    `;
    await sql()`
      CREATE OR REPLACE FUNCTION reject_baseball_analysis_direction_mutation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Baseball analysis direction history is append-only'; END $$
    `;
    await sql()`
      CREATE OR REPLACE FUNCTION validate_baseball_analysis_direction_pit_insert() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE pit baseball_analysis_pit_snapshots%ROWTYPE;
      BEGIN
        SELECT * INTO pit FROM baseball_analysis_pit_snapshots WHERE snapshot_id = NEW.snapshot_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'Analysis direction PIT parent is missing'; END IF;
        IF NEW.created_at >= NEW.game_start OR clock_timestamp() >= NEW.game_start THEN
          RAISE EXCEPTION 'Analysis direction history must be inserted before game start';
        END IF;
        IF NEW.official_date IS NULL OR NEW.away_team IS NULL OR NEW.home_team IS NULL
          OR pit.league_id IS DISTINCT FROM NEW.league_id
          OR pit.external_game_id IS DISTINCT FROM NEW.external_game_id
          OR pit.game_number IS DISTINCT FROM NEW.game_number
          OR pit.game_start IS DISTINCT FROM NEW.game_start
          OR pit.analysis_type IS DISTINCT FROM NEW.analysis_type
          OR pit.input_hash IS DISTINCT FROM NEW.input_hash
          OR pit.price_fingerprint IS DISTINCT FROM NEW.price_fingerprint
          OR pit.distribution_id IS DISTINCT FROM NEW.distribution_id
          OR pit.distribution_hash IS DISTINCT FROM NEW.distribution_hash
          OR pit.analysis_as_of IS DISTINCT FROM NEW.analysis_as_of
          OR pit.data_as_of IS DISTINCT FROM NEW.data_as_of
          OR pit.line_as_of IS DISTINCT FROM NEW.line_as_of
          OR pit.parent_snapshot_id IS DISTINCT FROM NEW.parent_snapshot_id
          OR NULLIF(pit.game_identity->>'awayTeamId', '')::bigint IS DISTINCT FROM NEW.away_team_id
          OR NULLIF(pit.game_identity->>'homeTeamId', '')::bigint IS DISTINCT FROM NEW.home_team_id
          OR NULLIF(pit.game_identity->>'officialDate', '') IS DISTINCT FROM NEW.official_date
          OR NULLIF(pit.game_identity->>'away', '') IS DISTINCT FROM NEW.away_team
          OR NULLIF(pit.game_identity->>'home', '') IS DISTINCT FROM NEW.home_team
          OR pit.model_version IS DISTINCT FROM NEW.model_version
          OR pit.rules_version IS DISTINCT FROM NEW.rules_version
          OR pit.data_version IS DISTINCT FROM NEW.data_version
          OR pit.score_formula_version IS DISTINCT FROM NEW.score_formula_version
          OR pit.settlement_rule_version IS DISTINCT FROM NEW.settlement_rule_version
          OR pit.uncertainty_set_version IS DISTINCT FROM NEW.uncertainty_set_version
          OR pit.reprice_version IS DISTINCT FROM NEW.reprice_version
          OR pit.versions->>'modelEvFormulaVersion' IS DISTINCT FROM NEW.model_ev_formula_version
          OR pit.versions->>'robustEvVersion' IS DISTINCT FROM NEW.robust_ev_version
          OR pit.versions->>'directionSlotContractVersion' IS DISTINCT FROM NEW.direction_slot_contract_version THEN
          RAISE EXCEPTION 'Analysis direction row does not match immutable PIT parent';
        END IF;
        RETURN NEW;
      END $$
    `;
    await sql()`
      CREATE OR REPLACE FUNCTION validate_baseball_analysis_direction_settlement_insert() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE
        parent_direction_id CHAR(64);
        parent_official_hash CHAR(64);
        result_period TEXT;
      BEGIN
        SELECT period INTO result_period
        FROM baseball_analysis_direction_results
        WHERE direction_result_id = NEW.direction_result_id;
        IF NOT FOUND OR result_period IS DISTINCT FROM NEW.selected_period THEN
          RAISE EXCEPTION 'Analysis direction settlement does not match its immutable direction row';
        END IF;
        IF NEW.supersedes_settlement_id IS NOT NULL THEN
          SELECT direction_result_id, official_result_hash
            INTO parent_direction_id, parent_official_hash
          FROM baseball_analysis_direction_settlements
          WHERE settlement_id = NEW.supersedes_settlement_id;
          IF NOT FOUND OR parent_direction_id IS DISTINCT FROM NEW.direction_result_id THEN
            RAISE EXCEPTION 'Analysis direction settlement supersedes a foreign or missing event';
          END IF;
          IF parent_official_hash IS NOT DISTINCT FROM NEW.official_result_hash THEN
            RAISE EXCEPTION 'Analysis direction correction must change the official result hash';
          END IF;
        END IF;
        RETURN NEW;
      END $$
    `;
    await sql()`
      DO $direction_history_trigger$
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtext('baseball_analysis_direction_history_immutable'));
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'baseball_analysis_direction_results_pit_insert'
          AND tgrelid = 'baseball_analysis_direction_results'::regclass AND NOT tgisinternal) THEN
          EXECUTE 'CREATE TRIGGER baseball_analysis_direction_results_pit_insert BEFORE INSERT ON baseball_analysis_direction_results FOR EACH ROW EXECUTE FUNCTION validate_baseball_analysis_direction_pit_insert()';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'baseball_analysis_direction_settlements_chain_insert'
          AND tgrelid = 'baseball_analysis_direction_settlements'::regclass AND NOT tgisinternal) THEN
          EXECUTE 'CREATE TRIGGER baseball_analysis_direction_settlements_chain_insert BEFORE INSERT ON baseball_analysis_direction_settlements FOR EACH ROW EXECUTE FUNCTION validate_baseball_analysis_direction_settlement_insert()';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'baseball_analysis_direction_results_immutable'
          AND tgrelid = 'baseball_analysis_direction_results'::regclass AND NOT tgisinternal) THEN
          EXECUTE 'CREATE TRIGGER baseball_analysis_direction_results_immutable BEFORE UPDATE OR DELETE ON baseball_analysis_direction_results FOR EACH ROW EXECUTE FUNCTION reject_baseball_analysis_direction_mutation()';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'baseball_analysis_direction_settlements_immutable'
          AND tgrelid = 'baseball_analysis_direction_settlements'::regclass AND NOT tgisinternal) THEN
          EXECUTE 'CREATE TRIGGER baseball_analysis_direction_settlements_immutable BEFORE UPDATE OR DELETE ON baseball_analysis_direction_settlements FOR EACH ROW EXECUTE FUNCTION reject_baseball_analysis_direction_mutation()';
        END IF;
      END
      $direction_history_trigger$
    `;
  })().catch(error => { schemaReady = null; throw error; });
  await schemaReady;
}

function databaseRecordPayload(record) {
  return {
    direction_result_id: record.directionResultId,
    record_hash: record.recordHash,
    history_schema_version: record.historySchemaVersion,
    snapshot_id: record.snapshotId,
    parent_snapshot_id: record.parentSnapshotId,
    analysis_type: record.analysisType,
    league_id: record.leagueId,
    external_game_id: record.gamePk,
    game_number: record.gameNumber,
    away_team_id: record.awayTeamId,
    home_team_id: record.homeTeamId,
    game_start: record.gameStart,
    official_date: record.officialDate,
    away_team: record.away,
    home_team: record.home,
    slot_id: record.slotId,
    slot_index: record.slotIndex,
    market: record.market,
    period: record.period,
    market_family: record.marketFamily,
    direction: record.direction,
    status: record.status,
    coverage_status: record.coverageStatus,
    coverage_errors: record.coverageErrors,
    pick: record.pick,
    line_text: record.lineText,
    line_modifier: record.lineModifier,
    line_legs: record.lineLegs,
    line_type: record.lineType,
    water: record.water,
    stake_basis: record.stakeBasis,
    rebate_rate: record.rebateRate,
    model_ev: record.modelEV,
    robust_ev: record.robustEV,
    qa_status: record.qaStatus,
    qa_reasons: record.qaReasons,
    score: record.score,
    ranking_eligible: record.rankingEligible,
    bet_eligible: record.betEligible,
    reader_version: record.readerVersion,
    reader_payload_hash: record.readerPayloadHash,
    reader_raw_board_hash: record.readerRawBoardHash,
    reader_game_market_hash: record.readerGameMarketHash,
    reader_board_date: record.readerBoardDate,
    reader_line_as_of: record.readerLineAsOf,
    reader_source_type: record.readerSourceType,
    market_provider: record.marketProvider,
    market_signature_version: record.marketSignatureVersion,
    market_signature: record.marketSignature,
    authorization_status: record.authorizationStatus,
    integrity_origin: record.integrityOrigin,
    model_version: record.modelVersion,
    rules_version: record.rulesVersion,
    data_version: record.dataVersion,
    score_formula_version: record.scoreFormulaVersion,
    settlement_rule_version: record.settlementRuleVersion,
    uncertainty_set_version: record.uncertaintySetVersion,
    model_ev_formula_version: record.modelEvFormulaVersion,
    robust_ev_version: record.robustEvVersion,
    direction_slot_contract_version: record.directionSlotContractVersion,
    robust_status: record.robustStatus,
    robust_scenario_source: record.robustScenarioSource,
    robust_scenario_hash: record.robustScenarioHash,
    reprice_version: record.repriceVersion,
    distribution_id: record.distributionId,
    distribution_hash: record.distributionHash,
    input_hash: record.inputHash,
    price_fingerprint: record.priceFingerprint,
    analysis_as_of: record.analysisAsOf,
    data_as_of: record.dataAsOf,
    line_as_of: record.lineAsOf,
    lead_minutes: record.leadMinutes,
    // The canonical record_payload already contains resultPayload and is hash
    // verified during replay. Keep this legacy NOT NULL column as a tiny pointer
    // instead of transferring the full direction result twice.
    result_payload: {
      directionResultId: record.directionResultId,
      recordHash: record.recordHash,
      payloadLocation: 'record_payload',
    },
    record_payload: recordHashPayload(record),
  };
}

export async function persistAnalysisDirectionHistory(bundle) {
  const validated = validateAnalysisDirectionHistory(bundle);
  if (!analysisDirectionHistoryDatabaseConfigured()) return { stored: false, reason: 'DATABASE_NOT_CONFIGURED', snapshotId: validated.snapshotId };
  await ensureAnalysisDirectionHistorySchema();
  const payload = validated.records.map(databaseRecordPayload);
  const inserted = await sql()`
    WITH incoming AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) AS row(
        direction_result_id CHAR(64), record_hash CHAR(64), history_schema_version TEXT,
        snapshot_id TEXT, parent_snapshot_id TEXT, analysis_type TEXT, league_id TEXT,
        external_game_id BIGINT, game_number INTEGER, away_team_id BIGINT, home_team_id BIGINT, game_start TIMESTAMPTZ,
        official_date TEXT, away_team TEXT, home_team TEXT, slot_id TEXT, slot_index SMALLINT,
        market TEXT, period TEXT, market_family TEXT, direction TEXT, status TEXT,
        coverage_status TEXT, coverage_errors JSONB, pick TEXT, line_text TEXT, line_modifier TEXT,
        line_legs JSONB, line_type TEXT, water NUMERIC, stake_basis NUMERIC, rebate_rate NUMERIC,
        model_ev NUMERIC, robust_ev NUMERIC, qa_status TEXT, qa_reasons JSONB, score NUMERIC,
        ranking_eligible BOOLEAN, bet_eligible BOOLEAN, reader_version TEXT,
        reader_payload_hash CHAR(64), reader_raw_board_hash CHAR(64), reader_game_market_hash CHAR(64),
        reader_board_date TEXT, reader_line_as_of TIMESTAMPTZ, reader_source_type TEXT,
        market_provider TEXT, market_signature_version TEXT, market_signature TEXT,
        authorization_status TEXT, integrity_origin TEXT,
        model_version TEXT, rules_version TEXT, data_version TEXT, score_formula_version TEXT,
        settlement_rule_version TEXT, uncertainty_set_version TEXT, model_ev_formula_version TEXT,
        robust_ev_version TEXT, direction_slot_contract_version TEXT,
        robust_status TEXT, robust_scenario_source JSONB, robust_scenario_hash CHAR(64), reprice_version TEXT,
        distribution_id TEXT, distribution_hash CHAR(64), input_hash CHAR(64), price_fingerprint CHAR(64),
        analysis_as_of TIMESTAMPTZ, data_as_of TIMESTAMPTZ, line_as_of TIMESTAMPTZ,
        lead_minutes NUMERIC, result_payload JSONB, record_payload JSONB
      )
    ), bound AS (
      SELECT i.* FROM incoming i
      JOIN baseball_analysis_pit_snapshots p
        ON p.snapshot_id = i.snapshot_id
        AND p.league_id = i.league_id
        AND p.external_game_id = i.external_game_id
        AND p.game_number = i.game_number
        AND p.game_start = i.game_start
        AND p.analysis_type = i.analysis_type
        AND p.input_hash = i.input_hash
        AND p.price_fingerprint = i.price_fingerprint
        AND p.distribution_id = i.distribution_id
        AND p.distribution_hash = i.distribution_hash
        AND p.analysis_as_of = i.analysis_as_of
        AND p.data_as_of = i.data_as_of
        AND p.line_as_of = i.line_as_of
        AND p.parent_snapshot_id IS NOT DISTINCT FROM i.parent_snapshot_id
        AND NULLIF(p.game_identity->>'awayTeamId', '')::bigint IS NOT DISTINCT FROM i.away_team_id
        AND NULLIF(p.game_identity->>'homeTeamId', '')::bigint IS NOT DISTINCT FROM i.home_team_id
        AND p.versions->>'modelEvFormulaVersion' = i.model_ev_formula_version
        AND p.versions->>'robustEvVersion' = i.robust_ev_version
        AND p.versions->>'directionSlotContractVersion' = i.direction_slot_contract_version
    )
    INSERT INTO baseball_analysis_direction_results (
      direction_result_id, record_hash, history_schema_version, snapshot_id, parent_snapshot_id,
      analysis_type, league_id, external_game_id, game_number, away_team_id, home_team_id, game_start, official_date, away_team, home_team,
      slot_id, slot_index, market, period, market_family, direction, status, coverage_status, coverage_errors,
      pick, line_text, line_modifier, line_legs, line_type, water, stake_basis, rebate_rate, model_ev, robust_ev,
      qa_status, qa_reasons, score, ranking_eligible, bet_eligible, reader_version, reader_payload_hash,
      reader_raw_board_hash, reader_game_market_hash, reader_board_date, reader_line_as_of, reader_source_type,
      market_provider, market_signature_version, market_signature, authorization_status, integrity_origin,
      model_version, rules_version, data_version, score_formula_version, settlement_rule_version,
      uncertainty_set_version, model_ev_formula_version, robust_ev_version, direction_slot_contract_version,
      robust_status, robust_scenario_source, robust_scenario_hash,
      reprice_version, distribution_id, distribution_hash, input_hash, price_fingerprint,
      analysis_as_of, data_as_of, line_as_of, lead_minutes, result_payload, record_payload
    ) SELECT
      direction_result_id, record_hash, history_schema_version, snapshot_id, parent_snapshot_id,
      analysis_type, league_id, external_game_id, game_number, away_team_id, home_team_id, game_start, official_date, away_team, home_team,
      slot_id, slot_index, market, period, market_family, direction, status, coverage_status, coverage_errors,
      pick, line_text, line_modifier, line_legs, line_type, water, stake_basis, rebate_rate, model_ev, robust_ev,
      qa_status, qa_reasons, score, ranking_eligible, bet_eligible, reader_version, reader_payload_hash,
      reader_raw_board_hash, reader_game_market_hash, reader_board_date, reader_line_as_of, reader_source_type,
      market_provider, market_signature_version, market_signature, authorization_status, integrity_origin,
      model_version, rules_version, data_version, score_formula_version, settlement_rule_version,
      uncertainty_set_version, model_ev_formula_version, robust_ev_version, direction_slot_contract_version,
      robust_status, robust_scenario_source, robust_scenario_hash,
      reprice_version, distribution_id, distribution_hash, input_hash, price_fingerprint,
      analysis_as_of, data_as_of, line_as_of, lead_minutes, result_payload, record_payload
    FROM bound WHERE game_start > NOW()
    ON CONFLICT DO NOTHING RETURNING direction_result_id
  `;
  const rows = await sql()`
    SELECT slot_id, record_hash FROM baseball_analysis_direction_results
    WHERE snapshot_id = ${validated.snapshotId} ORDER BY slot_index
  `;
  if (rows.length !== 8) return { stored: false, reason: 'EIGHT_SLOT_WRITE_NOT_CONFIRMED', snapshotId: validated.snapshotId, storedCount: rows.length };
  const expected = new Map(validated.records.map(record => [record.slotId, record.recordHash]));
  for (const row of rows) {
    if (expected.get(row.slot_id) !== row.record_hash) throw new Error(`八方向歷史資料庫幂等衝突：${row.slot_id}`);
  }
  return {
    stored: true,
    inserted: inserted.length,
    idempotent: inserted.length === 0,
    snapshotId: validated.snapshotId,
    historyHash: validated.historyHash,
    storedCount: rows.length,
  };
}

export async function persistAnalysisDirectionHistoryBestEffort(input) {
  let bundle;
  try {
    bundle = input?.records ? validateAnalysisDirectionHistory(input) : buildAnalysisDirectionHistory(input);
    const result = await persistAnalysisDirectionHistory(bundle);
    return { status: result.stored ? 'CONFIRMED' : 'UNAVAILABLE', confirmed: result.stored === true, ...result };
  } catch (error) {
    console.error('[ANALYSIS_DIRECTION_HISTORY_WRITE_FAILED]', {
      snapshotId: input?.snapshotRecord?.snapshotId || input?.snapshotId || null,
      error: clean(error?.message || error, 1000),
    });
    return {
      status: 'FAILED',
      confirmed: false,
      stored: false,
      reason: 'WRITE_FAILED',
      snapshotId: input?.snapshotRecord?.snapshotId || input?.snapshotId || null,
      error: clean(error?.message || error, 500),
    };
  }
}

function recordFromStoredPayload(row) {
  const payload = typeof row?.record_payload === 'string' ? JSON.parse(row.record_payload) : row?.record_payload;
  return validateAnalysisDirectionRecord({ ...payload, recordHash: row.record_hash });
}

export async function loadAnalysisDirectionHistory(snapshotId) {
  const id = clean(snapshotId, 500);
  if (!id) throw new Error('八方向重播缺少snapshot ID');
  if (!analysisDirectionHistoryDatabaseConfigured()) throw new Error('八方向重播需要DATABASE_URL');
  await ensureAnalysisDirectionHistorySchema();
  const rows = await sql()`
    SELECT record_hash, record_payload FROM baseball_analysis_direction_results
    WHERE snapshot_id = ${id} ORDER BY slot_index
  `;
  if (!rows.length) return null;
  const records = rows.map(recordFromStoredPayload);
  const first = records[0];
  const bundle = {
    historySchemaVersion: ANALYSIS_DIRECTION_HISTORY_VERSION,
    snapshotId: first.snapshotId,
    leagueId: first.leagueId,
    gamePk: first.gamePk,
    distributionId: first.distributionId,
    distributionHash: first.distributionHash,
    records,
    historyHash: sha256(records.map(record => record.recordHash)),
  };
  return replayAnalysisDirectionHistory(bundle);
}

function settlementDatabasePayload(event) {
  return {
    settlement_id: event.settlementId,
    settlement_schema_version: event.settlementSchemaVersion,
    direction_result_id: event.directionResultId,
    supersedes_settlement_id: event.supersedesSettlementId,
    official_result_hash: event.officialResultHash,
    status: event.status,
    selected_period: event.selectedPeriod,
    selected_away_runs: event.selectedAwayRuns,
    selected_home_runs: event.selectedHomeRuns,
    outcome: event.outcome,
    win_fraction: event.winFraction,
    loss_fraction: event.lossFraction,
    push_fraction: event.pushFraction,
    leg_outcomes: event.legOutcomes,
    stake: event.stake,
    gross_win: event.grossWin,
    gross_loss: event.grossLoss,
    rebate: event.rebate,
    net_profit: event.netProfit,
    roi: event.roi,
    settlement_rule_version: event.settlementRuleVersion,
    result_provider: event.resultProvider,
    result_snapshot: event.resultSnapshot,
    settlement_error: event.settlementError,
    settled_at: event.settledAt,
  };
}

export async function persistAnalysisDirectionSettlements(events = []) {
  const values = (Array.isArray(events) ? events : []).filter(Boolean);
  if (!values.length) return { stored: true, inserted: 0, insertedIds: [], idempotent: true };
  if (!analysisDirectionHistoryDatabaseConfigured()) return { stored: false, reason: 'DATABASE_NOT_CONFIGURED' };
  await ensureAnalysisDirectionHistorySchema();
  const payload = values.map(settlementDatabasePayload);
  const inserted = await sql()`
    WITH incoming AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) AS row(
        settlement_id CHAR(64), settlement_schema_version TEXT, direction_result_id CHAR(64),
        supersedes_settlement_id CHAR(64), official_result_hash CHAR(64), status TEXT,
        selected_period TEXT, selected_away_runs NUMERIC, selected_home_runs NUMERIC, outcome TEXT,
        win_fraction NUMERIC, loss_fraction NUMERIC, push_fraction NUMERIC, leg_outcomes JSONB,
        stake NUMERIC, gross_win NUMERIC, gross_loss NUMERIC, rebate NUMERIC, net_profit NUMERIC, roi NUMERIC,
        settlement_rule_version TEXT, result_provider TEXT, result_snapshot JSONB,
        settlement_error TEXT, settled_at TIMESTAMPTZ
      )
    )
    INSERT INTO baseball_analysis_direction_settlements (
      settlement_id, settlement_schema_version, direction_result_id, supersedes_settlement_id,
      official_result_hash, status, selected_period, selected_away_runs, selected_home_runs, outcome,
      win_fraction, loss_fraction, push_fraction, leg_outcomes, stake, gross_win, gross_loss,
      rebate, net_profit, roi, settlement_rule_version, result_provider, result_snapshot,
      settlement_error, settled_at
    ) SELECT settlement_id, settlement_schema_version, direction_result_id, supersedes_settlement_id,
      official_result_hash, status, selected_period, selected_away_runs, selected_home_runs, outcome,
      win_fraction, loss_fraction, push_fraction, leg_outcomes, stake, gross_win, gross_loss,
      rebate, net_profit, roi, settlement_rule_version, result_provider, result_snapshot,
      settlement_error, settled_at FROM incoming
    ON CONFLICT DO NOTHING RETURNING settlement_id
  `;
  const insertedIds = inserted.map(row => clean(row?.settlement_id, 64)).filter(Boolean);
  return { stored: true, inserted: insertedIds.length, insertedIds, idempotent: insertedIds.length === 0 };
}

export async function runAnalysisDirectionSettlementTasks(games, worker, {
  concurrency = 4,
  timeBudgetMs = 240_000,
  now = () => Date.now(),
} = {}) {
  const queue = Array.isArray(games) ? games : [];
  const parallelism = Math.max(1, Math.min(16, Math.trunc(Number(concurrency) || 4), queue.length || 1));
  const budget = Math.max(1, Math.min(290_000, Number(timeBudgetMs) || 240_000));
  const startedAt = now();
  const results = new Array(queue.length);
  let cursor = 0;
  let started = 0;
  let completed = 0;
  let active = 0;
  let maxActive = 0;
  let timeBudgetExhausted = false;
  const runner = async () => {
    while (true) {
      if (now() - startedAt >= budget) {
        timeBudgetExhausted = cursor < queue.length;
        return;
      }
      const index = cursor;
      if (index >= queue.length) return;
      cursor += 1;
      started += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        results[index] = { ok: true, value: await worker(queue[index], index) };
      } catch (error) {
        results[index] = { ok: false, error };
      } finally {
        active -= 1;
        completed += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: parallelism }, () => runner()));
  return {
    results: results.filter(Boolean),
    started,
    completed,
    deferred: Math.max(0, queue.length - started),
    maxActive,
    timeBudgetExhausted: timeBudgetExhausted || started < queue.length,
    elapsedMs: Math.max(0, now() - startedAt),
  };
}

export function buildChangedAnalysisDirectionSettlements(rows, result) {
  const candidates = (Array.isArray(rows) ? rows : []).map(row => ({
    row,
    event: settleAnalysisDirectionRecord(
      row?.record || recordFromStoredPayload(row),
      result,
      { supersedesSettlementId: row?.latest_settlement_id || row?.latestSettlementId || null },
    ),
  })).filter(item => item.event);
  const changed = candidates.filter(({ row, event }) => (
    row?.latest_official_result_hash ?? row?.latestOfficialResultHash ?? null
  ) !== event.officialResultHash);
  return {
    candidates,
    changed,
    events: changed.map(item => item.event),
    skippedUnchanged: candidates.length - changed.length,
  };
}

export async function settlePendingAnalysisDirections({
  league = '',
  limitGames = 100,
  fetchResult = null,
  concurrency = 4,
  timeBudgetMs = 240_000,
  correctionLookbackDays = 14,
} = {}) {
  if (!analysisDirectionHistoryDatabaseConfigured()) return { stored: false, reason: 'DATABASE_NOT_CONFIGURED', gamesChecked: 0, directionsSettled: 0 };
  await ensureAnalysisDirectionHistorySchema();
  const leagueFilter = clean(league, 8).toUpperCase() || null;
  if (leagueFilter) leagueId(leagueFilter);
  const cap = Math.max(1, Math.min(500, Number(limitGames) || 100));
  const lookbackDays = Math.max(1, Math.min(30, Math.trunc(Number(correctionLookbackDays) || 14)));
  const pendingGames = await sql()`
    SELECT d.league_id, d.external_game_id, MIN(d.official_date) AS official_date,
      BOOL_OR(EXISTS (
        SELECT 1 FROM baseball_analysis_direction_settlements settled
        WHERE settled.direction_result_id = d.direction_result_id AND settled.status = 'SETTLED'
      )) AS has_settled
    FROM baseball_analysis_direction_results d
    WHERE d.status = 'CALCULATED'
      AND (${leagueFilter}::text IS NULL OR d.league_id = ${leagueFilter})
      AND d.game_start <= NOW()
      AND (
        d.game_start >= NOW() - (${lookbackDays}::integer * INTERVAL '1 day')
        OR NOT EXISTS (
          SELECT 1 FROM baseball_analysis_direction_settlements unresolved
          WHERE unresolved.direction_result_id = d.direction_result_id AND unresolved.status = 'SETTLED'
        )
      )
    GROUP BY d.league_id, d.external_game_id
    ORDER BY BOOL_OR(EXISTS (
      SELECT 1 FROM baseball_analysis_direction_settlements settled
      WHERE settled.direction_result_id = d.direction_result_id AND settled.status = 'SETTLED'
    )), MIN(d.game_start), d.league_id, d.external_game_id
    LIMIT ${cap}
  `;
  const resolver = fetchResult || (async (leagueIdValue, gamePk, options) => {
    const { fetchLeagueFinalResult } = await import('./league-provider.js');
    return fetchLeagueFinalResult(leagueIdValue, gamePk, options);
  });
  const summary = {
    stored: true,
    correctionLookbackDays: lookbackDays,
    gamesSelected: pendingGames.length,
    gamesChecked: 0,
    gamesRechecked: 0,
    gamesFinal: 0,
    directionsSettled: 0,
    manualReview: 0,
    correctionsAppended: 0,
    eventsSkippedUnchanged: 0,
    failures: [],
  };
  const batch = await runAnalysisDirectionSettlementTasks(pendingGames, async game => {
      summary.gamesChecked += 1;
      if (game.has_settled === true) summary.gamesRechecked += 1;
      const result = await resolver(game.league_id, Number(game.external_game_id), { date: game.official_date || undefined });
      if (result?.final !== true) return;
      summary.gamesFinal += 1;
      const rows = await sql()`
        SELECT d.record_hash, d.record_payload,
          latest.settlement_id AS latest_settlement_id,
          latest.official_result_hash AS latest_official_result_hash,
          latest.settlement_rule_version AS latest_settlement_rule_version
        FROM baseball_analysis_direction_results d
        LEFT JOIN LATERAL (
          SELECT s.settlement_id, s.official_result_hash, s.settlement_rule_version
          FROM baseball_analysis_direction_settlements s
          WHERE s.direction_result_id = d.direction_result_id
          ORDER BY s.created_at DESC, s.settled_at DESC, s.settlement_id DESC LIMIT 1
        ) latest ON TRUE
        WHERE d.league_id = ${game.league_id} AND d.external_game_id = ${game.external_game_id}
          AND d.status = 'CALCULATED'
        ORDER BY d.analysis_as_of, d.slot_index
      `;
      const correction = buildChangedAnalysisDirectionSettlements(rows, result);
      summary.eventsSkippedUnchanged += correction.skippedUnchanged;
      const { changed, events } = correction;
      const stored = await persistAnalysisDirectionSettlements(events);
      if (!stored.stored) throw new Error(stored.reason || '八方向結算寫入未確認');
      const insertedIds = new Set(stored.insertedIds || []);
      const insertedEvents = changed.filter(({ event }) => insertedIds.has(event.settlementId));
      summary.directionsSettled += insertedEvents.filter(({ event }) => event.status === 'SETTLED').length;
      summary.manualReview += insertedEvents.filter(({ event }) => event.status === 'MANUAL_REVIEW').length;
      summary.correctionsAppended += insertedEvents.filter(({ row }) => Boolean(row.latest_settlement_id)).length;
    }, { concurrency, timeBudgetMs });
  for (const [index, result] of batch.results.entries()) {
    if (result.ok) continue;
    const game = pendingGames[index] || {};
    summary.failures.push({
      league: game.league_id || null,
      gamePk: Number(game.external_game_id) || null,
      error: clean(result.error?.message || result.error, 500),
    });
  }
  summary.concurrency = batch.maxActive;
  summary.elapsedMs = batch.elapsedMs;
  summary.timeBudgetExhausted = batch.timeBudgetExhausted;
  summary.gamesDeferred = batch.deferred;
  return summary;
}

export async function loadAnalysisDirectionStats({
  league = '', market = '', wMin = null, wMax = null, rSign = '', qaStatus = '', lineType = '',
  minLeadMinutes = null, maxLeadMinutes = null,
} = {}) {
  if (!analysisDirectionHistoryDatabaseConfigured()) throw new Error('八方向統計需要DATABASE_URL');
  await ensureAnalysisDirectionHistorySchema();
  const leagueFilter = clean(league, 8).toUpperCase() || null;
  if (leagueFilter) leagueId(leagueFilter);
  const marketFilter = clean(market, 40) || null;
  const rFilter = clean(rSign, 20).toUpperCase() || null;
  if (rFilter && !['POSITIVE', 'NON_POSITIVE', 'MISSING'].includes(rFilter)) throw new Error('R正負篩選無效');
  const qaFilter = clean(qaStatus, 80).toUpperCase() || null;
  const lineFilter = clean(lineType, 40).toUpperCase() || null;
  const minimumW = finite(wMin);
  const maximumW = finite(wMax);
  const minimumLead = finite(minLeadMinutes);
  const maximumLead = finite(maxLeadMinutes);
  const rows = await sql()`
    WITH latest_settlement AS (
      SELECT DISTINCT ON (direction_result_id) direction_result_id, status, outcome, stake, net_profit,
        settled_at, settlement_id
      FROM baseball_analysis_direction_settlements
      ORDER BY direction_result_id, created_at DESC, settled_at DESC, settlement_id DESC
    ), filtered AS (
      SELECT
        d.league_id AS league,
        d.market,
        CASE
          WHEN d.model_ev < 0 THEN 'NEGATIVE'
          WHEN d.model_ev < 0.02 THEN '0_TO_2_PERCENT'
          WHEN d.model_ev < 0.05 THEN '2_TO_5_PERCENT'
          WHEN d.model_ev < 0.10 THEN '5_TO_10_PERCENT'
          ELSE '10_PERCENT_PLUS'
        END AS w_band,
        CASE WHEN d.robust_ev IS NULL THEN 'MISSING'
          WHEN d.robust_ev > 0 THEN 'POSITIVE' ELSE 'NON_POSITIVE' END AS r_sign,
        COALESCE(NULLIF(UPPER(d.qa_status), ''), 'UNKNOWN') AS qa_status,
        COALESCE(NULLIF(UPPER(d.line_type), ''), 'UNKNOWN') AS line_type,
        CASE
          WHEN d.lead_minutes < 60 THEN 'UNDER_1_HOUR'
          WHEN d.lead_minutes < 180 THEN '1_TO_3_HOURS'
          WHEN d.lead_minutes < 720 THEN '3_TO_12_HOURS'
          WHEN d.lead_minutes < 1440 THEN '12_TO_24_HOURS'
          ELSE '24_HOURS_PLUS'
        END AS lead_band,
        s.outcome, s.stake, s.net_profit
      FROM baseball_analysis_direction_results d
      JOIN latest_settlement s ON s.direction_result_id = d.direction_result_id
      WHERE d.status = 'CALCULATED' AND s.status = 'SETTLED'
        AND (${leagueFilter}::text IS NULL OR d.league_id = ${leagueFilter})
        AND (${marketFilter}::text IS NULL OR d.market = ${marketFilter})
        AND (${minimumW}::numeric IS NULL OR d.model_ev >= ${minimumW})
        AND (${maximumW}::numeric IS NULL OR d.model_ev < ${maximumW})
        AND (${rFilter}::text IS NULL
          OR (${rFilter} = 'POSITIVE' AND d.robust_ev > 0)
          OR (${rFilter} = 'NON_POSITIVE' AND d.robust_ev <= 0)
          OR (${rFilter} = 'MISSING' AND d.robust_ev IS NULL))
        AND (${qaFilter}::text IS NULL OR UPPER(d.qa_status) = ${qaFilter})
        AND (${lineFilter}::text IS NULL OR UPPER(d.line_type) = ${lineFilter})
        AND (${minimumLead}::numeric IS NULL OR d.lead_minutes >= ${minimumLead})
        AND (${maximumLead}::numeric IS NULL OR d.lead_minutes < ${maximumLead})
    )
    SELECT GROUPING(league) AS all_group, league, market, w_band, r_sign, qa_status, line_type, lead_band,
      COUNT(*) AS sample_size,
      COUNT(*) FILTER (WHERE outcome = 'WIN') AS wins,
      COUNT(*) FILTER (WHERE outcome = 'LOSS') AS losses,
      COUNT(*) FILTER (WHERE outcome = 'PUSH') AS pushes,
      COUNT(*) FILTER (WHERE outcome = 'HALF_WIN') AS half_wins,
      COUNT(*) FILTER (WHERE outcome = 'HALF_LOSS') AS half_losses,
      COUNT(*) FILTER (WHERE outcome NOT IN ('WIN', 'LOSS', 'PUSH', 'HALF_WIN', 'HALF_LOSS')) AS mixed,
      COALESCE(SUM(stake), 0) AS total_stake,
      COALESCE(SUM(net_profit), 0) AS total_profit
    FROM filtered
    GROUP BY GROUPING SETS ((), (league, market, w_band, r_sign, qa_status, line_type, lead_band))
    ORDER BY GROUPING(league) DESC, league, market, w_band, r_sign, qa_status, line_type, lead_band
  `;
  const fromAggregate = (row, key, dimensions = {}) => finishStats({
    ...emptyStats(key, dimensions),
    sampleSize: Number(row?.sample_size) || 0,
    wins: Number(row?.wins) || 0,
    losses: Number(row?.losses) || 0,
    pushes: Number(row?.pushes) || 0,
    halfWins: Number(row?.half_wins) || 0,
    halfLosses: Number(row?.half_losses) || 0,
    mixed: Number(row?.mixed) || 0,
    totalStake: finite(row?.total_stake) || 0,
    totalProfit: finite(row?.total_profit) || 0,
  });
  const overallRow = rows.find(row => Number(row?.all_group) === 1);
  const groups = rows.filter(row => Number(row?.all_group) === 0).map(row => {
    const dimensions = {
      league: clean(row.league, 8).toUpperCase(),
      market: clean(row.market, 40),
      wBand: clean(row.w_band, 40),
      rSign: clean(row.r_sign, 20),
      qaStatus: clean(row.qa_status, 80),
      lineType: clean(row.line_type, 40),
      leadBand: clean(row.lead_band, 40),
    };
    const key = [dimensions.league, dimensions.market, dimensions.wBand, dimensions.rSign,
      dimensions.qaStatus, dimensions.lineType, dimensions.leadBand].join('|||');
    return fromAggregate(row, key, dimensions);
  });
  return {
    version: ANALYSIS_DIRECTION_SETTLEMENT_VERSION,
    overall: overallRow ? fromAggregate(overallRow, 'ALL') : emptyStats('ALL'),
    groups,
  };
}
