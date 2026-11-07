import { createHash } from 'node:crypto';
import { soccerDate, soccerLeague, validSoccerDate } from './contracts.js';
import { soccerShotXgResearchArtifacts } from './shot-xg-frozen.js';

export const SOCCER_SHOT_XG_VIEW_VERSION = 'SOCCER-SHOT-XG-RESEARCH-VIEW-v1';
const version = 'SOCCER-WYSCOUT-XY-SHOT-RESEARCH-v1';
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const instant = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
const sealed = value => {
  try {
    if (!value || typeof value !== 'object' || !/^[a-f0-9]{64}$/.test(value.contentHash || '')) return false;
    const { contentHash, ...body } = value;
    return hash(body) === contentHash;
  } catch { return false; }
};
const restricted = value => ['accepted', 'formalEligible', 'calibrationEligible', 'promotionEligible', 'modelEffectApplied', 'executable']
  .every(key => value?.[key] === false) && ['W', 'R', 'S'].every(key => value?.[key] === null);
const restrictions = { accepted: false, formalEligible: false, calibrationEligible: false,
  promotionEligible: false, modelEffectApplied: false, executable: false, currentSeasonModelApplied: false,
  W: null, R: null, S: null };

/** Snapshot-bound display of an older research cohort. This does not produce
 * current match xG, source authority, scorer inputs or acceptance registrations.
 * Old saved analyses are never enriched when read: only a new analysis owns
 * this projection at its unchanged calculation cutoff. */
export function shotXgResearchForGame(game, { now = Date.now(), artifacts } = {}) {
  if (!soccerLeague(game?.league) || typeof game.sourceId !== 'string' || !/^\d{1,16}$/.test(game.sourceId)
    || game.id !== `soccer:${game.league}:${game.sourceId}` || !validSoccerDate(game.date)
    || !Number.isFinite(instant(game.startTime)) || soccerDate(game.startTime) !== game.date
    || !Number.isFinite(now) || Math.abs(now) > 8.64e15
    || !['home', 'away'].every(side => typeof game[side]?.sourceId === 'string' && /^\d{1,16}$/.test(game[side].sourceId))
    || game.home.sourceId === game.away.sourceId) return null;
  const base = { version: SOCCER_SHOT_XG_VIEW_VERSION, league: game.league, gameId: game.id,
    gameContext: { sourceId: game.sourceId, date: game.date, startTime: game.startTime,
      homeSourceId: game.home.sourceId, awaySourceId: game.away.sourceId },
    analysisCutoff: new Date(now).toISOString(), report: null, artifact: null, ...restrictions };
  const result = (status, extra = {}) => ({ ...base, status, ...extra });
  let trusted;
  try { trusted = soccerShotXgResearchArtifacts(); artifacts = artifacts === undefined ? trusted : artifacts; }
  catch { return result('ARTIFACT_INVALID'); }
  // The optional copy is useful for immutable-view integrity checks, never a
  // caller-supplied replacement artifact or a way to backdate availability.
  if (!sealed(artifacts) || artifacts.contentHash !== trusted?.contentHash
    || artifacts.version !== version || artifacts.provider !== 'WYSCOUT_OPEN_DATA'
    || !restricted(artifacts) || !Number.isFinite(instant(artifacts.createdAt))) return result('ARTIFACT_INVALID');
  if (instant(artifacts.createdAt) > now) return result('NOT_AVAILABLE_AT_CUTOFF');
  const metadata = { version: artifacts.version, contentHash: artifacts.contentHash, createdAt: artifacts.createdAt };
  const report = artifacts.reports?.[game.league];
  if (!report) return result('NO_LEAGUE_COHORT', { artifact: metadata });
  if (!sealed(report) || report.version !== version || report.type !== 'AGGREGATE_SHOT_XG_RESEARCH_REPORT'
    || report.provider !== 'WYSCOUT_OPEN_DATA' || report.league !== game.league || report.synthetic !== false
    || report.sourceAuthenticationVerified !== true || !restricted(report)
    || report.rawRowsIncluded !== false || report.fittedCoefficientsIncluded !== false
    || !Number.isFinite(instant(report.createdAt)) || !Number.isFinite(instant(report.availableAt))
    || instant(report.availableAt) > instant(report.createdAt) || instant(report.createdAt) > instant(artifacts.createdAt))
    return result('ARTIFACT_INVALID');
  return result('RESEARCH_AVAILABLE', { artifact: metadata, report: structuredClone(report) });
}
