-- Additive NHL-only observation history. No existing league table is modified.
CREATE TABLE IF NOT EXISTS sports_nhl_snapshots_v1 (
  kind TEXT NOT NULL,
  record_key TEXT NOT NULL,
  revision TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (kind, record_key, revision),
  CHECK (payload->>'league' = 'NHL')
);
