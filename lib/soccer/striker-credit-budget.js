import { ensureSoccerJournal, soccerJournalQuery, soccerJournalTransaction } from './journal.js';

// Local research accounting, not the provider's balance or billing record.
// Identifiers are non-secret UUIDs allocated by the operator for one account.
export const STRIKER_CREDIT_BUDGET_VERSION = 'STRIKER-CREDIT-BUDGET-v1';
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const instant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const allowedKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => keys.includes(key));
const result = (status, extra = {}) => ({ version: STRIKER_CREDIT_BUDGET_VERSION, status, allowed: false,
  providerBalanceVerified: false, formalEligible: false, executable: false, ...extra });

let ready;
export async function ensureStrikerCreditBudgetStore() {
  return ready ||= (async () => {
    await ensureSoccerJournal();
    await soccerJournalTransaction([
      ['SELECT pg_advisory_xact_lock(221019,2310)'],
      [`CREATE TABLE IF NOT EXISTS sports_soccer_striker_credit_windows_v1 (
        budget_id UUID NOT NULL, window_start TIMESTAMPTZ NOT NULL, window_end TIMESTAMPTZ NOT NULL,
        max_credits INTEGER NOT NULL CHECK(max_credits BETWEEN 10 AND 10000000),
        reserved_credits INTEGER NOT NULL DEFAULT 0 CHECK(reserved_credits >= 0 AND reserved_credits <= max_credits),
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY (budget_id,window_start),
        CHECK(window_start < window_end))`],
      [`CREATE TABLE IF NOT EXISTS sports_soccer_striker_credit_reservations_v1 (
        request_id UUID PRIMARY KEY, budget_id UUID NOT NULL, window_start TIMESTAMPTZ NOT NULL,
        credits INTEGER NOT NULL CHECK(credits >= 10), reserved_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        FOREIGN KEY(budget_id,window_start) REFERENCES sports_soccer_striker_credit_windows_v1(budget_id,window_start))`],
      [`CREATE OR REPLACE FUNCTION sports_soccer_striker_credit_window_guard_v1() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF TG_OP = 'DELETE' OR NEW.budget_id <> OLD.budget_id OR NEW.window_start <> OLD.window_start
            OR NEW.window_end <> OLD.window_end OR NEW.max_credits <> OLD.max_credits
            OR NEW.created_at <> OLD.created_at OR NEW.reserved_credits < OLD.reserved_credits THEN
            RAISE EXCEPTION 'STRIKER_BUDGET_IMMUTABLE';
          END IF;
          RETURN NEW;
        END $$`],
      [`CREATE OR REPLACE TRIGGER sports_soccer_striker_credit_window_guard_v1 BEFORE UPDATE OR DELETE
        ON sports_soccer_striker_credit_windows_v1 FOR EACH ROW EXECUTE FUNCTION sports_soccer_striker_credit_window_guard_v1()`],
      [`CREATE OR REPLACE TRIGGER sports_soccer_striker_credit_reservation_immutable_v1 BEFORE UPDATE OR DELETE
        ON sports_soccer_striker_credit_reservations_v1 FOR EACH ROW EXECUTE FUNCTION sports_soccer_immutable_v2()`],
      [`CREATE OR REPLACE FUNCTION sports_soccer_striker_create_credit_window_v1(
        p_budget_id UUID,p_start TIMESTAMPTZ,p_end TIMESTAMPTZ,p_max INTEGER)
        RETURNS TEXT LANGUAGE plpgsql AS $$
        DECLARE existing sports_soccer_striker_credit_windows_v1%ROWTYPE;
        BEGIN
          PERFORM pg_advisory_xact_lock(hashtextextended(p_budget_id::text,2310));
          SELECT * INTO existing FROM sports_soccer_striker_credit_windows_v1
            WHERE budget_id=p_budget_id AND window_start=p_start;
          IF FOUND THEN
            IF existing.window_end=p_end AND existing.max_credits=p_max THEN RETURN 'EXISTING'; END IF;
            RETURN 'CONFIG_CONFLICT';
          END IF;
          IF p_start <= clock_timestamp() OR p_start >= p_end THEN RETURN 'WINDOW_NOT_FUTURE'; END IF;
          IF EXISTS(SELECT 1 FROM sports_soccer_striker_credit_windows_v1
             WHERE budget_id=p_budget_id AND window_start<p_end AND window_end>p_start) THEN RETURN 'WINDOW_OVERLAP'; END IF;
          INSERT INTO sports_soccer_striker_credit_windows_v1(budget_id,window_start,window_end,max_credits)
            VALUES(p_budget_id,p_start,p_end,p_max);
          RETURN 'CREATED';
        END $$`],
      [`CREATE OR REPLACE FUNCTION sports_soccer_striker_reserve_credits_v1(
        p_budget_id UUID,p_start TIMESTAMPTZ,p_request_id UUID,p_credits INTEGER)
        RETURNS TEXT LANGUAGE plpgsql AS $$
        DECLARE budget sports_soccer_striker_credit_windows_v1%ROWTYPE; inserted UUID; checked TIMESTAMPTZ;
        BEGIN
          SELECT * INTO budget FROM sports_soccer_striker_credit_windows_v1
            WHERE budget_id=p_budget_id AND window_start=p_start FOR UPDATE;
          IF NOT FOUND THEN RETURN 'BUDGET_NOT_FOUND'; END IF;
          IF EXISTS(SELECT 1 FROM sports_soccer_striker_credit_reservations_v1 WHERE request_id=p_request_id)
            THEN RETURN 'REQUEST_REPLAY'; END IF;
          checked := clock_timestamp();
          IF checked<budget.window_start OR checked>=budget.window_end THEN RETURN 'WINDOW_INACTIVE'; END IF;
          IF p_credits<10 OR p_credits>budget.max_credits-budget.reserved_credits THEN RETURN 'BUDGET_EXHAUSTED'; END IF;
          INSERT INTO sports_soccer_striker_credit_reservations_v1(request_id,budget_id,window_start,credits,reserved_at)
            VALUES(p_request_id,p_budget_id,p_start,p_credits,checked) ON CONFLICT(request_id) DO NOTHING RETURNING request_id INTO inserted;
          IF inserted IS NULL THEN RETURN 'REQUEST_REPLAY'; END IF;
          UPDATE sports_soccer_striker_credit_windows_v1 SET reserved_credits=reserved_credits+p_credits
            WHERE budget_id=p_budget_id AND window_start=p_start;
          RETURN 'RESERVED';
        END $$`],
    ]);
  })().catch(error => { ready = null; throw error; });
}

