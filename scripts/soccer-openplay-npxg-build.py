"""Reproduce historical research from the pinned openplay public data release.

Requires pyarrow only when reading the original Parquet files. This is neither
a current-season adapter nor a formal scoring/artifact registration.
"""
import argparse
import collections
import csv
import datetime as dt
import gzip
import hashlib
import json
import math
from pathlib import Path

VERSION = "SOCCER-OPENPLAY-HISTORICAL-NPXG-v1"
RELEASE = "https://github.com/nlbair/openplay/releases/download/data-v0.1.0/"
FILES = {
    "matches.parquet": "99017d55a38c1c03eda15ffc500e23be7c6e5a380839809732f48e531f8526ac",
    "shots.parquet": "1b8f5750af5fcce93a1c4dc6b14026b5df6c038463fb792f2764e9b27478e4c5",
    "coverage.csv": "0007ce546378948574ea656a9d0fd814b03373666e2f7fe910439e54835ede0d",
    "known_gaps.csv": "d653a1e13257601615d28493cbbf5e7e47597d8e552a54009469501a741da305",
    "data_issues.csv": "d2e61f67a60547b1fd47d35f1bac9282a591fa63d4a189b6f8b81e388b2dced3",
}
FLAGS = dict(accepted=False, formalEligible=False, modelEffectApplied=False,
             executable=False, historicalAvailabilityVerified=False,
             independentUntouchedTestVerified=False, W=None, R=None, S=None)
PERIODS = {"FirstHalf", "SecondHalf", "FirstPeriodOfExtraTime",
           "SecondPeriodOfExtraTime", "PenaltyShootout"}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                      allow_nan=False).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def number(value):
    return type(value) in (int, float) and math.isfinite(value)


