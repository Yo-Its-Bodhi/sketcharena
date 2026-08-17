create table if not exists leaderboard_match_receipts (
  match_id uuid primary key,
  ended_at timestamptz not null,
  recorded_at timestamptz not null default now()
);
create index if not exists leaderboard_match_receipts_ended_at on leaderboard_match_receipts(ended_at desc);
