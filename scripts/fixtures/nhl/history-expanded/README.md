# Official NHL historical acquisition and validation evidence

These files are real, retained official NHL responses and deterministic reports.
They are not synthetic data and not archived pregame injury/goalie snapshots.
Each raw checkpoint records its precise URL, observation time and SHA-256 of
the parsed response. Request failures remain explicit in coverage/progress.

`archives/manifest.json` and `archives/sources-*.json.gz.b64` preserve each raw
source checkpoint's original UTF-8 bytes in deterministic lossless gzip/base64
chunks. The manifest binds both the exact checkpoint-byte SHA-256 and original
official response hash, URL and observation time. The shared archive reader
checks compressed bytes, decompressed bytes, identity and source hash before
use; tampering is rejected even after a decoded cache hit. No original local
source file is removed. Six runtime datasets/reports remain ordinary JSON.

The latest counts and exact missing identities are in `coverage.json`; do not
replace them with a hard-coded claim that a whole season is available.

## Reproduce and resume

From this repository root:

```sh
node scripts/nhl-history-validation-runner.mjs --season 20232024 --out /absolute/path/to/scripts/fixtures/nhl/history-expanded --period-games 60 --all-periods --offline
node scripts/nhl-history-validation-runner-test.mjs
```

Remove `--offline` only to perform an authorized acquisition/resume. Successful
hash-valid checkpoints are reused. Requests are sequential and spaced at least
two seconds apart; a 403/429 stops further network requests for that run. A
Retry-After header, when supplied, is retained. Do not immediately repeat a
rate-limited run or bypass the provider's restriction. The script never uses
proxy services, browser credentials, fabricated responses or a second website.

The default terminal date comes from NHL's `standings-season` index. For
2023–24 that is 2024-04-18. The dated standings endpoint returned an empty array
for the next day and July 1; those original empty responses are retained as
schema/date counterevidence. A calendar assumption is not a valid registry.

`outcomes.json` contains separately labelled preseason, regular season and
playoff results. A whole regular season requires every official team game count
and both teams' independent schedules to corroborate every unique game.
Regulation ties in OT/SO are derived only by removing the one official awarded
winning goal; three regulation periods are **never** invented from that score.

`period-games.json` combines official landing paths and reciprocal game-level
team period reports. For the latter, two team rows must agree on official game,
home/away identity, opponent, date, all three periods and regulation totals.
Independent source conflicts quarantine the game. The API returns at most 100
rows per page, even if a request asks for 1000. Three retained larger-limit
requests each returned 100 rows; missing offsets cannot count as covered.

`score-validation.json` is an expanding empirical joint-score **benchmark**,
not a replacement NHL model. It uses only earlier official score outcomes with
a 48-hour embargo. Its chronological fixed holdout never fits on validation or
test outcomes. Preseason and playoffs are not mixed into regular-season fits.

`model-validation.json` uses the existing NHL `model.js` without any formula
change, with block walk-forward and an independent chronological fixed holdout.
It records the exact training IDs, source hashes, fitted bandwidth, calibration
fold counts, probability integrity, score Brier, squared error and reliability
bins. Missing features stay missing; poor scores or unseen held-out score paths
are not capped, concealed or repaired by changing evaluation thresholds.

Complete observed-score coverage is distinct from complete period coverage,
held-out predictive calibration, archived point-in-time personnel evidence,
and Tai888 validation. Today-fetched statistics do not prove historical data
availability. Reports therefore do not claim strict PIT, wagering profitability,
or production model calibration. The website reads a hash-checked compact
summary; it does not send every raw historical record to the browser.