def normalize_game(match, shots, issue_ids):
    """Keep the provider's own identities; never match ESPN clubs by name."""
    mid = match.get("match_id")
    if type(mid) is not int or mid <= 0 or match.get("comp") not in ("eng", "ucl"):
        raise ValueError("OPENPLAY_MATCH_IDENTITY_INVALID")
    if mid in issue_ids:
        raise ValueError("OPENPLAY_PUBLISHED_DATA_ISSUE")
    home, away = match.get("home_team_id"), match.get("away_team_id")
    if any(type(i) is not int or i <= 0 for i in (home, away)) or home == away:
        raise ValueError("OPENPLAY_TEAM_IDENTITY_INVALID")
    if (match.get("in_v1_scope") is not True or match.get("status_code") != 6
            or match.get("max_period") not in (2, 4, 5)
            or any(type(match.get(k)) is not bool for k in ("extra_time", "penalty_shootout"))
            or match.get("score_matches_events") is not True
            or match.get("xg_model") != "openplay_xg_v1"):
        raise ValueError("OPENPLAY_COMPLETED_SOURCE_SCOPE_UNVERIFIED")
    date = match.get("date")
    if isinstance(date, (dt.datetime, dt.date)):
        date = date.date().isoformat() if isinstance(date, dt.datetime) else date.isoformat()
    try:
        if dt.date.fromisoformat(date).isoformat() != date:
            raise ValueError()
    except (ValueError, TypeError):
        raise ValueError("OPENPLAY_PROVIDER_DATE_INVALID")
    if type(match.get("n_shots")) is not int or match["n_shots"] != len(shots):
        raise ValueError("OPENPLAY_SHOT_COUNT_MISMATCH")
    result = dict(provider="OPENPLAY", league="epl" if match["comp"] == "eng" else "ucl",
                  matchId=str(mid), matchDate=date, season=match["season"],
                  teams={"home": {"providerId": str(home), "name": match["home_team"]},
                         "away": {"providerId": str(away), "name": match["away_team"]}},
                  excludedExtraTimeShots=0, excludedShootoutShots=0, excludedOwnGoals=0,
                  periods={p: {s: dict(xg=0.0, npxg=0.0, penaltyXg=0.0,
                                     shots=0, penaltyShots=0)
                               for s in ("home", "away")} for p in ("FT", "HT")})
    seen = set()
    for shot in shots:
        key = (shot.get("event_id"), shot.get("event_id_sub"))
        if any(type(v) is not int for v in key) or key in seen:
            raise ValueError("OPENPLAY_DUPLICATE_OR_INVALID_SHOT_ID")
        seen.add(key)
        side = "home" if shot.get("team_id") == home else "away" if shot.get("team_id") == away else None
        if (shot.get("match_id") != mid or shot.get("comp") != match["comp"]
                or shot.get("season") != match["season"] or side is None
                or shot.get("is_home") is not (side == "home")
                or shot.get("opponent_id") != (away if side == "home" else home)
                or shot.get("period") not in PERIODS
                or any(type(shot.get(k)) is not bool for k in ("is_shootout", "is_own_goal", "is_penalty", "is_disallowed"))
                or shot.get("xg_model") != match["xg_model"]):
            raise ValueError("OPENPLAY_SHOT_SCOPE_INVALID")
        if shot["is_disallowed"]:
            raise ValueError("OPENPLAY_DISALLOWED_SHOT_IN_SOURCE")
        period = shot["period"]
        if shot["is_shootout"] != (period == "PenaltyShootout"):
            raise ValueError("OPENPLAY_SHOOTOUT_SCOPE_CONFLICT")
        # max_period describes the ordinary event stream and can remain 4 for
        # matches whose separate shot table includes a shootout. Use its explicit
        # match flag rather than inventing a period-5 requirement.
        if ((period == "PenaltyShootout" and not match["penalty_shootout"])
                or (period.startswith(("FirstPeriod", "SecondPeriod")) and not match["extra_time"])):
            raise ValueError("OPENPLAY_EXTRA_PERIOD_SCOPE_CONFLICT")
        if period == "PenaltyShootout":
            result["excludedShootoutShots"] += 1
            continue
        if period not in ("FirstHalf", "SecondHalf"):
            result["excludedExtraTimeShots"] += 1
            continue
        if shot["is_own_goal"]:
            result["excludedOwnGoals"] += 1
            continue
        if not number(shot.get("xg")) or not 0 <= shot["xg"] <= 1:
            # Own-half shots without a value remain unknown, never zero.
            raise ValueError("OPENPLAY_REGULATION_XG_MISSING_OR_INVALID")
        if not all(number(shot.get(k)) and 0 <= shot[k] <= 100 for k in ("x", "y")):
            raise ValueError("OPENPLAY_COORDINATES_INVALID")
        for which in (("FT", "HT") if period == "FirstHalf" else ("FT",)):
            totals = result["periods"][which][side]
            totals["xg"] += shot["xg"]
            totals["penaltyXg" if shot["is_penalty"] else "npxg"] += shot["xg"]
            totals["shots"] += 1
            totals["penaltyShots"] += int(shot["is_penalty"])
    result["contentHash"] = digest(result)
    return result


def fit(rows, period, before, prior=8):
    if period not in ("FT", "HT") or not number(prior) or prior <= 0:
        raise ValueError("OPENPLAY_FIT_SCOPE_INVALID")
    if len({r["league"] for r in rows}) != 1:
        raise ValueError("OPENPLAY_CROSS_LEAGUE_POOLING_PROHIBITED")
    selected = [r for r in rows if r["matchDate"] < before]
    if len(selected) < 30:
        raise ValueError("OPENPLAY_TRAINING_INSUFFICIENT")
    mean_home = sum(r["periods"][period]["home"]["npxg"] for r in selected) / len(selected)
    mean_away = sum(r["periods"][period]["away"]["npxg"] for r in selected) / len(selected)
    global_mean = (mean_home + mean_away) / 2
    if global_mean <= 0:
        raise ValueError("OPENPLAY_TRAINING_TARGET_EMPTY")
    teams = {}
    for row in selected:
        for side, opponent in (("home", "away"), ("away", "home")):
            key = row["teams"][side]["providerId"]
            team = teams.setdefault(key, dict(matches=0, npxgFor=0.0, npxgAgainst=0.0))
            team["matches"] += 1
            team["npxgFor"] += row["periods"][period][side]["npxg"]
            team["npxgAgainst"] += row["periods"][period][opponent]["npxg"]
    for team in teams.values():
        for output, field in (("attack", "npxgFor"), ("defence", "npxgAgainst")):
            team[output] = (team[field] + prior * global_mean) / (team["matches"] + prior) / global_mean
    return dict(period=period, beforeDate=before, priorGames=prior,
                trainingGames=len(selected), trainingHash=digest(selected),
                meanHome=mean_home, meanAway=mean_away, teams=teams)


