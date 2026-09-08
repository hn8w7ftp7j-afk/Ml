# KBO official TBF connection

Base: 36e86a829207ae7e8be607a48cc3654d5399efcb.

New live KBO collection reads the official PitcherDetail/Basic.aspx current-season TBF field for each identified starter. It checks response form player ID, profile name, official team emblem code, season heading, unique summary table and nonnegative integer value. GameCenter statistics must also match player name and season. Ambiguous multi-row totals are not guessed or summed.

Acquisition must finish before first pitch and belong to the current Korean-calendar year of the requested season. Historical inputs do not fetch this cumulative page. Publication time/statistical cutoff remain unknown; a receipt is not an invented publication timestamp. Existing snapshots are never rewritten. The raw response continues through the existing content-hash/event storage path; the season stores its exact event ID, content hash, source URL, field path and fetchedAt.

If acquisition, identity or format validation fails, the existing estimated sample remains labelled estimated, with acquisition status and no claimed observed count. No new fallback number is manufactured. This patch changes the TBF data input when verified; it does not change expected-innings estimation, mean/uncertainty formulas, settlement, Tai888 role, scoring thresholds or shadow eligibility. The production feature version is incremented to v1.0.3.

Tests cover real parser structure, ID/name/team/year mismatch, missing/negative/fractional counts, duplicate rows, wrong table, Futures redirect, zero, source receipt binding, current pipeline success, source failure, and rejection of historical backfill. A controlled worse-than-baseline starter example confirms increased actual sample changes shrinkage and uncertainty in the existing expected direction; no artificial EV cap or score adjustment is added.

Read-only live parser inspection on 2026-09-08 read TBF 461 for player 51264 and 503 for player 76715. These are observations at retrieval, not proof of the historical 09:12 snapshot's available values. Full KBO personnel completeness and predictive validation remain separate acceptance work.
