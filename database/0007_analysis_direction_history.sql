-- Normalized, immutable eight-direction analysis history.
-- Every PIT snapshot owns exactly one row for each contractual slot.  Final
-- settlements are append-only events so an official-score correction remains
-- auditable instead of rewriting the original analysis or its first result.
create table if not exists baseball_analysis_direction_results (
  direction_result_id char(64) primary key,
  record_hash char(64) not null,
  history_schema_version text not null,
  snapshot_id text not null references baseball_analysis_pit_snapshots(snapshot_id) on delete restrict,
  parent_snapshot_id text references baseball_analysis_pit_snapshots(snapshot_id) on delete restrict,
  analysis_type text not null check (analysis_type in ('FULL', 'PRICE_ONLY_REPRICE')),
  league_id text not null check (league_id in ('MLB', 'NPB', 'KBO', 'CPBL')),
  external_game_id bigint not null,
  game_number integer not null,
  away_team_id bigint not null,
  home_team_id bigint not null,
  game_start timestamptz not null,
  official_date text not null,
  away_team text not null,
  home_team text not null,
  slot_id text not null,
  slot_index smallint not null check (slot_index between 1 and 8),
  market text not null check (market in ('全場讓分', '全場大小', '上半讓分', '上半大小')),
  period text not null check (period in ('FULL_GAME', 'FIRST5')),
  market_family text not null check (market_family in ('RUNLINE', 'TOTAL')),
  direction text not null check (direction in ('home', 'away', 'over', 'under')),
  status text not null check (status in ('CALCULATED', 'UNOPENED', 'BLOCKED')),
  coverage_status text not null,
  coverage_errors jsonb not null default '[]'::jsonb,
  pick text,
  line_text text,
  line_modifier text,
  line_legs jsonb not null default '[]'::jsonb,
  line_type text,
  water numeric,
  stake_basis numeric not null default 10000 check (stake_basis = 10000),
  rebate_rate numeric not null default 0.015 check (rebate_rate = 0.015),
  model_ev numeric,
  robust_ev numeric,
  qa_status text not null,
  qa_reasons jsonb not null default '[]'::jsonb,
  score numeric,
  ranking_eligible boolean not null default false,
  bet_eligible boolean not null default false,
  reader_version text,
  reader_payload_hash char(64),
  reader_raw_board_hash char(64),
  reader_game_market_hash char(64),
  reader_board_date text,
  reader_line_as_of timestamptz,
  reader_source_type text,
  market_provider text,
  market_signature_version text,
  market_signature text,
  authorization_status text,
  integrity_origin text,
  model_version text not null,
  rules_version text not null,
  data_version text not null,
  score_formula_version text not null,
  settlement_rule_version text not null,
  uncertainty_set_version text not null,
  model_ev_formula_version text not null,
  robust_ev_version text not null,
  direction_slot_contract_version text not null,
  robust_status text not null check (robust_status in ('CALCULATED', 'BLOCKED')),
  robust_scenario_source jsonb not null default '[]'::jsonb,
  robust_scenario_hash char(64),
  reprice_version text,
  distribution_id text not null,
  distribution_hash char(64) not null,
  input_hash char(64) not null,
  price_fingerprint char(64) not null,
  analysis_as_of timestamptz not null,
  data_as_of timestamptz not null,
  line_as_of timestamptz not null,
  lead_minutes numeric not null,
  result_payload jsonb not null,
  record_payload jsonb not null,
  created_at timestamptz not null default now(),
  unique (snapshot_id, slot_id),
  unique (snapshot_id, slot_index),
  check (data_as_of <= analysis_as_of),
  check (line_as_of <= analysis_as_of),
  check (analysis_as_of < game_start),
  check (created_at < game_start),
  check (lead_minutes >= 0),
  check (
    (status = 'CALCULATED' and pick is not null and water is not null and model_ev is not null)
    or
    (status in ('UNOPENED', 'BLOCKED') and model_ev is null and robust_ev is null)
  ),
  check (
    (robust_status = 'CALCULATED' and robust_ev is not null and robust_scenario_hash is not null)
    or
    (robust_status = 'BLOCKED' and robust_ev is null and robust_scenario_hash is null)
  )
);

create index if not exists idx_analysis_direction_game
  on baseball_analysis_direction_results(league_id, external_game_id, analysis_as_of desc);
create index if not exists idx_analysis_direction_snapshot
  on baseball_analysis_direction_results(snapshot_id, slot_index);
create index if not exists idx_analysis_direction_market_w
  on baseball_analysis_direction_results(league_id, market, model_ev desc)
  where status = 'CALCULATED';