def evaluate(model, rows):
    absolute, squared, baseline_absolute, baseline_squared = [], [], [], []
    cold = 0
    for row in rows:
        for side, other, mean in (("home", "away", model["meanHome"]), ("away", "home", model["meanAway"])):
            a = model["teams"].get(row["teams"][side]["providerId"])
            b = model["teams"].get(row["teams"][other]["providerId"])
            cold += int(a is None or b is None)
            prediction = mean * (a["attack"] if a else 1) * (b["defence"] if b else 1)
            target = row["periods"][model["period"]][side]["npxg"]
            delta, base = prediction - target, mean - target
            absolute.append(abs(delta)); squared.append(delta * delta)
            baseline_absolute.append(abs(base)); baseline_squared.append(base * base)
    avg = lambda values: sum(values) / len(values) if values else None
    return dict(games=len(rows), teamTargets=len(absolute), coldStartTeamTargets=cold,
                candidate=dict(mae=avg(absolute), mse=avg(squared)),
                leagueMeanBaseline=dict(mae=avg(baseline_absolute), mse=avg(baseline_squared)))


def build(data_dir, output, collected_at):
    # Parquet decoding is offline; exact release digests precede every read.
    import pyarrow.parquet as pq
    for name, expected in FILES.items():
        if hashlib.sha256((data_dir / name).read_bytes()).hexdigest() != expected:
            raise ValueError("OPENPLAY_SOURCE_HASH_MISMATCH: " + name)
    read_csv = lambda name: list(csv.DictReader((data_dir / name).open(encoding="utf-8")))
    issues, coverage = read_csv("data_issues.csv"), read_csv("coverage.csv")
    gaps = read_csv("known_gaps.csv")
    issue_ids = {int(r["match_id"]) for r in issues}
    matches = pq.read_table(data_dir / "matches.parquet", filters=[("comp", "in", ["eng", "ucl"])]).to_pylist()
    shots = pq.read_table(data_dir / "shots.parquet", filters=[("comp", "in", ["eng", "ucl"])]).to_pylist()
    by_match = collections.defaultdict(list)
    for shot in shots:
        by_match[shot["match_id"]].append(shot)
    normalized, excluded = [], []
    seen = set()
    for match in matches:
        key = (match["comp"], match["match_id"])
        if key in seen:
            raise ValueError("OPENPLAY_DUPLICATE_MATCH")
        seen.add(key)
        try:
            normalized.append(normalize_game(match, by_match[match["match_id"]], issue_ids))
        except ValueError as error:
            excluded.append(dict(matchId=str(match["match_id"]), comp=match["comp"],
                                 reason=str(error), matchDate=str(match["date"])[:10]))
    normalized.sort(key=lambda r: (r["league"], r["matchDate"], r["matchId"]))
    report = dict(version=VERSION, status="RETROSPECTIVE_SOURCE_AND_NPXG_RESEARCH",
                  createdAt=dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
                  sourceCollectedAt=collected_at, provider="OPENPLAY", xgModel="openplay_xg_v1",
                  sourceAttribution="openplay (Noah Bair)", license="CC-BY-4.0",
                  sourceRelease=RELEASE, sourcePublishedAt="2026-11-03T06:57:53Z",
                  sourceFiles=[dict(name=n, url=RELEASE+n, sha256=h) for n, h in FILES.items()],
                  sourceModelTrainingProvenanceVerified=False,
                  sourceDeclaredCompletenessOnly=True, currentSeasonCoverage=False,
                  sourceIdentityMappingToEspnVerified=False, reports={}, **FLAGS)
    for comp, league in (("eng", "epl"), ("ucl", "ucl")):
        rows = [r for r in normalized if r["league"] == league]
        source_coverage = [r for r in coverage if r["comp"] == comp and r["in_v1_scope"] == "True"]
        declared = sum(int(r["matches_played"]) for r in source_coverage)
        supplied = sum(int(r["matches_with_events"]) for r in source_coverage)
        missing_ids = sorted({r["match_id"] for r in gaps if r["comp"] == comp and r["in_v1_scope"] == "True"})
        if len(missing_ids) != declared - supplied:
            raise ValueError("OPENPLAY_PUBLISHED_MISSING_COHORT_COUNT_MISMATCH")
        if supplied != sum(m["comp"] == comp and m["in_v1_scope"] is True for m in matches):
            raise ValueError("OPENPLAY_PUBLISHED_COHORT_COUNT_MISMATCH")
        omissions = [r for r in excluded if r["comp"] == comp]
        league_report = dict(declaredPlayedGames=declared, acquiredMatchRows=supplied,
                             sourceMissingGames=declared-supplied, usableGames=len(rows),
                             sourceMissingMatchIds=missing_ids,
                             excludedGames=len(omissions),
                             excludedReasons=dict(collections.Counter(r["reason"] for r in omissions)),
                             firstMatchDate=rows[0]["matchDate"], lastMatchDate=rows[-1]["matchDate"],
                             seasons=sorted({r["season"] for r in rows}), periods={})
        for period in ("FT", "HT"):
            model = fit(rows, period, "2024-07-01")
            league_report["periods"][period] = dict(
                protocol=dict(trainingBefore="2024-07-01", calibrationBefore="2025-07-01",
                              testBefore="2026-07-01", priorGames=8,
                              parameterSelection="FIXED_PRIOR_NO_HOLDOUT_TUNING",
                              target="OBSERVED_PROVIDER_NONPENALTY_XG_NOT_FUTURE_GOALS",
                              splitUnit="WHOLE_PROVIDER_LOCAL_MATCH_DATE"),
                model=model,
                calibration=evaluate(model, [r for r in rows if "2024-07-01" <= r["matchDate"] < "2025-07-01"]),
                test=evaluate(model, [r for r in rows if "2025-07-01" <= r["matchDate"] < "2026-07-01"]))
        report["reports"][league] = league_report
    ledger = dict(version=VERSION, observations=normalized, excluded=excluded, **FLAGS)
    output.mkdir(parents=True, exist_ok=True)
    retained = gzip.compress(canonical(ledger), mtime=0)
    (output / "observations.json.gz").write_bytes(retained)
    report["retainedObservationsSha256"] = hashlib.sha256(retained).hexdigest()
    report["normalizerImplementationSha256"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    report["contentHash"] = digest(report)
    (output / "research-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False)+"\n")
    print(json.dumps({k: {f: v[f] for f in ("declaredPlayedGames", "usableGames", "excludedGames", "sourceMissingGames")}
                      for k, v in report["reports"].items()}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--collected-at", required=True)
    args = parser.parse_args()
    instant = dt.datetime.fromisoformat(args.collected_at.replace("Z", "+00:00"))
    if instant.tzinfo is None or instant > dt.datetime.now(dt.timezone.utc):
        raise ValueError("OPENPLAY_COLLECTION_TIME_INVALID")
    build(args.data_dir, args.output, args.collected_at)
