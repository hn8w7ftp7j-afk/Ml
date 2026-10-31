import { createHash } from 'node:crypto';
import { soccerLeague, soccerDate } from './contracts.js';

export const SOCCER_SOURCE_DOCUMENT_VERSION = 'SOCCER-NORMALIZED-SOURCE-ARCHIVE-v1';
export const SOCCER_SOURCE_DOCUMENT_MAX_BYTES = 4 * 1024 * 1024;
const representation = 'NORMALIZED_JSON_DOCUMENT';
const documents = new WeakMap();
// Only this process's successful normalizer + default database readback can
// grant current availability. A serialized receipt remains display evidence;
// it cannot recreate this capability or backdate a later database observation.
const currentAvailability = new WeakMap();
const digest = text => createHash('sha256').update(text).digest('hex');
const soccerJournalHash = value => digest(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item));
// Normalization itself does not initialize a database client. Only the server
// archival operation loads the existing journal transport.
const journal = () => import('./journal.js');
const soccerJournalQuery = async (...args) => (await journal()).soccerJournalQuery(...args);
const soccerJournalTransaction = async (...args) => (await journal()).soccerJournalTransaction(...args);
const iso = value => {
  const time = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)
    && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};
const unavailable = reason => ({ version: SOCCER_SOURCE_DOCUMENT_VERSION, status: 'UNAVAILABLE', persisted: false,
  reason, representation, rawSourceHashRecomputed: false, normalizedDocumentHashRecomputed: false,
  prematchReceipt: false, historicalAvailabilityVerified: false, independentlyConfirmed: false, formalEligible: false });
const observedFields = ['document', ...['home', 'away'].flatMap(side => ['lineup', 'injuries', 'suspensions', 'minutes'].map(field => `teams.${side}.${field}`)),
  'xg', 'travel', 'weather', 'referee', 'uclContext'];
function observationFor(evidence, field) {
  return field === 'document' ? { source: evidence?.source, sourceEvidence: evidence?.sourceEvidence, rawSource: evidence?.rawSource }
    : field.split('.').reduce((node, key) => node?.[key], evidence);
}
function sourceMatchesBinding(source, field, binding) {
  return source && source.provider === binding.provider && source.url === binding.sourceUrl
    && source.contentHash === binding.contentHash && source.fetchedAt === binding.fetchedAt
    && source.availableAt === binding.availableAt && source.scope?.gameId === binding.gameId
    && source.scope?.league === binding.league && source.scope?.field === field;
}

function bindingFor(evidence) {
  const game = evidence?.game, source = evidence?.source, verified = evidence?.sourceEvidence;
  const league = soccerLeague(game?.league), eventId = game?.sourceId;
  if (evidence?.ok !== true || !league || !/^\d{1,16}$/.test(eventId || '')
    || game.id !== `soccer:${league.id}:${eventId}` || evidence.league !== league.id
    || verified?.sourceScopeVerified !== true || verified?.contentHashVerified !== true
    || verified?.fetchTimeVerified !== true || verified?.observedAvailabilityVerified !== true
    || source?.provider !== 'ESPN' || !/^[a-f0-9]{64}$/.test(source.contentHash || '')
    || source.scope?.league !== league.id || source.scope?.gameId !== game.id || source.scope?.field !== 'document') return null;
  let url;
  try { url = new URL(source.url); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname !== 'site.api.espn.com' || url.port || url.username || url.password || url.hash
    || url.pathname !== `/apis/site/v2/sports/soccer/${league.espnSlug}/summary`
    || [...url.searchParams.keys()].some(key => key !== 'event') || url.searchParams.getAll('event').length !== 1
    || url.searchParams.get('event') !== eventId) return null;
  const fetchedAt = iso(source.fetchedAt), availableAt = iso(source.availableAt), kickoffAt = iso(game.startTime);
  const requestedAt = source.requestedAt == null ? null : iso(source.requestedAt);
  if (!fetchedAt || !availableAt || !kickoffAt || availableAt < fetchedAt
    || source.requestedAt != null && (!requestedAt || requestedAt > fetchedAt)
    || soccerDate(kickoffAt) !== game.date
    || ![game.home, game.away].every(team => /^\d{1,16}$/.test(team?.sourceId || '')
      && team.id === `soccer:${league.id}:team:${team.sourceId}`) || game.home.id === game.away.id) return null;
  return { version: SOCCER_SOURCE_DOCUMENT_VERSION, representation, provider: 'ESPN', league: league.id,
    gameId: game.id, eventId, date: game.date, phase: evidence.phase, gameStatus: game.status,
    teamIds: { home: game.home.id, away: game.away.id },
    sourceUrl: source.url, contentHash: source.contentHash, fetchedAt, availableAt, requestedAt, kickoffAt,
    sourcePublishedAt: source.sourcePublishedAt == null ? null : iso(source.sourcePublishedAt),
    sourceUpdatedAt: source.sourceUpdatedAt == null ? null : iso(source.sourceUpdatedAt) };
}

