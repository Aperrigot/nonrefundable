-- Nonrefundable, lot 1 : schéma, RLS, logique temporelle, tick.
-- Règle d'or : une seule horloge, now() de Postgres. Toute fonction de temps
-- reçoit p_now pour pouvoir être testée (22:59:59, minuit, changement d'heure).

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------
create type public.obligation_kind as enum ('wake', 'bed');
create type public.obligation_status as enum ('pending', 'done', 'failed', 'free');
create type public.plan_source as enum ('user', 'default');

-- ---------------------------------------------------------------------------
-- Tables privées (jamais exposées par l'API)
-- ---------------------------------------------------------------------------
create table private.allowed_emails (
  email text primary key check (email = lower(email))
);
insert into private.allowed_emails (email) values ('art.perrigot@gmail.com');

create table private.shortcut_tokens (
  user_id uuid primary key references auth.users (id) on delete cascade,
  token_hash bytea not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create table private.tick_state (
  id int primary key default 1 check (id = 1),
  last_tick_at timestamptz not null
);

-- ---------------------------------------------------------------------------
-- Tables publiques (lecture sous RLS)
-- ---------------------------------------------------------------------------
create table public.challenges (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id),
  name text not null default 'Nonrefundable',
  real_start_date date not null default '2026-11-06',
  fine_cents int not null default 1000 check (fine_cents > 0),
  currency text not null default 'EUR',
  timezone text not null default 'Europe/Paris',
  default_wake time not null default '10:00',
  default_bed time not null default '01:00',
  bed_window_end time not null default '06:00',
  lock_time time not null default '23:00',
  wake_window interval not null default '1 hour',
  created_at timestamptz not null default now()
);

create table public.challenge_members (
  challenge_id uuid not null references public.challenges (id),
  user_id uuid not null references auth.users (id),
  role text not null default 'participant' check (role in ('owner', 'participant')),
  joined_at timestamptz not null default now(),
  primary key (challenge_id, user_id)
);
create index on public.challenge_members (user_id);

create table public.deposits (
  id uuid primary key default gen_random_uuid(),
  challenge_id uuid not null references public.challenges (id),
  user_id uuid not null default auth.uid() references auth.users (id),
  amount_cents int not null check (amount_cents > 0),
  friend_name text not null check (length(friend_name) between 1 and 60),
  paid_on date not null,
  created_at timestamptz not null default now()
);
create index on public.deposits (user_id);

create table public.day_plans (
  challenge_id uuid not null references public.challenges (id),
  user_id uuid not null references auth.users (id),
  day date not null,
  wake_time time not null,
  wake_free boolean not null default false,
  bed_time time not null,
  bed_free boolean not null default false,
  source public.plan_source not null,
  updated_at timestamptz not null default now(),
  primary key (challenge_id, user_id, day)
);
create index on public.day_plans (user_id, day);

create table public.daily_objects (
  id smallint generated always as identity primary key,
  label text not null unique
);

create table public.obligations (
  id uuid primary key default gen_random_uuid(),
  challenge_id uuid not null references public.challenges (id),
  user_id uuid not null references auth.users (id),
  day date not null,
  kind public.obligation_kind not null,
  window_start timestamptz not null,
  window_end timestamptz not null,
  is_free boolean not null default false,
  is_test boolean not null,
  is_scenario boolean not null default false,
  object_id smallint references public.daily_objects (id),
  status public.obligation_status not null default 'pending',
  plan_source public.plan_source,
  created_at timestamptz not null default now(),
  check (window_end > window_start)
);
-- Une seule obligation réelle par jour et par type. Les scénarios de test sont à part.
create unique index obligations_one_per_day
  on public.obligations (challenge_id, user_id, day, kind) where not is_scenario;
create index on public.obligations (user_id, kind, window_end);
create index on public.obligations (status, kind, window_end) where status = 'pending';

create table public.fines (
  id uuid primary key default gen_random_uuid(),
  obligation_id uuid not null unique references public.obligations (id),
  challenge_id uuid not null references public.challenges (id),
  user_id uuid not null references auth.users (id),
  day date not null,
  kind public.obligation_kind not null,
  amount_cents int not null check (amount_cents > 0),
  is_test boolean not null,
  reason text not null,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index on public.fines (user_id, day);

create table public.wake_proofs (
  id uuid primary key default gen_random_uuid(),
  obligation_id uuid references public.obligations (id),
  user_id uuid not null references auth.users (id),
  received_at timestamptz not null,
  accepted boolean not null,
  refusal_reason text,
  storage_path text,
  storage_failed boolean not null default false,
  bytes int,
  created_at timestamptz not null default now()
);
create index on public.wake_proofs (user_id, received_at);

create table public.app_signals (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id),
  app text not null check (app in ('instagram', 'tiktok')),
  received_at timestamptz not null default now()
);
create index on public.app_signals (user_id, received_at);

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  last_ok_at timestamptz
);
create index on public.push_subscriptions (user_id);

create table public.notification_log (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id),
  kind text not null,
  ref_key text not null,
  sent_at timestamptz not null default now(),
  status text not null default 'queued',
  unique (user_id, kind, ref_key)
);

