-- Additive-only v9 schema. No existing table is altered or dropped.
-- Numeric columns intentionally use NUMERIC rather than floating point.

create extension if not exists pgcrypto;

create table if not exists app_users (
  id uuid primary key default gen_random_uuid(),
  login text unique,
  role text not null default 'owner',
  status text not null default 'active',
  created_at timestamptz not null default now()
);

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  league text not null default 'MLB',
  external_game_id bigint not null,
  official_date date not null,
  game_number integer not null default 1,
  away_team text not null,
  home_team text not null,
  neutral_site boolean not null default false,
  venue text,
  scheduled_innings integer not null default 9,
  start_time timestamptz,
  status text,
  created_at timestamptz not null default now(),
  unique (league, external_game_id)
);

create table if not exists data_snapshots (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id),
  data_as_of timestamptz not null,
  data_version text not null,
  provider_timestamps jsonb not null default '{}'::jsonb,
  raw_payload jsonb not null,
  normalized_payload jsonb not null,
  core_fingerprint char(64) not null,
  created_at timestamptz not null default now(),
  unique (event_id, core_fingerprint, data_version)
);

create table if not exists line_sources (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  display_name text not null,
  source_type text not null check (source_type in ('ACTUAL_TW_CREDIT','REFERENCE','ESTIMATED','INTERNATIONAL','HISTORICAL','USER_IMPORTED')),
  authorization_status text not null default 'USER_PROVIDED',
  independent_group_id text,
  freshness_ttl_seconds integer,
  created_at timestamptz not null default now()
);

create table if not exists import_assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references app_users(id),
  asset_type text not null check (asset_type in ('IMAGE','TEXT','MANUAL','API')),
  original_name text,
  content_hash char(64) not null,
  storage_uri text,
  metadata jsonb not null default '{}'::jsonb,
  imported_at timestamptz not null default now()
);

create table if not exists line_snapshots (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id),
  source_id uuid references line_sources(id),
  import_asset_id uuid references import_assets(id),
  line_as_of timestamptz not null,
  imported_at timestamptz not null default now(),
  executable_status text not null default 'UNCONFIRMED' check (executable_status in ('EXECUTABLE','UNCONFIRMED','HISTORICAL','EXPIRED','REJECTED','DISAPPEARED')),
  source_label text,
  raw_payload jsonb not null,
  price_fingerprint char(64) not null,
  unique (event_id, price_fingerprint)
);

create table if not exists contracts (
  id uuid primary key default gen_random_uuid(),
  line_snapshot_id uuid not null references line_snapshots(id),
  market_group_id text not null,
  period text not null,
  market_type text not null,
  direction text not null,
  reference_side text,
  line_legs jsonb not null,
  tail_sign text not null,
  tail_percent numeric(7,4) not null default 0,
  water numeric(9,6),
  water_actual boolean not null default false,
  raw_text text not null,
  source_template_version text,
  contract_rule text,
  parse_qa jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists analysis_runs (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id),
  data_snapshot_id uuid not null references data_snapshots(id),
  line_snapshot_id uuid not null references line_snapshots(id),
  parent_distribution_id uuid,
  analysis_type text not null check (analysis_type in ('FULL','REPRICE')),
  analysis_as_of timestamptz not null,
  input_hash char(64) not null,
  core_fingerprint char(64) not null,
  price_fingerprint char(64) not null,
  model_version text not null,
  data_version text not null,
  score_formula_version text not null,
  settlement_rule_version text not null,
  uncertainty_set_version text not null,
  random_seed text,
  status text not null,
  created_at timestamptz not null default now(),
  unique (input_hash, model_version, score_formula_version, settlement_rule_version, uncertainty_set_version)
);

create table if not exists distribution_snapshots (
  id uuid primary key default gen_random_uuid(),
  analysis_run_id uuid not null references analysis_runs(id),
  full_distribution jsonb not null,
  first5_distribution jsonb not null,
  robust_variant_distributions jsonb,
  probability_sum numeric(24,18) not null,
  overflow_rule jsonb not null,
  distribution_hash char(64) not null,
  created_at timestamptz not null default now(),
  unique (distribution_hash)
);

alter table analysis_runs
  drop constraint if exists analysis_runs_parent_distribution_id_fkey;
