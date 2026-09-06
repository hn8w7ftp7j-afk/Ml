// Actual publicly retrieved NHL landing records; a limited engineering corpus.
// Outcomes are retrospective; no archived pregame feature availability is claimed.
export const NHL_HISTORICAL_SAMPLE_VERSION = "NHL-HISTORY-SAMPLE-v1.0.0";
export const NHL_HISTORICAL_SAMPLE_METADATA = {
  "version": "NHL-HISTORY-SAMPLE-v1.0.0",
  "scope": "LIMITED_RETROSPECTIVE_ENGINEERING_CORPUS",
  "completeSeasonCoverage": false,
  "pregamePointInTimeSnapshots": false,
  "calibrationValidated": false,
  "productionModelReady": false,
  "totalGames": 20,
  "seasons": [
    20232024,
    20242025
  ],
  "periodTotalsVerified": true,
  "outcomes": {
    "REG": 17,
    "SO": 1,
    "OT": 2
  },
  "sourceProvider": "NHL",
  "acquiredVia": "WEB_PUBLIC_SOURCE",
  "limitations": [
    "Selected retrievable official fixtures; incomplete schedule coverage",
    "Do not infer team rest/7-day density from this corpus",
    "No archived injury, pregame goalie or lineup publication snapshots",
    "No Tai888 historical lines; no betting profitability backtest",
    "No xG or complete 5v5 exposure data"
  ]
};
export const NHL_HISTORICAL_SAMPLES = [
  {
    "leagueId": "NHL",
    "gameId": "2023020001",
    "officialGameId": "2023020001",
    "season": 20232024,
    "gameType": 2,
    "startTimeUTC": "2023-10-10T21:30:00Z",
    "taipeiDate": "2023-10-11",
    "officialDate": "2023-10-10",
    "awayTeamId": 18,
    "homeTeamId": 14,
    "away": {
      "leagueId": "NHL",
      "teamId": 18,
      "identityKey": "NHL:team:18",
      "abbrev": "NSH",
      "name": "Nashville Predators"
    },
    "home": {
      "leagueId": "NHL",
      "teamId": 14,
      "identityKey": "NHL:team:14",
      "abbrev": "TBL",
      "name": "Tampa Bay Lightning"
    },
    "venue": "Amalie Arena",
    "venueTimezone": "US/Eastern",
    "neutralSite": false,
    "gameState": "OFF",
    "gameScheduleState": "OK",
    "final": {
      "awayGoals": 3,
      "homeGoals": 5
    },
    "outcomeType": "REG",
    "source": {
      "provider": "NHL",
      "url": "https://api-web.nhle.com/v1/gamecenter/2023020001/landing",
      "fetchedAt": "2026-09-06T02:39:28.576Z",
      "acquiredVia": "WEB_PUBLIC_SOURCE",
      "sourceUpdatedAt": null,
      "contentHash": "9b21d2acff3fb965bac6a1e83ca06ed101a7b189239f681ce85d5fd00467de46"
    },
    "seasonPhase": "REGULAR",
    "periods": [
      {
        "awayGoals": 0,
        "homeGoals": 1
      },
      {
        "awayGoals": 1,
        "homeGoals": 0
      },
      {
        "awayGoals": 2,
        "homeGoals": 4
      }
    ],
    "regulation": {
      "awayGoals": 3,
      "homeGoals": 5
    },
    "outcomeAvailableAt": null,
    "historical": true,
    "identity": {
      "ok": true,
      "status": "PASS",
      "issues": [],
      "identityKey": "NHL:2023020001:18:14:2023-10-10T21:30:00Z"
    },
    "league": "NHL",
    "northAmericaDate": "2023-10-10",
    "awayName": "Nashville Predators",
    "homeName": "Tampa Bay Lightning",
    "awayAbbrev": "NSH",
    "homeAbbrev": "TBL",
    "status": "OFF",
    "playerStatistics": {
      "away": {
        "skaters": [
          {
            "playerId": 8479996,
            "sweaterNumber": 8,
            "name": {
              "default": "C. Glass"
            },
            "position": "C",
            "goals": 0,
            "assists": 0,
            "points": 0,
            "plusMinus": 0,
            "pim": 0,
            "hits": 2,
            "powerPlayGoals": 0,
            "sog": 2,
            "faceoffWinningPctg": 0.714286,
            "toi": "15:29",
            "blockedShots": 0,
            "shifts": 17,
            "giveaways": 0,
            "takeaways": 0,
            "teamId": 18,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020001/boxscore",
              "fetchedAt": "2026-09-06T02:53:42.722Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "3e12168acbb3a39f7691580b4e7ab3721a19472b925b2b6ddc57618e8444cffb"
            }
          },
          {
            "playerId": 8476887,
            "sweaterNumber": 9,
            "name": {
              "default": "F. Forsberg"
            },
            "position": "L",
            "goals": 0,
            "assists": 2,
            "points": 2,
            "plusMinus": 0,
            "pim": 0,
            "hits": 1,
            "powerPlayGoals": 0,
            "sog": 6,
            "faceoffWinningPctg": 0,
            "toi": "20:51",
            "blockedShots": 0,
            "shifts": 22,
            "giveaways": 0,
            "takeaways": 0,
            "teamId": 18,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020001/boxscore",
              "fetchedAt": "2026-09-06T02:53:42.722Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "3e12168acbb3a39f7691580b4e7ab3721a19472b925b2b6ddc57618e8444cffb"
            }
          },
          {
            "playerId": 8476925,
            "sweaterNumber": 10,
            "name": {
              "default": "C. Sissons"
            },
            "position": "C",
            "goals": 0,
            "assists": 0,
            "points": 0,
            "plusMinus": -1,
            "pim": 2,
            "hits": 3,
            "powerPlayGoals": 0,
            "sog": 3,
            "faceoffWinningPctg": 0.615385,
            "toi": "14:45",
            "blockedShots": 1,
            "shifts": 23,
            "giveaways": 0,
            "takeaways": 0,
            "teamId": 18,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020001/boxscore",
              "fetchedAt": "2026-09-06T02:53:42.722Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "3e12168acbb3a39f7691580b4e7ab3721a19472b925b2b6ddc57618e8444cffb"
            }
          },
          {
            "playerId": 8478508,
            "sweaterNumber": 13,
            "name": {
              "default": "Y. Trenin",
              "cs": "J. Trenin",
              "fi": "J. Trenin",
              "sk": "J. Trenin"
            },
            "position": "C",
            "goals": 0,
            "assists": 0,
            "points": 0,
            "plusMinus": 0,
            "pim": 0,
            "hits": 4,
            "powerPlayGoals": 0,
            "sog": 1,
            "faceoffWinningPctg": 0,
            "toi": "13:54",
            "blockedShots": 0,
            "shifts": 18,
            "giveaways": 0,
            "takeaways": 3,
            "teamId": 18,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020001/boxscore",
              "fetchedAt": "2026-09-06T02:53:42.722Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "3e12168acbb3a39f7691580b4e7ab3721a19472b925b2b6ddc57618e8444cffb"
            }
          },
          {
            "playerId": 8474679,
            "sweaterNumber": 14,
            "name": {
              "default": "G. Nyquist"
            },
            "position": "R",
            "goals": 0,
            "assists": 1,
            "points": 1,
            "plusMinus": 0,
            "pim": 0,
            "hits": 1,
            "powerPlayGoals": 0,
            "sog": 2,
            "faceoffWinningPctg": 0,
            "toi": "14:53",
            "blockedShots": 0,
            "shifts": 20,
            "giveaways": 0,
            "takeaways": 0,
            "teamId": 18,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020001/boxscore",
              "fetchedAt": "2026-09-06T02:53:42.722Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "3e12168acbb3a39f7691580b4e7ab3721a19472b925b2b6ddc57618e8444cffb"
            }
          },
          {
            "playerId": 8481577,
            "sweaterNumber": 26,
            "name": {
              "default": "P. Tomasino"
            },
            "position": "R",
            "goals": 0,
            "assists": 1,
            "points": 1,
            "plusMinus": 0,
            "pim": 2,
            "hits": 0,
            "powerPlayGoals": 0,
            "sog": 0,
            "faceoffWinningPctg": 0,
            "toi": "13:30",
            "blockedShots": 1,
            "shifts": 18,
            "giveaways": 1,
            "takeaways": 0,
            "teamId": 18,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020001/boxscore",
              "fetchedAt": "2026-09-06T02:53:42.722Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "3e12168acbb3a39f7691580b4e7ab3721a19472b925b2b6ddc57618e8444cffb"
            }
          },
          {
            "playerId": 8482062,
            "sweaterNumber": 36,
            "name": {
              "default": "C. Smith"
            },
            "position": "R",
            "goals": 0,
            "assists": 0,
            "points": 0,
            "plusMinus": 0,
            "pim": 0,
            "hits": 2,
            "powerPlayGoals": 0,
            "sog": 1,
            "faceoffWinningPctg": 0,
            "toi": "12:52",
            "blockedShots": 0,
            "shifts": 17,
            "giveaways": 1,
            "takeaways": 2,
            "teamId": 18,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020001/boxscore",
              "fetchedAt": "2026-09-06T02:53:42.722Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "3e12168acbb3a39f7691580b4e7ab3721a19472b925b2b6ddc57618e8444cffb"
            }
          },
          {
            "playerId": 8480748,
            "sweaterNumber": 44,
            "name": {
              "default": "K. Sherwood"
            },
            "position": "L",
            "goals": 0,
            "assists": 0,
            "points": 0,
            "plusMinus": 0,
            "pim": 0,
            "hits": 2,
            "powerPlayGoals": 0,
            "sog": 1,
            "faceoffWinningPctg": 0,
            "toi": "07:54",
            "blockedShots": 0,
            "shifts": 13,
            "giveaways": 0,
            "takeaways": 0,
            "teamId": 18,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020001/boxscore",
              "fetchedAt": "2026-09-06T02:53:42.722Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "3e12168acbb3a39f7691580b4e7ab3721a19472b925b2b6ddc57618e8444cffb"
            }
          },
          {
            "playerId": 8481704,
            "sweaterNumber": 75,
            "name": {
              "default": "J. Parssinen",
              "cs": "J. Pärssinen",
              "fi": "J. Pärssinen",
              "sk": "J. Pärssinen",
              "sv": "J. Pärssinen"
            },
            "position": "C",
            "goals": 1,
            "assists": 0,
            "points": 1,
            "plusMinus": 1,
            "pim": 0,
            "hits": 0,
            "powerPlayGoals": 0,
            "sog": 2,
            "faceoffWinningPctg": 0.333333,
            "toi": "13:43",
            "blockedShots": 0,
            "shifts": 20,
            "giveaways": 0,
            "takeaways": 0,
            "teamId": 18,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020001/boxscore",
              "fetchedAt": "2026-09-06T02:53:42.722Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "3e12168acbb3a39f7691580b4e7ab3721a19472b925b2b6ddc57618e8444cffb"
            }
          },
          {
            "playerId": 8482146,
            "sweaterNumber": 77,
            "name": {
              "default": "L. Evangelista"
            },
            "position": "R",
            "goals": 0,
            "assists": 0,
            "points": 0,
            "plusMinus": 0,
            "pim": 0,
            "hits": 0,
            "powerPlayGoals": 0,
            "sog": 0,
            "faceoffWinningPctg": 0,
            "toi": "12:01",
            "blockedShots": 0,
            "shifts": 17,
            "giveaways": 2,
            "takeaways": 0,
            "teamId": 18,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020001/boxscore",
              "fetchedAt": "2026-09-06T02:53:42.722Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "3e12168acbb3a39f7691580b4e7ab3721a19472b925b2b6ddc57618e8444cffb"
            }
          },
          {
            "playerId": 8478438,
            "sweaterNumber": 82,
            "name": {
              "default": "T. Novak"
            },
            "position": "C",
            "goals": 1,
            "assists": 0,
            "points": 1,
            "plusMinus": -1,
            "pim": 0,
            "hits": 0,
            "powerPlayGoals": 1,
            "sog": 3,
            "faceoffWinningPctg": 0,
            "toi": "15:43",
            "blockedShots": 0,
            "shifts": 17,
            "giveaways": 1,
            "takeaways": 2,
            "teamId": 18,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020001/boxscore",
              "fetchedAt": "2026-09-06T02:53:42.722Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "3e12168acbb3a39f7691580b4e7ab3721a19472b925b2b6ddc57618e8444cffb"
            }
          },
          {
            "playerId": 8475158,
            "sweaterNumber": 90,
            "name": {
              "default": "R. O'Reilly"
            },
            "position": "C",
            "goals": 1,
            "assists": 1,
            "points": 2,
            "plusMinus": 0,
            "pim": 0,
            "hits": 0,
            "powerPlayGoals": 0,
            "sog": 4,
            "faceoffWinningPctg": 0.366667,
            "toi": "21:59",
            "blockedShots": 2,
            "shifts": 23,
            "giveaways": 1,
            "takeaways": 1,
            "teamId": 18,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020001/boxscore",
              "fetchedAt": "2026-09-06T02:53:42.722Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "3e12168acbb3a39f7691580b4e7ab3721a19472b925b2b6ddc57618e8444cffb"
            }
          },
          {
            "playerId": 8474568,
            "sweaterNumber": 2,
            "name": {
              "default": "L. Schenn"
            },
            "position": "D",
            "goals": 0,
            "assists": 0,
            "points": 0,
            "plusMinus": 0,
            "pim": 0,
            "hits": 5,
            "powerPlayGoals": 0,
            "sog": 0,
            "faceoffWinningPctg": 0,
            "toi": "15:11",
            "blockedShots": 1,
            "shifts": 25,
            "giveaways": 1,
            "takeaways": 0,
            "teamId": 18,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020001/boxscore",
              "fetchedAt": "2026-09-06T02:53:42.722Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "3e12168acbb3a39f7691580b4e7ab3721a19472b925b2b6ddc57618e8444cffb"
            }
          },
          {
            "playerId": 8478468,
            "sweaterNumber": 3,
            "name": {
              "default": "J. Lauzon"
            },
            "position": "D",
            "goals": 0,
            "assists": 0,
            "points": 0,
            "plusMinus": 1,
            "pim": 2,
            "hits": 3,
            "powerPlayGoals": 0,
            "sog": 1,
            "faceoffWinningPctg": 0,
            "toi": "13:21",
            "blockedShots": 0,
            "shifts": 23,
            "giveaways": 0,
            "takeaways": 1,
            "teamId": 18,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020001/boxscore",
              "fetchedAt": "2026-09-06T02:53:42.722Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "3e12168acbb3a39f7691580b4e7ab3721a19472b925b2b6ddc57618e8444cffb"
            }
          },
          {
            "playerId": 8475197,
            "sweaterNumber": 22,
            "name": {
              "default": "T. Barrie"
            },
            "position": "D",
            "goals": 0,
            "assists": 0,
            "points": 0,
            "plusMinus": -1,
            "pim": 0,
            "hits": 0,
            "powerPlayGoals": 0,
            "sog": 1,
            "faceoffWinningPctg": 0,
            "toi": "21:18",
            "blockedShots": 0,
            "shifts": 24,
            "giveaways": 0,
            "takeaways": 0,
            "teamId": 18,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020001/boxscore",
              "fetchedAt": "2026-09-06T02:53:42.722Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "3e12168acbb3a39f7691580b4e7ab3721a19472b925b2b6ddc57618e8444cffb"
            }
          },
          {
            "playerId": 8474151,
            "sweaterNumber": 27,
            "name": {
              "default": "R. McDonagh"
            },
            "position": "D",
            "goals": 0,
            "assists": 1,
            "points": 1,
            "plusMinus": 1,
            "pim": 0,
            "hits": 0,
            "powerPlayGoals": 0,
            "sog": 2,
            "faceoffWinningPctg": 0,
            "toi": "20:48",
            "blockedShots": 2,
            "shifts": 27,
            "giveaways": 0,
            "takeaways": 1,
            "teamId": 18,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020001/boxscore",
              "fetchedAt": "2026-09-06T02:53:42.722Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "3e12168acbb3a39f7691580b4e7ab3721a19472b925b2b6ddc57618e8444cffb"
            }
          },
          {
            "playerId": 8478851,
            "sweaterNumber": 45,
            "name": {
              "default": "A. Carrier"
            },
            "position": "D",
            "goals": 0,
            "assists": 0,
            "points": 0,
            "plusMinus": 1,
            "pim": 0,
            "hits": 0,
            "powerPlayGoals": 0,
            "sog": 0,
            "faceoffWinningPctg": 0,
            "toi": "20:39",
            "blockedShots": 2,
            "shifts": 29,
            "giveaways": 0,
            "takeaways": 0,
            "teamId": 18,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020001/boxscore",
              "fetchedAt": "2026-09-06T02:53:42.722Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "3e12168acbb3a39f7691580b4e7ab3721a19472b925b2b6ddc57618e8444cffb"
            }
          },
          {
            "playerId": 8474600,
            "sweaterNumber": 59,
            "name": {
              "default": "R. Josi"
            },
            "position": "D",
            "goals": 0,
            "assists": 0,
            "points": 0,
            "plusMinus": -2,
            "pim": 4,
            "hits": 0,
            "powerPlayGoals": 0,
            "sog": 2,
            "faceoffWinningPctg": 0,
            "toi": "25:37",
            "blockedShots": 1,
            "shifts": 25,
            "giveaways": 0,
            "takeaways": 0,
            "teamId": 18,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020001/boxscore",
              "fetchedAt": "2026-09-06T02:53:42.722Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "3e12168acbb3a39f7691580b4e7ab3721a19472b925b2b6ddc57618e8444cffb"
            }
          }
        ],
        "goalies": [
          {
            "playerId": 8480947,
            "sweaterNumber": 32,
            "name": {
              "default": "K. Lankinen"
            },
            "position": "G",
            "evenStrengthShotsAgainst": "0/0",
            "powerPlayShotsAgainst": "0/0",
            "shorthandedShotsAgainst": "0/0",
            "saveShotsAgainst": "0/0",
            "evenStrengthGoalsAgainst": 0,
            "powerPlayGoalsAgainst": 0,
            "shorthandedGoalsAgainst": 0,
            "pim": 0,
            "goalsAgainst": 0,
            "toi": "00:00",
            "starter": false,
            "shotsAgainst": 0,
            "saves": 0,
            "teamId": 18,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020001/boxscore",
              "fetchedAt": "2026-09-06T02:53:42.722Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "3e12168acbb3a39f7691580b4e7ab3721a19472b925b2b6ddc57618e8444cffb"
            },
            "confirmationScope": "OBSERVED_GAME_PARTICIPATION",
            "pregameConfirmed": false
          },
          {
            "playerId": 8477424,
            "sweaterNumber": 74,
            "name": {
              "default": "J. Saros"
            },
            "position": "G",
            "evenStrengthShotsAgainst": "21/23",
            "powerPlayShotsAgainst": "8/10",
            "shorthandedShotsAgainst": "0/0",
            "saveShotsAgainst": "29/33",
            "savePctg": 0.878788,
            "evenStrengthGoalsAgainst": 2,
            "powerPlayGoalsAgainst": 2,
            "shorthandedGoalsAgainst": 0,
            "pim": 0,
            "goalsAgainst": 4,
            "toi": "57:16",
            "starter": true,
            "decision": "L",
            "shotsAgainst": 33,
            "saves": 29,
            "teamId": 18,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020001/boxscore",
              "fetchedAt": "2026-09-06T02:53:42.722Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "3e12168acbb3a39f7691580b4e7ab3721a19472b925b2b6ddc57618e8444cffb"
            },
            "confirmationScope": "OBSERVED_GAME_PARTICIPATION",
            "pregameConfirmed": false
          }
        ]
      },
      "home": {
        "skaters": [
          {
            "playerId": 8476822,
            "sweaterNumber": 11,
            "name": {
              "default": "L. Glendening"
            },
            "position": "C",
            "goals": 0,
            "assists": 0,
            "points": 0,
            "plusMinus": 0,
            "pim": 0,
            "hits": 1,
            "powerPlayGoals": 0,
            "sog": 1,
            "faceoffWinningPctg": 0.692308,
            "toi": "14:01",
            "blockedShots": 2,
            "shifts": 23,
            "giveaways": 0,
            "takeaways": 0,
            "teamId": 14,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020001/boxscore",
              "fetchedAt": "2026-09-06T02:53:42.722Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "3e12168acbb3a39f7691580b4e7ab3721a19472b925b2b6ddc57618e8444cffb"
            }
          },
          {
            "playerId": 8477426,
            "sweaterNumber": 20,
            "name": {
              "default": "N. Paul"
            },
            "position": "L",
            "goals": 2,
            "assists": 1,
            "points": 3,
            "plusMinus": 1,
            "pim": 0,
            "hits": 2,
            "powerPlayGoals": 2,
            "sog": 3,
            "faceoffWinningPctg": 0.272727,
            "toi": "16:12",
            "blockedShots": 1,
            "shifts": 19,
            "giveaways": 2,
            "takeaways": 1,
            "teamId": 14,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020001/boxscore",
              "fetchedAt": "2026-09-06T02:53:42.722Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "3e12168acbb3a39f7691580b4e7ab3721a19472b925b2b6ddc57618e8444cffb"
            }
          },
          {
            "playerId": 8478010,
            "sweaterNumber": 21,
            "name": {
              "default": "B. Point"
            },
            "position": "C",
            "goals": 0,
            "assists": 3,
            "points": 3,
            "plusMinus": 1,
            "pim": 0,
            "hits": 0,
            "powerPlayGoals": 0,
            "sog": 3,
            "faceoffWinningPctg": 0,
            "toi": "22:13",
            "blockedShots": 1,
            "shifts": 24,
            "giveaways": 0,
            "takeaways": 0,
            "teamId": 14,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020001/boxscore",
              "fetchedAt": "2026-09-06T02:53:42.722Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "3e12168acbb3a39f7691580b4e7ab3721a19472b925b2b6ddc57618e8444cffb"
            }
          },
          {
            "playerId": 8479591,
            "sweaterNumber": 23,
            "name": {
              "default": "M. Eyssimont"
            },
            "position": "C",
            "goals": 0,
            "assists": 0,
            "points": 0,
            "plusMinus": 0,
            "pim": 0,
            "hits": 0,
            "powerPlayGoals": 0,
            "sog": 2,
            "faceoffWinningPctg": 0,
            "toi": "08:31",
            "blockedShots": 0,
            "shifts": 14,
            "giveaways": 0,
            "takeaways": 2,
            "teamId": 14,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020001/boxscore",
              "fetchedAt": "2026-09-06T02:53:42.722Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "3e12168acbb3a39f7691580b4e7ab3721a19472b925b2b6ddc57618e8444cffb"
            }
          },
          {
            "playerId": 8479542,
            "sweaterNumber": 38,
            "name": {
              "default": "B. Hagel"
            },
            "position": "L",
            "goals": 1,
            "assists": 0,
            "points": 1,
            "plusMinus": 0,
            "pim": 0,
            "hits": 0,
            "powerPlayGoals": 0,
            "sog": 4,
            "faceoffWinningPctg": 1,
            "toi": "18:07",
            "blockedShots": 1,
            "shifts": 20,
            "giveaways": 0,
            "takeaways": 0,
            "teamId": 14,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020001/boxscore",
              "fetchedAt": "2026-09-06T02:53:42.722Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "3e12168acbb3a39f7691580b4e7ab3721a19472b925b2b6ddc57618e8444cffb"
            }
          },
          {
            "playerId": 8484325,
            "sweaterNumber": 39,
            "name": {
              "default": "W. Merela"
            },
            "position": "C",
            "goals": 0,
            "assists": 0,
            "points": 0,
            "plusMinus": 0,
            "pim": 0,
            "hits": 1,
            "powerPlayGoals": 0,
            "sog": 0,
            "faceoffWinningPctg": 0,
            "toi": "10:21",
            "blockedShots": 1,
            "shifts": 16,
            "giveaways": 0,
            "takeaways": 1,
            "teamId": 14,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020001/boxscore",
              "fetchedAt": "2026-09-06T02:53:42.722Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "3e12168acbb3a39f7691580b4e7ab3721a19472b925b2b6ddc57618e8444cffb"
            }
          },
          {
            "playerId": 8477353,
            "sweaterNumber": 64,
            "name": {
              "default": "T. Motte"
            },
            "position": "C",
            "goals": 0,
            "assists": 0,
            "points": 0,
            "plusMinus": 0,
            "pim": 0,
            "hits": 2,
            "powerPlayGoals": 0,
            "sog": 0,
            "faceoffWinningPctg": 0,
            "toi": "07:55",
            "blockedShots": 1,
            "shifts": 10,
            "giveaways": 0,
            "takeaways": 0,
            "teamId": 14,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020001/boxscore",
              "fetchedAt": "2026-09-06T02:53:42.722Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "3e12168acbb3a39f7691580b4e7ab3721a19472b925b2b6ddc57618e8444cffb"
            }
          },
          {
            "playerId": 8478519,
            "sweaterNumber": 71,
            "name": {
              "default": "A. Cirelli"
            },
            "position": "C",
            "goals": 0,
            "assists": 0,
            "points": 0,
            "plusMinus": -1,
            "pim": 0,
            "hits": 0,
            "powerPlayGoals": 0,
            "sog": 1,
            "faceoffWinningPctg": 0.6,
            "toi": "16:42",
            "blockedShots": 0,
            "shifts": 22,
            "giveaways": 0,
            "takeaways": 1,
            "teamId": 14,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020001/boxscore",
              "fetchedAt": "2026-09-06T02:53:42.722Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "3e12168acbb3a39f7691580b4e7ab3721a19472b925b2b6ddc57618e8444cffb"
            }
          },
          {
            "playerId": 8477839,
            "sweaterNumber": 73,
            "name": {
              "default": "C. Sheary"
            },
            "position": "L",
            "goals": 0,
            "assists": 0,
            "points": 0,
            "plusMinus": -1,
            "pim": 0,
            "hits": 0,
            "powerPlayGoals": 0,
            "sog": 0,
            "faceoffWinningPctg": 0,
            "toi": "12:04",
            "blockedShots": 3,
            "shifts": 17,
            "giveaways": 0,
            "takeaways": 0,
            "teamId": 14,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020001/boxscore",
              "fetchedAt": "2026-09-06T02:53:42.722Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "3e12168acbb3a39f7691580b4e7ab3721a19472b925b2b6ddc57618e8444cffb"
            }
          },
          {
            "playerId": 8479661,
            "sweaterNumber": 84,
            "name": {
              "default": "T. Jeannot"
            },
            "position": "L",
            "goals": 0,
            "assists": 0,
            "points": 0,
            "plusMinus": 0,
            "pim": 0,
            "hits": 2,
            "powerPlayGoals": 0,
            "sog": 1,
            "faceoffWinningPctg": 0,
            "toi": "11:48",
            "blockedShots": 0,
            "shifts": 15,
            "giveaways": 1,
            "takeaways": 1,
            "teamId": 14,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020001/boxscore",
              "fetchedAt": "2026-09-06T02:53:42.722Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "3e12168acbb3a39f7691580b4e7ab3721a19472b925b2b6ddc57618e8444cffb"
            }
          },
          {
            "playerId": 8476453,
            "sweaterNumber": 86,
            "name": {
              "default": "N. Kucherov",
              "cs": "N. Kučerov",
              "fi": "N. Kutsherov",
              "sk": "N. Kučerov"
            },
            "position": "R",
            "goals": 2,
            "assists": 0,
            "points": 2,
            "plusMinus": 1,
            "pim": 2,
            "hits": 2,
            "powerPlayGoals": 0,
            "sog": 5,
            "faceoffWinningPctg": 0,
            "toi": "21:19",
            "blockedShots": 0,
            "shifts": 24,
            "giveaways": 2,
            "takeaways": 1,
            "teamId": 14,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020001/boxscore",
              "fetchedAt": "2026-09-06T02:53:42.722Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "3e12168acbb3a39f7691580b4e7ab3721a19472b925b2b6ddc57618e8444cffb"
            }
          },
          {
            "playerId": 8474564,
            "sweaterNumber": 91,
            "name": {
              "default": "S. Stamkos"
            },
            "position": "C",
            "goals": 0,
            "assists": 1,
            "points": 1,
            "plusMinus": 0,
            "pim": 2,
            "hits": 2,
            "powerPlayGoals": 0,
            "sog": 2,
            "faceoffWinningPctg": 0.705882,
            "toi": "20:23",
            "blockedShots": 0,
            "shifts": 22,
            "giveaways": 0,
            "takeaways": 0,
            "teamId": 14,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020001/boxscore",
              "fetchedAt": "2026-09-06T02:53:42.722Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "3e12168acbb3a39f7691580b4e7ab3721a19472b925b2b6ddc57618e8444cffb"
            }
          },
          {
            "playerId": 8478178,
            "sweaterNumber": 43,
            "name": {
              "default": "D. Raddysh"
            },
            "position": "D",
            "goals": 0,
            "assists": 0,
            "points": 0,
            "plusMinus": 1,
            "pim": 0,
            "hits": 1,
            "powerPlayGoals": 0,
            "sog": 3,
            "faceoffWinningPctg": 0,
            "toi": "18:04",
            "blockedShots": 1,
            "shifts": 23,
            "giveaways": 0,
            "takeaways": 0,
            "teamId": 14,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020001/boxscore",
              "fetchedAt": "2026-09-06T02:53:42.722Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "3e12168acbb3a39f7691580b4e7ab3721a19472b925b2b6ddc57618e8444cffb"
            }
          },
          {
            "playerId": 8475177,
            "sweaterNumber": 44,
            "name": {
              "default": "C. de Haan"
            },
            "position": "D",
            "goals": 0,
            "assists": 0,
            "points": 0,
            "plusMinus": 0,
            "pim": 0,
            "hits": 2,
            "powerPlayGoals": 0,
            "sog": 0,
            "faceoffWinningPctg": 0,
            "toi": "13:41",
            "blockedShots": 1,
            "shifts": 17,
            "giveaways": 0,
            "takeaways": 0,
            "teamId": 14,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020001/boxscore",
              "fetchedAt": "2026-09-06T02:53:42.722Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "3e12168acbb3a39f7691580b4e7ab3721a19472b925b2b6ddc57618e8444cffb"
            }
          },
          {
            "playerId": 8480246,
            "sweaterNumber": 48,
            "name": {
              "default": "N. Perbix"
            },
            "position": "D",
            "goals": 0,
            "assists": 0,
            "points": 0,
            "plusMinus": -1,
            "pim": 2,
            "hits": 0,
            "powerPlayGoals": 0,
            "sog": 1,
            "faceoffWinningPctg": 0,
            "toi": "11:42",
            "blockedShots": 1,
            "shifts": 18,
            "giveaways": 2,
            "takeaways": 0,
            "teamId": 14,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020001/boxscore",
              "fetchedAt": "2026-09-06T02:53:42.722Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "3e12168acbb3a39f7691580b4e7ab3721a19472b925b2b6ddc57618e8444cffb"
            }
          },
          {
            "playerId": 8475167,
            "sweaterNumber": 77,
            "name": {
              "default": "V. Hedman"
            },
            "position": "D",
            "goals": 0,
            "assists": 1,
            "points": 1,
            "plusMinus": -1,
            "pim": 0,
            "hits": 0,
            "powerPlayGoals": 0,
            "sog": 4,
            "faceoffWinningPctg": 0,
            "toi": "26:55",
            "blockedShots": 1,
            "shifts": 26,
            "giveaways": 1,
            "takeaways": 0,
            "teamId": 14,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020001/boxscore",
              "fetchedAt": "2026-09-06T02:53:42.722Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "3e12168acbb3a39f7691580b4e7ab3721a19472b925b2b6ddc57618e8444cffb"
            }
          },
          {
            "playerId": 8478416,
            "sweaterNumber": 81,
            "name": {
              "default": "E. Cernak",
              "cs": "E. Černák",
              "sk": "E. Černák"
            },
            "position": "D",
            "goals": 0,
            "assists": 0,
            "points": 0,
            "plusMinus": 0,
            "pim": 0,
            "hits": 7,
            "powerPlayGoals": 0,
            "sog": 2,
            "faceoffWinningPctg": 0,
            "toi": "19:20",
            "blockedShots": 1,
            "shifts": 21,
            "giveaways": 0,
            "takeaways": 0,
            "teamId": 14,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020001/boxscore",
              "fetchedAt": "2026-09-06T02:53:42.722Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "3e12168acbb3a39f7691580b4e7ab3721a19472b925b2b6ddc57618e8444cffb"
            }
          },
          {
            "playerId": 8479410,
            "sweaterNumber": 98,
            "name": {
              "default": "M. Sergachev",
              "cs": "M. Sergačov",
              "fi": "M. Sergatshov",
              "sk": "M. Sergačov"
            },
            "position": "D",
            "goals": 0,
            "assists": 1,
            "points": 1,
            "plusMinus": 1,
            "pim": 2,
            "hits": 0,
            "powerPlayGoals": 0,
            "sog": 2,
            "faceoffWinningPctg": 0,
            "toi": "23:00",
            "blockedShots": 2,
            "shifts": 25,
            "giveaways": 0,
            "takeaways": 1,
            "teamId": 14,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020001/boxscore",
              "fetchedAt": "2026-09-06T02:53:42.722Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "3e12168acbb3a39f7691580b4e7ab3721a19472b925b2b6ddc57618e8444cffb"
            }
          }
        ],
        "goalies": [
          {
            "playerId": 8477992,
            "sweaterNumber": 31,
            "name": {
              "default": "J. Johansson"
            },
            "position": "G",
            "evenStrengthShotsAgainst": "21/23",
            "powerPlayShotsAgainst": "6/7",
            "shorthandedShotsAgainst": "1/1",
            "saveShotsAgainst": "28/31",
            "savePctg": 0.903226,
            "evenStrengthGoalsAgainst": 2,
            "powerPlayGoalsAgainst": 1,
            "shorthandedGoalsAgainst": 0,
            "pim": 0,
            "goalsAgainst": 3,
            "toi": "60:00",
            "starter": true,
            "decision": "W",
            "shotsAgainst": 31,
            "saves": 28,
            "teamId": 14,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020001/boxscore",
              "fetchedAt": "2026-09-06T02:53:42.722Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "3e12168acbb3a39f7691580b4e7ab3721a19472b925b2b6ddc57618e8444cffb"
            },
            "confirmationScope": "OBSERVED_GAME_PARTICIPATION",
            "pregameConfirmed": false
          },
          {
            "playerId": 8477035,
            "sweaterNumber": 90,
            "name": {
              "default": "M. Tomkins"
            },
            "position": "G",
            "evenStrengthShotsAgainst": "0/0",
            "powerPlayShotsAgainst": "0/0",
            "shorthandedShotsAgainst": "0/0",
            "saveShotsAgainst": "0/0",
            "evenStrengthGoalsAgainst": 0,
            "powerPlayGoalsAgainst": 0,
            "shorthandedGoalsAgainst": 0,
            "pim": 0,
            "goalsAgainst": 0,
            "toi": "00:00",
            "starter": false,
            "shotsAgainst": 0,
            "saves": 0,
            "teamId": 14,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020001/boxscore",
              "fetchedAt": "2026-09-06T02:53:42.722Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "3e12168acbb3a39f7691580b4e7ab3721a19472b925b2b6ddc57618e8444cffb"
            },
            "confirmationScope": "OBSERVED_GAME_PARTICIPATION",
            "pregameConfirmed": false
          }
        ]
      }
    },
    "teamStatistics": {
      "away": {
        "shotsOnGoal": 31
      },
      "home": {
        "shotsOnGoal": 34
      },
      "source": {
        "provider": "NHL",
        "url": "https://api-web.nhle.com/v1/gamecenter/2023020001/landing",
        "fetchedAt": "2026-09-06T02:39:28.576Z",
        "acquiredVia": "WEB_PUBLIC_SOURCE",
        "sourceUpdatedAt": null,
        "contentHash": "9b21d2acff3fb965bac6a1e83ca06ed101a7b189239f681ce85d5fd00467de46"
      }
    },
    "goalie": {
      "away": null,
      "home": null,
      "status": "PREGAME_EVIDENCE_REQUIRED"
    },
    "injury": {
      "status": "UNKNOWN",
      "availableAt": null,
      "players": null,
      "source": null
    },
    "lineup": {
      "status": "UNKNOWN",
      "availableAt": null,
      "players": null,
      "source": null
    },
    "advanced": {
      "fiveOnFive": null,
      "xGF": null,
      "xGA": null,
      "goalieGsax": null,
      "status": "SOURCE_NOT_CONNECTED"
    },
    "qa": {
      "status": "PASS",
      "issues": [],
      "warnings": [
        "NHL_PREGAME_INJURY_LINEUP_GOALIE_EVIDENCE_MISSING",
        "NHL_XG_5V5_FEATURES_UNAVAILABLE"
      ],
      "canUseHistoricalPeriods": true,
      "pregameModelReady": false
    }
  },
  {
    "leagueId": "NHL",
    "gameId": "2023020002",
    "officialGameId": "2023020002",
    "season": 20232024,
    "gameType": 2,
    "startTimeUTC": "2023-10-11T00:00:00Z",
    "taipeiDate": "2023-10-11",
    "officialDate": "2023-10-10",
    "awayTeamId": 16,
    "homeTeamId": 5,
    "away": {
      "leagueId": "NHL",
      "teamId": 16,
      "identityKey": "NHL:team:16",
      "abbrev": "CHI",
      "name": "Chicago Blackhawks"
    },
    "home": {
      "leagueId": "NHL",
      "teamId": 5,
      "identityKey": "NHL:team:5",
      "abbrev": "PIT",
      "name": "Pittsburgh Penguins"
    },
    "venue": "PPG Paints Arena",
    "venueTimezone": "US/Eastern",
    "neutralSite": false,
    "gameState": "OFF",
    "gameScheduleState": "OK",
    "final": {
      "awayGoals": 4,
      "homeGoals": 2
    },
    "outcomeType": "REG",
    "source": {
      "provider": "NHL",
      "url": "https://api-web.nhle.com/v1/gamecenter/2023020002/landing",
      "fetchedAt": "2026-09-06T02:39:29.332Z",
      "acquiredVia": "WEB_PUBLIC_SOURCE",
      "sourceUpdatedAt": null,
      "contentHash": "830cbf39ea001442c4f5b629c9d6fc720c4978455323f05c530e85c38fffb35a"
    },
    "seasonPhase": "REGULAR",
    "periods": [
      {
        "awayGoals": 0,
        "homeGoals": 1
      },
      {
        "awayGoals": 1,
        "homeGoals": 1
      },
      {
        "awayGoals": 3,
        "homeGoals": 0
      }
    ],
    "regulation": {
      "awayGoals": 4,
      "homeGoals": 2
    },
    "outcomeAvailableAt": null,
    "historical": true,
    "identity": {
      "ok": true,
      "status": "PASS",
      "issues": [],
      "identityKey": "NHL:2023020002:16:5:2023-10-11T00:00:00Z"
    },
    "league": "NHL",
    "northAmericaDate": "2023-10-10",
    "awayName": "Chicago Blackhawks",
    "homeName": "Pittsburgh Penguins",
    "awayAbbrev": "CHI",
    "homeAbbrev": "PIT",
    "status": "OFF",
    "teamStatistics": {
      "away": {
        "shotsOnGoal": 36
      },
      "home": {
        "shotsOnGoal": 41
      },
      "source": {
        "provider": "NHL",
        "url": "https://api-web.nhle.com/v1/gamecenter/2023020002/landing",
        "fetchedAt": "2026-09-06T02:39:29.332Z",
        "acquiredVia": "WEB_PUBLIC_SOURCE",
        "sourceUpdatedAt": null,
        "contentHash": "830cbf39ea001442c4f5b629c9d6fc720c4978455323f05c530e85c38fffb35a"
      }
    },
    "goalie": {
      "away": null,
      "home": null,
      "status": "PREGAME_EVIDENCE_REQUIRED"
    },
    "injury": {
      "status": "UNKNOWN",
      "availableAt": null,
      "players": null,
      "source": null
    },
    "lineup": {
      "status": "UNKNOWN",
      "availableAt": null,
      "players": null,
      "source": null
    },
    "advanced": {
      "fiveOnFive": null,
      "xGF": null,
      "xGA": null,
      "goalieGsax": null,
      "status": "SOURCE_NOT_CONNECTED"
    },
    "qa": {
      "status": "PASS",
      "issues": [],
      "warnings": [
        "NHL_PREGAME_INJURY_LINEUP_GOALIE_EVIDENCE_MISSING",
        "NHL_XG_5V5_FEATURES_UNAVAILABLE"
      ],
      "canUseHistoricalPeriods": true,
      "pregameModelReady": false
    }
  },
  {
    "leagueId": "NHL",
    "gameId": "2023020006",
    "officialGameId": "2023020006",
    "season": 20232024,
    "gameType": 2,
    "startTimeUTC": "2023-10-11T23:30:00Z",
    "taipeiDate": "2023-10-12",
    "officialDate": "2023-10-11",
    "awayTeamId": 16,
    "homeTeamId": 6,
    "away": {
      "leagueId": "NHL",
      "teamId": 16,
      "identityKey": "NHL:team:16",
      "abbrev": "CHI",
      "name": "Chicago Blackhawks"
    },
    "home": {
      "leagueId": "NHL",
      "teamId": 6,
      "identityKey": "NHL:team:6",
      "abbrev": "BOS",
      "name": "Boston Bruins"
    },
    "venue": "TD Garden",
    "venueTimezone": "US/Eastern",
    "neutralSite": false,
    "gameState": "OFF",
    "gameScheduleState": "OK",
    "final": {
      "awayGoals": 1,
      "homeGoals": 3
    },
    "outcomeType": "REG",
    "source": {
      "provider": "NHL",
      "url": "https://api-web.nhle.com/v1/gamecenter/2023020006/landing",
      "fetchedAt": "2026-09-06T02:40:35.014Z",
      "acquiredVia": "WEB_PUBLIC_SOURCE",
      "sourceUpdatedAt": null,
      "contentHash": "23d5205da28ef6b1fb1d60986f0d1295750f0e59aecc758cba0c448d245e6c0c"
    },
    "seasonPhase": "REGULAR",
    "periods": [
      {
        "awayGoals": 1,
        "homeGoals": 1
      },
      {
        "awayGoals": 0,
        "homeGoals": 1
      },
      {
        "awayGoals": 0,
        "homeGoals": 1
      }
    ],
    "regulation": {
      "awayGoals": 1,
      "homeGoals": 3
    },
    "outcomeAvailableAt": null,
    "historical": true,
    "identity": {
      "ok": true,
      "status": "PASS",
      "issues": [],
      "identityKey": "NHL:2023020006:16:6:2023-10-11T23:30:00Z"
    },
    "league": "NHL",
    "northAmericaDate": "2023-10-11",
    "awayName": "Chicago Blackhawks",
    "homeName": "Boston Bruins",
    "awayAbbrev": "CHI",
    "homeAbbrev": "BOS",
    "status": "OFF",
    "teamStatistics": {
      "away": {
        "shotsOnGoal": 21
      },
      "home": {
        "shotsOnGoal": 33
      },
      "source": {
        "provider": "NHL",
        "url": "https://api-web.nhle.com/v1/gamecenter/2023020006/landing",
        "fetchedAt": "2026-09-06T02:40:35.014Z",
        "acquiredVia": "WEB_PUBLIC_SOURCE",
        "sourceUpdatedAt": null,
        "contentHash": "23d5205da28ef6b1fb1d60986f0d1295750f0e59aecc758cba0c448d245e6c0c"
      }
    },
    "goalie": {
      "away": null,
      "home": null,
      "status": "PREGAME_EVIDENCE_REQUIRED"
    },
    "injury": {
      "status": "UNKNOWN",
      "availableAt": null,
      "players": null,
      "source": null
    },
    "lineup": {
      "status": "UNKNOWN",
      "availableAt": null,
      "players": null,
      "source": null
    },
    "advanced": {
      "fiveOnFive": null,
      "xGF": null,
      "xGA": null,
      "goalieGsax": null,
      "status": "SOURCE_NOT_CONNECTED"
    },
    "qa": {
      "status": "PASS",
      "issues": [],
      "warnings": [
        "NHL_PREGAME_INJURY_LINEUP_GOALIE_EVIDENCE_MISSING",
        "NHL_XG_5V5_FEATURES_UNAVAILABLE"
      ],
      "canUseHistoricalPeriods": true,
      "pregameModelReady": false
    }
  },
  {
    "leagueId": "NHL",
    "gameId": "2023020008",
    "officialGameId": "2023020008",
    "season": 20232024,
    "gameType": 2,
    "startTimeUTC": "2023-10-12T02:00:00Z",
    "taipeiDate": "2023-10-12",
    "officialDate": "2023-10-11",
    "awayTeamId": 21,
    "homeTeamId": 26,
    "away": {
      "leagueId": "NHL",
      "teamId": 21,
      "identityKey": "NHL:team:21",
      "abbrev": "COL",
      "name": "Colorado Avalanche"
    },
    "home": {
      "leagueId": "NHL",
      "teamId": 26,
      "identityKey": "NHL:team:26",
      "abbrev": "LAK",
      "name": "Los Angeles Kings"
    },
    "venue": "Crypto.com Arena",
    "venueTimezone": "America/Los_Angeles",
    "neutralSite": false,
    "gameState": "OFF",
    "gameScheduleState": "OK",
    "final": {
      "awayGoals": 5,
      "homeGoals": 2
    },
    "outcomeType": "REG",
    "source": {
      "provider": "NHL",
      "url": "https://api-web.nhle.com/v1/gamecenter/2023020008/landing",
      "fetchedAt": "2026-09-06T02:40:36.482Z",
      "acquiredVia": "WEB_PUBLIC_SOURCE",
      "sourceUpdatedAt": null,
      "contentHash": "8011bf1ed790f1d3ea2da3ddc54041d951bd40866cd4dcd0cec7787a6cbc1edd"
    },
    "seasonPhase": "REGULAR",
    "periods": [
      {
        "awayGoals": 1,
        "homeGoals": 0
      },
      {
        "awayGoals": 2,
        "homeGoals": 2
      },
      {
        "awayGoals": 2,
        "homeGoals": 0
      }
    ],
    "regulation": {
      "awayGoals": 5,
      "homeGoals": 2
    },
    "outcomeAvailableAt": null,
    "historical": true,
    "identity": {
      "ok": true,
      "status": "PASS",
      "issues": [],
      "identityKey": "NHL:2023020008:21:26:2023-10-12T02:00:00Z"
    },
    "league": "NHL",
    "northAmericaDate": "2023-10-11",
    "awayName": "Colorado Avalanche",
    "homeName": "Los Angeles Kings",
    "awayAbbrev": "COL",
    "homeAbbrev": "LAK",
    "status": "OFF",
    "teamStatistics": {
      "away": {
        "shotsOnGoal": 37
      },
      "home": {
        "shotsOnGoal": 36
      },
      "source": {
        "provider": "NHL",
        "url": "https://api-web.nhle.com/v1/gamecenter/2023020008/landing",
        "fetchedAt": "2026-09-06T02:40:36.482Z",
        "acquiredVia": "WEB_PUBLIC_SOURCE",
        "sourceUpdatedAt": null,
        "contentHash": "8011bf1ed790f1d3ea2da3ddc54041d951bd40866cd4dcd0cec7787a6cbc1edd"
      }
    },
    "goalie": {
      "away": null,
      "home": null,
      "status": "PREGAME_EVIDENCE_REQUIRED"
    },
    "injury": {
      "status": "UNKNOWN",
      "availableAt": null,
      "players": null,
      "source": null
    },
    "lineup": {
      "status": "UNKNOWN",
      "availableAt": null,
      "players": null,
      "source": null
    },
    "advanced": {
      "fiveOnFive": null,
      "xGF": null,
      "xGA": null,
      "goalieGsax": null,
      "status": "SOURCE_NOT_CONNECTED"
    },
    "qa": {
      "status": "PASS",
      "issues": [],
      "warnings": [
        "NHL_PREGAME_INJURY_LINEUP_GOALIE_EVIDENCE_MISSING",
        "NHL_XG_5V5_FEATURES_UNAVAILABLE"
      ],
      "canUseHistoricalPeriods": true,
      "pregameModelReady": false
    }
  },
  {
    "leagueId": "NHL",
    "gameId": "2023020011",
    "officialGameId": "2023020011",
    "season": 20232024,
    "gameType": 2,
    "startTimeUTC": "2023-10-12T23:00:00Z",
    "taipeiDate": "2023-10-13",
    "officialDate": "2023-10-12",
    "awayTeamId": 4,
    "homeTeamId": 29,
    "away": {
      "leagueId": "NHL",
      "teamId": 4,
      "identityKey": "NHL:team:4",
      "abbrev": "PHI",
      "name": "Philadelphia Flyers"
    },
    "home": {
      "leagueId": "NHL",
      "teamId": 29,
      "identityKey": "NHL:team:29",
      "abbrev": "CBJ",
      "name": "Columbus Blue Jackets"
    },
    "venue": "Nationwide Arena",
    "venueTimezone": "US/Eastern",
    "neutralSite": false,
    "gameState": "OFF",
    "gameScheduleState": "OK",
    "final": {
      "awayGoals": 4,
      "homeGoals": 2
    },
    "outcomeType": "REG",
    "source": {
      "provider": "NHL",
      "url": "https://api-web.nhle.com/v1/gamecenter/2023020011/landing",
      "fetchedAt": "2026-09-06T02:45:11.332Z",
      "acquiredVia": "WEB_PUBLIC_SOURCE",
      "sourceUpdatedAt": null,
      "contentHash": "58e40b34f4d0b7e0e31ac8c582a7c694d6933d30ca8223281baa91f35cb55eac"
    },
    "seasonPhase": "REGULAR",
    "periods": [
      {
        "awayGoals": 2,
        "homeGoals": 1
      },
      {
        "awayGoals": 0,
        "homeGoals": 0
      },
      {
        "awayGoals": 2,
        "homeGoals": 1
      }
    ],
    "regulation": {
      "awayGoals": 4,
      "homeGoals": 2
    },
    "outcomeAvailableAt": null,
    "historical": true,
    "identity": {
      "ok": true,
      "status": "PASS",
      "issues": [],
      "identityKey": "NHL:2023020011:4:29:2023-10-12T23:00:00Z"
    },
    "league": "NHL",
    "northAmericaDate": "2023-10-12",
    "awayName": "Philadelphia Flyers",
    "homeName": "Columbus Blue Jackets",
    "awayAbbrev": "PHI",
    "homeAbbrev": "CBJ",
    "status": "OFF",
    "teamStatistics": {
      "away": {
        "shotsOnGoal": 37
      },
      "home": {
        "shotsOnGoal": 33
      },
      "source": {
        "provider": "NHL",
        "url": "https://api-web.nhle.com/v1/gamecenter/2023020011/landing",
        "fetchedAt": "2026-09-06T02:45:11.332Z",
        "acquiredVia": "WEB_PUBLIC_SOURCE",
        "sourceUpdatedAt": null,
        "contentHash": "58e40b34f4d0b7e0e31ac8c582a7c694d6933d30ca8223281baa91f35cb55eac"
      }
    },
    "goalie": {
      "away": null,
      "home": null,
      "status": "PREGAME_EVIDENCE_REQUIRED"
    },
    "injury": {
      "status": "UNKNOWN",
      "availableAt": null,
      "players": null,
      "source": null
    },
    "lineup": {
      "status": "UNKNOWN",
      "availableAt": null,
      "players": null,
      "source": null
    },
    "advanced": {
      "fiveOnFive": null,
      "xGF": null,
      "xGA": null,
      "goalieGsax": null,
      "status": "SOURCE_NOT_CONNECTED"
    },
    "qa": {
      "status": "PASS",
      "issues": [],
      "warnings": [
        "NHL_PREGAME_INJURY_LINEUP_GOALIE_EVIDENCE_MISSING",
        "NHL_XG_5V5_FEATURES_UNAVAILABLE"
      ],
      "canUseHistoricalPeriods": true,
      "pregameModelReady": false
    }
  },
  {
    "leagueId": "NHL",
    "gameId": "2023020015",
    "officialGameId": "2023020015",
    "season": 20232024,
    "gameType": 2,
    "startTimeUTC": "2023-10-13T00:00:00Z",
    "taipeiDate": "2023-10-13",
    "officialDate": "2023-10-12",
    "awayTeamId": 55,
    "homeTeamId": 18,
    "away": {
      "leagueId": "NHL",
      "teamId": 55,
      "identityKey": "NHL:team:55",
      "abbrev": "SEA",
      "name": "Seattle Kraken"
    },
    "home": {
      "leagueId": "NHL",
      "teamId": 18,
      "identityKey": "NHL:team:18",
      "abbrev": "NSH",
      "name": "Nashville Predators"
    },
    "venue": "Bridgestone Arena",
    "venueTimezone": "US/Central",
    "neutralSite": false,
    "gameState": "OFF",
    "gameScheduleState": "OK",
    "final": {
      "awayGoals": 0,
      "homeGoals": 3
    },
    "outcomeType": "REG",
    "source": {
      "provider": "NHL",
      "url": "https://api-web.nhle.com/v1/gamecenter/2023020015/landing",
      "fetchedAt": "2026-09-06T02:47:34.343Z",
      "acquiredVia": "WEB_PUBLIC_SOURCE",
      "sourceUpdatedAt": null,
      "contentHash": "b3176a891a0797e0054b0acda49eb4e5f18ef6b76d389ed46af1c16ec7972c23"
    },
    "seasonPhase": "REGULAR",
    "periods": [
      {
        "awayGoals": 0,
        "homeGoals": 0
      },
      {
        "awayGoals": 0,
        "homeGoals": 1
      },
      {
        "awayGoals": 0,
        "homeGoals": 2
      }
    ],
    "regulation": {
      "awayGoals": 0,
      "homeGoals": 3
    },
    "outcomeAvailableAt": null,
    "historical": true,
    "identity": {
      "ok": true,
      "status": "PASS",
      "issues": [],
      "identityKey": "NHL:2023020015:55:18:2023-10-13T00:00:00Z"
    },
    "league": "NHL",
    "northAmericaDate": "2023-10-12",
    "awayName": "Seattle Kraken",
    "homeName": "Nashville Predators",
    "awayAbbrev": "SEA",
    "homeAbbrev": "NSH",
    "status": "OFF",
    "teamStatistics": {
      "away": {
        "shotsOnGoal": 23
      },
      "home": {
        "shotsOnGoal": 35
      },
      "source": {
        "provider": "NHL",
        "url": "https://api-web.nhle.com/v1/gamecenter/2023020015/landing",
        "fetchedAt": "2026-09-06T02:47:34.343Z",
        "acquiredVia": "WEB_PUBLIC_SOURCE",
        "sourceUpdatedAt": null,
        "contentHash": "b3176a891a0797e0054b0acda49eb4e5f18ef6b76d389ed46af1c16ec7972c23"
      }
    },
    "goalie": {
      "away": null,
      "home": null,
      "status": "PREGAME_EVIDENCE_REQUIRED"
    },
    "injury": {
      "status": "UNKNOWN",
      "availableAt": null,
      "players": null,
      "source": null
    },
    "lineup": {
      "status": "UNKNOWN",
      "availableAt": null,
      "players": null,
      "source": null
    },
    "advanced": {
      "fiveOnFive": null,
      "xGF": null,
      "xGA": null,
      "goalieGsax": null,
      "status": "SOURCE_NOT_CONNECTED"
    },
    "qa": {
      "status": "PASS",
      "issues": [],
      "warnings": [
        "NHL_PREGAME_INJURY_LINEUP_GOALIE_EVIDENCE_MISSING",
        "NHL_XG_5V5_FEATURES_UNAVAILABLE"
      ],
      "canUseHistoricalPeriods": true,
      "pregameModelReady": false
    }
  },
  {
    "leagueId": "NHL",
    "gameId": "2023020019",
    "officialGameId": "2023020019",
    "season": 20232024,
    "gameType": 2,
    "startTimeUTC": "2023-10-14T17:00:00Z",
    "taipeiDate": "2023-10-15",
    "officialDate": "2023-10-14",
    "awayTeamId": 4,
    "homeTeamId": 9,
    "away": {
      "leagueId": "NHL",
      "teamId": 4,
      "identityKey": "NHL:team:4",
      "abbrev": "PHI",
      "name": "Philadelphia Flyers"
    },
    "home": {
      "leagueId": "NHL",
      "teamId": 9,
      "identityKey": "NHL:team:9",
      "abbrev": "OTT",
      "name": "Ottawa Senators"
    },
    "venue": "Canadian Tire Centre",
    "venueTimezone": "US/Eastern",
    "neutralSite": false,
    "gameState": "OFF",
    "gameScheduleState": "OK",
    "final": {
      "awayGoals": 2,
      "homeGoals": 5
    },
    "outcomeType": "REG",
    "source": {
      "provider": "NHL",
      "url": "https://api-web.nhle.com/v1/gamecenter/2023020019/landing",
      "fetchedAt": "2026-09-06T02:47:35.215Z",
      "acquiredVia": "WEB_PUBLIC_SOURCE",
      "sourceUpdatedAt": null,
      "contentHash": "f8c86f8d957e48f8075f629540b6220f750af1323915a29faa73f75d37613999"
    },
    "seasonPhase": "REGULAR",
    "periods": [
      {
        "awayGoals": 1,
        "homeGoals": 2
      },
      {
        "awayGoals": 1,
        "homeGoals": 2
      },
      {
        "awayGoals": 0,
        "homeGoals": 1
      }
    ],
    "regulation": {
      "awayGoals": 2,
      "homeGoals": 5
    },
    "outcomeAvailableAt": null,
    "historical": true,
    "identity": {
      "ok": true,
      "status": "PASS",
      "issues": [],
      "identityKey": "NHL:2023020019:4:9:2023-10-14T17:00:00Z"
    },
    "league": "NHL",
    "northAmericaDate": "2023-10-14",
    "awayName": "Philadelphia Flyers",
    "homeName": "Ottawa Senators",
    "awayAbbrev": "PHI",
    "homeAbbrev": "OTT",
    "status": "OFF",
    "teamStatistics": {
      "away": {
        "shotsOnGoal": 21
      },
      "home": {
        "shotsOnGoal": 31
      },
      "source": {
        "provider": "NHL",
        "url": "https://api-web.nhle.com/v1/gamecenter/2023020019/landing",
        "fetchedAt": "2026-09-06T02:47:35.215Z",
        "acquiredVia": "WEB_PUBLIC_SOURCE",
        "sourceUpdatedAt": null,
        "contentHash": "f8c86f8d957e48f8075f629540b6220f750af1323915a29faa73f75d37613999"
      }
    },
    "goalie": {
      "away": null,
      "home": null,
      "status": "PREGAME_EVIDENCE_REQUIRED"
    },
    "injury": {
      "status": "UNKNOWN",
      "availableAt": null,
      "players": null,
      "source": null
    },
    "lineup": {
      "status": "UNKNOWN",
      "availableAt": null,
      "players": null,
      "source": null
    },
    "advanced": {
      "fiveOnFive": null,
      "xGF": null,
      "xGA": null,
      "goalieGsax": null,
      "status": "SOURCE_NOT_CONNECTED"
    },
    "qa": {
      "status": "PASS",
      "issues": [],
      "warnings": [
        "NHL_PREGAME_INJURY_LINEUP_GOALIE_EVIDENCE_MISSING",
        "NHL_XG_5V5_FEATURES_UNAVAILABLE"
      ],
      "canUseHistoricalPeriods": true,
      "pregameModelReady": false
    }
  },
  {
    "leagueId": "NHL",
    "gameId": "2023020024",
    "officialGameId": "2023020024",
    "season": 20232024,
    "gameType": 2,
    "startTimeUTC": "2023-10-14T23:00:00Z",
    "taipeiDate": "2023-10-15",
    "officialDate": "2023-10-14",
    "awayTeamId": 16,
    "homeTeamId": 8,
    "away": {
      "leagueId": "NHL",
      "teamId": 16,
      "identityKey": "NHL:team:16",
      "abbrev": "CHI",
      "name": "Chicago Blackhawks"
    },
    "home": {
      "leagueId": "NHL",
      "teamId": 8,
      "identityKey": "NHL:team:8",
      "abbrev": "MTL",
      "name": "Montréal Canadiens"
    },
    "venue": "Centre Bell",
    "venueTimezone": "America/Montreal",
    "neutralSite": false,
    "gameState": "OFF",
    "gameScheduleState": "OK",
    "final": {
      "awayGoals": 2,
      "homeGoals": 3
    },
    "outcomeType": "REG",
    "source": {
      "provider": "NHL",
      "url": "https://api-web.nhle.com/v1/gamecenter/2023020024/landing",
      "fetchedAt": "2026-09-06T02:47:35.971Z",
      "acquiredVia": "WEB_PUBLIC_SOURCE",
      "sourceUpdatedAt": null,
      "contentHash": "04495aa5cf04450388a2a50bd59f62c78a9586f6c2d1a0c20497efedfa3f57eb"
    },
    "seasonPhase": "REGULAR",
    "periods": [
      {
        "awayGoals": 0,
        "homeGoals": 0
      },
      {
        "awayGoals": 0,
        "homeGoals": 3
      },
      {
        "awayGoals": 2,
        "homeGoals": 0
      }
    ],
    "regulation": {
      "awayGoals": 2,
      "homeGoals": 3
    },
    "outcomeAvailableAt": null,
    "historical": true,
    "identity": {
      "ok": true,
      "status": "PASS",
      "issues": [],
      "identityKey": "NHL:2023020024:16:8:2023-10-14T23:00:00Z"
    },
    "league": "NHL",
    "northAmericaDate": "2023-10-14",
    "awayName": "Chicago Blackhawks",
    "homeName": "Montréal Canadiens",
    "awayAbbrev": "CHI",
    "homeAbbrev": "MTL",
    "status": "OFF",
    "teamStatistics": {
      "away": {
        "shotsOnGoal": 30
      },
      "home": {
        "shotsOnGoal": 36
      },
      "source": {
        "provider": "NHL",
        "url": "https://api-web.nhle.com/v1/gamecenter/2023020024/landing",
        "fetchedAt": "2026-09-06T02:47:35.971Z",
        "acquiredVia": "WEB_PUBLIC_SOURCE",
        "sourceUpdatedAt": null,
        "contentHash": "04495aa5cf04450388a2a50bd59f62c78a9586f6c2d1a0c20497efedfa3f57eb"
      }
    },
    "goalie": {
      "away": null,
      "home": null,
      "status": "PREGAME_EVIDENCE_REQUIRED"
    },
    "injury": {
      "status": "UNKNOWN",
      "availableAt": null,
      "players": null,
      "source": null
    },
    "lineup": {
      "status": "UNKNOWN",
      "availableAt": null,
      "players": null,
      "source": null
    },
    "advanced": {
      "fiveOnFive": null,
      "xGF": null,
      "xGA": null,
      "goalieGsax": null,
      "status": "SOURCE_NOT_CONNECTED"
    },
    "qa": {
      "status": "PASS",
      "issues": [],
      "warnings": [
        "NHL_PREGAME_INJURY_LINEUP_GOALIE_EVIDENCE_MISSING",
        "NHL_XG_5V5_FEATURES_UNAVAILABLE"
      ],
      "canUseHistoricalPeriods": true,
      "pregameModelReady": false
    }
  },
  {
    "leagueId": "NHL",
    "gameId": "2023020030",
    "officialGameId": "2023020030",
    "season": 20232024,
    "gameType": 2,
    "startTimeUTC": "2023-10-15T02:00:00Z",
    "taipeiDate": "2023-10-15",
    "officialDate": "2023-10-14",
    "awayTeamId": 21,
    "homeTeamId": 28,
    "away": {
      "leagueId": "NHL",
      "teamId": 21,
      "identityKey": "NHL:team:21",
      "abbrev": "COL",
      "name": "Colorado Avalanche"
    },
    "home": {
      "leagueId": "NHL",
      "teamId": 28,
      "identityKey": "NHL:team:28",
      "abbrev": "SJS",
      "name": "San Jose Sharks"
    },
    "venue": "SAP Center at San Jose",
    "venueTimezone": "US/Pacific",
    "neutralSite": false,
    "gameState": "OFF",
    "gameScheduleState": "OK",
    "final": {
      "awayGoals": 2,
      "homeGoals": 1
    },
    "outcomeType": "SO",
    "source": {
      "provider": "NHL",
      "url": "https://api-web.nhle.com/v1/gamecenter/2023020030/landing",
      "fetchedAt": "2026-09-06T02:47:36.727Z",
      "acquiredVia": "WEB_PUBLIC_SOURCE",
      "sourceUpdatedAt": null,
      "contentHash": "56e5d981101924c49b177b4eb6f616189479487f0df84f2593eccf897117b77f"
    },
    "seasonPhase": "REGULAR",
    "periods": [
      {
        "awayGoals": 0,
        "homeGoals": 1
      },
      {
        "awayGoals": 0,
        "homeGoals": 0
      },
      {
        "awayGoals": 1,
        "homeGoals": 0
      }
    ],
    "regulation": {
      "awayGoals": 1,
      "homeGoals": 1
    },
    "outcomeAvailableAt": null,
    "historical": true,
    "identity": {
      "ok": true,
      "status": "PASS",
      "issues": [],
      "identityKey": "NHL:2023020030:21:28:2023-10-15T02:00:00Z"
    },
    "league": "NHL",
    "northAmericaDate": "2023-10-14",
    "awayName": "Colorado Avalanche",
    "homeName": "San Jose Sharks",
    "awayAbbrev": "COL",
    "homeAbbrev": "SJS",
    "status": "OFF",
    "teamStatistics": {
      "away": {
        "shotsOnGoal": 52
      },
      "home": {
        "shotsOnGoal": 21
      },
      "source": {
        "provider": "NHL",
        "url": "https://api-web.nhle.com/v1/gamecenter/2023020030/landing",
        "fetchedAt": "2026-09-06T02:47:36.727Z",
        "acquiredVia": "WEB_PUBLIC_SOURCE",
        "sourceUpdatedAt": null,
        "contentHash": "56e5d981101924c49b177b4eb6f616189479487f0df84f2593eccf897117b77f"
      }
    },
    "goalie": {
      "away": null,
      "home": null,
      "status": "PREGAME_EVIDENCE_REQUIRED"
    },
    "injury": {
      "status": "UNKNOWN",
      "availableAt": null,
      "players": null,
      "source": null
    },
    "lineup": {
      "status": "UNKNOWN",
      "availableAt": null,
      "players": null,
      "source": null
    },
    "advanced": {
      "fiveOnFive": null,
      "xGF": null,
      "xGA": null,
      "goalieGsax": null,
      "status": "SOURCE_NOT_CONNECTED"
    },
    "qa": {
      "status": "PASS",
      "issues": [],
      "warnings": [
        "NHL_PREGAME_INJURY_LINEUP_GOALIE_EVIDENCE_MISSING",
        "NHL_XG_5V5_FEATURES_UNAVAILABLE"
      ],
      "canUseHistoricalPeriods": true,
      "pregameModelReady": false
    }
  },
  {
    "leagueId": "NHL",
    "gameId": "2023020038",
    "officialGameId": "2023020038",
    "season": 20232024,
    "gameType": 2,
    "startTimeUTC": "2023-10-16T23:00:00Z",
    "taipeiDate": "2023-10-17",
    "officialDate": "2023-10-16",
    "awayTeamId": 16,
    "homeTeamId": 10,
    "away": {
      "leagueId": "NHL",
      "teamId": 16,
      "identityKey": "NHL:team:16",
      "abbrev": "CHI",
      "name": "Chicago Blackhawks"
    },
    "home": {
      "leagueId": "NHL",
      "teamId": 10,
      "identityKey": "NHL:team:10",
      "abbrev": "TOR",
      "name": "Toronto Maple Leafs"
    },
    "venue": "Scotiabank Arena",
    "venueTimezone": "America/Toronto",
    "neutralSite": false,
    "gameState": "OFF",
    "gameScheduleState": "OK",
    "final": {
      "awayGoals": 4,
      "homeGoals": 1
    },
    "outcomeType": "REG",
    "source": {
      "provider": "NHL",
      "url": "https://api-web.nhle.com/v1/gamecenter/2023020038/landing",
      "fetchedAt": "2026-09-06T02:52:47.105Z",
      "acquiredVia": "WEB_PUBLIC_SOURCE",
      "sourceUpdatedAt": null,
      "contentHash": "1713a3a377b1ffb8c32e70704397a19c01707d3d7a71e578cfed1f9d4f6e6f2c"
    },
    "seasonPhase": "REGULAR",
    "periods": [
      {
        "awayGoals": 0,
        "homeGoals": 0
      },
      {
        "awayGoals": 3,
        "homeGoals": 1
      },
      {
        "awayGoals": 1,
        "homeGoals": 0
      }
    ],
    "regulation": {
      "awayGoals": 4,
      "homeGoals": 1
    },
    "outcomeAvailableAt": null,
    "historical": true,
    "identity": {
      "ok": true,
      "status": "PASS",
      "issues": [],
      "identityKey": "NHL:2023020038:16:10:2023-10-16T23:00:00Z"
    },
    "league": "NHL",
    "northAmericaDate": "2023-10-16",
    "awayName": "Chicago Blackhawks",
    "homeName": "Toronto Maple Leafs",
    "awayAbbrev": "CHI",
    "homeAbbrev": "TOR",
    "status": "OFF",
    "teamStatistics": {
      "away": {
        "shotsOnGoal": 31
      },
      "home": {
        "shotsOnGoal": 36
      },
      "source": {
        "provider": "NHL",
        "url": "https://api-web.nhle.com/v1/gamecenter/2023020038/landing",
        "fetchedAt": "2026-09-06T02:52:47.105Z",
        "acquiredVia": "WEB_PUBLIC_SOURCE",
        "sourceUpdatedAt": null,
        "contentHash": "1713a3a377b1ffb8c32e70704397a19c01707d3d7a71e578cfed1f9d4f6e6f2c"
      }
    },
    "goalie": {
      "away": null,
      "home": null,
      "status": "PREGAME_EVIDENCE_REQUIRED"
    },
    "injury": {
      "status": "UNKNOWN",
      "availableAt": null,
      "players": null,
      "source": null
    },
    "lineup": {
      "status": "UNKNOWN",
      "availableAt": null,
      "players": null,
      "source": null
    },
    "advanced": {
      "fiveOnFive": null,
      "xGF": null,
      "xGA": null,
      "goalieGsax": null,
      "status": "SOURCE_NOT_CONNECTED"
    },
    "qa": {
      "status": "PASS",
      "issues": [],
      "warnings": [
        "NHL_PREGAME_INJURY_LINEUP_GOALIE_EVIDENCE_MISSING",
        "NHL_XG_5V5_FEATURES_UNAVAILABLE"
      ],
      "canUseHistoricalPeriods": true,
      "pregameModelReady": false
    }
  },
  {
    "leagueId": "NHL",
    "gameId": "2023020049",
    "officialGameId": "2023020049",
    "season": 20232024,
    "gameType": 2,
    "startTimeUTC": "2023-10-18T23:00:00Z",
    "taipeiDate": "2023-10-19",
    "officialDate": "2023-10-18",
    "awayTeamId": 15,
    "homeTeamId": 9,
    "away": {
      "leagueId": "NHL",
      "teamId": 15,
      "identityKey": "NHL:team:15",
      "abbrev": "WSH",
      "name": "Washington Capitals"
    },
    "home": {
      "leagueId": "NHL",
      "teamId": 9,
      "identityKey": "NHL:team:9",
      "abbrev": "OTT",
      "name": "Ottawa Senators"
    },
    "venue": "Canadian Tire Centre",
    "venueTimezone": "US/Eastern",
    "neutralSite": false,
    "gameState": "OFF",
    "gameScheduleState": "OK",
    "final": {
      "awayGoals": 1,
      "homeGoals": 6
    },
    "outcomeType": "REG",
    "source": {
      "provider": "NHL",
      "url": "https://api-web.nhle.com/v1/gamecenter/2023020049/landing",
      "fetchedAt": "2026-09-06T02:52:47.861Z",
      "acquiredVia": "WEB_PUBLIC_SOURCE",
      "sourceUpdatedAt": null,
      "contentHash": "5ba9e41344295e00279d98366efee164b89f85fb12598b9f856bcb349b7ae68c"
    },
    "seasonPhase": "REGULAR",
    "periods": [
      {
        "awayGoals": 1,
        "homeGoals": 2
      },
      {
        "awayGoals": 0,
        "homeGoals": 3
      },
      {
        "awayGoals": 0,
        "homeGoals": 1
      }
    ],
    "regulation": {
      "awayGoals": 1,
      "homeGoals": 6
    },
    "outcomeAvailableAt": null,
    "historical": true,
    "identity": {
      "ok": true,
      "status": "PASS",
      "issues": [],
      "identityKey": "NHL:2023020049:15:9:2023-10-18T23:00:00Z"
    },
    "league": "NHL",
    "northAmericaDate": "2023-10-18",
    "awayName": "Washington Capitals",
    "homeName": "Ottawa Senators",
    "awayAbbrev": "WSH",
    "homeAbbrev": "OTT",
    "status": "OFF",
    "teamStatistics": {
      "away": {
        "shotsOnGoal": 24
      },
      "home": {
        "shotsOnGoal": 29
      },
      "source": {
        "provider": "NHL",
        "url": "https://api-web.nhle.com/v1/gamecenter/2023020049/landing",
        "fetchedAt": "2026-09-06T02:52:47.861Z",
        "acquiredVia": "WEB_PUBLIC_SOURCE",
        "sourceUpdatedAt": null,
        "contentHash": "5ba9e41344295e00279d98366efee164b89f85fb12598b9f856bcb349b7ae68c"
      }
    },
    "goalie": {
      "away": null,
      "home": null,
      "status": "PREGAME_EVIDENCE_REQUIRED"
    },
    "injury": {
      "status": "UNKNOWN",
      "availableAt": null,
      "players": null,
      "source": null
    },
    "lineup": {
      "status": "UNKNOWN",
      "availableAt": null,
      "players": null,
      "source": null
    },
    "advanced": {
      "fiveOnFive": null,
      "xGF": null,
      "xGA": null,
      "goalieGsax": null,
      "status": "SOURCE_NOT_CONNECTED"
    },
    "qa": {
      "status": "PASS",
      "issues": [],
      "warnings": [
        "NHL_PREGAME_INJURY_LINEUP_GOALIE_EVIDENCE_MISSING",
        "NHL_XG_5V5_FEATURES_UNAVAILABLE"
      ],
      "canUseHistoricalPeriods": true,
      "pregameModelReady": false
    }
  },
  {
    "leagueId": "NHL",
    "gameId": "2023020061",
    "officialGameId": "2023020061",
    "season": 20232024,
    "gameType": 2,
    "startTimeUTC": "2023-10-20T02:30:00Z",
    "taipeiDate": "2023-10-20",
    "officialDate": "2023-10-19",
    "awayTeamId": 16,
    "homeTeamId": 21,
    "away": {
      "leagueId": "NHL",
      "teamId": 16,
      "identityKey": "NHL:team:16",
      "abbrev": "CHI",
      "name": "Chicago Blackhawks"
    },
    "home": {
      "leagueId": "NHL",
      "teamId": 21,
      "identityKey": "NHL:team:21",
      "abbrev": "COL",
      "name": "Colorado Avalanche"
    },
    "venue": "Ball Arena",
    "venueTimezone": "America/Denver",
    "neutralSite": false,
    "gameState": "OFF",
    "gameScheduleState": "OK",
    "final": {
      "awayGoals": 0,
      "homeGoals": 4
    },
    "outcomeType": "REG",
    "source": {
      "provider": "NHL",
      "url": "https://api-web.nhle.com/v1/gamecenter/2023020061/landing",
      "fetchedAt": "2026-09-06T02:52:48.617Z",
      "acquiredVia": "WEB_PUBLIC_SOURCE",
      "sourceUpdatedAt": null,
      "contentHash": "1b61e2d6d580bf094a99e9dc6fec4ea14df1006f7bb5b4d931e68e6052dfcad7"
    },
    "seasonPhase": "REGULAR",
    "periods": [
      {
        "awayGoals": 0,
        "homeGoals": 2
      },
      {
        "awayGoals": 0,
        "homeGoals": 1
      },
      {
        "awayGoals": 0,
        "homeGoals": 1
      }
    ],
    "regulation": {
      "awayGoals": 0,
      "homeGoals": 4
    },
    "outcomeAvailableAt": null,
    "historical": true,
    "identity": {
      "ok": true,
      "status": "PASS",
      "issues": [],
      "identityKey": "NHL:2023020061:16:21:2023-10-20T02:30:00Z"
    },
    "league": "NHL",
    "northAmericaDate": "2023-10-19",
    "awayName": "Chicago Blackhawks",
    "homeName": "Colorado Avalanche",
    "awayAbbrev": "CHI",
    "homeAbbrev": "COL",
    "status": "OFF",
    "teamStatistics": {
      "away": {
        "shotsOnGoal": 18
      },
      "home": {
        "shotsOnGoal": 41
      },
      "source": {
        "provider": "NHL",
        "url": "https://api-web.nhle.com/v1/gamecenter/2023020061/landing",
        "fetchedAt": "2026-09-06T02:52:48.617Z",
        "acquiredVia": "WEB_PUBLIC_SOURCE",
        "sourceUpdatedAt": null,
        "contentHash": "1b61e2d6d580bf094a99e9dc6fec4ea14df1006f7bb5b4d931e68e6052dfcad7"
      }
    },
    "goalie": {
      "away": null,
      "home": null,
      "status": "PREGAME_EVIDENCE_REQUIRED"
    },
    "injury": {
      "status": "UNKNOWN",
      "availableAt": null,
      "players": null,
      "source": null
    },
    "lineup": {
      "status": "UNKNOWN",
      "availableAt": null,
      "players": null,
      "source": null
    },
    "advanced": {
      "fiveOnFive": null,
      "xGF": null,
      "xGA": null,
      "goalieGsax": null,
      "status": "SOURCE_NOT_CONNECTED"
    },
    "qa": {
      "status": "PASS",
      "issues": [],
      "warnings": [
        "NHL_PREGAME_INJURY_LINEUP_GOALIE_EVIDENCE_MISSING",
        "NHL_XG_5V5_FEATURES_UNAVAILABLE"
      ],
      "canUseHistoricalPeriods": true,
      "pregameModelReady": false
    }
  },
  {
    "leagueId": "NHL",
    "gameId": "2023020069",
    "officialGameId": "2023020069",
    "season": 20232024,
    "gameType": 2,
    "startTimeUTC": "2023-10-21T23:00:00Z",
    "taipeiDate": "2023-10-22",
    "officialDate": "2023-10-21",
    "awayTeamId": 15,
    "homeTeamId": 8,
    "away": {
      "leagueId": "NHL",
      "teamId": 15,
      "identityKey": "NHL:team:15",
      "abbrev": "WSH",
      "name": "Washington Capitals"
    },
    "home": {
      "leagueId": "NHL",
      "teamId": 8,
      "identityKey": "NHL:team:8",
      "abbrev": "MTL",
      "name": "Montréal Canadiens"
    },
    "venue": "Centre Bell",
    "venueTimezone": "America/Montreal",
    "neutralSite": false,
    "gameState": "OFF",
    "gameScheduleState": "OK",
    "final": {
      "awayGoals": 2,
      "homeGoals": 3
    },
    "outcomeType": "OT",
    "source": {
      "provider": "NHL",
      "url": "https://api-web.nhle.com/v1/gamecenter/2023020069/landing",
      "fetchedAt": "2026-09-06T02:52:49.373Z",
      "acquiredVia": "WEB_PUBLIC_SOURCE",
      "sourceUpdatedAt": null,
      "contentHash": "55e2706502ae8b7ba2a219817486480bcc651a9a08635c6e9039216c192c48ed"
    },
    "seasonPhase": "REGULAR",
    "periods": [
      {
        "awayGoals": 0,
        "homeGoals": 1
      },
      {
        "awayGoals": 0,
        "homeGoals": 1
      },
      {
        "awayGoals": 2,
        "homeGoals": 0
      }
    ],
    "regulation": {
      "awayGoals": 2,
      "homeGoals": 2
    },
    "outcomeAvailableAt": null,
    "historical": true,
    "identity": {
      "ok": true,
      "status": "PASS",
      "issues": [],
      "identityKey": "NHL:2023020069:15:8:2023-10-21T23:00:00Z"
    },
    "league": "NHL",
    "northAmericaDate": "2023-10-21",
    "awayName": "Washington Capitals",
    "homeName": "Montréal Canadiens",
    "awayAbbrev": "WSH",
    "homeAbbrev": "MTL",
    "status": "OFF",
    "teamStatistics": {
      "away": {
        "shotsOnGoal": 33
      },
      "home": {
        "shotsOnGoal": 28
      },
      "source": {
        "provider": "NHL",
        "url": "https://api-web.nhle.com/v1/gamecenter/2023020069/landing",
        "fetchedAt": "2026-09-06T02:52:49.373Z",
        "acquiredVia": "WEB_PUBLIC_SOURCE",
        "sourceUpdatedAt": null,
        "contentHash": "55e2706502ae8b7ba2a219817486480bcc651a9a08635c6e9039216c192c48ed"
      }
    },
    "goalie": {
      "away": null,
      "home": null,
      "status": "PREGAME_EVIDENCE_REQUIRED"
    },
    "injury": {
      "status": "UNKNOWN",
      "availableAt": null,
      "players": null,
      "source": null
    },
    "lineup": {
      "status": "UNKNOWN",
      "availableAt": null,
      "players": null,
      "source": null
    },
    "advanced": {
      "fiveOnFive": null,
      "xGF": null,
      "xGA": null,
      "goalieGsax": null,
      "status": "SOURCE_NOT_CONNECTED"
    },
    "qa": {
      "status": "PASS",
      "issues": [],
      "warnings": [
        "NHL_PREGAME_INJURY_LINEUP_GOALIE_EVIDENCE_MISSING",
        "NHL_XG_5V5_FEATURES_UNAVAILABLE"
      ],
      "canUseHistoricalPeriods": true,
      "pregameModelReady": false
    }
  },
  {
    "leagueId": "NHL",
    "gameId": "2023020071",
    "officialGameId": "2023020071",
    "season": 20232024,
    "gameType": 2,
    "startTimeUTC": "2023-10-22T00:00:00Z",
    "taipeiDate": "2023-10-22",
    "officialDate": "2023-10-21",
    "awayTeamId": 54,
    "homeTeamId": 16,
    "away": {
      "leagueId": "NHL",
      "teamId": 54,
      "identityKey": "NHL:team:54",
      "abbrev": "VGK",
      "name": "Vegas Golden Knights"
    },
    "home": {
      "leagueId": "NHL",
      "teamId": 16,
      "identityKey": "NHL:team:16",
      "abbrev": "CHI",
      "name": "Chicago Blackhawks"
    },
    "venue": "United Center",
    "venueTimezone": "America/Chicago",
    "neutralSite": false,
    "gameState": "OFF",
    "gameScheduleState": "OK",
    "final": {
      "awayGoals": 5,
      "homeGoals": 3
    },
    "outcomeType": "REG",
    "source": {
      "provider": "NHL",
      "url": "https://api-web.nhle.com/v1/gamecenter/2023020071/landing",
      "fetchedAt": "2026-09-06T02:53:39.706Z",
      "acquiredVia": "WEB_PUBLIC_SOURCE",
      "sourceUpdatedAt": null,
      "contentHash": "33c1d753eb488e308b4082e52cf1d92a631a0adfdf96ec1a0a24189193ac9898"
    },
    "seasonPhase": "REGULAR",
    "periods": [
      {
        "awayGoals": 1,
        "homeGoals": 1
      },
      {
        "awayGoals": 1,
        "homeGoals": 1
      },
      {
        "awayGoals": 3,
        "homeGoals": 1
      }
    ],
    "regulation": {
      "awayGoals": 5,
      "homeGoals": 3
    },
    "outcomeAvailableAt": null,
    "historical": true,
    "identity": {
      "ok": true,
      "status": "PASS",
      "issues": [],
      "identityKey": "NHL:2023020071:54:16:2023-10-22T00:00:00Z"
    },
    "league": "NHL",
    "northAmericaDate": "2023-10-21",
    "awayName": "Vegas Golden Knights",
    "homeName": "Chicago Blackhawks",
    "awayAbbrev": "VGK",
    "homeAbbrev": "CHI",
    "status": "OFF",
    "teamStatistics": {
      "away": {
        "shotsOnGoal": 24
      },
      "home": {
        "shotsOnGoal": 24
      },
      "source": {
        "provider": "NHL",
        "url": "https://api-web.nhle.com/v1/gamecenter/2023020071/landing",
        "fetchedAt": "2026-09-06T02:53:39.706Z",
        "acquiredVia": "WEB_PUBLIC_SOURCE",
        "sourceUpdatedAt": null,
        "contentHash": "33c1d753eb488e308b4082e52cf1d92a631a0adfdf96ec1a0a24189193ac9898"
      }
    },
    "goalie": {
      "away": null,
      "home": null,
      "status": "PREGAME_EVIDENCE_REQUIRED"
    },
    "injury": {
      "status": "UNKNOWN",
      "availableAt": null,
      "players": null,
      "source": null
    },
    "lineup": {
      "status": "UNKNOWN",
      "availableAt": null,
      "players": null,
      "source": null
    },
    "advanced": {
      "fiveOnFive": null,
      "xGF": null,
      "xGA": null,
      "goalieGsax": null,
      "status": "SOURCE_NOT_CONNECTED"
    },
    "qa": {
      "status": "PASS",
      "issues": [],
      "warnings": [
        "NHL_PREGAME_INJURY_LINEUP_GOALIE_EVIDENCE_MISSING",
        "NHL_XG_5V5_FEATURES_UNAVAILABLE"
      ],
      "canUseHistoricalPeriods": true,
      "pregameModelReady": false
    }
  },
  {
    "leagueId": "NHL",
    "gameId": "2023020085",
    "officialGameId": "2023020085",
    "season": 20232024,
    "gameType": 2,
    "startTimeUTC": "2023-10-24T22:45:00Z",
    "taipeiDate": "2023-10-25",
    "officialDate": "2023-10-24",
    "awayTeamId": 7,
    "homeTeamId": 9,
    "away": {
      "leagueId": "NHL",
      "teamId": 7,
      "identityKey": "NHL:team:7",
      "abbrev": "BUF",
      "name": "Buffalo Sabres"
    },
    "home": {
      "leagueId": "NHL",
      "teamId": 9,
      "identityKey": "NHL:team:9",
      "abbrev": "OTT",
      "name": "Ottawa Senators"
    },
    "venue": "Canadian Tire Centre",
    "venueTimezone": "US/Eastern",
    "neutralSite": false,
    "gameState": "OFF",
    "gameScheduleState": "OK",
    "final": {
      "awayGoals": 6,
      "homeGoals": 4
    },
    "outcomeType": "REG",
    "source": {
      "provider": "NHL",
      "url": "https://api-web.nhle.com/v1/gamecenter/2023020085/landing",
      "fetchedAt": "2026-09-06T02:53:40.462Z",
      "acquiredVia": "WEB_PUBLIC_SOURCE",
      "sourceUpdatedAt": null,
      "contentHash": "27914754ea15947ef1802fece0e56b7bd974513814f8764142ef6e6f34ecdf67"
    },
    "seasonPhase": "REGULAR",
    "periods": [
      {
        "awayGoals": 2,
        "homeGoals": 0
      },
      {
        "awayGoals": 3,
        "homeGoals": 1
      },
      {
        "awayGoals": 1,
        "homeGoals": 3
      }
    ],
    "regulation": {
      "awayGoals": 6,
      "homeGoals": 4
    },
    "outcomeAvailableAt": null,
    "historical": true,
    "identity": {
      "ok": true,
      "status": "PASS",
      "issues": [],
      "identityKey": "NHL:2023020085:7:9:2023-10-24T22:45:00Z"
    },
    "league": "NHL",
    "northAmericaDate": "2023-10-24",
    "awayName": "Buffalo Sabres",
    "homeName": "Ottawa Senators",
    "awayAbbrev": "BUF",
    "homeAbbrev": "OTT",
    "status": "OFF",
    "teamStatistics": {
      "away": {
        "shotsOnGoal": 24
      },
      "home": {
        "shotsOnGoal": 38
      },
      "source": {
        "provider": "NHL",
        "url": "https://api-web.nhle.com/v1/gamecenter/2023020085/landing",
        "fetchedAt": "2026-09-06T02:53:40.462Z",
        "acquiredVia": "WEB_PUBLIC_SOURCE",
        "sourceUpdatedAt": null,
        "contentHash": "27914754ea15947ef1802fece0e56b7bd974513814f8764142ef6e6f34ecdf67"
      }
    },
    "goalie": {
      "away": null,
      "home": null,
      "status": "PREGAME_EVIDENCE_REQUIRED"
    },
    "injury": {
      "status": "UNKNOWN",
      "availableAt": null,
      "players": null,
      "source": null
    },
    "lineup": {
      "status": "UNKNOWN",
      "availableAt": null,
      "players": null,
      "source": null
    },
    "advanced": {
      "fiveOnFive": null,
      "xGF": null,
      "xGA": null,
      "goalieGsax": null,
      "status": "SOURCE_NOT_CONNECTED"
    },
    "qa": {
      "status": "PASS",
      "issues": [],
      "warnings": [
        "NHL_PREGAME_INJURY_LINEUP_GOALIE_EVIDENCE_MISSING",
        "NHL_XG_5V5_FEATURES_UNAVAILABLE"
      ],
      "canUseHistoricalPeriods": true,
      "pregameModelReady": false
    }
  },
  {
    "leagueId": "NHL",
    "gameId": "2023020094",
    "officialGameId": "2023020094",
    "season": 20232024,
    "gameType": 2,
    "startTimeUTC": "2023-10-25T01:00:00Z",
    "taipeiDate": "2023-10-25",
    "officialDate": "2023-10-24",
    "awayTeamId": 22,
    "homeTeamId": 30,
    "away": {
      "leagueId": "NHL",
      "teamId": 22,
      "identityKey": "NHL:team:22",
      "abbrev": "EDM",
      "name": "Edmonton Oilers"
    },
    "home": {
      "leagueId": "NHL",
      "teamId": 30,
      "identityKey": "NHL:team:30",
      "abbrev": "MIN",
      "name": "Minnesota Wild"
    },
    "venue": "Xcel Energy Center",
    "venueTimezone": "US/Central",
    "neutralSite": false,
    "gameState": "OFF",
    "gameScheduleState": "OK",
    "final": {
      "awayGoals": 4,
      "homeGoals": 7
    },
    "outcomeType": "REG",
    "source": {
      "provider": "NHL",
      "url": "https://api-web.nhle.com/v1/gamecenter/2023020094/landing",
      "fetchedAt": "2026-09-06T02:53:41.214Z",
      "acquiredVia": "WEB_PUBLIC_SOURCE",
      "sourceUpdatedAt": null,
      "contentHash": "98efcca2bee56780a2fc4861458da935e19a0ad3a4e58439ded44c1452055b49"
    },
    "seasonPhase": "REGULAR",
    "periods": [
      {
        "awayGoals": 2,
        "homeGoals": 2
      },
      {
        "awayGoals": 1,
        "homeGoals": 0
      },
      {
        "awayGoals": 1,
        "homeGoals": 5
      }
    ],
    "regulation": {
      "awayGoals": 4,
      "homeGoals": 7
    },
    "outcomeAvailableAt": null,
    "historical": true,
    "identity": {
      "ok": true,
      "status": "PASS",
      "issues": [],
      "identityKey": "NHL:2023020094:22:30:2023-10-25T01:00:00Z"
    },
    "league": "NHL",
    "northAmericaDate": "2023-10-24",
    "awayName": "Edmonton Oilers",
    "homeName": "Minnesota Wild",
    "awayAbbrev": "EDM",
    "homeAbbrev": "MIN",
    "status": "OFF",
    "teamStatistics": {
      "away": {
        "shotsOnGoal": 28
      },
      "home": {
        "shotsOnGoal": 32
      },
      "source": {
        "provider": "NHL",
        "url": "https://api-web.nhle.com/v1/gamecenter/2023020094/landing",
        "fetchedAt": "2026-09-06T02:53:41.214Z",
        "acquiredVia": "WEB_PUBLIC_SOURCE",
        "sourceUpdatedAt": null,
        "contentHash": "98efcca2bee56780a2fc4861458da935e19a0ad3a4e58439ded44c1452055b49"
      }
    },
    "goalie": {
      "away": null,
      "home": null,
      "status": "PREGAME_EVIDENCE_REQUIRED"
    },
    "injury": {
      "status": "UNKNOWN",
      "availableAt": null,
      "players": null,
      "source": null
    },
    "lineup": {
      "status": "UNKNOWN",
      "availableAt": null,
      "players": null,
      "source": null
    },
    "advanced": {
      "fiveOnFive": null,
      "xGF": null,
      "xGA": null,
      "goalieGsax": null,
      "status": "SOURCE_NOT_CONNECTED"
    },
    "qa": {
      "status": "PASS",
      "issues": [],
      "warnings": [
        "NHL_PREGAME_INJURY_LINEUP_GOALIE_EVIDENCE_MISSING",
        "NHL_XG_5V5_FEATURES_UNAVAILABLE"
      ],
      "canUseHistoricalPeriods": true,
      "pregameModelReady": false
    }
  },
  {
    "leagueId": "NHL",
    "gameId": "2023020101",
    "officialGameId": "2023020101",
    "season": 20232024,
    "gameType": 2,
    "startTimeUTC": "2023-10-26T23:00:00Z",
    "taipeiDate": "2023-10-27",
    "officialDate": "2023-10-26",
    "awayTeamId": 55,
    "homeTeamId": 12,
    "away": {
      "leagueId": "NHL",
      "teamId": 55,
      "identityKey": "NHL:team:55",
      "abbrev": "SEA",
      "name": "Seattle Kraken"
    },
    "home": {
      "leagueId": "NHL",
      "teamId": 12,
      "identityKey": "NHL:team:12",
      "abbrev": "CAR",
      "name": "Carolina Hurricanes"
    },
    "venue": "PNC Arena",
    "venueTimezone": "US/Eastern",
    "neutralSite": false,
    "gameState": "OFF",
    "gameScheduleState": "OK",
    "final": {
      "awayGoals": 2,
      "homeGoals": 3
    },
    "outcomeType": "OT",
    "source": {
      "provider": "NHL",
      "url": "https://api-web.nhle.com/v1/gamecenter/2023020101/landing",
      "fetchedAt": "2026-09-06T02:53:41.966Z",
      "acquiredVia": "WEB_PUBLIC_SOURCE",
      "sourceUpdatedAt": null,
      "contentHash": "6351e5d8bced8152ede10486fa837c04e8c0b2ad3d03be9e351291815402397b"
    },
    "seasonPhase": "REGULAR",
    "periods": [
      {
        "awayGoals": 2,
        "homeGoals": 1
      },
      {
        "awayGoals": 0,
        "homeGoals": 0
      },
      {
        "awayGoals": 0,
        "homeGoals": 1
      }
    ],
    "regulation": {
      "awayGoals": 2,
      "homeGoals": 2
    },
    "outcomeAvailableAt": null,
    "historical": true,
    "identity": {
      "ok": true,
      "status": "PASS",
      "issues": [],
      "identityKey": "NHL:2023020101:55:12:2023-10-26T23:00:00Z"
    },
    "league": "NHL",
    "northAmericaDate": "2023-10-26",
    "awayName": "Seattle Kraken",
    "homeName": "Carolina Hurricanes",
    "awayAbbrev": "SEA",
    "homeAbbrev": "CAR",
    "status": "OFF",
    "teamStatistics": {
      "away": {
        "shotsOnGoal": 26
      },
      "home": {
        "shotsOnGoal": 45
      },
      "source": {
        "provider": "NHL",
        "url": "https://api-web.nhle.com/v1/gamecenter/2023020101/landing",
        "fetchedAt": "2026-09-06T02:53:41.966Z",
        "acquiredVia": "WEB_PUBLIC_SOURCE",
        "sourceUpdatedAt": null,
        "contentHash": "6351e5d8bced8152ede10486fa837c04e8c0b2ad3d03be9e351291815402397b"
      }
    },
    "goalie": {
      "away": null,
      "home": null,
      "status": "PREGAME_EVIDENCE_REQUIRED"
    },
    "injury": {
      "status": "UNKNOWN",
      "availableAt": null,
      "players": null,
      "source": null
    },
    "lineup": {
      "status": "UNKNOWN",
      "availableAt": null,
      "players": null,
      "source": null
    },
    "advanced": {
      "fiveOnFive": null,
      "xGF": null,
      "xGA": null,
      "goalieGsax": null,
      "status": "SOURCE_NOT_CONNECTED"
    },
    "qa": {
      "status": "PASS",
      "issues": [],
      "warnings": [
        "NHL_PREGAME_INJURY_LINEUP_GOALIE_EVIDENCE_MISSING",
        "NHL_XG_5V5_FEATURES_UNAVAILABLE"
      ],
      "canUseHistoricalPeriods": true,
      "pregameModelReady": false
    }
  },
  {
    "leagueId": "NHL",
    "gameId": "2023020204",
    "officialGameId": "2023020204",
    "season": 20232024,
    "gameType": 2,
    "startTimeUTC": "2023-11-11T00:00:00Z",
    "taipeiDate": "2023-11-11",
    "officialDate": "2023-11-10",
    "awayTeamId": 30,
    "homeTeamId": 7,
    "away": {
      "leagueId": "NHL",
      "teamId": 30,
      "identityKey": "NHL:team:30",
      "abbrev": "MIN",
      "name": "Minnesota Wild"
    },
    "home": {
      "leagueId": "NHL",
      "teamId": 7,
      "identityKey": "NHL:team:7",
      "abbrev": "BUF",
      "name": "Buffalo Sabres"
    },
    "venue": "KeyBank Center",
    "venueTimezone": "America/New_York",
    "neutralSite": false,
    "gameState": "OFF",
    "gameScheduleState": "OK",
    "final": {
      "awayGoals": 2,
      "homeGoals": 3
    },
    "outcomeType": "REG",
    "source": {
      "provider": "NHL",
      "url": "https://api-web.nhle.com/v1/gamecenter/2023020204/landing",
      "fetchedAt": "2026-09-06T02:39:27.812Z",
      "acquiredVia": "WEB_PUBLIC_SOURCE",
      "sourceUpdatedAt": null,
      "contentHash": "fa4085d038bcd1c1293f89513a2ff1dea0d388f5d003546e34f805be8ae388fe"
    },
    "seasonPhase": "REGULAR",
    "periods": [
      {
        "awayGoals": 1,
        "homeGoals": 1
      },
      {
        "awayGoals": 0,
        "homeGoals": 1
      },
      {
        "awayGoals": 1,
        "homeGoals": 1
      }
    ],
    "regulation": {
      "awayGoals": 2,
      "homeGoals": 3
    },
    "outcomeAvailableAt": null,
    "historical": true,
    "identity": {
      "ok": true,
      "status": "PASS",
      "issues": [],
      "identityKey": "NHL:2023020204:30:7:2023-11-11T00:00:00Z"
    },
    "league": "NHL",
    "northAmericaDate": "2023-11-10",
    "awayName": "Minnesota Wild",
    "homeName": "Buffalo Sabres",
    "awayAbbrev": "MIN",
    "homeAbbrev": "BUF",
    "status": "OFF",
    "playerStatistics": {
      "away": {
        "skaters": [
          {
            "playerId": 8479968,
            "sweaterNumber": 10,
            "name": {
              "default": "V. Lettieri"
            },
            "position": "C",
            "goals": 0,
            "assists": 0,
            "points": 0,
            "plusMinus": 0,
            "pim": 0,
            "hits": 3,
            "powerPlayGoals": 0,
            "sog": 2,
            "faceoffWinningPctg": 0,
            "toi": "11:11",
            "blockedShots": 0,
            "shifts": 13,
            "giveaways": 0,
            "takeaways": 0,
            "teamId": 30,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020204/boxscore",
              "fetchedAt": "2026-09-06T02:53:43.518Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "82b6620b95c179b4edf0c6f7f1da7cea413ffe844524dfac314a58ea2f876c3d"
            }
          },
          {
            "playerId": 8481557,
            "sweaterNumber": 12,
            "name": {
              "default": "M. Boldy"
            },
            "position": "L",
            "goals": 0,
            "assists": 1,
            "points": 1,
            "plusMinus": -1,
            "pim": 0,
            "hits": 0,
            "powerPlayGoals": 0,
            "sog": 4,
            "faceoffWinningPctg": 0.5,
            "toi": "17:02",
            "blockedShots": 1,
            "shifts": 17,
            "giveaways": 0,
            "takeaways": 0,
            "teamId": 30,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020204/boxscore",
              "fetchedAt": "2026-09-06T02:53:43.518Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "82b6620b95c179b4edf0c6f7f1da7cea413ffe844524dfac314a58ea2f876c3d"
            }
          },
          {
            "playerId": 8478493,
            "sweaterNumber": 14,
            "name": {
              "default": "J. Eriksson Ek"
            },
            "position": "C",
            "goals": 1,
            "assists": 0,
            "points": 1,
            "plusMinus": -1,
            "pim": 2,
            "hits": 0,
            "powerPlayGoals": 1,
            "sog": 7,
            "faceoffWinningPctg": 0.826087,
            "toi": "19:47",
            "blockedShots": 0,
            "shifts": 20,
            "giveaways": 0,
            "takeaways": 0,
            "teamId": 30,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020204/boxscore",
              "fetchedAt": "2026-09-06T02:53:43.518Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "82b6620b95c179b4edf0c6f7f1da7cea413ffe844524dfac314a58ea2f876c3d"
            }
          },
          {
            "playerId": 8475220,
            "sweaterNumber": 17,
            "name": {
              "default": "M. Foligno"
            },
            "position": "L",
            "goals": 0,
            "assists": 0,
            "points": 0,
            "plusMinus": -1,
            "pim": 0,
            "hits": 9,
            "powerPlayGoals": 0,
            "sog": 0,
            "faceoffWinningPctg": 0,
            "toi": "15:29",
            "blockedShots": 1,
            "shifts": 20,
            "giveaways": 0,
            "takeaways": 2,
            "teamId": 30,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020204/boxscore",
              "fetchedAt": "2026-09-06T02:53:43.518Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "82b6620b95c179b4edf0c6f7f1da7cea413ffe844524dfac314a58ea2f876c3d"
            }
          },
          {
            "playerId": 8474034,
            "sweaterNumber": 20,
            "name": {
              "default": "P. Maroon"
            },
            "position": "L",
            "goals": 0,
            "assists": 0,
            "points": 0,
            "plusMinus": -1,
            "pim": 0,
            "hits": 2,
            "powerPlayGoals": 0,
            "sog": 2,
            "faceoffWinningPctg": 0,
            "toi": "14:48",
            "blockedShots": 0,
            "shifts": 17,
            "giveaways": 0,
            "takeaways": 0,
            "teamId": 30,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020204/boxscore",
              "fetchedAt": "2026-09-06T02:53:43.518Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "82b6620b95c179b4edf0c6f7f1da7cea413ffe844524dfac314a58ea2f876c3d"
            }
          },
          {
            "playerId": 8479520,
            "sweaterNumber": 21,
            "name": {
              "default": "B. Duhaime"
            },
            "position": "L",
            "goals": 0,
            "assists": 0,
            "points": 0,
            "plusMinus": 0,
            "pim": 0,
            "hits": 4,
            "powerPlayGoals": 0,
            "sog": 0,
            "faceoffWinningPctg": 0,
            "toi": "09:55",
            "blockedShots": 1,
            "shifts": 14,
            "giveaways": 0,
            "takeaways": 0,
            "teamId": 30,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020204/boxscore",
              "fetchedAt": "2026-09-06T02:53:43.518Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "82b6620b95c179b4edf0c6f7f1da7cea413ffe844524dfac314a58ea2f876c3d"
            }
          },
          {
            "playerId": 8482079,
            "sweaterNumber": 23,
            "name": {
              "default": "M. Rossi"
            },
            "position": "C",
            "goals": 0,
            "assists": 0,
            "points": 0,
            "plusMinus": 0,
            "pim": 0,
            "hits": 1,
            "powerPlayGoals": 0,
            "sog": 1,
            "faceoffWinningPctg": 0.75,
            "toi": "15:02",
            "blockedShots": 0,
            "shifts": 15,
            "giveaways": 0,
            "takeaways": 1,
            "teamId": 30,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020204/boxscore",
              "fetchedAt": "2026-09-06T02:53:43.518Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "82b6620b95c179b4edf0c6f7f1da7cea413ffe844524dfac314a58ea2f876c3d"
            }
          },
          {
            "playerId": 8480980,
            "sweaterNumber": 26,
            "name": {
              "default": "C. Dewar"
            },
            "position": "C",
            "goals": 0,
            "assists": 0,
            "points": 0,
            "plusMinus": 0,
            "pim": 0,
            "hits": 1,
            "powerPlayGoals": 0,
            "sog": 0,
            "faceoffWinningPctg": 0.833333,
            "toi": "10:59",
            "blockedShots": 1,
            "shifts": 14,
            "giveaways": 1,
            "takeaways": 0,
            "teamId": 30,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020204/boxscore",
              "fetchedAt": "2026-09-06T02:53:43.518Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "82b6620b95c179b4edf0c6f7f1da7cea413ffe844524dfac314a58ea2f876c3d"
            }
          },
          {
            "playerId": 8475692,
            "sweaterNumber": 36,
            "name": {
              "default": "M. Zuccarello"
            },
            "position": "R",
            "goals": 0,
            "assists": 2,
            "points": 2,
            "plusMinus": -1,
            "pim": 0,
            "hits": 0,
            "powerPlayGoals": 0,
            "sog": 6,
            "faceoffWinningPctg": 0,
            "toi": "19:16",
            "blockedShots": 0,
            "shifts": 20,
            "giveaways": 0,
            "takeaways": 0,
            "teamId": 30,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020204/boxscore",
              "fetchedAt": "2026-09-06T02:53:43.518Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "82b6620b95c179b4edf0c6f7f1da7cea413ffe844524dfac314a58ea2f876c3d"
            }
          },
          {
            "playerId": 8477451,
            "sweaterNumber": 38,
            "name": {
              "default": "R. Hartman"
            },
            "position": "R",
            "goals": 0,
            "assists": 0,
            "points": 0,
            "plusMinus": -2,
            "pim": 0,
            "hits": 1,
            "powerPlayGoals": 0,
            "sog": 5,
            "faceoffWinningPctg": 0.705882,
            "toi": "15:22",
            "blockedShots": 1,
            "shifts": 19,
            "giveaways": 1,
            "takeaways": 1,
            "teamId": 30,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020204/boxscore",
              "fetchedAt": "2026-09-06T02:53:43.518Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "82b6620b95c179b4edf0c6f7f1da7cea413ffe844524dfac314a58ea2f876c3d"
            }
          },
          {
            "playerId": 8475149,
            "sweaterNumber": 90,
            "name": {
              "default": "M. Johansson"
            },
            "position": "L",
            "goals": 0,
            "assists": 0,
            "points": 0,
            "plusMinus": -1,
            "pim": 0,
            "hits": 1,
            "powerPlayGoals": 0,
            "sog": 1,
            "faceoffWinningPctg": 0,
            "toi": "16:55",
            "blockedShots": 0,
            "shifts": 16,
            "giveaways": 0,
            "takeaways": 1,
            "teamId": 30,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020204/boxscore",
              "fetchedAt": "2026-09-06T02:53:43.518Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "82b6620b95c179b4edf0c6f7f1da7cea413ffe844524dfac314a58ea2f876c3d"
            }
          },
          {
            "playerId": 8478864,
            "sweaterNumber": 97,
            "name": {
              "default": "K. Kaprizov"
            },
            "position": "L",
            "goals": 1,
            "assists": 1,
            "points": 2,
            "plusMinus": -1,
            "pim": 2,
            "hits": 0,
            "powerPlayGoals": 1,
            "sog": 4,
            "faceoffWinningPctg": 0,
            "toi": "20:56",
            "blockedShots": 0,
            "shifts": 19,
            "giveaways": 0,
            "takeaways": 0,
            "teamId": 30,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020204/boxscore",
              "fetchedAt": "2026-09-06T02:53:43.518Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "82b6620b95c179b4edf0c6f7f1da7cea413ffe844524dfac314a58ea2f876c3d"
            }
          },
          {
            "playerId": 8478136,
            "sweaterNumber": 5,
            "name": {
              "default": "J. Middleton"
            },
            "position": "D",
            "goals": 0,
            "assists": 0,
            "points": 0,
            "plusMinus": -1,
            "pim": 0,
            "hits": 2,
            "powerPlayGoals": 0,
            "sog": 1,
            "faceoffWinningPctg": 0,
            "toi": "16:08",
            "blockedShots": 2,
            "shifts": 21,
            "giveaways": 1,
            "takeaways": 0,
            "teamId": 30,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020204/boxscore",
              "fetchedAt": "2026-09-06T02:53:43.518Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "82b6620b95c179b4edf0c6f7f1da7cea413ffe844524dfac314a58ea2f876c3d"
            }
          },
          {
            "playerId": 8477541,
            "sweaterNumber": 6,
            "name": {
              "default": "D. Mermis"
            },
            "position": "D",
            "goals": 0,
            "assists": 0,
            "points": 0,
            "plusMinus": 0,
            "pim": 0,
            "hits": 2,
            "powerPlayGoals": 0,
            "sog": 0,
            "faceoffWinningPctg": 0,
            "toi": "12:36",
            "blockedShots": 2,
            "shifts": 15,
            "giveaways": 0,
            "takeaways": 0,
            "teamId": 30,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020204/boxscore",
              "fetchedAt": "2026-09-06T02:53:43.518Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "82b6620b95c179b4edf0c6f7f1da7cea413ffe844524dfac314a58ea2f876c3d"
            }
          },
          {
            "playerId": 8482122,
            "sweaterNumber": 7,
            "name": {
              "default": "B. Faber"
            },
            "position": "D",
            "goals": 0,
            "assists": 0,
            "points": 0,
            "plusMinus": -2,
            "pim": 2,
            "hits": 1,
            "powerPlayGoals": 0,
            "sog": 0,
            "faceoffWinningPctg": 0,
            "toi": "19:26",
            "blockedShots": 1,
            "shifts": 26,
            "giveaways": 0,
            "takeaways": 0,
            "teamId": 30,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020204/boxscore",
              "fetchedAt": "2026-09-06T02:53:43.518Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "82b6620b95c179b4edf0c6f7f1da7cea413ffe844524dfac314a58ea2f876c3d"
            }
          },
          {
            "playerId": 8474567,
            "sweaterNumber": 24,
            "name": {
              "default": "Z. Bogosian"
            },
            "position": "D",
            "goals": 0,
            "assists": 0,
            "points": 0,
            "plusMinus": 0,
            "pim": 2,
            "hits": 2,
            "powerPlayGoals": 0,
            "sog": 1,
            "faceoffWinningPctg": 0,
            "toi": "13:30",
            "blockedShots": 1,
            "shifts": 17,
            "giveaways": 0,
            "takeaways": 0,
            "teamId": 30,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020204/boxscore",
              "fetchedAt": "2026-09-06T02:53:43.518Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "82b6620b95c179b4edf0c6f7f1da7cea413ffe844524dfac314a58ea2f876c3d"
            }
          },
          {
            "playerId": 8476463,
            "sweaterNumber": 25,
            "name": {
              "default": "J. Brodin"
            },
            "position": "D",
            "goals": 0,
            "assists": 0,
            "points": 0,
            "plusMinus": -2,
            "pim": 0,
            "hits": 0,
            "powerPlayGoals": 0,
            "sog": 1,
            "faceoffWinningPctg": 0,
            "toi": "23:31",
            "blockedShots": 4,
            "shifts": 27,
            "giveaways": 1,
            "takeaways": 1,
            "teamId": 30,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020204/boxscore",
              "fetchedAt": "2026-09-06T02:53:43.518Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "82b6620b95c179b4edf0c6f7f1da7cea413ffe844524dfac314a58ea2f876c3d"
            }
          },
          {
            "playerId": 8474716,
            "sweaterNumber": 46,
            "name": {
              "default": "J. Spurgeon"
            },
            "position": "D",
            "goals": 0,
            "assists": 0,
            "points": 0,
            "plusMinus": -1,
            "pim": 0,
            "hits": 2,
            "powerPlayGoals": 0,
            "sog": 0,
            "faceoffWinningPctg": 0,
            "toi": "21:52",
            "blockedShots": 3,
            "shifts": 31,
            "giveaways": 0,
            "takeaways": 0,
            "teamId": 30,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020204/boxscore",
              "fetchedAt": "2026-09-06T02:53:43.518Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "82b6620b95c179b4edf0c6f7f1da7cea413ffe844524dfac314a58ea2f876c3d"
            }
          }
        ],
        "goalies": [
          {
            "playerId": 8470594,
            "sweaterNumber": 29,
            "name": {
              "default": "M. Fleury"
            },
            "position": "G",
            "evenStrengthShotsAgainst": "0/0",
            "powerPlayShotsAgainst": "0/0",
            "shorthandedShotsAgainst": "0/0",
            "saveShotsAgainst": "0/0",
            "evenStrengthGoalsAgainst": 0,
            "powerPlayGoalsAgainst": 0,
            "shorthandedGoalsAgainst": 0,
            "pim": 0,
            "goalsAgainst": 0,
            "toi": "00:00",
            "starter": false,
            "shotsAgainst": 0,
            "saves": 0,
            "teamId": 30,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020204/boxscore",
              "fetchedAt": "2026-09-06T02:53:43.518Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "82b6620b95c179b4edf0c6f7f1da7cea413ffe844524dfac314a58ea2f876c3d"
            },
            "confirmationScope": "OBSERVED_GAME_PARTICIPATION",
            "pregameConfirmed": false
          },
          {
            "playerId": 8479406,
            "sweaterNumber": 32,
            "name": {
              "default": "F. Gustavsson"
            },
            "position": "G",
            "evenStrengthShotsAgainst": "12/15",
            "powerPlayShotsAgainst": "7/7",
            "shorthandedShotsAgainst": "3/3",
            "saveShotsAgainst": "22/25",
            "savePctg": 0.88,
            "evenStrengthGoalsAgainst": 3,
            "powerPlayGoalsAgainst": 0,
            "shorthandedGoalsAgainst": 0,
            "pim": 0,
            "goalsAgainst": 3,
            "toi": "58:15",
            "starter": true,
            "decision": "L",
            "shotsAgainst": 25,
            "saves": 22,
            "teamId": 30,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020204/boxscore",
              "fetchedAt": "2026-09-06T02:53:43.518Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "82b6620b95c179b4edf0c6f7f1da7cea413ffe844524dfac314a58ea2f876c3d"
            },
            "confirmationScope": "OBSERVED_GAME_PARTICIPATION",
            "pregameConfirmed": false
          }
        ]
      },
      "home": {
        "skaters": [
          {
            "playerId": 8478413,
            "sweaterNumber": 12,
            "name": {
              "default": "J. Greenway"
            },
            "position": "L",
            "goals": 0,
            "assists": 0,
            "points": 0,
            "plusMinus": 1,
            "pim": 2,
            "hits": 2,
            "powerPlayGoals": 0,
            "sog": 1,
            "faceoffWinningPctg": 0,
            "toi": "22:31",
            "blockedShots": 3,
            "shifts": 24,
            "giveaways": 1,
            "takeaways": 0,
            "teamId": 7,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020204/boxscore",
              "fetchedAt": "2026-09-06T02:53:43.518Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "82b6620b95c179b4edf0c6f7f1da7cea413ffe844524dfac314a58ea2f876c3d"
            }
          },
          {
            "playerId": 8481751,
            "sweaterNumber": 13,
            "name": {
              "default": "L. Rousek"
            },
            "position": "R",
            "goals": 0,
            "assists": 0,
            "points": 0,
            "plusMinus": 0,
            "pim": 0,
            "hits": 0,
            "powerPlayGoals": 0,
            "sog": 0,
            "faceoffWinningPctg": 0,
            "toi": "13:14",
            "blockedShots": 0,
            "shifts": 13,
            "giveaways": 0,
            "takeaways": 0,
            "teamId": 7,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020204/boxscore",
              "fetchedAt": "2026-09-06T02:53:43.518Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "82b6620b95c179b4edf0c6f7f1da7cea413ffe844524dfac314a58ea2f876c3d"
            }
          },
          {
            "playerId": 8479370,
            "sweaterNumber": 17,
            "name": {
              "default": "T. Jost"
            },
            "position": "C",
            "goals": 0,
            "assists": 0,
            "points": 0,
            "plusMinus": 0,
            "pim": 0,
            "hits": 1,
            "powerPlayGoals": 0,
            "sog": 0,
            "faceoffWinningPctg": 0,
            "toi": "10:29",
            "blockedShots": 0,
            "shifts": 13,
            "giveaways": 0,
            "takeaways": 0,
            "teamId": 7,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020204/boxscore",
              "fetchedAt": "2026-09-06T02:53:43.518Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "82b6620b95c179b4edf0c6f7f1da7cea413ffe844524dfac314a58ea2f876c3d"
            }
          },
          {
            "playerId": 8481522,
            "sweaterNumber": 19,
            "name": {
              "default": "P. Krebs"
            },
            "position": "C",
            "goals": 0,
            "assists": 0,
            "points": 0,
            "plusMinus": 0,
            "pim": 0,
            "hits": 0,
            "powerPlayGoals": 0,
            "sog": 0,
            "faceoffWinningPctg": 0,
            "toi": "06:05",
            "blockedShots": 1,
            "shifts": 7,
            "giveaways": 0,
            "takeaways": 0,
            "teamId": 7,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020204/boxscore",
              "fetchedAt": "2026-09-06T02:53:43.518Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "82b6620b95c179b4edf0c6f7f1da7cea413ffe844524dfac314a58ea2f876c3d"
            }
          },
          {
            "playerId": 8473449,
            "sweaterNumber": 21,
            "name": {
              "default": "K. Okposo"
            },
            "position": "R",
            "goals": 0,
            "assists": 0,
            "points": 0,
            "plusMinus": 0,
            "pim": 0,
            "hits": 1,
            "powerPlayGoals": 0,
            "sog": 2,
            "faceoffWinningPctg": 0.333333,
            "toi": "14:40",
            "blockedShots": 1,
            "shifts": 21,
            "giveaways": 0,
            "takeaways": 0,
            "teamId": 7,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020204/boxscore",
              "fetchedAt": "2026-09-06T02:53:43.518Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "82b6620b95c179b4edf0c6f7f1da7cea413ffe844524dfac314a58ea2f876c3d"
            }
          },
          {
            "playerId": 8481528,
            "sweaterNumber": 24,
            "name": {
              "default": "D. Cozens"
            },
            "position": "C",
            "goals": 0,
            "assists": 0,
            "points": 0,
            "plusMinus": 1,
            "pim": 0,
            "hits": 0,
            "powerPlayGoals": 0,
            "sog": 2,
            "faceoffWinningPctg": 0.5,
            "toi": "14:05",
            "blockedShots": 0,
            "shifts": 14,
            "giveaways": 1,
            "takeaways": 0,
            "teamId": 7,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020204/boxscore",
              "fetchedAt": "2026-09-06T02:53:43.518Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "82b6620b95c179b4edf0c6f7f1da7cea413ffe844524dfac314a58ea2f876c3d"
            }
          },
          {
            "playerId": 8476878,
            "sweaterNumber": 28,
            "name": {
              "default": "Z. Girgensons"
            },
            "position": "C",
            "goals": 0,
            "assists": 0,
            "points": 0,
            "plusMinus": 0,
            "pim": 0,
            "hits": 3,
            "powerPlayGoals": 0,
            "sog": 1,
            "faceoffWinningPctg": 0,
            "toi": "14:29",
            "blockedShots": 1,
            "shifts": 21,
            "giveaways": 0,
            "takeaways": 0,
            "teamId": 7,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020204/boxscore",
              "fetchedAt": "2026-09-06T02:53:43.518Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "82b6620b95c179b4edf0c6f7f1da7cea413ffe844524dfac314a58ea2f876c3d"
            }
          },
          {
            "playerId": 8479999,
            "sweaterNumber": 37,
            "name": {
              "default": "C. Mittelstadt"
            },
            "position": "C",
            "goals": 0,
            "assists": 0,
            "points": 0,
            "plusMinus": 1,
            "pim": 4,
            "hits": 0,
            "powerPlayGoals": 0,
            "sog": 1,
            "faceoffWinningPctg": 0.470588,
            "toi": "22:18",
            "blockedShots": 2,
            "shifts": 23,
            "giveaways": 1,
            "takeaways": 0,
            "teamId": 7,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020204/boxscore",
              "fetchedAt": "2026-09-06T02:53:43.518Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "82b6620b95c179b4edf0c6f7f1da7cea413ffe844524dfac314a58ea2f876c3d"
            }
          },
          {
            "playerId": 8475784,
            "sweaterNumber": 53,
            "name": {
              "default": "J. Skinner"
            },
            "position": "L",
            "goals": 1,
            "assists": 1,
            "points": 2,
            "plusMinus": 2,
            "pim": 0,
            "hits": 2,
            "powerPlayGoals": 0,
            "sog": 4,
            "faceoffWinningPctg": 0,
            "toi": "18:42",
            "blockedShots": 0,
            "shifts": 22,
            "giveaways": 0,
            "takeaways": 1,
            "teamId": 7,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020204/boxscore",
              "fetchedAt": "2026-09-06T02:53:43.518Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "82b6620b95c179b4edf0c6f7f1da7cea413ffe844524dfac314a58ea2f876c3d"
            }
          },
          {
            "playerId": 8479420,
            "sweaterNumber": 72,
            "name": {
              "default": "T. Thompson"
            },
            "position": "C",
            "goals": 0,
            "assists": 1,
            "points": 1,
            "plusMinus": 2,
            "pim": 0,
            "hits": 0,
            "powerPlayGoals": 0,
            "sog": 2,
            "faceoffWinningPctg": 0.1,
            "toi": "21:16",
            "blockedShots": 2,
            "shifts": 24,
            "giveaways": 0,
            "takeaways": 0,
            "teamId": 7,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020204/boxscore",
              "fetchedAt": "2026-09-06T02:53:43.518Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "82b6620b95c179b4edf0c6f7f1da7cea413ffe844524dfac314a58ea2f876c3d"
            }
          },
          {
            "playerId": 8482175,
            "sweaterNumber": 77,
            "name": {
              "default": "J. Peterka"
            },
            "position": "R",
            "goals": 1,
            "assists": 1,
            "points": 2,
            "plusMinus": 2,
            "pim": 2,
            "hits": 0,
            "powerPlayGoals": 0,
            "sog": 2,
            "faceoffWinningPctg": 0,
            "toi": "15:47",
            "blockedShots": 0,
            "shifts": 20,
            "giveaways": 0,
            "takeaways": 0,
            "teamId": 7,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020204/boxscore",
              "fetchedAt": "2026-09-06T02:53:43.518Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "82b6620b95c179b4edf0c6f7f1da7cea413ffe844524dfac314a58ea2f876c3d"
            }
          },
          {
            "playerId": 8483512,
            "sweaterNumber": 93,
            "name": {
              "default": "M. Savoie"
            },
            "position": "C",
            "goals": 0,
            "assists": 0,
            "points": 0,
            "plusMinus": 0,
            "pim": 0,
            "hits": 0,
            "powerPlayGoals": 0,
            "sog": 0,
            "faceoffWinningPctg": 0,
            "toi": "03:55",
            "blockedShots": 0,
            "shifts": 5,
            "giveaways": 0,
            "takeaways": 0,
            "teamId": 7,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020204/boxscore",
              "fetchedAt": "2026-09-06T02:53:43.518Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "82b6620b95c179b4edf0c6f7f1da7cea413ffe844524dfac314a58ea2f876c3d"
            }
          },
          {
            "playerId": 8473446,
            "sweaterNumber": 6,
            "name": {
              "default": "E. Johnson"
            },
            "position": "D",
            "goals": 0,
            "assists": 0,
            "points": 0,
            "plusMinus": 0,
            "pim": 0,
            "hits": 1,
            "powerPlayGoals": 0,
            "sog": 1,
            "faceoffWinningPctg": 0,
            "toi": "14:22",
            "blockedShots": 5,
            "shifts": 20,
            "giveaways": 0,
            "takeaways": 0,
            "teamId": 7,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020204/boxscore",
              "fetchedAt": "2026-09-06T02:53:43.518Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "82b6620b95c179b4edf0c6f7f1da7cea413ffe844524dfac314a58ea2f876c3d"
            }
          },
          {
            "playerId": 8480035,
            "sweaterNumber": 10,
            "name": {
              "default": "H. Jokiharju"
            },
            "position": "D",
            "goals": 1,
            "assists": 0,
            "points": 1,
            "plusMinus": 1,
            "pim": 0,
            "hits": 1,
            "powerPlayGoals": 0,
            "sog": 1,
            "faceoffWinningPctg": 0,
            "toi": "17:46",
            "blockedShots": 0,
            "shifts": 21,
            "giveaways": 1,
            "takeaways": 0,
            "teamId": 7,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020204/boxscore",
              "fetchedAt": "2026-09-06T02:53:43.518Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "82b6620b95c179b4edf0c6f7f1da7cea413ffe844524dfac314a58ea2f876c3d"
            }
          },
          {
            "playerId": 8482671,
            "sweaterNumber": 25,
            "name": {
              "default": "O. Power"
            },
            "position": "D",
            "goals": 0,
            "assists": 1,
            "points": 1,
            "plusMinus": 2,
            "pim": 0,
            "hits": 0,
            "powerPlayGoals": 0,
            "sog": 2,
            "faceoffWinningPctg": 0,
            "toi": "22:18",
            "blockedShots": 3,
            "shifts": 25,
            "giveaways": 0,
            "takeaways": 0,
            "teamId": 7,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020204/boxscore",
              "fetchedAt": "2026-09-06T02:53:43.518Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "82b6620b95c179b4edf0c6f7f1da7cea413ffe844524dfac314a58ea2f876c3d"
            }
          },
          {
            "playerId": 8480839,
            "sweaterNumber": 26,
            "name": {
              "default": "R. Dahlin"
            },
            "position": "D",
            "goals": 0,
            "assists": 0,
            "points": 0,
            "plusMinus": 2,
            "pim": 0,
            "hits": 5,
            "powerPlayGoals": 0,
            "sog": 2,
            "faceoffWinningPctg": 0,
            "toi": "25:43",
            "blockedShots": 2,
            "shifts": 27,
            "giveaways": 0,
            "takeaways": 1,
            "teamId": 7,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020204/boxscore",
              "fetchedAt": "2026-09-06T02:53:43.518Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "82b6620b95c179b4edf0c6f7f1da7cea413ffe844524dfac314a58ea2f876c3d"
            }
          },
          {
            "playerId": 8481564,
            "sweaterNumber": 33,
            "name": {
              "default": "R. Johnson"
            },
            "position": "D",
            "goals": 0,
            "assists": 0,
            "points": 0,
            "plusMinus": 0,
            "pim": 2,
            "hits": 1,
            "powerPlayGoals": 0,
            "sog": 4,
            "faceoffWinningPctg": 0,
            "toi": "18:00",
            "blockedShots": 0,
            "shifts": 19,
            "giveaways": 1,
            "takeaways": 0,
            "teamId": 7,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020204/boxscore",
              "fetchedAt": "2026-09-06T02:53:43.518Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "82b6620b95c179b4edf0c6f7f1da7cea413ffe844524dfac314a58ea2f876c3d"
            }
          },
          {
            "playerId": 8477365,
            "sweaterNumber": 75,
            "name": {
              "default": "C. Clifton"
            },
            "position": "D",
            "goals": 0,
            "assists": 0,
            "points": 0,
            "plusMinus": 1,
            "pim": 0,
            "hits": 3,
            "powerPlayGoals": 0,
            "sog": 0,
            "faceoffWinningPctg": 0,
            "toi": "15:47",
            "blockedShots": 2,
            "shifts": 19,
            "giveaways": 0,
            "takeaways": 0,
            "teamId": 7,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020204/boxscore",
              "fetchedAt": "2026-09-06T02:53:43.518Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "82b6620b95c179b4edf0c6f7f1da7cea413ffe844524dfac314a58ea2f876c3d"
            }
          }
        ],
        "goalies": [
          {
            "playerId": 8480045,
            "sweaterNumber": 1,
            "name": {
              "default": "U. Luukkonen"
            },
            "position": "G",
            "evenStrengthShotsAgainst": "0/0",
            "powerPlayShotsAgainst": "0/0",
            "shorthandedShotsAgainst": "0/0",
            "saveShotsAgainst": "0/0",
            "evenStrengthGoalsAgainst": 0,
            "powerPlayGoalsAgainst": 0,
            "shorthandedGoalsAgainst": 0,
            "pim": 0,
            "goalsAgainst": 0,
            "toi": "00:00",
            "starter": false,
            "shotsAgainst": 0,
            "saves": 0,
            "teamId": 7,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020204/boxscore",
              "fetchedAt": "2026-09-06T02:53:43.518Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "82b6620b95c179b4edf0c6f7f1da7cea413ffe844524dfac314a58ea2f876c3d"
            },
            "confirmationScope": "OBSERVED_GAME_PARTICIPATION",
            "pregameConfirmed": false
          },
          {
            "playerId": 8482221,
            "sweaterNumber": 27,
            "name": {
              "default": "D. Levi"
            },
            "position": "G",
            "evenStrengthShotsAgainst": "21/21",
            "powerPlayShotsAgainst": "10/12",
            "shorthandedShotsAgainst": "2/2",
            "saveShotsAgainst": "33/35",
            "savePctg": 0.942857,
            "evenStrengthGoalsAgainst": 0,
            "powerPlayGoalsAgainst": 2,
            "shorthandedGoalsAgainst": 0,
            "pim": 0,
            "goalsAgainst": 2,
            "toi": "60:00",
            "starter": true,
            "decision": "W",
            "shotsAgainst": 35,
            "saves": 33,
            "teamId": 7,
            "source": {
              "provider": "NHL",
              "url": "https://api-web.nhle.com/v1/gamecenter/2023020204/boxscore",
              "fetchedAt": "2026-09-06T02:53:43.518Z",
              "acquiredVia": "WEB_PUBLIC_SOURCE",
              "sourceUpdatedAt": null,
              "contentHash": "82b6620b95c179b4edf0c6f7f1da7cea413ffe844524dfac314a58ea2f876c3d"
            },
            "confirmationScope": "OBSERVED_GAME_PARTICIPATION",
            "pregameConfirmed": false
          }
        ]
      }
    },
    "teamStatistics": {
      "away": {
        "shotsOnGoal": 35
      },
      "home": {
        "shotsOnGoal": 25
      },
      "source": {
        "provider": "NHL",
        "url": "https://api-web.nhle.com/v1/gamecenter/2023020204/landing",
        "fetchedAt": "2026-09-06T02:39:27.812Z",
        "acquiredVia": "WEB_PUBLIC_SOURCE",
        "sourceUpdatedAt": null,
        "contentHash": "fa4085d038bcd1c1293f89513a2ff1dea0d388f5d003546e34f805be8ae388fe"
      }
    },
    "goalie": {
      "away": null,
      "home": null,
      "status": "PREGAME_EVIDENCE_REQUIRED"
    },
    "injury": {
      "status": "UNKNOWN",
      "availableAt": null,
      "players": null,
      "source": null
    },
    "lineup": {
      "status": "UNKNOWN",
      "availableAt": null,
      "players": null,
      "source": null
    },
    "advanced": {
      "fiveOnFive": null,
      "xGF": null,
      "xGA": null,
      "goalieGsax": null,
      "status": "SOURCE_NOT_CONNECTED"
    },
    "qa": {
      "status": "PASS",
      "issues": [],
      "warnings": [
        "NHL_PREGAME_INJURY_LINEUP_GOALIE_EVIDENCE_MISSING",
        "NHL_XG_5V5_FEATURES_UNAVAILABLE"
      ],
      "canUseHistoricalPeriods": true,
      "pregameModelReady": false
    }
  },
  {
    "leagueId": "NHL",
    "gameId": "2024020001",
    "officialGameId": "2024020001",
    "season": 20242025,
    "gameType": 2,
    "startTimeUTC": "2024-10-04T17:00:00Z",
    "taipeiDate": "2024-10-05",
    "officialDate": "2024-10-04",
    "awayTeamId": 1,
    "homeTeamId": 7,
    "away": {
      "leagueId": "NHL",
      "teamId": 1,
      "identityKey": "NHL:team:1",
      "abbrev": "NJD",
      "name": "New Jersey Devils"
    },
    "home": {
      "leagueId": "NHL",
      "teamId": 7,
      "identityKey": "NHL:team:7",
      "abbrev": "BUF",
      "name": "Buffalo Sabres"
    },
    "venue": "O2 Czech Republic",
    "venueTimezone": "Europe/Prague",
    "neutralSite": false,
    "gameState": "OFF",
    "gameScheduleState": "OK",
    "final": {
      "awayGoals": 4,
      "homeGoals": 1
    },
    "outcomeType": "REG",
    "source": {
      "provider": "NHL",
      "url": "https://api-web.nhle.com/v1/gamecenter/2024020001/landing",
      "fetchedAt": "2026-09-06T02:47:02.330Z",
      "acquiredVia": "WEB_PUBLIC_SOURCE",
      "sourceUpdatedAt": null,
      "contentHash": "c1477ab83d09b941cdfbf0f688b12ade156714d00443f2368ce93c5ea44c2d4b"
    },
    "seasonPhase": "REGULAR",
    "periods": [
      {
        "awayGoals": 2,
        "homeGoals": 0
      },
      {
        "awayGoals": 1,
        "homeGoals": 0
      },
      {
        "awayGoals": 1,
        "homeGoals": 1
      }
    ],
    "regulation": {
      "awayGoals": 4,
      "homeGoals": 1
    },
    "outcomeAvailableAt": null,
    "historical": true,
    "identity": {
      "ok": true,
      "status": "PASS",
      "issues": [],
      "identityKey": "NHL:2024020001:1:7:2024-10-04T17:00:00Z"
    },
    "league": "NHL",
    "northAmericaDate": "2024-10-04",
    "awayName": "New Jersey Devils",
    "homeName": "Buffalo Sabres",
    "awayAbbrev": "NJD",
    "homeAbbrev": "BUF",
    "status": "OFF",
    "teamStatistics": {
      "away": {
        "shotsOnGoal": 23
      },
      "home": {
        "shotsOnGoal": 31
      },
      "source": {
        "provider": "NHL",
        "url": "https://api-web.nhle.com/v1/gamecenter/2024020001/landing",
        "fetchedAt": "2026-09-06T02:47:02.330Z",
        "acquiredVia": "WEB_PUBLIC_SOURCE",
        "sourceUpdatedAt": null,
        "contentHash": "c1477ab83d09b941cdfbf0f688b12ade156714d00443f2368ce93c5ea44c2d4b"
      }
    },
    "goalie": {
      "away": null,
      "home": null,
      "status": "PREGAME_EVIDENCE_REQUIRED"
    },
    "injury": {
      "status": "UNKNOWN",
      "availableAt": null,
      "players": null,
      "source": null
    },
    "lineup": {
      "status": "UNKNOWN",
      "availableAt": null,
      "players": null,
      "source": null
    },
    "advanced": {
      "fiveOnFive": null,
      "xGF": null,
      "xGA": null,
      "goalieGsax": null,
      "status": "SOURCE_NOT_CONNECTED"
    },
    "qa": {
      "status": "PASS",
      "issues": [],
      "warnings": [
        "NHL_PREGAME_INJURY_LINEUP_GOALIE_EVIDENCE_MISSING",
        "NHL_XG_5V5_FEATURES_UNAVAILABLE"
      ],
      "canUseHistoricalPeriods": true,
      "pregameModelReady": false
    }
  },
  {
    "leagueId": "NHL",
    "gameId": "2024020002",
    "officialGameId": "2024020002",
    "season": 20242025,
    "gameType": 2,
    "startTimeUTC": "2024-10-05T14:00:00Z",
    "taipeiDate": "2024-10-05",
    "officialDate": "2024-10-05",
    "awayTeamId": 7,
    "homeTeamId": 1,
    "away": {
      "leagueId": "NHL",
      "teamId": 7,
      "identityKey": "NHL:team:7",
      "abbrev": "BUF",
      "name": "Buffalo Sabres"
    },
    "home": {
      "leagueId": "NHL",
      "teamId": 1,
      "identityKey": "NHL:team:1",
      "abbrev": "NJD",
      "name": "New Jersey Devils"
    },
    "venue": "O2 Czech Republic",
    "venueTimezone": "Europe/Prague",
    "neutralSite": false,
    "gameState": "OFF",
    "gameScheduleState": "OK",
    "final": {
      "awayGoals": 1,
      "homeGoals": 3
    },
    "outcomeType": "REG",
    "source": {
      "provider": "NHL",
      "url": "https://api-web.nhle.com/v1/gamecenter/2024020002/landing",
      "fetchedAt": "2026-09-06T02:47:03.086Z",
      "acquiredVia": "WEB_PUBLIC_SOURCE",
      "sourceUpdatedAt": null,
      "contentHash": "c1a83711476172952a9c8576d51313de65b3d515f2e14182446d68ae036d9b93"
    },
    "seasonPhase": "REGULAR",
    "periods": [
      {
        "awayGoals": 0,
        "homeGoals": 0
      },
      {
        "awayGoals": 1,
        "homeGoals": 1
      },
      {
        "awayGoals": 0,
        "homeGoals": 2
      }
    ],
    "regulation": {
      "awayGoals": 1,
      "homeGoals": 3
    },
    "outcomeAvailableAt": null,
    "historical": true,
    "identity": {
      "ok": true,
      "status": "PASS",
      "issues": [],
      "identityKey": "NHL:2024020002:7:1:2024-10-05T14:00:00Z"
    },
    "league": "NHL",
    "northAmericaDate": "2024-10-05",
    "awayName": "Buffalo Sabres",
    "homeName": "New Jersey Devils",
    "awayAbbrev": "BUF",
    "homeAbbrev": "NJD",
    "status": "OFF",
    "teamStatistics": {
      "away": {
        "shotsOnGoal": 18
      },
      "home": {
        "shotsOnGoal": 37
      },
      "source": {
        "provider": "NHL",
        "url": "https://api-web.nhle.com/v1/gamecenter/2024020002/landing",
        "fetchedAt": "2026-09-06T02:47:03.086Z",
        "acquiredVia": "WEB_PUBLIC_SOURCE",
        "sourceUpdatedAt": null,
        "contentHash": "c1a83711476172952a9c8576d51313de65b3d515f2e14182446d68ae036d9b93"
      }
    },
    "goalie": {
      "away": null,
      "home": null,
      "status": "PREGAME_EVIDENCE_REQUIRED"
    },
    "injury": {
      "status": "UNKNOWN",
      "availableAt": null,
      "players": null,
      "source": null
    },
    "lineup": {
      "status": "UNKNOWN",
      "availableAt": null,
      "players": null,
      "source": null
    },
    "advanced": {
      "fiveOnFive": null,
      "xGF": null,
      "xGA": null,
      "goalieGsax": null,
      "status": "SOURCE_NOT_CONNECTED"
    },
    "qa": {
      "status": "PASS",
      "issues": [],
      "warnings": [
        "NHL_PREGAME_INJURY_LINEUP_GOALIE_EVIDENCE_MISSING",
        "NHL_XG_5V5_FEATURES_UNAVAILABLE"
      ],
      "canUseHistoricalPeriods": true,
      "pregameModelReady": false
    }
  }
];
export default NHL_HISTORICAL_SAMPLES;
