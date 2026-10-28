import { createHash } from 'node:crypto';
import { soccerDate } from './contracts.js';
import { soccerTeamXgDocumentProof, getSoccerTeamXgProvider, SOCCER_TEAM_XG_VERSION } from './team-xg.js';

export const SOCCER_TEAM_XG_ARCHIVE_VERSION = 'SOCCER-TEAM-XG-SOURCE-ARCHIVE-v1';
export const SOCCER_TEAM_XG_DOCUMENT_MAX_BYTES = 2 * 1024 * 1024;
const representation = 'DECODED_HTML_TEXT_DOCUMENT';
const digest = value => createHash('sha256').update(value, 'utf8').digest('hex');
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const hash = value => digest(canonical(value));
const journal = () => import('./journal.js');
const queryJournal = async (...args) => (await journal()).soccerJournalQuery(...args);
const transactionJournal = async (...args) => (await journal()).soccerJournalTransaction(...args);
const iso = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const time = Date.parse(value), day = value.slice(0, 10), parsedDay = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(time) && Number.isFinite(parsedDay) && new Date(parsedDay).toISOString().slice(0, 10) === day
    ? new Date(time).toISOString() : null;
};
const unavailable = reason => ({ version: SOCCER_TEAM_XG_ARCHIVE_VERSION, status: 'UNAVAILABLE', persisted: false,
  reason, representation, decodedDocumentHashRecomputed: false, rawSourceHashRecomputed: false,
  prematchReceipt: false, historicalAvailabilityVerified: false, independentlyConfirmed: false, formalEligible: false });
export const unavailableSoccerTeamXgArchive = () => unavailable('TEAM_XG_SOURCE_STORAGE_UNAVAILABLE');

function bindingFor(result, proof) {
  const source = result?.source, scope = source?.scope, original = proof?.binding, provider = getSoccerTeamXgProvider(result?.league);
  if (!provider || result?.ok !== true || result.version !== SOCCER_TEAM_XG_VERSION
    || result.status !== 'PROVIDER_REPORTED' || result.modelEffectApplied !== false
    || result.pointInTimeAvailabilityVerified !== false || result.formalEligible !== false || result.executable !== false
    || !new RegExp(`^soccer:${provider.league}:[1-9]\\d{0,15}$`).test(result.gameId || '')
    || source?.provider !== 'OPTA_ANALYST' || !/^[a-f0-9]{64}$/.test(source.contentHash || '')
    || source.sourcePublishedAt !== null || scope?.league !== provider.league || scope.gameId !== result.gameId || scope.field !== 'season-team-xg'
    || result.season !== provider.season || canonical(result.competition) !== canonical(provider.competition)
    || !original || original.league !== provider.league || !['PREMATCH_OBSERVATION', 'POSTSTART_AUDIT'].includes(original.phase)
    || !['scheduled', 'live', 'final', 'postponed', 'cancelled', 'suspended'].includes(original.gameStatus)
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(original.fetchId || '')) return null;
  let url;
  try { url = new URL(source.url); } catch { return null; }
  if (source.url !== provider.sourceUrl || url.protocol !== 'https:' || url.hostname !== 'theanalyst.com' || url.username || url.password || url.port || url.hash
    || !url.pathname || url.pathname === '/') return null;
  const fetchedAt = iso(source.fetchedAt), availableAt = iso(source.availableAt), requestedAt = iso(source.requestedAt), kickoffAt = iso(result.startTime);
  const sourceUpdatedAt = source.sourceUpdatedAt === null ? null : iso(source.sourceUpdatedAt);
  if (!fetchedAt || !availableAt || !requestedAt || !kickoffAt || requestedAt > fetchedAt || fetchedAt > availableAt
    || Date.parse(availableAt) > Date.now()
    || source.sourceUpdatedAt !== null && (!sourceUpdatedAt || sourceUpdatedAt > fetchedAt)
    || soccerDate(kickoffAt) !== result.date
    || !['home', 'away'].every(side => /^[1-9]\d{0,15}$/.test(result.teams?.[side]?.sourceId || ''))
    || result.teams.home.sourceId === result.teams.away.sourceId) return null;
  const current = { ...original, provider: source.provider, league: result.league, gameId: result.gameId, date: result.date,
    season: result.season, competition: result.competition,
    teamIds: { home: result.teams.home.sourceId, away: result.teams.away.sourceId },
    sourceUrl: source.url, contentHash: source.contentHash, requestedAt, fetchedAt, availableAt, kickoffAt,
    sourcePublishedAt: null, sourceUpdatedAt };
  if (canonical(current) !== canonical(original)) return null;
  // The actual fetcher's process-local identity separates two real requests
  // with identical bodies/clocks, while cache reuse and archival retries retain
  // one observation. A copied public fetch ID cannot recreate its private proof.
  return { ...current, version: SOCCER_TEAM_XG_ARCHIVE_VERSION, representation };
}

