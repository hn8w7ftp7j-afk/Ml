-- Additive NBA-only Reader storage. Existing sports models and ledgers are
-- untouched. Runtime initialization creates this same table if needed.
CREATE TABLE IF NOT EXISTS sports_nba_reader_boards_v1 (
  board_date TEXT PRIMARY KEY,
  observed_at TIMESTAMPTZ NOT NULL,
  page_activity_at TIMESTAMPTZ NOT NULL,
  source_hash TEXT NOT NULL,
  checksum TEXT NOT NULL,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (payload->>'league' = 'NBA'),
  CHECK (payload->>'boardDate' = board_date),
  CHECK (payload->>'executable' = 'false')
);
