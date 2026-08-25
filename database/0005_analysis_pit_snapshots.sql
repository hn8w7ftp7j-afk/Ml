-- Immutable, league-isolated point-in-time analysis and repricing snapshots.
-- Repricing rows link to the exact parent input/distribution and never replace it.
create table if not exists baseball_analysis_pit_snapshots (
  snapshot_id text primary key,
  schema_version text not null,
  league_id text not null check (league_id in ('MLB', 'NPB', 'KBO', 'CPBL')),
  external_game_id bigint not null,
  game_number integer not null,
  game_identity jsonb not null,
  game_start timestamptz not null,
  data_as_of timestamptz not null,
  analysis_as_of timestamptz not null,
  line_as_of timestamptz not null,
  provider_timestamps jsonb not null,
  analysis_type text not null check (analysis_type in ('FULL', 'PRICE_ONLY_REPRICE')),
  input_hash char(64) not null,
  core_fingerprint char(64) not null,
  price_fingerprint char(64) not null,
  calculation_fingerprint char(64) not null,
  auxiliary_fingerprint char(64) not null,
  distribution_id text not null,
  distribution_hash char(64) not null,
  distribution_storage text not null check (distribution_storage in ('FULL_JSON', 'GZIP_BASE64', 'HASH_ONLY_REBUILDABLE')),
  distribution_payload jsonb not null,
  parent_snapshot_id text references baseball_analysis_pit_snapshots(snapshot_id) deferrable initially deferred,
  parent_analysis_type text check (parent_analysis_type is null or parent_analysis_type in ('FULL', 'PRICE_ONLY_REPRICE')),
  parent_input_hash char(64),
  parent_distribution_id text,
  parent_distribution_hash char(64),
  frozen_context_payload jsonb not null,
  market_analysis_payload jsonb not null,
  feature_contract jsonb not null,
  scenario_contract jsonb not null,
  calibration_contract jsonb not null,
  rule_contract jsonb not null,
  quarantine_contract jsonb not null,
  evidence_status text not null check (evidence_status in ('CURRENT_IMMUTABLE_PIT_CAPTURE', 'EXCLUDED_UNVERIFIABLE_LEGACY')),
  quarantine_status text not null check (quarantine_status in ('NOT_QUARANTINED', 'QUARANTINED')),
  calibration_eligibility text not null check (calibration_eligibility in ('PENDING_SETTLEMENT_AND_LOCKED_OOS_GATE', 'EXCLUDED_UNVERIFIABLE_LEGACY')),
  model_version text not null,
  rules_version text not null,
  data_version text not null,
  score_formula_version text not null,
  settlement_rule_version text not null,
  uncertainty_set_version text not null,
  reprice_version text,
  versions jsonb not null,
  replay_identity_hash char(64) not null,
  created_at timestamptz not null default now(),
  unique (league_id, analysis_type, input_hash),
  check (data_as_of <= analysis_as_of),
  check (line_as_of <= analysis_as_of),
  check (analysis_as_of < game_start),
  check (created_at < game_start),
  check (
    (analysis_type = 'FULL' and parent_snapshot_id is null and parent_analysis_type is null and parent_input_hash is null and parent_distribution_id is null and parent_distribution_hash is null)
    or
    (analysis_type = 'PRICE_ONLY_REPRICE' and parent_snapshot_id is not null and parent_analysis_type is not null and parent_input_hash is not null and parent_distribution_id = distribution_id and parent_distribution_hash = distribution_hash)
  ),
  constraint analysis_pit_reprice_not_self check (
    analysis_type <> 'PRICE_ONLY_REPRICE'
    or (parent_snapshot_id <> snapshot_id and parent_input_hash <> input_hash)
  )
);

-- CREATE TABLE IF NOT EXISTS does not evolve a pre-release table that may
-- already exist during a rolling deploy. Additive fields preserve those rows
-- but explicitly quarantine them from calibration as unverifiable legacy data.
alter table baseball_analysis_pit_snapshots
  add column if not exists parent_snapshot_id text references baseball_analysis_pit_snapshots(snapshot_id) deferrable initially deferred,
  add column if not exists parent_analysis_type text,
  add column if not exists feature_contract jsonb not null default '{"legacyMigration":true}'::jsonb,
  add column if not exists scenario_contract jsonb not null default '{"legacyMigration":true}'::jsonb,
  add column if not exists calibration_contract jsonb not null default '{"status":"EXCLUDED_UNVERIFIABLE_LEGACY"}'::jsonb,
  add column if not exists rule_contract jsonb not null default '{"legacyMigration":true}'::jsonb,
  add column if not exists quarantine_contract jsonb not null default '{"status":"QUARANTINED","legacyEvidenceStatus":"EXCLUDED_UNVERIFIABLE_LEGACY","calibrationEligibility":"EXCLUDED_UNVERIFIABLE_LEGACY","mayEnterCalibration":false}'::jsonb,
  add column if not exists evidence_status text not null default 'EXCLUDED_UNVERIFIABLE_LEGACY',
  add column if not exists quarantine_status text not null default 'QUARANTINED',
  add column if not exists calibration_eligibility text not null default 'EXCLUDED_UNVERIFIABLE_LEGACY';

do $pit_noop_constraint$
begin
  perform pg_advisory_xact_lock(hashtext('analysis_pit_reprice_not_self'));
  if not exists (
    select 1 from pg_constraint
    where conname = 'analysis_pit_reprice_not_self'
      and conrelid = 'baseball_analysis_pit_snapshots'::regclass
  ) then
    alter table baseball_analysis_pit_snapshots
      add constraint analysis_pit_reprice_not_self
      check (
        analysis_type <> 'PRICE_ONLY_REPRICE'
        or (parent_snapshot_id <> snapshot_id and parent_input_hash <> input_hash)
      ) not valid;
  end if;
end
$pit_noop_constraint$;

create index if not exists idx_analysis_pit_league_game_time
  on baseball_analysis_pit_snapshots(league_id, external_game_id, analysis_as_of desc);

create index if not exists idx_analysis_pit_distribution
  on baseball_analysis_pit_snapshots(league_id, distribution_hash);

create index if not exists idx_analysis_pit_parent
  on baseball_analysis_pit_snapshots(parent_snapshot_id);

create index if not exists idx_analysis_pit_calibration_gate
  on baseball_analysis_pit_snapshots(league_id, calibration_eligibility, game_start);

create or replace function reject_baseball_analysis_pit_mutation() returns trigger language plpgsql as $$
begin raise exception 'Baseball analysis PIT snapshots are immutable'; end $$;

do $pit_trigger$
begin
  perform pg_advisory_xact_lock(hashtext('baseball_analysis_pit_immutable'));
  if not exists (
    select 1 from pg_trigger
    where tgname = 'baseball_analysis_pit_immutable'
      and tgrelid = 'baseball_analysis_pit_snapshots'::regclass
      and not tgisinternal
  ) then
    execute 'create trigger baseball_analysis_pit_immutable before update or delete on baseball_analysis_pit_snapshots for each row execute function reject_baseball_analysis_pit_mutation()';
  end if;
end
$pit_trigger$;
