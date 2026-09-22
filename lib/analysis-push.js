import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import webpush from 'web-push';
import { neon } from '@neondatabase/serverless';
import { durableDatabaseUrl } from './database-url.js';

export const PUSH_COOKIE = 'analysis_push_device';
let client;
let ready;
const sql = () => client ||= neon(durableDatabaseUrl());
export function deviceHash(token) {
  return /^[a-f0-9]{64}$/.test(token || '') ? createHash('sha256').update(token).digest('hex') : null;
}
function encryptionKey() {
  if (!process.env.SESSION_SECRET) throw new Error('Notification encryption is not configured');
  return createHash('sha256').update('analysis-push-v1:' + process.env.SESSION_SECRET).digest();
}
export function seal(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}
export function unseal(value) {
  const data = Buffer.from(value, 'base64');
  const cipher = createDecipheriv('aes-256-gcm', encryptionKey(), data.subarray(0, 12));
  cipher.setAuthTag(data.subarray(12, 28));
  return JSON.parse(Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString());
}
export function validateSubscription(value) {
  const url = new URL(value?.endpoint);
  const host = url.hostname;
  const allowed = host === 'web.push.apple.com' || host.endsWith('.push.apple.com')
    || host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com'
    || host.endsWith('.notify.windows.com');
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || !allowed
    || url.href.length > 2048 || !/^[A-Za-z0-9_-]{86,88}$/.test(value?.keys?.p256dh || '')
    || !/^[A-Za-z0-9_-]{22,24}$/.test(value?.keys?.auth || '')) throw new Error('無效的通知訂閱');
  return { endpoint: url.href, keys: { p256dh: value.keys.p256dh, auth: value.keys.auth } };
}
async function schema() {
  if (!ready) ready = sql().transaction([
    sql()`SELECT pg_advisory_xact_lock(hashtext('analysis_push_schema_v1'))`,
    sql()`CREATE TABLE IF NOT EXISTS analysis_push_keys (id INTEGER PRIMARY KEY CHECK (id=1), encrypted TEXT NOT NULL)`,
    sql()`CREATE TABLE IF NOT EXISTS analysis_push_devices (id TEXT PRIMARY KEY, encrypted TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
    sql()`CREATE TABLE IF NOT EXISTS analysis_push_deliveries (id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  ]).catch(error => { ready = null; throw error; });
  await ready;
}
async function keys() {
  await schema();
  let rows = await sql()`SELECT encrypted FROM analysis_push_keys WHERE id=1`;
  if (!rows.length) {
    const encrypted = seal(webpush.generateVAPIDKeys());
    await sql()`INSERT INTO analysis_push_keys (id, encrypted) VALUES (1, ${encrypted}) ON CONFLICT DO NOTHING`;
    rows = await sql()`SELECT encrypted FROM analysis_push_keys WHERE id=1`;
  }
  return unseal(rows[0].encrypted);
}
export async function pushStatus(id) {
  const pair = await keys();
  const rows = id ? await sql()`SELECT id FROM analysis_push_devices WHERE id=${id}` : [];
  return { publicKey: pair.publicKey, subscribed: rows.length > 0 };
}
export async function savePushDevice(id, subscription) {
  await schema();
  const encrypted = seal(validateSubscription(subscription));
  await sql()`INSERT INTO analysis_push_devices (id, encrypted) VALUES (${id}, ${encrypted})
    ON CONFLICT (id) DO UPDATE SET encrypted=EXCLUDED.encrypted, updated_at=NOW()`;
}
export async function removePushDevice(id) {
  await schema();
  await sql()`DELETE FROM analysis_push_devices WHERE id=${id}`;
}
export function completionMessage(runId, result, preflightFailures = 0) {
  const batches = result.batches || [result];
  const failed = preflightFailures > 0 || batches.some(b => b.ok !== true || b.completed < b.total);
  return {
    title: failed ? '分析結束，部分項目未完成' : '分析完成',
    body: batches.map(b => `${b.league} ${b.completed}/${b.total} 場`).join('｜')
      + (preflightFailures ? `｜${preflightFailures} 聯盟預查失敗` : ''),
    tag: `analysis-${runId}`,
    url: `/?analysisRun=${encodeURIComponent(runId)}`,
  };
}
export async function sendPush(id, message, deliveryId) {
  if (!id) return { status: 'not-subscribed' };
  await schema();
  const rows = await sql()`SELECT encrypted FROM analysis_push_devices WHERE id=${id}`;
  if (!rows.length) return { status: 'not-subscribed' };
  // A short lease allows a crashed worker to retry. The notification tag coalesces
  // duplicate deliveries; Web Push cannot provide exactly-once delivery.
  const claim = await sql()`INSERT INTO analysis_push_deliveries (id,status) VALUES (${deliveryId},'sending')
    ON CONFLICT (id) DO UPDATE SET status='sending', updated_at=NOW()
    WHERE analysis_push_deliveries.status='retry' OR
      (analysis_push_deliveries.status='sending' AND analysis_push_deliveries.updated_at < NOW()-INTERVAL '2 minutes')
    RETURNING id`;
  if (!claim.length) return { status: 'already-claimed' };
  try {
    const pair = await keys();
    await webpush.sendNotification(validateSubscription(unseal(rows[0].encrypted)), JSON.stringify(message), {
      vapidDetails: { subject: 'https://mlb-positive-ev.vercel.app', publicKey: pair.publicKey, privateKey: pair.privateKey },
      TTL: 3600, timeout: 10000,
    });
    await sql()`UPDATE analysis_push_deliveries SET status='sent', updated_at=NOW() WHERE id=${deliveryId}`;
    return { status: 'sent' };
  } catch (error) {
    const expired = [404, 410].includes(error.statusCode);
    if (expired) await removePushDevice(id);
    await sql()`UPDATE analysis_push_deliveries SET status=${expired ? 'expired' : 'retry'}, updated_at=NOW() WHERE id=${deliveryId}`;
    if (expired) return { status: 'expired' };
    throw new Error('推播服務暫時無法送達');
  }
}
