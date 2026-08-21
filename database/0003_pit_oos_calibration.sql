-- Additive PIT/OOS calibration storage. Historical rows are immutable by trigger.
create table if not exists pit_calibration_observations (
  id uuid primary key default gen_random_uuid(), observation_id text not null unique,
  schema_version text not null, league text not null, external_game_id bigint not null,
  game_start timestamptz not null, snapshot_as_of timestamptz not null, model_as_of timestamptz not null,
  settled_at timestamptz not null, market_family text not null, contract_type text not null,
  raw_weighted_ev numeric(24,18) not null, realized_net_return numeric(24,18) not null,
  water numeric(9,6) not null, source_payload_hash char(64) not null, model_input_hash char(64) not null,
  feature_observed_ats jsonb not null, provenance jsonb not null, created_at timestamptz not null default now(),
  check (snapshot_as_of < game_start), check (model_as_of <= snapshot_as_of), check (settled_at >= game_start)
);

create table if not exists oos_calibration_artifacts (
  id uuid primary key default gen_random_uuid(), calibration_version text not null,
  artifact_hash char(64) not null unique, trained_through timestamptz not null,
  sample_size integer not null, oos_sample_size integer not null, artifact jsonb not null,
  status text not null default 'SHADOW', created_at timestamptz not null default now()
);

create or replace function reject_pit_observation_mutation() returns trigger language plpgsql as $$
begin raise exception 'PIT calibration observations are immutable'; end $$;
drop trigger if exists pit_observations_immutable on pit_calibration_observations;
create trigger pit_observations_immutable before update or delete on pit_calibration_observations
for each row execute function reject_pit_observation_mutation();

create index if not exists idx_pit_calibration_time on pit_calibration_observations(league, game_start);
