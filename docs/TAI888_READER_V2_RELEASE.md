# Tai888 Reader 2.0 / MLB EV 9.4.0

## Goal

A user-authenticated desktop Chrome session displays the Tai888 MLB board. The Reader reads only the visible MLB market DOM, normalizes the four supported markets, and securely pushes a versioned snapshot to MLB EV. It does not log in, read credentials/cookies/session, bypass Cloudflare, or place bets.

## Data flow

1. Tai888 page DOM -> Reader parser.
2. Reader pairing -> short-lived device token.
3. Signed/idempotent ingest -> Runtime Cache snapshot.
4. MLB EV `/api/credit-lines` -> fresh Reader snapshot.
5. First analysis -> frozen full-game and first-five joint score distributions.
6. Later price-only changes -> `/api/reprice`, keeping the same distribution and recalculating settlement, EV, robust EV and deterministic score.
7. Core baseball-data changes -> normal full analysis/version path.

## Safety and freshness

- Only `www1.tai888.in` and `mlb-positive-ev.vercel.app` are in extension host permissions.
- Account/balance/password/session text is filtered client-side and server-side.
- Device tokens expire and are bound to a reader ID.
- Replayed or duplicate payload hashes are idempotent.
- Reader snapshots carry observed/received timestamps, content hash and game count.
- Stale or offline snapshots are not treated as executable current prices.
- No betting controls are read or operated.

## Versions

- Website: 9.4.0
- Extension: 2.0.0
- Reader API/parser/store versions are returned by health/status endpoints and included in stored snapshots.
