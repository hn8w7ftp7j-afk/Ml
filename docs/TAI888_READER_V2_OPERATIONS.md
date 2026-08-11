# Tai888 Reader v2 operations

## Required Production environment

- `THE_ODDS_API_KEY`
- `TAI888_PASSWORD` or a dedicated `READER_PAIR_SECRET`

A dedicated `READER_PAIR_SECRET` is preferred. If absent, the Reader pairing endpoint can use the already configured server-side Tai888 password as a compatibility fallback. Secret values must remain server-side and are never committed.

## Normal state

- Desktop is awake.
- Chrome is running.
- Tai888 remains logged in and the MLB board remains open.
- Reader popup shows paired/automatic sync active.
- MLB EV shows a fresh Reader timestamp and non-zero matched game count.

## Degraded state

- Tai888 logged out or page moved away from MLB: Reader reports no valid board.
- Reader/desktop offline: snapshot becomes stale and MLB EV warns instead of presenting it as current.
- International reference source unavailable: existing Reader snapshot remains separately labeled; it is not relabeled as a reference market.
- Runtime Cache unavailable: local/test memory fallback works only within one runtime and health/status exposes the degraded state.

## Recovery

1. Restore the Tai888 MLB page and login.
2. Open the Reader popup and use “sync now” once.
3. Verify the Reader timestamp/game count in MLB EV.
4. If pairing expired, pair again; do not copy browser cookies or sessions.
