create table if not exists player_progression (
  session_id text primary key,
  name varchar(20) not null,
  season_id varchar(32) not null,
  level integer not null check (level >= 1),
  battle_pass varchar(16) not null check (battle_pass in ('free','premium')),
  document jsonb not null check (jsonb_typeof(document) = 'object'),
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null
);
create index if not exists player_progression_name_search on player_progression(lower(name));
create index if not exists player_progression_last_seen on player_progression(last_seen_at desc);

create table if not exists progression_applied_keys (
  idempotency_key text primary key,
  applied_at timestamptz not null default now()
);

create table if not exists progression_redemption_keys (
  idempotency_key text primary key,
  applied_at timestamptz not null default now()
);

create table if not exists progression_audit (
  id uuid primary key,
  action varchar(32) not null,
  actor text not null,
  at timestamptz not null,
  document jsonb not null check (jsonb_typeof(document) = 'object')
);
create index if not exists progression_audit_recent on progression_audit(at desc);
