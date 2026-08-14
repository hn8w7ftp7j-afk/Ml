# Tai888 Reader v2 operations

## Required Production environment

- `READER_PAIR_SECRET`
- `APP_PASSWORD`
- `SESSION_SECRET`

`READER_PAIR_SECRET` must be independent. Reader pairing never uses `TAI888_PASSWORD`, and the website session never uses either Tai888 credential. `JBOT_API_TOKEN` or `THE_ODDS_API_KEY` is optional when a separate reference market is desired. Secret values must remain server-side and are never committed.

Reader 2.0.3 is the minimum accepted client. Every ingest must include valid `observedAt`, fresh `pageActivityAt`, `expectedGameCount`, and `detectedGameCount`. Both counts must equal the submitted games and the complete official Taipei board-date slate. Every game must map one-to-one (including doubleheaders) and contain exactly four markets/eight executable directions; partial boards are rejected without replacing the previous snapshot.

## Normal state

- Desktop is awake.
- Chrome is running.
- Tai888 remains logged in and the MLB board remains open.
- Keep one current Tai888 MLB board tab; close or refresh duplicate/old tabs if Reader reports a cross-tab conflict. More than four Tai888 tabs is rejected.
- Reader popup shows paired/automatic sync active.
- MLB EV shows a fresh Reader timestamp and non-zero matched game count.

## Degraded state

- Tai888 logged out or page moved away from MLB: Reader reports no valid board.
- Reader/desktop offline: snapshot becomes stale and MLB EV warns instead of presenting it as current.
- International reference source unavailable: existing Reader snapshot remains separately labeled; it is not relabeled as a reference market.
- Runtime Cache unavailable in Production: ingest returns 503 and does not update process memory or report success. Explicit local/test memory-only mode remains process-local.
- Runtime Cache has no atomic compare-and-swap across regions. Operate only one Reader writer; use a persistent database with conditional writes before enabling concurrent Readers.

## Recovery

1. Restore the Tai888 MLB page and login.
2. Open the Reader popup and use “sync now” once.
3. Verify the Reader timestamp/game count in MLB EV.
4. If pairing expired, pair again; do not copy browser cookies or sessions.
