create table if not exists moderation_reports (
  id uuid primary key,
  room_id text not null,
  room_name varchar(36) not null,
  reporter_session_id text not null,
  reporter_name varchar(20) not null,
  target_session_id text not null,
  target_player_id text not null,
  target_name varchar(20) not null,
  category varchar(32) not null check (category in ('harassment','hate-or-threats','spam','cheating','unsafe-art','other')),
  detail varchar(500) not null,
  status varchar(16) not null check (status in ('open','reviewing','resolved','dismissed')),
  handled_by text,
  resolution_note varchar(500),
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index if not exists moderation_reports_status_recent on moderation_reports(status, created_at desc);
create index if not exists moderation_reports_duplicate_window on moderation_reports(reporter_session_id,target_session_id,room_id,category,created_at desc);