-- Point de branchement de l'e-mail mensuel à l'ami (lot futur).
create table public.monthly_reports (
  id uuid primary key default gen_random_uuid(),
  challenge_id uuid not null references public.challenges (id),
  user_id uuid not null references auth.users (id),
  month date not null check (extract(day from month) = 1),
  snapshot jsonb not null,
  created_at timestamptz not null default now(),
  emailed_at timestamptz,
  unique (challenge_id, user_id, month)
);

-- ---------------------------------------------------------------------------
-- Objets du jour (jamais une personne, jamais un miroir)
-- ---------------------------------------------------------------------------
insert into public.daily_objects (label) values
  ('une fourchette'), ('une cuillère'), ('un verre d''eau'), ('une tasse'),
  ('une brosse à dents'), ('un tube de dentifrice'), ('une clé'), ('une chaussette'),
  ('une chaussure'), ('un oreiller'), ('une serviette'), ('un savon'),
  ('un livre'), ('un stylo'), ('une feuille de papier'), ('une bouteille'),
  ('une pomme'), ('une banane'), ('un bol'), ('une assiette'),
  ('une casserole'), ('une poêle'), ('un interrupteur'), ('une prise électrique'),
  ('une poignée de porte'), ('un rideau'), ('une plante'), ('une télécommande'),
  ('un chargeur'), ('des écouteurs'), ('une montre'), ('des lunettes'),
  ('un portefeuille'), ('un sac'), ('une veste'), ('un parapluie'),
  ('l''intérieur du frigo'), ('un robinet'), ('une poubelle'), ('une lampe allumée'),
  ('le ciel par la fenêtre'), ('la porte d''entrée'), ('un torchon'), ('une boîte de céréales'),
  ('une éponge'), ('un coussin'), ('une bougie'), ('un carnet');

-- ---------------------------------------------------------------------------
-- Fonctions de temps
-- ---------------------------------------------------------------------------
-- Heure locale → instant absolu. Changement d'heure (règle Postgres) :
-- heure inexistante (mars) = décalage d'avant le saut ; heure ambiguë
-- (octobre) = décalage d'après, donc la seconde occurrence.
create function private.local_ts(p_day date, p_time time, p_tz text)
returns timestamptz language sql stable set search_path = '' as $$
  select (p_day + p_time) at time zone p_tz
$$;

create function private.local_date(p_ts timestamptz, p_tz text)
returns date language sql stable set search_path = '' as $$
  select (p_ts at time zone p_tz)::date
$$;

