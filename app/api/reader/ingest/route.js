import { NextResponse } from 'next/server';
import { fetchOfficialTaipeiSlate, officialPrestartSlate } from '../../../../lib/official-schedule-v1.js';
import {
  bearerToken,
  readerCorsHeaders,
  readerOriginAllowed,
  verifyReaderToken,
} from '../../../../lib/reader-auth-v2.js';
import {
  loadReaderSnapshot,
  refreshReaderSnapshot,
  storeReaderSnapshot,
  readerSnapshotStatus,
} from '../../../../lib/reader-store-v2.js';
import {
  normalizeTai888ReaderPayload,
  readerSnapshotIsComplete,
  validateTai888ReaderEnvelope,
} from '../../../../lib/tai888-reader-parser-v2.js';
import { checkRateLimit, cleanText, rateLimitResponse, readJsonBody, validDateString } from '../../../../lib/security.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function temporalError(message) {
  const error = new Error(message);
  error.status = 409;
  return error;
}

function assertMonotonic(previous, envelope, boardChanged) {
  if (!previous) return;
  const previousObserved = Date.parse(previous.observedAt || '');
  const previousActivity = Date.parse(previous.pageActivityAt || '');
  const observed = Date.parse(envelope.observedAt);
  const activity = Date.parse(envelope.pageActivityAt);
  if (Number.isFinite(previousObserved) && observed <= previousObserved) {
    throw temporalError('Reader observedAt 未向前推進，已拒絕重播快照');
  }
  if (Number.isFinite(previousActivity) && activity < previousActivity) {
    throw temporalError('Reader pageActivityAt 時間倒退，已拒絕舊盤覆蓋');
  }
  if (boardChanged && Number.isFinite(previousActivity) && activity <= previousActivity) {
    throw temporalError('Reader 盤口內容變更但頁面活動時間未推進，已拒絕重播');
  }
}

function snapshotMatchesSchedule(snapshot, schedule) {
  if (!readerSnapshotIsComplete(snapshot)) return false;
  const expected = schedule.map(game => Number(game.gamePk)).sort((left, right) => left - right);
  const actual = [...snapshot.games, ...(snapshot.unopenedGames || [])]
    .map(game => Number(game.gamePk)).sort((left, right) => left - right);
  if (actual.length !== expected.length) return false;
  return expected.every((gamePk, index) => gamePk === actual[index]);
}

export async function OPTIONS(request) {
  const headers = readerCorsHeaders(request);
  if (!readerOriginAllowed(request)) return new Response(null, { status: 403, headers });
  return new Response(null, { status: 204, headers });
}

