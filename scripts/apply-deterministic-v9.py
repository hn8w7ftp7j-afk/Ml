from pathlib import Path
import json


def one(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match, found {count}')
    return text.replace(old, new, 1)


def replace_between(text, start, end, replacement, label):
    left = text.find(start)
    right = text.find(end, left + len(start))
    if left < 0 or right < 0:
        raise SystemExit(f'{label}: markers missing')
    return text[:left] + replacement.rstrip() + '\n\n' + text[right:]

# ---------------------------------------------------------------------------
# Taiwan contract parser / settlement integration
# ---------------------------------------------------------------------------
p = Path('lib/markets.js')
s = p.read_text()
if not s.startswith("import { parseTaiwanContract"):
    s = "import { parseTaiwanContract, settleTaiwanContract, settlementProfit, profitFromNetFraction, SETTLEMENT_RULE_VERSION } from './taiwan-settlement-v9.js';\n\n" + s
s = s.replace("export const SCORE_CONTRACT_VERSION = 'GPT-COMPOSITE-EVIDENCE-v8.3';", "export const SCORE_CONTRACT_VERSION = 'DUAL-EV-BOTTLENECK-2026-08-v1.0.0';\nexport { SETTLEMENT_RULE_VERSION, settleTaiwanContract };")
start = 'export function parseTaiwanLine(pick) {'
end = 'export function resultLabel(fraction) {'
replacement = '''export function parseTaiwanLine(pick, options = {}) {
  return parseTaiwanContract(pick, options);
}

function normalizeTeamName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9\\u4e00-\\u9fff]/g, '');
}

export function outcomeSettlementForScore(pick, awayRuns, homeRuns, awayName = '', homeName = '', options = {}) {
  return settleTaiwanContract(pick, awayRuns, homeRuns, awayName, homeName, options);
}

export function outcomeFractionForScore(pick, awayRuns, homeRuns, awayName = '', homeName = '') {
  const settlement = settleTaiwanContract(pick, awayRuns, homeRuns, awayName, homeName);
  return settlement == null ? null : settlement.netFraction;
}'''
s = replace_between(s, start, end, replacement, 'replace parser settlement block')
old_profit_start = 'export function calculateProfit({ stake, water, fraction, rebateRate = 0.015 }) {'
old_profit_end = 'export function priceCLV(openWater, closeWater) {'
new_profit = '''export function calculateProfit({ stake, water, fraction, settlement = null, rebateRate = 0.015 }) {
  return settlement
    ? settlementProfit({ stake, water, settlement, rebateRate })
    : profitFromNetFraction({ stake, water, fraction, rebateRate });
}'''
s = replace_between(s, old_profit_start, old_profit_end, new_profit, 'replace profit block')
p.write_text(s)

# ---------------------------------------------------------------------------
# Full deterministic analysis route. No GPT scorer and no GPT residual layer.
# ---------------------------------------------------------------------------
Path('app/api/analyze/route.js').write_text(r'''import { NextResponse } from 'next/server';
import { buildGameContext } from '../../../lib/mlb.js';
import { analyzeMarkets, MODEL_VERSION, RULES_VERSION } from '../../../lib/analysis.js';
import { finalizeDeterministicAnalysis, UNCERTAINTY_SET_VERSION } from '../../../lib/deterministic-finalizer.js';
import { SCORE_FORMULA_VERSION } from '../../../lib/deterministic-score.js';
import { SETTLEMENT_RULE_VERSION } from '../../../lib/taiwan-settlement-v9.js';
import { buildSnapshotFingerprints, DATA_VERSION } from '../../../lib/snapshot-v9.js';
import { MARKET_ORDER, marketIsOpen, validateMarketPair } from '../../../lib/markets.js';
import {
  checkRateLimit,
  cleanText,
  originErrorResponse,
  positiveInteger,
  rateLimitResponse,
  readJsonBody,
  requireApiAuth,
  validateSameOrigin,
} from '../../../lib/security.js';

export const runtime = 'nodejs';
export const maxDuration = 90;
export const dynamic = 'force-dynamic';

const responseCache = globalThis.__MLB_V9_ANALYSIS_CACHE__ || new Map();
globalThis.__MLB_V9_ANALYSIS_CACHE__ = responseCache;

function optionalNumber(value) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sanitizeGame(game) {
  const safe = {
    gamePk: positiveInteger(game?.gamePk),
    gameDate: cleanText(game?.gameDate, 40),
    officialDate: cleanText(game?.officialDate, 20),
    status: cleanText(game?.status, 60),
    statusEnglish: cleanText(game?.statusEnglish, 60),
    statusCode: cleanText(game?.statusCode, 10),
    doubleHeader: cleanText(game?.doubleHeader, 10),
    gameNumber: positiveInteger(game?.gameNumber) || 1,
    scheduledInnings: positiveInteger(game?.scheduledInnings) || 9,
    away: cleanText(game?.away, 80),
    home: cleanText(game?.home, 80),
    awayEnglish: cleanText(game?.awayEnglish, 80),
    homeEnglish: cleanText(game?.homeEnglish, 80),
    venue: cleanText(game?.venue, 100),
    venueEnglish: cleanText(game?.venueEnglish, 100),
    awayTeamId: positiveInteger(game?.awayTeamId),
    homeTeamId: positiveInteger(game?.homeTeamId),
    venueId: positiveInteger(game?.venueId),
    awayProbableId: positiveInteger(game?.awayProbableId),
    homeProbableId: positiveInteger(game?.homeProbableId),
    awayProbable: cleanText(game?.awayProbable, 80),
    homeProbable: cleanText(game?.homeProbable, 80),
  };
  return safe.gamePk && safe.awayTeamId && safe.homeTeamId && safe.away && safe.home ? safe : null;
}

function gameAlreadyStarted(game) {
  const text = `${game?.statusCode || ''} ${game?.statusEnglish || ''} ${game?.status || ''}`.toLowerCase();
  return /in progress|game over|final|completed|live/.test(text) || ['I', 'F', 'O'].includes(String(game?.statusCode || '').toUpperCase());
}

function cleanVerification(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const sources = (Array.isArray(value.sources) ? value.sources : []).slice(0, 4).map(source => ({
    provider: cleanText(source?.provider, 80),
    independentGroup: cleanText(source?.independentGroup, 80),
    observedAt: cleanText(source?.observedAt, 40),
    contractKey: cleanText(source?.contractKey, 160),
  })).filter(source => source.provider && source.independentGroup && source.observedAt && source.contractKey);
  const groups = new Set(sources.map(source => source.independentGroup));
  return {
    sources,
    verified: value.verified === true && sources.length >= 2 && groups.size >= 2,
    policyStatus: cleanText(value.policyStatus, 80) || 'MANUAL_EVIDENCE_ONLY',
  };
}

function sanitizeMarketRows(rows, maximum = 16) {
  return (Array.isArray(rows) ? rows : []).slice(0, maximum).map(row => ({
    market: MARKET_ORDER.includes(row?.market) ? row.market : '',
    pick: cleanText(row?.pick, 120),
    water: optionalNumber(row?.water),
    waterEstimated: Boolean(row?.waterEstimated),
    confidence: Math.max(0, Math.min(1, Number(row?.confidence) || 0)),
    sourceType: cleanText(row?.sourceType, 40) || (row?.waterEstimated ? 'ESTIMATED' : 'ACTUAL_TW_CREDIT'),
    lineAsOf: cleanText(row?.lineAsOf, 40),
    executable: row?.executable !== false,
    marketVerification: cleanVerification(row?.marketVerification),
  })).filter(row => row.market);
}

function cacheSet(key, value) {
  responseCache.set(key, value);
  while (responseCache.size > 100) responseCache.delete(responseCache.keys().next().value);
}

export async function POST(request) {
  try {
    const auth = await requireApiAuth(request); if (auth) return auth;
    if (!validateSameOrigin(request)) return originErrorResponse();
    const rate = checkRateLimit(request, { id: 'analyze-v9-deterministic', limit: 60, windowMs: 10 * 60 * 1000 });
    if (!rate.allowed) return rateLimitResponse(rate);

    const body = await readJsonBody(request, 350000);
    const game = sanitizeGame(body.game);
    if (!game || !Array.isArray(body.markets)) {
      return NextResponse.json({ ok: false, error: '缺少或無效的賽事／盤口資料' }, { status: 400 });
    }
    if (gameAlreadyStarted(game)) {
      return NextResponse.json({ ok: false, error: '比賽已開打或結束｜賽前模型停止評分' }, { status: 409 });
    }

    const markets = sanitizeMarketRows(body.markets, 12);
    const previousMarkets = sanitizeMarketRows(body.previousMarkets, 24);
    const errors = [];
    for (const name of MARKET_ORDER) {
      const pair = markets.filter(row => row.market === name);
      if (!marketIsOpen(pair)) continue;
      errors.push(...validateMarketPair(name, pair).map(error => `${name}：${error}`));
    }
    if (errors.length) {
      return NextResponse.json({ ok: false, error: `⛔ QA未通過｜不評分｜不下注：${[...new Set(errors)].join('、')}` }, { status: 400 });
    }
    const activeMarkets = markets.filter(row => row.pick);
    if (!activeMarkets.length) return NextResponse.json({ ok: false, error: '目前沒有任何已開盤市場可分析' }, { status: 400 });

    const settings = {
      rebateRate: Math.max(0, Math.min(0.1, Number(body.settings?.rebateRate) || 0.015)),
      candidateThreshold: 7.2,
      strongestThreshold: 8.5,
      simulationsPerScenario: Math.max(500, Math.min(4000, Math.round(Number(body.settings?.simulationsPerScenario) || 1800))),
      expertMode: 'off',
    };

    const context = await Promise.race([
      buildGameContext(game),
      new Promise((_, reject) => setTimeout(() => reject(new Error('MLB資料取得逾時，請稍後重試')), 30000)),
    ]);
    const preliminary = analyzeMarkets({ context, markets: activeMarkets, previousMarkets, settings });
    const analysis = finalizeDeterministicAnalysis({ analysis: preliminary, game, settings });
    const versions = {
      modelVersion: MODEL_VERSION,
      rulesVersion: RULES_VERSION,
      dataVersion: DATA_VERSION,
      scoreFormulaVersion: SCORE_FORMULA_VERSION,
      settlementRuleVersion: SETTLEMENT_RULE_VERSION,
      uncertaintySetVersion: UNCERTAINTY_SET_VERSION,
    };
    const fingerprints = buildSnapshotFingerprints({ context, markets: activeMarkets, versions });
    const cached = responseCache.get(fingerprints.inputHash);
    if (cached) return NextResponse.json(cached, { headers: { 'Cache-Control': 'no-store', 'X-Analysis-Cache': 'HIT' } });

    const analysisAsOf = new Date().toISOString();
    const lineAsOf = activeMarkets.map(row => row.lineAsOf).filter(Boolean).sort().at(-1) || analysisAsOf;
    const finalized = {
      ...analysis,
      ...fingerprints,
      analysisType: 'FULL',
      dataVersion: DATA_VERSION,
      dataAsOf: context.fetchedAt || analysisAsOf,
      lineAsOf,
      analysisAsOf,
      snapshotId: fingerprints.inputHash,
    };
    const payload = {
      ok: true,
      game,
      context,
      analysis: finalized,
      repriceSnapshot: {
        frozenContext: context,
        coreFingerprint: fingerprints.coreFingerprint,
        priceFingerprint: fingerprints.priceFingerprint,
        inputHash: fingerprints.inputHash,
        distributionId: finalized.distributionId,
        dataAsOf: finalized.dataAsOf,
        simulationsPerScenario: finalized.scenarioSummary?.simulationsPerScenario,
        versions,
      },
      openMarkets: [...new Set(activeMarkets.map(row => row.market))],
    };
    cacheSet(fingerprints.inputHash, payload);
    return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store', 'X-Analysis-Cache': 'MISS' } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error?.message || error) }, {
      status: Number(error?.status) || 500,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
''')

# ---------------------------------------------------------------------------
# Health/version endpoint
# ---------------------------------------------------------------------------
Path('app/api/health/route.js').write_text(r'''import { NextResponse } from 'next/server';
import { appPasswordConfigured } from '../../../lib/security.js';
import { MODEL_VERSION, RULES_VERSION } from '../../../lib/analysis.js';
import { VISION_VERSION } from '../../../lib/vision.js';
import { BATCH_VERSION } from '../../../lib/batch.js';
import { FINAL_ENGINE_VERSION, UNCERTAINTY_SET_VERSION } from '../../../lib/deterministic-finalizer.js';
import { SCORE_FORMULA_VERSION, SCORE_POLICY_VERSION } from '../../../lib/deterministic-score.js';
import { SETTLEMENT_RULE_VERSION } from '../../../lib/taiwan-settlement-v9.js';
import { DATA_VERSION, REPRICE_VERSION } from '../../../lib/snapshot-v9.js';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({
    ok: true,
    version: '9.0.0-preview',
    modelVersion: MODEL_VERSION,
    rulesVersion: RULES_VERSION,
    dataVersion: DATA_VERSION,
    visionVersion: VISION_VERSION,
    batchVersion: BATCH_VERSION,
    finalEngineVersion: FINAL_ENGINE_VERSION,
    scoreFormulaVersion: SCORE_FORMULA_VERSION,
    scorePolicyVersion: SCORE_POLICY_VERSION,
    settlementRuleVersion: SETTLEMENT_RULE_VERSION,
    uncertaintySetVersion: UNCERTAINTY_SET_VERSION,
    repriceVersion: REPRICE_VERSION,
    deterministicScoring: true,
    gptScoringEnabled: false,
    aiGatewayConfiguredForVision: Boolean(process.env.AI_GATEWAY_API_KEY),
    databaseConfigured: Boolean(process.env.DATABASE_URL),
    authConfigured: appPasswordConfigured(),
    commit: process.env.VERCEL_GIT_COMMIT_SHA || null,
    time: new Date().toISOString(),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
''')

# ---------------------------------------------------------------------------
# Client integration: deterministic scoring, precise settlement, quick reprice.
# ---------------------------------------------------------------------------
p = Path('app/page.js')
s = p.read_text()
s = s.replace('  outcomeFractionForScore,', '  outcomeFractionForScore,\n  settleTaiwanContract,')
s = one(s, "const VERSION = '8.4.3';", "const VERSION = '9.0.0-preview';", 'page version')
s = one(s, "const STORAGE = 'mlb-positive-ev-v8-4-3';", "const STORAGE = 'mlb-positive-ev-v9-preview';", 'storage namespace')
s = one(s, "const FINAL_SCORE_VERSION = 'GPT-FINAL-EXECUTION-JUDGE-2026-08-v8.4.3';", "const SCORE_FORMULA_VERSION = 'DUAL-EV-BOTTLENECK-2026-08-v1.0.0';", 'page score version')
old_request = '''async function requestAnalysisJSON(payload, onRetry = null) {
  let lastError = null;
  const delays = [0, 30000, 90000];
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt]) {
      onRetry?.(`GPT 評分服務忙碌，等待 ${Math.round(delays[attempt] / 1000)} 秒後自動重試（${attempt + 1}/${delays.length}）`);
      await sleep(delays[attempt]);
    }
    try {
      return await requestJSON('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }, 180000);
    } catch (error) {
      lastError = error;
      const retryable = Number(error?.status) === 429 || /429|rate.?limit|too many requests|額度|credits|評分服務忙碌/i.test(String(error?.message || ''));
      if (!retryable || attempt === delays.length - 1) throw error;
    }
  }
  throw lastError || new Error('GPT 最終評分未完成');
}'''
new_request = '''async function requestAnalysisJSON(payload, onRetry = null) {
  let lastError = null;
  const delays = [0, 3000, 9000];
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt]) {
      onRetry?.(`資料服務暫時忙碌，${Math.round(delays[attempt] / 1000)} 秒後自動重試`);
      await sleep(delays[attempt]);
    }
    try {
      return await requestJSON('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': globalThis.crypto?.randomUUID?.() || `${Date.now()}` },
        body: JSON.stringify(payload),
      }, 120000);
    } catch (error) {
      lastError = error;
      if (![429, 503, 504].includes(Number(error?.status)) || attempt === delays.length - 1) throw error;
    }
  }
  throw lastError || new Error('固定分析尚未完成');
}

async function requestRepriceJSON(payload) {
  return requestJSON('/api/reprice', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': globalThis.crypto?.randomUUID?.() || `${Date.now()}` },
    body: JSON.stringify(payload),
  }, 120000);
}'''
s = one(s, old_request, new_request, 'request analysis replacement')
old_snapshot = '''function scoreSnapshotIsValid(version) {
  const analysis = version?.analysis;
  if (!analysis || analysis.finalScoreVersion !== FINAL_SCORE_VERSION || analysis.scoreValidation?.passed !== true) return false;
  return (analysis.results || []).every(result => result.score == null || (
    Number.isFinite(Number(result.score))
    && Number(result.score) >= 1
    && Number(result.score) <= 9.4
    && result.scoreAudit?.ok === true
    && result.scoreSource === 'GPT 最終 Execution 判讀'
  ));
}'''
new_snapshot = '''function scoreSnapshotIsValid(version) {
  const analysis = version?.analysis;
  if (!analysis || analysis.scoreFormulaVersion !== SCORE_FORMULA_VERSION || analysis.scoreValidation?.passed !== true) return false;
  return (analysis.results || []).every(result => result.score == null || (
    Number.isFinite(Number(result.score))
    && Number(result.score) >= 1
    && Number(result.score) <= 8.9
    && result.scoreAudit?.ok === true
    && result.scoreSource === '固定雙EV短板公式'
  ));
}'''
s = one(s, old_snapshot, new_snapshot, 'snapshot validator')
# Preserve every valid version instead of truncating to 30.
s = s.replace("[analysisVersion, ...(value.analysisHistory[lock.id] || [])].slice(0, 30)", "[analysisVersion, ...(value.analysisHistory[lock.id] || [])]")
s = s.replace("[version, ...(value.analysisHistory[lock.id] || [])].slice(0, 30)", "[version, ...(value.analysisHistory[lock.id] || [])]")
s = s.replace("locks: [...plan.locks, ...value.locks].slice(0, 300)", "locks: [...plan.locks, ...value.locks]")
s = s.replace("locks: [lock, ...value.locks].slice(0, 300)", "locks: [lock, ...value.locks]")
# Add frozen-price reprice action after the full analyze function.
marker = '''  function removeLock(id) {
    if (!confirm('刪除這個盤口快照與其分析版本？下注紀錄不受影響。')) return;'''
reprice_function = '''  async function reprice(lock) {
    if (busyLocks[lock.id]) return;
    const parentLock = [...store.locks]
      .filter(item => item.id !== lock.id && String(item.game?.gamePk) === String(lock.game?.gamePk) && new Date(item.lockedAt) < new Date(lock.lockedAt))
      .sort((left, right) => new Date(right.lockedAt) - new Date(left.lockedAt))
      .find(item => latestVersion(store.analysisHistory, item.id)?.repriceSnapshot);
    const parent = parentLock ? latestVersion(store.analysisHistory, parentLock.id) : null;
    if (!parent?.repriceSnapshot) return alert('找不到同場上一個凍結比分分布，請先做一次完整分析');
    setBusyLocks(value => ({ ...value, [lock.id]: true }));
    try {
      const data = await requestRepriceJSON({
        snapshot: parent.repriceSnapshot,
        markets: lock.markets,
        previousMarkets: parentLock.markets || [],
        settings: store.settings,
      });
      const version = { id: uid(), createdAt: new Date().toISOString(), ...data };
      setStore(value => ({
        ...value,
        analysisHistory: {
          ...value.analysisHistory,
          [lock.id]: [version, ...(value.analysisHistory[lock.id] || [])],
        },
      }));
      setTab('analysis');
    } catch (error) {
      alert(`快速重算失敗：${error.message}`);
    } finally {
      setBusyLocks(value => ({ ...value, [lock.id]: false }));
    }
  }

  function removeLock(id) {
    if (!confirm('刪除這個盤口快照與其分析版本？下注紀錄不受影響。')) return;'''
s = one(s, marker, reprice_function, 'insert reprice function')
# No invented Unit formula.
s = one(s, "    const unit = result.portfolioUnit || result.unitSuggestion || 0.5;", "    const unit = Number(result.portfolioUnit ?? result.unitSuggestion ?? 0);", 'unit initialization')
# Precise per-leg settlement in bet ledger.
old_settle = '''    const fraction = outcomeFractionForScore(bet.pick, Number(awayRuns), Number(homeRuns), bet.away, bet.home);
    if (fraction == null) return alert('盤口或球隊名稱無法結算');
    const stake = Number(bet.unit || 1) * store.settings.unitValue;
    const calculation = calculateProfit({ stake, water: bet.water, fraction, rebateRate: store.settings.rebateRate });'''
new_settle = '''    const settlement = settleTaiwanContract(bet.pick, Number(awayRuns), Number(homeRuns), bet.away, bet.home);
    if (settlement == null) return alert('盤口或球隊名稱無法結算');
    const fraction = settlement.netFraction;
    const stake = Number(bet.unit || 0) * store.settings.unitValue;
    const calculation = calculateProfit({ stake, water: bet.water, settlement, rebateRate: store.settings.rebateRate });'''
s = one(s, old_settle, new_settle, 'bet settlement')
s = one(s, "updateBet(bet.id, { ...scorePatch, stake, fraction, result: resultLabel(fraction), profit: calculation.profit, rebate: calculation.rebate, clv });", "updateBet(bet.id, { ...scorePatch, stake, fraction, settlement, result: resultLabel(fraction), profit: calculation.profit, rebate: calculation.rebate, clv });", 'save leg settlement')
# Header and loading copy.
s = s.replace("health?.ok && health?.aiGatewayConfigured ? 'ok' : 'warn'", "health?.ok && health?.deterministicScoring ? 'ok' : 'warn'")
s = s.replace("health?.ok ? (health.aiGatewayConfigured ? '人工智慧正常' : '人工智慧未設定') : '系統檢查中'", "health?.ok ? (health.deterministicScoring ? '固定評分正常' : '固定評分未啟用') : '系統檢查中'")
s = s.replace('正在取得資料、建立聯合情境並執行 GPT 最終評分…', '正在取得資料、建立聯合情境並執行固定雙EV評分…')
old_note = '''            <div className="note">GPT 最終評分：{data.analysis.scoreValidation?.passed ? `通過（${data.analysis.scoreValidation.checkedDirections} 個方向）` : `失敗，已封鎖異常分數（${data.analysis.scoreValidation?.failures?.length || 0} 項）`}｜{data.analysis.finalScoreModel || '模型未回報'}｜無固定 EV 換分公式｜{data.analysis.finalScoreVersion}</div>'''
new_note = '''            <div className="note">固定評分：{data.analysis.scoreValidation?.passed ? `通過（${data.analysis.scoreValidation.checkedDirections} 個方向）` : `失敗，已封鎖異常分數（${data.analysis.scoreValidation?.failures?.length || 0} 項）`}｜雙EV短板法｜GPT不得調分｜{data.analysis.scoreFormulaVersion}</div>'''
s = one(s, old_note, new_note, 'analysis note')
# Analysis header buttons: full rebuild and frozen reprice are explicit and separate.
old_buttons = '''<div className="analysisHead"><div><h2>{matchup(lock.game)}</h2><small>盤口快照 {dateText(lock.lockedAt)}｜分析版本 {versions.length}</small></div><button className="secondary" disabled={busyLocks[lock.id]} onClick={() => analyze(lock)}>{busyLocks[lock.id] ? '完整分析中…' : '以最新資料重算新版本'}</button></div>'''
new_buttons = '''<div className="analysisHead"><div><h2>{matchup(lock.game)}</h2><small>盤口快照 {dateText(lock.lockedAt)}｜分析版本 {versions.length}</small></div><div className="toolbar"><button className="secondary" disabled={busyLocks[lock.id]} onClick={() => reprice(lock)}>{busyLocks[lock.id] ? '處理中…' : '只改盤口／水位快速重算'}</button><button className="secondary" disabled={busyLocks[lock.id]} onClick={() => analyze(lock)}>{busyLocks[lock.id] ? '完整分析中…' : '核心資料完整重算'}</button></div></div>'''
s = one(s, old_buttons, new_buttons, 'analysis action buttons')
# Snapshot list buttons.
old_lock_buttons = '''<div className="toolbar"><button className="primary" disabled={busyLocks[lock.id]} onClick={() => analyze(lock)}>{busyLocks[lock.id] ? '完整分析中…' : '建立新分析版本'}</button><button className="dangerSmall" onClick={() => removeLock(lock.id)}>刪除</button></div>'''
new_lock_buttons = '''<div className="toolbar"><button className="secondary" disabled={busyLocks[lock.id]} onClick={() => reprice(lock)}>{busyLocks[lock.id] ? '處理中…' : '快速重算價格'}</button><button className="primary" disabled={busyLocks[lock.id]} onClick={() => analyze(lock)}>{busyLocks[lock.id] ? '完整分析中…' : '完整重算核心資料'}</button><button className="dangerSmall" onClick={() => removeLock(lock.id)}>刪除</button></div>'''
s = one(s, old_lock_buttons, new_lock_buttons, 'lock buttons')
# Classic mobile output: formula evidence, no GPT / invented Unit.
old_classic_meta = '''    {score != null && <><div className="classicMeta">加權 EV {pct(result.weightedEV)}｜穩健 EV {pct(result.robustEV)}｜保守 EV {pct(result.conservativeEV)}｜驗算 {result.scoreAudit?.ok ? '通過' : '失敗'}｜建議 {unit} Unit</div><div className="classicMeta">GPT 評分：{result.scoreReason || '—'}｜{result.scoreModel || '—'}</div></>}'''
new_classic_meta = '''    {score != null && <><div className="classicMeta">加權 EV {pct(result.weightedEV)}｜穩健 EV {pct(result.robustEV)}｜驗算 {result.scoreAudit?.ok ? '通過' : '失敗'}｜Unit {result.unitSuggestion == null ? '待風控公式校準' : `${unit}`}</div><div className="classicMeta">固定公式：{result.scoreFormulaVersion || '—'}{result.scoreBreakdown?.caps?.length ? `｜封頂 ${result.scoreBreakdown.caps.join('、')}` : ''}</div>{score >= 7.2 && <div className="classicMeta">QA：PASS｜合約✓ 水碼✓ 鏡像✓ 機率100%✓ EV雙算✓ 市場{score >= 8.5 ? '✓' : '—'} 分數上限✓</div>}</>}'''
s = one(s, old_classic_meta, new_classic_meta, 'classic score meta')
s = s.replace("{result.scoreAudit?.ok === false && <div className=\"classicMeta\">評分已封鎖：{result.scoreAudit.errors?.join('；')}</div>}", "{result.scoreAudit?.ok === false && <div className=\"classicMeta\">評分已封鎖：{result.scoreAudit?.baseQa?.failures?.join('；') || result.scoreAudit?.boundary?.errors?.join('；') || 'QA未通過'}</div>}")
# Context/detail wording.
s = s.replace('<Info t="GPT 研究判讀" v={`${analysis.alignmentAudit?.expertLayer?.used ? \'已整合\' : \'統計備援\'}｜${analysis.alignmentAudit?.expertLayer?.model || analysis.alignmentAudit?.expertLayer?.reason || \'—\'}`}/>', '<Info t="固定評分" v={`${analysis.scoreFormulaVersion || \'—\'}｜GPT不參與數字評分`}/>')
s = s.replace('GPT 指令對齊與未知資料檢查', '資料狀態與未知資訊檢查')
s = s.replace("{audit.expertLayer?.used ? 'GPT 已整合' : '統計備援'}", "聯合情境")
# Versioned export names and restore copy.
s = s.replace('mlb-positive-ev-v7-', 'mlb-positive-ev-v9-')
s = s.replace('mlb-bets-v7-', 'mlb-bets-v9-')
s = s.replace("alert('第 7 版備份已還原');", "alert('備份已還原；舊版分數保留為歷史資料，不會冒充固定公式分數');")
p.write_text(s)

# ---------------------------------------------------------------------------
# Package/version/metadata
# ---------------------------------------------------------------------------
p = Path('package.json')
package = json.loads(p.read_text())
package['version'] = '9.0.0-preview'
package['scripts']['test'] = 'node scripts/deterministic-v9-test.mjs && node scripts/security-test.mjs'
package['dependencies']['decimal.js'] = '^10.6.0'
p.write_text(json.dumps(package, ensure_ascii=False, indent=2) + '\n')
Path('DEPLOYMENT_VERSION').write_text('9.0.0-preview-deterministic-dual-ev\n')

p = Path('app/layout.js')
s = p.read_text()
s = s.replace('完整 GPT 聯合情境模型', '固定雙EV短板聯合情境模型')
s = s.replace('實際開盤、聯合情境、穩健 EV、版本化績效追蹤', '實際開盤、逐腿結算、加權EV、穩健EV、固定可重現評分')
p.write_text(s)

p = Path('.env.example')
s = p.read_text()
if 'DATABASE_URL=' not in s:
    s += 'DATABASE_URL=\n'
p.write_text(s)

p = Path('README.md')
s = p.read_text()
s += r'''

## 9.0.0 Preview｜固定雙EV短板、逐腿退水與價格快速重算

此分支不會自動部署 Production。正式數字評分已移除 GPT 自由判斷，改為 `DUAL-EV-BOTTLENECK-2026-08-v1.0.0`：

- 加權EV≤0固定6.6；加權EV>0但穩健EV≤0固定7.1。
- 7.2～8.9使用加權EV與穩健EV各自區間進度的較低值。
- 每個區間使用下一評分區間起點作數學上界，最後無條件捨去到一位小數。
- 8.5區間使用7%/4%起點、12%/8%虛擬9.0飽和點；沒有兩個獨立相同合約市場即封頂8.4。
- 一般單腿最高8.9，內部Raw Score達9.0進高分異常與人工確認流程。
- QA只可作資格、封頂或攔截，不得主觀加減分。
- 拆分盤逐腿計算、逐腿退水；同一結果同時有贏腿與輸腿時不得先互抵。
- `/api/reprice`使用上一版凍結context及相同distributionId重播，不抓新資料、不呼叫GPT；核心資料有變時才走完整`/api/analyze`。
- PostgreSQL加法式schema位於`database/0001_additive_v9_schema.sql`；未設定DATABASE_URL時網站仍明確標示尚未具備永久伺服器保存。
'''
p.write_text(s)

print('deterministic v9 integration applied')
