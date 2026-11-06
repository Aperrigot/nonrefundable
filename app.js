import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js';

const EMAIL = 'art.perrigot@gmail.com';
const SITE_URL = 'https://aperrigot.github.io/nonrefundable/';

// Flux « implicit » : le jeton du lien e-mail peut être vérifié depuis l'appli
// (en PKCE il dépendrait du navigateur qui a fait la demande).
// detectSessionInUrl désactivé : on gère nous-mêmes le retour du lien (Safari ≠ appli).
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { flowType: 'implicit', detectSessionInUrl: false, persistSession: true, autoRefreshToken: true, storageKey: 'nr-auth' },
});

const app = document.getElementById('app');
const tabbar = document.getElementById('tabbar');
const isStandalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const $ = (sel) => app.querySelector(sel);

function say(el, text, isError = false) {
  el.textContent = text;
  el.classList.toggle('error', isError);
}

// ---------------------------------------------------------------------------
// Connexion
// ---------------------------------------------------------------------------
function authMessage(error) {
  const m = (error?.message || '').toLowerCase();
  if (m.includes('rate limit') || error?.status === 429) return 'Trop de demandes. Réessaie dans une heure.';
  if (m.includes('expired') || m.includes('invalid') || m.includes('not found') || m.includes('already used')) {
    return 'Lien expiré ou déjà utilisé. Demande un nouveau lien.';
  }
  if (m.includes('signups not allowed') || m.includes('not allowed')) return 'Adresse non autorisée.';
  return error?.message || 'Erreur inconnue.';
}

async function loginWithPasted(raw) {
  const text = raw.trim();
  if (!text) throw new Error('Rien à coller.');
  let url = null;
  try { url = new URL(text); } catch { /* pas une URL : code transféré depuis Safari */ }

  let result;
  if (url) {
    const fragment = new URLSearchParams(url.hash.slice(1));
    const token = url.searchParams.get('token');
    if (fragment.get('refresh_token')) {
      result = await sb.auth.setSession({ access_token: fragment.get('access_token'), refresh_token: fragment.get('refresh_token') });
    } else if (token) {
      const type = url.searchParams.get('type') || 'magiclink';
      result = await sb.auth.verifyOtp({ token_hash: token, type });
      if (result.error && type !== 'email') result = await sb.auth.verifyOtp({ token_hash: token, type: 'email' });
    } else {
      throw new Error('Lien non reconnu.');
    }
  } else {
    result = await sb.auth.refreshSession({ refresh_token: text });
  }
  if (result.error) throw new Error(authMessage(result.error));
}

function renderLogin(notice = '') {
  tabbar.hidden = true;
  app.innerHTML = `
    <h1 class="brand">Nonrefundable</h1>
    <div class="stack">
      <p class="muted">Connexion pour ${esc(EMAIL)}.</p>
      <button class="btn" id="send">Recevoir le lien par e-mail</button>
      <p class="msg" id="send-msg">${esc(notice)}</p>
    </div>
    <div class="stack">
      <label for="paste">Colle le lien de l'e-mail, ou le code affiché par Safari.</label>
      <textarea id="paste" rows="3" autocapitalize="off" autocorrect="off" spellcheck="false" inputmode="url"></textarea>
      <button class="btn" id="go">Se connecter</button>
      <p class="msg" id="go-msg"></p>
    </div>`;

  $('#send').addEventListener('click', async (e) => {
    e.target.disabled = true;
    const { error } = await sb.auth.signInWithOtp({ email: EMAIL, options: { shouldCreateUser: false, emailRedirectTo: SITE_URL } });
    e.target.disabled = false;
    if (error) say($('#send-msg'), authMessage(error), true);
    else say($('#send-msg'), 'E-mail envoyé. Copie le lien (appui long) ou ouvre-le, puis reviens ici.');
  });

  $('#go').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await loginWithPasted($('#paste').value);
      location.hash = '#/accueil';
      await route();
    } catch (err) {
      say($('#go-msg'), err.message, true);
    } finally {
      e.target.disabled = false;
    }
  });
}

