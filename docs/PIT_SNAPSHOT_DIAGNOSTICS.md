# Original PIT snapshot diagnostics

`GET /api/analysis-snapshots` uses the existing site login and a 20-request/10-minute rate limit. It is a read-only diagnostic: it never creates schema, rewrites snapshots, settles records, calls current sports feeds, or changes scoring.

List one game's original FULL snapshots with `league=MLB&gamePk=823903`. The default `order=latest` returns at most 20 rows; `order=oldest` reads the earliest 20. `hasMore` explicitly marks a truncated listing. Metadata listing does not claim payload integrity has been checked.

To compare, add `before=<full snapshot ID>&after=<full snapshot ID>`. Both IDs must belong to the requested league and game and be different FULL snapshots. The server validates stored row identities, payload hashes, the pregame timestamp chain, and the saved distribution before comparing original outputs. It returns saved versions, acquisition/analysis/line times, changed context sections, and expected-run deltas. It does not return the full stored payloads or update the records.

Different contexts or markets return `INPUTS_DIFFER_NOT_CONTROLLED_COMPARISON`. Missing records, corrupt evidence, and unavailable storage are separate outcomes. A database error is never reported as proof that historical snapshots are absent. Even matching saved inputs are only an output comparison: `historicalValidationPassed` always remains false. Neither this endpoint nor the offline comparison CLI establishes source availability at historical prediction time, causal attribution, or improved future win rate.

Production acceptance still requires real stored records. Synthetic fixture tests alone do not establish historical validation.
