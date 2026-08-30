-- V11.7.4: cancelled tickets remain immutable audit records, while the same
-- position may receive one new active ticket. At most one non-cancelled ticket
-- per position is still enforced atomically by PostgreSQL.

begin;

lock table baseball_private_bets_v2 in share row exclusive mode;

create unique index if not exists uq_baseball_private_bets_v2_active_position_v1172
  on baseball_private_bets_v2(position_key)
  where status <> 'CANCELLED';

drop index if exists uq_baseball_private_bets_v2_position_key_v110;

commit;
