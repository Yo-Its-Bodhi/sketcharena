alter table player_accounts add column if not exists name_key varchar(64);

with ranked as (
  select id, name, row_number() over (partition by lower(regexp_replace(trim(name), '\s+', ' ', 'g')) order by (secured_at is not null) desc, created_at, id) as position
  from player_accounts
), conflicts as (
  select id, left(name, 14) || '-' || left(replace(id::text, '-', ''), 5) as replacement
  from ranked
  where position > 1
)
update player_accounts account
set name = conflicts.replacement,
    updated_at = greatest(account.updated_at, now())
from conflicts
where account.id = conflicts.id;

update player_accounts
set name_key = lower(regexp_replace(trim(name), '\s+', ' ', 'g'))
where name_key is null;

alter table player_accounts alter column name_key set not null;
create unique index if not exists player_accounts_name_key_unique on player_accounts(name_key);
create unique index if not exists wallet_bindings_address_unique on wallet_bindings(lower(address));
