# NHL continuation — 2026-10-01 Taipei

The prior chat reached its length limit. Resume from the existing repository and
Production, without replacing concurrent MLB/NBA work or changing wagering rules.
Initial verified baseline was main/Production `8a4a70a` (11.9.46); main `4591551`
(11.9.47) was merged before this release, retaining its goalie-identity fixes.

## Reproduced and repaired

- The official 2026-09-30 lineup article appended W-L-OT records to matchup
  headings. All three current games incorrectly returned `NO_MATCHING_GAME`.
  Strip only the exact numeric record suffix and retain exact team matching.
- The same official article listed Colorado with 11 forwards and 7 defensemen.
  Classifying two names as defense and a single name as a goalie quarantined
  valid personnel. Classify using verified official positions and preserve
  forward/defense/goalie section order. Mixed positions and unresolved IDs still
  block; nonstandard group sizes remain explicitly warned.
- Schedule, game and roster handlers could set visible state before storage
  rejected nested foreign-league/date/season identities. Validate before display
  and retain the prior valid result. Three actual-handler regression groups
  failed before the repair and pass afterward.

Local real-source verification of game `2026020007` returned LAK 12F/6D/2G and
COL 11F/7D/2G, no identity issues, with both goalies PROJECTED. Article revision
`2026-09-30T18:34:11.014Z`, acquired `2026-09-30T18:54:31.029Z`, SHA-256
`7443d14cacf6b68955f770304686d3e7619672d86aaadc9ced8079dabb886c06`.
Identity sources were official roster and club-statistics endpoints for the exact
teams/20262027/regular-season scope, acquired before puck drop. This local check
does not by itself establish Production persistence or a confirmed-goalie change.
The signed-in Production UI separately reproduced the old no-match bug at 03:02
Taipei. Post-release results must be added only after observation.

PR #285 passed the full Verify workflow (36764698643) and merged as `6da0fdc`.
Production deployment `dpl_Gd2DzfidQYHvBiCaQhWHjcm6Xxn7` was READY; both the
signed-in NHL page and `/api/health` read back 11.9.48. At 03:24 Taipei the real
LAK/COL article now displayed the verified 12F/6D and 11F/7D groups, both goalies
still PROJECTED, and acquisition before puck drop.

That live check exposed a second defect: the snapshot validator still rejected
short forward/defense groups. The real retained source reproduced
`NHL_PERSONNEL_SNAPSHOT_LINE_INVALID` and catalog mismatch. The validator now
accepts nonempty groups up to the positional maximum only with the parser's
explicit nonstandard-lineup warning. Empty, oversized, mixed-position and
warning-stripped groups remain rejected. The same retained official source
passes snapshot validation after the repair; actual Production write/read-back
remains a separate deployment check.

Full replayable shot reports now use a lossless gzip archive with compressed and
uncompressed SHA-256 checks. Training IDs and all numerical fields are retained;
this changes storage only, with full round-trip and corruption regressions.

## Historical source completion

Resumed the original 1,312-game regular-season manifest with existing verified
checkpoints, at most two requests in flight, at least two seconds between request
starts, and the existing 403/429 stop policy. Restored all 216 old compressed
checkpoints locally and verified their exact original SHA-256 bytes.

Source acquisition and research eligibility remain separate. Two retained real
examples have official SOG 36 vs event count 37 (`2023020068`, team 13), and
38 vs 39 (`2023020090`, team 21). A fresh official read still showed each conflict.
They remain excluded; diagnostics now retain the compared totals. The UI separates
missing responses from acquired responses that fail QA. Final counts belong to
the completed manifest and regenerated report, not an intermediate progress log.

Acquisition completed on 2026-09-30 UTC: all **1,312/1,312** official responses
retained, **1,298** QA-eligible games, **14** quarantined total mismatches, no
missing checkpoint and no provider stop. All 14 mismatches have matching goals
and event SOG exactly one above official SOG; their causes are not established.
No count is silently adjusted to force agreement. The archive round-trip verified
1,311 responses in 14 chunks (19,615,166 bytes), alongside the separately retained
original `2023020001` source. The acquisition command's nonzero exit records
research ineligibility, not an incomplete download.

The regenerated report (2026-09-30T19:31:38.446Z) retains the existing 20-game
initial training threshold, 10-game held-out blocks and 48-hour embargo. All
four strength reports have zero `FIT_NOT_CONVERGED` exclusions; every published
fit retains the original absolute gradient tolerance below 1e-8.

| Strength | Evaluated games | Held-out shots | Brier | Constant baseline Brier |
| --- | ---: | ---: | ---: | ---: |
| 5V5 | 1,258 | 85,854 | 0.053230 | 0.056185 |
| PP | 1,258 | 15,968 | 0.085341 | 0.087622 |
| PK | 1,046 | 2,657 | 0.062661 | 0.068394 |
| OTHER_EVEN_STRENGTH | 571 | 2,297 | 0.098537 | 0.102127 |

The source-complete flag is true; QA-complete season coverage, pregame PIT and
Production calibration remain false. These are conditional-on-observed-shot
results, not a forecast of future shot volume or wagering performance.

## Verification and limits

- Full `npm test`: PASS, including NHL/NBA and existing baseball suites.
- Production build: PASS; rechecked after the research diagnostics display.
- Personnel parser, confirmation identity and actual client handlers: PASS.
- Shot research: 20 groups PASS on the retained 215-game report before expansion.
- Real CONFIRMED-goalie transitions, historical pregame personnel snapshots,
  physical-phone testing, and real Tai888 NHL contracts remain unverified.
- Full-season source acquisition does not establish predictive calibration.

This release does not change score-model, settlement, EV/S or wagering execution.