-- Verrouillage du jour J : J-1 à 23:00, heure locale.
create function private.lock_at(p_c public.challenges, p_day date)
returns timestamptz language sql stable set search_path = '' as $$
  select private.local_ts(p_day - 1, p_c.lock_time, p_c.timezone)
$$;

-- Coucher : une heure ≥ 12:00 est le soir du jour J, sinon après minuit (J+1).
create function private.bed_window(p_c public.challenges, p_day date, p_bed time,
  out w_start timestamptz, out w_end timestamptz)
language sql stable set search_path = '' as $$
  select private.local_ts(case when p_bed >= time '12:00' then p_day else p_day + 1 end, p_bed, p_c.timezone),
         private.local_ts(p_day + 1, p_c.bed_window_end, p_c.timezone)
$$;

-- Réveil : [limite - 1 h, limite], en temps absolu.
create function private.wake_window(p_c public.challenges, p_day date, p_wake time,
  out w_start timestamptz, out w_end timestamptz)
language sql stable set search_path = '' as $$
  select private.local_ts(p_day, p_wake, p_c.timezone) - p_c.wake_window,
         private.local_ts(p_day, p_wake, p_c.timezone)
$$;

-- Date de début D : réel à partir du coucher de D et du réveil de D+1.
create function private.is_test(p_c public.challenges, p_kind public.obligation_kind, p_day date)
returns boolean language sql stable set search_path = '' as $$
  select case when p_kind = 'wake' then p_day <= p_c.real_start_date
              else p_day < p_c.real_start_date end
$$;

create function private.check_plan_times(p_wake time, p_bed time)
returns void language plpgsql immutable set search_path = '' as $$
begin
  if p_wake < time '05:00' or p_wake > time '12:00'
     or extract(minute from p_wake)::int % 15 <> 0 or extract(second from p_wake) <> 0 then
    raise exception 'Réveil hors plage (05:00 à 12:00, par 15 min).';
  end if;
  if (p_bed > time '04:00' and p_bed < time '20:00')
     or extract(minute from p_bed)::int % 15 <> 0 or extract(second from p_bed) <> 0 then
    raise exception 'Coucher hors plage (20:00 à 04:00, par 15 min).';
  end if;
end $$;

create function private.user_challenge(p_user uuid)
returns public.challenges language sql stable security definer set search_path = '' as $$
  select c.* from public.challenges c
  join public.challenge_members m on m.challenge_id = c.id
  where m.user_id = p_user
  order by m.joined_at
  limit 1
$$;

-- ---------------------------------------------------------------------------
-- Obligations
-- ---------------------------------------------------------------------------
create function private.pick_object(p_user uuid, p_day date)
returns smallint language sql volatile set search_path = '' as $$
  select coalesce(
    (select o.id from public.daily_objects o
      where o.id not in (select ob.object_id from public.obligations ob
                          where ob.user_id = p_user and ob.kind = 'wake'
                            and ob.object_id is not null
                            and ob.day between p_day - 10 and p_day)
      order by random() limit 1),
    (select o.id from public.daily_objects o order by random() limit 1))
$$;

-- Fige les obligations du jour J une fois le verrouillage passé. Idempotente :
-- appelée par le tick et par chaque fonction qui en a besoin.
create function private.ensure_obligations(p_user uuid, p_day date, p_now timestamptz)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_c public.challenges;
  v_plan public.day_plans;
  v_w record;
  v_b record;
