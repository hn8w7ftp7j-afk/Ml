import { NextResponse } from 'next/server';
import { fetchSchedule } from '../../../../lib/mlb.js';
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
import { normalizeTai888ReaderPayload } from '../../../../lib/tai888-reader-parser-v2.js';
import { checkRateLimit, cleanText, rateLimitResponse, readJsonBody, validDateString } from '../../../../lib/security.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function dateShift(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function scheduleWindow(boardDate) {
  const dates = [dateShift(boardDate, -1), boardDate, dateShift(boardDate, 1)];
  const rows = await Promise.all(dates.map(date => fetchSchedule(date).catch(() => [])));
  return [...new Map(rows.flat().map(game => [Number(game.gamePk), game])).values()];
}

function validObservedAt(value, receivedAt, maximumDifferenceMs = 10 * 60 * 1000) {
  const observed = Date.parse(value || '');
  const received = Date.parse(receivedAt || '');
  return Number.isFinite(observed)
    && Number.isFinite(received)
    && Math.abs(received - observed) <= maximumDifferenceMs;
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
    const observedAt = cleanText(body.observedAt, 60);
    if (!validObservedAt(observedAt, receivedAt)) {
      return NextResponse.json({ ok: false, error: 'Reader 盤口時間與伺服器差距過大' }, { status: 400, headers });
    }

    const clientPayloadHash = cleanText(body.payloadHash, 80).toLowerCase();
    const sourceHost = cleanText(body.sourceHost, 200).toLowerCase();
    const previous = await loadReaderSnapshot(boardDate);

    if (/^[a-f0-9]{64}$/.test(clientPayloadHash)
      && previous?.clientPayloadHash === clientPayloadHash
      && previous?.deviceId === token.deviceId
      && previous?.sourceHost === sourceHost) {
      const refreshedResult = await refreshReaderSnapshot(previous, {
        observedAt,
        receivedAt,
        readerVersion: cleanText(body.readerVersion, 80),
      });
      const refreshed = refreshedResult?.snapshot;
      const storage = refreshedResult?.storage;
      if (!refreshed) throw new Error('Reader 心跳快照更新失敗');
      if (process.env.VERCEL === '1' && !storage?.runtimeCache) {
        return NextResponse.json({ ok: false, error: 'Reader 心跳未能寫入 Vercel Runtime Cache' }, { status: 503, headers });
      }
      return NextResponse.json({
        ok: true,
        heartbeat: true,
        message: `Tai888 Reader 心跳正常｜盤口未變｜${refreshed.matchedGameCount}/${refreshed.rawGameCount} 場`,
        boardDate: refreshed.boardDate,
        payloadHash: refreshed.payloadHash,
        clientPayloadHash: refreshed.clientPayloadHash,
        rawGameCount: refreshed.rawGameCount,
        matchedGameCount: refreshed.matchedGameCount,
        scheduleGameCount: refreshed.scheduleGameCount,
        unmatched: refreshed.unmatched || [],
        receivedAt: refreshed.receivedAt,
        observedAt: refreshed.observedAt,
        runtimeCache: Boolean(storage?.runtimeCache),
        freshness: readerSnapshotStatus(refreshed),
      }, { headers });
    }

    const schedule = await scheduleWindow(boardDate);
    if (!schedule.length) {
      return NextResponse.json({ ok: false, error: '無法取得相鄰日期 MLB 官方賽程，Reader 本次未寫入' }, { status: 502, headers });
    }

    const normalized = {
      ...normalizeTai888ReaderPayload(body, schedule, {
        deviceId: token.deviceId,
        receivedAt,
      }),
      clientPayloadHash: /^[a-f0-9]{64}$/.test(clientPayloadHash) ? clientPayloadHash : null,
    };
    if (!normalized.matchedGameCount) {
      return NextResponse.json({
        ok: false,
        error: 'Reader 已讀到 Tai888 表格，但沒有場次能配對 MLB 官方賽程',
        rawGameCount: normalized.rawGameCount,
        unmatched: normalized.unmatched,
      }, { status: 422, headers });
    }

    const matchRatio = normalized.rawGameCount > 0
      ? normalized.matchedGameCount / normalized.rawGameCount
      : 0;
    if (normalized.rawGameCount >= 2 && matchRatio < 0.60) {
      return NextResponse.json({
        ok: false,
        error: `Reader 本次只配對 ${normalized.matchedGameCount}/${normalized.rawGameCount} 場，疑似部分解析，已拒絕覆蓋舊盤`,
        rawGameCount: normalized.rawGameCount,
        matchedGameCount: normalized.matchedGameCount,
        unmatched: normalized.unmatched,
      }, { status: 422, headers });
    }

    const storage = await storeReaderSnapshot(normalized);
    if (process.env.VERCEL === '1' && !storage.runtimeCache) {
      return NextResponse.json({ ok: false, error: 'Reader 快照未能寫入 Vercel Runtime Cache，已停止回報成功' }, { status: 503, headers });
    }
    const status = readerSnapshotStatus(normalized);
    return NextResponse.json({
      ok: true,
      heartbeat: false,
      message: `Tai888 Reader 已自動同步 ${normalized.matchedGameCount}/${normalized.rawGameCount} 場`,
      boardDate: normalized.boardDate,
      payloadHash: normalized.payloadHash,
      clientPayloadHash: normalized.clientPayloadHash,
      rawGameCount: normalized.rawGameCount,
      matchedGameCount: normalized.matchedGameCount,
      scheduleGameCount: normalized.scheduleGameCount,
      unmatched: normalized.unmatched,
      receivedAt: normalized.receivedAt,
      observedAt: normalized.observedAt,
      runtimeCache: storage.runtimeCache,
      freshness: status,
    }, { headers });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error?.message || error) }, {
      status: Number(error?.status) || 500,
      headers,
    });
  }
}
