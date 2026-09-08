import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { modelValidationLink } from './model-validation-registry.js';
let artifact;
export function readReplayArtifact() {
  if (artifact) return artifact;
  try {
    const value = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.generated/replay-artifact.json'), 'utf8'));
    const raw = gunzipSync(Buffer.from(value.content, 'base64'), { maxOutputLength: 8_000_000 });
    if (createHash('sha256').update(raw).digest('hex') !== value.sourceSha256) throw new Error('Artifact hash mismatch');
    return artifact = value;
  } catch { return null; }
}
export function replayEnvironmentEvidence(analysis, league, versions = {}) {
  const sourceArtifact = readReplayArtifact();
  const settings = structuredClone(analysis.calculationSettings || null);
  return { version: 'REPLAY-ENVIRONMENT-EVIDENCE-v1', sourceArtifact,
    sourceStatus: sourceArtifact ? 'CONTENT_ARCHIVED' : 'BUILD_ARTIFACT_NOT_AVAILABLE',
    runtime: { name: 'node', version: process.version, versions: { ...process.versions }, platform: process.platform, arch: process.arch },
    dependencyStatus: sourceArtifact ? 'LOCK_ARCHIVED_BINARIES_NOT_ARCHIVED' : 'UNKNOWN',
    config: { calculationSettings: settings, configId: settings ? createHash('sha256').update(JSON.stringify(settings)).digest('hex') : null,
      scope: 'EXPLICIT_CALCULATION_SETTINGS_PLUS_FROZEN_CONTEXT_AND_ARCHIVED_CODE_CONSTANTS' },
    randomness: { status: 'NOT_APPLICABLE', method: 'DETERMINISTIC_ENUMERATION_AND_QUADRATURE', seed: null,
      scope: 'BASEBALL_SHARED_SCORE_ENGINE_ONLY' },
    modelValidation: modelValidationLink(league, versions.modelVersion || analysis.modelVersion || null),
    executionStatus: 'NOT_EXECUTED_FROM_ARCHIVE',
    note: '已保存來源內容不代表此環境已獨立啟動成功；依賴套件及執行器仍須可取得並核驗。' };
}
export function replayEnvironmentSummary(evidence) {
  if (!evidence) return { status: 'HISTORICAL_EVIDENCE_NOT_RECORDED', sourceArtifact: null, modelValidation: null };
  const { sourceArtifact, ...summary } = evidence;
  return { ...summary, sourceArtifact: sourceArtifact ? { ...sourceArtifact, content: undefined } : null };
}
