# Football missing scores — 11.10.34

## Confirmed baseline

Production 11.10.33 was serving main `b3451bb`. On 2026-10-24,
`GET /api/soccer/reader?league=epl&date=2026-10-24` returned the original
葉士域治 / 諾定咸森林 pair as `UNMATCHED`. Its observation time was
`2026-10-22T21:45:04.969Z`, with `HT` and `UNKNOWN` periods, `fresh:false`
and `prestart:false`. The game had finished; this is not a current prematch
quote and must never be republished with a newer observation time.

There is also a separate, unresolved feature gap: the normal soccer analysis
path does not provide the accepted settlement contract, football scenarios,
empirical net-return uncertainty artifact or model/calibration registrations
needed for formal W/R/S. Their production registries remain empty. The
existing shipped-path tests correctly produce zero formal scores.

## Changes

- Resolve the two observed EPL spellings through exact server-side aliases to
  Ipswich Town and Nottingham Forest. Preserve the installed Reader wire,
  canonical keys, original text and hashes. League, both teams, date, kickoff,
  ambiguity and raw-identity conflict checks remain mandatory.
- Describe completed research as `比分研究完成`; explicitly state that formal
  scoring is unfinished and that reanalysis cannot supply missing scoring
  inputs. Keep the per-stage reasons and existing score/quote counts.
- Keep the original partial-score wording and existing genuine/historical
  numeric-score presentation behavior.

## Validation boundaries

The alias roundtrip test constructs a fixture using the two observed names;
it is not evidence of live numeric scores. It covers the old Reader parse and
strict server reparse, unchanged canonical/hash values, swapped/wrong teams,
wrong league/date/time, ambiguity, raw conflicts, stale observations and final
games. A separate old-observation fixture retains `HT`/`UNKNOWN`, with no
automatic upgrade to `FT` or fresh/prestart authorization.

This release does not change any probabilities, payoff terms, 1% football
rebates, NBA 1.5% policy, fixed S formula, S >= 7.2 / W > 0 / R > 0 gates,
ranking eligibility, model registrations or candidate publication authority.
Football numeric scoring remains incomplete and must not be reported as fixed.
