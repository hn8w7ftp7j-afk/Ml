import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_key,item) => item && typeof item==='object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])) : item);

/** Preserve the serialized provider-data bytes that fetchSoccerJson hashed.
 * JSONB reorders object keys; a retained string does not. No new hash replaces
 * the original source hash and no unordered fallback approves legacy data. */
export function retainSoccerProviderDocument(document) {
  if (!document?.ok || !document.data) return document;
  const retainedJson=JSON.stringify(document.data);
  if (hash(retainedJson)!==document.source?.contentHash) return document;
  return {...document,retainedJson};
}

export function soccerProviderDocumentHashValid(document) {
  if (!document?.data || typeof document.data!=='object' || Array.isArray(document.data)
    || !/^[a-f0-9]{64}$/.test(document.source?.contentHash||'')) return false;
  if (document.retainedJson===undefined) return hash(JSON.stringify(document.data))===document.source.contentHash;
  if (typeof document.retainedJson!=='string' || document.retainedJson.length>4*1024*1024
    || hash(document.retainedJson)!==document.source.contentHash) return false;
  try { return canonical(JSON.parse(document.retainedJson))===canonical(document.data); }
  catch { return false; }
}
