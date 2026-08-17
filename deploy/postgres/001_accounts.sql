create table if not exists player_accounts (
  id uuid primary key,
  name varchar(20) not null,
  legacy_credential_hash char(64) unique,
  secured_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists player_device_sessions (
  id uuid primary key,
  account_id uuid not null references player_accounts(id) on delete cascade,
  token_hash char(64) not null unique,
  label varchar(80) not null,
  created_at timestamptz not null,
  last_seen_at timestamptz not null,
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index if not exists player_device_sessions_account_active on player_device_sessions(account_id, last_seen_at desc) where revoked_at is null;
create index if not exists player_device_sessions_expiry on player_device_sessions(expires_at);

create table if not exists player_passkeys (
  id text primary key,
  account_id uuid not null references player_accounts(id) on delete cascade,
  webauthn_user_id text not null,
  public_key text not null,
  counter bigint not null check (counter >= 0),
  device_type varchar(16) not null check (device_type in ('singleDevice','multiDevice')),
  backed_up boolean not null,
  transports jsonb not null default '[]'::jsonb,
  label varchar(80) not null,
  created_at timestamptz not null,
  last_used_at timestamptz
);
create index if not exists player_passkeys_account on player_passkeys(account_id);

create table if not exists account_challenges (
  id uuid primary key,
  kind varchar(16) not null check (kind in ('registration','authentication')),
  challenge text not null,
  account_id uuid references player_accounts(id) on delete cascade,
  created_at timestamptz not null,
  expires_at timestamptz not null
);
create index if not exists account_challenges_expiry on account_challenges(expires_at);
