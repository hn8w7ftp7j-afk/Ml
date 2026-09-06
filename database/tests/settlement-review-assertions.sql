CREATE TRIGGER direction_review_test BEFORE INSERT ON baseball_analysis_direction_settlements
FOR EACH ROW EXECUTE FUNCTION validate_baseball_analysis_direction_settlement_insert();

CREATE FUNCTION pg_temp.expect_rejected(statement TEXT, expected_message TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN
    IF position(expected_message IN SQLERRM) > 0 THEN RETURN; END IF;
    RAISE;
  END;
  RAISE EXCEPTION 'Expected rejection: %', expected_message;
END $$;

INSERT INTO baseball_analysis_direction_settlements VALUES
('review-a','direction-a',NULL,'official-hash-a','FULL_GAME','MANUAL_REVIEW');
SELECT pg_temp.expect_rejected($q$INSERT INTO baseball_analysis_direction_settlements VALUES
('review-duplicate','direction-a','review-a','official-hash-a','FULL_GAME','MANUAL_REVIEW')$q$,
'must change the official result hash');

-- The repaired validator may append a successful event with the same evidence.
INSERT INTO baseball_analysis_direction_settlements VALUES
('settled-a','direction-a','review-a','official-hash-a','FULL_GAME','SETTLED');
SELECT pg_temp.expect_rejected($q$INSERT INTO baseball_analysis_direction_settlements VALUES
('settled-duplicate','direction-a','settled-a','official-hash-a','FULL_GAME','SETTLED')$q$,
'must change the official result hash');
SELECT pg_temp.expect_rejected($q$INSERT INTO baseball_analysis_direction_settlements VALUES
('concurrent-duplicate','direction-a','review-a','official-hash-a','FULL_GAME','SETTLED')$q$,
'idx_test_child');
SELECT pg_temp.expect_rejected($q$INSERT INTO baseball_analysis_direction_settlements VALUES
('foreign-parent','direction-b','review-a','official-hash-b','FIRST5','SETTLED')$q$,
'foreign or missing event');
SELECT pg_temp.expect_rejected($q$INSERT INTO baseball_analysis_direction_settlements VALUES
('wrong-period','direction-a','settled-a','official-hash-b','FIRST5','SETTLED')$q$,
'immutable direction row');

-- Genuine official result corrections still append normally.
INSERT INTO baseball_analysis_direction_settlements VALUES
('corrected-a','direction-a','settled-a','official-hash-b','FULL_GAME','SETTLED');
DO $$ BEGIN
  IF (SELECT count(*) FROM baseball_analysis_direction_settlements) <> 3
    OR (SELECT status FROM baseball_analysis_direction_settlements WHERE settlement_id='review-a') <> 'MANUAL_REVIEW' THEN
    RAISE EXCEPTION 'Recovery changed history or counted an invalid event';
  END IF;
END $$;
ROLLBACK;
SELECT 'PostgreSQL settlement review recovery PASS' AS result;