export async function POST(request) {
  const headers = readerCorsHeaders(request);
  if (!readerOriginAllowed(request)) {
    return NextResponse.json({ ok: false, error: '不允許的 Reader 請求來源' }, { status: 403, headers });
  }
  try {
    const rate = checkRateLimit(request, { id: 'reader-ingest-v2', limit: 180, windowMs: 10 * 60 * 1000 });
    if (!rate.allowed) {
      const response = rateLimitResponse(rate);
      for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
      return response;
    }

    const token = await verifyReaderToken(bearerToken(request));
    if (!token) return NextResponse.json({ ok: false, error: 'Reader 配對已失效，請重新配對' }, { status: 401, headers });
    const deviceHeader = cleanText(request.headers.get('x-device-id'), 100);
    if (!deviceHeader || deviceHeader !== token.deviceId) {
      return NextResponse.json({ ok: false, error: 'Reader 裝置識別碼不一致' }, { status: 401, headers });
    }

    const body = await readJsonBody(request, 600_000);
    const boardDate = cleanText(body.boardDate, 20);
    if (!validDateString(boardDate)) {
      return NextResponse.json({ ok: false, error: 'Tai888 Reader 盤口日期格式錯誤' }, { status: 400, headers });
    }

    const receivedAt = new Date().toISOString();
    const envelope = validateTai888ReaderEnvelope(body, { receivedAt });
    const previous = await loadReaderSnapshot(boardDate);
    let schedule;
    let fullSchedule;
    try {
      fullSchedule = await fetchOfficialTaipeiSlate(boardDate);
      schedule = officialPrestartSlate(fullSchedule, Date.parse(envelope.pageActivityAt));
    } catch {
      return NextResponse.json({ ok: false, error: '無法取得完整 MLB 官方賽程，Reader 本次未寫入' }, { status: 502, headers });
    }
    if (!schedule.length) {
      return NextResponse.json({ ok: false, error: '官方台北盤日已無未開賽 MLB 場次，Reader 本次未寫入' }, { status: 409, headers });
    }

    const unchangedBoard = previous?.rawBoardHash === envelope.rawBoardHash;
    assertMonotonic(previous, envelope, !unchangedBoard);
    if (unchangedBoard
      && previous?.deviceId === token.deviceId
      && previous?.sourceHost === envelope.sourceHost
      && previous?.boardDate === envelope.boardDate
      && snapshotMatchesSchedule(previous, schedule)) {
      const refreshedResult = await refreshReaderSnapshot(previous, {
        observedAt: envelope.observedAt,
        receivedAt: envelope.receivedAt,
        pageActivityAt: envelope.pageActivityAt,
        readerVersion: envelope.readerVersion,
      });
      const refreshed = refreshedResult?.snapshot;
      const storage = refreshedResult?.storage;
      if (!refreshed || !storage?.allRequiredWritesSucceeded) {
        return NextResponse.json({ ok: false, error: 'Reader 心跳未完成所有必要儲存寫入' }, { status: 503, headers });
      }
      return NextResponse.json({
        ok: true,
        heartbeat: true,
        message: `Tai888 Reader 心跳正常｜已開盤 ${refreshed.matchedGameCount} 場｜未開盤 ${refreshed.unopenedGameCount || 0} 場`,
        boardDate: refreshed.boardDate,
        payloadHash: refreshed.payloadHash,
        rawBoardHash: refreshed.rawBoardHash,
        rawGameCount: refreshed.rawGameCount,
        matchedGameCount: refreshed.matchedGameCount,
        unopenedGameCount: refreshed.unopenedGameCount || 0,
        scheduleGameCount: refreshed.scheduleGameCount,
        unmatched: refreshed.unmatched || [],
        receivedAt: refreshed.receivedAt,
        observedAt: refreshed.observedAt,
        pageActivityAt: refreshed.pageActivityAt,
        runtimeCache: Boolean(storage?.runtimeCache),
        allRequiredWritesSucceeded: true,
        freshness: readerSnapshotStatus(refreshed),
      }, { headers });
    }

    const normalized = normalizeTai888ReaderPayload(body, schedule, {
      deviceId: token.deviceId,
      receivedAt: envelope.receivedAt,
      envelope,
      fullSchedule,
    });

    const storage = await storeReaderSnapshot(normalized);
    if (!storage.allRequiredWritesSucceeded) {
      return NextResponse.json({ ok: false, error: 'Reader 快照未完成所有必要儲存寫入' }, { status: 503, headers });
    }
    const status = readerSnapshotStatus(normalized);
    return NextResponse.json({
      ok: true,
      heartbeat: false,
      message: `Tai888 Reader 已同步｜已開盤 ${normalized.matchedGameCount} 場｜未開盤 ${normalized.unopenedGameCount || 0} 場`,
      boardDate: normalized.boardDate,
      payloadHash: normalized.payloadHash,
      rawBoardHash: normalized.rawBoardHash,
      rawGameCount: normalized.rawGameCount,
      matchedGameCount: normalized.matchedGameCount,
      unopenedGameCount: normalized.unopenedGameCount || 0,
      scheduleGameCount: normalized.scheduleGameCount,
      unmatched: normalized.unmatched,
      receivedAt: normalized.receivedAt,
      observedAt: normalized.observedAt,
      pageActivityAt: normalized.pageActivityAt,
      runtimeCache: storage.runtimeCache,
      allRequiredWritesSucceeded: true,
      freshness: status,
    }, { headers });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error?.message || error) }, {
      status: Number(error?.status) || 500,
      headers,
    });
  }
}
