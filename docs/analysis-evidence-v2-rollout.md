# Shared evidence rollout v2

Scope: shared analysis receipts and exports; MLB-specific FIP and starter evidence stay in baseball modules. Existing W/R/S, market parsing, ranking and immutable saved payloads are unchanged.

Implemented:
- Export saved numeric outcome probabilities and equivalent settlement shares without display rounding or normalization. Units and lack of independent replay are explicit.
- New analyses retain actual settlement-event buckets with independent probability, settlement fractions and per-leg profit/rebate calculation, plus R scenario/downside trace. No reconstruction is applied to old results.
- Preserve non-finite numbers as error objects in the new evidence export; this is not a replacement for engine QA or a retroactive repair of already serialized nulls.
- Expose existing flattened batter metrics, sample PA, reliability, declared usage and provenance. Missing provenance is not filled from a different timestamp.
- Persist the full data audit receipt in new market-analysis payloads, alongside the existing compact quality summary; old saved payloads are untouched.
- Distinguish zero-start individual pitching samples from starter-only statistics; expose actual innings fallback and source branch.
- Show both sides' saved innings statuses, and framing summary versus calculation-input status without guessing source semantics.
- Export actual model FIP rates, constant, clamps and formula through the same calculation function. The numerical model and existing distribution output are unchanged.
- Preserve supplied request/cache/value/freshness dimensions independently; unrecorded dimensions remain UNKNOWN.
- Use scope-specific expected lineup size when supplied, baseball starting-lineup contract otherwise; unknown non-baseball scopes have no inferred denominator.
- Mark under-10 bullpen innings as a display reference only.

Still requires separate implementation / verification (not claimed complete):
- End-to-end collection and persistence of request attempts, selected cache source, source-value nature and freshness for every provider.
- External quote failure reason provenance across collection, matching, persistence and export.
- Layered replay capability receipts and model/cohort historical validation linkage.
- Runtime/code/config artifact retention and per-layer numeric acceptance policy.
- Production browser interaction acceptance and new-snapshot API evidence after deployment.

Existing snapshots must never acquire fabricated evidence. Missing historic inputs remain missing; any retrospective audit is a separately identified receipt.
