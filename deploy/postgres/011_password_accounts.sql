alter table player_accounts add column if not exists password_hash text;

alter table player_accounts
  add constraint player_accounts_password_hash_format
  check (password_hash is null or password_hash ~ '^scrypt[$][0-9]+[$][0-9]+[$][0-9]+[$][A-Za-z0-9_-]+[$][A-Za-z0-9_-]+$')
  not valid;

alter table player_accounts validate constraint player_accounts_password_hash_format;
