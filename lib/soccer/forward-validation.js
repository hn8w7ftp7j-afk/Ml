import { createHash } from 'node:crypto';
import { soccerLeague, validSoccerDate, soccerDate, shiftSoccerDate } from './contracts.js';
import { buildSoccerProbabilityAudit, soccerProbabilityAuditFields } from './probability-audit.js';
import { soccerScoreLogProbability } from './score-model.js';

export const SOCCER_FORWARD_VERSION = 'SOCCER-PROSPECTIVE-SAVED-PREDICTION-v1';
export const SOCCER_FORWARD_POLICY = Object.freeze({
  version: SOCCER_FORWARD_VERSION,
  observation: 'FIRST_VALID_DATABASE_RECEIPT_PER_LEAGUE_GAME_PERIOD_MODEL_HASH',
  order: 'CAPTURE_SEQUENCE_ASCENDING_THEN_REVISION_ASCENDING',
  admission: 'PROTOCOL_ACTIVE_BEFORE_RUN_AND_DATABASE_CAPTURE_STRICTLY_BEFORE_KICKOFF',
  periods: ['REGULATION_FT', 'REGULATION_HT'],
  variants: ['BASELINE', 'PERSONNEL_CHALLENGER'],
  probabilityMassTolerance: 1e-10,
  resultEvidence: 'ESPN_TWO_ENDPOINT_CROSSCHECK_NOT_INDEPENDENT_OFFICIAL_CONFIRMATION',
  settledResultRecheckIntervalMs: 6 * 3600000,
  resultCheckDedupWindowMs: 3600000,
  resultCheckPriority: 'LEAST_RECENTLY_CHECKED_GAME_THEN_FIRST_CAPTURE_SEQUENCE',
  historicalBackfill: false, retrospective2025IsNewOos: false, promotionEligible: false,
});
const CLASSES = ['home', 'draw', 'away'];
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export const soccerForwardHash = value => createHash('sha256').update(canonical(value)).digest('hex');
// The existing analysis store intentionally hashes its canonical JSON STRING.
export const soccerForwardAnalysisRevision = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const hashValid = value => /^[a-f0-9]{64}$/.test(value || '');
const epoch = value => Date.parse(value);
const fail = reason => ({ ok: false, reason });

export function normalizeSoccerForwardScope(input = {}, now = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(Error('前瞻驗證查詢不正確。'), { status: 400 });
  const league = input.league == null ? null : soccerLeague(input.league)?.id;
  if (input.league != null && (league !== input.league || !league)) throw Object.assign(Error('足球聯盟不正確。'), { status: 400 });
  if (input.date != null && (input.from != null || input.through != null)) throw Object.assign(Error('單日與日期範圍請擇一。'), { status: 400 });
  const today = soccerDate(now), from = input.date ?? input.from ?? shiftSoccerDate(today, -30), through = input.date ?? input.through ?? today;
  if (![from, through].every(validSoccerDate) || through < from || epoch(through) - epoch(from) > 366 * 86400000)
    throw Object.assign(Error('前瞻驗證日期範圍最多 367 天。'), { status: 400 });
  return { league, from, through };
}

export const soccerForwardDistribution = capture => capture.variant === 'PERSONNEL_CHALLENGER' ? capture.snapshot?.personnelPrediction
  : capture.period === 'REGULATION_FT' ? capture.snapshot?.prediction : capture.snapshot?.halfTimePrediction;
export function soccerForwardModelDescriptor(snapshot, period, variant = 'BASELINE') {
  const prediction = soccerForwardDistribution({ snapshot, period, variant });
  const inputs = snapshot?.inputVersions || {};
  return { analysisVersion: snapshot?.version || null, period, variant, modelVersion: prediction?.modelVersion || null,
    trainingHash: prediction?.trainingHash || null, fullTimeTrainingHash: inputs.modelTrainingHash || null,
    researchArtifactHash: inputs.researchArtifactHash || null,
    halfTimeArtifactHash: period === 'REGULATION_HT' ? inputs.halfTimeArtifactHash || null : null,
    personnelArtifactHash: variant === 'PERSONNEL_CHALLENGER' ? snapshot?.personnelResearch?.artifactHash || null : null,
    personnelProtocolHash: variant === 'PERSONNEL_CHALLENGER' ? snapshot?.personnelResearch?.protocolHash || null : null,
    personnelTrainingHash: variant === 'PERSONNEL_CHALLENGER' ? snapshot?.personnelResearch?.trainingHash || null : null,
    personnelBaselineHash: variant === 'PERSONNEL_CHALLENGER' ? snapshot?.personnelResearch?.baselineHash || null : null };
}

