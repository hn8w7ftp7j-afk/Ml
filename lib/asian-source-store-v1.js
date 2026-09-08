import { neon } from '@neondatabase/serverless';
import { durableDatabaseConfigured, durableDatabaseUrl } from './database-url.js';

let client;
let ready;
const canonical = value => JSON.stringify(value, function (key, item) {
  return item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item;
});
function sql() { return client ||= neon(durableDatabaseUrl()); }
async function schema() {
  if (!ready) ready = (async () => {
    await sql()`CREATE TABLE IF NOT EXISTS asian_source_contents_v1 (
      content_hash TEXT PRIMARY KEY, payload JSONB NOT NULL, saved_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
    await sql()`CREATE TABLE IF NOT EXISTS asian_source_events_v1 (
      event_id TEXT PRIMARY KEY, payload JSONB NOT NULL, saved_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
  })().catch(error => { ready = null; throw error; });
  return ready;
}

// New records only. No UPDATE, DELETE, or rewriting any historical evidence.
export async function externalizeAsianSourceEvidence(context) {
  if (!context?.sourceEvidence || context.sourceEvidence.contentStorage === 'IMMUTABLE_SOURCE_STORE_V1' || !durableDatabaseConfigured()) return context;
  await schema();
  const evidence = context.sourceEvidence;
  const contents = Object.values(evidence.contents || {});
  const events = (evidence.events || []).map(({ fromCache, observedAt, ...event }) => event);
  const hashes = [...new Set([...(evidence.contentHashes || []), ...contents.map(row => row.contentHash)])];
  const [, , storedContents, storedEvents] = await sql().transaction([
    sql()`INSERT INTO asian_source_contents_v1 (content_hash, payload)
      SELECT item->>'contentHash', item FROM jsonb_array_elements(${JSON.stringify(contents)}::jsonb) AS item
      ON CONFLICT (content_hash) DO NOTHING`,
    sql()`INSERT INTO asian_source_events_v1 (event_id, payload)
      SELECT item->>'id', item FROM jsonb_array_elements(${JSON.stringify(events)}::jsonb) AS item
      ON CONFLICT (event_id) DO NOTHING`,
    sql()`SELECT content_hash, payload FROM asian_source_contents_v1
      WHERE content_hash IN (SELECT jsonb_array_elements_text(${JSON.stringify(hashes)}::jsonb))`,
    sql()`SELECT event_id, payload FROM asian_source_events_v1
      WHERE event_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(events.map(row => row.id))}::jsonb))`,
  ]);
  const byHash = new Map(storedContents.map(row => [row.content_hash, row.payload]));
  const byId = new Map(storedEvents.map(row => [row.event_id, row.payload]));
  if (hashes.some(value => !byHash.has(value))
    || contents.some(row => canonical(byHash.get(row.contentHash)) !== canonical(row))
    || events.some(row => canonical(byId.get(row.id)) !== canonical(row))) {
    throw new Error('ASIAN_SOURCE_STORE_READBACK_MISMATCH');
  }
  return { ...context, sourceEvidence: { ...evidence, contents: {},
    contentHashes: hashes, contentStorage: 'IMMUTABLE_SOURCE_STORE_V1', storageReadback: 'VERIFIED' } };
}

export async function hydrateAsianSourceEvidence(context) {
  if (context?.sourceEvidence?.contentStorage !== 'IMMUTABLE_SOURCE_STORE_V1') return context;
  if (!durableDatabaseConfigured()) return context;
  const hashes = context.sourceEvidence.contentHashes || [];
  if (!hashes.length) return context;
  const rows = await sql()`SELECT content_hash, payload FROM asian_source_contents_v1
    WHERE content_hash IN (SELECT jsonb_array_elements_text(${JSON.stringify(hashes)}::jsonb))`;
  return { ...context, sourceEvidence: { ...context.sourceEvidence,
    contents: { ...context.sourceEvidence.contents, ...Object.fromEntries(rows.map(row => [row.content_hash, row.payload])) } } };
}
