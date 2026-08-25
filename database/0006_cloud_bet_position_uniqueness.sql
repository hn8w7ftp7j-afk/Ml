-- V11.0: make the one-position-one-ticket invariant a database guarantee.
-- Existing duplicate rows are retained verbatim in an audit quarantine and
-- remain in the ledger as MANUAL_REVIEW rows under deterministic quarantine keys.

begin;

lock table baseball_private_bets_v2 in share row exclusive mode;

create table if not exists baseball_private_bets_v2_position_quarantine (
  id text primary key,
  original_position_key text not null,
  canonical_bet_id text not null,
  reason text not null,
  quarantined_at timestamptz not null default now(),
  original_row jsonb not null
);

with ranked as (
  select bet.*,
         row_number() over (
           partition by position_key
           order by placed_at asc, updated_at asc, id asc
         ) as duplicate_rank,
         first_value(id) over (
           partition by position_key
           order by placed_at asc, updated_at asc, id asc
         ) as canonical_bet_id
  from baseball_private_bets_v2 as bet
)
insert into baseball_private_bets_v2_position_quarantine (
  id, original_position_key, canonical_bet_id, reason, original_row
)
select id,
       position_key,
       canonical_bet_id,
       'DUPLICATE_POSITION_KEY_BEFORE_V110_UNIQUE_INDEX',
       to_jsonb(ranked) - 'duplicate_rank' - 'canonical_bet_id'
from ranked
where duplicate_rank > 1
on conflict (id) do nothing;

with ranked as (
  select id,
         position_key as original_position_key,
         status as original_status,
         row_number() over (
           partition by position_key
           order by placed_at asc, updated_at asc, id asc
         ) as duplicate_rank,
         first_value(id) over (
           partition by position_key
           order by placed_at asc, updated_at asc, id asc
         ) as canonical_bet_id
  from baseball_private_bets_v2
), duplicates as (
  select id,
         original_position_key,
         original_status,
         canonical_bet_id,
         original_position_key
           || '|||duplicate-quarantine-v110|||'
           || encode(convert_to(id, 'UTF8'), 'hex') as quarantine_position_key
  from ranked
  where duplicate_rank > 1
)
update baseball_private_bets_v2 as bet
set position_key = duplicates.quarantine_position_key,
    status = 'MANUAL_REVIEW',
    payload = bet.payload || jsonb_build_object(
      'positionIdentity', duplicates.quarantine_position_key,
      'originalPositionIdentity', duplicates.original_position_key,
      'status', 'MANUAL_REVIEW',
      'pitPrediction', null,
      'pitPredictionStatus', 'EXCLUDED_DUPLICATE_POSITION_QUARANTINE',
      'pitPredictionErrors', jsonb_build_array('DUPLICATE_POSITION_KEY_BEFORE_V110_UNIQUE_INDEX'),
      'pitEvidenceVerified', false,
      'calibrationEligibility', 'EXCLUDED_DUPLICATE_POSITION_QUARANTINE',
      'duplicateQuarantine', jsonb_build_object(
        'version', 'V11.0.0',
        'reason', 'DUPLICATE_POSITION_KEY_BEFORE_V110_UNIQUE_INDEX',
        'canonicalBetId', duplicates.canonical_bet_id,
        'originalStatus', duplicates.original_status
      )
    ),
    updated_at = now()
from duplicates
where bet.id = duplicates.id;

create unique index if not exists uq_baseball_private_bets_v2_position_key_v110
  on baseball_private_bets_v2(position_key);

commit;
