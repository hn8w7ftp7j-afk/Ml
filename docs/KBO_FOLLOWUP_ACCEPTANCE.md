# KBO follow-up acceptance boundaries

Base: f77eedbf0caaec372dcdcf1ed7eeee8a5719e94d.

## Implemented in this change

- Starter seasons disclose observedBattersFaced separately from effectiveBattersFaced. Missing reported BF uses the existing inningsPitched * 4.25 estimate, with input, coefficient, consumers and status recorded. Fractional reported counts are INVALID_REPORTED_COUNT, never labelled observed or silently rounded.
- The legacy battersFaced value remains an effective-sample compatibility field. No numerical input, mean, uncertainty formula, W/R/S, locked settlement or ranking policy is changed. A breaking schema migration needs a separately versioned replay/transport migration.
- Tests exercise the existing uncertainty function directly: in its unsaturated region replacing 374.85 with 375 shifts sigma by -0.15/12000 = -0.0000125, holding other inputs fixed. This is a synthetic sensitivity check, NOT a claim that 375 is the correct official value or an estimate of the resulting R/S shift.
- Source acquisition audit covers all supplied feature nodes, not only the fixed baseline list. A bound statistics cutoff after inputCutoffAt fails even when the response was fetched earlier.
- Field traceability remains separately PENDING. Valid hashes and receipt times do not establish correct raw-field selection, transformations or predictive validity.

## Remaining evidence-dependent work (not accepted)

1. Minimal raw-field mapping and independent parser replay for every actual mean/uncertainty/settlement input. The conservative source groups are not equivalent to this. Obtain the frozen source payloads and transformation mappings; do not invent historical records.
2. KBO lineup, relief usage, injury and split coverage. A projected or missing source must remain disclosed; no fabricated actual lineup/usage is substituted.
3. Written effective Tai888 settlement terms covering rebate eligibility, void/postponement and partial settlement. The current implementation rebates settled win/loss principal, not returned principal. Non-normal finals go to manual review in bet-settlement-service.js; no new automatic void rule is introduced.
4. Archived Asian engine and historical dependencies/configuration for original replay. Current-engine comparison is not original replay.
5. Dated out-of-sample KBO predictions/results and frozen settings for independent distribution, W/R/S and model-performance acceptance. Passing software tests is not this evidence.

The shadow eligibility state is unchanged. This change does not certify KBO as complete or authorize real-money execution.
