# Nonrefundable — plan v1

Statut : à valider. Aucun code tant que ce plan n'est pas validé.
Date : jeudi 5 novembre 2026. Premier engagement réel : coucher du vendredi 6 novembre 2026.

---

## 0. Décisions clés (lire en premier)

1. **Une seule horloge : celle de Postgres.** Toute heure (réception d'une photo, signal Instagram, verrouillage) est `now()` de la base, jamais l'horloge du téléphone ni celle de l'Edge Function.
2. **Les engagements sont « figés » à 23 h 00 la veille.** À ce moment, le serveur transforme le réglage (heures locales) en *obligations* avec des instants absolus (UTC). Le changement d'heure est résolu une fois, à ce moment-là. Toute la suite ne compare que des instants absolus.
3. **pg_cron tourne en UTC.** On ne planifie donc rien « à 22 h 30 » dans cron. Un seul job tourne chaque minute (`tick`) et décide en heure de Paris ce qui est dû. Le changement d'heure n'a aucun effet sur cron.
4. **Écarts proposés par rapport à ta demande (à valider, voir questions) :**
   - **Lien collé dans l'appli plutôt que clic sur le lien.** Sur iPhone, le lien magique s'ouvre dans Safari, pas dans l'appli installée (stockage séparé) : tu serais connecté dans Safari, pas dans la PWA. Tu copies le lien et tu le colles dans l'appli (voir décision 3 ; le code à 6 chiffres est impossible sans SMTP personnalisé).
   - **L'automatisation Raccourcis se déclenche à l'ouverture ET à la fermeture** d'Instagram/TikTok. Sinon : on ouvre Instagram hors ligne (l'appel échoue), on réactive le réseau, et plus rien n'est détecté.
   - **Scénarios de test.** Les vraies règles empêchent de tester ce soir (le coucher de ce soir a été figé hier, le réveil est à 9 h–10 h demain). Réglages contient donc « Lancer un scénario de test » : crée une obligation TEST qui commence maintenant (coucher : fenêtre de 10 min ; photo : fenêtre de 10 min commençant dans 1 min). Toujours marquée TEST, ne touche jamais les vraies obligations.

---

## 1. Architecture

```
iPhone
 ├─ PWA (GitHub Pages, HTML/CSS/JS statiques, service worker)
 │    ├─ supabase-js ──► Auth (code e-mail) / PostgREST (lectures + RPC)
 │    └─ photo (multipart) ──► Edge Function submit-proof
 └─ Raccourcis (automatisation) ──► Edge Function app-signal (jeton secret)

Supabase (projet gratuit dédié, région eu-west-3 Paris)
 ├─ Postgres : tables + RLS + fonctions SQL (toute la logique métier)
 ├─ pg_cron : tick chaque minute (figer, sanctionner, notifier) + ménage quotidien
 ├─ pg_net  : tick ──► Edge Function send-push (secret interne lu dans Vault)
 ├─ Storage : bucket privé « proofs »
 └─ Edge Functions : app-signal, submit-proof, send-push
```

### Dépendances (et pourquoi)

| Dépendance | Où | Pourquoi | Alternative écartée |
|---|---|---|---|
| `@supabase/supabase-js` (version figée, fichier copié dans `vendor/`, ~50 Ko gz) | Front | Session, rafraîchissement du jeton, appels RPC. Réécrire le rafraîchissement de session à la main est source de bugs. Copié dans le dépôt : pas de CDN au runtime, pas de mise à jour surprise. | `fetch` brut |
| `npm:@supabase/supabase-js` | Edge Functions | Accès base/Storage avec la clé secrète, vérification du JWT. | `fetch` brut, plus verbeux |
| `jsr:@negrel/webpush` | send-push | Signature VAPID + chiffrement aes128gcm (RFC 8291) en WebCrypto natif Deno. Le chiffrement à la main est le premier piège de Web Push. | `npm:web-push` (dépend de modules Node) |
| Supabase CLI | Ton Mac (outil, pas runtime) | Migrations versionnées, déploiement des fonctions, secrets. | Copier-coller dans le dashboard |

Rien d'autre : pas de framework, pas de bundler, pas d'étape de build, pas de lib de compression (canvas natif), service worker écrit à la main (~60 lignes). Pas de Docker : les tests SQL tournent sur le projet distant dans une transaction annulée (`BEGIN … ROLLBACK`).

### Offres gratuites — vérifié le 5/11/2026

