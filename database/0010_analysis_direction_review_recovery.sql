-- Permit verified recovery while keeping immutable event chains and all
-- same-result duplicate protections for already settled events.
CREATE OR REPLACE FUNCTION validate_baseball_analysis_direction_settlement_insert() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  parent_direction_id CHAR(64);
  parent_official_hash CHAR(64);
  parent_status TEXT;
  result_period TEXT;
BEGIN
  SELECT period INTO result_period
  FROM baseball_analysis_direction_results
  WHERE direction_result_id = NEW.direction_result_id;
  IF NOT FOUND OR result_period IS DISTINCT FROM NEW.selected_period THEN
    RAISE EXCEPTION 'Analysis direction settlement does not match its immutable direction row';
  END IF;
  IF NEW.supersedes_settlement_id IS NOT NULL THEN
    SELECT direction_result_id, official_result_hash, status
      INTO parent_direction_id, parent_official_hash, parent_status
    FROM baseball_analysis_direction_settlements
    WHERE settlement_id = NEW.supersedes_settlement_id;
    IF NOT FOUND OR parent_direction_id IS DISTINCT FROM NEW.direction_result_id THEN
      RAISE EXCEPTION 'Analysis direction settlement supersedes a foreign or missing event';
    END IF;
    IF parent_official_hash IS NOT DISTINCT FROM NEW.official_result_hash
      AND NOT (parent_status = 'MANUAL_REVIEW' AND NEW.status = 'SETTLED') THEN
      RAISE EXCEPTION 'Analysis direction correction must change the official result hash';
    END IF;
  END IF;
  RETURN NEW;
END $$;
