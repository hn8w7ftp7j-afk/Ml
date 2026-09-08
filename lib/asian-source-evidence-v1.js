import { createHash, randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

export const ASIAN_SOURCE_EVIDENCE_VERSION = 'ASIAN-SOURCE-EVIDENCE-v1';
const hash = text => createHash('sha256').update(text).digest('hex');
const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;

// Payload identity and acquisition identity are deliberately independent.
export function captureAsianSource({ url, method, requestBody, raw, representation, fetchedAt, httpStatus }) {
  const contentHash = hash(raw);
  return {
    event: { id: randomUUID(), url, method, requestBodyHash: hash(String(requestBody || '')),
      fetchedAt, publishedAt: null, dataCutoff: null, httpStatus, success: true, contentHash },
    content: { contentHash, representation, encoding: 'GZIP_BASE64',
      rawBytes: Buffer.byteLength(raw), data: gzipSync(raw).toString('base64') },
  };
}

export function auditAsianSourceEvidence(context = {}) {
  const evidence = context.sourceEvidence || {};
  const cutoff = instant(context.inputCutoffAt);
  const contents = evidence.contents || {};
  const events = new Map((evidence.events || []).map(event => [event.id, event]));
  const required = [...new Set(['gameIdentity', 'history', 'away.starter', 'home.starter', 'away.lineup',
    'home.lineup', 'away.bullpen', 'home.bullpen', 'park', 'weather', 'rules',
    ...(evidence.features || []).map(row => row.featureName || row.feature).filter(Boolean)])];
  const supplied = new Map((evidence.features || []).map(row => [row.featureName || row.feature, row]));
  const decoded = new Map();
  const rows = required.map(featureName => {
    const row = supplied.get(featureName);
    const missing = [];
    const contradictions = [];
    if (cutoff === null) missing.push('INPUT_CUTOFF_MISSING');
    if (!row || row.complete !== true) missing.push('DEPENDENCY_MAPPING_INCOMPLETE');
    if (!row?.sourceEventIds?.length && !(row?.derivationVersion && row?.requiredFeatures?.length)) missing.push('SOURCE_EVENT_REFERENCE_MISSING');
    for (const id of row?.sourceEventIds || []) {
      const event = events.get(id);
      if (!event?.success) { missing.push('SUCCESSFUL_SOURCE_EVENT_MISSING'); continue; }
      const content = contents[event.contentHash];
      if (!content) missing.push('SOURCE_CONTENT_MISSING');
      if (content && !decoded.has(event.contentHash)) {
        try {
          const raw = gunzipSync(Buffer.from(content.data, 'base64'), { maxOutputLength: 16 * 1024 * 1024 });
          decoded.set(event.contentHash, hash(raw) === event.contentHash ? null : 'SOURCE_CONTENT_HASH_MISMATCH');
        } catch { decoded.set(event.contentHash, 'SOURCE_CONTENT_UNREADABLE'); }
      }
      if (decoded.get(event.contentHash)) contradictions.push(decoded.get(event.contentHash));
      const fetched = instant(event.fetchedAt);
      if (fetched === null) missing.push('FETCH_TIME_MISSING');
      // Only explicitly bound input events are checked; audit re-fetches are not inputs.
      else if (cutoff !== null && fetched > cutoff) contradictions.push('BOUND_INPUT_FETCH_AFTER_CUTOFF');
      const published = instant(event.publishedAt);
      if (published !== null && cutoff !== null && published > cutoff) contradictions.push('BOUND_VERSION_PUBLICATION_AFTER_CUTOFF');
      const dataCutoff = instant(event.dataCutoff);
      if (dataCutoff !== null && cutoff !== null && dataCutoff > cutoff) contradictions.push('BOUND_STATISTICS_AFTER_CUTOFF');
    }
    return { featureName, status: contradictions.length ? 'FAILED' : missing.length ? 'PENDING' : 'VERIFIED',
      reasons: [...new Set([...contradictions, ...missing])], sourceEventIds: row?.sourceEventIds || [],
      // Acquisition timing is not proof of field-level derivation correctness.
      fieldTraceabilityStatus: 'PENDING',
      fieldTraceabilityReason: 'RAW_FIELD_TO_TRANSFORM_REPLAY_NOT_VALIDATED',
      dependencyScope: row?.dependencyScope || null,
      sourcePaths: row?.sourcePaths || [], derivationVersion: row?.derivationVersion || null };
  });
  const resolved = new Set();
  const visiting = new Set();
  function resolveDependencies(row) {
    if (resolved.has(row.featureName)) return;
    if (visiting.has(row.featureName)) {
      row.status = row.status === 'FAILED' ? 'FAILED' : 'PENDING';
      row.reasons.push('DEPENDENCY_CYCLE');
      return;
    }
    visiting.add(row.featureName);
    for (const name of supplied.get(row.featureName)?.requiredFeatures || []) {
      const dependency = rows.find(item => item.featureName === name);
      if (dependency) resolveDependencies(dependency);
      if (dependency?.status !== 'VERIFIED') {
        row.status = row.status === 'FAILED' || dependency?.status === 'FAILED' ? 'FAILED' : 'PENDING';
        row.reasons.push(`DEPENDENCY_NOT_VERIFIED:${name}`);
      }
    }
    visiting.delete(row.featureName);
    resolved.add(row.featureName);
  }
  rows.forEach(resolveDependencies);
  const start = instant(context.game?.gameDate);
  const pregameCutoffStatus = cutoff === null || start === null ? 'PENDING' : cutoff < start ? 'VERIFIED' : 'FAILED';
  return { version: ASIAN_SOURCE_EVIDENCE_VERSION, inputCutoffAt: context.inputCutoffAt || null, pregameCutoffStatus,
    status: pregameCutoffStatus === 'FAILED' || rows.some(row => row.status === 'FAILED') ? 'FAILED' : pregameCutoffStatus === 'VERIFIED' && rows.every(row => row.status === 'VERIFIED') ? 'VERIFIED' : 'PENDING',
    rows, scope: 'BOUND_SOURCE_CONTENT_AND_ACQUISITION_TIMING', fieldTraceabilityStatus: 'PENDING', predictiveAccuracyValidated: false };
}
