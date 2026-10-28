import { createHash } from 'node:crypto';
import { acceptedSoccerRuntimeBundles as registeredScoringBundles } from './scoring-bundle-registry.js';

export const SOCCER_SCORING_BUNDLE_VERSION = 'SOCCER-TRUSTED-RUNTIME-INPUT-BUNDLE-v1';
export const SOCCER_SCORING_FACTORY_VERSION = 'SOCCER-REVIEWED-RUNTIME-INPUT-FACTORY-v1';
// Only reviewed server-owned artifacts may populate this registry. Request
// bodies, saved flags and research scenario fits cannot register a bundle.
// A registration contains the exact game/quote-specific materialized inputs.
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export const soccerScoringBundleHash = value => createHash('sha256').update(canonical(value) ?? 'null').digest('hex');
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const instant = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
const detached = value => JSON.parse(JSON.stringify(value));
const periods = { FT: 'REGULATION_FT', HT: 'REGULATION_HT' };
const failure = code => ({ version: SOCCER_SCORING_BUNDLE_VERSION, status: 'MISSING', code, reasons: [code], inputs: null, receipt: null });

// Hash only original quote identity, excluding the calculation/qualification
// fields later attached to that quote. JSONB key order is immaterial.
export function soccerScoringBundleContext({ quote, game, distribution, evidence } = {}) {
  const quoteIdentity = Object.fromEntries(['key', 'sourceQuoteKey', 'marketKey', 'period', 'kind', 'unit', 'line', 'lineSide', 'side', 'water', 'rawRows', 'provenance']
    .map(key => [key, quote?.[key] ?? null]));
  const gameIdentity = { id: game?.id, league: game?.league, date: game?.date, startTime: game?.startTime,
    sourceId: game?.sourceId, homeSourceId: game?.home?.sourceId, awaySourceId: game?.away?.sourceId, neutralSite: Boolean(game?.neutralSite) };
  return { league: game?.league, gameId: game?.id, period: quote?.period, sourceQuoteKey: quote?.key,
    modelVersion: distribution?.modelVersion, trainingHash: distribution?.trainingHash,
    gameHash: soccerScoringBundleHash(gameIdentity), quoteHash: soccerScoringBundleHash(quoteIdentity),
    distributionHash: soccerScoringBundleHash(distribution), evidenceHash: soccerScoringBundleHash(evidence) };
}