// Le lien a été ouvert dans Safari : on affiche un code à coller dans l'appli
// (le stockage de Safari et celui de l'appli installée sont séparés).
function renderTransfer(accessToken, refreshToken) {
  tabbar.hidden = true;
  app.innerHTML = `
    <h1 class="brand">Presque fini</h1>
    <div class="stack">
      <p>Tu es dans Safari. Copie ce code, ouvre l'appli Nonrefundable et colle-le.</p>
      <div class="card code">${esc(refreshToken)}</div>
      <button class="btn" id="copy">Copier le code</button>
      <p class="msg" id="copy-msg"></p>
      <button class="btn secondary" id="here">Continuer dans ce navigateur</button>
    </div>`;
  $('#copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(refreshToken);
      say($('#copy-msg'), 'Copié. Ouvre l\'appli et colle le code.');
    } catch {
      say($('#copy-msg'), 'Copie impossible. Sélectionne le code à la main.', true);
    }
  });
  $('#here').addEventListener('click', async () => {
    const { error } = await sb.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
    if (error) return say($('#copy-msg'), authMessage(error), true);
    location.hash = '#/accueil';
    await route();
  });
}

// ---------------------------------------------------------------------------
// Outils d'affichage
// ---------------------------------------------------------------------------
const TZ = 'Europe/Paris';
let timer = null;
let serverOffset = 0; // ms à ajouter à l'horloge du téléphone pour obtenir l'heure serveur

const euros = (cents) => (cents / 100).toLocaleString('fr-FR', {
  style: 'currency', currency: 'EUR', minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2,
});

const dayLabel = (isoDay) => new Date(`${isoDay}T12:00:00Z`).toLocaleDateString('fr-FR', {
  weekday: 'long', day: 'numeric', month: 'long', timeZone: TZ,
});

const serverNow = () => Date.now() + serverOffset;

function countdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h} h ${String(m).padStart(2, '0')} min ${sec} s` : `${m} min ${sec} s`;
}

// Mode démo (?demo) : données fictives en mémoire, aucun appel à la base.
// Sert à vérifier l'affichage sans session.
const DEMO = new URLSearchParams(location.search).has('demo');

function demoRpc(name, args) {
  const now = new Date();
  const lock = new Date(now.getTime() + 2 * 3600e3 + 14 * 60e3);
  const home = {
    server_now: now.toISOString(), today: '2026-11-06', month: '2026-11-01',
    month_due_cents: 2000, month_test_cents: 1000, deposit_cents: 10000, fines_total_cents: 2000,
    friend_name: 'Ami', real_start_date: '2026-11-06', last_signal_at: null, last_tick_at: now.toISOString(),
    tonight: { day: '2026-11-06', start: '01:00', free: false, test: false, status: 'pending', active: false },
    tomorrow: { day: '2026-11-07', set: false, wake_time: '10:00', wake_free: false, bed_time: '01:00', bed_free: false,
      lock_at: lock.toISOString(), locked: false },
    defaults: { wake_time: '10:00', bed_time: '01:00' },
  };
  if (name === 'get_home') return home;
  if (name === 'set_tomorrow') return { day: home.tomorrow.day, lock_at: home.tomorrow.lock_at, server_now: home.server_now, args };
  throw new Error(`Démo : ${name} non simulé.`);
}

async function rpc(name, args) {
  if (DEMO) return demoRpc(name, args);
  const { data, error } = await sb.rpc(name, args);
  if (error) throw new Error(error.message);
  return data;
}

async function loadHome() {
  const state = await rpc('get_home');
  serverOffset = Date.parse(state.server_now) - Date.now();
  return state;
}

function timeOptions(from, to, selected) {
  // Pas de 15 min, en passant éventuellement minuit (20:00 → 04:00).
  const out = [];
  const [fh, fm] = from.split(':').map(Number);
  const [th, tm] = to.split(':').map(Number);
  let t = fh * 60 + fm;
  const end = th * 60 + tm + (th * 60 + tm < t ? 1440 : 0);
  for (; t <= end; t += 15) {
    const v = `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
    out.push(`<option value="${v}"${v === selected ? ' selected' : ''}>${v}</option>`);
  }
  return out.join('');
}