begin
  v_c := private.user_challenge(p_user);
  if v_c.id is null
     or p_now < private.lock_at(v_c, p_day)
     or p_day < private.local_date(v_c.created_at, v_c.timezone) then
    return;
  end if;
  if exists (select 1 from public.obligations
              where challenge_id = v_c.id and user_id = p_user and day = p_day and not is_scenario) then
    return;
  end if;

  insert into public.day_plans (challenge_id, user_id, day, wake_time, wake_free, bed_time, bed_free, source, updated_at)
  values (v_c.id, p_user, p_day, v_c.default_wake, false, v_c.default_bed, false, 'default', p_now)
  on conflict do nothing;

  select * into v_plan from public.day_plans
   where challenge_id = v_c.id and user_id = p_user and day = p_day;
  select * into v_w from private.wake_window(v_c, p_day, v_plan.wake_time);
  select * into v_b from private.bed_window(v_c, p_day, v_plan.bed_time);

  insert into public.obligations
    (challenge_id, user_id, day, kind, window_start, window_end, is_free, is_test, object_id, status, plan_source, created_at)
  values
    (v_c.id, p_user, p_day, 'wake', v_w.w_start, v_w.w_end, v_plan.wake_free,
     private.is_test(v_c, 'wake', p_day), private.pick_object(p_user, p_day),
     case when v_plan.wake_free then 'free' else 'pending' end::public.obligation_status, v_plan.source, p_now),
    (v_c.id, p_user, p_day, 'bed', v_b.w_start, v_b.w_end, v_plan.bed_free,
     private.is_test(v_c, 'bed', p_day), null,
     case when v_plan.bed_free then 'free' else 'pending' end::public.obligation_status, v_plan.source, p_now)
  on conflict (challenge_id, user_id, day, kind) where not is_scenario do nothing;
end $$;

-- Au plus une amende par obligation : garanti par fines.obligation_id unique.
create function private.add_fine(p_o public.obligations, p_reason text, p_at timestamptz)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  insert into public.fines (obligation_id, challenge_id, user_id, day, kind, amount_cents, is_test, reason, occurred_at)
  select p_o.id, p_o.challenge_id, p_o.user_id, p_o.day, p_o.kind, c.fine_cents, p_o.is_test, p_reason, p_at
    from public.challenges c where c.id = p_o.challenge_id
  on conflict (obligation_id) do nothing
  returning id into v_id;
  update public.obligations set status = 'failed' where id = p_o.id and status = 'pending';
  return v_id is not null;
end $$;

