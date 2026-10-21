# Reader 2.1.42 automatic diagnostic delivery

Included in the NBA 2.1.41 score-race section fix, without changing market validation, probability, scoring or settlement rules.

- Each completed scan creates an allow-listed summary independent of market ingest. Rejected boards, empty captures, silent content scripts and upload failures can be reported without accepting invalid markets.
- Contains actual background/manifest versions, device identity from the signed token, client/server timestamps, league state, validation codes and numeric capture counts. It excludes raw DOM, page text, URLs, credentials and arbitrary server error strings. Unknown diagnostic strings become `unrecognized-issue`.
- Same-state errors are sampled at most once per minute; unchanged healthy scans every five minutes. State changes enqueue immediately. Local queue retains up to 20 reports for up to 14 days; oldest entries may be dropped when full. This is bounded diagnostic sampling, not a complete event archive.
- A separate one-minute alarm retries the queue even when market auto-sync is paused. Retry backoff grows from one to fifteen minutes. Only a durable receipt with the matching report ID removes a queued entry. Expired pairing requires re-pairing before delivery can resume. Explicit unpair clears pending reports.
- POST `/api/reader/diagnostics` requires a signed Reader token and matching `X-Device-Id`; GET requires a site session and supports `league` and `deviceId` filters. Reader tokens cannot read diagnostics. Requests are origin checked, size limited and rate limited.
- Reports use a dedicated PostgreSQL table with idempotent report IDs, a checksum and a 14-day retention window. It cannot modify market snapshots or analysis results. No memory-only success receipt is allowed.
- `/reader-diagnostics` shows received reports on desktop and mobile; the extension shows pending/sent status and links to this authenticated page. Manual JSON download remains available as a fallback.

Unattended receipt does not mean unattended source modification. Debugging and changes occur in an active authorized work session. Reader must be installed and running; a completely stopped/offline device cannot send new reports.

Acceptance must separately record local/CI tests, build, deployed API/DB/UI checks and receipt from the user's updated Chrome Reader. Missing live verification must remain NOT VERIFIED.
