// Additive 2.2 storage. Historical rows are immutable; only current projections update.
export const SOCCER_JOURNAL_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sports_soccer_analysis_v1 (
    league TEXT NOT NULL CHECK (league IN ('epl','ucl')), game_id TEXT NOT NULL,
    analysis_hash TEXT NOT NULL, observed_at TIMESTAMPTZ NOT NULL, payload JSONB NOT NULL,
    PRIMARY KEY (league,game_id,analysis_hash))`,
  `CREATE TABLE IF NOT EXISTS sports_soccer_source_heads_v2 (
    league TEXT NOT NULL CHECK (league IN ('epl','ucl')), board_date DATE NOT NULL,
    quote_generation BIGINT NOT NULL DEFAULT 0, content_hash TEXT, source_observed_at TIMESTAMPTZ, observation_id TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY (league,board_date))`,
  `CREATE TABLE IF NOT EXISTS sports_soccer_reader_observations_v2 (
    observation_id TEXT PRIMARY KEY, league TEXT NOT NULL CHECK (league IN ('EPL','UCL')),
    board_date DATE NOT NULL, content_hash TEXT NOT NULL, source_observed_at TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL, persisted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    payload JSONB NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sports_soccer_reader_observations_scope_v2
    ON sports_soccer_reader_observations_v2 (league,board_date,source_observed_at DESC,received_at DESC)`,
  `CREATE INDEX IF NOT EXISTS sports_soccer_reader_observations_content_v2
    ON sports_soccer_reader_observations_v2 (league,board_date,content_hash,received_at)`,
  `CREATE TABLE IF NOT EXISTS sports_soccer_reader_period_observations_v2 (
    observation_id TEXT NOT NULL REFERENCES sports_soccer_reader_observations_v2(observation_id),
    period TEXT NOT NULL CHECK (period IN ('FT','HT','UNKNOWN')), content_hash TEXT NOT NULL,
    PRIMARY KEY (observation_id,period))`,
  `CREATE INDEX IF NOT EXISTS sports_soccer_reader_period_observations_content_v2
    ON sports_soccer_reader_period_observations_v2 (period,content_hash,observation_id)`,
  `CREATE TABLE IF NOT EXISTS sports_soccer_reader_period_heads_v2 (
    league TEXT NOT NULL CHECK (league IN ('epl','ucl')), board_date DATE NOT NULL,
    period TEXT NOT NULL CHECK (period IN ('FT','HT','UNKNOWN')), observation_id TEXT NOT NULL,
    content_hash TEXT NOT NULL, source_observed_at TIMESTAMPTZ NOT NULL, received_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (league,board_date,period),
    FOREIGN KEY (observation_id,period) REFERENCES sports_soccer_reader_period_observations_v2(observation_id,period))`,
  `CREATE TABLE IF NOT EXISTS sports_soccer_cohort_v2 (
    snapshot_id TEXT PRIMARY KEY, league TEXT NOT NULL CHECK (league IN ('epl','ucl')),
    game_id TEXT NOT NULL, board_date DATE NOT NULL, received_at TIMESTAMPTZ NOT NULL,
    payload JSONB NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sports_soccer_analysis_runs_v2 (
    run_id TEXT PRIMARY KEY, request_seq BIGSERIAL UNIQUE NOT NULL,
    league TEXT NOT NULL CHECK (league IN ('epl','ucl')), game_id TEXT NOT NULL, board_date DATE NOT NULL,
    started_at TIMESTAMPTZ NOT NULL, quote_generation BIGINT NOT NULL, requirements_version TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sports_soccer_analysis_events_v2 (
    run_id TEXT PRIMARY KEY REFERENCES sports_soccer_analysis_runs_v2(run_id),
    finished_at TIMESTAMPTZ NOT NULL, analysis_status TEXT NOT NULL
      CHECK (analysis_status IN ('COMPLETED','FAILED','INSUFFICIENT_DATA')),
    qa_flag TEXT NOT NULL CHECK (qa_flag IN ('PASS','WARN','BLOCKED')),
    selection_result TEXT CHECK (selection_result IS NULL OR selection_result='RESEARCH_SHADOW'),
    analysis_revision TEXT, reasons JSONB NOT NULL,
    CHECK (selection_result IS NULL OR (analysis_status='COMPLETED' AND qa_flag<>'BLOCKED')),
    CHECK (qa_flag<>'BLOCKED' OR (analysis_status<>'COMPLETED' AND selection_result IS NULL)))`,
  `CREATE TABLE IF NOT EXISTS sports_soccer_analysis_heads_v2 (
    league TEXT NOT NULL CHECK (league IN ('epl','ucl')), game_id TEXT NOT NULL, board_date DATE NOT NULL,
    requested_run_id TEXT NOT NULL REFERENCES sports_soccer_analysis_runs_v2(run_id),
    requested_seq BIGINT NOT NULL, quote_generation BIGINT NOT NULL, published_revision TEXT,
    valid_until TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (league,game_id,board_date))`,
  `CREATE OR REPLACE FUNCTION sports_soccer_immutable_v2() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'SOCCER_IMMUTABLE_HISTORY'; END; $$`,
  ...['reader_observations','reader_period_observations','cohort','analysis_runs','analysis_events'].map(name=>
    `CREATE OR REPLACE TRIGGER sports_soccer_immutable_v2 BEFORE UPDATE OR DELETE ON sports_soccer_${name}_v2
     FOR EACH ROW EXECUTE FUNCTION sports_soccer_immutable_v2()`),
  `CREATE OR REPLACE TRIGGER sports_soccer_immutable_v2 BEFORE UPDATE OR DELETE ON sports_soccer_analysis_v1
    FOR EACH ROW EXECUTE FUNCTION sports_soccer_immutable_v2()`,
];
