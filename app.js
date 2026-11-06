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
// Écrans
// ---------------------------------------------------------------------------
async function renderHome() {
  app.innerHTML = `<h1>Accueil</h1><p class="muted">Lot 3 à venir.</p>`;
}

async function renderProof() {
  app.innerHTML = `<h1>Preuve de réveil</h1><p class="muted">Lot 5 à venir.</p>`;
}

async function renderHistory() {
  app.innerHTML = `<h1>Historique</h1><p class="muted">Lot 7 à venir.</p>`;
}

async function renderSettings() {
  const { data: { user } } = await sb.auth.getUser();
  app.innerHTML = `
    <h1>Réglages</h1>
    <div class="stack">
      <p class="muted">Connecté : ${esc(user?.email)}</p>
      <button class="btn secondary" id="logout">Se déconnecter</button>
    </div>`;
  $('#logout').addEventListener('click', async () => {
    await sb.auth.signOut();
    await route();
  });
}

const screens = {
  accueil: { tab: 'accueil', render: renderHome },
  photo: { tab: 'photo', render: renderProof },
  historique: { tab: 'historique', render: renderHistory },
  reglages: { tab: 'reglages', render: renderSettings },
};

async function route() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return renderLogin();
  const name = location.hash.replace(/^#\/?/, '') || 'accueil';
  const screen = screens[name] || screens.accueil;
  tabbar.hidden = false;
  tabbar.querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.dataset.tab === screen.tab));
  window.scrollTo(0, 0);
  await screen.render();
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
