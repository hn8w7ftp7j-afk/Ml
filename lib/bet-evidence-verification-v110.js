import { canonicalBetPick } from './bet-ledger.js';
import { featureObservedAtsFromContextV109 } from './calibration-ledger-v109.js';
import { applyMarketFreshness } from './market-freshness-v1.js';
import { loadReaderSnapshot, readerSnapshotStatus } from './reader-store-v2.js';
import { assertLeagueGamePrestart, resolveLeagueGame } from './league-provider.js';
import {
  isAnalysisPitIntegrityError,
  loadAnalysisPitReplay,
  loadLatestAnalysisPitIdentity,
} from './analysis-pit-snapshot-store-v1.js';
import { isLeagueId } from './leagues.js';
import { verifyMarketRow } from './market-integrity-v1.js';
import { readerGameEvidenceContentHash } from './reader-market-revision-v110.js';
import { isDatabaseError, markDatabaseError } from './database-error.js';

export const BET_EVIDENCE_VERIFICATION_V110_VERSION = 'BASEBALL-BET-EVIDENCE-SERVER-VERIFICATION-v11.8.34';

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const clean = value => String(value || '').trim();
const water = value => Number.isFinite(Number(value)) ? Number(value) : null;

function fail(message, code = 'BET_EVIDENCE_REJECTED') {
  const error = new Error(message);
  error.status = 409;
  error.code = code;
  throw error;
}

function exactDirection(rows, candidate) {
  const expectedPick = canonicalBetPick(candidate?.pick);
  const expectedWater = water(candidate?.water);
  return (Array.isArray(rows) ? rows : []).find(row => (
    clean(row?.market) === clean(candidate?.market)
    && canonicalBetPick(row?.pick) === expectedPick
    && expectedWater != null
    && water(row?.water) != null
    && Math.abs(water(row.water) - expectedWater) <= 1e-9
  )) || null;
}

function pitInputHash(snapshotId, league, gamePk) {
  const prefix = `${league}:${gamePk}:`;
  const value = clean(snapshotId);
  if (!value.startsWith(prefix)) return null;
  const inputHash = value.split(':').at(-1)?.toLowerCase() || '';
  return HASH_PATTERN.test(inputHash) ? inputHash : null;
}

