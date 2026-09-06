# NBA Shadow research verification — 2026-09-06

This release adds non-wagering basketball research to the existing repo/project. Existing MLB/NPB/KBO/CPBL/NHL implementations, wagering actions, EV/S, ranking, Reader and settlement rules are not modified by this NBA change. The base is main `0610f7e5cc49dd0039ca2b85cd9a8924bfddfcf0`, including the other conversations' v11.9.5 recovery fixes.

## Real-source historical runs

Reproduce with `npm run nba:shadow-history -- --team=5 --season=2026 --output=/absolute/new-report.json`, changing the ending year for other seasons. Reports include source URLs, SHA-256 hashes, retrieval/publication times, normalized observations, every fold's training cutoff and the exact research method. Output uses exclusive file creation. No synthetic fixture is a provider fallback.

| Cleveland season | Actual box scores | Validation games | Model score MAE | Same-fold baseline MAE | Model RMSE | 90% joint interval observed coverage |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 2024–25 regular | 82 / 82 | 67 | 10.7781 | 9.2825 | 14.7939 | 46 / 47 = 97.8723% |
| 2025–26 regular | 82 / 82 | 67 | 10.3351 | 9.5153 | 13.1667 | 42 / 47 = 89.3617% |

The model is **worse than the simple baseline on both samples**. This is a negative research result, not a bug to hide by changing observations, clipping output, relaxing QA or presenting the model as calibrated. These are two seasons of one team, not a league-wide benchmark. Three 2025–26 and two 2024–25 games included overtime; duration checks passed.

The 2025–26 preseason is a separate four-game dataset. ESPN summaries `401812684` and `401812692` contain player identity records that cannot be verified. In `401812684`, a did-not-play record contains only `shortName: Olbrich`, no ID and empty links. The existing identity gate correctly blocks the affected summary. The research runner must show BLOCK; it must not guess the athlete, silently omit the identity failure, or label the entire preseason verified. A four-game sample is insufficient for this model even if source identity is repaired.

## Test coverage

NBA data: 35 groups. Existing scores-only research: 14 groups. Basketball/Shadow tests add arithmetic, missing values, overtime, minute precision, no caps, chronological/nested split isolation, same-date isolation, season/type isolation, same-fold baselines, symmetric positive-semidefinite paired covariance, missing-boxscore accounting, cancellation/rerun, identity-block propagation and invalid-input preflight. API/client: 9 groups. All fixtures are explicitly synthetic test-only data.

Run `npm test`, `npm run build`, `npm audit --omit=dev --audit-level=high` and actual Production browser tests for release acceptance. Do not infer browser or deployment PASS from unit/build results. Deployment evidence belongs in the final handoff once verified.

## Still not validated or implemented

- Official NBA IDs, official live JSON and official advanced-stat ingestion are not established by the ESPN adapter. A fresh ordinary fetch of `https://www.nba.com/schedule` returned 200 but its server-rendered page data contained settings, not the actual game feed; that does not verify an official schedule adapter.
- Historical pregame injury/lineup publication snapshots, official On/Off, actual travel itinerary and a complete player-impact model are not yet integrated. This is an implemented basketball research model, not the originally requested full NBA analysis system.
- Model superiority, league-wide calibration and prospective validation are not established.
- Mobile physical-device verification is not claimed; browser tooling lacks a viewport/device-emulation capability.
- NBA betting/recommendations/ranking are outside this narrowed change and remain absent. Existing wagering code stays untouched.

## Post-deployment corrective pass

v11.9.6 / PR #175 deployed to the same Production alias at main `2e1a5b453f18d3a5c18e10f8d6780917aed439d0`; health reported 11.9.6. Actual browser testing started the 82-game research run, switched to the team view, and returned to continuing progress with no source failures. The built-server HTTP boundary also verified authentication (401), foreign-league rejection (400), `/nba` (200), 22 actual player rows and shared 102.8 estimated possessions for game 401811042.

The v11.9.7 correction makes initial hydration and pending tab-key transitions display Loading instead of an empty-state instruction, counts the QA-blocked request as processed, and explicitly reports session-storage quota failure as memory-only persistence. The existing verified 30-team identity registry supplies selection labels before live team data arrives, avoiding an ID-only dropdown after reload. Storage failures never trigger deletion of another league's data. Two additional storage-path tests bring NBA coverage to 80 groups (35 data + 14 baseline + 22 basketball/Shadow + 9 API/client). These corrections do not change model formulas or any existing wagering rule.
