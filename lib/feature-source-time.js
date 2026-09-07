// Transport receipt time is distinct from a statistical period or forecast
// valid time. Never substitute Date.now(), asOf, or game start for evidence.
export function withFeatureSourceTime(feature, receipts = []) {
  const sources = receipts.filter(Boolean);
  const valid = value => typeof value === 'string' && /(Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
  const complete = sources.length > 0 && sources.every(r => valid(r.fetchedAt));
  return { ...feature, dependencyReceipts: sources,
    fetchedAt: complete ? sources.map(r => r.fetchedAt).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) : null,
    sourceTimeStatus: complete ? 'RECEIPT_TIMES_RECORDED' : 'MISSING_RECEIPT_TIME',
    sourceTimeBasis: 'LATEST_DEPENDENCY_RECEIPT_NOT_PROVIDER_PUBLICATION',
  };
}

export function nestedSourceReceipts(value) {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(nestedSourceReceipts);
  const own = typeof value.sourceRecord === 'string' && 'fetchedAt' in value
    ? [{ sourceRecord: value.sourceRecord, fetchedAt: value.fetchedAt, rawPayloadHash: value.rawPayloadHash ?? null,
      fetchStatus: value.fetchStatus || (value.error ? 'FAILED' : 'RECORDED'), source: value.source || null }] : [];
  return [...own, ...Object.values(value).filter(v => v && typeof v === 'object').flatMap(nestedSourceReceipts)];
}