// The successful normalizer alone attaches this process-local proof. Cloning or
// JSON/HTTP round-tripping an evidence object cannot carry the document or grant
// archival approval. This is parsed-provider JSON, never the original HTTP bytes.
export function registerSoccerSourceDocument(evidence, payload) {
  try {
    const binding = bindingFor(evidence);
    if (!binding || String(payload?.header?.id) !== binding.eventId) {
      documents.set(evidence, { reason: 'SOURCE_DOCUMENT_SCOPE_OR_HASH_UNVERIFIED' }); return evidence;
    }
    const text = JSON.stringify(payload), bytes = Buffer.byteLength(text);
    if (bytes > SOCCER_SOURCE_DOCUMENT_MAX_BYTES) {
      documents.set(evidence, { reason: 'SOURCE_DOCUMENT_BYTE_BUDGET' }); return evidence;
    }
    if (digest(text) !== binding.contentHash) {
      documents.set(evidence, { reason: 'SOURCE_DOCUMENT_HASH_MISMATCH' }); return evidence;
    }
    // Capture the exact source references and observations emitted by this
    // normalizer. Fields invented or changed before archive cannot gain source
    // authority merely by copying the document's URL/hash into a new scope.
    const sourceProofs = observedFields.flatMap(field => {
      const observation = observationFor(evidence, field), source = observation?.source;
      return sourceMatchesBinding(source, field, binding) ? [{ field, source,
        sourceSignature: soccerJournalHash(source), observationSignature: soccerJournalHash(observation) }] : [];
    });
    documents.set(evidence, { text, bytes, binding, receiptId: soccerJournalHash(binding), sourceProofs });
  } catch { if (evidence && typeof evidence === 'object') documents.set(evidence, { reason: 'SOURCE_DOCUMENT_UNVERIFIED' }); }
  return evidence;
}

let ready;
export async function ensureSoccerSourceDocumentStore() {
  return ready ||= (async () => {
    await (await journal()).ensureSoccerJournal();
    await soccerJournalTransaction([
      ['SELECT pg_advisory_xact_lock(221019,2301)'],
      [`CREATE TABLE IF NOT EXISTS sports_soccer_source_documents_v1 (
        content_hash TEXT PRIMARY KEY CHECK (content_hash ~ '^[a-f0-9]{64}$'),
        representation TEXT NOT NULL CHECK (representation='NORMALIZED_JSON_DOCUMENT'),
        document_text TEXT NOT NULL, document_bytes INTEGER NOT NULL
          CHECK (document_bytes>0 AND document_bytes<=4194304 AND octet_length(document_text)=document_bytes),
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())`],
      [`CREATE TABLE IF NOT EXISTS sports_soccer_source_document_observations_v1 (
        receipt_id TEXT PRIMARY KEY CHECK (receipt_id ~ '^[a-f0-9]{64}$'),
        content_hash TEXT NOT NULL REFERENCES sports_soccer_source_documents_v1(content_hash),
        league TEXT NOT NULL CHECK (league IN ('epl','ucl')), game_id TEXT NOT NULL, source_url TEXT NOT NULL,
        fetched_at TIMESTAMPTZ NOT NULL, available_at TIMESTAMPTZ NOT NULL, binding JSONB NOT NULL,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())`],
      [`CREATE INDEX IF NOT EXISTS sports_soccer_source_document_scope_v1
        ON sports_soccer_source_document_observations_v1 (league,game_id,recorded_at)`],
      ...['documents', 'document_observations'].map(name => [`CREATE OR REPLACE TRIGGER sports_soccer_immutable_v2
        BEFORE UPDATE OR DELETE ON sports_soccer_source_${name}_v1
        FOR EACH ROW EXECUTE FUNCTION sports_soccer_immutable_v2()`]),
    ]);
  })().catch(error => { ready = null; throw error; });
}