| Brique | Limite gratuite | Notre usage estimé | Risque |
|---|---|---|---|
| Supabase projets | **2 projets actifs max par organisation** | 1 (+ ton existant) | Si tu en as déjà 2 actifs : bloquant (question 1) |
| Base Postgres | 500 Mo | < 20 Mo/an | Aucun |
| Storage | 1 Go | 150 Ko × 365 ≈ 55 Mo/an | Aucun avant ~15 ans |
| Egress | 5 Go (+ 5 Go cache) | quelques Mo/mois | Aucun |
| Edge Functions | 500 000 appels/mois, 2 s CPU/requête, 256 Mo, 150 s max | ~100 signaux/jour + 2 push/jour ≈ 4 000/mois | Aucun. Le tick est en SQL pur, il ne consomme pas d'appels. |
| Auth | 50 000 MAU | 1 | Aucun |
| **E-mail d'Auth (SMTP par défaut)** | **2 e-mails/heure, et seulement vers des membres de l'équipe de l'organisation Supabase** | 1 connexion de temps en temps | art.perrigot@gmail.com doit être membre de l'orga (question 1). Sinon SMTP Gmail (mot de passe d'application, gratuit). |
| **Mise en pause** | **Projet gratuit mis en pause après 1 semaine d'inactivité** | Les signaux Raccourcis quotidiens et l'usage de l'appli = activité | Vacances sans téléphone : pause possible. Parade : un ping hebdo par GitHub Actions (gratuit). |
| Sauvegardes | **Aucune** sur le gratuit | — | Export `pg_dump` hebdo par GitHub Actions vers un artefact privé (lot 8) |
| pg_cron / pg_net / Vault | Inclus | 1 job/minute + 1 job/jour | Aucun |
| GitHub Pages | Gratuit **seulement si le dépôt est public** (privé = GitHub Pro payant). 1 Go de site, 100 Go/mois de bande passante. | ~200 Ko | Le dépôt doit être public : d'où « zéro secret dans le dépôt » |
| Web Push iOS | Gratuit (APNs via le navigateur). iOS ≥ 16.4, appli installée sur l'écran d'accueil, autorisation demandée par un tap dans l'appli. | 2/jour | Si une notification push arrive sans en afficher une, iOS peut révoquer l'abonnement : on affiche toujours une notification. |

Clés : les nouveaux projets Supabase utilisent une **clé publishable** (`sb_publishable_…`, équivalent de l'anon) et une **clé secrète** (`sb_secret_…`). Seule la publishable va dans le front. La clé secrète n'existe que dans les secrets des Edge Functions (injectée automatiquement).

### Schéma de données

Tout est en schéma `public` (lisible via l'API sous RLS) sauf les fonctions internes, dans un schéma `private` non exposé.
Chaque table porte `user_id` et, quand c'est pertinent, `challenge_id` : la version à plusieurs ajoutera des membres et des défis sans migration lourde.

**Défi et membres (préparation multi-utilisateur, une seule ligne aujourd'hui)**
- `challenges` : `id`, `owner_id`, `name`, `real_start_date date` (= 2026-11-06), `fine_cents int` (1000), `currency` ('EUR'), `timezone` ('Europe/Paris'), `default_wake time` (10:00), `default_bed time` (01:00), `bed_window_end time` (06:00), `lock_time time` (23:00), `wake_window interval` (1 h), `created_at`.
- `challenge_members` : `challenge_id`, `user_id`, `role` ('owner' | 'participant'), `joined_at`. PK (challenge_id, user_id).

**Argent**
- `deposits` : `id`, `challenge_id`, `user_id`, `amount_cents`, `friend_name`, `paid_on date`, `created_at`. Plusieurs lignes possibles (recharge plus tard). Caution = somme.
- `fines` : `id`, `obligation_id UNIQUE`, `challenge_id`, `user_id`, `kind` ('wake' | 'bed'), `amount_cents`, `is_test bool`, `reason text` (« Instagram ouvert à 01:24 »), `occurred_at timestamptz`, `day date`, `created_at`. **Append-only** (trigger qui refuse UPDATE/DELETE). `UNIQUE(obligation_id)` = au plus une amende par nuit et par matin, garanti par la base.

**Réglages et obligations**
- `day_plans` : `challenge_id`, `user_id`, `day date`, `wake_time time`, `wake_free bool`, `bed_time time`, `bed_free bool`, `source` ('user' | 'default'), `updated_at`. PK (challenge_id, user_id, day). Écrit uniquement via la RPC `set_tomorrow`.
- `obligations` : `id`, `challenge_id`, `user_id`, `day date`, `kind` ('wake' | 'bed'), `window_start timestamptz`, `window_end timestamptz`, `is_free bool`, `is_test bool`, `is_scenario bool`, `object_id` (réveil), `status` ('pending' | 'done' | 'failed' | 'free'), `created_at`. Index unique (challenge_id, user_id, day, kind) **hors scénarios**. Créée par le serveur au verrouillage, jamais par le client.
- `daily_objects` : `id`, `label` (≥ 40 objets : « une fourchette », « une clé », « une chaussette », « un verre d'eau »…, jamais une personne ni toi). Tiré au hasard au verrouillage, en excluant les 10 derniers jours. Stocké dans l'obligation : pas de nouveau tirage possible.

**Preuves et signaux**
- `wake_proofs` : `id`, `obligation_id`, `user_id`, `received_at timestamptz`, `accepted bool`, `refusal_reason`, `storage_path`, `bytes int`. Garde aussi les tentatives refusées (utile pour l'historique et le test « photo hors fenêtre refusée »).
- `app_signals` : `id`, `user_id`, `app` ('instagram' | 'tiktok'), `received_at`, `obligation_id null`. Journal de tous les signaux, de jour comme de nuit (sert à détecter un silence suspect, voir risques).
- `shortcut_tokens` : `user_id PK`, `token_hash bytea` (SHA-256), `created_at`, `last_used_at`. Le jeton en clair n'est jamais stocké.

**Notifications**
- `push_subscriptions` : `id`, `user_id`, `endpoint UNIQUE`, `p256dh`, `auth`, `created_at`, `last_ok_at`.
- `notification_log` : `id`, `user_id`, `kind` ('plan_reminder' | 'wake_reminder' | 'test'), `ref_key` (ex. '2026-11-06'), `sent_at`, `status`. `UNIQUE(user_id, kind, ref_key)` = jamais deux fois le même rappel.

**Fin de mois (point de branchement de l'e-mail futur)**
- `monthly_reports` : `id`, `challenge_id`, `user_id`, `month date`, `snapshot jsonb` (amendes, total, reste), `created_at`, `emailed_at null`. Créé par le tick le 1er du mois à 08:00 Paris. Plus tard : un trigger ou un job lit les lignes `emailed_at IS NULL` et appelle une Edge Function `send-monthly-email`. Rien d'autre à changer.

### Politiques RLS

Principe : **le client lit ce qui est à lui, n'écrit presque rien en direct.** Toute écriture sensible passe par une fonction SQL `SECURITY DEFINER` (search_path figé) qui vérifie l'heure serveur.

| Table | SELECT | INSERT / UPDATE / DELETE client |
|---|---|---|
| challenges, challenge_members | membre du défi | aucun |
| deposits | `user_id = auth.uid()` | insert/update les siennes (champs saisis à la main) |
| day_plans | à soi | **aucun** (RPC `set_tomorrow` seulement) |
| obligations, fines, wake_proofs, app_signals, notification_log, monthly_reports | à soi | **aucun** |
| daily_objects | utilisateur connecté | aucun |
| push_subscriptions | à soi | insert/delete à soi |
| shortcut_tokens | **aucun** (ni le hash) | aucun (RPC `regenerate_shortcut_token`) |
| Storage `proofs` (privé) | fichiers sous `{user_id}/` | **aucun** : seule submit-proof écrit |

Et aussi :
- Rôle `anon` : aucun droit sur aucune table (test automatique : la clé publishable sans session renvoie zéro ligne partout).
- `REVOKE EXECUTE … FROM PUBLIC` sur toutes les fonctions ; `GRANT` explicite au rôle `authenticated` seulement pour les RPC prévues. (Piège Postgres : par défaut, toute fonction est exécutable par tous.)
- Inscriptions désactivées dans Auth + `shouldCreateUser: false` côté client. Ton compte est créé une fois depuis le dashboard.
- Advisors de sécurité Supabase : zéro alerte exigée en fin de lot 1.

### RPC exposées au client
- `get_home()` : `server_now`, amendes dues du mois, reste de caution, coucher de ce soir, réveil de demain, état de « demain réglé ».
- `get_tomorrow()` / `set_tomorrow(wake_time, wake_free, bed_time, bed_free)` : renvoie aussi `lock_at` et `server_now` pour le compte à rebours.
- `get_wake_status()` : objet du jour, fenêtre, état.
- `get_history(month)`, `get_month_recap(month)`.
- `update_settings(...)`, `regenerate_shortcut_token()` (renvoie le jeton en clair une seule fois).
- `start_scenario(kind)`, `queue_test_push()`.

---

## 2. Edge Functions, cron et cas limites

### Fonctions de temps (SQL, schéma `private`)
Toutes prennent un paramètre `p_now timestamptz DEFAULT now()`. En production on n'y touche pas ; dans les tests on simule 22:59:59, minuit, le changement d'heure, etc.

- `paris_date(t)` = `(t AT TIME ZONE 'Europe/Paris')::date`.
- `lock_at(J)` = `((J - 1) + time '23:00') AT TIME ZONE 'Europe/Paris'`.
- `wake_deadline(J, t)` = `(J + t) AT TIME ZONE 'Europe/Paris'` ; fenêtre = `[deadline - 1 h, deadline]` en temps absolu.
- `bed_start(J, t)` = si `t >= 12:00` alors `(J + t)` sinon `(J + 1 + t)`, converti en Paris. Fin = `(J + 1 + 06:00)` Paris. Fenêtre `[début, fin)`.
- `ensure_obligations(user, J, p_now)` : si `p_now >= lock_at(J)` et que les obligations de J n'existent pas, les crée depuis `day_plans` ou les valeurs par défaut. Idempotente (`ON CONFLICT DO NOTHING`). Appelée par le tick ET par chaque fonction qui en a besoin : si le cron a raté une minute, rien n'est perdu.
- `is_test(kind, J)` : vrai si `kind = 'wake' AND J <= real_start_date` ou `kind = 'bed' AND J < real_start_date`. Avec `real_start_date = 2026-11-06` : le réveil du 6 est TEST, le coucher du 6 est réel, le réveil du 7 est réel.

### Edge Function `app-signal` (appelée par Raccourcis)
- `verify_jwt = false` ; authentification par en-tête `Authorization: Bearer <jeton>` ; comparaison du SHA-256 en temps constant. Mauvais jeton : 401, rien n'est écrit.
- Corps : `{"app": "instagram"}` ou `"tiktok"`. Toute autre valeur (YouTube compris) : 400, ignorée.
- Appelle `private.record_app_signal(user, app)` qui, dans une seule transaction :
  1. horodate avec `now()` de Postgres et insère dans `app_signals` ;
  2. appelle `ensure_obligations` pour `J = paris_date(now)` et `J - 1` ;
  3. cherche l'obligation `bed` non libre dont la fenêtre contient `now` (au plus une : chaque fenêtre finit à 06:00 et la suivante commence au plus tôt à 12:00) ;
  4. insère l'amende `ON CONFLICT (obligation_id) DO NOTHING`, motif « Instagram ouvert à 01:24 ».
- Répond 200 dans tous les cas valides (Raccourcis n'a rien à afficher).

### Edge Function `submit-proof` (appelée par l'appli)
1. Vérifie le JWT (`auth.getUser`).
2. Lit tout le corps (JPEG ≤ 150 Ko ; au-delà : 413).
3. **Horodatage après réception complète** : RPC interne `private.stamp_wake_proof(user)` → `now()` Postgres + verdict.
4. Si dans la fenêtre : upload Storage `{user_id}/{day}.jpg` avec la clé secrète, `wake_proofs.accepted = true`, obligation `done`. Si l'upload Storage échoue alors que la photo a été reçue à temps : acceptée quand même, `storage_path` nul et marquée (la faute est au serveur, pas à toi).
5. Sinon : `wake_proofs.accepted = false`, réponse 422 avec un message lisible (« Fenêtre fermée à 10:00. Reçue à 10:00:03. » ou « Fenêtre ouverte à 09:00. »).

### Edge Function `send-push` (interne)
- `verify_jwt = false` ; exige l'en-tête `x-internal-secret` égal au secret stocké dans Vault (côté base) et dans les secrets de la fonction.
- Corps : `{user_id, title, body, url}`. Envoie à tous les abonnements de l'utilisateur via VAPID. 404/410 → l'abonnement est supprimé. Résultat écrit dans `notification_log`.

### Jobs pg_cron
1. **`nr-tick` chaque minute** → `private.tick(now())`, protégé par un verrou consultatif (deux ticks ne se chevauchent jamais) :
   - **Figer** : pour chaque membre, `ensure_obligations(J)` pour J = demain (dès 23:00) et rattrapage des 3 jours précédents.
   - **Réveil manqué** : obligations `wake` en attente dont `window_end < now - 3 min` → `failed` + amende « Pas de photo avant 10:00 ». Les 3 minutes couvrent une requête commencée avant l'heure limite et pas encore finie (150 s max par fonction).
   - **Coucher terminé** : obligations `bed` en attente dont `window_end <= now` → `done`.
   - **Rappels** (chacun dédoublonné par `notification_log`, tolérance de 5 min, jamais envoyé en retard au-delà) :
     - 22:30 Paris, si demain n'a pas de réglage `source = 'user'` : « Règle demain avant 23 h. »
     - `deadline - 30 min`, si réveil non libre et pas de photo acceptée : « Photo avant 10:00. Objet : une fourchette. »
   - **Fin de mois** : le 1er à 08:00 Paris, crée la ligne `monthly_reports` du mois précédent.
   - Envoi des push via `pg_net.http_post` vers send-push.
2. **`nr-cleanup` chaque jour** : purge `cron.job_run_details` et les réponses pg_net de plus de 7 jours.

### Cas limites (tous couverts par un test SQL)

| Cas | Règle |
|---|---|
| Réglage reçu à 22:59:59,8 | Accepté si la transaction voit `now() < lock_at`. À 23:00:00,000 : refusé. L'heure qui compte est l'arrivée en base. |
| Réglage de J+2 ou d'aujourd'hui | Refusé : seul « demain » (date de Paris) est réglable. |
| Rien réglé | À 23:00, obligations créées avec 10:00 / 01:00, `source = 'default'`. |
| Coucher 23:30 | Fenêtre J 23:30 → J+1 06:00. |
| Coucher 01:00 | Fenêtre J+1 01:00 → J+1 06:00 (« après minuit » = heure < 12:00). |
| Signal à 00:30 pour un coucher à 23:30 | `paris_date` = J+1, on regarde J et J−1 : trouvé dans la fenêtre de J. |
| Signal à l'instant exact du coucher | Compté (borne incluse). À 06:00:00 : pas compté. |
| Instagram ouvert 2 fois (ou ouvert puis fermé) | 2 signaux enregistrés, 1 seule amende (contrainte unique). Deux requêtes simultanées : la contrainte tranche, l'une ne fait rien. |
| Instagram et TikTok la même nuit | 1 seule amende, motif = la première app. |
| Photo à 09:59:59,900 qui finit d'arriver à 10:00:00,300 | Horodatée à la fin de réception : `10:00:00,300`. **Règle : acceptée si l'heure tronquée à la seconde est ≤ l'heure limite.** Donc 10:00:00,999 accepté, 10:00:01,000 refusé. Le tick attend 10:03 avant d'infliger l'amende. |
| Photo à 08:59:59 pour 10:00 | Refusée : « Fenêtre ouverte à 09:00. » |
| Deux photos dans la fenêtre | La 2e est enregistrée, la 1re acceptée fait foi. |
| Passage à l'heure d'été (dernier dimanche de mars, 02:00 → 03:00) | Un coucher à 02:30 n'existe pas : Postgres le place à 03:30 heure d'été (règle documentée de Postgres, vérifiée par test). Fenêtre de photo = « 1 h avant » en temps réel. |
| Passage à l'heure d'hiver (dernier dimanche d'octobre, 02:00–02:59 deux fois) | Un coucher à 02:30 est ambigu : Postgres prend le second (heure d'hiver). Nuit plus longue d'une heure, en ta faveur. 06:00, 10:00, 22:30 et 23:00 ne sont jamais ambigus. |
| cron et fuseau | cron en UTC, mais il ne sert que de métronome : toutes les comparaisons se font en heure de Paris dans le SQL. |
| Cron en panne une heure | `ensure_obligations` est appelée aussi par app-signal et submit-proof ; le tick rattrape ensuite. Les rappels ratés de plus de 5 min ne sont pas envoyés en retard. |
| Mois d'une amende | Celui du jour J de l'obligation (Instagram le 1er décembre à 01:00 pour la nuit du 30 novembre → novembre). |
| Téléphone à une mauvaise heure | Aucun effet : le front affiche les heures que le serveur renvoie ; le compte à rebours = `lock_at - server_now`, corrigé du décalage local. |

---

## 3. Risques de triche et de panne

| # | Risque | Parade |
|---|---|---|
| T1 | Désactiver l'automatisation Raccourcis | Impossible à empêcher sur iOS. Parade sociale : tous les signaux (jour et nuit) sont journalisés. Si aucun signal depuis 36 h : bandeau orange sur l'accueil, et le récap partagé à l'ami affiche « jours sans aucun signal ». |
| T2 | Ouvrir Instagram hors ligne, puis réactiver le réseau | Automatisation sur l'ouverture ET la fermeture : la fermeture envoie le signal. |
| T3 | Instagram/TikTok dans Safari, sur iPad ou sur ordinateur | Non détectable. Parade optionnelle : Temps d'écran → Contenu → bloquer instagram.com et tiktok.com dans Safari. iPad : même automatisation, même jeton. Risque accepté et écrit. |
| T4 | Tout mettre en « libre » | Autorisé par tes règles. Le récap compte les jours libres et l'ami le voit. |
| T5 | Repousser la date de début pour rester en TEST | La date de début n'est modifiable que tant qu'elle est dans le futur. Une fois passée, verrouillée côté serveur. |
| T6 | Supprimer une amende | Pas de DELETE/UPDATE via l'API, trigger qui refuse même en SQL direct. Tu restes admin de la base : la vraie parade est le récap envoyé à l'ami chaque mois. |
| T7 | Photo depuis la galerie ou ancienne photo | `capture="environment"` ouvre directement l'appareil photo sur iOS, pas la galerie. Contourner demande d'appeler l'API à la main, et seulement dans la fenêtre : il faut être réveillé de toute façon. Objet imposé par le serveur. |
| T8 | Régler demain après 23 h en changeant l'heure du téléphone | Le serveur seul décide (`now()` Postgres dans la RPC). |
| T9 | Jeton Raccourcis volé | 32 octets aléatoires, seul le hash est stocké, régénérable. Au pire, quelqu'un peut te créer une amende de nuit, au plus une par nuit, visible avec son heure. |
| P1 | Projet Supabase mis en pause (7 jours sans activité) | Usage quotidien = activité. En plus : ping hebdo GitHub Actions. |
| P2 | E-mail de connexion non reçu (2/h, membres de l'orga seulement) | Ton e-mail dans l'orga Supabase ; session longue (pas de déconnexion) ; SMTP Gmail en secours. |
| P3 | Abonnement push perdu (réinstallation, iOS) | Réglages affiche l'état ; send-push supprime les abonnements morts ; le bandeau d'accueil signale « notifications coupées ». |
| P4 | Réseau mauvais au moment de la photo | Ouvrir l'appareil à l'avance : la fenêtre dure 1 h. Compression à ~100 Ko. Bouton « Réessayer » qui renvoie la même image. Message d'erreur explicite si refus. |
| P5 | Raccourcis en échec réseau la nuit | Le signal de fermeture rattrape (T2). Les signaux échoués ne sont pas rejoués : risque accepté. |
| P6 | Cron arrêté | Rattrapage par `ensure_obligations` à la demande + tick qui traite les retards. Le bandeau d'accueil affiche « serveur en retard » si le dernier tick date de plus de 10 min. |
| P7 | Aucune sauvegarde sur l'offre gratuite | `pg_dump` hebdo par GitHub Actions (mot de passe DB dans les secrets GitHub, pas dans le dépôt). |
| P8 | Fuite de secret dans le dépôt public | `.gitignore` (`.env`, `supabase/.temp`), seul `config.js` contient l'URL et la clé publishable. Vérification `git grep` avant chaque push (critère de lot). |

---

## 4. Lots de travail (dans l'ordre)

Ce soir, pour le critère final : lots 0 à 6. Lots 7 et 8 : vendredi avant 23 h si possible, sinon le week-end (ils ne bloquent pas le démarrage réel).

| Lot | Contenu | Critère de réussite vérifiable |
|---|---|---|
| **0. Socle** | Dossier, `git init`, `.gitignore`, `supabase init` + `link`, dépôt GitHub public, Pages activé. | `supabase migration list` répond. La page « Hello » s'affiche en HTTPS sur l'URL Pages. `git grep -i secret` ne trouve rien. |
| **1. Base** | Migration : tables, RLS, grants, fonctions de temps, `ensure_obligations`, `set_tomorrow`, `record_app_signal`, tick, 40+ objets, triggers append-only. Tests SQL (`BEGIN … ROLLBACK`). | Tous les tests passent : 22:59:59 accepté, 23:00:00 refusé ; coucher 23:30 et 01:00 ; signal 00:30 rattaché à J ; double signal = 1 amende ; mars et octobre ; photo 10:00:00,999 acceptée, 10:00:01 refusée ; TEST avant le 6 novembre. Requête avec la clé publishable sans session = 0 ligne partout. Advisors sécurité = 0 alerte. |
| **2. Coquille PWA + connexion** | `index.html`, styles (design), manifest, icônes, service worker, connexion par code. | Sur l'iPhone : ajoutée à l'écran d'accueil, s'ouvre en plein écran (pas de barre Safari), fond #0E0F12, contenu hors encoche. Connexion par code. Toujours connecté après avoir tué l'appli. Une connexion avec un autre e-mail est refusée. |
| **3. Accueil + Régler demain** | Écrans, compte à rebours, verrouillage. | Je règle demain, je vois mes valeurs sur l'accueil. Un `curl` direct sur `set_tomorrow` simulé après 23:00 (test SQL) est refusé. Après 23:00 réel, l'écran affiche « Verrouillé ». |
| **4. Coucher** | `app-signal`, jeton (affiché une fois, régénérable), guide Raccourcis, scénario de test coucher. | Scénario lancé, j'ouvre Instagram : une amende TEST « Instagram ouvert à HH:MM » apparaît en moins de 10 s. 2e ouverture : toujours 1 amende. YouTube : rien. Ancien jeton après régénération : 401. |
| **5. Réveil** | Écran preuve, capture caméra, compression < 150 Ko, `submit-proof`, scénario de test photo. | Photo dans la fenêtre : acceptée, fichier < 150 Ko visible dans Storage. Photo avant l'ouverture : refusée avec l'heure. Fin de fenêtre sans photo : amende TEST 3 min après. |
| **6. Notifications** | Clés VAPID, abonnement, `send-push`, tick, bouton « Tester les notifications ». | Sur l'iPhone verrouillé : je reçois « Règle demain avant 23 h » et « Photo avant HH:MM » de test. Le même rappel n'arrive jamais deux fois. |
| **7. Historique + récap + réglages caution** | Grand livre, récap du mois, Partager, caution/ami/date. | Les totaux affichés = une requête SQL de contrôle. « Partager » ouvre la feuille de partage iOS avec le texte du récap. Date de début non modifiable une fois passée. |
| **8. Durcissement** | Bandeaux de santé (silence Raccourcis, push coupé, tick en retard), `nr-cleanup`, ping hebdo et `pg_dump` hebdo (GitHub Actions). | Couper l'automatisation 36 h → bandeau visible. Action GitHub verte. Restauration du dump testée une fois sur un Postgres local ou un schéma de test. |

---

## 5. Ce que tu fais toi-même (ordre exact)

**Mac, ce soir**
1. Supabase : vérifie l'organisation (combien de projets **actifs**, max 2 en gratuit) et qu'art.perrigot@gmail.com en est membre (Organization → Team).
2. ~~Créer le projet~~ : fait par Claude via le connecteur (décision 2). Ensuite, tu réinitialises toi-même le mot de passe DB (Project Settings → Database) et tu le ranges dans ton gestionnaire. Il ne passe jamais par le chat ; il ne sert qu'à `supabase link`.
3. Auth → Users → Add user → `art.perrigot@gmail.com`, « Auto confirm ».
4. Auth → Sign In / Providers → désactive « Allow new users to sign up ».
5. ~~Auth → Email Templates → « Magic Link »~~ : sans objet (modèle verrouillé sans SMTP personnalisé, voir décision 3).
6. Installe la CLI : `brew install supabase/tap/supabase`, puis `supabase login` (ouvre le navigateur).
7. GitHub : `gh auth status` (sinon `gh auth login`). Je crée le dépôt public `nonrefundable` et active Pages, ou tu le fais (Settings → Pages → Deploy from branch → main / root).
8. Auth → URL Configuration → Site URL = `https://<ton-user>.github.io/nonrefundable/`.
9. Secrets : je génère les clés VAPID et le secret interne en local et je les envoie avec `supabase secrets set` + Vault. Rien n'est écrit dans un fichier du dépôt. Tu valides la commande.

**iPhone, ce soir**
10. Vérifie iOS ≥ 16.4 (Réglages → Général → Informations).
11. Safari → URL Pages → Partager → « Sur l'écran d'accueil » → nom « Nonrefundable ».
12. Ouvre depuis l'icône (pas depuis Safari). Demande le lien, puis dans Mail : appui long sur le lien → « Copier » → colle-le dans l'appli.
13. Réglages de l'appli → « Activer les notifications » → Autoriser.
14. Réglages de l'appli → « Générer le jeton » → copie (affiché une seule fois).
15. Raccourcis → Automatisation → + → App → Instagram → cocher « Est ouverte » et « Est fermée » → « Exécuter immédiatement », « Notifier lors de l'exécution » désactivé → action « Obtenir le contenu de l'URL » : URL de `app-signal`, méthode POST, en-tête `Authorization: Bearer <jeton>`, corps JSON `app = instagram`. Le guide pas à pas sera dans l'appli.
16. Même chose pour TikTok (`app = tiktok`).
17. Optionnel : Temps d'écran → bloquer instagram.com et tiktok.com dans Safari.
18. Réglages de l'appli : caution (montant, prénom, date), date de début = 06/11/2026.
19. Tests finaux : scénario coucher + Instagram, scénario photo dans et hors fenêtre, bouton « Tester les notifications ».
20. Si l'appli est prête **avant 23:00 ce soir**, règle vendredi. Sinon, valeurs par défaut (10:00 / 01:00) : réveil du vendredi en TEST, coucher du vendredi réel.

---

## 6. Décisions (réponses du 6/11/2026)

1. **Supabase** : art.perrigot@gmail.com est le compte Supabase. Organisation « Stud'IA », 1 projet actif (« Aperrigot's Project ») : place pour le 2e. SMTP par défaut suffisant.
2. **Création** : Claude crée le projet `nonrefundable` (eu-west-3, Stud'IA) via le connecteur Supabase et le dépôt public `Aperrigot/nonrefundable` via `gh`. Tu gardes : réglages Auth (étapes 3 à 5 et 8), CLI (étape 6), iPhone.
3. **Connexion** : ~~code à 6 chiffres~~ → **lien collé dans l'appli** (décision du 6/11, 02:10). Le SMTP par défaut interdit de modifier le modèle d'e-mail, donc pas de code dans l'e-mail. Appui long sur le lien dans Mail → « Copier » → coller dans le champ de connexion de l'appli. L'appli extrait le paramètre `token` du lien et appelle `verifyOtp({ token_hash, type: 'magiclink' })` : la session est ouverte dans l'appli, pas dans Safari. Client supabase-js en `flowType: 'implicit'` (en PKCE, le jeton du lien serait préfixé `pkce_`). À vérifier au lot 2 sur l'iPhone. Repli si ça échoue : SMTP Gmail (mot de passe d'application) pour débloquer le modèle.
4. **Plages** : coucher 20:00 → 04:00, réveil 05:00 → 12:00, pas de 15 min. Validées côté serveur dans `set_tomorrow`. Conséquence : un coucher entre 02:00 et 02:59 reste possible, le cas du changement d'heure reste donc testé.
5. **Caution épuisée** : reste négatif affiché en orange (« 20 € à compléter »), les amendes continuent.
6. **GitHub** : compte `Aperrigot`, dépôt public.
7. **Signaux** : toutes les ouvertures et fermetures d'Instagram/TikTok sont enregistrées, de jour comme de nuit.
8. **Photos** : conservées sans limite de durée.
9. **Scénarios de test** : toujours disponibles, toujours marqués TEST.

Constat du 6/11 à 01:25 : rien n'a été réglé hier avant 23 h, donc vendredi = valeurs par défaut (réveil 10:00 en TEST, coucher 01:00 **réel**, nuit du 6 au 7). La CLI Supabase n'est pas encore installée.

---

## 7. Journal d'avancement

**Lot 0 (6/11, 01:40)** : projet Supabase `tixiaahenxcykhgzkmdu` (eu-west-3, 0 €), dépôt public `Aperrigot/nonrefundable`, Pages en ligne.

**Lot 1 (6/11, 01:50)** : migrations `20261106004702_lot1_schema` et `20261106004812_lot1_pg_net_schema` appliquées. Tests `supabase/tests/lot1.sql` : 22/22. Accès anonyme par l'API : refusé partout (42501). Le tick tourne ; obligations du 6/11 figées (réveil 09:00–10:00 TEST, coucher 07/11 01:00–06:00 réel).
Alertes restantes des advisors, acceptées volontairement :
- `rls_enabled_no_policy` (INFO) sur les 3 tables du schéma `private` : aucun accès client voulu.
- `authenticated_security_definer_function_executable` (WARN) sur `set_tomorrow`, `start_scenario`, `regenerate_shortcut_token` : ce sont les RPC prévues, elles vérifient `auth.uid()` et l'heure serveur.
- `auth_leaked_password_protection` (WARN) : sans objet, aucune connexion par mot de passe.