// ---------------------------------------------------------------------------
// Accueil
// ---------------------------------------------------------------------------
async function renderHome() {
  const s = await loadHome();
  const remaining = s.deposit_cents - s.fines_total_cents;
  const t = s.tomorrow;
  const night = s.tonight;
  const silentHours = s.last_signal_at ? (serverNow() - Date.parse(s.last_signal_at)) / 3.6e6 : null;

  const banners = [];
  if (!t.set && !t.locked) banners.push('Demain n\'est pas réglé.');
  if (silentHours === null) banners.push('Aucun signal Raccourcis reçu pour l\'instant.');
  else if (silentHours > 36) banners.push(`Aucun signal Raccourcis depuis ${Math.floor(silentHours)} h.`);

  const caution = s.deposit_cents === 0
    ? '<a class="muted" href="#/reglages">Caution non saisie</a>'
    : remaining >= 0
      ? `Reste de la caution : <span class="num">${euros(remaining)}</span>`
      : `<span class="accent num">${euros(-remaining)} à compléter</span>`;

  const nightText = !night ? '—'
    : night.free ? 'Libre'
    : `${night.start}${night.active ? ' · en cours' : ''}${night.test ? ' · TEST' : ''}`;
  const wakeText = t.wake_free ? 'Libre' : `${t.wake_time}${t.set ? '' : ' · par défaut'}`;

  app.innerHTML = `
    ${banners.map((b) => `<div class="banner">${esc(b)}</div>`).join('')}
    <section class="hero">
      <div class="big num">${euros(s.month_due_cents)}</div>
      <p class="muted">dû ce mois</p>
      ${s.month_test_cents ? `<p class="muted small">TEST : ${euros(s.month_test_cents)}</p>` : ''}
      <p>${caution}</p>
    </section>
    <div class="card">
      <div class="row"><span>Coucher ce soir</span><span class="num">${esc(nightText)}</span></div>
      <div class="row"><span>Réveil demain</span><span class="num">${esc(wakeText)}</span></div>
    </div>
    <a class="btn ${t.locked ? 'secondary' : ''}" href="#/demain">${t.locked ? 'Demain est verrouillé' : 'Régler demain'}</a>`;
}

// ---------------------------------------------------------------------------
// Régler demain
// ---------------------------------------------------------------------------
async function renderTomorrow() {
  const s = await loadHome();
  const t = s.tomorrow;
  const lockAt = Date.parse(t.lock_at);
  const locked = t.locked || serverNow() >= lockAt;

  app.innerHTML = `
    <h1>Régler demain</h1>
    <p class="muted">${esc(dayLabel(t.day))}</p>
    <p class="${locked ? 'accent' : ''}" id="lock">${locked ? 'Verrouillé depuis 23:00.' : ''}</p>
    <div class="card">
      <div class="row"><span>Photo avant</span>
        <select id="wake" ${locked ? 'disabled' : ''}>${timeOptions('05:00', '12:00', t.wake_time)}</select></div>
      <div class="row"><span>Réveil libre</span>${toggle('wake-free', t.wake_free, locked)}</div>
    </div>
    <div class="card">
      <div class="row"><span>Coucher à</span>
        <select id="bed" ${locked ? 'disabled' : ''}>${timeOptions('20:00', '04:00', t.bed_time)}</select></div>
      <div class="row"><span>Coucher libre</span>${toggle('bed-free', t.bed_free, locked)}</div>
    </div>
    ${locked ? '' : '<button class="btn" id="save">Enregistrer</button>'}
    <p class="msg" id="save-msg">${t.set ? 'Réglé.' : locked ? 'Valeurs par défaut appliquées.' : 'Pas encore réglé.'}</p>`;

  const syncDisabled = () => {
    $('#wake').disabled = locked || $('#wake-free').checked;
    $('#bed').disabled = locked || $('#bed-free').checked;
  };
  syncDisabled();
  if (locked) return;

  $('#wake-free').addEventListener('change', syncDisabled);
  $('#bed-free').addEventListener('change', syncDisabled);

  const tick = () => {
    const left = lockAt - serverNow();
    if (left <= 0) {
      clearInterval(timer);
      renderTomorrow();
      return;
    }
    $('#lock').textContent = `Verrouillage dans ${countdown(left)}.`;
  };
  tick();
  timer = setInterval(tick, 1000);

  $('#save').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await rpc('set_tomorrow', {
        p_wake_time: $('#wake').value,
        p_wake_free: $('#wake-free').checked,
        p_bed_time: $('#bed').value,
        p_bed_free: $('#bed-free').checked,
      });
      say($('#save-msg'), 'Enregistré.');
    } catch (err) {
      say($('#save-msg'), err.message, true);
      if (err.message.startsWith('Verrouillé')) setTimeout(renderTomorrow, 1500);
    } finally {
      e.target.disabled = false;
    }
  });
}

