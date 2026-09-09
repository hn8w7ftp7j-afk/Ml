import { gameIsPrestartNow } from './client-analysis-state.js';
import { hasActualWater } from './markets.js';

export const BET_ACTION_STATE_VERSION = '11.8.44';

// Explain the existing gate; this does not grant Reader authority or change eligibility.
export function readerContractDiagnostic(item, row, readerAuthority = null) {
  const fail = (code, text, title) => ({ code, text, title });
  if (item?.status !== 'done') return fail('ANALYSIS_NOT_READY', '分析尚未完成', '此場分析尚未完成；完成後才能核對下注盤口。');
  if (item?.analysisFailure != null) return fail('ANALYSIS_FAILED', '分析待重試', '此場分析失敗；請重新複核此場。');
  if (retainedGameIsInactive(item)) return fail('GAME_NOT_CURRENT', '非目前賽前場次', '此場已不在官方賽前清單；保留歷史分析，不建立新下注。');
  if (readerAuthority && typeof readerAuthority === 'object') {
    if (!readerAuthority.payloadHash) return fail('READER_MISSING', '尚無Reader盤口', '目前未取得Reader盤口；請確認讀盤電腦已同步此聯盟與日期，再重新複核。');
    if (String(readerAuthority.boardDate || '') !== String(readerAuthority.expectedBoardDate || '')) return fail('READER_DATE_MISMATCH', 'Reader日期不符', 'Reader盤日與目前選定日期不同；請確認日期後重新複核。');
    if (readerAuthority.fresh !== true) return fail('READER_NOT_FRESH', 'Reader時效未通過', 'Reader最新狀態未通過時效檢查；請確認讀盤電腦持續同步，再重新複核。');
    if (String(item?.readerPayloadHash || '') !== String(readerAuthority.payloadHash)) return fail('READER_REVISION_MISMATCH', '盤口版本待複核', '目前分析綁定的Reader版本與最新版本不同；請重新複核此場。');
  }
  if (item?.actualSource?.provider !== 'TAI888_READER_AUTO' || row?.sourceType !== 'ACTUAL_TW_CREDIT' || row?.provider !== 'TAI888_READER_AUTO') return fail('READER_SOURCE_UNVERIFIED', '盤口來源待確認', '此方向尚未綁定已驗證的Tai888 Reader實際盤口。');
  if (!hasActualWater(row?.water) || row?.waterEstimated === true) return fail('READER_WATER_UNVERIFIED', '實際水位待確認', '實際水位缺失、無效或為估計值；不能作為實際下注紀錄。');
  return fail('READER_CONTRACT_UNVERIFIED', '盤口合約待複核', '此方向尚未完成Reader合約綁定；請重新複核此場。');
}

function retainedGameIsInactive(item) {
  return String(item?.statusLabel || '').includes('目前已不在官方賽前清單');
}

export function capturedReaderContractReady(item, row, now = Date.now(), readerAuthority = null) {
  const authorityRequired = readerAuthority && typeof readerAuthority === 'object';
  const authorityReady = !authorityRequired || (
    readerAuthority.fresh === true
    && String(readerAuthority.boardDate || '') === String(readerAuthority.expectedBoardDate || '')
    && Boolean(readerAuthority.payloadHash)
    && String(item?.readerPayloadHash || '') === String(readerAuthority.payloadHash)
  );
  return item?.status === 'done'
    && item?.analysisFailure == null
    && !retainedGameIsInactive(item)
    && gameIsPrestartNow(item?.game, now)
    && item?.actualSource?.provider === 'TAI888_READER_AUTO'
    && row?.sourceType === 'ACTUAL_TW_CREDIT'
    && row?.provider === 'TAI888_READER_AUTO'
    && (row?.evCalibration?.actualReaderEligible === true || row?.clientVerifiedReaderContract === true)
    && authorityReady
    && hasActualWater(row?.water)
    && row?.waterEstimated !== true;
}

