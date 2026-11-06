-- Tests du lot 1. Tout s'exécute dans un seul bloc qui se termine par une
-- exception volontaire : rien n'est conservé en base.
-- Succès : l'erreur « NR_TESTS_OK passed=N ». Échec : l'erreur « FAIL … ».
do $$
declare
  tz constant text := 'Europe/Paris';
  u1 uuid := gen_random_uuid();
  u2 uuid := gen_random_uuid();
  c public.challenges;
  o public.obligations;
  r jsonb;
  n int;
  ok boolean;
  t timestamptz;
  v_token text;
  v_old_token text;
  passed int := 0;
begin
  -- Comptes de test (liste blanche temporaire)
  insert into private.allowed_emails values ('test1@nr.invalid'), ('test2@nr.invalid');
  insert into auth.users (id, email) values (u1, 'test1@nr.invalid'), (u2, 'test2@nr.invalid');
  c := private.user_challenge(u1);
  if c.id is null or (private.user_challenge(u2)).id is null then raise exception 'FAIL bootstrap défi'; end if;
  passed := passed + 1;

  -- Inscription hors liste blanche refusée
  begin
    insert into auth.users (id, email) values (gen_random_uuid(), 'intrus@example.com');
    ok := false;
  exception when others then ok := sqlerrm like 'Inscriptions fermées%';
  end;
  if not ok then raise exception 'FAIL liste blanche'; end if;
  passed := passed + 1;

  -- Objets du jour
  select count(*) into n from public.daily_objects;
  if n < 40 then raise exception 'FAIL objets: %', n; end if;
  passed := passed + 1;

  -- Mode test : réveil du 6 = TEST, coucher du 6 = réel
  if not private.is_test(c, 'wake', '2026-11-06') then raise exception 'FAIL is_test réveil 6'; end if;
  if private.is_test(c, 'bed', '2026-11-06') then raise exception 'FAIL is_test coucher 6'; end if;
  if not private.is_test(c, 'bed', '2026-11-05') then raise exception 'FAIL is_test coucher 5'; end if;
  if private.is_test(c, 'wake', '2026-11-07') then raise exception 'FAIL is_test réveil 7'; end if;
  passed := passed + 1;

  -- Verrouillage : 22:59:59 accepté, 23:00:00 refusé
  r := private.set_day_plan(u1, '07:00', false, '23:30', false, private.local_ts('2026-11-10', '22:59:59', tz));
  if r->>'day' <> '2026-11-11' then raise exception 'FAIL jour réglé: %', r; end if;
  begin
    perform private.set_day_plan(u1, '08:00', false, '23:30', false, private.local_ts('2026-11-10', '23:00:00', tz));
    ok := false;
  exception when others then ok := sqlerrm like 'Verrouillé%';
  end;
  if not ok then raise exception 'FAIL verrou 23:00'; end if;
  if (select wake_time from public.day_plans where user_id = u1 and day = '2026-11-11') <> '07:00' then
    raise exception 'FAIL réglage modifié après verrou';
  end if;
  passed := passed + 1;

  -- Après minuit, « demain » change : le 11/11 à 00:10, on règle le 12
  r := private.set_day_plan(u1, null, true, null, false, private.local_ts('2026-11-11', '00:10', tz));
  if r->>'day' <> '2026-11-12' then raise exception 'FAIL demain après minuit: %', r; end if;
  -- remis par défaut pour la suite (réveil 10:00 non libre)
  perform private.set_day_plan(u1, '10:00', false, '01:00', false, private.local_ts('2026-11-11', '00:11', tz));
  passed := passed + 1;

  -- Plages horaires
  begin perform private.set_day_plan(u1, '13:00', false, '23:00', false, private.local_ts('2026-11-15', '12:00', tz)); ok := false;
  exception when others then ok := sqlerrm like 'Réveil hors plage%'; end;
  if not ok then raise exception 'FAIL plage réveil 13:00'; end if;
  begin perform private.set_day_plan(u1, '07:10', false, '23:00', false, private.local_ts('2026-11-15', '12:00', tz)); ok := false;
  exception when others then ok := sqlerrm like 'Réveil hors plage%'; end;
  if not ok then raise exception 'FAIL pas de 15 min'; end if;
  begin perform private.set_day_plan(u1, '07:00', false, '12:00', false, private.local_ts('2026-11-15', '12:00', tz)); ok := false;
  exception when others then ok := sqlerrm like 'Coucher hors plage%'; end;
  if not ok then raise exception 'FAIL plage coucher 12:00'; end if;
  passed := passed + 1;

  -- Figer : rien avant 23:00, tout à 23:00
  perform private.ensure_obligations(u1, '2026-11-11', private.local_ts('2026-11-10', '22:59:59', tz));
  if exists (select 1 from public.obligations where user_id = u1 and day = '2026-11-11') then raise exception 'FAIL figé trop tôt'; end if;
  perform private.ensure_obligations(u1, '2026-11-11', private.local_ts('2026-11-10', '23:00:00', tz));
  select * into o from public.obligations where user_id = u1 and day = '2026-11-11' and kind = 'wake';
  if o.window_start <> '2026-11-11 05:00+00' or o.window_end <> '2026-11-11 06:00+00' or o.is_test or o.object_id is null then
    raise exception 'FAIL fenêtre réveil 07:00: % → %', o.window_start, o.window_end;
  end if;
  select * into o from public.obligations where user_id = u1 and day = '2026-11-11' and kind = 'bed';
  if o.window_start <> '2026-11-11 22:30+00' or o.window_end <> '2026-11-12 05:00+00' then
    raise exception 'FAIL fenêtre coucher 23:30: % → %', o.window_start, o.window_end;
  end if;
  passed := passed + 1;

  -- Coucher après minuit (01:00, nuit du 12) : 13/11 01:00 → 06:00
  perform private.ensure_obligations(u1, '2026-11-12', private.local_ts('2026-11-11', '23:00', tz));
  select * into o from public.obligations where user_id = u1 and day = '2026-11-12' and kind = 'bed';
  if o.window_start <> '2026-11-13 00:00+00' or o.window_end <> '2026-11-13 05:00+00' then
    raise exception 'FAIL fenêtre coucher 01:00: % → %', o.window_start, o.window_end;
  end if;
  passed := passed + 1;

  -- Valeurs par défaut si rien réglé (jour 13)
  perform private.ensure_obligations(u1, '2026-11-13', private.local_ts('2026-11-12', '23:00', tz));
  if (select source from public.day_plans where user_id = u1 and day = '2026-11-13') <> 'default' then raise exception 'FAIL source défaut'; end if;
  select * into o from public.obligations where user_id = u1 and day = '2026-11-13' and kind = 'wake';
  if o.window_end <> '2026-11-13 09:00+00' then raise exception 'FAIL défaut réveil 10:00: %', o.window_end; end if;
  passed := passed + 1;

  -- Signal à 00:30 rattaché à la nuit du 11 ; double ouverture = 1 amende
  r := private.record_app_signal(u1, 'instagram', private.local_ts('2026-11-12', '00:30', tz));
  if (r->>'fines_created')::int <> 1 then raise exception 'FAIL amende 00:30: %', r; end if;
  if (select reason from public.fines f join public.obligations ob on ob.id = f.obligation_id
       where f.user_id = u1 and ob.day = '2026-11-11' and ob.kind = 'bed') <> 'Instagram ouvert à 00:30' then
    raise exception 'FAIL motif 00:30';
  end if;
  r := private.record_app_signal(u1, 'tiktok', private.local_ts('2026-11-12', '00:45', tz));
  if (r->>'fines_created')::int <> 0 then raise exception 'FAIL double amende: %', r; end if;
  passed := passed + 1;

  -- Bornes de la nuit du 12 (01:00 → 06:00)
  r := private.record_app_signal(u1, 'instagram', private.local_ts('2026-11-13', '00:59:59', tz));
  if (r->>'fines_created')::int <> 0 then raise exception 'FAIL 00:59:59 compté'; end if;
  r := private.record_app_signal(u1, 'tiktok', private.local_ts('2026-11-13', '01:00:00', tz));
  if (r->>'fines_created')::int <> 1 then raise exception 'FAIL 01:00:00 non compté'; end if;
  if not exists (select 1 from public.fines where user_id = u1 and reason = 'TikTok ouvert à 01:00') then raise exception 'FAIL motif TikTok'; end if;
  r := private.record_app_signal(u1, 'instagram', private.local_ts('2026-11-14', '06:00:00', tz));
  if (r->>'fines_created')::int <> 0 then raise exception 'FAIL 06:00:00 compté'; end if;
  passed := passed + 1;

  -- App non suivie (YouTube)
  begin perform private.record_app_signal(u1, 'youtube', now()); ok := false;
  exception when others then ok := sqlerrm like 'App non suivie%'; end;
  if not ok then raise exception 'FAIL youtube accepté'; end if;
  passed := passed + 1;

  -- Photo : trop tôt, puis 10:00:00,999 acceptée (jour 12)
  r := private.stamp_wake_proof(u1, 90000, private.local_ts('2026-11-12', '08:59:59', tz));
  if (r->>'accepted')::boolean or r->>'reason' <> 'Trop tôt. Fenêtre ouverte à 09:00.' then raise exception 'FAIL photo trop tôt: %', r; end if;
  r := private.stamp_wake_proof(u1, 90000, private.local_ts('2026-11-12', '10:00:00.999', tz));
  if not (r->>'accepted')::boolean then raise exception 'FAIL photo 10:00:00,999: %', r; end if;
  passed := passed + 1;

  -- Photo à 10:00:01 refusée (jour 13), amende seulement après 3 min de grâce
  r := private.stamp_wake_proof(u1, 90000, private.local_ts('2026-11-13', '10:00:01', tz));
  if (r->>'accepted')::boolean or r->>'reason' <> 'Trop tard. Fenêtre fermée à 10:00. Reçue à 10:00:01.' then
    raise exception 'FAIL photo 10:00:01: %', r;
  end if;
  perform private.tick(private.local_ts('2026-11-13', '10:02:59', tz));
  if exists (select 1 from public.fines f join public.obligations ob on ob.id = f.obligation_id
              where f.user_id = u1 and ob.day = '2026-11-13' and ob.kind = 'wake') then raise exception 'FAIL amende avant grâce'; end if;
  perform private.tick(private.local_ts('2026-11-13', '10:03:01', tz));
  if (select reason from public.fines f join public.obligations ob on ob.id = f.obligation_id
       where f.user_id = u1 and ob.day = '2026-11-13' and ob.kind = 'wake') is distinct from 'Pas de photo avant 10:00' then
    raise exception 'FAIL amende réveil manqué';
  end if;
  if exists (select 1 from public.fines f join public.obligations ob on ob.id = f.obligation_id
              where f.user_id = u1 and ob.day = '2026-11-12' and ob.kind = 'wake') then raise exception 'FAIL amende malgré photo'; end if;
  passed := passed + 1;

  -- Changement d'heure : mars (02:30 inexistant → 03:30 CEST)
  perform private.set_day_plan(u1, '10:00', false, '02:30', false, private.local_ts('2027-03-26', '12:00', tz));
  perform private.ensure_obligations(u1, '2027-03-27', private.local_ts('2027-03-26', '23:00', tz));
  select * into o from public.obligations where user_id = u1 and day = '2027-03-27' and kind = 'bed';
  if o.window_start <> '2027-03-28 01:30+00' or o.window_end <> '2027-03-28 04:00+00' then
    raise exception 'FAIL heure d''été coucher: % → %', o.window_start, o.window_end;
  end if;
  perform private.ensure_obligations(u1, '2027-03-28', private.local_ts('2027-03-27', '23:00', tz));
  select * into o from public.obligations where user_id = u1 and day = '2027-03-28' and kind = 'wake';
  if o.window_start <> '2027-03-28 07:00+00' or o.window_end <> '2027-03-28 08:00+00' then
    raise exception 'FAIL heure d''été réveil: % → %', o.window_start, o.window_end;
  end if;
  if private.lock_at(c, '2027-03-28') <> '2027-03-27 22:00+00' or private.lock_at(c, '2027-03-29') <> '2027-03-28 21:00+00' then
    raise exception 'FAIL verrou heure d''été';
  end if;
  passed := passed + 1;

  -- Changement d'heure : octobre (02:30 ambigu → seconde occurrence, CET)
  perform private.set_day_plan(u1, '10:00', false, '02:30', false, private.local_ts('2027-10-29', '12:00', tz));
  perform private.ensure_obligations(u1, '2027-10-30', private.local_ts('2027-10-29', '23:00', tz));
  select * into o from public.obligations where user_id = u1 and day = '2027-10-30' and kind = 'bed';
  if o.window_start <> '2027-10-31 01:30+00' or o.window_end <> '2027-10-31 05:00+00' then
    raise exception 'FAIL heure d''hiver coucher: % → %', o.window_start, o.window_end;
  end if;
  passed := passed + 1;

  -- Scénarios de test
  t := '2026-11-20 21:00:20+00';
  o := private.start_scenario(u1, 'bed', t);
  r := private.record_app_signal(u1, 'instagram', t + interval '1 minute');
  if (r->>'fines_created')::int <> 1 or not (select is_test from public.fines where obligation_id = o.id) then
    raise exception 'FAIL scénario coucher: %', r;
  end if;
  o := private.start_scenario(u1, 'wake', t);
  r := private.stamp_wake_proof(u1, 90000, t);
  if (r->>'accepted')::boolean or r->>'reason' not like 'Trop tôt%' then raise exception 'FAIL scénario photo hors fenêtre: %', r; end if;
  r := private.stamp_wake_proof(u1, 90000, t + interval '3 minutes');
  if not (r->>'accepted')::boolean then raise exception 'FAIL scénario photo dans la fenêtre: %', r; end if;
  passed := passed + 1;

  -- Ajout seul
  begin update public.fines set amount_cents = 1 where user_id = u1; ok := false;
  exception when others then ok := sqlerrm like 'Table en ajout seul%'; end;
  if not ok then raise exception 'FAIL amende modifiable'; end if;
  begin delete from public.fines where user_id = u1; ok := false;
  exception when others then ok := sqlerrm like 'Table en ajout seul%'; end;
  if not ok then raise exception 'FAIL amende supprimable'; end if;
  passed := passed + 1;

  -- Jeton Raccourcis
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  v_old_token := public.regenerate_shortcut_token();
  r := public.edge_app_signal(v_old_token, 'Instagram');
  if not (r->>'ok')::boolean then raise exception 'FAIL jeton valide: %', r; end if;
  r := public.edge_app_signal('nr_mauvais', 'instagram');
  if (r->>'ok')::boolean then raise exception 'FAIL mauvais jeton accepté'; end if;
  v_token := public.regenerate_shortcut_token();
  r := public.edge_app_signal(v_old_token, 'instagram');
  if (r->>'ok')::boolean or v_token = v_old_token then raise exception 'FAIL ancien jeton encore valide'; end if;
  passed := passed + 1;

  -- RLS : u1 ne voit que ses lignes, ne peut rien écrire de sensible
  perform private.tick(private.local_ts('2026-11-14', '12:00', tz)); -- crée aussi des amendes pour u2
  select count(*) into n from public.fines where user_id = u1;
  set local role authenticated;
  if (select count(*) from public.fines) <> n then raise exception 'FAIL RLS amendes u1'; end if;
  if exists (select 1 from public.fines where user_id = u2) then raise exception 'FAIL RLS voit u2'; end if;
  if exists (select 1 from public.obligations where user_id = u2) then raise exception 'FAIL RLS obligations u2'; end if;
  begin
    insert into public.fines (obligation_id, challenge_id, user_id, day, kind, amount_cents, is_test, reason, occurred_at)
    values (o.id, c.id, u1, '2026-11-20', 'wake', 1000, true, 'x', now());
    ok := false;
  exception when insufficient_privilege then ok := true;
  end;
  if not ok then raise exception 'FAIL insert amende par client'; end if;
  begin perform private.tick(); ok := false; exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL tick appelable par client'; end if;
  begin perform public.edge_app_signal('x', 'instagram'); ok := false; exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL edge_app_signal appelable par client'; end if;
  r := public.set_tomorrow('09:00', false, '00:30', false);
  if r->>'day' is null then raise exception 'FAIL set_tomorrow client'; end if;
  reset role;
  passed := passed + 1;

  -- anon : aucun accès
  set local role anon;
  begin perform 1 from public.fines limit 1; ok := false; exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL anon lit fines'; end if;
  begin perform 1 from public.daily_objects limit 1; ok := false; exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL anon lit objets'; end if;
  begin perform public.set_tomorrow('09:00', false, '00:30', false); ok := false; exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL anon appelle set_tomorrow'; end if;
  reset role;
  passed := passed + 1;

  raise exception 'NR_TESTS_OK passed=%', passed;
end $$;
