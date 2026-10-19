// Client-safe projection validation. Direction summaries never authorize quotes.
export const SOCCER_CANDIDATE_PROJECTION_VERSION = 'SOCCER-QUOTE-CURRENT-QUALIFICATION-v1';
const finite = x => typeof x === 'number' && Number.isFinite(x);
const sha = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const instant = x => typeof x === 'string' ? Date.parse(x) : NaN;
const fresh = (x, now) => Number.isFinite(instant(x)) && instant(x) <= now && now - instant(x) < 180000;
const canonical = x => JSON.stringify(x, (_k, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const same = (a, b) => canonical(a) === canonical(b);
const sequence = x => typeof x === 'string' && /^\d+$/.test(x) || Number.isSafeInteger(x) && x >= 0;
const qualified = c => c?.formalScoringEnabled === true && c.calculationEligible === true && c.executable === false
  && c.status === 'FORMAL_CALCULATED_AWAITING_PUBLICATION' && c.unit === 'NET_PROFIT_PER_1_STAKE'
  && finite(c.score) && c.S === c.score && c.score >= 7.2 && finite(c.W) && c.W > 0 && finite(c.R) && c.R > 0;

export function soccerQuoteIdentity(q) {
  if (!q) return null;
  return Object.fromEntries(['key', 'sourceQuoteKey', 'marketKey', 'period', 'kind', 'unit', 'line', 'lineSide', 'side',
    'water', 'rawRows', 'provenance'].map(k => [k, q[k] ?? null]));
}
export function soccerCandidateReceiptCurrent(s, r, now = Date.now()) {
  const g = s?.evidence?.game;
  return Boolean(finite(now) && s?.persisted === true && s.publishedCurrent === true && s.executable === false
    && s.analysisStatus === 'COMPLETED' && s.selectionResult === 'RESEARCH_SHADOW' && ['PASS', 'WARN'].includes(s.qaFlag)
    && ['epl', 'ucl'].includes(s.league) && g?.id === s.gameId && g.league === s.league && g.date === s.date
    && g.status === 'scheduled' && instant(g.startTime) > now && fresh(s.observedAt, now)
    && sha(s.revision) && typeof s.analysisRunId === 'string' && s.analysisRunId.length >= 8
    && sequence(s.qualificationVersion) && BigInt(s.qualificationVersion) > 0n && sequence(s.quoteGeneration)
    && r?.publishedCurrent === true && r.reason === 'ACTIVE' && r.analysisStatus === 'COMPLETED'
    && r.selectionResult === 'RESEARCH_SHADOW' && r.executable === false && r.revision === s.revision
    && r.analysisRunId === s.analysisRunId && String(r.qualificationVersion) === String(s.qualificationVersion)
    && String(r.quoteGeneration) === String(s.quoteGeneration) && fresh(r.checkedAt, now)
    && instant(r.validUntil) > now && instant(s.validUntil) > now);
}
function scope(s, d, q, now) {
  const sides = { HANDICAP_HOME: 'home', HANDICAP_AWAY: 'away', TOTAL_OVER: 'over', TOTAL_UNDER: 'under' };
  return Boolean(Object.hasOwn(sides, d?.direction) && ['FT', 'HT'].includes(d.period) && d.qaFlag !== 'BLOCKED'
    && q?.period === d.period && q.side === sides[d.direction] && q.kind === (d.direction.startsWith('TOTAL') ? 'TOTAL' : 'HANDICAP')
    && q.unit === 'GOALS' && sha(q.key) && q.sourceQuoteKey === q.key && q.provenance?.gameId === s.gameId
    && q.fresh === true && q.prestart === true && finite(q.water) && q.water > 0 && fresh(q.provenance.observedAt, now));
}
function expiry(s, r, q) {
  return Math.min(instant(s.validUntil), instant(r.validUntil), instant(s.observedAt) + 180000,
    instant(q.provenance.observedAt) + 180000, instant(s.evidence.game.startTime));
}
export function soccerQuoteCandidateCurrent(s, d, q, { currentStatus = s?.currentResearch, now = Date.now() } = {}) {
  const a = q?.qualification, c = q?.scoring;
  return Boolean(s?.candidateProjectionVersion === SOCCER_CANDIDATE_PROJECTION_VERSION && soccerCandidateReceiptCurrent(s, currentStatus, now)
    && scope(s, d, q, now) && qualified(c) && a?.status === 'AUTHORIZED_CURRENT' && a.eligible === true && q.eligible === true
    && a.sourceQuoteKey === q.key && same(a.quoteIdentity, soccerQuoteIdentity(q)) && a.analysisRevision === s.revision
    && a.analysisRunId === s.analysisRunId && String(a.qualificationVersion) === String(s.qualificationVersion)
    && String(a.quoteGeneration) === String(s.quoteGeneration) && a.gameId === s.gameId && a.league === s.league
    && a.date === s.date && a.period === d.period && a.direction === d.direction && a.checkedAt === currentStatus.checkedAt
    && instant(a.validUntil) === expiry(s, currentStatus, q) && instant(a.validUntil) > now
    && a.score === c.score && a.W === c.W && a.R === c.R && a.distributionHash === c.provenance?.distributionHash);
}
export function projectSoccerCandidates(s, { currentStatus = null, validatedCalculations = null, now = Date.now() } = {}) {
  const current = soccerCandidateReceiptCurrent(s, currentStatus, now);
  const directions = (Array.isArray(s?.directions) ? s.directions : []).map(d => {
    const quotes = (Array.isArray(d?.quotes) ? d.quotes : []).map(q => {
      const c = validatedCalculations instanceof Map ? validatedCalculations.get(q?.key)
        : validatedCalculations && Object.hasOwn(validatedCalculations, q?.key) ? validatedCalculations[q.key] : null;
      const p = c?.conditionalPayoff?.quote;
      const accepted = current && scope(s, d, q, now) && qualified(c) && qualified(q.scoring)
        && c.sourceQuoteKey === q.key && c.gameId === s.gameId && c.league === s.league && c.period === q.period
        && c.score === q.scoring.score && c.W === q.scoring.W && c.R === q.scoring.R
        && c.provenance?.quoteHash === q.key && sha(c.provenance.distributionHash) && fresh(c.provenance.calculatedAt, now)
        && c.conditionalPayoff?.ok === true && p?.period === q.period && p.kind === q.kind && p.direction === q.side.toUpperCase()
        && p.sourceLine === q.line && (p.lineSide ?? null) === (q.lineSide ?? null) && p.water === q.water;
      const qualification = accepted ? { status: 'AUTHORIZED_CURRENT', eligible: true, sourceQuoteKey: q.key,
        quoteIdentity: soccerQuoteIdentity(q), gameId: s.gameId, league: s.league, date: s.date, period: d.period, direction: d.direction,
        analysisRevision: s.revision, analysisRunId: s.analysisRunId, qualificationVersion: String(s.qualificationVersion),
        quoteGeneration: String(s.quoteGeneration), checkedAt: currentStatus.checkedAt,
        validUntil: new Date(expiry(s, currentStatus, q)).toISOString(), score: c.score, W: c.W, R: c.R,
        distributionHash: c.provenance.distributionHash } : { status: current ? 'NOT_AUTHORIZED' : 'NOT_CURRENT', eligible: false };
      return { ...q, qualification, eligible: Boolean(accepted), executable: false };
    });
    const selected = quotes.filter(q => q.eligible).sort((a, b) => b.qualification.score - a.qualification.score
      || b.qualification.W - a.qualification.W || b.qualification.R - a.qualification.R || a.key.localeCompare(b.key))[0];
    return { ...d, quotes, quote: selected || null, selectedQuoteKey: selected?.key || null,
      score: selected?.qualification.score ?? null, W: selected?.qualification.W ?? null,
      R: selected?.qualification.R ?? null, eligible: Boolean(selected), executable: false };
  });
  const accepted = directions.flatMap(d => d.quotes).filter(q => q.eligible);
  return { ...s, directions, currentResearch: currentStatus, candidateProjectionVersion: SOCCER_CANDIDATE_PROJECTION_VERSION,
    formalScoringEnabled: accepted.length > 0, executable: false,
    qualification: { status: accepted.length ? 'AUTHORIZED_CURRENT' : 'NOT_AUTHORIZED', eligible: accepted.length > 0,
      validUntil: accepted.length ? new Date(Math.min(...accepted.map(q => instant(q.qualification.validUntil)))).toISOString() : null } };
}
export function soccerCandidatePayloadValid(s, now = Date.now()) {
  if (!s || s.executable !== false || !Array.isArray(s.directions)
    || s.directions.some(d => !d || d.executable !== false
      || d.quotes !== undefined && (!Array.isArray(d.quotes) || d.quotes.some(q => !q)))) return false;
  const accepted = [];
  for (const d of s.directions) {
    const qs = (d.quotes || []).filter(q => q.eligible === true || q.qualification?.eligible === true);
    if (qs.some(q => !soccerQuoteCandidateCurrent(s, d, q, { now }))) return false;
    if (!qs.length) { if (d.eligible !== false || d.score != null || d.W != null || d.R != null) return false; }
    else {
      qs.sort((a, b) => b.qualification.score - a.qualification.score || b.qualification.W - a.qualification.W
        || b.qualification.R - a.qualification.R || a.key.localeCompare(b.key));
      const q = qs[0];
      if (d.eligible !== true || d.selectedQuoteKey !== q.key || !same(d.quote, q)
        || d.score !== q.qualification.score || d.W !== q.qualification.W || d.R !== q.qualification.R) return false;
    }
    accepted.push(...qs);
  }
  if (!accepted.length) return s.formalScoringEnabled === false && s.qualification?.eligible !== true;
  return s.formalScoringEnabled === true && s.qualification?.eligible === true
    && instant(s.qualification.validUntil) === Math.min(...accepted.map(q => instant(q.qualification.validUntil)));
}