function sourceKnown(source, cutoff) {
  if (!source || !sha(source.contentHash) || typeof source.provider !== 'string' || !source.provider.trim()) return false;
  try { const url = new URL(source.url); if (url.protocol !== 'https:' || url.username || url.password) return false; } catch { return false; }
  const times = [source.sourcePublishedAt, source.fetchedAt, source.availableAt].map(instant);
  return times.every(time => Number.isFinite(time) && time <= cutoff) && times[0] <= times[1] && times[1] <= times[2];
}
function validInputs(inputs, context, availableAt) {
  if (!inputs || Object.keys(inputs).sort().join(',') !== 'acceptance,scenarios,uncertainty'
    || !Array.isArray(inputs.scenarios) || !inputs.scenarios.length || inputs.scenarios.length > 1000) return false;
  const { uncertainty, acceptance, scenarios } = inputs;
  if (!uncertainty || uncertainty.version !== 'SOCCER-EXPLICIT-SCENARIO-RETURNS-v1'
    || uncertainty.league !== context.league || uncertainty.period !== context.period
    || uncertainty.modelVersion !== context.modelVersion || uncertainty.trainingHash !== context.trainingHash
    || uncertainty.aggregation !== 'WEIGHTED_Q10_AND_EMPIRICAL_ERROR' || uncertainty.quantile !== .10
    || !Number.isFinite(instant(uncertainty.createdAt)) || instant(uncertainty.createdAt) > availableAt
    || !(instant(uncertainty.trainedThrough) < instant(uncertainty.createdAt))
    || uncertainty.scenariosHash !== soccerScoringBundleHash(scenarios)
    || !sha(uncertainty.artifactHash) || uncertainty.artifactHash !== soccerScoringBundleHash(Object.fromEntries(Object.entries(uncertainty).filter(([key]) => key !== 'artifactHash')))
    || !Number.isFinite(uncertainty.modelError?.value) || uncertainty.modelError.value < 0
    || uncertainty.modelError.unit !== 'NET_PROFIT_PER_1_STAKE' || !sha(uncertainty.modelError.validationArtifactHash)
    || !Number.isSafeInteger(uncertainty.modelError.validationSamples) || uncertainty.modelError.validationSamples <= 0
    || !sourceKnown(uncertainty.modelError.source, availableAt)) return false;
  for (const kind of ['model', 'calibration', 'uncertainty']) {
    const manifest = acceptance?.[kind];
    if (manifest?.status !== 'VERIFIED' || manifest.league !== context.league || manifest.period !== context.period
      || manifest.modelVersion !== context.modelVersion || manifest.trainingHash !== context.trainingHash
      || !sha(manifest.artifactHash) || !sourceKnown(manifest.source, availableAt)) return false;
  }
  if (acceptance.uncertainty.artifactHash !== uncertainty.artifactHash) return false;
  const seen = new Set();
  for (const scenario of scenarios) {
    if (typeof scenario?.id !== 'string' || !scenario.id || seen.has(scenario.id) || !Number.isFinite(scenario.weight) || scenario.weight <= 0
      || scenario.league !== context.league || scenario.gameId !== context.gameId || scenario.period !== context.period
      || scenario.modelVersion !== context.modelVersion || scenario.trainingHash !== context.trainingHash
      || scenario.distribution?.league !== context.league || scenario.distribution?.gameId !== context.gameId
      || scenario.distribution?.period !== periods[context.period] || scenario.distribution?.modelVersion !== context.modelVersion
      || scenario.distribution?.trainingHash !== context.trainingHash || !Array.isArray(scenario.sources) || !scenario.sources.length
      || scenario.sources.some(source => !sourceKnown(source, availableAt))) return false;
    seen.add(scenario.id);
  }
  return true;
}

