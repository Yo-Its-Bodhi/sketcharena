create table if not exists wallet_challenges (
  id uuid primary key,
  session_id text not null,
  address varchar(42) not null check (address ~ '^0x[0-9A-Fa-f]{40}$'),
  message text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null,
  used_at timestamptz
);
create index if not exists wallet_challenges_expiry on wallet_challenges(expires_at);

create table if not exists wallet_bindings (
  session_id text primary key,
  address varchar(42) not null check (address ~ '^0x[0-9A-Fa-f]{40}$'),
  verified_at timestamptz not null
);

create table if not exists mint_records (
  id uuid primary key,
  artwork_id uuid not null unique,
  owner_session_id text not null,
  status varchar(16) not null check (status in ('prepared','submitted','confirmed','failed','expired')),
  wallet_address varchar(42) not null check (wallet_address ~ '^0x[0-9A-Fa-f]{40}$'),
  credit_reward_id text,
  credit_unit integer check (credit_unit is null or credit_unit >= 0),
  discount_reward_id text,
  discount_unit integer check (discount_unit is null or discount_unit >= 0),
  expires_at timestamptz not null,
  transaction_hash varchar(66),
  record jsonb not null check (jsonb_typeof(record) = 'object'),
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index if not exists mint_records_owner_updated on mint_records(owner_session_id, updated_at desc);
create index if not exists mint_records_status_updated on mint_records(status, updated_at desc);
create index if not exists mint_records_live_credit on mint_records(credit_reward_id, credit_unit) where credit_reward_id is not null and status in ('prepared','submitted');
create index if not exists mint_records_live_discount on mint_records(discount_reward_id, discount_unit) where discount_reward_id is not null and status in ('prepared','submitted');
