-- Lot 5 : état de la preuve de réveil pour l'écran Photo.
-- Un scénario de test récent passe avant le réveil réel du jour.
create function private.wake_status(p_user uuid, p_now timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_c public.challenges;
  v_d date;
  v_o public.obligations;
  v_state text;
begin
  v_c := private.user_challenge(p_user);
  if v_c.id is null then
    raise exception 'Non autorisé.' using errcode = '42501';
  end if;
  v_d := private.local_date(p_now, v_c.timezone);
  perform private.ensure_obligations(p_user, v_d, p_now);

  select * into v_o from public.obligations
   where user_id = p_user and kind = 'wake' and is_scenario and window_end > p_now - interval '30 minutes'
   order by created_at desc limit 1;
  if not found then
    select * into v_o from public.obligations
     where user_id = p_user and kind = 'wake' and not is_scenario and day = v_d;
  end if;
  if not found then
    return jsonb_build_object('state', 'none', 'server_now', p_now);
  end if;

  v_state := case
    when v_o.is_free then 'free'
    when v_o.status = 'done' then 'done'
    when v_o.status = 'failed' or p_now >= v_o.window_end + interval '1 second' then 'failed'
    when p_now < v_o.window_start then 'not_open'
    else 'open' end;

  return jsonb_build_object(
    'state', v_state,
    'server_now', p_now,
    'day', v_o.day,
    'scenario', v_o.is_scenario,
    'test', v_o.is_test,
    'window_start', v_o.window_start,
    'window_end', v_o.window_end,
    'object', (select label from public.daily_objects where id = v_o.object_id),
    'proof_at', (select min(received_at) from public.wake_proofs where obligation_id = v_o.id and accepted));
end $$;

create function public.get_wake_status()
returns jsonb language sql security definer set search_path = '' as $$
  select private.wake_status((select auth.uid()), now())
$$;

revoke execute on function private.wake_status(uuid, timestamptz) from public, anon, authenticated;
revoke execute on function public.get_wake_status() from public, anon;
grant execute on function public.get_wake_status() to authenticated;
