import assert from 'node:assert/strict';
import fs from 'node:fs';

const page = fs.readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
const pit = fs.readFileSync(new URL('../lib/analysis-pit-snapshot-store-v1.js', import.meta.url), 'utf8');

assert.match(page, /const manualDateSelectionRef = useRef\(new Set\(\)\)/, 'manual date authority must be isolated per league');
assert.match(page, /function selectAnalysisDate\(value\)[\s\S]*setLeagueBoardDate\(league, value, \{ manual: true \}\)/, 'manual date selection must update the active league immediately');
assert.match(page, /function selectLeague\(value\)[\s\S]*allLeagueBoardDate\(allLeagueRun, nextLeague,[\s\S]*setDate\(nextDate\)/, 'switching leagues must restore that league board date');
assert.match(page, /\.filter\(row => item\.actualSource\?\.provider === 'TAI888_READER_AUTO'[\s\S]*modelEvValue\(row\) != null/, 'pending Reader validation must retain the previously calculated ranking rows');
const rankingDerivation = page.slice(page.indexOf('const shadowRanking = useMemo'), page.indexOf('const shadowBetOrder = useMemo'));
const rankingFilter = rankingDerivation.slice(rankingDerivation.indexOf('.filter(row'), rankingDerivation.indexOf('.map(row'));
assert.doesNotMatch(rankingFilter, /preservedReaderAnalysis/, 'background refresh must not remove previously calculated ranking rows');
assert.match(rankingDerivation, /currentAnalysisExecutable[\s\S]*!preservedReaderAnalysis/, 'preserved rows must remain visible without regaining current ranking authority');
assert.match(page, /useLayoutEffect\([\s\S]*rankingScrollAnchorRef[\s\S]*data-rank-key/, 'ranking refresh must preserve the visible row anchor');
assert.ok((page.match(/data-rank-key=\{entry\.stableKey\}/g) || []).length >= 2, 'both ranking views must use stable row identities');

assert.match(pit, /analysisPitSemanticIdentityHash\(storedRecord\) !== analysisPitSemanticIdentityHash\(record\)/, 'PIT conflicts must compare semantic immutable evidence before accepting a retry');
assert.match(pit, /loadAnalysisDirectionHistory\(record\.snapshotId\)/, 'an existing complete direction history must be verified instead of rebuilt with retry timestamps');
assert.match(pit, /canonicalRecord\.marketAnalysisPayload/, 'a partial direction history retry must use the canonical stored PIT analysis');

console.log('V11.8.2 per-league dates, PIT idempotency and mobile ranking stability PASS');
