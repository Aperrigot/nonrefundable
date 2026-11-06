-- Lot 7 : grand livre, récap du mois, caution, date de début, clôture mensuelle.

-- Récap d'un mois (mois = celui du jour J de l'obligation).
create function private.month_recap(p_user uuid, p_month date, p_now timestamptz)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_c public.challenges;
  v_start date := date_trunc('month', p_month)::date;
  v_end date := (date_trunc('month', p_month) + interval '1 month')::date; -- exclu
  v_today date;
  v_from date;
  v_to date;
begin
  v_c := private.user_challenge(p_user);
  if v_c.id is null then
    raise exception 'Non autorisé.' using errcode = '42501';
  end if;
  v_today := private.local_date(p_now, v_c.timezone);
  v_from := greatest(v_start, private.local_date(v_c.created_at, v_c.timezone));
  v_to := least(v_end - 1, v_today - 1); -- jours complets seulement

  return jsonb_build_object(
    'month', v_start,
    'fines', coalesce((select jsonb_agg(jsonb_build_object(
                'day', f.day, 'kind', f.kind, 'amount_cents', f.amount_cents, 'is_test', f.is_test,
                'reason', f.reason, 'occurred_at', f.occurred_at) order by f.occurred_at)
              from public.fines f where f.user_id = p_user and f.day >= v_start and f.day < v_end), '[]'::jsonb),
    'due_cents', (select coalesce(sum(amount_cents), 0) from public.fines
                   where user_id = p_user and not is_test and day >= v_start and day < v_end),
    'test_cents', (select coalesce(sum(amount_cents), 0) from public.fines
                    where user_id = p_user and is_test and day >= v_start and day < v_end),
    'deposit_cents', (select coalesce(sum(amount_cents), 0) from public.deposits where user_id = p_user),
    'friend_name', (select friend_name from public.deposits where user_id = p_user order by paid_on desc, created_at desc limit 1),
    'paid_on', (select paid_on from public.deposits where user_id = p_user order by paid_on desc, created_at desc limit 1),
    'remaining_cents', (select coalesce(sum(amount_cents), 0) from public.deposits where user_id = p_user)
                     - (select coalesce(sum(amount_cents), 0) from public.fines
                         where user_id = p_user and not is_test and day < v_end),
    'free_count', (select count(*) from public.obligations
                    where user_id = p_user and not is_scenario and is_free and day >= v_start and day < v_end),
    'silent_days', case when v_to < v_from then 0 else
      (select count(*) from generate_series(v_from, v_to, interval '1 day') g(d)
        where not exists (select 1 from public.app_signals s
                           where s.user_id = p_user
                             and private.local_date(s.received_at, v_c.timezone) = g.d::date)) end);
end $$;

create function public.get_month_recap(p_month date)
returns jsonb language sql security definer set search_path = '' as $$
  select private.month_recap((select auth.uid()), p_month, now())
$$;

-- Réglages : caution (une seule ligne, modifiable) et date de début.
create function public.get_settings()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'deposit', (select jsonb_build_object('amount_cents', amount_cents, 'friend_name', friend_name, 'paid_on', paid_on)
                  from public.deposits where user_id = (select auth.uid()) order by paid_on desc, created_at desc limit 1),
    'real_start_date', c.real_start_date,
    'start_editable', private.local_date(now(), c.timezone) < c.real_start_date,
    'push_devices', (select count(*) from public.push_subscriptions where user_id = (select auth.uid())))
  from public.challenges c where c.id = (private.user_challenge((select auth.uid()))).id
$$;

create function public.set_deposit(p_amount_cents int, p_friend_name text, p_paid_on date)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_c public.challenges;
  v_id uuid;
begin
  v_c := private.user_challenge(v_user);
  if v_user is null or v_c.id is null then
    raise exception 'Non autorisé.' using errcode = '42501';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 then raise exception 'Montant invalide.'; end if;
  if coalesce(trim(p_friend_name), '') = '' then raise exception 'Prénom manquant.'; end if;
  if p_paid_on is null then raise exception 'Date manquante.'; end if;

  select id into v_id from public.deposits where user_id = v_user order by paid_on desc, created_at desc limit 1;
  if v_id is null then
    insert into public.deposits (challenge_id, user_id, amount_cents, friend_name, paid_on)
    values (v_c.id, v_user, p_amount_cents, trim(p_friend_name), p_paid_on);
  else
    update public.deposits set amount_cents = p_amount_cents, friend_name = trim(p_friend_name), paid_on = p_paid_on
     where id = v_id;
  end if;
end $$;

-- Modifiable seulement tant que la date actuelle est dans le futur, et vers une date future.
create function public.set_start_date(p_date date)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_c public.challenges;
  v_today date;
begin
  v_c := private.user_challenge(auth.uid());
  if v_c.id is null or v_c.owner_id <> auth.uid() then
    raise exception 'Non autorisé.' using errcode = '42501';
  end if;
  v_today := private.local_date(now(), v_c.timezone);
  if v_today >= v_c.real_start_date then
    raise exception 'Date de début passée : verrouillée.';
  end if;
  if p_date is null or p_date <= v_today then
    raise exception 'La date de début doit être dans le futur.';
  end if;
  update public.challenges set real_start_date = p_date where id = v_c.id;
end $$;

-- Clôture mensuelle : point de branchement de l'e-mail à l'ami (lot futur :
-- une Edge Function lira les lignes emailed_at IS NULL).
create function private.close_month(p_now timestamptz default now())
returns int language plpgsql security definer set search_path = '' as $$
declare
  m record;
  v_prev date;
  v_n int := 0;
begin
  for m in
    select cm.user_id, c.id as challenge_id, c.timezone from public.challenge_members cm
    join public.challenges c on c.id = cm.challenge_id
  loop
    v_prev := (date_trunc('month', private.local_date(p_now, m.timezone)) - interval '1 month')::date;
    insert into public.monthly_reports (challenge_id, user_id, month, snapshot)
    values (m.challenge_id, m.user_id, v_prev, private.month_recap(m.user_id, v_prev, p_now))
    on conflict (challenge_id, user_id, month) do nothing;
    if found then v_n := v_n + 1; end if;
  end loop;
  return v_n;
end $$;

revoke execute on function private.month_recap(uuid, date, timestamptz), private.close_month(timestamptz)
  from public, anon, authenticated;
revoke execute on function public.get_month_recap(date), public.get_settings(), public.set_deposit(int, text, date),
  public.set_start_date(date) from public, anon;
grant execute on function public.get_month_recap(date), public.get_settings(), public.set_deposit(int, text, date),
  public.set_start_date(date) to authenticated;

-- Le 1er du mois à 07:05 UTC (08:05 ou 09:05 à Paris).
select cron.schedule('nr-close-month', '5 7 1 * *', $$select private.close_month()$$);
