export const ANALYSIS_DISPLAY_STATE_V116_VERSION = 'ANALYSIS-DISPLAY-STATE-v11.6.1';

const finite = value => value != null && value !== '' && Number.isFinite(Number(value));

function directionStatus(row) {
  const explicit = String(row?.status || row?.slotStatus || row?.directionStatus || '').trim().toUpperCase();
  if (explicit) return explicit;
  return [row?.modelEV, row?.modelEv, row?.rawWeightedEV, row?.weightedEV].some(finite)
    ? 'CALCULATED'
    : '';
}

function directionIdentity(row) {
  return String(row?.slotId || row?.directionKey || row?.id
    || `${row?.market || ''}|||${row?.pick || row?.direction || row?.side || ''}`);
}

export function analysisDisplayRows(value) {
  const analysis = value?.analysis || value || {};
  const slots = Array.isArray(analysis?.directionSlots) ? analysis.directionSlots
    : Array.isArray(analysis?.slots) ? analysis.slots
      : [];
  return slots.length ? slots : Array.isArray(analysis?.results) ? analysis.results : [];
}

export function analysisDisplayRowsForCard(value, { pitConfirmed = false } = {}) {
  const analysis = value?.analysis || value || {};
  const rows = analysisDisplayRows(analysis);
  const slots = Array.isArray(analysis?.directionSlots) ? analysis.directionSlots
    : Array.isArray(analysis?.slots) ? analysis.slots
      : [];
  if (slots.length) return rows;

  const readerRows = rows.filter(row => String(row?.sourceType || '').trim().toUpperCase() === 'ACTUAL_TW_CREDIT');
  if (readerRows.length) return readerRows;

  // Results saved before the eight-direction contract can still contain the
  // immutable calculated W/R/S rows without their newer sourceType field. A
  // confirmed PIT snapshot is sufficient to render those historical values,
  // but never to make them executable or eligible for a new bet.
  if (pitConfirmed && analysisHasCalculatedDirections(analysis)) {
    return rows.filter(row => directionStatus(row) === 'CALCULATED'
      || [row?.modelEV, row?.modelEv, row?.rawWeightedEV, row?.weightedEV].some(finite));
  }
  return readerRows;
}

export function analysisHasCalculatedDirections(value) {
  const analysis = value?.analysis || value || {};
  if (Number(analysis?.calculatedDirectionCount) > 0) return true;
  return analysisDisplayRows(analysis).some(row => directionStatus(row) === 'CALCULATED'
    || [row?.modelEV, row?.modelEv, row?.rawWeightedEV, row?.weightedEV].some(finite));
}

export function calculatedDirectionRows(value) {
  return analysisDisplayRows(value).filter(row => directionStatus(row) === 'CALCULATED'
    || [row?.modelEV, row?.modelEv, row?.rawWeightedEV, row?.weightedEV].some(finite));
}

function calculatedMarkets(value) {
  return new Set(calculatedDirectionRows(value)
    .map(row => String(row?.market || '').trim()).filter(Boolean));
}

function isReaderCoverageBlock(row) {
  return String(row?.integrityOrigin || '').toUpperCase() === 'SERVER_SIGNED_READER_COVERAGE'
    || String(row?.authorizationStatus || '').toUpperCase() === 'SERVER_ATTESTED_READER_COVERAGE_BLOCK'
    || String(row?.sourceTemplateVersion || '').toUpperCase() === 'TAI888-DOM-COVERAGE-BLOCK-V1.0.0';
}

export function readerMarketsHaveBlockingTransition(previousValue, incomingMarkets = []) {
  const previousMarkets = calculatedMarkets(previousValue);
  return previousMarkets.size > 0 && (Array.isArray(incomingMarkets) ? incomingMarkets : [])
    .some(row => previousMarkets.has(String(row?.market || '').trim()) && isReaderCoverageBlock(row));
}

export function analysisHasCalculatedToBlockedTransition(previousValue, incomingValue) {
  const previousMarkets = calculatedMarkets(previousValue);
  return previousMarkets.size > 0 && analysisDisplayRows(incomingValue)
    .some(row => directionStatus(row) === 'BLOCKED'
      && previousMarkets.has(String(row?.market || '').trim()));
}

export function readerMarketsLoseCalculatedCoverage(previousValue, incomingMarkets = []) {
  const previousMarkets = calculatedMarkets(previousValue);
  if (!previousMarkets.size) return false;
  const currentMarkets = new Set((Array.isArray(incomingMarkets) ? incomingMarkets : [])
    .map(row => String(row?.market || '').trim()).filter(Boolean));
  return [...previousMarkets].some(market => !currentMarkets.has(market));
}

export function analysisLosesCalculatedDirectionsToUnopened(previousValue, incomingValue) {
  const previous = calculatedDirectionRows(previousValue);
  if (!previous.length) return false;
  const incoming = new Map(analysisDisplayRows(incomingValue)
    .map(row => [directionIdentity(row), directionStatus(row)]));
  return previous.some(row => !incoming.has(directionIdentity(row))
    || incoming.get(directionIdentity(row)) === 'UNOPENED');
}

export function analysisIsUnopenedOnly(value) {
  const rows = analysisDisplayRows(value);
  return rows.length > 0
    && !analysisHasCalculatedDirections(value)
    && rows.every(row => directionStatus(row) === 'UNOPENED');
}

export function shouldPreserveCalculatedAnalysis(previousValue, incomingValue, incomingMarkets = []) {
  if (!analysisHasCalculatedDirections(previousValue)) return false;
  // Never splice rows from different joint score distributions. A mixed
  // BLOCKED + UNOPENED contraction keeps the previous immutable distribution
  // for history while the current coverage overlay exposes the true block and
  // the item hash is cleared. A complete new snapshot containing BLOCKED rows
  // still replaces the old result because none of its directions disappeared.
  return !Array.isArray(incomingMarkets)
    || incomingMarkets.length === 0
    || readerMarketsLoseCalculatedCoverage(previousValue, incomingMarkets)
    || analysisIsUnopenedOnly(incomingValue)
    || analysisLosesCalculatedDirectionsToUnopened(previousValue, incomingValue);
}

export function readerResultIsStale({ taskPayloadHash, livePayloadHash, liveBoardDate, targetDate } = {}) {
  const task = String(taskPayloadHash || '').trim();
  const live = String(livePayloadHash || '').trim();
  if (!task) return false;
  return !live
    || String(liveBoardDate || '').trim() !== String(targetDate || '').trim()
    || task !== live;
}

function readerEvidenceTime(value) {
  return Math.max(
    ...[value?.pageActivityAt, value?.observedAt, value?.receivedAt]
      .map(timestamp => Date.parse(timestamp || '')).filter(Number.isFinite),
    Number.NEGATIVE_INFINITY,
  );
}

export function readerEvidenceIsOlder(incomingSource, ...currentSources) {
  const incoming = readerEvidenceTime(incomingSource);
  const current = Math.max(...currentSources.map(readerEvidenceTime), Number.NEGATIVE_INFINITY);
  return Number.isFinite(incoming) && Number.isFinite(current) && incoming < current;
}
