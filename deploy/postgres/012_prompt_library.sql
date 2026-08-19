create table if not exists prompt_cards (
  id uuid primary key,
  text varchar(120) not null,
  text_key varchar(120) not null unique,
  category varchar(32) not null,
  difficulty varchar(12) not null check (difficulty in ('easy','medium','hard')),
  active boolean not null default true,
  seasonal_tag varchar(48),
  times_played integer not null default 0 check (times_played >= 0),
  times_solved integer not null default 0 check (times_solved >= 0),
  total_solve_ms bigint not null default 0 check (total_solve_ms >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists prompt_cards_picker
  on prompt_cards(active, category, difficulty);

