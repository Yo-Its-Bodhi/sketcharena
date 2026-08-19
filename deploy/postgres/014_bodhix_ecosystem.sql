-- Additive BodhiX ecosystem identity and rewards migration.
-- Existing Sketch Arena accounts remain the authority and are never rewritten.

create table if not exists bodhix_apps (
  id varchar(48) primary key,
  name varchar(80) not null,
  status varchar(16) not null default 'private' check (status in ('private','beta','live','paused')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into bodhix_apps(id,name,status) values
  ('sketch','Sketch Arena','live'),
  ('poker','BodhiX Poker','beta'),
  ('football','BodhiX Football','private'),
  ('carnival','The Shitshow Carnival','private'),
  ('shidoki','Shidoki','private'),
  ('store','BodhiX Store','private'),
  ('minigames','BodhiX Mini Games','private')
on conflict(id) do nothing;

create table if not exists bodhix_wallets (
  id uuid primary key,
  account_id uuid not null references player_accounts(id) on delete cascade,
  address varchar(42) not null check (address ~ '^0x[0-9A-Fa-f]{40}$'),
  label varchar(80) not null default 'Verified wallet',
  is_primary boolean not null default false,
  verified_at timestamptz not null,
  revoked_at timestamptz
);
create unique index if not exists bodhix_wallets_active_address_unique on bodhix_wallets(lower(address)) where revoked_at is null;
create unique index if not exists bodhix_wallets_one_primary_per_account on bodhix_wallets(account_id) where is_primary and revoked_at is null;
create index if not exists bodhix_wallets_account_active on bodhix_wallets(account_id, is_primary desc, verified_at) where revoked_at is null;

-- The legacy Sketch binding key has represented the durable account UUID since
-- identity migration 010. Copy it; never remove or rewrite the legacy record.
create table if not exists bodhix_wallet_import_conflicts (
  account_id uuid not null references player_accounts(id) on delete cascade,
  address varchar(42) not null,
  verified_at timestamptz not null,
  detected_at timestamptz not null default now(),
  primary key(account_id,address)
);

insert into bodhix_wallet_import_conflicts(account_id,address,verified_at)
select binding.session_id::uuid,binding.address,binding.verified_at
from wallet_bindings binding
where binding.session_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  and exists(select 1 from player_accounts account where account.id=binding.session_id::uuid)
  and exists(select 1 from wallet_bindings other where lower(other.address)=lower(binding.address) and other.session_id<>binding.session_id)
on conflict(account_id,address) do nothing;

with candidates as (
  select distinct on (lower(binding.address)) binding.session_id,binding.address,binding.verified_at
  from wallet_bindings binding
  where binding.session_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    and exists(select 1 from player_accounts account where account.id=binding.session_id::uuid)
  order by lower(binding.address),binding.verified_at desc,binding.session_id
)
insert into bodhix_wallets(id,account_id,address,label,is_primary,verified_at)
select (substr(md5(candidate.session_id||':'||lower(candidate.address)),1,8)||'-'||substr(md5(candidate.session_id||':'||lower(candidate.address)),9,4)||'-'||substr(md5(candidate.session_id||':'||lower(candidate.address)),13,4)||'-'||substr(md5(candidate.session_id||':'||lower(candidate.address)),17,4)||'-'||substr(md5(candidate.session_id||':'||lower(candidate.address)),21,12))::uuid,candidate.session_id::uuid,candidate.address,'Imported Sketch wallet',true,candidate.verified_at
from candidates candidate
where not exists(select 1 from bodhix_wallets wallet where lower(wallet.address)=lower(candidate.address) and wallet.revoked_at is null)
on conflict do nothing;

create table if not exists bodhix_seasons (
  id varchar(64) primary key,
  name varchar(120) not null,
  status varchar(16) not null default 'draft' check (status in ('draft','private','live','ended','paused')),
  public_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(public_metadata)='object'),
  private_config jsonb not null default '{}'::jsonb check (jsonb_typeof(private_config)='object'),
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into bodhix_seasons(id,name,status,public_metadata)
values('beta-0','The First Bad Decision','live','{"label":"Beta Season 0"}'::jsonb)
on conflict(id) do nothing;

create table if not exists bodhix_reward_definitions (
  id uuid primary key,
  code varchar(100) not null unique,
  name varchar(120) not null,
  kind varchar(32) not null check (kind in ('cosmetic','xp','badge','title','emote','discount','mint-credit','nft-claim','store-credit','pass-entitlement','consumable')),
  scope varchar(16) not null default 'app' check (scope in ('app','ecosystem')),
  app_id varchar(48) references bodhix_apps(id),
  season_id varchar(64) references bodhix_seasons(id),
  transferable boolean not null default false,
  consumable boolean not null default false,
  supply_cap bigint check (supply_cap is null or supply_cap>=0),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata)='object'),
  status varchar(16) not null default 'draft' check (status in ('draft','private','live','retired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((scope='ecosystem' and app_id is null) or (scope='app' and app_id is not null))
);
create index if not exists bodhix_reward_definitions_catalog on bodhix_reward_definitions(status,season_id,app_id,kind);

-- Preserve the previously promised founding-player access as a private ecosystem
-- entitlement. Its future product name, price and launch copy are intentionally absent.
insert into bodhix_reward_definitions(id,code,name,kind,scope,metadata,status)
values('b0d10000-0000-4000-8000-000000000001','founder-future-pass','FOUNDING WEIRDO ACCESS','pass-entitlement','ecosystem','{"hidden":true,"founder":true}'::jsonb,'private')
on conflict(code) do nothing;

create table if not exists bodhix_entitlements (
  id uuid primary key,
  account_id uuid not null references player_accounts(id) on delete cascade,
  reward_id uuid not null references bodhix_reward_definitions(id),
  quantity bigint not null default 1 check (quantity>=0),
  remaining bigint check (remaining is null or remaining>=0),
  status varchar(16) not null default 'active' check (status in ('active','consumed','expired','revoked')),
  source varchar(32) not null,
  source_reference varchar(160),
  idempotency_key varchar(160) not null unique,
  granted_by varchar(120) not null,
  granted_at timestamptz not null,
  expires_at timestamptz,
  revoked_at timestamptz,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata)='object')
);
create index if not exists bodhix_entitlements_account_active on bodhix_entitlements(account_id,status,expires_at,granted_at desc);
create index if not exists bodhix_entitlements_reward_active on bodhix_entitlements(reward_id,status,granted_at desc);

