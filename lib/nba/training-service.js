import { durableDatabaseUrl } from '../database-url.js';
import { defaultTraining } from './analysis-training.js';
import { loadNbaLiveHistory } from './live-history-store.js';
import { buildLiveNbaTraining } from './live-training.js';

// A database/source failure is not an empty new season. Never conceal it by
// silently switching a production prediction to the frozen research archive.
export async function loadNbaTrainingContext(game, { now = Date.now, list = loadNbaLiveHistory, configured = Boolean(durableDatabaseUrl()) } = {}) {
  if (!configured) return { status: 'archive_only', trainingData: defaultTraining,
    provenance: { status: 'not_configured', liveGames: 0, strictPointInTime: false } };
  try {
    const rows = await list({ beforeDate: game.taipeiDate });
    const result = buildLiveNbaTraining(rows, { beforeDate: game.taipeiDate, seasonYear: game.season.year,
      now: Number(typeof now === 'function' ? now() : now) });
    return { status: 'ready', ...result };
  } catch {
    return { status: 'unavailable', provenance: { status: 'unavailable', strictPointInTime: false },
      issue: { code: 'NBA_LIVE_TRAINING_UNAVAILABLE', message: '永久歷史資料暫時無法核對，未以凍結舊資料代替本次更新。' } };
  }
}