export async function verifyCloudBetEvidenceV110(candidate, {
  now = Date.now(),
  loadReader = loadReaderSnapshot,
  resolveGame = resolveLeagueGame,
  assertPrestart = assertLeagueGamePrestart,
  loadPitReplay = loadAnalysisPitReplay,
  loadLatestPitIdentity = loadLatestAnalysisPitIdentity,
  wallClock = Date.now,
} = {}) {
  const league = clean(candidate?.league).toUpperCase();
  const date = clean(candidate?.date);
  const gamePk = Number(candidate?.gamePk);
  if (!isLeagueId(league) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isSafeInteger(gamePk) || gamePk <= 0) {
    fail('下注紀錄缺少有效聯盟、盤日或場次', 'BET_IDENTITY_INVALID');
  }

  const snapshot = await loadReader(league, date);
  const readerState = readerSnapshotStatus(snapshot, now, league);
  if (!snapshot || snapshot?.boardDate !== date || readerState.state === 'invalid') {
    fail('找不到這個盤日已成功擷取的 Reader 快照', 'READER_CAPTURE_MISSING');
  }
  const capturedPayloadHash = clean(candidate?.readerPayloadHash).toLowerCase();
  const capturedRawBoardHash = clean(candidate?.rawBoardHash).toLowerCase();
  if (!HASH_PATTERN.test(clean(snapshot?.payloadHash).toLowerCase())
    || !HASH_PATTERN.test(capturedPayloadHash)
    || clean(candidate?.readerRevision) !== `${date}:${capturedPayloadHash}`) {
    fail('下注紀錄缺少有效的 Reader payload hash／revision', 'READER_HASH_MISMATCH');
  }
  if (!HASH_PATTERN.test(capturedRawBoardHash)) {
    fail('下注紀錄缺少有效的 Reader 原始盤面雜湊', 'READER_RAW_HASH_MISMATCH');
  }

  const readerGame = (Array.isArray(snapshot?.games) ? snapshot.games : []).find(row => Number(row?.gamePk || row?.game?.gamePk) === gamePk);
  if (!readerGame?.game) fail('目前 Reader 快照找不到這場已開盤賽事', 'READER_GAME_MISSING');
  const resolved = await resolveGame(league, readerGame.game, { date });
  const officialGame = resolved?.game || readerGame.game;
  assertPrestart(league, officialGame, now);

  const readerMarket = exactDirection(readerGame.markets, candidate);
  if (!readerMarket) fail('目前 Reader 快照找不到完全相同的市場、方向、盤口與水位', 'READER_CONTRACT_MISMATCH');
  const verifiedLine = applyMarketFreshness({
    ...readerMarket,
    sourceType: 'ACTUAL_TW_CREDIT',
    provider: 'TAI888_READER_AUTO',
    executable: true,
    lineAsOf: snapshot.pageActivityAt || readerMarket.lineAsOf,
  }, now);
  const currentGameMarketHash = readerGameEvidenceContentHash(readerGame, snapshot.pageActivityAt);
  if (!HASH_PATTERN.test(clean(currentGameMarketHash).toLowerCase())) {
    fail('Reader場次盤口內容雜湊無法建立', 'READER_GAME_MARKET_HASH_INVALID');
  }

  const snapshotId = clean(candidate?.pitSnapshotId);
  const inputHash = pitInputHash(snapshotId, league, gamePk);
  let pit = null;
  let pitError = 'PIT_SNAPSHOT_NOT_PROVIDED';
  if (snapshotId && inputHash) {
    try {
      // The board can be replaced by a newer durable analysis between render and
      // tap (mobile Safari makes this race especially easy to hit).  The server,
      // not the stale client card, is authoritative: attach the latest immutable
      // PIT only after re-verifying that it contains the exact current Reader
      // contract below.
      let latestPit;
      try {
        latestPit = await loadLatestPitIdentity({ league, gamePk });
      } catch (error) {
        throw markDatabaseError(error, 'BET_LATEST_PIT_READ_FAILED');
      }
      if (!latestPit?.snapshotId || !HASH_PATTERN.test(clean(latestPit?.inputHash).toLowerCase())) {
        throw new Error('同場目前沒有可附著的最新不可變PIT快照');
      }
      const authoritativeSnapshotId = clean(latestPit.snapshotId);
      const authoritativeInputHash = clean(latestPit.inputHash).toLowerCase();
      let replay;
      try {
        replay = await loadPitReplay({
          league,
          snapshotId: authoritativeSnapshotId,
          expected: { leagueId: league, gamePk, inputHash: authoritativeInputHash },
        });
      } catch (error) {
        if (isAnalysisPitIntegrityError(error)) throw error;
        throw markDatabaseError(error, 'BET_PIT_REPLAY_READ_FAILED');
      }
      const result = exactDirection(replay?.marketAnalysis?.results, candidate);
      const supplied = exactDirection(replay?.marketAnalysis?.suppliedMarkets, candidate);
      if (!replay || !result || !supplied) throw new Error('PIT市場方向或成交價格不一致');
      if (clean(supplied?.sourceType).toUpperCase() !== 'ACTUAL_TW_CREDIT'
        || clean(supplied?.provider).toUpperCase() !== 'TAI888_READER_AUTO') {
        throw new Error('PIT成交盤不是Tai888 Reader伺服器來源');
      }
      if (clean(supplied?.readerGameMarketHash).toLowerCase() !== currentGameMarketHash
        || clean(supplied?.readerBoardDate) !== date) {
        throw new Error('PIT成交盤與目前Reader不是同一場盤口內容版本');
      }
      if (!HASH_PATTERN.test(clean(supplied?.readerPayloadHash).toLowerCase())
        || !HASH_PATTERN.test(clean(supplied?.readerRawBoardHash).toLowerCase())) {
        throw new Error('PIT成交盤缺少Reader payload／原始盤面修訂證據');
      }
      // A different game can move after this card was analyzed, changing the
      // full-board payload/raw hashes without changing this game's contract.
      // Bind the browser request to the immutable PIT capture, then use the
      // per-game content hash above to prove the current server Reader game is
      // still exactly the analyzed market set. A move in this game therefore
      // remains fail-closed, while an unrelated game's move no longer breaks
      // the record button.
      if (capturedPayloadHash !== clean(supplied.readerPayloadHash).toLowerCase()
        || capturedRawBoardHash !== clean(supplied.readerRawBoardHash).toLowerCase()
        || clean(supplied?.readerBoardDate) !== date) {
        throw new Error('下注畫面Reader證據與不可變PIT擷取版本不一致');
      }
      if (!(await verifyMarketRow(league, officialGame, supplied))) {
        throw new Error('PIT成交盤缺少有效伺服器簽章');
      }
      if (replay?.quarantineContract?.legacyEvidenceStatus === 'EXCLUDED_UNVERIFIABLE_LEGACY') {
        throw new Error('PIT快照已列入legacy quarantine');
      }
      pit = {
        verified: true,
        snapshotId: authoritativeSnapshotId,
        inputHash: clean(replay?.inputHash).toLowerCase(),
        coreFingerprint: clean(replay?.coreFingerprint).toLowerCase(),
        distributionHash: clean(replay?.distributionHash).toLowerCase(),
        distributionId: clean(replay?.distributionId),
        analysisAsOf: clean(replay?.analysisAsOf),
        dataAsOf: clean(replay?.dataAsOf),
        modelVersion: clean(replay?.versions?.modelVersion),
        scoreFormulaVersion: clean(replay?.versions?.scoreFormulaVersion),
        settlementRuleVersion: clean(replay?.versions?.settlementRuleVersion),
        weightedEV: Number.isFinite(Number(result?.weightedEV)) ? Number(result.weightedEV) : null,
        robustEV: Number.isFinite(Number(result?.robustEV)) ? Number(result.robustEV) : null,
        formulaDiagnosticScore: Number.isFinite(Number(result?.formulaDiagnosticScore)) ? Number(result.formulaDiagnosticScore) : null,
        shadowDiagnosticScore: Number.isFinite(Number(result?.shadowDiagnosticScore)) ? Number(result.shadowDiagnosticScore) : null,
        scoreStatus: clean(result?.scoreStatus) || null,
        readerGameMarketHash: clean(supplied?.readerGameMarketHash).toLowerCase(),
        readerPayloadHash: clean(supplied?.readerPayloadHash).toLowerCase() || null,
        readerRawBoardHash: clean(supplied?.readerRawBoardHash).toLowerCase() || null,
        readerBoardDate: clean(supplied?.readerBoardDate) || null,
        featureObservedAts: featureObservedAtsFromContextV109(replay.frozenContext),
      };
      if (!HASH_PATTERN.test(pit.coreFingerprint) || !HASH_PATTERN.test(pit.distributionHash)
        || pit.inputHash !== authoritativeInputHash || !pit.analysisAsOf || !pit.dataAsOf
        || !pit.modelVersion || !pit.settlementRuleVersion || pit.weightedEV == null || pit.robustEV == null) {
        throw new Error('PIT模型證據欄位不完整');
      }
      pitError = '';
    } catch (error) {
      if (isDatabaseError(error)) throw error;
      pit = null;
      pitError = clean(error?.message || error).slice(0, 300) || 'PIT_REPLAY_FAILED';
    }
  }

  const finalizedAt = Number(wallClock());
  assertPrestart(league, officialGame, finalizedAt);
  return {
    version: BET_EVIDENCE_VERIFICATION_V110_VERSION,
    readerVerified: true,
    verifiedAt: new Date(finalizedAt).toISOString(),
    officialGame,
    reader: {
      payloadHash: clean(snapshot.payloadHash).toLowerCase(),
      rawBoardHash: clean(snapshot.rawBoardHash).toLowerCase() || null,
      revision: `${date}:${snapshot.payloadHash}`,
      lineAsOf: verifiedLine.lineAsOf,
      captureFreshAtRecord: verifiedLine.lineFresh === true,
      market: clean(readerMarket.market),
      pick: clean(readerMarket.pick),
      water: water(readerMarket.water),
    },
    pitVerified: pit?.verified === true,
    pit,
    pitError,
    calibrationEligibility: pit?.verified === true
      ? 'PENDING_SETTLEMENT_AND_LOCKED_OOS_GATE'
      : 'EXCLUDED_UNVERIFIABLE',
  };
}