async function readDocument(receiptId, query) {
  const rows = await query(`SELECT o.receipt_id,o.content_hash,o.league,o.game_id,o.source_url,o.fetched_at,o.available_at,
    o.binding,o.recorded_at,d.representation,d.document_text,d.document_bytes,d.recorded_at AS document_recorded_at
    FROM sports_soccer_source_document_observations_v1 o JOIN sports_soccer_source_documents_v1 d USING(content_hash)
    WHERE o.receipt_id=$1 AND d.document_bytes<=$2`, [receiptId, SOCCER_SOURCE_DOCUMENT_MAX_BYTES]);
  const row = rows[0], binding = row?.binding;
  if (!row || rows.length !== 1 || row.representation !== representation || soccerJournalHash(binding) !== receiptId
    || binding.contentHash !== row.content_hash || binding.league !== row.league || binding.gameId !== row.game_id
    || binding.sourceUrl !== row.source_url || binding.fetchedAt !== new Date(row.fetched_at).toISOString()
    || binding.availableAt !== new Date(row.available_at).toISOString()
    || Buffer.byteLength(row.document_text) !== Number(row.document_bytes) || digest(row.document_text) !== row.content_hash)
    throw Error('SOCCER_SOURCE_DOCUMENT_READBACK_FAILED');
  const recordedAt = new Date(row.recorded_at).toISOString(), documentRecordedAt = new Date(row.document_recorded_at).toISOString();
  if (!iso(recordedAt) || !iso(documentRecordedAt)) throw Error('SOCCER_SOURCE_DOCUMENT_RECEIPT_TIME_INVALID');
  const timingStatus = binding.availableAt > recordedAt ? 'QUARANTINED_SOURCE_TIME_AFTER_DATABASE_RECEIPT'
    : documentRecordedAt > recordedAt ? 'QUARANTINED_DOCUMENT_TIME_AFTER_OBSERVATION'
      : recordedAt >= binding.kickoffAt ? 'AFTER_KICKOFF_DATABASE_RECEIPT'
        : binding.phase !== 'PREMATCH_OBSERVATION' || binding.gameStatus !== 'scheduled' ? 'POSTSTART_SOURCE_OBSERVATION' : 'PREGAME_DATABASE_RECEIPT';
  return { text: row.document_text, binding, receipt: { version: SOCCER_SOURCE_DOCUMENT_VERSION, status: 'ARCHIVED', persisted: true,
    receiptId, representation, serialization: 'JSON.stringify(PARSED_PROVIDER_RESPONSE)', hashAlgorithm: 'SHA256',
    provider: binding.provider, league: row.league, gameId: row.game_id, sourceUrl: row.source_url, contentHash: row.content_hash,
    documentBytes: Number(row.document_bytes), fetchedAt: binding.fetchedAt, availableAt: binding.availableAt,
    sourcePublishedAt: binding.sourcePublishedAt, sourceUpdatedAt: binding.sourceUpdatedAt,
    kickoffAt: binding.kickoffAt, recordedAt, documentRecordedAt, timingStatus,
    // An already-known body never backdates this particular fetch observation.
    prematchReceipt: timingStatus === 'PREGAME_DATABASE_RECEIPT',
    normalizedDocumentHashRecomputed: true, rawSourceHashRecomputed: false,
    historicalAvailabilityVerified: false, independentlyConfirmed: false, formalEligible: false } };
}

