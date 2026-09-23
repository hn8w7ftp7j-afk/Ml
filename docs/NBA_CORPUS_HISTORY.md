# NBA historical odds corpus research

The NBA corpus interface has moved to the private independent site:
https://nba-mlb-research.kai-2199.chatgpt.site/
The main site has no research tab; old corpus and research APIs return authenticated
410 RESEARCH_MOVED responses. Old corpus POST no longer writes to the main DB.
The new site owns its bundled seed and append-only R2 research versions.
`research/nba-history/` is ignored. Never commit uploaded source images, Drive
references, or research payloads to this public repository.

## Reproduce

Run `node scripts/nba-corpus-history.mjs --source=/private/source.json
--output=/private/result.json --checkpoint=/private/checkpoints --season=2026`.
Arguments must be on one command line. `--offline=true` replays saved acquisition
results without network requests. The source file SHA-256 is recorded. Successful
normalized responses preserve their original source hashes and retrieval times.
Source schema/identity failures remain visible. The runner also retains raw odds
rows, candidate dates and unmatched games; it never backdates a quote.

The season is a candidate, checked against exact Taiwan date and home/away team
identity. ESPN matching is secondary-source matching, not an official NBA ID
crosswalk. Date-range HTTP 400 responses retry two individually validated UTC
days, recording both response sources and the recovered failure.

Team histories include warmup games absent from the odds corpus. Regular season
and postseason remain separate. The unchanged single-team model is run for each
team/type and each target game uses its **home-team perspective**, declared before
examining performance. Training uses strictly earlier Taiwan dates. Optional
historical diagnostics expose the same predictions and same-fold baseline used
by the existing aggregate report; they do not alter the fit or release future
predictions.

When player identity blocks the general game view, the internal completed-game
team-box reader separately validates NBA league, game, unique home/away IDs,
period/final scores, shooting/rebound/turnover arithmetic and duration. It returns
no players, lineups or player effects. The general game/player QA remains BLOCK.
This boundary is covered by synthetic identity/arithmetic counterexamples.

## Private import

Create a delivery JSON from the result: set `league: "NBA"` and
`modelInputEnabled: false`; replace each entry's `snapshots` with `snapshotCount`
and `sourceRows` (original row IDs). Omit the bulky per-team `reports` from the UI
payload; retain them with the private reproducibility archive. Upload through
the independent site → NBA → 匯入歷史研究報告.

The POST is authenticated, same-origin and size limited. The store
reconciles unique rows, candidate/matched/included counts, training cutoffs and
aggregate MAE/RMSE/bias before insertion. Revisions use canonical key ordering so
JSON key ordering cannot invalidate an unchanged payload. Writes append;
readback must match the revision before a persisted receipt is returned.
The research table is independent of pregame evidence, ledgers and model inputs.

## Interpretation

Inclusion in score research is not verified market backtesting. Missing quote
capture times, unresolved periods, synthetic midpoint prices and missing official
crosswalks remain explicit. This path does not calculate EV, market probability,
ROI or wagering recommendations. Strict point-in-time replay remains false.
Rows without enough history stay pending rather than disappearing.

Unit and SQL transport-double tests are not live DB or browser acceptance.
Production must separately verify import receipt, reload, filters, pagination,
authentication and the displayed totals against the saved artifact.

