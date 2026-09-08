# MLB diagnostic presentation correction

This change separates historical input quality from projected starter innings,
and moves whole-team pitching diagnostics out of the pure-relief display.
The saved report is copied for presentation; old snapshots are never rewritten.

New contexts retain the existing expectedInningsStatus used by quality gates,
and add an independent PROJECTED calculation receipt with the selected branch,
raw innings/starts, fallback, role and bounds. Old receipts do not acquire invented
branch evidence. No W/R, S, ranking, uncertainty or pitching weights are changed.

OPS sensitivity notes explain the split OPS / team OPS denominator and per-unit
slopes. This explains a possible negative slope, not empirical model validation.
External validation explains preserved rejection evidence; generic missing-price
records do not fabricate provider configuration, HTTP failures or closure causes.

Targeted tests check report immutability and equality of run profiles with and
without the new receipt. The original MLB 824792 snapshot and nine-player source
replay remain unverified because authenticated browser access was unavailable
during investigation. Deployment and live UI acceptance must be reported separately.