create index if not exists idx_analysis_direction_dimensions
  on baseball_analysis_direction_results(league_id, market, qa_status, line_type, lead_minutes)
  where status = 'CALCULATED';
create index if not exists idx_analysis_direction_distribution
  on baseball_analysis_direction_results(league_id, distribution_hash, snapshot_id);

create table if not exists baseball_analysis_direction_settlements (
  settlement_id char(64) primary key,
  settlement_schema_version text not null,
  direction_result_id char(64) not null references baseball_analysis_direction_results(direction_result_id) on delete restrict,
  supersedes_settlement_id char(64) references baseball_analysis_direction_settlements(settlement_id) on delete restrict,
  official_result_hash char(64) not null,
  status text not null check (status in ('SETTLED', 'MANUAL_REVIEW')),
  selected_period text not null check (selected_period in ('FULL_GAME', 'FIRST5')),
  selected_away_runs numeric,
  selected_home_runs numeric,
  outcome text,
  win_fraction numeric,
  loss_fraction numeric,
  push_fraction numeric,
  leg_outcomes jsonb not null default '[]'::jsonb,
  stake numeric not null check (stake = 10000),
  gross_win numeric,
  gross_loss numeric,
  rebate numeric,
  net_profit numeric,
  roi numeric,
  settlement_rule_version text not null,
  result_provider text,
  result_snapshot jsonb not null,
  settlement_error text,
  settled_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (
    (status = 'SETTLED' and outcome is not null and selected_away_runs is not null and selected_home_runs is not null and net_profit is not null and roi is not null)
    or
    (status = 'MANUAL_REVIEW' and settlement_error is not null)
  )
);

create index if not exists idx_analysis_direction_settlement_latest
  on baseball_analysis_direction_settlements(direction_result_id, settled_at desc, created_at desc);
create index if not exists idx_analysis_direction_settlement_outcome
  on baseball_analysis_direction_settlements(status, outcome, settled_at desc);
create unique index if not exists idx_analysis_direction_settlement_root
  on baseball_analysis_direction_settlements(direction_result_id)
  where supersedes_settlement_id is null;
create unique index if not exists idx_analysis_direction_settlement_child
  on baseball_analysis_direction_settlements(supersedes_settlement_id)
  where supersedes_settlement_id is not null;

-- A pre-release runtime-created table may still carry the former uniqueness
-- rule that prevented an official result from returning to a previously seen
-- hash. Remove only that exact three-column constraint; the deterministic event
-- ID and the linear-chain indexes above retain idempotency.
do $direction_settlement_legacy_unique$
declare legacy_name text;
begin
  perform pg_advisory_xact_lock(hashtext('baseball_analysis_direction_settlement_legacy_unique'));
  select constraint_row.conname into legacy_name
  from pg_constraint constraint_row
  where constraint_row.conrelid = 'baseball_analysis_direction_settlements'::regclass
    and constraint_row.contype = 'u'
    and (
      select array_agg(attribute_row.attname::text order by key_row.ordinality)
      from unnest(constraint_row.conkey) with ordinality as key_row(attnum, ordinality)
      join pg_attribute attribute_row
        on attribute_row.attrelid = constraint_row.conrelid
       and attribute_row.attnum = key_row.attnum
    ) = array['direction_result_id', 'official_result_hash', 'settlement_rule_version']::text[]
  limit 1;
  if legacy_name is not null then
    execute format('alter table baseball_analysis_direction_settlements drop constraint %I', legacy_name);
  end if;
end
$direction_settlement_legacy_unique$;

create or replace function reject_baseball_analysis_direction_mutation() returns trigger language plpgsql as $$
begin raise exception 'Baseball analysis direction history is append-only'; end $$;