function toggle(id, checked, disabled) {
  return `<label class="switch"><input type="checkbox" id="${id}"${checked ? ' checked' : ''}${disabled ? ' disabled' : ''}><span></span></label>`;
}

async function renderProof() {
  app.innerHTML = `<h1>Preuve de réveil</h1><p class="muted">Lot 5 à venir.</p>`;
}

async function renderHistory() {
  app.innerHTML = `<h1>Historique</h1><p class="muted">Lot 7 à venir.</p>`;
}

// ---------------------------------------------------------------------------
// Réglages
// ---------------------------------------------------------------------------
const SIGNAL_URL = `${SUPABASE_URL}/functions/v1/app-signal`;

const hhmm = (ts) => new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
const dateTime = (ts) => new Date(ts).toLocaleString('fr-FR', {
  weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: TZ,
});

async function copy(text, msgEl) {
  try {
    await navigator.clipboard.writeText(text);
    say(msgEl, 'Copié.');
  } catch {
    say(msgEl, 'Copie impossible. Sélectionne le texte à la main.', true);
  }
}

function copyField(id, label, value) {
  return `<div class="stack">
    <label>${esc(label)}</label>
    <div class="card code small" id="${id}-value">${esc(value)}</div>
    <button class="btn secondary" data-copy="${id}">Copier</button>
  </div>`;
}

function bindCopyButtons(msgEl) {
  app.querySelectorAll('[data-copy]').forEach((b) => {
    b.addEventListener('click', () => copy($(`#${b.dataset.copy}-value`).textContent, msgEl));
  });
}

function shortcutGuide(token) {
  const header = token ? `Bearer ${token}` : 'Bearer <ton jeton>';
  return `
    <ol class="guide">
      <li>Ouvre l'app <b>Raccourcis</b>, onglet <b>Automatisation</b>, puis <b>+</b>.</li>
      <li>Choisis <b>App</b>, sélectionne <b>Instagram</b>. Coche <b>Est ouverte</b> et <b>Est fermée</b>.</li>
      <li>Choisis <b>Exécuter immédiatement</b> et désactive <b>Notifier lors de l'exécution</b>. Touche <b>Suivant</b>.</li>
      <li>Touche <b>Nouveau raccourci vide</b>, ajoute l'action <b>Obtenir le contenu de l'URL</b>.</li>
      <li>Colle l'URL Instagram ci-dessous à la place de « URL ».</li>
      <li>Touche la flèche de l'action. Méthode : <b>POST</b>. Dans <b>En-têtes</b>, ajoute la clé <b>Authorization</b> avec la valeur ci-dessous.</li>
      <li>Touche <b>OK</b>. Recommence avec <b>TikTok</b> et l'URL TikTok.</li>
      <li>Vérifie : lance un scénario coucher ci-dessous, ouvre Instagram, reviens ici.</li>
    </ol>
    ${copyField('url-ig', 'URL Instagram', `${SIGNAL_URL}?app=instagram`)}
    ${copyField('url-tt', 'URL TikTok', `${SIGNAL_URL}?app=tiktok`)}
    ${token ? copyField('auth-header', 'Valeur de l\'en-tête Authorization', header) : ''}`;
}

