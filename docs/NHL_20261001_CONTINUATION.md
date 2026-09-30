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

## Verification and limits

- Full `npm test`: PASS, including NHL/NBA and existing baseball suites.
- Production build: PASS; rechecked after the research diagnostics display.
- Personnel parser, confirmation identity and actual client handlers: PASS.
- Shot research: 20 groups PASS on the retained 215-game report before expansion.
- Real CONFIRMED-goalie transitions, historical pregame personnel snapshots,
  physical-phone testing, and real Tai888 NHL contracts remain unverified.
- Full-season source acquisition does not establish predictive calibration.

This release does not change score-model, settlement, EV/S or wagering execution.
