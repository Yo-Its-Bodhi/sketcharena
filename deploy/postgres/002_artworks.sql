create table if not exists artworks (
  id uuid primary key,
  owner_session_id uuid not null,
  origin varchar(16) not null check (origin in ('arena','studio')),
  status varchar(16) not null check (status in ('draft','gallery','mint-ready','minted')),
  title varchar(80) not null,
  description varchar(500) not null default '',
  canvas_ratio varchar(16) not null check (canvas_ratio in ('square','portrait','landscape')),
  width integer not null check (width between 1 and 10000),
  height integer not null check (height between 1 and 10000),
  strokes jsonb not null default '[]'::jsonb check (jsonb_typeof(strokes) = 'array'),
  preview_url text,
  source_round_id uuid,
  mint jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create unique index if not exists artworks_round_owner_unique on artworks(owner_session_id, origin, source_round_id) where source_round_id is not null;
create index if not exists artworks_owner_updated on artworks(owner_session_id, updated_at desc);
create index if not exists artworks_public_mints on artworks(updated_at desc) where status = 'minted' and mint->>'status' = 'confirmed';
