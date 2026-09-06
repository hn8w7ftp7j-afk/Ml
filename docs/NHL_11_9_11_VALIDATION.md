# NHL 11.9.11 validation record — pending

Release status: **PENDING**. This is a handoff checklist for the current work,
not a claim of merge, deployment, final test success or Production acceptance.
The integration owner must fill the final evidence below from the frozen
candidate and the subsequently deployed commit. Do not replace a missing result
with PASS merely because its command or implementation exists.

## Platform authorization checkpoint (2026-09-06)

The platform explicitly rejected continuation of the full-season official PBP
batch acquisition. Do not resume it, split it into smaller requests to bypass
the decision, change transport/proxy/agent, or use Production as a download
proxy. Continuation requires permitted source data supplied by the user or the
platform's authorization for that acquisition. Successful original checkpoints
are retained; an authorization rejection is not a provider timeout.

At this checkpoint the local source directory contained 216 new PBP response
files, plus one existing official base fixture: 217 responses, 215 QA-eligible
games. Two source event/SOG-total conflicts remain BLOCK. Several 5v5 fit blocks
also remain explicitly `FIT_NOT_CONVERGED`; this is not full calibration PASS.
These counts are not a complete-season certificate. Any compact xG report must be checked against its own generated
time and manifest before reporting final metrics.

The complete official 2023–24 score/period corpus is already available: 32 teams,
1,312 regular games and all three periods, zero missing/conflicting period IDs.
The existing score model produced 1,194 chronological folds and a separate fixed
holdout of 780 training, 270 validation and 260 test games; the two boundary games
excluded from training by the 48-hour embargo are not training observations.
Historical-score validation tests passed 21 groups after archive round-trip and
tamper/identity checks were added (the original model/coverage suite was 19).
The 123 original history response checkpoints also have five verified compressed
archive chunks; original raw files remain present and have not been deleted.
These are retrospective
score diagnostics, not contemporaneous personnel PIT or predictive certification.

One full `npm test` run completed successfully during integration. Subsequent
client hydration/source retry/archive work means this is not final-candidate
acceptance: rerun the complete suite and build after the checkpoint is frozen.
The candidate has not been committed, merged or deployed. This work has not
changed Production. Physical-mobile and final Production acceptance remain open.

Offline safety-checkpoint tests subsequently completed: source data 28,
personnel-feed 28, personnel API 12, observed-shot API 9, boundary regression 11,
client state 11, history/archive 21 and shot/archive 19 groups. These local tests
do not replace the final whole-site run, Production build or actual acceptance.
The xG raw report, compact report and frozen artifact were synchronized to the
215 eligible games. All four final frozen fits converged, but the chronological
research retained 60 5v5, 10 PP and 10 PK targets skipped for non-converged fits.
The full-manifest offline runner intentionally exits 1 for incomplete coverage:
1,095 requested games have not been acquired. Do not turn this exit into PASS.
Three compressed shot archives preserve all 216 new raw checkpoints losslessly.

## Implemented scope

### Subsequent integration checkpoint

Integrated main `79da780635502f304a41c559fb8ced2627b55a54`, preserving the
concurrent official-result and database settlement-recovery fixes. The complete
`npm test` command exited 0 after this integration, including the existing
baseball/NBA suites and all NHL posttests. The separately repeated observed-shot
API (9 groups) and personnel API (12 groups) tests also exited 0. Production-only
dependency audit reported zero vulnerabilities. Deployment acceptance remains
pending until an actual deployed revision is checked below.

The earlier 60/10/10 non-convergent target checkpoint is resolved on the retained
corpus. Near the optimum, subtracting two large summed losses lost the small
Newton improvement. The line search now evaluates the same objective difference
directly using `log1p`/`expm1` and compensated summation. The objective, L2 penalty,
iteration limit and absolute gradient tolerance of `1e-8` are unchanged. Every
published chronological fit passes that tolerance; zero retained targets are now
skipped for `FIT_NOT_CONVERGED`.

The regenerated 5v5 evidence contains 175 held-out games / 11,680 shots,
Brier 0.05345076372409309 and log loss 0.20123083380469317 (training-only baseline
Brier 0.05672446124934354). PP has 175 held-out games, PK 159 and other-even 91;
insufficient-prior-data cases remain excluded. Frozen artifact SHA-256:
`804d577607c57623f3da4d37a683e66c0a40f3a32218fa814a91421b97555c95`.
The offline full-manifest runner still correctly exits 1: 217 retained responses,
215 eligible games, 1,095 missing games and two source conflicts are not complete
season coverage. No additional source requests were made for this numerical fix.

- Official editorial personnel acquisition, exact game/team/player identity,
  projected lines/pairs/goalies, injuries/scratches and explicit unresolved rows.
- Authenticated `personnel` and `personnel-versions` API actions, immutable source
  observations, freshness, semantic revisions and goalie-change distinctions.
- NHL-only bounded browser display persistence for manual data requests,
  including completion after leaving and returning to the NHL route.
- Expanded official outcome coverage, separate period-path validation and
  independent retrospective conditional-on-observed-shots xG research.
- Same repository/app/authentication/Production project; wagering rules and
  existing MLB/NPB/KBO/CPBL/NBA responsibilities are not replaced.

## Evidence classes must remain distinct

