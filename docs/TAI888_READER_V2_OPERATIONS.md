# Tai888 Reader v2 operations

## Required Production environment

- `READER_PAIR_SECRET`
- `APP_PASSWORD`
- `SESSION_SECRET`

`READER_PAIR_SECRET` must be independent. Reader pairing never uses `TAI888_PASSWORD`, and the website session never uses either Tai888 credential. `JBOT_API_TOKEN` or `THE_ODDS_API_KEY` is optional when a separate reference market is desired. Secret values must remain server-side and are never committed.

Reader 2.1.0+ is required for NPB, KBO and CPBL; MLB retains Reader 2.0.3+ compatibility during migration. Reader 2.1.1 automatically selects one authoritative usable tab when duplicate tabs show the same league; price movement in an ignored duplicate tab does not block that league, while conflicting frames inside the selected tab still fail closed. Every ingest must include valid `observedAt`, fresh `pageActivityAt`, `expectedGameCount`, and `detectedGameCount`; the submitted board counts must agree. Every visible game must map one-to-one to that league's official Taipei board-date slate, including doubleheaders. A visible open game must contain exactly four markets/eight executable directions; any visible partial game rejects the entire batch without replacing the previous snapshot. An official game that Tai888 has not presented, or has fully locked, remains non-executable and is never filled with invented prices.

## Normal state

- Desktop is awake.
- Chrome is running.
- Tai888 remains logged in and the intended MLB, NPB, KBO and/or CPBL boards remain open.
- Keep at most one current authoritative tab per league. Close or refresh duplicate/old same-league tabs if Reader reports a conflict; more than four Tai888 tabs in total is rejected.
- Reader popup shows paired/automatic sync active.
- Baseball EV shows a fresh Reader timestamp and the expected matched count for the selected league. Asian-league cards remain marked shadow and never show betting controls.

## Degraded state

- Tai888 logged out or a league page moved away from its board: Reader reports no valid board for that league.
- Reader/desktop offline: snapshots become stale and Baseball EV warns instead of presenting them as current.
- International reference source unavailable: existing Reader snapshot remains separately labeled; it is not relabeled as a reference market.
- Runtime Cache unavailable in Production: ingest returns 503 and does not update process memory or report success. Explicit local/test memory-only mode remains process-local.
- Runtime Cache has no atomic compare-and-swap across regions. Operate only one Reader writer; use a persistent database with conditional writes before enabling concurrent Readers.

## Recovery

1. Restore the intended Tai888 league board page(s) and login.
2. Open the Reader popup and use “sync now” once.
3. Verify the Reader timestamp/game count in Baseball EV for each selected league.
4. If pairing expired, pair again; do not copy browser cookies or sessions.