/** Explicit operator configuration; no inferred cycle, automatic rollover or reset. */
export async function createStrikerCreditBudget(options = {}) {
  if (!allowedKeys(options, ['enabled', 'budgetId', 'windowStart', 'windowEnd', 'maxCredits'])) return result('CONFIG_INVALID');
  if (options.enabled !== true) return result('DISABLED');
  const { budgetId, windowStart, windowEnd, maxCredits } = options;
  if (!uuid(budgetId) || !instant(windowStart) || !instant(windowEnd) || windowStart >= windowEnd
    || !Number.isSafeInteger(maxCredits) || maxCredits < 10 || maxCredits > 10000000) return result('CONFIG_INVALID');
  try {
    await ensureStrikerCreditBudgetStore();
    const rows = await soccerJournalQuery('SELECT sports_soccer_striker_create_credit_window_v1($1::uuid,$2::timestamptz,$3::timestamptz,$4::integer) AS status',
      [budgetId,windowStart,windowEnd,maxCredits]);
    return result(rows[0]?.status || 'DATABASE_UNAVAILABLE');
  } catch { return result('DATABASE_UNAVAILABLE'); }
}

/** Exactly one caller may use a newly reserved request ID. Replays never send.
 * A lost response or network timeout does not undo a committed reservation. */
export async function reserveStrikerCredits(options = {}) {
  if (!allowedKeys(options, ['enabled', 'budgetId', 'windowStart', 'requestId', 'credits'])) return result('RESERVATION_INVALID');
  if (options.enabled !== true) return result('DISABLED');
  const { budgetId, windowStart, requestId, credits } = options;
  if (!uuid(budgetId) || !instant(windowStart) || !uuid(requestId) || !Number.isSafeInteger(credits)
    || credits < 10 || credits > 10000000) return result('RESERVATION_INVALID');
  try {
    await ensureStrikerCreditBudgetStore();
    const rows = await soccerJournalQuery('SELECT sports_soccer_striker_reserve_credits_v1($1::uuid,$2::timestamptz,$3::uuid,$4::integer) AS status',
      [budgetId,windowStart,requestId,credits]);
    const status = rows[0]?.status || 'DATABASE_UNAVAILABLE';
    return result(status, { allowed: status === 'RESERVED' });
  } catch { return result('DATABASE_UNAVAILABLE'); }
}
