-- Lot 6 : notifications Web Push (VAPID).
-- Les secrets sont générés côté serveur et rangés dans Vault : jamais dans le
-- dépôt, jamais affichés. Les clés VAPID sont créées par send-push à son
-- premier appel (private.push_init).

select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'nr_internal_secret',
  'Secret partagé : pg_net -> send-push');
select vault.create_secret('https://tixiaahenxcykhgzkmdu.supabase.co/functions/v1', 'nr_functions_url',
  'URL des Edge Functions');

create function private.secret(p_name text)
returns text language sql stable security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = p_name limit 1
$$;

-- Appel asynchrone de send-push (pg_net envoie après le commit).
create function private.post_push(p_body jsonb)
returns bigint language sql security definer set search_path = '' as $$
  select net.http_post(
    url := private.secret('nr_functions_url') || '/send-push',
    body := p_body,
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-internal-secret', private.secret('nr_internal_secret')),
    timeout_milliseconds := 10000)
$$;

create function private.push_init()
returns bigint language sql security definer set search_path = '' as $$
  select private.post_push(jsonb_build_object('action', 'init'))
$$;

-- Au plus une fois par (utilisateur, type, clé) grâce à notification_log.
create function private.queue_push(p_user uuid, p_kind text, p_ref text, p_body text, p_url text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_id bigint;
begin
  insert into public.notification_log (user_id, kind, ref_key) values (p_user, p_kind, p_ref)
  on conflict (user_id, kind, ref_key) do nothing
  returning id into v_id;
  if v_id is null then
    return false;
  end if;
  perform private.post_push(jsonb_build_object(
    'user_id', p_user, 'title', 'Nonrefundable', 'body', p_body, 'url', p_url, 'log_id', v_id));
  return true;
end $$;

-- Rappels dus (job nr-notify, chaque minute). Heures comparées en heure de Paris.
create function private.notify_due(p_now timestamptz default now())
returns int language plpgsql security definer set search_path = '' as $$
declare
  m record;
  o record;
  v_local timestamp;
  v_sent int := 0;
begin
  -- Seulement en temps réel : un test qui simule une autre heure n'envoie rien.
  if abs(extract(epoch from (p_now - now()))) > 120 then
    return 0;
  end if;

  -- 22:30 : demain n'est pas réglé.
  for m in
    select cm.user_id, c.timezone from public.challenge_members cm
    join public.challenges c on c.id = cm.challenge_id
  loop
    v_local := p_now at time zone m.timezone;
    if v_local::time >= time '22:30' and v_local::time < time '22:35'
       and not exists (select 1 from public.day_plans
                        where user_id = m.user_id and day = v_local::date + 1 and source = 'user') then
      if private.queue_push(m.user_id, 'plan_reminder', (v_local::date + 1)::text,
                            'Règle demain avant 23 h.', './#/demain') then
        v_sent := v_sent + 1;
      end if;
    end if;
  end loop;

  -- 30 min avant l'heure limite : photo pas encore faite.
  for o in
    select ob.id, ob.user_id, ob.window_end, c.timezone, d.label
      from public.obligations ob
      join public.challenges c on c.id = ob.challenge_id
      left join public.daily_objects d on d.id = ob.object_id
     where ob.kind = 'wake' and ob.status = 'pending' and not ob.is_free and not ob.is_scenario
       and p_now >= ob.window_end - interval '30 minutes'
       and p_now < ob.window_end - interval '25 minutes'
  loop
    if private.queue_push(o.user_id, 'wake_reminder', o.id::text,
         'Photo avant ' || to_char(o.window_end at time zone o.timezone, 'HH24:MI')
         || '. Objet : ' || coalesce(o.label, 'au choix') || '.', './#/photo') then
      v_sent := v_sent + 1;
    end if;
  end loop;

  return v_sent;
end $$;

-- ---------------------------------------------------------------------------
-- RPC
-- ---------------------------------------------------------------------------
create function public.edge_push_config()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('internal_secret', private.secret('nr_internal_secret'),
                            'vapid_keys', private.secret('nr_vapid_keys')::jsonb)
$$;

create function public.edge_store_vapid_keys(p_keys jsonb, p_public text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if private.secret('nr_vapid_keys') is null then
    perform vault.create_secret(p_keys::text, 'nr_vapid_keys', 'Clés VAPID (JWK), créées par send-push');
    perform vault.create_secret(p_public, 'nr_vapid_public', 'Clé publique VAPID (applicationServerKey)');
  end if;
  return private.secret('nr_vapid_keys')::jsonb;
end $$;

create function public.get_vapid_public_key()
returns text language sql stable security definer set search_path = '' as $$
  select private.secret('nr_vapid_public')
$$;

create function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null or (private.user_challenge(v_user)).id is null then
    raise exception 'Non autorisé.' using errcode = '42501';
  end if;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
  values (v_user, p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update
    set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, created_at = now();
end $$;

-- Bouton « Tester les notifications » : les deux messages, marqués (test).
create function public.queue_test_push()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_c public.challenges;
  v_time text;
  v_obj text;
begin
  v_c := private.user_challenge(v_user);
  if v_user is null or v_c.id is null then
    raise exception 'Non autorisé.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.push_subscriptions where user_id = v_user) then
    raise exception 'Aucun appareil abonné. Active d''abord les notifications.';
  end if;
  select to_char(ob.window_end at time zone v_c.timezone, 'HH24:MI'), d.label into v_time, v_obj
    from public.obligations ob left join public.daily_objects d on d.id = ob.object_id
   where ob.user_id = v_user and ob.kind = 'wake' and not ob.is_scenario
     and ob.day = private.local_date(now(), v_c.timezone);
  v_time := coalesce(v_time, to_char(v_c.default_wake, 'HH24:MI'));
  v_obj := coalesce(v_obj, (select label from public.daily_objects order by random() limit 1));

  perform private.queue_push(v_user, 'test', gen_random_uuid()::text, 'Règle demain avant 23 h. (test)', './#/demain');
  perform private.queue_push(v_user, 'test', gen_random_uuid()::text,
                             'Photo avant ' || v_time || '. Objet : ' || v_obj || '. (test)', './#/photo');
  return jsonb_build_object('queued', 2);
end $$;

-- ---------------------------------------------------------------------------
-- Droits
-- ---------------------------------------------------------------------------
revoke execute on function private.secret(text), private.post_push(jsonb), private.push_init(),
  private.queue_push(uuid, text, text, text, text), private.notify_due(timestamptz)
  from public, anon, authenticated;
revoke execute on function public.edge_push_config(), public.edge_store_vapid_keys(jsonb, text),
  public.get_vapid_public_key(), public.save_push_subscription(text, text, text), public.queue_test_push()
  from public, anon, authenticated;
grant execute on function public.edge_push_config(), public.edge_store_vapid_keys(jsonb, text) to service_role;
grant execute on function public.get_vapid_public_key(), public.save_push_subscription(text, text, text),
  public.queue_test_push() to authenticated;

-- ---------------------------------------------------------------------------
-- Cron
-- ---------------------------------------------------------------------------
select cron.schedule('nr-notify', '* * * * *', $$select private.notify_due()$$);
