# Reader receipt inventory

This diagnostic counts and validates only Reader receipts visible to one database statement for an EPL or UCL board date. It does not establish game identity, market pairings, historical completeness, calibration, or W/R/S. Original Reader, betting, and analysis records are never changed by this feature.

For each new snapshot, the client generates a cryptographically random 24-byte value encoded as 48 lowercase hexadecimal characters and stores it before sending an authenticated same-origin POST to `/api/soccer/reader-inventory-scan`:

```json
{"action":"start","league":"ucl","date":"2026-10-21","cursor":"<48 hexadecimal characters>"}
```

Retrying the same start request returns that exact existing manifest and current progress. To obtain a later snapshot use a new cursor; data committed after the old snapshot is never claimed to be in it. Continue using the same cursor, league, and date in POST bodies with `"action":"continue"` until status is `COMPLETE` or `PARTIAL`. Do not place cursors in URLs, application logs, or shared reports. A `PARTIAL` result gives a reason and is not a complete inventory. Counts apply only to records visible at the manifest statement, not all historical receipts. An individual receipt exceeding the byte budget ends the scan as partial; it is not silently skipped.

Each league/date defaults to at most 30 retained manifests, including partial manifests. An operator may configure `SOCCER_READER_INVENTORY_MAX_SCANS_PER_SCOPE` to an integer from 1 to 1000. An exhausted limit yields `READER_MANIFEST_SCOPE_BUDGET`, unknown counts and no new manifest. Retrying an existing cursor remains available at the limit. Raising the setting requires appropriate storage capacity; scans and immutable manifest items are not automatically deleted. Current database guards protect immutable manifest fields/items and enforce monotonic progress, but do not prevent an actor with direct privileged database write access from falsifying progress; restrict that access operationally.

The row limit bounds returned manifest items, not the cost of finding and sorting source rows. Before large-scale use, inspect the Production query plan and assess an appropriate index using a deployment procedure that does not block source writes. The browser stores local continuation references; clearing browser storage or using concurrent tabs can make references unavailable locally even though the database manifests remain retained.

Authenticated same-origin `list` and `resume` POST operations recover retained manifests after a browser loses its local index. They are scoped to one league and board date and expose only validated summaries and an opaque, domain-separated HMAC identifier, never the internal cursor, source payload, or device information. This application uses shared site authentication, not per-user accounts; any signed-in site user can access summaries in that scope. The HMAC uses the existing `SESSION_SECRET` and fails closed if it is not configured. After that secret rotates, sign in again and list the scope again to obtain new identifiers for the same retained manifests; an old identifier does not create a new manifest or grant access.
