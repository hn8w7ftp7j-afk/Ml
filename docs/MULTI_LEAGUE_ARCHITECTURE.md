# Multi-league architecture

The website is one authenticated product with four isolated league modules:
MLB, NPB, KBO and CPBL.

`lib/leagues.js` is the authoritative capability registry. A league may expose
schedule, Reader, analysis and ranking only after each dependency has passed
its own fixture, identity, time, market-completeness and model-calibration
tests. A disabled capability must fail closed in the UI and API; the system
must never reuse MLB data, team identities, schedule adapters, Reader parsing
or model probabilities for another league.

MLB is the only formal, bet-eligible module. NPB, KBO and CPBL are enabled in
Production as `EXPERIMENTAL_SHADOW` modules: each uses its own official schedule
adapter, Tai888 aliases, Reader namespace, model configuration and version
family, and may display the complete four-market/eight-direction diagnostic
analysis and ranking. The server always forces their analyses to
`executable=false`, `betEligible=false` and `portfolio=[]`; they cannot create
bet records or fall back to an MLB schedule, identity, cache or model snapshot.

Moving any shadow league to formal, bet-eligible status requires:

1. an authoritative schedule adapter with Taipei-date and game-identity tests;
2. Tai888 DOM fixtures for four markets and eight directions;
3. league-specific team aliases, doubleheader handling and start-time gates;
4. a separate model/version family plus an out-of-sample calibration report;
5. Reader snapshot keys namespaced by league and date;
6. end-to-end tests proving that no payload can cross league boundaries.
