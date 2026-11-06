-- Lot 3 : état de l'accueil et de « Régler demain », calculé côté serveur.

create function private.home_state(p_user uuid, p_now timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_c public.challenges;
  v_today date;
  v_tomorrow date;
  v_month date;
  v_bed public.obligations;
  v_plan public.day_plans;
  v_lock timestamptz;
begin
  v_c := private.user_challenge(p_user);
  if v_c.id is null then
    raise exception 'Non autorisé.' using errcode = '42501';
  end if;
  v_today := private.local_date(p_now, v_c.timezone);
  v_tomorrow := v_today + 1;
  v_month := date_trunc('month', v_today)::date;
  v_lock := private.lock_at(v_c, v_tomorrow);

  perform private.ensure_obligations(p_user, v_today - 1, p_now);
  perform private.ensure_obligations(p_user, v_today, p_now);
  perform private.ensure_obligations(p_user, v_tomorrow, p_now);

  -- « Ce soir » : la nuit en cours ou la prochaine (après minuit, c'est encore celle de la veille).
  select * into v_bed from public.obligations
   where user_id = p_user and kind = 'bed' and not is_scenario
     and day between v_today - 1 and v_today and window_end > p_now
   order by day
   limit 1;

  select * into v_plan from public.day_plans
   where challenge_id = v_c.id and user_id = p_user and day = v_tomorrow;

  return jsonb_build_object(
    'server_now', p_now,
    'today', v_today,
    'month', v_month,
    'month_due_cents', (select coalesce(sum(amount_cents), 0) from public.fines
                         where user_id = p_user and not is_test
                           and day >= v_month and day < (v_month + interval '1 month')::date),
    'month_test_cents', (select coalesce(sum(amount_cents), 0) from public.fines
                          where user_id = p_user and is_test
                            and day >= v_month and day < (v_month + interval '1 month')::date),
    'deposit_cents', (select coalesce(sum(amount_cents), 0) from public.deposits where user_id = p_user),
    'fines_total_cents', (select coalesce(sum(amount_cents), 0) from public.fines where user_id = p_user and not is_test),
    'friend_name', (select friend_name from public.deposits where user_id = p_user order by paid_on desc, created_at desc limit 1),
    'tonight', case when v_bed.id is null then null else jsonb_build_object(
      'day', v_bed.day,
      'start', to_char(v_bed.window_start at time zone v_c.timezone, 'HH24:MI'),
      'free', v_bed.is_free,
      'test', v_bed.is_test,
      'status', v_bed.status,
      'active', p_now >= v_bed.window_start) end,
    'tomorrow', jsonb_build_object(
      'day', v_tomorrow,
      'set', coalesce(v_plan.source = 'user', false),
      'wake_time', to_char(coalesce(v_plan.wake_time, v_c.default_wake), 'HH24:MI'),
      'wake_free', coalesce(v_plan.wake_free, false),
      'bed_time', to_char(coalesce(v_plan.bed_time, v_c.default_bed), 'HH24:MI'),
      'bed_free', coalesce(v_plan.bed_free, false),
      'lock_at', v_lock,
      'locked', p_now >= v_lock),
    'defaults', jsonb_build_object(
      'wake_time', to_char(v_c.default_wake, 'HH24:MI'),
      'bed_time', to_char(v_c.default_bed, 'HH24:MI')),
    'real_start_date', v_c.real_start_date,
    'last_signal_at', (select max(received_at) from public.app_signals where user_id = p_user),
    'last_tick_at', (select last_tick_at from private.tick_state));
end $$;

create function public.get_home()
returns jsonb language sql security definer set search_path = '' as $$
  select private.home_state((select auth.uid()), now())
$$;

revoke execute on function private.home_state(uuid, timestamptz) from public, anon, authenticated;
revoke execute on function public.get_home() from public, anon;
grant execute on function public.get_home() to authenticated;
