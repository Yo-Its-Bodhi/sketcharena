create table if not exists promotion_campaigns (
  id uuid primary key,
  name varchar(80) not null,
  code_hash char(64) not null unique,
  code_hint varchar(16) not null,
  kind varchar(24) not null check (kind in ('free-mint','mint-discount')),
  uses_per_player integer not null check (uses_per_player between 1 and 10),
  discount_bps integer check (discount_bps is null or discount_bps between 1 and 10000),
  reason varchar(240) not null,
  max_redemptions integer not null check (max_redemptions between 1 and 1000000),
  starts_at timestamptz not null,
  expires_at timestamptz not null,
  status varchar(16) not null check (status in ('active','paused')),
  created_by text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index if not exists promotion_campaigns_status_expiry on promotion_campaigns(status, expires_at);

create table if not exists promotion_redemptions (
  campaign_id uuid not null references promotion_campaigns(id) on delete cascade,
  session_id text not null,
  redeemed_at timestamptz not null,
  primary key(campaign_id, session_id)
);
create index if not exists promotion_redemptions_campaign on promotion_redemptions(campaign_id, redeemed_at);

create table if not exists promotion_audit (
  id uuid primary key,
  action varchar(32) not null,
  actor text not null,
  campaign_id uuid not null references promotion_campaigns(id) on delete cascade,
  at timestamptz not null,
  detail text not null
);
create index if not exists promotion_audit_recent on promotion_audit(at desc);
