import { createHash } from 'node:crypto';

const immutableHashes = new WeakMap();

// Scenarios are JSON model outputs. Keep a private, immutable copy for one
// analysis, so the same study and score grids need hashing only once across
// its original quotes. Mutable caller objects always take the full hash path.
export function immutableSoccerScoringInput(value) {
  const snapshot = JSON.parse(JSON.stringify(value));
  function freeze(item) {
    if (item === null || typeof item !== 'object') return;
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
    immutableHashes.set(item, null);
  }
  freeze(snapshot);
  return snapshot;
}

export function isImmutableSoccerScoringInput(value) {
  return immutableHashes.has(value);
}

export function soccerScoringHash(value) {
  const cached = immutableHashes.get(value);
  if (cached) return cached;
  const canonical = JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
  const digest = createHash('sha256').update(canonical ?? 'null').digest('hex');
  if (cached === null) immutableHashes.set(value, digest);
  return digest;
}