alter table analysis_runs
  add constraint analysis_runs_parent_distribution_id_fkey
  foreign key (parent_distribution_id) references distribution_snapshots(id);

create table if not exists scenario_sets (
  id uuid primary key default gen_random_uuid(),
  analysis_run_id uuid not null references analysis_runs(id),
  uncertainty_set_version text not null,
  scenarios jsonb not null,
  weights jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists analysis_results (
  id uuid primary key default gen_random_uuid(),
  analysis_run_id uuid not null references analysis_runs(id),
  contract_id uuid not null references contracts(id),
  score_type text not null,
  full_win_probability numeric(24,18),
  partial_win_probability numeric(24,18),
  push_probability numeric(24,18),
  partial_loss_probability numeric(24,18),
  full_loss_probability numeric(24,18),
  weighted_ev numeric(24,18),
  robust_ev numeric(24,18),
  conservative_ev numeric(24,18),
  ev_flip_probability numeric(24,18),
  ev_flip_status text,
  score_raw numeric(8,4),
  score_final numeric(4,1),
  score_formula_version text not null,
  score_components jsonb not null,
  applied_caps jsonb not null default '[]'::jsonb,
  eligibility boolean not null default false,
  result_status text not null,
  created_at timestamptz not null default now(),
  unique (analysis_run_id, contract_id)
);

create table if not exists qa_checks (
  id uuid primary key default gen_random_uuid(),
  analysis_run_id uuid not null references analysis_runs(id),
  analysis_result_id uuid references analysis_results(id),
  check_code text not null,
  passed boolean not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists minimum_prices (
  id uuid primary key default gen_random_uuid(),
  analysis_result_id uuid not null references analysis_results(id),
  score_threshold numeric(4,1) not null default 7.2,
  minimum_line jsonb,
  minimum_tail_sign text,
  minimum_tail_percent numeric(7,4),
  minimum_water numeric(9,6),
  break_even_water numeric(9,6),
  distance_to_pass jsonb,
  created_at timestamptz not null default now()
);

create table if not exists bets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references app_users(id),
  analysis_result_id uuid not null references analysis_results(id),
  placed_contract_snapshot jsonb not null,
  stake numeric(18,4) not null,
  unit numeric(12,4),
  placed_at timestamptz not null,
  status text not null default 'OPEN',
  created_at timestamptz not null default now()
);

create table if not exists bet_settlements (
  id uuid primary key default gen_random_uuid(),
  bet_id uuid not null references bets(id),
  result_snapshot jsonb not null,
  leg_outcomes jsonb not null,
  gross_win numeric(18,4) not null,
  gross_loss numeric(18,4) not null,
  rebate numeric(18,4) not null,
  net_profit numeric(18,4) not null,
  settlement_rule_version text not null,
  settled_at timestamptz not null default now(),
  unique (bet_id)
);

create table if not exists closing_snapshots (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id),
  source_id uuid references line_sources(id),
  line_as_of timestamptz not null,
  contracts jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists clv_results (
  id uuid primary key default gen_random_uuid(),
  bet_id uuid not null references bets(id),
  market_clv numeric(24,18),
  closing_reestimated_ev numeric(24,18),
  calculation_versions jsonb not null,
  created_at timestamptz not null default now(),
  unique (bet_id)
);

create table if not exists version_registry (
  version_type text not null,
  version text not null,
  definition jsonb not null,
  checksum char(64) not null,
  active_from timestamptz not null,
  retired_at timestamptz,
  primary key (version_type, version)
);

create table if not exists feature_flags (
  flag text primary key,
  enabled boolean not null default false,
  definition jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists idempotency_keys (
  owner_key text not null,
  idempotency_key text not null,
  request_hash char(64) not null,
  response_status integer,
  response_body jsonb,
  resource_type text,
  resource_id uuid,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (owner_key, idempotency_key)
);

create table if not exists audit_logs (
  id bigserial primary key,
  user_id uuid references app_users(id),
  action text not null,
  resource_type text,
  resource_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_analysis_runs_event_created on analysis_runs(event_id, created_at desc);
create index if not exists idx_analysis_results_score on analysis_results(score_final desc);
create index if not exists idx_bets_user_created on bets(user_id, created_at desc);
create index if not exists idx_qa_checks_run on qa_checks(analysis_run_id, passed);