| Evidence | What it establishes | What it does not establish |
| --- | --- | --- |
| Official raw response with URL, acquisition time and SHA-256 | Reproducible source content observed on that acquisition date | Availability before a historical game's start |
| Official 2026-06-14 personnel factual extract | Names, projected groupings, article metadata and separately sourced identity mappings | A raw original article archive or confirmed starter |
| Factual extract in synthetic HTML/API envelopes | Parser, transport, authentication and failure-state behavior | A live Production source acquisition |
| Synthetic goalie/identity/counterexample cases | Rejection of malformed, conditional, stale or cross-game evidence | Observation of an actual confirmed-goalie change |
| Outcome coverage certificate | Official recorded season games and phase-specific outcome completeness | Complete periods, PBP, injuries, goalie or xG coverage |
| Chronological holdout/reliability reports | Reproducible historical diagnostic measurements on identified folds | Certified Production predictive calibration |
| Actual deployed browser/API observations | The tested flow on a specific deployed commit | Untested mobile devices or a guarantee of future upstream availability |

## Final corpus and research evidence

At draft time, the working-tree `history-expanded/coverage.json` identified
2023–24, 32 acquired teams and 1,312/1,312 official recorded regular-season
outcomes. Period and PBP acquisition/validation are separate ongoing work. The
integration owner must fill the final rows below from mutually hash-verified
reports after acquisition and regeneration finish.

| Final field | Evidence to use | Final observed value |
| --- | --- | --- |
| Outcome corpus/coverage hash and phase counts | `history-expanded/coverage.json`, `outcomes.json` | PENDING_FINAL_EVIDENCE |
| Complete-period coverage and missing/conflicting IDs | `period-games.json`, coverage and batch-period reports | PENDING_FINAL_EVIDENCE |
| Score benchmark walk-forward/validation/test counts and errors | `score-validation.json` | PENDING_FINAL_EVIDENCE |
| Existing NHL period model folds and frozen holdouts | `model-validation.json` | PENDING_FINAL_EVIDENCE |
| PBP requested/acquired/eligible/excluded games | `xg-research/acquisition-manifest.json` | PENDING_FINAL_EVIDENCE |
| Shot model scenario coverage, held-out shots, Brier/log loss and baseline | Bundled shot research evidence/reports | PENDING_FINAL_EVIDENCE |
| Frozen shot artifact/source hashes and training cutoff | `shot-research-frozen.js` and acquisition evidence | PENDING_FINAL_EVIDENCE |

The displayed research xGF/xGA/share are estimates conditional on covered
observed shots, not NHL-published xG, a complete-game official total or a pregame
shot-volume/score forecast. No fabricated 5v5 exposure, per-60 or high-danger
definition is permitted. Historical personnel PIT remains unverified where no
contemporary capture exists. All actual calibrated/uncalibrated flags must be
reported as stored; diagnostic output alone cannot promote them.

## Final tests and deployment

These are required evidence locations, not completed-result claims. Preserve
the command exit status, tested commit and complete relevant output. Re-run
after integrating concurrent main changes or fixing an acceptance defect.

| Gate | Final evidence/result |
| --- | --- |
| Personnel parser and actual-handler integration (`nhl-personnel-feed-test.mjs`, `nhl-personnel-api-test.mjs`) | PENDING_FINAL_EVIDENCE |
| Source/identity/goalie/timezone and nested observation boundaries | PENDING_FINAL_EVIDENCE |
| Client state, route-switch completion, persistence failures and data isolation | PENDING_FINAL_EVIDENCE |
| History coverage/period/hash and chronological validation tests | PENDING_FINAL_EVIDENCE |
| Shot-model mathematics, leakage and counterexample tests | PENDING_FINAL_EVIDENCE |
| Full NHL and MLB/NPB/KBO/CPBL/merged NBA regression | PENDING_FINAL_EVIDENCE |
| Production build and repository CI | PENDING_FINAL_EVIDENCE |
| Latest integrated main SHA, PR and merge SHA | PENDING_FINAL_EVIDENCE |
| Production deployment ID, READY state and matching main SHA | PENDING_FINAL_EVIDENCE |

## Post-deployment actual acceptance

| Actual flow | Observed commit/time/result |
| --- | --- |
| Existing-site NHL entry, official schedule and Taipei/US dates | PENDING_FINAL_EVIDENCE |
| Personnel fetch, verified rows, unresolved names and projected-vs-confirmed labels | PENDING_FINAL_EVIDENCE |
| Source freshness, durable snapshot write and version readback | PENDING_FINAL_EVIDENCE |
| No-match, source failure, loading completion and preserved prior result | PENDING_FINAL_EVIDENCE |
| Leave NHL during request, return, reload and verify stored display state | PENDING_FINAL_EVIDENCE |
| Expanded history/period/shot research with truthful coverage labels | PENDING_FINAL_EVIDENCE |
| MLB/NPB/KBO/CPBL/NBA navigation and cross-league isolation | PENDING_FINAL_EVIDENCE |
| Desktop interactions and overflow check | PENDING_FINAL_EVIDENCE |
| Mobile device/viewport, touch interaction and overflow check | PENDING_FINAL_EVIDENCE |
| Site-origin console/runtime/network errors and outstanding upstream issues | PENDING_FINAL_EVIDENCE |

An emulated narrow viewport must be labelled emulation; it is not a physical
phone test. The currently retained real personnel article lists projected
goalies; real CONFIRMED transitions require their own actual evidence. Tai888
remains **等待真實 Tai888 NHL 盤驗證**. None of these separate limitations may be
silently converted into a successful gate or used to erase completed engineering.
