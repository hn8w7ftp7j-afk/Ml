-- Permanent actual-bet ledger. User-facing APIs are additive; legacy rows remain available for audit.

create table if not exists baseball_private_bets_v2 (
  id text primary key,
  position_key text not null,
  price_key text not null,
  league text not null,
  game_pk bigint not null,
  placed_at timestamptz not null,
  status text not null default 'OPEN',
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

create index if not exists idx_baseball_private_bets_v2_league_placed
  on baseball_private_bets_v2(league, placed_at desc);

create index if not exists idx_baseball_private_bets_v2_status
  on baseball_private_bets_v2(status, placed_at);

-- Safe one-time import from the previous single-position table.
insert into baseball_private_bets_v2 (
  id, position_key, price_key, league, game_pk, placed_at, status, payload, updated_at
)
select
  id,
  position_key,
  position_key || '|||legacy',
  league,
  coalesce(nullif(payload->>'gamePk', '')::bigint, 0),
  placed_at,
  coalesce(nullif(upper(payload->>'status'), ''), 'OPEN'),
  payload,
  updated_at
from baseball_private_bets
on conflict (id) do nothing;
