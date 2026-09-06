-- Isolated PostgreSQL integration fixtures, never Production records.
BEGIN;
CREATE TABLE baseball_analysis_direction_results (
  direction_result_id CHAR(64) PRIMARY KEY,
  period TEXT NOT NULL
);
CREATE TABLE baseball_analysis_direction_settlements (
  settlement_id CHAR(64) PRIMARY KEY,
  direction_result_id CHAR(64) NOT NULL REFERENCES baseball_analysis_direction_results,
  supersedes_settlement_id CHAR(64) REFERENCES baseball_analysis_direction_settlements,
  official_result_hash CHAR(64) NOT NULL,
  selected_period TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('MANUAL_REVIEW', 'SETTLED'))
);
CREATE UNIQUE INDEX idx_test_root ON baseball_analysis_direction_settlements(direction_result_id)
WHERE supersedes_settlement_id IS NULL;
CREATE UNIQUE INDEX idx_test_child ON baseball_analysis_direction_settlements(supersedes_settlement_id)
WHERE supersedes_settlement_id IS NOT NULL;
INSERT INTO baseball_analysis_direction_results VALUES ('direction-a','FULL_GAME'),('direction-b','FIRST5');
