# Official KBO innings and starts

Base: 550ee4f85d577361ac382a27e8ab9fc4cd692685.

The identified current-season Basic.aspx summary supplies G (appearances) and IP. Exact outs are parsed from integer or mixed-third notation, not decimal arithmetic: 100 1/3 = 301 outs. Decimal strings such as 4.2 are rejected for this specific official HTML field. The old rounded-average product remains only a labelled estimate if official acquisition fails; after success it is retained separately as estimatedInningsPitched and is not the actual innings field.

GameCenter's generic count no longer populates gamesStarted. Starts are counted only from the full Daily.aspx regular-season rows whose role is exactly 선발; 구원 is relief. Player ID, profile name, current team, selected year and regular-season selector must match. The row count, sum of TBF and sum of exact outs must match the independently parsed season summary. Missing, duplicate-date, same-day, future, malformed or unknown-role rows prevent confirmation. Same-day doubleheader reconstruction without game IDs is intentionally not inferred.

Daily failure leaves verified TBF/IP intact and gamesStarted unknown. Each accepted field retains its source event, raw-content hash and path; starts also bind the season-summary receipt used for reconciliation. Live cumulative acquisition is pregame/current-season only; saved historical inputs are not backfilled. No scoring, settlement, Tai888 role or expected-innings formula is changed. Production features advance to v1.0.4.

Read-only official-page check on 2026-09-08: player 51264's summary returned G=21, TBF=461, IP=100 1/3; all daily rows reconciled to 301 outs and 21 starts. This is not proof of what any earlier saved analysis knew. Synthetic mixed-role tests verify G=21 can correctly yield GS=10, plus partial-source failures, year/series mismatch and reconciliation failures. Full KBO model-performance acceptance remains separate.