function materializeFactory(factory, request, context, now, asOf) {
  const { generateInputs, registrationHash, ...registration } = factory;
  if (factory.version !== SOCCER_SCORING_FACTORY_VERSION || typeof generateInputs !== 'function'
    || !sha(registrationHash) || registrationHash !== soccerScoringBundleHash(registration)
    || !sha(factory.generatorSourceHash) || typeof factory.generatorVersion!=='string' || !factory.generatorVersion
    || typeof factory.factoryId !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/.test(factory.factoryId)
    || typeof factory.factoryVersion !== 'string' || !factory.factoryVersion)
    return { code: 'SOCCER_SCORING_BUNDLE_HASH_MISMATCH' };
  const created=instant(factory.createdAt),available=instant(factory.availableAt),from=instant(factory.validFrom),until=instant(factory.expiresAt);
  if (![created,available,from,until].every(Number.isFinite) || created>available || available>asOf || from>asOf || asOf>now)
    return { code: 'SOCCER_SCORING_BUNDLE_UNAVAILABLE_AT_CUTOFF' };
  if (!(until>now) || until<=from) return { code:'SOCCER_SCORING_BUNDLE_EXPIRED' };
  const refs=factory.artifactRefs,review=factory.reviewReceipt;
  if (!refs || ['modelArtifactHash','calibrationArtifactHash','uncertaintyValidationArtifactHash','scenarioProtocolHash'].some(key=>!sha(refs[key]))
    || review?.status!=='REVIEWED' || typeof review.evidenceRef!=='string' || !review.evidenceRef
    || !(instant(review.reviewedAt)<=available) || ['model','calibration','uncertaintyTemplate'].some(key=>!sha(review.manifestHashes?.[key])))
    return { code:'SOCCER_SCORING_BUNDLE_ARTIFACT_INVALID' };
  let inputs,repeat;
  try {
    // Reviewed source hash/version remain stable across Next/SWC transforms;
    // function.toString() is deliberately not an authorization mechanism.
    // The executable factory exists only in the reviewed server registry. Run
    // twice on detached identical context to reject random/mutating factories.
    inputs=generateInputs(detached({...request,now:asOf}));
    repeat=generateInputs(detached({...request,now:asOf}));
    if (soccerScoringBundleHash(inputs)!==soccerScoringBundleHash(repeat) || !validInputs(inputs,context,asOf)
      || instant(inputs.uncertainty.createdAt)!==asOf
      || inputs.acceptance.model.artifactHash!==refs.modelArtifactHash
      || inputs.acceptance.calibration.artifactHash!==refs.calibrationArtifactHash
      || inputs.uncertainty.modelError.validationArtifactHash!==refs.uncertaintyValidationArtifactHash
      || soccerScoringBundleHash(inputs.acceptance.model)!==review.manifestHashes.model
      || soccerScoringBundleHash(inputs.acceptance.calibration)!==review.manifestHashes.calibration
      || soccerScoringBundleHash(Object.fromEntries(Object.entries(inputs.acceptance.uncertainty).filter(([key])=>key!=='artifactHash')))!==review.manifestHashes.uncertaintyTemplate)
      return { code:'SOCCER_SCORING_BUNDLE_ARTIFACT_INVALID' };
  } catch { return { code:'SOCCER_SCORING_BUNDLE_ARTIFACT_INVALID' }; }
  const at=new Date(asOf).toISOString(),body={version:SOCCER_SCORING_BUNDLE_VERSION,
    bundleId:`${factory.factoryId}:${factory.factoryVersion}`,...context,
    createdAt:at,availableAt:at,validFrom:at,expiresAt:new Date(Math.min(asOf+180000,until,instant(request.game.startTime))).toISOString(),
    inputs,inputsHash:soccerScoringBundleHash(inputs),factoryId:factory.factoryId,factoryVersion:factory.factoryVersion,
    factoryRegistrationHash:registrationHash,artifactRefs:refs,reviewReceipt:review};
  return { bundle:{...body,bundleHash:soccerScoringBundleHash(body)} };
}