create or replace function validate_baseball_analysis_direction_pit_insert() returns trigger language plpgsql as $$
declare pit baseball_analysis_pit_snapshots%rowtype;
begin
  select * into pit from baseball_analysis_pit_snapshots where snapshot_id = new.snapshot_id;
  if not found then raise exception 'Analysis direction PIT parent is missing'; end if;
  if new.created_at >= new.game_start or clock_timestamp() >= new.game_start then
    raise exception 'Analysis direction history must be inserted before game start';
  end if;
  if new.official_date is null or new.away_team is null or new.home_team is null
    or pit.league_id is distinct from new.league_id
    or pit.external_game_id is distinct from new.external_game_id
    or pit.game_number is distinct from new.game_number
    or pit.game_start is distinct from new.game_start
    or pit.analysis_type is distinct from new.analysis_type
    or pit.input_hash is distinct from new.input_hash
    or pit.price_fingerprint is distinct from new.price_fingerprint
    or pit.distribution_id is distinct from new.distribution_id
    or pit.distribution_hash is distinct from new.distribution_hash
    or pit.analysis_as_of is distinct from new.analysis_as_of
    or pit.data_as_of is distinct from new.data_as_of
    or pit.line_as_of is distinct from new.line_as_of
    or pit.parent_snapshot_id is distinct from new.parent_snapshot_id
    or nullif(pit.game_identity->>'awayTeamId', '')::bigint is distinct from new.away_team_id
    or nullif(pit.game_identity->>'homeTeamId', '')::bigint is distinct from new.home_team_id
    or nullif(pit.game_identity->>'officialDate', '') is distinct from new.official_date
    or nullif(pit.game_identity->>'away', '') is distinct from new.away_team
    or nullif(pit.game_identity->>'home', '') is distinct from new.home_team
    or pit.model_version is distinct from new.model_version
    or pit.rules_version is distinct from new.rules_version
    or pit.data_version is distinct from new.data_version
    or pit.score_formula_version is distinct from new.score_formula_version
    or pit.settlement_rule_version is distinct from new.settlement_rule_version
    or pit.uncertainty_set_version is distinct from new.uncertainty_set_version
    or pit.reprice_version is distinct from new.reprice_version
    or pit.versions->>'modelEvFormulaVersion' is distinct from new.model_ev_formula_version
    or pit.versions->>'robustEvVersion' is distinct from new.robust_ev_version
    or pit.versions->>'directionSlotContractVersion' is distinct from new.direction_slot_contract_version then
    raise exception 'Analysis direction row does not match immutable PIT parent';
  end if;
  return new;
end $$;

create or replace function validate_baseball_analysis_direction_settlement_insert() returns trigger language plpgsql as $$
declare
  parent_direction_id char(64);
  parent_official_hash char(64);
  result_period text;
begin
  select period into result_period
  from baseball_analysis_direction_results
  where direction_result_id = new.direction_result_id;
  if not found or result_period is distinct from new.selected_period then
    raise exception 'Analysis direction settlement does not match its immutable direction row';
  end if;
  if new.supersedes_settlement_id is not null then
    select direction_result_id, official_result_hash
      into parent_direction_id, parent_official_hash
    from baseball_analysis_direction_settlements
    where settlement_id = new.supersedes_settlement_id;
    if not found or parent_direction_id is distinct from new.direction_result_id then
      raise exception 'Analysis direction settlement supersedes a foreign or missing event';
    end if;
    if parent_official_hash is not distinct from new.official_result_hash then
      raise exception 'Analysis direction correction must change the official result hash';
    end if;
  end if;
  return new;
end $$;

do $direction_history_trigger$
begin
  perform pg_advisory_xact_lock(hashtext('baseball_analysis_direction_history_immutable'));
  if not exists (
    select 1 from pg_trigger
    where tgname = 'baseball_analysis_direction_results_pit_insert'
      and tgrelid = 'baseball_analysis_direction_results'::regclass
      and not tgisinternal
  ) then
    execute 'create trigger baseball_analysis_direction_results_pit_insert before insert on baseball_analysis_direction_results for each row execute function validate_baseball_analysis_direction_pit_insert()';
  end if;
  if not exists (
    select 1 from pg_trigger
    where tgname = 'baseball_analysis_direction_settlements_chain_insert'
      and tgrelid = 'baseball_analysis_direction_settlements'::regclass
      and not tgisinternal
  ) then
    execute 'create trigger baseball_analysis_direction_settlements_chain_insert before insert on baseball_analysis_direction_settlements for each row execute function validate_baseball_analysis_direction_settlement_insert()';
  end if;
  if not exists (
    select 1 from pg_trigger
    where tgname = 'baseball_analysis_direction_results_immutable'
      and tgrelid = 'baseball_analysis_direction_results'::regclass
      and not tgisinternal
  ) then
    execute 'create trigger baseball_analysis_direction_results_immutable before update or delete on baseball_analysis_direction_results for each row execute function reject_baseball_analysis_direction_mutation()';
  end if;
  if not exists (
    select 1 from pg_trigger
    where tgname = 'baseball_analysis_direction_settlements_immutable'
      and tgrelid = 'baseball_analysis_direction_settlements'::regclass
      and not tgisinternal
  ) then
    execute 'create trigger baseball_analysis_direction_settlements_immutable before update or delete on baseball_analysis_direction_settlements for each row execute function reject_baseball_analysis_direction_mutation()';
  end if;
end
$direction_history_trigger$;
