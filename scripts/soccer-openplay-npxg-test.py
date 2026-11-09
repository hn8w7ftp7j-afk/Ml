"""Synthetic boundary checks and replay of the retained empirical ledger.

Standard library only. Synthetic fixtures below are schema/math tests, never
counted as real matches or independent model validation.
"""
import collections
import copy
import datetime as dt
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("openplay_builder", Path(__file__).with_name("soccer-openplay-npxg-build.py"))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def fixture():
    match = dict(match_id=1, comp="ucl", season="2526", home_team_id=10,
                 away_team_id=20, home_team="Synthetic Home", away_team="Synthetic Away",
                 in_v1_scope=True, status_code=6, max_period=4, score_matches_events=True,
                 extra_time=True, penalty_shootout=True, xg_model="openplay_xg_v1",
                 date=dt.datetime(2026, 1, 1), n_shots=7)
    def shot(i, xg, period="FirstHalf", penalty=False, own=False, home=True):
        return dict(match_id=1, comp="ucl", season="2526", event_id=i, event_id_sub=i,
                    team_id=10 if home else 20, is_home=home, opponent_id=20 if home else 10,
                    period=period, is_shootout=period == "PenaltyShootout", is_own_goal=own,
                    is_penalty=penalty, is_disallowed=False, xg_model="openplay_xg_v1",
                    xg=xg, x=90.0, y=50.0)
    shots = [shot(1, .4), shot(2, .75, penalty=True), shot(3, .2, "SecondHalf"),
             shot(4, .3, "SecondHalf", home=False),
             shot(5, .9, "FirstPeriodOfExtraTime"), shot(6, .8, "PenaltyShootout", penalty=True),
             shot(7, None, own=True)]
    return match, shots


class Normalization(unittest.TestCase):
    def test_regulation_penalties_own_goals_and_added_periods(self):
        m, shots = fixture()
        row = builder.normalize_game(m, shots, set())
        # Hand-calculated totals, independently specified from the implementation.
        self.assertAlmostEqual(row["periods"]["FT"]["home"]["npxg"], .6)
        self.assertAlmostEqual(row["periods"]["FT"]["home"]["xg"], 1.35)
        self.assertAlmostEqual(row["periods"]["HT"]["home"]["npxg"], .4)
        self.assertAlmostEqual(row["periods"]["FT"]["away"]["npxg"], .3)
        self.assertEqual(row["periods"]["HT"]["away"]["shots"], 0)
        self.assertEqual([row[k] for k in ("excludedExtraTimeShots", "excludedShootoutShots", "excludedOwnGoals")], [1, 1, 1])
        # Real provider max_period=4 with a separate shootout table must work.
        self.assertEqual(row["matchDate"], "2026-01-01")

    def test_unknown_regulation_xg_never_becomes_zero(self):
        for value in (None, float("nan"), float("inf"), True, -.1, 1.1):
            with self.subTest(value=value):
                m, shots = fixture(); shots[0]["xg"] = value
                with self.assertRaisesRegex(ValueError, "XG_MISSING_OR_INVALID"):
                    builder.normalize_game(m, shots, set())

    def test_identity_duplicates_flags_completeness_and_issues(self):
        cases = [
            (lambda m, s: s.append(copy.deepcopy(s[0])), "SHOT_COUNT_MISMATCH"),
            (lambda m, s: s[1].update(event_id=1, event_id_sub=1), "DUPLICATE_OR_INVALID_SHOT_ID"),
            (lambda m, s: s[0].update(team_id=999), "SHOT_SCOPE_INVALID"),
            (lambda m, s: s[0].update(opponent_id=999), "SHOT_SCOPE_INVALID"),
            (lambda m, s: s[0].update(is_penalty=None), "SHOT_SCOPE_INVALID"),
            (lambda m, s: s[0].update(is_disallowed=True), "DISALLOWED_SHOT"),
            (lambda m, s: s[0].update(x=-1), "COORDINATES_INVALID"),
            (lambda m, s: s[0].update(is_shootout=True), "SHOOTOUT_SCOPE_CONFLICT"),
            (lambda m, s: m.update(penalty_shootout=False), "EXTRA_PERIOD_SCOPE_CONFLICT"),
            (lambda m, s: m.update(extra_time=False), "EXTRA_PERIOD_SCOPE_CONFLICT"),
            (lambda m, s: m.update(status_code=1), "COMPLETED_SOURCE_SCOPE_UNVERIFIED"),
        ]
        for mutate, reason in cases:
            with self.subTest(reason=reason):
                m, shots = fixture(); mutate(m, shots)
                with self.assertRaisesRegex(ValueError, reason):
                    builder.normalize_game(m, shots, set())
        m, shots = fixture()
        with self.assertRaisesRegex(ValueError, "PUBLISHED_DATA_ISSUE"):
            builder.normalize_game(m, shots, {1})


