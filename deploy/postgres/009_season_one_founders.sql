update player_progression
set document = jsonb_set(
  document,
  '{passEntitlements}',
  coalesce(document->'passEntitlements', '[]'::jsonb) || to_jsonb('season-1-premium'::text),
  true
)
where season_id = 'season-0'
  and not (coalesce(document->'passEntitlements', '[]'::jsonb) ? 'season-1-premium');