export function resolveSoccerScoringBundle({ quote, game, distribution, evidence, now = Date.now(), asOf = now } = {}) {
  const context = soccerScoringBundleContext({ quote, game, distribution, evidence });
  asOf=typeof asOf==='string'?instant(asOf):asOf;
  if (!Number.isFinite(now) || !['epl', 'ucl'].includes(context.league) || !Object.hasOwn(periods, context.period)
    || game?.id !== `soccer:${game.league}:${game.sourceId}` || game.status !== 'scheduled' || !(instant(game.startTime) > now)
    || !sha(context.sourceQuoteKey) || !sha(context.trainingHash) || typeof context.modelVersion !== 'string' || !context.modelVersion
    || distribution?.league !== game.league || distribution?.gameId !== game.id || distribution?.period !== periods[context.period])
    return failure('SOCCER_SCORING_BUNDLE_CONTEXT_MISMATCH');
  if (!Number.isFinite(asOf) || asOf>now || [quote?.provenance?.observedAt,quote?.provenance?.firstFetchedAt,quote?.provenance?.receivedAt,
    quote?.provenance?.persistedAt,evidence?.source?.fetchedAt].some(time=>!Number.isFinite(instant(time))||instant(time)>asOf))
    return failure('SOCCER_SCORING_BUNDLE_UNAVAILABLE_AT_CUTOFF');
  const candidates = registeredScoringBundles.filter(bundle => !bundle?.factoryVersion
    && ['league', 'gameId', 'period', 'sourceQuoteKey', 'modelVersion', 'trainingHash'].every(key => bundle?.[key] === context[key]));
  const factories=registeredScoringBundles.filter(factory=>factory?.factoryVersion
    && ['league','period','modelVersion','trainingHash'].every(key=>factory[key]===context[key]));
  const factoryFailures=[];
  for(const factory of factories){
    const built=materializeFactory(factory,{quote,game,distribution,evidence},context,now,asOf);
    if(built.bundle)candidates.push(built.bundle);else factoryFailures.push(built.code);
  }
  if (!candidates.length && factoryFailures.length) return failure(factoryFailures[0]);
  if (!candidates.length) return failure('SOCCER_SCORING_BUNDLE_MISSING');
  if (candidates.length !== 1) return failure('SOCCER_SCORING_BUNDLE_AMBIGUOUS');
  const bundle = candidates[0], { bundleHash, ...body } = bundle;
  if (bundle.version !== SOCCER_SCORING_BUNDLE_VERSION || !sha(bundleHash) || bundleHash !== soccerScoringBundleHash(body)
    || !sha(bundle.inputsHash) || bundle.inputsHash !== soccerScoringBundleHash(bundle.inputs)) return failure('SOCCER_SCORING_BUNDLE_HASH_MISMATCH');
  if (['gameHash', 'quoteHash', 'distributionHash', 'evidenceHash'].some(key => bundle[key] !== context[key]))
    return failure('SOCCER_SCORING_BUNDLE_CONTEXT_MISMATCH');
  const created = instant(bundle.createdAt), available = instant(bundle.availableAt), from = instant(bundle.validFrom), until = instant(bundle.expiresAt);
  if (![created, available, from, until].every(Number.isFinite) || created > available || available > now || from > now)
    return failure('SOCCER_SCORING_BUNDLE_UNAVAILABLE_AT_CUTOFF');
  if (!(until > now) || until > instant(game.startTime) || until <= from)
    return failure('SOCCER_SCORING_BUNDLE_EXPIRED');
  if (typeof bundle.bundleId !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/.test(bundle.bundleId)
    || !validInputs(bundle.inputs, context, available)) return failure('SOCCER_SCORING_BUNDLE_ARTIFACT_INVALID');
  const receipt = { version: SOCCER_SCORING_BUNDLE_VERSION, status: 'AVAILABLE', code: 'SOCCER_SCORING_BUNDLE_AVAILABLE',
    bundleId: bundle.bundleId, bundleHash, inputsHash: bundle.inputsHash, ...context,
    ...(bundle.factoryId?{factoryId:bundle.factoryId,factoryVersion:bundle.factoryVersion,factoryRegistrationHash:bundle.factoryRegistrationHash,
      artifactRefs:detached(bundle.artifactRefs),reviewReceipt:detached(bundle.reviewReceipt)}:{}),
    createdAt: bundle.createdAt, availableAt: bundle.availableAt, validFrom: bundle.validFrom, expiresAt: bundle.expiresAt };
  return { version: SOCCER_SCORING_BUNDLE_VERSION, status: 'AVAILABLE', code: receipt.code, reasons: [], inputs: detached(bundle.inputs), receipt };
}

// Current registry authority must still contain the exact original bundle.
// A saved calculation cannot substitute its own scenarios/manifests or survive
// revocation/expiry by retaining a formerly VERIFIED flag.
export function revalidateSoccerScoringBundle({ saved, ...context } = {}) {
  const receipt = saved?.inputBundle;
  const resolved = resolveSoccerScoringBundle({...context,asOf:receipt?.factoryId?receipt.createdAt:context.now});
  if (!resolved.inputs || receipt?.status !== 'AVAILABLE'
    || soccerScoringBundleHash(receipt) !== soccerScoringBundleHash(resolved.receipt)
    || soccerScoringBundleHash(saved.calculationInputs) !== resolved.receipt.inputsHash)
    return { ok: false, code: 'SOCCER_SCORING_BUNDLE_REVOKED_OR_CHANGED', resolutionCode: resolved.code, inputs: null };
  return { ok: true, code: resolved.code, inputs: resolved.inputs, receipt: resolved.receipt };
}
