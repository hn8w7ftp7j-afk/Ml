# NBA preseason market estimates — v11.9.64

The formal NBA workspace now analyzes available preseason full-game and first-half total and spread contracts. Previously the same-season model had no 2027 preseason calibration observations, so its fallback displayed previous regular-season baseline scores but no market probabilities. The regular-season model remains separate.

ESPN secondary historical schedules for all 30 NBA teams were retrieved for preseason ending years 2024–2026 and previous regular seasons 2023–2025. Event identity, season/type, Taipei date, starting time, home/away, final score and neutral-site flags were cross-checked with every preseason event summary. Quarter scores must sum to final scores; first half uses quarters 1–2. Nineteen unique non-NBA-opponent games were excluded. The artifact embeds a manifest of 378 source URLs with SHA-256 hashes and 198 usable preseason games. Current 2027 preseason inputs use completed 2026 regular-season team results, never current game outcomes.

Four independent fixed ridge regressions (penalty 1000, minimum 30 earlier preseason games) map previous regular-season team strength to full total, full home-minus-away margin, half total and half margin. Each archived error is generated using only games on strictly earlier Taipei dates; same-day results are excluded. The minimum error distribution is 50 observations. All 168 frozen errors are used together, with a fixed 365-day half-life. There is no outcome-based filtering or reversal of over picks to under picks.

Reader quotes are matched to the authoritative scheduled event. Credit-contract rounding, partial wins/losses, favorite identity and each side's own water are evaluated separately. The UI displays unconditional model win probability, push probability and model net per 100 units including 1.5% turnover rebate. A heartbeat with unchanged prices preserves a current result; any change to any analyzed price, line or favorite marks it obsolete. Locked, stale or started events cannot be analyzed.

These are model estimates, **not verified historical betting win rates**. Historical original credit quotes and full contemporaneous input snapshots are unavailable, and injuries, roster changes and rotations are not incorporated. No executable NBA bet or baseball ledger eligibility is introduced. The UI and validation JSON explicitly disclose these limitations. 2025 total MAE improves from baseline 15.74 to 14.81; 2026 total MAE worsens from 16.89 to 17.78. These results do not establish profitability or a >50% realized win rate.

Reproduction:

```sh
node scripts/download-nba-preseason-training.mjs /absolute/source-directory
node scripts/prepare-nba-preseason-training.mjs /absolute/source-directory/training.json
npm run test:nba
npm run build
```

`nba-preseason-model-test.mjs` covers all four markets, exact partial-credit cash settlement, away/home favorite mapping, future/same-day exclusion, training integrity, single-market service execution, merged job results and price freshness. Existing NBA and multi-league tests protect authentication, event matching, workflow progress and baseball isolation.

## Shadow ranking and S display — v11.9.66

The NBA workspace now exposes an independent shadow-ranking tab, with full/half and total/spread filters. It lists every valid analyzed side, including negative net estimates, sorted by S score, then W and R, using the same production deterministic-score mapping as MLB. Win probability, push probability, exact quote/water, favorite/underdog role and sample count come directly from the same analysis payload as the game card; W is NBA model net per 100 units; R is the minimum of W and each prior preseason season stress estimate, requiring at least two seasons with 30 residuals each. S inputs use decimal return units, not probabilities. R is a historical scenario stress metric, not a confidence bound or a verified betting EV. Missing stress evidence leaves S blank until reanalysis. Both game cards and rankings display S to one decimal, with W/R and win/push probabilities in detail. All score outputs remain non-executable and ineligible for formal bets. Completed games join as each job result arrives. Changed prices, stale snapshots, started games, insufficient/reference results and mismatched identities are excluded. Reanalyzing from ranking preserves the selected view. Existing job restoration supplies the same rankings after reload.
