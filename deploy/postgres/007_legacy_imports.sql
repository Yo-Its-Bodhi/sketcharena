create table if not exists sketch_arena_legacy_imports (
  source_name text primary key,
  source_path text not null,
  source_sha256 char(64) not null,
  imported_rows integer not null check (imported_rows >= 0),
  imported_at timestamptz not null default now()
);
