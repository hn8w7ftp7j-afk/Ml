# V6 earlier-era external retrospective source archive

This separate source-only archive contains the 2007–2011 regular seasons. Each
year has 1230 verified completed games, for 6150 total. The expected calendar and
game count come from both participating teams' completed schedules, not from a
fixed 82-game assumption. All 150 team schedules and 816 daily scoreboards were
downloaded and re-read from checksummed compressed raw checkpoints. There are
zero missing games. Ordered quarter scores sum to each final result; the actual
Q1+Q2 totals are retained for first-half targets.

The 2011 outcome corpus remains quarantined from predictive evaluation until
the next protocol and development selection are frozen. Acquisition, parsing,
packaging and source audit perform no predictive metric calculations. The V5
2013–2017 archive and its consumed validation result remain unchanged.

Reviewed raw archive SHA256:
`abbf2fc1c41d5509a2b7ff182aa4949702b66a6d6266dc82d7b795f915cb49e9`.

## Historical provider symbols

The shared normalizer correctly rejects a provider ID with an unexpected team
abbreviation. These older sources use `NJ` / `New Jersey Nets` for source ID17
in 2007–2011 and `SEA` / `Seattle SuperSonics` for source ID25 in 2007–2008.
A V6-only parser adapter allows exactly these raw ID/name/season/date tuples
and substitutes the current symbol for the same provider ID in a cloned parser
view. Raw source bytes and their hashes are unchanged. All other unexpected
identities and later-era aliases are rejected. The original shared normalizer
and earlier archives are untouched.

The source audit binds the exact reviewed archive, this adapter version,
all source URLs/hashes/cache paths and dates, all 30 schedules per year, actual
scoreboard calendar, normalized game identities, and coverage. Changed scores,
missing sources or teams, unverified metadata, different quarantine years and
arbitrary alias repair cannot pass by supplying a plausible checksum or count.

## Evidence boundary

This can supply an earlier-era external retrospective test whose outcomes were
not used in the preceding 2021/2022/2023–2026 or V5 2017 metrics. Model design
was informed by later-era findings, so this is not prospective OOS, proof of
historical pregame availability, official NBA source verification, recovered
bookmaker odds or proof of profitable betting. A source archive alone cannot
activate W/R/S. Current-era regression and exact runtime/replay checks remain
separate requirements. The locked sample and error gates are unchanged.

## Reproduction

```sh
node scripts/download-nba-opening-v6-independent-history.mjs /path/to/scratch/source-cache
node scripts/prepare-nba-opening-v6-independent-history.mjs /path/to/scratch/source-cache/opening-v6-independent-history.json
node scripts/nba-opening-v6-historical-alias-test.mjs
node scripts/nba-opening-v6-independent-evidence-test.mjs
```

The downloader retains resumable checksummed checkpoints and a persisted bound
of 1200 requests for the exact five-season scope, with eight concurrent requests
and source-size/time limits. The completed package used 966 sources and 967
download attempts. One public URL transiently returned HTTP403; a retry of the
identical public URL returned HTTP200, without changing headers, authorization
or URL. No access restriction was bypassed. New retrieval metadata must receive
a new raw-source review before any replacement pin is accepted.
