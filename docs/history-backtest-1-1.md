# Historical backtest 1.1 — frozen over diagnostics

This preview adds `/diagnostics/over` to the existing application. It uses the
frozen 659-game research inventory: 655 computable games, 116 without a full-game
over market, 539 valid over contracts, and 4 preserved source blocks. Historical
simulation is separate from the actual bet ledger. No model, market, rebate,
selection, settlement or source eligibility rule is changed.

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
external/evidence export gates, and `npm run build`. Then verify the deployed
preview API and UI, including all four tabs, search/selection/batch filters, paging,
expanded details, downloads, reload recovery, authentication and mobile layout.
Build success alone is not end-to-end acceptance. Do not promote this research
preview as a verified profitable model.
