# Multi-league architecture

The website is one authenticated product with four isolated league modules:
MLB, NPB, KBO and CPBL.

`lib/leagues.js` is the authoritative capability registry. A league may expose
schedule, Reader, analysis and ranking only after each dependency has passed
its own fixture, identity, time, market-completeness and model-calibration
tests. A disabled capability must fail closed in the UI and API; the system
must never reuse MLB data, team identities, schedule adapters, Reader parsing
or model probabilities for another league.

MLB remains the only production-enabled module in the first multi-league
foundation release. NPB, KBO and CPBL have independent navigation and storage
identity but stay explicitly unavailable until their real Tai888 pages and
authoritative schedule/model inputs are verified.

Each future league activation requires:

1. an authoritative schedule adapter with Taipei-date and game-identity tests;
2. Tai888 DOM fixtures for four markets and eight directions;
3. league-specific team aliases, doubleheader handling and start-time gates;
4. a separate model/version family and calibration report;
5. Reader snapshot keys namespaced by league and date;
6. end-to-end tests proving that no payload can cross league boundaries.