async function renderSettings() {
  const { data: { user } } = DEMO ? { data: { user: { email: EMAIL } } } : await sb.auth.getUser();
  const st = DEMO ? { has_token: false } : await rpc('get_shortcut_status');

  const signal = st.last_signal_at
    ? `Dernier signal : ${esc(st.last_signal_app === 'tiktok' ? 'TikTok' : 'Instagram')}, ${esc(dateTime(st.last_signal_at))}.`
    : 'Aucun signal reçu.';

  app.innerHTML = `
    <h1>Réglages</h1>

    <h2>Raccourcis</h2>
    <div class="stack">
      <p>${st.has_token ? `Jeton créé le ${esc(dateTime(st.token_created_at))}.` : 'Aucun jeton.'}<br>
        <span class="muted">${signal}</span></p>
      <button class="btn ${st.has_token ? 'secondary' : ''}" id="token">${st.has_token ? 'Régénérer le jeton' : 'Générer le jeton'}</button>
      <p class="msg" id="token-msg"></p>
      <div id="guide">${shortcutGuide(null)}</div>
    </div>

    <h2>Tester</h2>
    <div class="stack">
      <button class="btn secondary" id="scenario-bed">Scénario coucher (10 min)</button>
      <p class="msg" id="scenario-msg"></p>
    </div>

    <h2>Compte</h2>
    <div class="stack">
      <p class="muted">${esc(user?.email)}</p>
      <button class="btn secondary" id="logout">Se déconnecter</button>
    </div>`;

  bindCopyButtons($('#token-msg'));

  $('#token').addEventListener('click', async (e) => {
    if (st.has_token && !confirm('L\'ancien jeton cessera de fonctionner. Il faudra mettre à jour les deux automatisations.')) return;
    e.target.disabled = true;
    try {
      const token = await rpc('regenerate_shortcut_token');
      $('#guide').innerHTML = shortcutGuide(token);
      bindCopyButtons($('#token-msg'));
      say($('#token-msg'), 'Jeton affiché une seule fois. Garde cet écran ouvert le temps de créer les deux automatisations.');
      $('#auth-header-value').scrollIntoView({ block: 'center' });
    } catch (err) {
      say($('#token-msg'), err.message, true);
    } finally {
      e.target.disabled = false;
    }
  });

  $('#scenario-bed').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const o = await rpc('start_scenario', { p_kind: 'bed' });
      say($('#scenario-msg'), `Fenêtre TEST ouverte jusqu'à ${hhmm(o.window_end)}. Ouvre Instagram, puis reviens ici.`);
      watchScenarioFine(o.id, $('#scenario-msg'));
    } catch (err) {
      say($('#scenario-msg'), err.message, true);
    } finally {
      e.target.disabled = false;
    }
  });

  $('#logout').addEventListener('click', async () => {
    await sb.auth.signOut();
    await route();
  });
}

// Au retour dans l'appli, on regarde si l'amende TEST du scénario est tombée.
function watchScenarioFine(obligationId, msgEl) {
  const check = async () => {
    if (document.visibilityState !== 'visible' || !msgEl.isConnected) return;
    const { data } = await sb.from('fines').select('reason, amount_cents').eq('obligation_id', obligationId).maybeSingle();
    if (data) {
      say(msgEl, `Amende TEST : ${data.reason} (${euros(data.amount_cents)}).`);
      document.removeEventListener('visibilitychange', check);
    }
  };
  document.addEventListener('visibilitychange', check);
}

const screens = {
  accueil: { tab: 'accueil', render: renderHome },
  demain: { tab: 'accueil', render: renderTomorrow },
  photo: { tab: 'photo', render: renderProof },
  historique: { tab: 'historique', render: renderHistory },
  reglages: { tab: 'reglages', render: renderSettings },
};

async function route() {
  clearInterval(timer);
  const { data: { session } } = await sb.auth.getSession();
  if (!session && !DEMO) return renderLogin();
  const name = location.hash.replace(/^#\/?/, '') || 'accueil';
  const screen = screens[name] || screens.accueil;
  tabbar.hidden = false;
  tabbar.querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.dataset.tab === screen.tab));
  window.scrollTo(0, 0);
  try {
    await screen.render();
  } catch (err) {
    app.innerHTML = `<h1>Erreur</h1><p class="msg error">${esc(err.message)}</p>
      <button class="btn secondary" onclick="location.reload()">Réessayer</button>`;
  }
}

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------
async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});

  // Retour du lien e-mail : #access_token=…&refresh_token=… ou #error_description=…
  const fragment = new URLSearchParams(location.hash.slice(1));
  if (fragment.get('refresh_token') || fragment.get('error_description')) {
    history.replaceState(null, '', location.pathname);
    if (fragment.get('error_description')) return renderLogin(fragment.get('error_description'));
    if (!isStandalone) return renderTransfer(fragment.get('access_token'), fragment.get('refresh_token'));
    await sb.auth.setSession({ access_token: fragment.get('access_token'), refresh_token: fragment.get('refresh_token') });
  }

  window.addEventListener('hashchange', route);
  sb.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') route();
  });
  await route();
}

boot();
