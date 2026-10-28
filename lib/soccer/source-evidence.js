import { createHash } from 'node:crypto';
import { soccerLeague } from './contracts.js';

export const SOCCER_SOURCE_EVIDENCE_VERSION = 'SOCCER-FIELD-SOURCE-TIMES-v1';
const instant = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return NaN;
  const day=value.slice(0,10),date=Date.parse(`${day}T00:00:00.000Z`),time=Date.parse(value);
  return Number.isFinite(date)&&new Date(date).toISOString().slice(0,10)===day&&Number.isFinite(time)?time:NaN;
};
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy = value => value && typeof value === 'object' ? structuredClone(value) : {};
const publishedFields = ['sourcePublishedAt', 'publishedAt', 'datePublished', 'firstPublishedAt', 'published'];
const updatedFields = ['sourceUpdatedAt', 'updatedAt', 'lastUpdated', 'lastModified', 'dateModified', 'updated'];

function timestamp(node, fields, fetchedAt) {
  const candidates = fields.filter(field => Object.hasOwn(node || {}, field)).map(field => {
    const value = node[field], parsed = instant(value);
    return { field, value: typeof value === 'string' ? value.slice(0, 160) : null,
      status: !Number.isFinite(parsed) ? 'INVALID_TIMESTAMP' : !Number.isFinite(fetchedAt) ? 'FETCH_TIME_UNVERIFIED'
        : parsed > fetchedAt ? 'AFTER_FETCH' : 'PROVIDER_REPORTED' };
  });
  const values = [...new Set(candidates.filter(item => item.status === 'PROVIDER_REPORTED').map(item => new Date(item.value).toISOString()))];
  // A future/invalid/conflicting timestamp is retained as a diagnostic, never
  // silently replaced with another date or with the server fetch clock.
  const valid = candidates.length > 0 && candidates.every(item => item.status === 'PROVIDER_REPORTED') && values.length === 1;
  return { value: valid ? values[0] : null, status: !candidates.length ? 'NOT_PROVIDED' : valid ? 'PROVIDER_REPORTED'
    : values.length > 1 ? 'CONFLICTING_TIMESTAMPS' : 'UNVERIFIED', candidates };
}

/**
 * Field-local timestamps from the actual fetched document. A kickoff date,
 * injury onset date, team logo update or news article date is not the field's
 * publication time. A response fetch proves availability at that fetch only;
 * it does not prove what was published in an earlier historical snapshot.
 */
function observationSource({ node = {}, payload, game, source = {}, now = Date.now(), field = 'document' } = {}, documentEvidence = null) {
  source = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  const rawSource = copy(source), fetched = instant(source?.fetchedAt), league = soccerLeague(game?.league);
  let sourceScopeVerified = false;
  try {
    const url = new URL(source.url);
    sourceScopeVerified = source.provider === 'ESPN' && url.protocol === 'https:' && url.hostname === 'site.api.espn.com'
      && !url.port && !url.username && !url.password && !url.hash
      && url.pathname === `/apis/site/v2/sports/soccer/${league?.espnSlug}/summary`
      && url.searchParams.getAll('event').length === 1 && url.searchParams.get('event') === game?.sourceId;
  } catch {}
  let contentHashVerified = documentEvidence?.contentHashVerified === true;
  if (!documentEvidence) {
    try { contentHashVerified = /^[a-f0-9]{64}$/.test(source?.contentHash || '') && payload != null && hash(payload) === source.contentHash; } catch {}
  }
  const requested = source.requestedAt == null ? null : instant(source.requestedAt);
  const available = source.availableAt == null ? fetched : instant(source.availableAt);
  const fetchTimeVerified = Number.isFinite(now) && Number.isFinite(fetched) && fetched <= now
    && Number.isFinite(available) && fetched <= available && available <= now
    && (requested === null || Number.isFinite(requested) && requested <= fetched);
  // Only document-level adapter metadata can describe document publication.
  // It must never be inherited as a player/lineup/injury publication time.
  const publicationNode = field === 'document' && source.sourcePublishedAt !== undefined
    ? { ...node, adapterSourcePublishedAt: source.sourcePublishedAt } : node;
  const updateNode = field === 'document' && source.sourceUpdatedAt !== undefined
    ? { ...node, adapterSourceUpdatedAt: source.sourceUpdatedAt } : node;
  const publication = timestamp(publicationNode, [...publishedFields, 'adapterSourcePublishedAt'], fetched);
  const update = timestamp(updateNode, [...updatedFields, 'adapterSourceUpdatedAt'], fetched);
  const observationVerified = sourceScopeVerified && contentHashVerified && fetchTimeVerified;
  const observedAvailableAt = fetchTimeVerified ? new Date(available).toISOString() : null;
  const normalized = { ...rawSource, sourcePublishedAt: publication.value, sourceUpdatedAt: update.value,
    availableAt: observedAvailableAt, availabilityBasis: observedAvailableAt
      ? source.availableAt == null ? 'OBSERVED_FETCH_COMPLETION' : 'SOURCE_ADAPTER_AVAILABILITY_TIME' : 'FETCH_TIME_UNVERIFIED',
    publicationStatus: publication.status, updateStatus: update.status,
    scope: { league: game?.league || null, gameId: game?.id || null, field },
    independentlyConfirmed: false, historicalAvailabilityVerified: false };
  return { source: normalized, rawSource, evidence: {
    version: SOCCER_SOURCE_EVIDENCE_VERSION, field, sourceScopeVerified, contentHashVerified, fetchTimeVerified,
    observedAvailabilityVerified: observationVerified, observedAvailableAt,
    sourcePublishedAt: publication.value, publicationStatus: publication.status, publicationCandidates: publication.candidates,
    sourceUpdatedAt: update.value, updateStatus: update.status, updateCandidates: update.candidates,
    publishedAvailabilityVerified: observationVerified && publication.value !== null,
    independentlyConfirmed: false, historicalAvailabilityVerified: false,
    missingReason: !sourceScopeVerified ? 'SOURCE_EVENT_SCOPE_UNVERIFIED' : !contentHashVerified ? 'SOURCE_DOCUMENT_HASH_UNVERIFIED'
      : !fetchTimeVerified ? 'SOURCE_FETCH_TIME_UNVERIFIED' : publication.value === null ? 'SOURCE_PUBLICATION_TIME_UNVERIFIED' : null,
  } };
}

export function soccerObservationSource(options) { return observationSource(options); }

// Reuse the one hash of the immutable raw JSON during a normalizer invocation;
// hashing the full summary again for each player would add unnecessary work.
export function soccerObservationSources(options) {
  const document = observationSource(options);
  return { document, forField: (node, field) => observationSource({ ...options, node, field }, document.evidence) };
}