let ready;
export async function ensureSoccerTeamXgStore() {
  return ready ||= (async () => {
    await (await journal()).ensureSoccerJournal();
    await transactionJournal([
      ['SELECT pg_advisory_xact_lock(221019,2302)'],
      [`CREATE TABLE IF NOT EXISTS sports_soccer_team_xg_documents_v1 (
        content_hash TEXT PRIMARY KEY CHECK (content_hash ~ '^[a-f0-9]{64}$'),
        representation TEXT NOT NULL CHECK (representation='DECODED_HTML_TEXT_DOCUMENT'),
        document_text TEXT NOT NULL, document_bytes INTEGER NOT NULL
          CHECK (document_bytes>0 AND document_bytes<=2097152 AND octet_length(document_text)=document_bytes),
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())`],
      [`CREATE TABLE IF NOT EXISTS sports_soccer_team_xg_observations_v1 (
        receipt_id TEXT PRIMARY KEY CHECK (receipt_id ~ '^[a-f0-9]{64}$'),
        content_hash TEXT NOT NULL REFERENCES sports_soccer_team_xg_documents_v1(content_hash),
        league TEXT NOT NULL CHECK (league IN ('epl','ucl')), game_id TEXT NOT NULL, source_url TEXT NOT NULL,
        fetched_at TIMESTAMPTZ NOT NULL, available_at TIMESTAMPTZ NOT NULL, binding JSONB NOT NULL,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())`],
      [`CREATE INDEX IF NOT EXISTS sports_soccer_team_xg_scope_v1
        ON sports_soccer_team_xg_observations_v1 (league,game_id,recorded_at)`],
      ...['documents', 'observations'].map(name => [`CREATE OR REPLACE TRIGGER sports_soccer_immutable_v2
        BEFORE UPDATE OR DELETE ON sports_soccer_team_xg_${name}_v1
        FOR EACH ROW EXECUTE FUNCTION sports_soccer_immutable_v2()`]),
    ]);
  })().catch(error => { ready = null; throw error; });
}

async function readDocument(receiptId, query) {
  const rows = await query(`SELECT o.receipt_id,o.content_hash,o.league,o.game_id,o.source_url,o.fetched_at,o.available_at,
    o.binding,o.recorded_at,d.representation,d.document_text,d.document_bytes,d.recorded_at AS document_recorded_at
    FROM sports_soccer_team_xg_observations_v1 o JOIN sports_soccer_team_xg_documents_v1 d USING(content_hash)
    WHERE o.receipt_id=$1 AND d.document_bytes<=$2`, [receiptId, SOCCER_TEAM_XG_DOCUMENT_MAX_BYTES]);
  const row = rows[0], binding = row?.binding, provider = getSoccerTeamXgProvider(binding?.league);
  if (!row || rows.length !== 1 || row.representation !== representation || hash(binding) !== receiptId
    || binding.version !== SOCCER_TEAM_XG_ARCHIVE_VERSION || binding.representation !== representation || binding.provider !== 'OPTA_ANALYST'
    || !provider || binding.season !== provider.season || canonical(binding.competition) !== canonical(provider.competition)
    || binding.sourceUrl !== provider.sourceUrl || binding.contentHash !== row.content_hash || binding.league !== row.league || binding.gameId !== row.game_id
    || binding.sourceUrl !== row.source_url || binding.fetchedAt !== new Date(row.fetched_at).toISOString()
    || binding.availableAt !== new Date(row.available_at).toISOString() || typeof row.document_text !== 'string'
    || Buffer.byteLength(row.document_text, 'utf8') !== Number(row.document_bytes) || digest(row.document_text) !== row.content_hash)
    throw Error('SOCCER_TEAM_XG_SOURCE_READBACK_FAILED');
  const recordedAt = new Date(row.recorded_at).toISOString(), documentRecordedAt = new Date(row.document_recorded_at).toISOString();
  if (!iso(recordedAt) || !iso(documentRecordedAt)) throw Error('SOCCER_TEAM_XG_SOURCE_RECEIPT_TIME_INVALID');
  const timingStatus = binding.availableAt > recordedAt ? 'QUARANTINED_SOURCE_TIME_AFTER_DATABASE_RECEIPT'
    : documentRecordedAt > recordedAt ? 'QUARANTINED_DOCUMENT_TIME_AFTER_OBSERVATION'
      : recordedAt >= binding.kickoffAt ? 'AFTER_KICKOFF_DATABASE_RECEIPT'
        : binding.phase !== 'PREMATCH_OBSERVATION' || binding.gameStatus !== 'scheduled' ? 'POSTSTART_SOURCE_OBSERVATION' : 'PREGAME_DATABASE_RECEIPT';
  return { text: row.document_text, receipt: { version: SOCCER_TEAM_XG_ARCHIVE_VERSION, status: 'ARCHIVED', persisted: true,
    receiptId, representation, serialization: 'UTF8_DECODED_HTTP_RESPONSE_TEXT', hashAlgorithm: 'SHA256',
    provider: binding.provider, league: row.league, gameId: row.game_id, date: binding.date, season: binding.season,
    competition: binding.competition, teamIds: binding.teamIds, sourceUrl: row.source_url, contentHash: row.content_hash,
    documentBytes: Number(row.document_bytes), fetchedAt: binding.fetchedAt, availableAt: binding.availableAt,
    sourcePublishedAt: null, sourceUpdatedAt: binding.sourceUpdatedAt, kickoffAt: binding.kickoffAt,
    recordedAt, documentRecordedAt, timingStatus, prematchReceipt: timingStatus === 'PREGAME_DATABASE_RECEIPT',
    decodedDocumentHashRecomputed: true, rawSourceHashRecomputed: false,
    historicalAvailabilityVerified: false, independentlyConfirmed: false, formalEligible: false } };
}

