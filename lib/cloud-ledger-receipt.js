import { betPriceMatches } from './bet-ledger.js';

function receiptError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function requireCloudLedgerResponse(data) {
  if (data?.ok !== true || !Array.isArray(data?.bets)) {
    throw receiptError('永久帳本回傳格式錯誤，尚未確認同步完成', 'LEDGER_RESPONSE_INVALID');
  }
  return data;
}

function hasDurableEvidence(bet) {
  return ['SERVER_VERIFIED_CURRENT_READER', 'SERVER_VERIFIED_CAPTURED_READER'].includes(bet?.readerEvidenceStatus)
    && bet?.pitEvidenceVerified === true
    && bet?.pitPredictionStatus === 'IMMUTABLE_PIT_VERIFIED';
}

function sameRecordedContract(bet, candidate) {
  return bet?.league === candidate?.league
    && bet?.date === candidate?.date
    && Number(bet?.gamePk) === Number(candidate?.gamePk)
    && bet?.market === candidate?.market
    && betPriceMatches(bet, candidate?.date, candidate?.gamePk, candidate, candidate?.league)
    && Number.isFinite(Number(candidate?.stake))
    && Number(bet?.stake) === Number(candidate.stake);
}

export function requireRecordedBet(data, betId, candidate) {
  requireCloudLedgerResponse(data);
  const matches = data.bets.filter(bet => bet?.id === betId);
  if (!betId || matches.length !== 1) {
    throw receiptError('永久帳本尚未讀回這筆紀錄，請重新確認；目前不會顯示成功', 'LEDGER_READBACK_MISSING');
  }
  const bet = matches[0];
  if (!sameRecordedContract(bet, candidate) || !['OPEN', 'SETTLED', 'VOID', 'MANUAL_REVIEW'].includes(bet.status)) {
    throw receiptError('永久帳本讀回的紀錄與本次盤口、金額或狀態不一致，請重新確認', 'LEDGER_READBACK_CONFLICT');
  }
  if (!hasDurableEvidence(bet)) {
    throw receiptError('永久帳本讀回的紀錄缺少已驗證證據，尚未確認成功', 'LEDGER_READBACK_UNVERIFIED');
  }
  return bet;
}

// A write response alone is insufficient: verify its exact record, then make
// an independent no-cache ledger read before letting the page show success.
export async function confirmCloudBetMutation(postData, candidate, readLedger) {
  if (postData?.created !== true && postData?.idempotent !== true) {
    throw receiptError('永久帳本未確認建立或讀回原有紀錄', 'LEDGER_WRITE_UNCONFIRMED');
  }
  requireRecordedBet(postData, postData.betId, candidate);
  const data = requireCloudLedgerResponse(await readLedger());
  const bet = requireRecordedBet(data, postData.betId, candidate);
  return { data, bet, idempotent: postData.idempotent === true };
}

export function requireCancelledBet(data, betId) {
  requireCloudLedgerResponse(data);
  const matches = data.bets.filter(bet => bet?.id === betId);
  if (!betId || matches.length !== 1 || matches[0].status !== 'CANCELLED') {
    throw receiptError('永久帳本尚未讀回這筆取消狀態，請重新確認；目前不會顯示取消成功', 'LEDGER_CANCEL_UNCONFIRMED');
  }
  return matches[0];
}

export function findConfirmedRecordedBet(data, candidate) {
  requireCloudLedgerResponse(data);
  const matches = data.bets.filter(bet => ['OPEN', 'SETTLED', 'VOID', 'MANUAL_REVIEW'].includes(bet?.status)
    && hasDurableEvidence(bet) && sameRecordedContract(bet, candidate));
  return matches.length === 1 ? matches[0] : null;
}

export function cloudBetMutationOutcomeUncertain(error) {
  const status = Number(error?.status || 0);
  return !status || status >= 500 || String(error?.code || '').startsWith('LEDGER_');
}