class RetainedEmpiricalResearch(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        folder = ROOT / "research/soccer/openplay-npxg"
        cls.report = json.loads((folder / "research-report.json").read_text())
        cls.compressed = (folder / "observations.json.gz").read_bytes()
        cls.ledger = json.loads(gzip.decompress(cls.compressed))

    def test_hashes_attribution_and_nonformal_scope(self):
        r = self.report
        self.assertEqual(hashlib.sha256(self.compressed).hexdigest(), r["retainedObservationsSha256"])
        self.assertEqual(hashlib.sha256((ROOT / "scripts/soccer-openplay-npxg-build.py").read_bytes()).hexdigest(), r["normalizerImplementationSha256"])
        body = {k: v for k, v in r.items() if k != "contentHash"}
        self.assertEqual(builder.digest(body), r["contentHash"])
        for value in (r, self.ledger):
            for key, expected in builder.FLAGS.items():
                self.assertIs(value[key], expected)
        self.assertEqual(r["license"], "CC-BY-4.0")
        self.assertEqual(r["sourceAttribution"], "openplay (Noah Bair)")
        self.assertFalse(r["currentSeasonCoverage"])
        self.assertFalse(r["sourceModelTrainingProvenanceVerified"])
        self.assertFalse(r["sourceIdentityMappingToEspnVerified"])
        self.assertEqual({f["name"]: f["sha256"] for f in r["sourceFiles"]}, builder.FILES)
        when = dt.datetime.fromisoformat(r["createdAt"].replace("Z", "+00:00"))
        self.assertLessEqual(when, dt.datetime.now(dt.timezone.utc))

    def test_whole_cohort_exclusions_and_actual_row_integrity(self):
        seen = set()
        for row in self.ledger["observations"]:
            key = row["league"], row["matchId"]
            self.assertNotIn(key, seen); seen.add(key)
            self.assertEqual(row["contentHash"], builder.digest({k: v for k, v in row.items() if k != "contentHash"}))
            self.assertLess(row["matchDate"], "2026-07-01")
            for side in ("home", "away"):
                ft, ht = (row["periods"][p][side] for p in ("FT", "HT"))
                self.assertGreaterEqual(ft["npxg"] + 1e-10, ht["npxg"])
                for t in (ft, ht):
                    self.assertAlmostEqual(t["xg"], t["npxg"] + t["penaltyXg"])
                    self.assertLessEqual(t["penaltyShots"], t["shots"])
        for comp, league in (("eng", "epl"), ("ucl", "ucl")):
            r = self.report["reports"][league]
            rows = [x for x in self.ledger["observations"] if x["league"] == league]
            excluded = [x for x in self.ledger["excluded"] if x["comp"] == comp]
            self.assertEqual(len(rows), r["usableGames"])
            self.assertEqual(len(excluded), r["excludedGames"])
            self.assertEqual(r["declaredPlayedGames"], len(rows) + len(excluded) + r["sourceMissingGames"])
            self.assertEqual(dict(collections.Counter(x["reason"] for x in excluded)), r["excludedReasons"])

    def test_replay_models_and_holdout_never_change_training(self):
        for league, report in self.report["reports"].items():
            rows = [x for x in self.ledger["observations"] if x["league"] == league]
            for period, result in report["periods"].items():
                model = builder.fit(rows, period, "2024-07-01")
                self.assertEqual(model, result["model"])
                training = [x for x in rows if x["matchDate"] < "2024-07-01"]
                self.assertEqual(builder.fit(training, period, "2024-07-01"), model)
                for label, start, end in (("calibration", "2024-07-01", "2025-07-01"), ("test", "2025-07-01", "2026-07-01")):
                    selected = [x for x in rows if start <= x["matchDate"] < end]
                    self.assertEqual(builder.evaluate(model, selected), result[label])
                # Perturb a future target by an enormous amount: fitted model is unchanged.
                edited = copy.deepcopy(rows)
                next(x for x in edited if x["matchDate"] >= "2024-07-01")["periods"][period]["home"]["npxg"] = 1000000
                self.assertEqual(builder.fit(edited, period, "2024-07-01"), model)
        mixed = self.ledger["observations"]
        with self.assertRaisesRegex(ValueError, "CROSS_LEAGUE_POOLING"):
            builder.fit(mixed, "FT", "2024-07-01")


if __name__ == "__main__":
    unittest.main()
