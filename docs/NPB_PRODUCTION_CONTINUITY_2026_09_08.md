# NPB Production continuity, 2026-09-08

Baseline: main 957f922eacf8b7c4858a4f8cc54f3d43dcef033c, Production deployment dpl_8nos9Z8JZRgmHuP2i6D1Zb7rVEm7, app 11.9.23.

## Reproduced defect and change

The official-provider acquisition for CHU–YOM (575837198996336) retained legacy identityConfirmed=true while both starter IDs were null and the actual input used NPB_OFFICIAL_PRIOR_STARTS_ROTATION_FORECAST_PIT. The UI repeated the legacy summary as CONFIRMED. This acquisition was after first pitch and is diagnostic only, not pregame evidence.

Derive NPB display status from the frozen game's league/date/teams, starter ID, identity readiness, conflicts and projection provenance. Preserve those fields through compact transport. Older incomplete contexts remain unverified. The presentation never rewrites saved inputs/results; model distributions, scores, thresholds, rules and other league status paths are unchanged.

Regression covers missing ID, projection, full/compact consistency, immutable inputs, cross-game/date/team/league conflicts and other league isolation. It is included in the existing npm pretest through reader-revalidation-personnel-test.mjs.

## Actual pre-deployment Production evidence

- NPB schedule/provider returned six games for 2026-09-08.
- Authenticated snapshot API returned eight saved FULL snapshots for CHU–YOM. Latest suffix: 4c8df4eab9a953f8193a33e13c27a233e680fd7ee4dbd8b20cb548d699c35917.
- Audit of that snapshot: envelope/identity/parent-chain integrity CONFIRMED; bound source timing VERIFIED; 26/26 immutable source contents loaded, write/readback VERIFIED; eight market rows had deltaW=deltaR=0; current-engine distribution matched. Original archived engine replay remains unavailable and calibration remains UNVALIDATED_SHADOW. These results do not establish prediction accuracy or universal source completeness.
- UI: league switch to NPB and synchronization completed. Today's games had started; the UI removed waiting cards and reported no eligible pregame games. NPB Reader was expired. A new fresh-Reader full-analysis/reprice flow therefore cannot be certified from this session.
- Native keyboard date editing updated state. Browser fill alone did not reliably commit the native date control; a subsequent browser timeout interrupted the full date-sync verification. Do not mark that operation or mobile verification PASS based on code inspection.
- Production settlement warning for 2026-09-04 CHU–YAK corresponds to the official club's 1–1 rain-shortened ten-inning final (https://www.yakult-swallows.co.jp/game/result/2021039373). Preserve manual review under the locked twelve-inning draw contract; do not force automatic settlement or alter rules.

Local final-tree npm test and npm run build exited successfully. Deployment and post-deployment acceptance evidence belong in the associated PR; pending steps must remain explicitly pending.
