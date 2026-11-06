-- Lot 4 : état du jeton Raccourcis et des signaux, pour l'écran Réglages.
create function public.get_shortcut_status()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'has_token', t.user_id is not null,
    'token_created_at', t.created_at,
    'token_last_used_at', t.last_used_at,
    'last_signal_at', s.received_at,
    'last_signal_app', s.app,
    'server_now', now())
  from (select (select auth.uid()) as uid) me
  left join private.shortcut_tokens t on t.user_id = me.uid
  left join lateral (select received_at, app from public.app_signals
                      where user_id = me.uid order by received_at desc limit 1) s on true
$$;

revoke execute on function public.get_shortcut_status() from public, anon;
grant execute on function public.get_shortcut_status() to authenticated;