export async function archiveSoccerTeamXg(result, { query = queryJournal, transaction = transactionJournal, ensure = ensureSoccerTeamXgStore } = {}) {
  let proof, binding;
  try { proof = soccerTeamXgDocumentProof(result); binding = proof && bindingFor(result, proof); } catch { return unavailable('TEAM_XG_SOURCE_PRIVATE_PROOF_INVALID'); }
  if (!proof) return unavailable('TEAM_XG_SOURCE_PRIVATE_PROOF_MISSING');
  if (!binding) return unavailable('TEAM_XG_SOURCE_BINDING_CHANGED');
  if (typeof proof.text !== 'string' || proof.text.includes('\u0000') || !proof.text.length
    || Buffer.byteLength(proof.text, 'utf8') !== proof.bytes || proof.bytes > SOCCER_TEAM_XG_DOCUMENT_MAX_BYTES)
    return unavailable('TEAM_XG_SOURCE_BYTE_BUDGET');
  if (digest(proof.text) !== binding.contentHash) return unavailable('TEAM_XG_SOURCE_HASH_MISMATCH');
  const receiptId = hash(binding);
  await ensure();
  await transaction([
    [`INSERT INTO sports_soccer_team_xg_documents_v1(content_hash,representation,document_text,document_bytes)
      VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [binding.contentHash, representation, proof.text, proof.bytes]],
    [`INSERT INTO sports_soccer_team_xg_observations_v1
      (receipt_id,content_hash,league,game_id,source_url,fetched_at,available_at,binding)
      VALUES($1,$2,$3,$4,$5,$6::timestamptz,$7::timestamptz,$8::jsonb) ON CONFLICT DO NOTHING`,
    [receiptId, binding.contentHash, binding.league, binding.gameId, binding.sourceUrl, binding.fetchedAt, binding.availableAt, JSON.stringify(binding)]],
  ]);
  const stored = await readDocument(receiptId, query);
  if (stored.text !== proof.text) throw Error('SOCCER_TEAM_XG_SOURCE_CONTENT_CONFLICT');
  return stored.receipt;
}

// Server-only audit helper; no route exports source HTML or private proof.
export async function loadSoccerTeamXgDocument(receiptId, { query = queryJournal, ensure = ensureSoccerTeamXgStore } = {}) {
  if (!/^[a-f0-9]{64}$/.test(receiptId || '')) throw Error('SOCCER_TEAM_XG_SOURCE_RECEIPT_INVALID');
  await ensure();
  const stored = await readDocument(receiptId, query);
  return { receipt: stored.receipt, document: stored.text };
}