with founders as (
  select distinct progression.session_id::uuid account_id
  from player_progression progression
  where progression.session_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    and exists(select 1 from player_accounts account where account.id=progression.session_id::uuid)
    and coalesce(progression.document->'passEntitlements','[]'::jsonb) ? 'season-1-premium'
)
insert into bodhix_entitlements(id,account_id,reward_id,quantity,remaining,status,source,source_reference,idempotency_key,granted_by,granted_at,metadata)
select (substr(md5(founder.account_id::text||':founder-future-pass'),1,8)||'-'||substr(md5(founder.account_id::text||':founder-future-pass'),9,4)||'-'||substr(md5(founder.account_id::text||':founder-future-pass'),13,4)||'-'||substr(md5(founder.account_id::text||':founder-future-pass'),17,4)||'-'||substr(md5(founder.account_id::text||':founder-future-pass'),21,12))::uuid,
  founder.account_id,'b0d10000-0000-4000-8000-000000000001',1,null,'active','legacy-founder','season-0','founder-future-pass:'||founder.account_id::text,'migration:014',now(),'{"hidden":true}'::jsonb
from founders founder
on conflict(idempotency_key) do nothing;

create table if not exists bodhix_xp_events (
  id uuid primary key,
  account_id uuid not null references player_accounts(id) on delete cascade,
  app_id varchar(48) not null references bodhix_apps(id),
  season_id varchar(64) references bodhix_seasons(id),
  amount integer not null,
  reason varchar(240) not null,
  idempotency_key varchar(160) not null unique,
  source_reference varchar(160),
  created_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata)='object')
);
create index if not exists bodhix_xp_events_leaderboard on bodhix_xp_events(app_id,season_id,account_id,created_at desc);