-- ---------------------------------------------------------------------------
-- Règles métier
-- ---------------------------------------------------------------------------
create function private.set_day_plan(p_user uuid, p_wake time, p_wake_free boolean,
  p_bed time, p_bed_free boolean, p_now timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_c public.challenges;
  v_day date;
  v_lock timestamptz;
begin
  v_c := private.user_challenge(p_user);
  if v_c.id is null then
    raise exception 'Aucun défi.';
  end if;
  v_day := private.local_date(p_now, v_c.timezone) + 1;
  v_lock := private.lock_at(v_c, v_day);
  if p_now >= v_lock then
    raise exception 'Verrouillé depuis 23:00.';
  end if;
  p_wake := coalesce(p_wake, v_c.default_wake);
  p_bed := coalesce(p_bed, v_c.default_bed);
  perform private.check_plan_times(p_wake, p_bed);

  insert into public.day_plans (challenge_id, user_id, day, wake_time, wake_free, bed_time, bed_free, source, updated_at)
  values (v_c.id, p_user, v_day, p_wake, coalesce(p_wake_free, false), p_bed, coalesce(p_bed_free, false), 'user', p_now)
  on conflict (challenge_id, user_id, day) do update
    set wake_time = excluded.wake_time, wake_free = excluded.wake_free,
        bed_time = excluded.bed_time, bed_free = excluded.bed_free,
        source = 'user', updated_at = excluded.updated_at;

  return jsonb_build_object('day', v_day, 'lock_at', v_lock, 'server_now', p_now);
end $$;

create function private.record_app_signal(p_user uuid, p_app text, p_now timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_c public.challenges;
  v_d date;
  v_o public.obligations;
  v_sig bigint;
  v_label text;
  v_fined int := 0;
begin
  if p_app is null or p_app not in ('instagram', 'tiktok') then
    raise exception 'App non suivie.';
  end if;
  v_c := private.user_challenge(p_user);
  if v_c.id is null then
    raise exception 'Aucun défi.';
  end if;

  insert into public.app_signals (user_id, app, received_at) values (p_user, p_app, p_now)
  returning id into v_sig;

  -- La nuit en cours peut appartenir au jour J (avant minuit) ou J-1 (après minuit).
  v_d := private.local_date(p_now, v_c.timezone);
  perform private.ensure_obligations(p_user, v_d - 1, p_now);
  perform private.ensure_obligations(p_user, v_d, p_now);

  v_label := case p_app when 'instagram' then 'Instagram' else 'TikTok' end;
  for v_o in
    select * from public.obligations
     where user_id = p_user and kind = 'bed' and not is_free
       and window_start <= p_now and p_now < window_end
  loop
    if private.add_fine(v_o, v_label || ' ouvert à ' || to_char(p_now at time zone v_c.timezone, 'HH24:MI'), p_now) then
      v_fined := v_fined + 1;
    end if;
  end loop;

  return jsonb_build_object('signal_id', v_sig, 'fines_created', v_fined);
end $$;

-- Horodatage d'une photo, après réception complète par l'Edge Function.
-- Acceptée si window_start <= reçue et reçue (tronquée à la seconde) <= limite.
create function private.stamp_wake_proof(p_user uuid, p_bytes int, p_now timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_c public.challenges;
  v_d date;
  v_o public.obligations;
  v_id uuid := gen_random_uuid();
  v_path text;
  v_reason text;
  v_sec timestamptz := date_trunc('second', p_now);
begin
  v_c := private.user_challenge(p_user);
  if v_c.id is null then
    raise exception 'Aucun défi.';
  end if;
  v_d := private.local_date(p_now, v_c.timezone);
  perform private.ensure_obligations(p_user, v_d, p_now);

  select * into v_o from public.obligations
   where user_id = p_user and kind = 'wake' and not is_free and status in ('pending', 'done')
     and window_start <= p_now and v_sec <= window_end
   order by (status = 'pending') desc, window_end
   limit 1;

  if found then
    v_path := p_user::text || '/' || v_o.day::text || '/' || v_id::text || '.jpg';
    insert into public.wake_proofs (id, obligation_id, user_id, received_at, accepted, storage_path, bytes)
    values (v_id, v_o.id, p_user, p_now, true, v_path, p_bytes);
    update public.obligations set status = 'done' where id = v_o.id and status = 'pending';
    return jsonb_build_object('accepted', true, 'proof_id', v_id, 'storage_path', v_path,
                              'received_at', p_now, 'deadline', v_o.window_end);
  end if;

  -- Refus : on explique par rapport à la fenêtre la plus proche.
  select * into v_o from public.obligations
   where user_id = p_user and kind = 'wake'
     and (day = v_d or (is_scenario and created_at > p_now - interval '1 hour'))
   order by greatest(window_start - p_now, p_now - window_end)
   limit 1;

  if not found then
    v_reason := 'Aucun réveil prévu aujourd''hui.';
  elsif v_o.is_free then
    v_reason := 'Réveil libre aujourd''hui.';
  elsif p_now < v_o.window_start then
    v_reason := 'Trop tôt. Fenêtre ouverte à ' || to_char(v_o.window_start at time zone v_c.timezone, 'HH24:MI') || '.';
  else
    v_reason := 'Trop tard. Fenêtre fermée à ' || to_char(v_o.window_end at time zone v_c.timezone, 'HH24:MI')
             || '. Reçue à ' || to_char(p_now at time zone v_c.timezone, 'HH24:MI:SS') || '.';
  end if;

  insert into public.wake_proofs (id, obligation_id, user_id, received_at, accepted, refusal_reason, bytes)
  values (v_id, v_o.id, p_user, p_now, false, v_reason, p_bytes);
  return jsonb_build_object('accepted', false, 'proof_id', v_id, 'reason', v_reason, 'received_at', p_now);
end $$;

-- Scénarios de test : obligations TEST qui commencent maintenant, sans toucher au réel.
create function private.start_scenario(p_user uuid, p_kind public.obligation_kind, p_now timestamptz)
returns public.obligations language plpgsql security definer set search_path = '' as $$
declare
  v_c public.challenges;
  v_o public.obligations;
  v_deadline timestamptz;
begin
  v_c := private.user_challenge(p_user);
  if v_c.id is null then
    raise exception 'Aucun défi.';
  end if;
  select * into v_o from public.obligations
   where user_id = p_user and is_scenario and kind = p_kind and status = 'pending' and window_end > p_now
   limit 1;
  if found then
    return v_o;
  end if;

  if p_kind = 'bed' then
    insert into public.obligations
      (challenge_id, user_id, day, kind, window_start, window_end, is_test, is_scenario, status, created_at)
    values (v_c.id, p_user, private.local_date(p_now, v_c.timezone), 'bed',
            p_now, p_now + interval '10 minutes', true, true, 'pending', p_now)
    returning * into v_o;
  else
    -- Fenêtre de 10 min qui s'ouvre dans 1 à 2 min : permet de tester un refus puis une acceptation.
    v_deadline := date_trunc('minute', p_now) + interval '12 minutes';
    insert into public.obligations
      (challenge_id, user_id, day, kind, window_start, window_end, is_test, is_scenario, object_id, status, created_at)
    values (v_c.id, p_user, private.local_date(p_now, v_c.timezone), 'wake',
            v_deadline - interval '10 minutes', v_deadline, true, true,
            private.pick_object(p_user, private.local_date(p_now, v_c.timezone)), 'pending', p_now)
    returning * into v_o;
  end if;
  return v_o;
end $$;

-- ---------------------------------------------------------------------------
-- Tick (pg_cron, chaque minute). cron est en UTC : il ne sert que de métronome.
-- ---------------------------------------------------------------------------
create function private.tick(p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  m record;
  i int;
  v_o public.obligations;
  v_tz text;
  v_failed int := 0;
  v_done int := 0;
begin
  if not pg_try_advisory_xact_lock(hashtext('nonrefundable.tick')) then
    return jsonb_build_object('skipped', true);
  end if;

  -- Figer demain (dès 23:00) et rattraper les jours manqués.
  for m in
    select cm.user_id, c.timezone from public.challenge_members cm
    join public.challenges c on c.id = cm.challenge_id
  loop
    for i in -2..1 loop
      perform private.ensure_obligations(m.user_id, private.local_date(p_now, m.timezone) + i, p_now);
    end loop;
  end loop;

  -- Réveil manqué : 3 min de grâce pour une requête partie avant l'heure limite.
  for v_o in
    select * from public.obligations
     where kind = 'wake' and status = 'pending' and window_end < p_now - interval '3 minutes'
     for update skip locked
  loop
    select timezone into v_tz from public.challenges where id = v_o.challenge_id;
    perform private.add_fine(v_o, 'Pas de photo avant ' || to_char(v_o.window_end at time zone v_tz, 'HH24:MI'), v_o.window_end);
    v_failed := v_failed + 1;
  end loop;

  -- Nuit terminée sans signal.
  update public.obligations set status = 'done'
   where kind = 'bed' and status = 'pending' and window_end <= p_now;
  get diagnostics v_done = row_count;

  insert into private.tick_state (id, last_tick_at) values (1, p_now)
  on conflict (id) do update set last_tick_at = excluded.last_tick_at;

  return jsonb_build_object('wake_failed', v_failed, 'bed_done', v_done);
end $$;

-- ---------------------------------------------------------------------------
-- Ajout seul : amendes et signaux ne se modifient ni ne se suppriment.
-- ---------------------------------------------------------------------------
create function private.forbid_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'Table en ajout seul : %', tg_table_name;
end $$;

create trigger fines_append_only before update or delete on public.fines
  for each row execute function private.forbid_change();
create trigger fines_no_truncate before truncate on public.fines
  for each statement execute function private.forbid_change();
create trigger app_signals_append_only before update or delete on public.app_signals
  for each row execute function private.forbid_change();
create trigger app_signals_no_truncate before truncate on public.app_signals
  for each statement execute function private.forbid_change();

-- ---------------------------------------------------------------------------
-- Comptes : liste blanche + création automatique du défi
-- ---------------------------------------------------------------------------
create function private.bootstrap_member(p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  if exists (select 1 from public.challenge_members where user_id = p_user) then
    return;
  end if;
  insert into public.challenges (owner_id) values (p_user) returning id into v_id;
  insert into public.challenge_members (challenge_id, user_id, role) values (v_id, p_user, 'owner');
end $$;

create function private.guard_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from private.allowed_emails where email = lower(new.email)) then
    raise exception 'Inscriptions fermées.' using errcode = '42501';
  end if;
  return new;
end $$;

create function private.on_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.bootstrap_member(new.id);
  return new;
end $$;

grant usage on schema private to supabase_auth_admin;
grant execute on function private.guard_new_user(), private.on_new_user() to supabase_auth_admin;

create trigger nonrefundable_guard_new_user before insert on auth.users
  for each row execute function private.guard_new_user();
create trigger nonrefundable_on_new_user after insert on auth.users
  for each row execute function private.on_new_user();

-- Compte déjà créé depuis le dashboard avant cette migration.
select private.bootstrap_member(u.id)
  from auth.users u
 where lower(u.email) in (select email from private.allowed_emails);

-- ---------------------------------------------------------------------------
-- RPC exposées
-- ---------------------------------------------------------------------------
create function public.set_tomorrow(p_wake_time time, p_wake_free boolean, p_bed_time time, p_bed_free boolean)
returns jsonb language sql security definer set search_path = '' as $$
  select private.set_day_plan((select auth.uid()), p_wake_time, p_wake_free, p_bed_time, p_bed_free, now())
$$;

create function public.start_scenario(p_kind text)
returns jsonb language sql security definer set search_path = '' as $$
  select to_jsonb(private.start_scenario((select auth.uid()), p_kind::public.obligation_kind, now()))
$$;

-- Jeton Raccourcis : renvoyé en clair une seule fois, seul le hash est stocké.
create function public.regenerate_shortcut_token()
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_token text;
begin
  if v_user is null or (private.user_challenge(v_user)).id is null then
    raise exception 'Non autorisé.' using errcode = '42501';
  end if;
  v_token := 'nr_' || encode(extensions.gen_random_bytes(32), 'hex');
  insert into private.shortcut_tokens (user_id, token_hash, created_at, last_used_at)
  values (v_user, extensions.digest(v_token, 'sha256'), now(), null)
  on conflict (user_id) do update
    set token_hash = excluded.token_hash, created_at = excluded.created_at, last_used_at = null;
  return v_token;
end $$;

-- Réservées aux Edge Functions (rôle service_role).
create function public.edge_app_signal(p_token text, p_app text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
begin
  update private.shortcut_tokens set last_used_at = now()
   where token_hash = extensions.digest(coalesce(p_token, ''), 'sha256')
  returning user_id into v_user;
  if v_user is null then
    return jsonb_build_object('ok', false, 'error', 'token');
  end if;
  return jsonb_build_object('ok', true) || private.record_app_signal(v_user, lower(p_app), now());
end $$;

create function public.edge_stamp_wake_proof(p_user uuid, p_bytes int)
returns jsonb language sql security definer set search_path = '' as $$
  select private.stamp_wake_proof(p_user, p_bytes, now())
$$;

create function public.edge_proof_storage_failed(p_proof uuid)
returns void language sql security definer set search_path = '' as $$
  update public.wake_proofs set storage_failed = true, storage_path = null where id = p_proof
$$;

-- ---------------------------------------------------------------------------
-- Droits : rien pour anon, lecture seule pour authenticated sauf exceptions.
-- ---------------------------------------------------------------------------
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke execute on functions from public, anon, authenticated;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;

grant select on public.challenges, public.challenge_members, public.deposits, public.day_plans,
  public.daily_objects, public.obligations, public.fines, public.wake_proofs, public.app_signals,
  public.push_subscriptions, public.notification_log, public.monthly_reports to authenticated;
grant insert, update on public.deposits to authenticated;
grant insert, delete on public.push_subscriptions to authenticated;

grant execute on function public.set_tomorrow(time, boolean, time, boolean),
  public.start_scenario(text), public.regenerate_shortcut_token() to authenticated;
grant execute on function public.edge_app_signal(text, text), public.edge_stamp_wake_proof(uuid, int),
  public.edge_proof_storage_failed(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.challenges enable row level security;
alter table public.challenge_members enable row level security;
alter table public.deposits enable row level security;
alter table public.day_plans enable row level security;
alter table public.daily_objects enable row level security;
alter table public.obligations enable row level security;
alter table public.fines enable row level security;
alter table public.wake_proofs enable row level security;
alter table public.app_signals enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.notification_log enable row level security;
alter table public.monthly_reports enable row level security;
alter table private.shortcut_tokens enable row level security;
alter table private.allowed_emails enable row level security;
alter table private.tick_state enable row level security;

create policy "lecture : mes défis" on public.challenges for select to authenticated
  using (id in (select challenge_id from public.challenge_members where user_id = (select auth.uid())));
create policy "lecture : mes adhésions" on public.challenge_members for select to authenticated
  using (user_id = (select auth.uid()));
create policy "lecture : objets" on public.daily_objects for select to authenticated
  using (true);

create policy "lecture : mes cautions" on public.deposits for select to authenticated
  using (user_id = (select auth.uid()));
create policy "ajout : mes cautions" on public.deposits for insert to authenticated
  with check (user_id = (select auth.uid())
              and challenge_id in (select challenge_id from public.challenge_members where user_id = (select auth.uid())));
create policy "modif : mes cautions" on public.deposits for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid())
              and challenge_id in (select challenge_id from public.challenge_members where user_id = (select auth.uid())));

create policy "lecture : mes réglages" on public.day_plans for select to authenticated
  using (user_id = (select auth.uid()));
create policy "lecture : mes obligations" on public.obligations for select to authenticated
  using (user_id = (select auth.uid()));
create policy "lecture : mes amendes" on public.fines for select to authenticated
  using (user_id = (select auth.uid()));
create policy "lecture : mes preuves" on public.wake_proofs for select to authenticated
  using (user_id = (select auth.uid()));
create policy "lecture : mes signaux" on public.app_signals for select to authenticated
  using (user_id = (select auth.uid()));
create policy "lecture : mes notifications" on public.notification_log for select to authenticated
  using (user_id = (select auth.uid()));
create policy "lecture : mes récaps" on public.monthly_reports for select to authenticated
  using (user_id = (select auth.uid()));

create policy "lecture : mes abonnements" on public.push_subscriptions for select to authenticated
  using (user_id = (select auth.uid()));
create policy "ajout : mes abonnements" on public.push_subscriptions for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "suppression : mes abonnements" on public.push_subscriptions for delete to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Storage : bucket privé, écriture par submit-proof uniquement.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('proofs', 'proofs', false, 153600, array['image/jpeg']);

create policy "lecture : mes photos" on storage.objects for select to authenticated
  using (bucket_id = 'proofs' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- ---------------------------------------------------------------------------
-- Cron
-- ---------------------------------------------------------------------------
select cron.schedule('nr-tick', '* * * * *', $$select private.tick()$$);
select cron.schedule('nr-cleanup', '17 3 * * *',
  $$delete from cron.job_run_details where end_time < now() - interval '7 days'$$);