export async function archiveSoccerSourceDocument(evidence, { query = soccerJournalQuery,
  transaction = soccerJournalTransaction, ensure = ensureSoccerSourceDocumentStore } = {}) {
  const document = documents.get(evidence);
  if (!document || document.reason) return unavailable(document?.reason || 'SOURCE_DOCUMENT_PRIVATE_PROOF_MISSING');
  const current = bindingFor(evidence);
  if (!current || soccerJournalHash(current) !== document.receiptId) return unavailable('SOURCE_DOCUMENT_BINDING_CHANGED');
  await ensure();
  const binding = document.binding;
  await transaction([
    [`INSERT INTO sports_soccer_source_documents_v1(content_hash,representation,document_text,document_bytes)
      VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [binding.contentHash, representation, document.text, document.bytes]],
    [`INSERT INTO sports_soccer_source_document_observations_v1
      (receipt_id,content_hash,league,game_id,source_url,fetched_at,available_at,binding)
      VALUES($1,$2,$3,$4,$5,$6::timestamptz,$7::timestamptz,$8::jsonb) ON CONFLICT DO NOTHING`,
    [document.receiptId, binding.contentHash, binding.league, binding.gameId, binding.sourceUrl,
      binding.fetchedAt, binding.availableAt, JSON.stringify(binding)]],
  ]);
  const stored = await readDocument(document.receiptId, query);
  if (stored.text !== document.text) throw Error('SOCCER_SOURCE_DOCUMENT_CONTENT_CONFLICT');
  if (query === soccerJournalQuery && transaction === soccerJournalTransaction && ensure === ensureSoccerSourceDocumentStore)
    rememberCurrentAvailability(evidence, document, stored.receipt);
  return stored.receipt;
}

function rememberCurrentAvailability(evidence, document, receipt, restoreOnly = false) {
  const binding = document.binding;
  if (receipt.prematchReceipt === true) {
    const sources = new Map();
    for (const original of document.sourceProofs || []) {
      const observation = observationFor(evidence, original.field), source = observation?.source;
      if ((restoreOnly || source === original.source) && sourceMatchesBinding(source, original.field, binding)
        && soccerJournalHash(source) === original.sourceSignature && soccerJournalHash(observation) === original.observationSignature)
        sources.set(source, { field: original.field, signature: original.sourceSignature, observationSignature: original.observationSignature });
    }
    // Restoring a board retains only small capabilities, not one full source
    // document per game. The fetched body can be released after each iteration.
    currentAvailability.set(evidence, { receiptId: document.receiptId, normalizerDocument: restoreOnly ? null : document,
      binding, receipt: Object.freeze(structuredClone(receipt)), sources });
  }
}

/** Current-only availability of the exact privately retained source object.
 * It proves presence by the database receipt, never a publisher's earlier time,
 * independent correctness, complete field coverage or model acceptance. */
export function soccerCurrentSourceAvailability(source, { evidence, game, now = Date.now(), field = 'document' } = {}) {
  try {
    const proof = currentAvailability.get(evidence), entry = proof?.sources.get(source), receipt = proof?.receipt;
    if (!proof || !entry || entry.field !== field || proof.normalizerDocument && documents.get(evidence) !== proof.normalizerDocument
      || entry.signature !== soccerJournalHash(source) || entry.observationSignature !== soccerJournalHash(observationFor(evidence, field))
      || soccerJournalHash(bindingFor(evidence)) !== proof.receiptId
      || game?.id !== proof.binding.gameId || game?.league !== proof.binding.league
      || game?.startTime !== proof.binding.kickoffAt
      || !['home', 'away'].every(side => game?.[side]?.id === proof.binding.teamIds[side])
      || evidence.phase !== 'PREMATCH_OBSERVATION' || game.status !== 'scheduled'
      || source.sourcePublishedAt !== null || source.publicationStatus !== 'NOT_PROVIDED'
      || !Number.isFinite(now) || Date.parse(receipt.recordedAt) > now
      || Date.parse(receipt.kickoffAt) <= now || now - Date.parse(receipt.fetchedAt) >= 180000) return null;
    return { version: 'SOCCER-CURRENT-ARCHIVE-AVAILABILITY-v1', status: 'CURRENT_DATABASE_RECEIPT_VERIFIED',
      scope: 'CURRENT_ANALYSIS_ONLY', receiptId: receipt.receiptId, gameId: receipt.gameId, league: receipt.league,
      contentHash: receipt.contentHash, sourceUrl: receipt.sourceUrl, fetchedAt: receipt.fetchedAt,
      availableAt: receipt.availableAt, recordedAt: receipt.recordedAt,
      sourcePublishedAt: null, historicalAvailabilityVerified: false, independentlyConfirmed: false };
  } catch { return null; }
}

// A saved JSON receipt is only a lookup key. Re-read its exact immutable body
// and binding through the real store, reconstruct the source observations, and
// match them before granting a new process-local current capability. Neither
// custom transports nor caller-supplied availability flags enter this path.
export async function restoreSoccerCurrentSourceAvailability(evidence, now = Date.now()) {
  try {
    if (soccerCurrentSourceAvailability(evidence?.source, { evidence, game: evidence?.game, now })) return true;
    const receiptId = evidence?.sourceDocumentArchive?.receiptId;
    const fetchedAt = Date.parse(evidence?.source?.fetchedAt);
    if (!/^[a-f0-9]{64}$/.test(receiptId || '') || !Number.isFinite(now)
      || evidence?.phase !== 'PREMATCH_OBSERVATION' || evidence?.game?.status !== 'scheduled'
      || evidence.source?.sourcePublishedAt !== null || evidence.source?.publicationStatus !== 'NOT_PROVIDED'
      || !(Date.parse(evidence.game.startTime) > now) || !Number.isFinite(fetchedAt)
      || fetchedAt > now || now - fetchedAt >= 180000
      || evidence.sourceDocumentArchive.prematchReceipt !== true
      || !(Date.parse(evidence.sourceDocumentArchive.recordedAt) <= now)) return false;
    await ensureSoccerSourceDocumentStore();
    const stored = await readDocument(receiptId, soccerJournalQuery);
    if (!stored.receipt.prematchReceipt || Date.parse(stored.receipt.recordedAt) > now
      || soccerJournalHash(bindingFor(evidence)) !== receiptId) return false;
    const { normalizeSoccerPrematch } = await import('./prematch.js');
    const rebuilt = normalizeSoccerPrematch(JSON.parse(stored.text), evidence.game, evidence.rawSource, now);
    const document = documents.get(rebuilt);
    if (!rebuilt.ok || !document || document.reason || document.receiptId !== receiptId
      || ['source', 'sourceEvidence', 'rawSource', 'teams', 'referee'].some(field => soccerJournalHash(rebuilt[field]) !== soccerJournalHash(evidence[field]))) return false;
    const originalScopes = new Map((document.sourceProofs || []).map(entry => [entry.field, entry]));
    for (const field of observedFields) {
      const observation = observationFor(evidence, field), source = observation?.source;
      // Later backend observations (e.g. Opta xG) have their own source/hash.
      // They cannot claim an invented field within this ESPN document.
      if (source?.url === document.binding.sourceUrl && source?.contentHash === document.binding.contentHash) {
        const original = originalScopes.get(field);
        if (!original || soccerJournalHash(source) !== original.sourceSignature
          || soccerJournalHash(observation) !== original.observationSignature) return false;
      }
    }
    rememberCurrentAvailability(evidence, document, stored.receipt, true);
    return Boolean(soccerCurrentSourceAvailability(evidence.source, { evidence, game: evidence.game, now }));
  } catch { return false; }
}

// Server-side audit helper. No route exposes the retained source document.
export async function loadSoccerSourceDocument(receiptId, { query = soccerJournalQuery, ensure = ensureSoccerSourceDocumentStore } = {}) {
  if (!/^[a-f0-9]{64}$/.test(receiptId || '')) throw Error('SOCCER_SOURCE_DOCUMENT_RECEIPT_INVALID');
  await ensure();
  const stored = await readDocument(receiptId, query);
  return { receipt: stored.receipt, document: JSON.parse(stored.text) };
}

export const unavailableSoccerSourceDocumentArchive = () => unavailable('SOURCE_DOCUMENT_STORAGE_UNAVAILABLE');
