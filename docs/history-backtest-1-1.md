# Historical backtest 1.1 — frozen over diagnostics

This integration adds `/diagnostics/over` to the existing application. It uses the
frozen 659-game research inventory: 655 computable games, 116 without a full-game
over market, 539 valid over contracts, and 4 preserved source blocks. Historical
simulation is separate from the actual bet ledger. No model, market, rebate,
historical selection, settlement or source eligibility rule is changed.

## Current policy — UI 11.9.35

The user reversed the temporary exclusion: MLB full-game overs remain normally
visible and participate in the original candidate order and QA/ranking rules.
Observation metadata is not a restriction and is not evidence of positive EV.
The frozen research tables, model estimates and negative historical ROI remain
unchanged. No model, ledger, authentication or settlement formula is changed.

The actual-bet statistics panel also retains the original first-five total
aggregate and adds independent first-five OVER and UNDER views. These filters use
the recorded contract direction, inherit date/league filters, and reuse existing
settlement accounting. Unknown/conflicting directions remain in the aggregate
without guessed assignment. Subviews never get added again into the grand total.

## Previous integration — UI 11.9.34 (exclusion superseded above)

The approved integration labels **MLB full-game total-over only** as research-only
and removes it from the actionable candidate order. Raw scores, W/R, QA results,
signed snapshots and the original model v11.0.3 remain unchanged. The policy lives
in a separate display/candidate helper and is not written into historical analyses.
Full-game unders, first-five markets and other leagues retain their existing rules;
this does not imply they have demonstrated positive returns.

Actual bets can still be honestly recorded, cancelled, re-recorded and settled
under the original ledger checks. Research-only is not a ledger deletion or a block
on recording an external bet. Copy exports distinguish the current display policy
from the archived analysis.

The home page links to **研究回測**. Its first screen separately reports the frozen
selected cohort's mean model W (+14.71%), conservative model R (+8.85%) and historical
simulated ROI (−14.42%; −30.27475 units on 210 one-unit entries; 89 wins, 120 losses,
1 push). The sample is repeatedly studied, not a new out-of-sample test, and these
values are neither current opportunities nor actual ledger ROI. All-sample and
selected-sample date counts are separately labelled (50 and 49 dates).

## Four tables

1. **Calculation chain:** per-side baseline and exact baseline-data identity,
   applied offense/pitching/environment factors, scheduled versus terminal means,
   market W/R/S and simulated return. Market metrics repeat across the two sides;
   do not sum the two references as separate bets.
2. **Starter/bullpen allocation:** the actual estimator branch and fallback,
   scheduled exposure, and explicitly diagnostic allocation. Terminal expected
   outs remain null because score distributions did not preserve out-state paths.
3. **Nested funnel:** computable, outcome-evaluable and missing-outcome populations;
   W > 0, then R > 0, then S >= 7.2, then frozen final selection. Joint date-cluster
   bootstrap uses the same resampled dates for both sides of every contrast.
4. **Conditional comparison:** batch × feature state, fixed delta/line bins,
   selected/unselected sample and date counts, sparse/no-overlap warnings, and
   component averages. Batch/feature collinearity prevents single-factor attribution.

## Delivery and provenance

`GET /api/diagnostics/over` requires existing application authentication and returns
all 539 compact table rows with summaries. `?gameId=<id>` retrieves that game's
expanded diagnostic trace and referenced source-evidence projections. `?download=1`
downloads the pinned gzip artifact. All responses use no-store; there is no DB write,
live model execution or external source request in these handlers.

The loader verifies compressed and uncompressed SHA-256 identities, schema and
embedded frozen-input hash before displaying data. These checks establish artifact
integrity; they do not independently authenticate historical publication times.
Provenance projections explicitly distinguish archived receipts, retrieval time,
publication evidence and missing fields. Full underlying receipt collections remain
in the original frozen inputs. Availability update (2026-09-12): workspace cleanup
removed the not-yet-persisted full v1.1 research projection and its scripts.
The 539 public diagnostic rows and 4,539 representative source records were
recovered unchanged from GitHub blobs. The 33,504-record full collection is not
currently restored: attempts to materialize the original Library input archives
returned HTTP 502. Embedded full-artifact paths/hashes are historical references,
not a claim that the exact full archive is currently downloadable. Any rebuilt
research bundle must disclose this scope and must not invent omitted receipts.

The original mathematical core is pinned to
`4f04ecf22bc0682c9e7e70116dd991c873d0186d`. Display/data provenance changes do not
constitute a new fitted model. All historical outcomes were previously studied;
reported intervals and conditional contrasts are exploratory, not fresh OOS results.

## Validation

Run `npm run test:over-diagnostics`, the existing `npm test`, additional PIT/Asian/
external/evidence export gates, `npm run build` and `npm run test:over-http`.
The HTTP smoke test starts the built app with random ephemeral local credentials;
it verifies normal authentication, protected routes, summaries, detail and exact
gzip download without production credentials, database writes or browser claims.
Separately verify the deployed API and UI, including all four tabs, search/selection/batch filters, paging,
expanded details, downloads, reload recovery, authentication and mobile layout.
Build and local HTTP success alone are not authenticated production-browser or
mobile visual acceptance. Report any remaining acceptance gaps explicitly.
Do not promote this research integration as a verified profitable model.
