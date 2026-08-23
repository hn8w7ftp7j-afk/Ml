-- Immutable point-in-time inputs for the six MLB advanced feature families.
create table if not exists mlb_advanced_feature_snapshots (
  id uuid primary key default gen_random_uuid(),
  snapshot_id text not null unique,
  schema_version text not null,
  external_game_id bigint not null,
  game_start timestamptz not null,
  observed_at timestamptz not null,
  feature_payload jsonb not null,
  source_payload_hash char(64) not null,
  provenance jsonb not null,
  created_at timestamptz not null default now(),
  check (observed_at < game_start)
);

create index if not exists idx_mlb_advanced_snapshot_game_time
  on mlb_advanced_feature_snapshots(external_game_id, observed_at);

create or replace function reject_mlb_advanced_snapshot_mutation() returns trigger language plpgsql as $$
begin raise exception 'MLB advanced feature snapshots are immutable'; end $$;
drop trigger if exists mlb_advanced_snapshots_immutable on mlb_advanced_feature_snapshots;
create trigger mlb_advanced_snapshots_immutable
before update or delete on mlb_advanced_feature_snapshots
for each row execute function reject_mlb_advanced_snapshot_mutation();

