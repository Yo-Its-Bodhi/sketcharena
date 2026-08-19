-- BodhiX app membership, app-session and reward-claim infrastructure.
-- Additive only: existing Sketch accounts, progression and entitlements are untouched.

create table if not exists bodhix_app_memberships (
  account_id uuid not null references player_accounts(id) on delete cascade,
  app_id varchar(48) not null references bodhix_apps(id),
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata)='object'),
  primary key(account_id,app_id)
);
create index if not exists bodhix_app_memberships_app_recent on bodhix_app_memberships(app_id,last_seen_at desc,account_id);

-- Every existing account originated in Sketch. This seed makes that history
-- explicit without changing the account or its legacy progression document.
insert into bodhix_app_memberships(account_id,app_id,first_seen_at,last_seen_at,metadata)
select account.id,'sketch',account.created_at,greatest(account.created_at,account.updated_at),'{"source":"migration-015"}'::jsonb
from player_accounts account
on conflict(account_id,app_id) do nothing;

-- Opaque app sessions let a server-rendered BodhiX app read only the signed-in
-- player's shared profile. Raw tokens are returned once; only hashes are stored.
create table if not exists bodhix_app_sessions (
  id uuid primary key,
  token_hash text not null unique,
  account_id uuid not null references player_accounts(id) on delete cascade,
  app_id varchar(48) not null references bodhix_apps(id),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  last_seen_at timestamptz not null,
  revoked_at timestamptz,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata)='object')
);
create index if not exists bodhix_app_sessions_active on bodhix_app_sessions(account_id,app_id,expires_at) where revoked_at is null;

-- Claims are receipts, not silent mutations. Preparing a claim reserves an
-- entitlement quantity; fulfilment/rejection is performed by an app operator.
create table if not exists bodhix_reward_claims (
  id uuid primary key,
  entitlement_id uuid not null references bodhix_entitlements(id),
  account_id uuid not null references player_accounts(id) on delete cascade,
  app_id varchar(48) not null references bodhix_apps(id),
  quantity bigint not null check (quantity>0),
  status varchar(16) not null default 'reserved' check (status in ('reserved','fulfilled','rejected','reversed')),
  idempotency_key varchar(160) not null unique,
  reserved_at timestamptz not null,
  fulfilled_at timestamptz,
  rejected_at timestamptz,
  reversed_at timestamptz,
  handled_by varchar(120),
  external_reference varchar(200),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata)='object')
);
create index if not exists bodhix_reward_claims_account_recent on bodhix_reward_claims(account_id,reserved_at desc);
create index if not exists bodhix_reward_claims_app_status on bodhix_reward_claims(app_id,status,reserved_at);

