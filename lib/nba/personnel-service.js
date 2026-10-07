import { loadNbaData } from './data.js';
import { buildNbaPregame } from './pregame-store.js';
import { buildNbaPersonnelEvidence, nbaPersonnelSnapshotInputs, validNbaPersonnelTarget } from './personnel-evidence.js';
import { loadTargetNbaInjuries } from './target-injuries.js';

/**
 * loadGame/loadInjuries use the loadNbaData(query, options) signature.
 * Saving is opt-in via a server-owned saveSnapshot(payload) callback. Client
 * timestamps, reported names and inferred minutes are never accepted here.
 */
export async function loadNbaPersonnelEvidence(game, {
  now = Date.now, loadGame = loadNbaData, loadInjuries = null, saveSnapshot = null, timeoutMs = 6000,
} = {}) {
  const clock = () => Number(typeof now === 'function' ? now() : now);
  const sourceTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 20000) : 6000;
  if (!validNbaPersonnelTarget(game, clock())) return buildNbaPersonnelEvidence(game, null, null, clock());
  const results = await Promise.allSettled([
    loadGame({ view: 'game', id: game.sourceId }, { now: clock, timeoutMs: sourceTimeout }),
    typeof loadInjuries === 'function'
      ? loadInjuries({ view: 'injuries' }, { now: clock, timeoutMs: sourceTimeout })
      : loadTargetNbaInjuries(game, { now: clock, timeoutMs: sourceTimeout }),
  ]);
  const [gameResult, injuryResult] = results.map(result => result.status === 'fulfilled' ? result.value : null);
  const capturedAt = clock();
  const evidence = buildNbaPersonnelEvidence(game, gameResult, injuryResult, capturedAt);
  evidence.persistence = { persisted: false, status: typeof saveSnapshot === 'function' ? 'not_capture_eligible' : 'not_requested' };
  const inputs = nbaPersonnelSnapshotInputs(evidence, gameResult, injuryResult);
  if (inputs && typeof saveSnapshot === 'function') {
    try {
      const { persistence, ...capturedEvidence } = evidence;
      const snapshot = { ...buildNbaPregame(inputs.gameResult, inputs.injuryResult, capturedAt),
        lineupStatus: evidence.coverage.lineups, injuryStatus: evidence.coverage.injuries,
        personnelEvidence: capturedEvidence };
      if (!validNbaPersonnelTarget(game, clock())) {
        evidence.persistence = { persisted: false, status: 'capture_window_closed' }; return evidence;
      }
      const receipt = await saveSnapshot(snapshot);
      const receiptTime = Date.parse(receipt?.capturedAt || '');
      if (receipt?.persisted !== true || !/^[a-f0-9]{64}$/.test(receipt.revision || '')
        || !Number.isFinite(receiptTime) || receiptTime > capturedAt || receiptTime >= Date.parse(game.startTime)) {
        evidence.persistence = { persisted: false, status: 'receipt_unverified' };
      } else evidence.persistence = { persisted: true, status: 'saved', revision: receipt.revision,
        capturedAt: receipt.capturedAt, inserted: receipt.inserted === true };
    } catch {
      evidence.persistence = { persisted: false, status: 'save_failed' };
    }
  }
  return evidence;
}
