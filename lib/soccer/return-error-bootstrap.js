import { soccerForwardHash } from './forward-validation.js';
import { SOCCER_RETURN_ERROR_CANDIDATE_PROTOCOL } from './return-error-model.js';
import { SOCCER_RETURN_ERROR_VALIDATION_VERSION, listActiveSoccerReturnErrorProtocols,
  registerSoccerReturnErrorProtocol, soccerReturnErrorDatabaseNow } from './return-error-validation-store.js';
import { soccerReturnErrorPlannedProtocol } from './return-error-plans.js';

export const SOCCER_RETURN_ERROR_BOOTSTRAP_VERSION = 'SOCCER-RETURN-ERROR-SERVER-PLAN-BOOTSTRAP-v1';
const restrictions = { accepted: false, formalEligible: false, promotionEligible: false, executable: false,
  W: null, R: null, S: null, empiricalErrorMargin: null };
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = code => { throw Error(code); };

function exactReceipt(receipt, expected, league, now) {
  const protocol = receipt?.protocol;
  if (receipt?.version !== SOCCER_RETURN_ERROR_VALIDATION_VERSION || receipt?.status !== 'DATABASE_PROSPECTIVE_PROTOCOL'
    || receipt.league !== league || protocol?.league !== league || !sha(receipt.protocolId)
    || !sha(receipt.protocolHash) || soccerForwardHash(protocol) !== receipt.protocolHash
    || receipt.registeredAt !== protocol.registeredAt || !Number.isFinite(Date.parse(receipt.registeredAt))
    || Date.parse(receipt.registeredAt) > now || !(Date.parse(receipt.registeredAt) < Date.parse(protocol.trainingBefore))
    || protocol.status !== 'REGISTERED_RESEARCH_ONLY' || receipt.accepted !== false
    || receipt.formalEligible !== false || receipt.promotionEligible !== false || receipt.executable !== false
    || ['W', 'R', 'S'].some(key => receipt[key] !== null))
    fail('RETURN_ERROR_BOOTSTRAP_RECEIPT_INVALID');
  const plan = { ...protocol, status: SOCCER_RETURN_ERROR_CANDIDATE_PROTOCOL.status, registeredAt: null };
  const planHash = soccerForwardHash(plan);
  if (receipt.protocolId !== soccerForwardHash([SOCCER_RETURN_ERROR_VALIDATION_VERSION, league, planHash]))
    fail('RETURN_ERROR_BOOTSTRAP_RECEIPT_INVALID');
  return planHash === soccerForwardHash(expected);
}

/** Only a fixed server plan enters this operation. HTTP callers cannot choose
 * dates, a protocol, a saved timestamp or approval. A timeout is unknown even
 * if the idempotent DB write later finishes; retry reads its original receipt. */
export async function bootstrapSoccerReturnErrorProtocol({ league, timeBudgetMs = 1500 } = {}, overrides = {}) {
  if (!['epl', 'ucl'].includes(league) || !Number.isSafeInteger(timeBudgetMs) || timeBudgetMs < 1 || timeBudgetMs > 5000)
    fail('RETURN_ERROR_BOOTSTRAP_SCOPE_INVALID');
  const manifest = soccerReturnErrorPlannedProtocol(league), expected = { ...SOCCER_RETURN_ERROR_CANDIDATE_PROTOCOL, ...manifest.plan };
  const base = { version: SOCCER_RETURN_ERROR_BOOTSTRAP_VERSION, league, manifestHash: manifest.manifestHash,
    planHash: soccerForwardHash(expected), plan: manifest.plan, configured: false, persisted: false, ...restrictions };
  const deps = { listProtocols: listActiveSoccerReturnErrorProtocols, register: registerSoccerReturnErrorProtocol,
    databaseNow: soccerReturnErrorDatabaseNow, wallNow: Date.now, ...overrides };
  const deadline = deps.wallNow() + timeBudgetMs;
  const checkBudget = () => { if (deps.wallNow() >= deadline) fail('RETURN_ERROR_BOOTSTRAP_TIMEOUT'); };
  const configured = (receipt, status) => ({ ...base, status, configured: true, persisted: true,
    protocolId: receipt.protocolId, protocolHash: receipt.protocolHash, registeredAt: receipt.registeredAt });
  let timer;
  try {
    return await Promise.race([(async () => {
      if (soccerForwardHash(SOCCER_RETURN_ERROR_CANDIDATE_PROTOCOL) !== manifest.protocolTemplateHash)
        fail('RETURN_ERROR_BOOTSTRAP_PROTOCOL_TEMPLATE_CHANGED');
      const [listed, now] = await Promise.all([deps.listProtocols({ league, limit: 100 }), deps.databaseNow()]);
      checkBudget();
      if (!Number.isFinite(now) || listed?.completeWithinRequestedScope !== true || !Array.isArray(listed.protocols))
        fail('RETURN_ERROR_BOOTSTRAP_EXISTING_SCOPE_UNVERIFIED');
      const matching = listed.protocols.filter(receipt => exactReceipt(receipt, expected, league, now));
      if (listed.protocols.length !== matching.length || matching.length > 1)
        return { ...base, status: 'PROTOCOL_CONFLICT', reason: 'RETURN_ERROR_BOOTSTRAP_EXISTING_PROTOCOL_CONFLICT' };
      // A genuine earlier registration continues after training closes. Do not
      // re-register it, move its calendar or replace its original DB timestamp.
      if (matching.length === 1) return configured(matching[0], 'ALREADY_REGISTERED_RESEARCH_ONLY');
      if (now >= Date.parse(expected.trainingBefore))
        return { ...base, status: 'REGISTRATION_CLOSED', reason: 'RETURN_ERROR_BOOTSTRAP_REGISTRATION_WINDOW_CLOSED' };
      checkBudget();
      const receipt = await deps.register(manifest.plan);
      checkBudget();
      const [readback, checkedAt] = await Promise.all([deps.listProtocols({ league, limit: 100 }), deps.databaseNow()]);
      checkBudget();
      if (!Number.isFinite(checkedAt) || readback?.completeWithinRequestedScope !== true || !Array.isArray(readback.protocols))
        fail('RETURN_ERROR_BOOTSTRAP_EXISTING_SCOPE_UNVERIFIED');
      if (!exactReceipt(receipt, expected, league, checkedAt)) fail('RETURN_ERROR_BOOTSTRAP_RECEIPT_INVALID');
      const exact = readback.protocols.filter(value => exactReceipt(value, expected, league, checkedAt));
      if (readback.protocols.length !== exact.length || exact.length !== 1)
        return { ...base, status: 'PROTOCOL_CONFLICT', reason: 'RETURN_ERROR_BOOTSTRAP_EXISTING_PROTOCOL_CONFLICT' };
      if (exact[0].protocolId !== receipt.protocolId || exact[0].registeredAt !== receipt.registeredAt
        || exact[0].protocolHash !== receipt.protocolHash) fail('RETURN_ERROR_BOOTSTRAP_RECEIPT_INVALID');
      return configured(exact[0], 'REGISTERED_RESEARCH_ONLY');
    })(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('RETURN_ERROR_BOOTSTRAP_TIMEOUT')), timeBudgetMs); })]);
  } catch (error) {
    const reason = /^RETURN_ERROR_[A-Z0-9_]{1,120}$/.test(error?.message || '')
      ? error.message : 'RETURN_ERROR_BOOTSTRAP_STORAGE_UNAVAILABLE';
    return { ...base, status: 'NOT_VERIFIED', reason };
  } finally { clearTimeout(timer); }
}