export function evaluateBetAction({
  item,
  row,
  now = Date.now(),
  betsEnabled = true,
  cloudLedgerState = 'ready',
  latest = null,
  cancelled = null,
  readerAuthority = null,
} = {}) {
  const prestart = gameIsPrestartNow(item?.game, now);
  const pitConfirmed = item?.customData?.pitPersistence?.confirmed === true;
  const readerReady = capturedReaderContractReady(item, row, now, readerAuthority);
  const cloudLedgerReady = cloudLedgerState === 'ready';
  const recordable = betsEnabled && cloudLedgerReady && pitConfirmed && prestart && readerReady;
  const cloudLedgerLabel = cloudLedgerState === 'loading' ? '帳本同步中' : '永久帳本暫停';
  const cloudLedgerTitle = cloudLedgerState === 'loading'
    ? '正在同步永久雲端帳本，完成後才可寫入'
    : '永久雲端帳本目前無法寫入';

  if (latest?.status === 'OPEN') {
    return {
      kind: prestart && cloudLedgerReady ? 'cancel' : 'none',
      text: !prestart ? '已開賽' : !cloudLedgerReady ? cloudLedgerLabel : '取消下注',
      title: !prestart ? '比賽已達官方預定開打時間，不能取消' : !cloudLedgerReady ? cloudLedgerTitle : '取消這筆尚未開賽的實際下注；原始證據仍會保留',
      disabled: !prestart || !cloudLedgerReady,
      recordable: false,
      readerReady,
      reasonCode: !prestart ? 'GAME_STARTED' : !cloudLedgerReady ? 'LEDGER_UNAVAILABLE' : 'CANCEL_OPEN',
    };
  }
  if (latest) return {
    kind: 'none', text: '已下注 ✓', title: '此方向已經記錄；盤口或水位變動也不再新增', disabled: true,
    recordable: false, readerReady, reasonCode: 'ALREADY_RECORDED',
  };
  if (recordable) return {
    kind: 'record',
    text: cancelled ? '重新紀錄下注' : '紀錄實際下注',
    title: cancelled ? '先前下注已取消；以目前盤口、水位與最新PIT建立一筆新的實際下注紀錄' : '記錄目前實際下注盤口與水位',
    disabled: false, recordable: true, readerReady, reasonCode: 'RECORDABLE',
  };
  if (!betsEnabled) return {
    kind: 'none', text: '暫不可記錄', title: '目前聯盟未開放實際下注紀錄', disabled: true,
    recordable: false, readerReady, reasonCode: 'BETTING_DISABLED',
  };
  if (!prestart) return {
    kind: 'none', text: '已開賽', title: '已達官方預定開打時間，停止記錄新下注', disabled: true,
    recordable: false, readerReady, reasonCode: 'GAME_STARTED',
  };
  if (!cloudLedgerReady) return {
    kind: 'none', text: cloudLedgerLabel, title: cloudLedgerTitle, disabled: true,
    recordable: false, readerReady, reasonCode: cloudLedgerState === 'loading' ? 'LEDGER_LOADING' : 'LEDGER_UNAVAILABLE',
  };
  if (!pitConfirmed) return {
    kind: 'none', text: 'PIT未保存', title: 'PIT永久保存尚未確認；確認後會自動開放記錄', disabled: true,
    recordable: false, readerReady, reasonCode: 'PIT_UNCONFIRMED',
  };
  if (!readerReady) {
    const diagnostic = readerContractDiagnostic(item, row, readerAuthority);
    return {
      kind: 'none', text: diagnostic.text, title: diagnostic.title, disabled: true,
      recordable: false, readerReady, reasonCode: 'READER_UNVERIFIED',
      readerReasonCode: diagnostic.code,
      canRecheck: diagnostic.code !== 'GAME_NOT_CURRENT' && item?.status !== 'running',
    };
  }
  return {
    kind: 'none', text: cancelled ? '已取消' : '暫不可記錄', title: '目前未通過實際下注記錄條件', disabled: true,
    recordable: false, readerReady, reasonCode: cancelled ? 'CANCELLED' : 'UNKNOWN',
  };
}
