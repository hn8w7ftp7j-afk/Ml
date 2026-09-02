import assert from 'node:assert/strict';
import {
  BET_CLOSING_LINE_VERSION,
  buildPlacedClosingContractSnapshot,
  buildReaderClosingContractCandidate,
  calculateClosingContractMetrics,
  closingContractNeedsReplacement,
} from '../lib/bet-closing-line-v1.js';

const hash = character => character.repeat(64);
const bet = {
  id: 'bet-1',
  league: 'MLB',
  date: '2026-08-30',
  gamePk: 123,
  gameDate: '2026-08-30T10:00:00.000Z',
  placedAt: '2026-08-30T08:00:00.000Z',
  market: '全場大小',
  pick: '小8+50',
  water: 0.94,
  rebateRate: 0.015,
  lineAsOf: '2026-08-30T07:59:00.000Z',
  placedContractSnapshot: { market: '全場大小', pick: '小8+50', water: 0.94, lineAsOf: '2026-08-30T07:59:00.000Z' },
  readerPayloadHash: hash('a'),
  rawBoardHash: hash('b'),
  readerRevision: `2026-08-30:${hash('a')}`,
  pitSnapshotId: `MLB:123:FULL:${hash('c')}`,
  inputHash: hash('c'),
  coreFingerprint: hash('d'),
  distributionHash: hash('e'),
  distributionId: 'distribution-1',
};

const placed = buildPlacedClosingContractSnapshot(bet, {
  formulaDiagnosticScore: 8.1,
  shadowDiagnosticScore: 8.1,
  weightedEV: 0.08,
  robustEV: 0.04,
  scoreStatus: 'SHADOW_DIAGNOSTIC_UNCALIBRATED',
  distributionHash: hash('e'),
  distributionId: 'distribution-1',
});
assert.equal(placed.version, BET_CLOSING_LINE_VERSION);
assert.equal(placed.pick, '小8+50');
assert.equal(placed.formulaDiagnosticScore, 8.1);

const oldCapturedLine = '2026-08-30T07:20:00.000Z';
const capturedReaderBet = {
  ...bet,
  lineAsOf: oldCapturedLine,
  placedContractSnapshot: { ...bet.placedContractSnapshot, lineAsOf: oldCapturedLine },
  readerEvidenceStatus: 'SERVER_VERIFIED_CAPTURED_READER',
  serverEvidenceVersion: 'BASEBALL-BET-EVIDENCE-SERVER-VERIFICATION-v11.8.16',
  serverEvidenceVerifiedAt: '2026-08-30T08:00:00.000Z',
};
const capturedPlaced = buildPlacedClosingContractSnapshot(capturedReaderBet);
assert.equal(capturedPlaced?.lineAsOf, oldCapturedLine, '伺服器已驗證的擷取Reader盤即使早於下注超過10分鐘，仍可作為開賽前初始快照');

assert.equal(buildPlacedClosingContractSnapshot({
  ...capturedReaderBet,
  readerEvidenceStatus: 'SERVER_VERIFIED_CURRENT_READER',
}), null, '一般即時Reader證據不得繞過下注前10分鐘限制');
assert.equal(buildPlacedClosingContractSnapshot({
  ...capturedReaderBet,
  serverEvidenceVersion: '',
}), null, '只有具備伺服器驗證中繼資料的擷取Reader盤可放寬時間差');

for (const lineAsOf of ['2026-08-30T10:00:00.000Z', '2026-08-30T10:00:01.000Z']) {
  assert.equal(buildPlacedClosingContractSnapshot({
    ...capturedReaderBet,
    lineAsOf,
    placedContractSnapshot: { ...capturedReaderBet.placedContractSnapshot, lineAsOf },
  }), null, `伺服器已驗證的擷取Reader盤仍不得使用開賽時或之後盤口：${lineAsOf}`);
}

const readerSnapshot = {
  league: 'MLB',
  boardDate: '2026-08-30',
  pageActivityAt: '2026-08-30T09:55:00.000Z',
  payloadHash: hash('f'),
  rawBoardHash: hash('9'),
  games: [{
    gamePk: 123,
    readerGameMarketHash: hash('8'),
    markets: [
      { market: '全場大小', pick: '小8平', water: 0.92, lineAsOf: '2026-08-30T09:55:00.000Z' },
      { market: '全場大小', pick: '大8平', water: 0.92, lineAsOf: '2026-08-30T09:55:00.000Z' },
    ],
  }],
};
const candidate = buildReaderClosingContractCandidate(bet, readerSnapshot);
assert.equal(candidate.pick, '小8平');
assert.equal(candidate.water, 0.92);
assert.equal(closingContractNeedsReplacement(placed, candidate), true, '跳盤後必須覆蓋前一個最新盤');
assert.equal(closingContractNeedsReplacement({ ...candidate, metricStatus: 'CALCULATED' }, candidate), false, '相同盤口與水位不得重複寫入');
assert.equal(closingContractNeedsReplacement({ ...candidate, metricStatus: 'REPRICE_FAILED' }, candidate), false, '同盤即使重算失敗也不得每次心跳重寫，等下次跳盤再重算');

const postStart = buildReaderClosingContractCandidate(bet, {
  ...readerSnapshot,
  pageActivityAt: '2026-08-30T10:00:01.000Z',
  games: readerSnapshot.games.map(game => ({
    ...game,
    markets: game.markets.map(row => ({ ...row, lineAsOf: '2026-08-30T10:00:01.000Z' })),
  })),
});
assert.equal(postStart, null, '開賽後盤口不得覆蓋開賽前最後盤');

let replayRequest = null;
const metrics = await calculateClosingContractMetrics(bet, candidate, {
  loadReplay: async request => {
    replayRequest = request;
    return {
      frozenContext: { game: { gamePk: 123, away: 'A', home: 'H' } },
      distributionSnapshot: { id: 'frozen' },
      distributionHash: hash('e'),
      distributionId: 'distribution-1',
      versions: { modelVersion: 'MODEL', scoreFormulaVersion: 'SCORE' },
    };
  },
  reprice: ({ markets }) => ({ results: markets }),
  finalize: ({ analysis }) => ({
    results: analysis.results.map(row => ({
      ...row,
      formulaDiagnosticScore: 7.5,
      shadowDiagnosticScore: 7.5,
      weightedEV: 0.03,
      robustEV: 0.012,
      scoreStatus: 'SHADOW_DIAGNOSTIC_UNCALIBRATED',
    })),
  }),
});
assert.equal(replayRequest.snapshotId, bet.pitSnapshotId);
assert.equal(replayRequest.expected.distributionHash, bet.distributionHash);
assert.equal(metrics.formulaDiagnosticScore, 7.5);
assert.equal(metrics.weightedEV, 0.03);
assert.equal(metrics.robustEV, 0.012);

console.log('Single-row overwrite closing line, prestart lock and frozen-PIT S/W/R reprice PASS');
