import { neon } from '@neondatabase/serverless';
import { durableDatabaseConfigured, durableDatabaseUrl } from './database-url.js';

let client;
let ready;
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
  await sql().transaction([
    sql()`INSERT INTO asian_source_contents_v1 (content_hash, payload)
      SELECT item->>'contentHash', item FROM jsonb_array_elements(${JSON.stringify(contents)}::jsonb) AS item
      ON CONFLICT (content_hash) DO NOTHING`,
    sql()`INSERT INTO asian_source_events_v1 (event_id, payload)
      SELECT item->>'id', item FROM jsonb_array_elements(${JSON.stringify(events)}::jsonb) AS item
      ON CONFLICT (event_id) DO NOTHING`,
  ]);
  return { ...context, sourceEvidence: { ...evidence, contents: {},
    contentHashes: [...new Set([...(evidence.contentHashes || []), ...contents.map(row => row.contentHash)])], contentStorage: 'IMMUTABLE_SOURCE_STORE_V1' } };
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