function sourceValid(source, league, kind, gameId, cutoff) {
  try {
    const url = new URL(source.url), time = epoch(source.fetchedAt);
    return source.provider === 'ESPN' && hashValid(source.contentHash) && Number.isFinite(time) && time <= cutoff
      && url.protocol === 'https:' && url.hostname === 'site.api.espn.com' && !url.username && !url.password && !url.port && !url.hash
      && url.pathname === `/apis/site/v2/sports/soccer/${league.espnSlug}/${kind}`
      && (kind !== 'summary' || url.searchParams.get('event') === gameId.split(':').at(-1));
  } catch { return false; }
}

function probabilityReason(distribution, period) {
  if (!distribution || distribution.period !== period || !distribution.modelVersion || !hashValid(distribution.trainingHash)
    || !Array.isArray(distribution.cells) || !distribution.cells.length || distribution.cells.length > 100000) return 'FORWARD_DISTRIBUTION_UNVERIFIED';
  if (!['POISSON_DIXON_COLES', 'POISSON_DIXON_COLES_THINNED'].includes(distribution.distributionFamily)
    || period === 'REGULATION_HT' && distribution.distributionFamily !== 'POISSON_DIXON_COLES_THINNED'
    || period === 'REGULATION_FT' && distribution.distributionFamily !== 'POISSON_DIXON_COLES') return 'FORWARD_DISTRIBUTION_FAMILY_UNVERIFIED';
  const sums = { home: 0, draw: 0, away: 0 }, seen = new Set();
  for (const cell of distribution.cells) {
    if (![cell.home, cell.away].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 300)
      || !Number.isFinite(cell.probability) || cell.probability < 0 || cell.probability > 1 || seen.has(`${cell.home}:${cell.away}`)) return 'FORWARD_DISTRIBUTION_CELL_INVALID';
    seen.add(`${cell.home}:${cell.away}`);
    // Analytic log probability validates the archived numerical distribution.
    // Cells beyond the current exact-score scorer's input domain retain their
    // original mass and are still checked through the aggregate identities.
    if (cell.home <= 30 && cell.away <= 30) {
      try {
        const expected = Math.exp(soccerScoreLogProbability(cell.home, cell.away, distribution.homeRate, distribution.awayRate, distribution.rho));
        if (Math.abs(expected - cell.probability) > Math.max(1e-14, expected * 1e-9)) return 'FORWARD_DISTRIBUTION_PARAMETER_MISMATCH';
      } catch { return 'FORWARD_DISTRIBUTION_PARAMETER_INVALID'; }
    }
    sums[cell.home > cell.away ? 'home' : cell.home === cell.away ? 'draw' : 'away'] += cell.probability;
  }
  if (CLASSES.some(key => !Number.isFinite(distribution.outcomes?.[key]) || distribution.outcomes[key] < 0 || distribution.outcomes[key] > 1
    || Math.abs(distribution.outcomes[key] - sums[key]) > 1e-10)) return 'FORWARD_OUTCOME_MASS_MISMATCH';
  const retained = CLASSES.reduce((total, key) => total + sums[key], 0), tail = distribution.tailMass;
  if (![distribution.retainedMass, tail].every(value => Number.isFinite(value) && value >= 0 && value <= 1 + 1e-10)
    || Math.abs(retained - distribution.retainedMass) > 1e-10 || Math.abs(retained + tail - 1) > 1e-10) return 'FORWARD_PROBABILITY_MASS_UNVERIFIED';
  return tail > SOCCER_FORWARD_POLICY.probabilityMassTolerance ? 'FORWARD_OMITTED_MASS_EXCEEDS_TOLERANCE' : null;
}

