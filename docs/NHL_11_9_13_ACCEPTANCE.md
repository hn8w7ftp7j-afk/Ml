# NHL deployed acceptance and source-absence follow-up

## Shipped engineering

PR #184 merged as `b3ce25328932e18e071fdf705645918437491654` into the existing
`hn8w7ftp7j-afk/Ml` repository and existing Production project `mlb-ev`.
Deployment `dpl_D87YR56JFBoT5dACV8Yg5Qazt1xi` reached READY and the existing
`https://mlb-positive-ev.vercel.app/nhl` displayed 11.9.11.
GitHub Verify run `34063702015` passed all jobs, including PostgreSQL settlement
recovery, full regression, dependency audit, build and Reader packaging.

The earlier `NHL_11_9_11_VALIDATION.md` is a chronological pre-merge checkpoint;
its pending deployment fields are superseded by this observed record and the
acceptance comments on the release PRs, not by assumptions.

## Actual browser observations on deployed NHL code

- Official Taipei 2026-06-15 schedule: game 2025030416, CAR 12 at VGK 54,
  08:00 Taipei / 20:00 previous date America/New_York, final 3–0.
- Personnel: eight projected forward lines, six defensive pairs, projected
  Bussi/Hart with official IDs; Karlsson injury displayed. Three unresolved
  source names remain quarantined, stale and retrospective warnings visible.
- Personnel snapshot permanently saved and read back as one version;
  revision `8f93538bcc0562770206cd7784beaeb0550126f6c1cbd3e146cdf16eac98baf9`.
  This does not establish a real CONFIRMED-goalie transition or historical PIT.
- Started game refresh, left through MLB, switched NPB/KBO/CPBL and returned:
  NHL schedule, game and personnel remained; refreshed game source time advanced.
  Full reload also recovered the saved schedule and selected game.
- NHL historical endpoint displayed 1,312 complete regular outcomes/periods,
  32 teams, 1,194 chronological score folds, separate 270 validation / 260 test;
  preseason and playoff coverage stayed separate.
- Research displayed 217 retained event responses, 215 eligible games and
  incomplete full-season QA; 5v5 175 held-out games / 11,680 shots.
- Game 2024020001 observed-shot API returned frozen-model 5v5 research xGF
  1.674 / 1.925, 74 eligible observed shots; no request-time fitting or pregame
  prediction claim. Source and artifact hashes were displayed.
- Today (Taipei 2026-09-07) returned a visible zero-game state and unlocked
  manual buttons, not a blank screen or permanent loading state.
- Official NSH 2023–24 roster and team summary loaded: 82 games, 47 wins,
  PP 21.56%, PK 76.92%, with team/season/phase evidence.
- Filip Forsberg's official player page loaded the correct player ID and
  season/phase-separated career statistics. The rest/schedule-density action
  returned its descriptive result and kept travel unknown without coordinates.
- The existing update prompt offered explicit update/later choices while
  leaving completed NHL data intact; selecting later did not clear the result.
- NBA opens the existing modal workspace; after closing that modal, NHL tabs
  respond. Background controls being inert while a modal is open is expected.
- Desktop screenshot inspected; viewport and document scroll width both 1348.
  No site-origin error/warning in the captured console log; extension messages
  are distinct. This is not a physical-phone or exhaustive network certificate.

## Follow-up found during real acceptance

The older `nhl-lineup-projections-2023-24-season` official slug returns 302 with
`Location: /errors/not-found` (observed 2026-09-06 22:39 UTC). It is not a usable
canonical redirect or a transient article fetch. The follow-up classifies that
exact official not-found redirect and direct 404 as
`NHL_PERSONNEL_ARTICLE_NOT_FOUND`, retaining upstream status and existing data.
No redirect is followed, no cross-host redirect is admitted, no different
season's article is substituted, and no missing injury becomes zero/healthy.
Counterexamples cover relative/absolute official not-found, attacker host,
unrelated article redirect, direct 404 and authenticated API absence handling.

Before this follow-up, integrated main `da0dd3a39cbb3896fef53ed6e6e0ff06ff87e772`,
preserving PR #185 NBA checkpoint/resume and PR #186 settlement fixes.
Final 11.9.13 CI/deployment/acceptance evidence belongs in its PR conversation
after those actions actually finish; this file does not predeclare them PASS.

## Explicit remaining non-PASS

- 1,095 PBP games absent; two retained source SOG conflicts remain BLOCK.
- Full-season xG calibration, contemporaneous historical personnel snapshots,
  actual confirmed-goalie changes, High-Danger definitions and 5v5 exposure.
- Physical-mobile testing is not available in this browser environment.
- Tai888: **等待真實 Tai888 NHL 盤驗證**.
- Existing wagering rules, EV/S recommendations and wagering execution were
  not added/modified by this NHL engineering release.
