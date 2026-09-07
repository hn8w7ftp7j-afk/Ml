import * as current from './analysis-v11.js';
import { DATA_VERSION } from './snapshot-v9.js';
import * as original from './archives/mlb-v1100/lib/analysis-v11.js';
import { DATA_VERSION as ORIGINAL_DATA_VERSION } from './archives/mlb-v1100/lib/snapshot-v9.js';

const describe = (engine, dataVersion, archived = false) => ({
  modelVersion: engine.MODEL_VERSION, rulesVersion: engine.RULES_VERSION,
  dataVersion, distributionEngine: engine.DEFAULT_MODEL_CONFIG.engine, archived,
  revision: archived ? '53d2522cc47b0ebdbed069d8af3f1391eadcd40c' : null,
  build: engine.buildDistributionSnapshot, evaluate: engine.evaluateMarketsFromDistribution,
});
export const CURRENT_REPLAY_ENGINE = describe(current, DATA_VERSION);
const engines = [CURRENT_REPLAY_ENGINE, describe(original, ORIGINAL_DATA_VERSION, true)];
export function selectPitReplayEngine(modelVersion) {
  return engines.find(engine => engine.modelVersion === modelVersion) || null;
}