// A DB receipt is evidence of when the saved prediction was available. Neither
// observedAt nor a historical source's publication label substitutes for it.
const compactCaptureProofs = new WeakMap();
const compactSnapshots = new WeakMap();
// Only full immutable originals can create these in-process summaries. A saved
// or HTTP `verified` flag is never a substitute for original revision checks.
export function compactSoccerForwardCapture(capture, protocol, now = Date.now()) {
  const checked = validateSoccerForwardCapture(capture, protocol, now), p = capture.snapshot || {};
  const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const distribution = value => value && Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'cells'));
  let snapshot = compactSnapshots.get(p);
  if(!snapshot){snapshot = Object.fromEntries(['version','league','gameId','date','runStartedAt','observedAt','analysisCutoff','status',
    'analysisStatus','qaFlag','formalScoringEnabled','executable','inputVersions','personnelResearch','unassignedQuotes'].map(key => [key,copy(p[key])]));
  snapshot.evidence = copy(p.evidence && {game:p.evidence.game,source:p.evidence.source,scheduleSource:p.evidence.scheduleSource,
    phase:p.evidence.phase,teams:Object.fromEntries(['home','away'].map(side=>[side,{lineup:p.evidence.teams?.[side]?.lineup}]))});
  for (const key of ['prediction','halfTimePrediction','personnelPrediction']) snapshot[key] = copy(distribution(p[key]));
  snapshot.personnelResearch = p.personnelResearch && Object.fromEntries(['artifactHash','protocolHash','trainingHash','baselineHash'].map(key=>[key,p.personnelResearch[key]??null]));
  snapshot.directions = (Array.isArray(p.directions)?p.directions:[]).map(direction => ({period:direction?.period,direction:direction?.direction,
    quotes:(Array.isArray(direction?.quotes)?direction.quotes:[]).map(quote=>copy(Object.fromEntries(['key','sourceQuoteKey','marketKey','period','kind','unit','line','lineSide','side','water','rawRows','provenance','fresh','prestart'].map(key=>[key,quote?.[key]??null]))))}));
  if(p&&typeof p==='object')compactSnapshots.set(p,snapshot);
  }
  const compact = {...capture,snapshot};
  const freeze = value => {if(value && typeof value==='object' && !Object.isFrozen(value)){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
  freeze(compact);
  compactCaptureProofs.set(compact,{protocolHash:soccerForwardHash(protocol),at:now,
    checked:checked.ok?{...checked,distribution:soccerForwardDistribution(compact)}:checked});
  return compact;
}
export function validateSoccerForwardCapture(capture, protocol, now = Date.now()) {
  const compact=compactCaptureProofs.get(capture);
  if(compact && compact.protocolHash===soccerForwardHash(protocol) && Number.isFinite(now) && now>=compact.at) return compact.checked;
  const p = capture?.snapshot, league = soccerLeague(capture?.league), game = p?.evidence?.game;
  if (!hashValid(capture?.captureId) || !/^[1-9]\d*$/.test(String(capture?.captureSequence || ''))) return fail('FORWARD_DATABASE_RECEIPT_UNVERIFIED');
  if (protocol?.version !== SOCCER_FORWARD_VERSION || soccerForwardHash(protocol.policy) !== soccerForwardHash(SOCCER_FORWARD_POLICY)) return fail('FORWARD_PROTOCOL_UNVERIFIED');
  if (!league || capture.league !== league.id || !validSoccerDate(p?.date) || !new RegExp(`^soccer:${league.id}:\\d{1,16}$`).test(capture.gameId || '')
    || p.league !== league.id || p.gameId !== capture.gameId || p.date !== capture.date || game?.id !== p.gameId || game.league !== league.id
    || game.date !== p.date || game.sourceId !== p.gameId.split(':').at(-1) || soccerDate(game.startTime) !== p.date) return fail('FORWARD_GAME_IDENTITY_INVALID');
  if (!['home', 'away'].every(side => /^\d{1,16}$/.test(game[side]?.sourceId || '')
    && game[side]?.id === `soccer:${league.id}:team:${game[side].sourceId}`) || game.home.id === game.away.id) return fail('FORWARD_TEAM_IDENTITY_INVALID');
  if (!hashValid(capture.revision) || soccerForwardAnalysisRevision(p) !== capture.revision) return fail('FORWARD_ORIGINAL_REVISION_MISMATCH');
  const times = { active: epoch(protocol.activatedAt), run: epoch(p.runStartedAt), cutoff: epoch(p.analysisCutoff), observed: epoch(p.observedAt),
    captured: epoch(capture.capturedAt), start: epoch(game.startTime) };
  if (!Object.values(times).every(Number.isFinite) || !Number.isFinite(now) || times.captured > now
    || times.run < times.active || times.run > times.cutoff || times.cutoff > times.observed || times.observed > times.captured)
    return fail('FORWARD_PERSISTENCE_TIME_UNVERIFIED');
  if (times.captured >= times.start) return fail('FORWARD_FIRST_CAPTURE_NOT_PREGAME');
  if (p.status !== 'RESEARCH_ONLY' || p.evidence?.phase !== 'PREMATCH_OBSERVATION' || game.status !== 'scheduled'
    || p.analysisStatus !== 'COMPLETED' || p.qaFlag === 'BLOCKED' || p.formalScoringEnabled !== false || p.executable !== false) return fail('FORWARD_NOT_A_PREMATCH_RESEARCH_SNAPSHOT');
  const scheduleSource = p.evidence.scheduleSource, scheduleVersion = p.inputVersions?.scheduleSourceVersion;
  if (!sourceValid(p.evidence.source, league, 'summary', p.gameId, times.cutoff)
    || !sourceValid(scheduleSource, league, 'scoreboard', p.gameId, times.cutoff)
    || times.cutoff - epoch(p.evidence.source.fetchedAt) > 180000
    || times.cutoff - epoch(scheduleSource?.fetchedAt) > 180000
    || p.inputVersions?.evidenceHash !== p.evidence.source.contentHash
    || p.inputVersions?.evidenceFetchedAt !== p.evidence.source.fetchedAt
    || ['provider', 'url', 'contentHash', 'fetchedAt'].some(key => scheduleVersion?.[key] !== scheduleSource?.[key]))
    return fail('FORWARD_INPUT_SOURCE_AVAILABILITY_UNVERIFIED');
  const descriptor = soccerForwardModelDescriptor(p, capture.period, capture.variant), distribution = soccerForwardDistribution(capture);
  if (!SOCCER_FORWARD_POLICY.variants.includes(capture.variant) || capture.variant === 'PERSONNEL_CHALLENGER' && capture.period !== 'REGULATION_FT') return fail('FORWARD_VARIANT_UNVERIFIED');
  if (capture.variant === 'PERSONNEL_CHALLENGER') {
    if (![descriptor.personnelArtifactHash, descriptor.personnelProtocolHash, descriptor.personnelTrainingHash, descriptor.personnelBaselineHash].every(hashValid)
      || descriptor.trainingHash !== descriptor.personnelTrainingHash || distribution?.baselineHash !== descriptor.personnelBaselineHash) return fail('FORWARD_PERSONNEL_MODEL_UNVERIFIED');
    const observation = distribution?.personnelObservation;
    if (distribution?.mode !== 'CURRENT_PREMATCH' || observation?.availability !== 'OBSERVED_PREMATCH_XI'
      || observation.sourceHash !== p.evidence.source.contentHash || observation.sourceUrl !== p.evidence.source.url
      || observation.fetchedAt !== p.evidence.source.fetchedAt) return fail('FORWARD_PERSONNEL_SOURCE_AVAILABILITY_UNVERIFIED');
    if (!['home', 'away'].every(side => {
      const lineup = p.evidence.teams?.[side]?.lineup;
      return lineup?.status === 'PROVIDER_REPORTED_XI' && lineup.starters?.length === 11
        && ['provider', 'url', 'contentHash', 'fetchedAt'].every(key => lineup.source?.[key] === p.evidence.source[key])
        && epoch(lineup.source?.fetchedAt) <= times.cutoff
        && new Set(lineup.starters.map(player => player.id)).size === 11
        && JSON.stringify(lineup.starters.map(player => player.id).sort()) === JSON.stringify([...(observation.startingXIs?.[side] || [])].sort());
    })) return fail('FORWARD_PERSONNEL_PREGAME_XI_UNVERIFIED');
  }
  if (!SOCCER_FORWARD_POLICY.periods.includes(capture.period) || !descriptor.modelVersion || !hashValid(descriptor.trainingHash)
    || !hashValid(descriptor.fullTimeTrainingHash) || !hashValid(descriptor.researchArtifactHash)
    || capture.period === 'REGULATION_HT' && !hashValid(descriptor.halfTimeArtifactHash)
    || capture.period === 'REGULATION_FT' && capture.variant === 'BASELINE' && descriptor.trainingHash !== descriptor.fullTimeTrainingHash
    || capture.modelHash !== soccerForwardHash(descriptor) || !(epoch(distribution?.trainedThrough) < times.run)) return fail('FORWARD_MODEL_VERSION_UNVERIFIED');
  const reason = probabilityReason(distribution, capture.period);
  return reason ? fail(reason) : { ok: true, descriptor, distribution, sourceAvailabilityBasis: 'OBSERVED_SERVER_FETCH_AND_IMMUTABLE_PREGAME_DATABASE_RECEIPT', rawSourceHashRecomputed: false };
}

const sequence = row => /^[1-9]\d*$/.test(String(row.captureSequence || '')) ? BigInt(row.captureSequence) : 0n;
export function canonicalSoccerForwardCaptures(captures, protocol, now = Date.now()) {
  const candidates = new Map(), excluded = [], superseded = [];
  const sorted = [...captures].sort((a, b) => sequence(a) < sequence(b) ? -1 : sequence(a) > sequence(b) ? 1 : String(a.revision).localeCompare(String(b.revision)));
  for (const capture of sorted) {
    const verified = validateSoccerForwardCapture(capture, protocol, now);
    if (!verified.ok) { excluded.push({ capture, reason: verified.reason }); continue; }
    const key = JSON.stringify([capture.league, capture.gameId, capture.period, capture.variant, capture.modelHash]);
    if (candidates.has(key)) { superseded.push({ capture, reason: 'FORWARD_LATER_VALID_REANALYSIS_NOT_SELECTED' }); continue; }
    candidates.set(key, capture);
  }
  return { chosen: [...candidates.values()], excluded, superseded };
}

export function evaluateSoccerForwardCapture(capture, protocol, result, now = Date.now()) {
  const verified = validateSoccerForwardCapture(capture, protocol, now), pending = reason => ({ status: 'PENDING', reason });
  if (!verified.ok) return pending(verified.reason);
  const p = capture.snapshot, game = p.evidence.game;
  if (!result?.ok || result.verified !== true || result.status !== 'NORMAL_FINAL_CROSSCHECKED') return pending(result?.reason || 'FORWARD_RESULT_UNVERIFIED');
  if (result.league !== capture.league || result.gameId !== capture.gameId || result.date !== p.date || result.startTime !== game.startTime
    || !['home', 'away'].every(side => result.teamIds?.[side] === game[side].id) || epoch(game.startTime) >= now) return pending('FORWARD_RESULT_SCOPE_MISMATCH');
  if (!hashValid(result.resultHash) || result.evidenceScope !== SOCCER_FORWARD_POLICY.resultEvidence || !Array.isArray(result.sources) || result.sources.length !== 2
    || !sourceValid(result.sources[0], soccerLeague(capture.league), 'summary', capture.gameId, now)
    || !sourceValid(result.sources[1], soccerLeague(capture.league), 'scoreboard', capture.gameId, now)
    || result.sources.some(source => epoch(source.fetchedAt) < epoch(game.startTime))) return pending('FORWARD_RESULT_SOURCES_UNVERIFIED');
  const score = capture.period === 'REGULATION_FT' ? result.fullTime : result.halfTime;
  if (!score) return pending(result.halfTimeMissingReason || 'FORWARD_HALF_TIME_RESULT_UNVERIFIED');
  if (score.period !== capture.period || capture.period === 'REGULATION_HT' && score.verified !== true
    || !['home', 'away'].every(side => Number.isSafeInteger(score[side]) && score[side] >= 0)
    || capture.period === 'REGULATION_HT' && !['home', 'away'].every(side => Number.isSafeInteger(result.fullTime?.[side]) && score[side] <= result.fullTime[side])) return pending('FORWARD_RESULT_PERIOD_OR_SCORE_INVALID');
  const actual = score.home > score.away ? 'home' : score.home === score.away ? 'draw' : 'away', d = verified.distribution;
  const probability = d.outcomes[actual], logLoss = probability === 0 ? null : -Math.log(probability);
  const brier = CLASSES.reduce((sum, key) => sum + (d.outcomes[key] - Number(key === actual)) ** 2, 0);
  let exact = null;
  try { exact = soccerScoreLogProbability(score.home, score.away, d.homeRate, d.awayRate, d.rho); } catch {}
  return { status: 'EVALUATED', version: SOCCER_FORWARD_VERSION, captureId: capture.captureId, captureSequence: String(capture.captureSequence),
    revision: capture.revision, league: capture.league, gameId: capture.gameId, eventId: game.sourceId, period: capture.period,
    modelHash: capture.modelHash, variant: capture.variant, modelVersion: d.modelVersion, modelDescriptor: verified.descriptor,
    capturedAt: capture.capturedAt, startTime: game.startTime, resultHash: result.resultHash, actualScore: { home: score.home, away: score.away },
    ...soccerProbabilityAuditFields(d, actual, exact),
    logLoss, logLossState: probability === 0 ? 'POSITIVE_INFINITY' : 'FINITE',
    logLossLowerBound: probability + d.tailMass === 0 ? null : -Math.log(probability + d.tailMass),
    brier, brierNumericalErrorBound: 2 * d.tailMass + d.tailMass ** 2,
    scoreLogLoss: exact === null ? null : -exact,
    evaluatedAt: new Date(now).toISOString(), resultEvidenceScope: result.evidenceScope,
    rawSourceHashRecomputed: false, strictHistoricalPit: false, formalEligible: false, promotionEligible: false, executable: false };
}

export function buildSoccerForwardReport({ captures = [], evaluations = [], checks = [], protocol, truncated = false, incompleteResultCaptureIds = [], readCoverage = null, now = Date.now() } = {}) {
  const selected = canonicalSoccerForwardCaptures(captures, protocol, now), byCapture = new Map(), conflicts = new Set(), incompleteHistories = new Set(incompleteResultCaptureIds);
  for (const evaluation of evaluations) {
    if (evaluation?.status !== 'EVALUATED' || evaluation.version !== SOCCER_FORWARD_VERSION) continue;
    const previous = byCapture.get(evaluation.captureId);
    if (previous && canonical({ score: previous.actualScore, outcome: previous.actualOutcome, revision: previous.revision, modelHash: previous.modelHash })
      !== canonical({ score: evaluation.actualScore, outcome: evaluation.actualOutcome, revision: evaluation.revision, modelHash: evaluation.modelHash })) conflicts.add(evaluation.captureId);
    else byCapture.set(evaluation.captureId, evaluation);
  }
  const grouped = new Map(), excludedReasons = {};
  for (const { reason } of selected.excluded) excludedReasons[reason] = (excludedReasons[reason] || 0) + 1;
  const groupFor = capture => {
    const key = JSON.stringify([capture.league, capture.period, capture.variant, capture.modelHash]);
    if (!grouped.has(key)) grouped.set(key, { league: capture.league, period: capture.period, modelHash: capture.modelHash,
      variant: capture.variant, modelVersion: soccerForwardModelDescriptor(capture.snapshot, capture.period, capture.variant).modelVersion, captures: [], evaluated: [], reasons: {},
      receivedSnapshotPeriods: 0, excludedSnapshotPeriods: 0, excludedReasons: {}, laterReanalysesNotSelected: 0 });
    return grouped.get(key);
  };
  for (const capture of captures) groupFor(capture).receivedSnapshotPeriods++;
  for (const { capture, reason } of selected.excluded) {
    const group = groupFor(capture); group.excludedSnapshotPeriods++; group.excludedReasons[reason] = (group.excludedReasons[reason] || 0) + 1;
  }
  for (const { capture } of selected.superseded) groupFor(capture).laterReanalysesNotSelected++;
  for (const capture of selected.chosen) {
    const group = groupFor(capture), evaluation = byCapture.get(capture.captureId);
    group.captures.push(capture);
    if (incompleteHistories.has(capture.captureId)) group.reasons.FORWARD_RESULT_HISTORY_READ_INCOMPLETE = (group.reasons.FORWARD_RESULT_HISTORY_READ_INCOMPLETE || 0) + 1;
    else if (conflicts.has(capture.captureId)) group.reasons.FORWARD_CONFLICTING_RESULT_EVIDENCE = (group.reasons.FORWARD_CONFLICTING_RESULT_EVIDENCE || 0) + 1;
    else if (evaluation && evaluation.revision === capture.revision && evaluation.modelHash === capture.modelHash && evaluation.period === capture.period && evaluation.variant === capture.variant && evaluation.league === capture.league
      && evaluation.gameId === capture.gameId && evaluation.captureSequence === String(capture.captureSequence)) group.evaluated.push(evaluation);
    else {
      const latest = checks.filter(check => check.captureId === capture.captureId).sort((a, b) => epoch(b.checkedAt) - epoch(a.checkedAt))[0];
      const reason = latest?.reason || (epoch(capture.snapshot.evidence.game.startTime) > now ? 'FORWARD_MATCH_NOT_STARTED' : 'FORWARD_RESULT_NOT_CHECKED');
      group.reasons[reason] = (group.reasons[reason] || 0) + 1;
    }
  }
  const groups = [...grouped.values()].map(group => {
    const { captures: members, evaluated, reasons, ...scope } = group, count = evaluated.length, infinities = evaluated.filter(row => row.logLossState === 'POSITIVE_INFINITY').length;
    const exact = evaluated.filter(row => Number.isFinite(row.scoreLogLoss));
    return { ...scope, capturedGames: members.length, evaluatedGames: count, pendingGames: members.length - count, pendingReasons: reasons,
      properScores: { count, brier: count ? evaluated.reduce((sum, row) => sum + row.brier, 0) / count : null,
        logLoss: count && !infinities ? evaluated.reduce((sum, row) => sum + row.logLoss, 0) / count : null,
        logLossState: !count ? 'NO_SAMPLES' : infinities ? 'POSITIVE_INFINITY' : 'FINITE', infiniteLogLossCount: infinities,
        scoreLogLoss: exact.length ? exact.reduce((sum, row) => sum + row.scoreLogLoss, 0) / exact.length : null,
        exactScoreCount: exact.length, exactScoreExcluded: count - exact.length, probabilitiesRenormalized: false },
      probabilityAudit: buildSoccerProbabilityAudit(evaluated, scope),
      observations: evaluated.map(row => ({ captureId: row.captureId, revision: row.revision, gameId: row.gameId, capturedAt: row.capturedAt,
        startTime: row.startTime, resultHash: row.resultHash, actualScore: row.actualScore, probabilities: row.probabilities,
        logLoss: row.logLoss, logLossState: row.logLossState, brier: row.brier, scoreLogLoss: row.scoreLogLoss })) };
  });
  return { version: SOCCER_FORWARD_VERSION, status: groups.some(group => group.evaluatedGames) ? 'FORWARD_OBSERVATIONS_AVAILABLE' : 'AWAITING_PROSPECTIVE_RESULTS',
    protocol: protocol || null, canonicalRule: SOCCER_FORWARD_POLICY, capturedSnapshotPeriods: captures.length,
    selectedGameModelPeriods: selected.chosen.length, excludedSnapshotPeriods: selected.excluded.length, excludedReasons,
    laterReanalysesNotSelected: selected.superseded.length, uniqueSelectedGames: new Set(selected.chosen.map(row => row.gameId)).size,
    evaluatedGameModelPeriods: groups.reduce((sum, group) => sum + group.evaluatedGames, 0), conflictingResultCaptures: conflicts.size,
    denominator: 'ONE_FIRST_VALID_PREGAME_DATABASE_CAPTURE_PER_GAME_PERIOD_MODEL; NOT_ALL_SCHEDULED_GAMES_OR_ALL_BETS',
    groups, truncated: truncated || incompleteHistories.size > 0, complete: !truncated && incompleteHistories.size === 0, readCoverage, readAt: new Date(now).toISOString(),
    interpretation: 'New predictions sealed before kickoff only. Retrospective 2025 diagnostics are not renamed fresh OOS. FT/HT and model versions remain separate; this report does not authorize or promote a model.',
    sourceLimitations: ['Normalized archived source hashes are preserved; raw provider bytes are not retained for independent hash recomputation.',
      'Postgame results are crosschecked across two ESPN endpoints, not independent governing-body confirmation.',
      'No guaranteed accuracy improvement, bookmaker settlement return or candidate score validation is implied.'],
    strictHistoricalPit: false, formalEligible: false, promotionEligible: false, executable: false };
}