create table if not exists bodhix_campaigns (
  id uuid primary key,
  code varchar(100) not null unique,
  name varchar(160) not null,
  app_id varchar(48) references bodhix_apps(id),
  season_id varchar(64) references bodhix_seasons(id),
  reward_id uuid not null references bodhix_reward_definitions(id),
  status varchar(16) not null default 'draft' check (status in ('draft','scheduled','live','paused','ended','cancelled')),
  hidden boolean not null default true,
  audience jsonb not null default '{}'::jsonb check (jsonb_typeof(audience)='object'),
  quantity_per_account bigint not null default 1 check (quantity_per_account>0),
  max_grants bigint check (max_grants is null or max_grants>0),
  starts_at timestamptz,
  ends_at timestamptz,
  created_by varchar(120) not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index if not exists bodhix_campaigns_status_window on bodhix_campaigns(status,starts_at,ends_at);

create table if not exists bodhix_campaign_grants (
  campaign_id uuid not null references bodhix_campaigns(id) on delete cascade,
  account_id uuid not null references player_accounts(id) on delete cascade,
  entitlement_id uuid references bodhix_entitlements(id),
  status varchar(16) not null default 'granted' check (status in ('granted','claimed','failed','revoked')),
  granted_at timestamptz not null,
  claimed_at timestamptz,
  error text,
  primary key(campaign_id,account_id)
);
create index if not exists bodhix_campaign_grants_account on bodhix_campaign_grants(account_id,granted_at desc);

create table if not exists bodhix_admin_principals (
  name varchar(80) primary key,
  role varchar(16) not null check (role in ('viewer','support','operator','admin')),
  account_id uuid references player_accounts(id),
  active boolean not null default true,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists bodhix_admin_audit (
  id uuid primary key,
  principal varchar(80) not null,
  action varchar(100) not null,
  target_type varchar(64) not null,
  target_id varchar(160),
  idempotency_key varchar(160) not null unique,
  request_id varchar(100),
  before_state jsonb,
  after_state jsonb,
  created_at timestamptz not null
);
create index if not exists bodhix_admin_audit_created on bodhix_admin_audit(created_at desc,principal);

create table if not exists bodhix_commerce_quotes (
  id uuid primary key,
  account_id uuid not null references player_accounts(id) on delete cascade,
  product_code varchar(100) not null,
  payer_wallet varchar(42) not null check (payer_wallet ~ '^0x[0-9A-Fa-f]{40}$'),
  token_address varchar(42) not null check (token_address ~ '^0x[0-9A-Fa-f]{40}$'),
  token_amount numeric(78,0) not null check (token_amount>0),
  fiat_currency char(3) not null,
  fiat_minor integer not null check (fiat_minor>0),
  status varchar(16) not null default 'quoted' check (status in ('quoted','submitted','confirmed','expired','cancelled','failed')),
  expires_at timestamptz not null,
  transaction_hash varchar(66),
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create unique index if not exists bodhix_commerce_quotes_transaction on bodhix_commerce_quotes(transaction_hash) where transaction_hash is not null;
create index if not exists bodhix_commerce_quotes_account_status on bodhix_commerce_quotes(account_id,status,created_at desc);

-- Short-lived, single-use PKCE handoffs let other BodhiX apps authenticate against
-- this account authority without sharing Sketch cookies or passwords.
create table if not exists bodhix_auth_codes (
  id uuid primary key,
  code_hash text unique not null,
  account_id uuid not null references player_accounts(id) on delete cascade,
  app_id text not null references bodhix_apps(id),
  redirect_uri text not null,
  pkce_challenge text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists bodhix_auth_codes_expiry on bodhix_auth_codes(expires_at) where used_at is null;
