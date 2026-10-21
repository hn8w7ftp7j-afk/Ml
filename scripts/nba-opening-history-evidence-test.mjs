import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openingResearchHistory as archive, openingResearchHistoryArchiveSha256 } from '../lib/nba/opening-research-history.js';
import { auditOpeningResearchArchive, OPENING_RESEARCH_REVIEWED_ARCHIVE_SHA256,
  OPENING_RESEARCH_REQUIRED_SOURCE_YEARS } from '../lib/nba/opening-history-evidence.js';

// Source-only verification: never import a predictive model or inspect holdout
// forecasts, errors, probabilities or candidate selection.
assert.equal(openingResearchHistoryArchiveSha256, OPENING_RESEARCH_REVIEWED_ARCHIVE_SHA256);
assert.equal(createHash('sha256').update(JSON.stringify(archive)).digest('hex'), OPENING_RESEARCH_REVIEWED_ARCHIVE_SHA256);
const before = JSON.stringify(archive), audit = auditOpeningResearchArchive(archive.history, archive);
assert.deepEqual(audit.map(row => row.year), OPENING_RESEARCH_REQUIRED_SOURCE_YEARS);
assert.deepEqual(audit.map(row => row.observedGames), [1230, 1230, 1059, 1080, 1230]);
assert.ok(audit.every(row => row.verified && row.schedulesChecked === 30 && row.failureCodes.length === 0));
assert.ok(auditOpeningResearchArchive([...archive.history].reverse(), archive).every(row => row.verified), 'row ordering cannot alter source identity');
assert.ok(auditOpeningResearchArchive(archive.history, archive, { requiredYears: [2021, 2022] }).every(row => !row.verified), 'development and holdout audits cannot omit fit/prior/residual source years');
assert.ok(auditOpeningResearchArchive(archive.history, archive, { requiredYears: '2018,2019,2020,2021,2022' }).every(row => !row.verified));
assert.ok(auditOpeningResearchArchive(archive.history, null).every(row => !row.verified));
assert.ok(auditOpeningResearchArchive(null, archive).every(row => !row.verified));
const forged = { kind: 'NBA_OPENING_VERIFIED_REGULAR_ARCHIVE', missing: [], sources: ['plausible-but-not-evidence'],
  coverage: { years: archive.coverage.years }, history: archive.history };
assert.ok(auditOpeningResearchArchive(archive.history, forged).every(row => !row.verified && row.failureCodes.includes('REVIEWED_ARCHIVE_HASH_MISMATCH')),
  'numeric coverage and a nonempty sources array cannot establish source verification');
const mutateArchive = (mutate, code) => {
  const copy = structuredClone(archive); mutate(copy);
  const changed = auditOpeningResearchArchive(copy.history, copy);
  assert.ok(changed.every(row => !row.verified && row.failureCodes.includes('REVIEWED_ARCHIVE_HASH_MISMATCH')));
  if (code) assert.ok(changed.some(row => row.failureCodes.includes(code)), code);
};
mutateArchive(value => { value.sources[0].url = value.sources[0].url.replace('https:', 'http:'); }, 'SCOREBOARD_SOURCE_SCOPE_INVALID');
mutateArchive(value => { value.sources[0].sha256 = 'f'.repeat(64); }, 'ROW_SOURCE_CHECKPOINT_MISMATCH');
mutateArchive(value => { value.sources[0].retrievedAt = 'not-a-time'; }, 'SOURCE_CHECKPOINT_INVALID');
mutateArchive(value => { value.sources[0].bytes = Infinity; }, 'SOURCE_CHECKPOINT_INVALID');
mutateArchive(value => { value.sources[0].cacheFile = '../elsewhere.json.gz'; }, 'SOURCE_CHECKPOINT_INVALID');
mutateArchive(value => { value.sources[0].kind = 'unverified'; }, 'SOURCE_KIND_INVALID');
mutateArchive(value => { value.sources.push(value.sources[0]); }, 'SOURCE_URL_DUPLICATE_OR_INVALID');
mutateArchive(value => { value.sources = value.sources.filter(source => source.kind !== 'team_schedule' || source.year !== 2018 || source.team !== 1); }, 'THIRTY_TEAM_SCHEDULES_REQUIRED');
mutateArchive(value => { value.sources = value.sources.filter(source => source.day !== '2017-10-17'); }, 'ROW_SOURCE_CHECKPOINT_MISMATCH');
mutateArchive(value => { value.sources.find(source => source.kind === 'team_schedule').year = 2026; }, 'SCHEDULE_SOURCE_SCOPE_INVALID');
mutateArchive(value => { value.history[0].checkpointSha256 = 'f'.repeat(64); }, 'ROW_SOURCE_CHECKPOINT_MISMATCH');
mutateArchive(value => { value.history[0].date = '2017-10-19'; }, 'ROW_TAIPEI_DATE_MISMATCH');
mutateArchive(value => { value.coverage.years[2018].expectedGames = 1; }, 'RECONSTRUCTED_COVERAGE_MISMATCH');
mutateArchive(value => { value.synthetic = true; }, 'ARCHIVE_SCOPE_INVALID');
const changedHistory = structuredClone(archive.history);
changedHistory[0].homeScore++;
const mismatch = auditOpeningResearchArchive(changedHistory, archive);
assert.equal(mismatch.find(row => row.year === 2018).verified, false);
assert.ok(mismatch.find(row => row.year === 2018).failureCodes.includes('EVALUATED_HISTORY_SOURCE_MISMATCH'));
assert.ok(mismatch.filter(row => row.year !== 2018).every(row => row.verified), 'an altered input cannot borrow unrelated trusted source identities');
assert.equal(JSON.stringify(archive), before);
console.log('NBA opening research history evidence PASS: all five source years, reviewed raw-archive pin, exact source/row identity, manifest/date/checksum coverage, and malformed/forged evidence fail closed; no holdout metrics evaluated.');
