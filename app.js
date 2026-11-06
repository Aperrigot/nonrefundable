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

// ---------------------------------------------------------------------------
// Preuve de réveil
// ---------------------------------------------------------------------------
const PROOF_URL = `${SUPABASE_URL}/functions/v1/submit-proof`;
const MAX_PHOTO_BYTES = 140 * 1024; // marge sous la limite serveur de 150 Ko

function canvasToJpeg(canvas, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

// Redimensionne et recompresse jusqu'à passer sous 140 Ko. L'orientation EXIF
// est appliquée par le navigateur au décodage ; les métadonnées ne sont pas recopiées.
async function compressPhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    let side = 1280;
    for (let attempt = 0; attempt < 8; attempt++) {
      const scale = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      for (const q of [0.72, 0.6, 0.5, 0.4]) {
        const blob = await canvasToJpeg(canvas, q);
        if (blob && blob.size <= MAX_PHOTO_BYTES) return blob;
      }
      side = Math.round(side * 0.75);
    }
    throw new Error('Compression impossible.');
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function sendPhoto(blob) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) throw new Error('Session expirée. Reconnecte-toi.');
  const res = await fetch(PROOF_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'image/jpeg' },
    body: blob,
  });
  const body = await res.json().catch(() => ({}));
  if (res.status >= 500) throw new Error('Serveur indisponible. Réessaie.');
  return body;
}

function proofStateText(w) {
  switch (w.state) {
    case 'none': return 'Aucun réveil prévu aujourd\'hui.';
    case 'free': return 'Réveil libre aujourd\'hui.';
    case 'done': return `Faite à ${hhmm(w.proof_at)}.`;
    case 'failed': return `Ratée. Fenêtre fermée à ${hhmm(w.window_end)}.`;
    case 'not_open': return `Fenêtre pas encore ouverte. Ouverture à ${hhmm(w.window_start)}.`;
    default: return `Fenêtre ouverte jusqu'à ${hhmm(w.window_end)}.`;
  }
}

async function renderProof() {
  const w = DEMO
    ? { state: 'open', object: 'une fourchette', window_start: new Date().toISOString(),
        window_end: new Date(Date.now() + 40 * 60e3).toISOString(), server_now: new Date().toISOString(), test: true }
    : await rpc('get_wake_status');
  serverOffset = Date.parse(w.server_now) - Date.now();
  const canShoot = ['open', 'not_open', 'failed'].includes(w.state);

  app.innerHTML = `
    <h1>Preuve de réveil</h1>
    ${w.object ? `
      <div class="card object">
        <p class="muted small">Objet du jour${w.scenario ? ' · scénario TEST' : w.test ? ' · TEST' : ''}</p>
        <p class="object-label">${esc(w.object)}</p>
      </div>` : ''}
    <p class="state ${w.state === 'failed' ? 'accent' : ''}" id="state">${esc(proofStateText(w))}</p>
    <p class="muted num" id="left"></p>
    ${canShoot ? `
      <input type="file" id="camera" accept="image/*" capture="environment" hidden>
      <button class="btn" id="shoot">Prendre la photo</button>` : ''}
    <button class="btn secondary" id="retry" hidden>Réessayer l'envoi</button>
    <p class="msg" id="proof-msg"></p>`;

  if (w.state === 'open' || w.state === 'not_open') {
    const target = Date.parse(w.state === 'open' ? w.window_end : w.window_start);
    const tickLeft = () => {
      const left = target - serverNow();
      if (left <= 0) {
        clearInterval(timer);
        renderProof();
        return;
      }
      $('#left').textContent = `${w.state === 'open' ? 'Reste' : 'Ouverture dans'} ${countdown(left)}.`;
    };
    tickLeft();
    timer = setInterval(tickLeft, 1000);
  }
  if (!canShoot) return;

  let pending = null;
  const submit = async () => {
    const msg = $('#proof-msg');
    say(msg, 'Envoi…');
    $('#retry').hidden = true;
    try {
      const r = DEMO ? { accepted: true } : await sendPhoto(pending);
      if (r.accepted) {
        say(msg, r.storage_failed ? 'Acceptée (photo non stockée, erreur serveur).' : 'Acceptée.');
        pending = null;
        setTimeout(renderProof, 1200);
      } else {
        say(msg, r.reason || 'Refusée.', true);
      }
    } catch (err) {
      say(msg, err.message, true);
      $('#retry').hidden = false;
    }
  };

  $('#shoot').addEventListener('click', () => $('#camera').click());
  $('#retry').addEventListener('click', submit);
  $('#camera').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      say($('#proof-msg'), 'Compression…');
      pending = await compressPhoto(file);
    } catch (err) {
      say($('#proof-msg'), err.message, true);
      return;
    }
    await submit();
  });
}

// ---------------------------------------------------------------------------
// Historique et récap du mois
// ---------------------------------------------------------------------------
let historyMonth = null; // 'YYYY-MM-01'

const monthLabel = (isoMonth) => new Date(`${isoMonth}T12:00:00Z`).toLocaleDateString('fr-FR', {
  month: 'long', year: 'numeric', timeZone: TZ,
});
const shortDay = (isoDay) => new Date(`${isoDay}T12:00:00Z`).toLocaleDateString('fr-FR', {
  day: '2-digit', month: '2-digit', timeZone: TZ,
});
const kindLabel = (k) => (k === 'bed' ? 'Coucher' : 'Réveil');

function shiftMonth(isoMonth, delta) {
  const [y, m] = isoMonth.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

function recapText(r) {
  const real = r.fines.filter((f) => !f.is_test);
  const lines = [
    `Nonrefundable, ${monthLabel(r.month)}`,
    `Amendes : ${real.length} (${euros(r.due_cents)})`,
    ...real.map((f) => `- ${shortDay(f.day)} ${kindLabel(f.kind)} : ${f.reason} (${euros(f.amount_cents)})`),
    `Total dû ce mois : ${euros(r.due_cents)}`,
  ];
  if (r.deposit_cents) {
    lines.push(`Caution : ${euros(r.deposit_cents)} versés à ${r.friend_name} le ${shortDay(r.paid_on)}.`);
    lines.push(r.remaining_cents >= 0 ? `Reste : ${euros(r.remaining_cents)}.` : `À compléter : ${euros(-r.remaining_cents)}.`);
  }
  lines.push(`Jours libres : ${r.free_count}. Jours sans signal Raccourcis : ${r.silent_days}.`);
  return lines.join('\n');
}

async function renderHistory() {
  if (!historyMonth) {
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: TZ }); // YYYY-MM-DD
    historyMonth = `${today.slice(0, 7)}-01`;
  }
  const r = DEMO
    ? { month: historyMonth, due_cents: 1000, test_cents: 1000, deposit_cents: 10000, remaining_cents: 9000,
        friend_name: 'Ami', paid_on: '2026-11-05', free_count: 1, silent_days: 0,
        fines: [{ day: '2026-11-06', kind: 'wake', amount_cents: 1000, is_test: true, reason: 'Pas de photo avant 10:00' },
                { day: '2026-11-06', kind: 'bed', amount_cents: 1000, is_test: false, reason: 'Instagram ouvert à 01:24' }] }
    : await rpc('get_month_recap', { p_month: historyMonth });

  const rows = r.fines.length
    ? r.fines.slice().reverse().map((f) => `
        <div class="ledger">
          <div><span class="num">${esc(shortDay(f.day))}</span> · ${esc(kindLabel(f.kind))}${f.is_test ? ' <span class="tag">TEST</span>' : ''}
            <div class="muted small">${esc(f.reason)}</div></div>
          <div class="num ${f.is_test ? 'muted' : 'accent'}">${esc(euros(f.amount_cents))}</div>
        </div>`).join('')
    : '<p class="muted">Aucune amende ce mois.</p>';

  app.innerHTML = `
    <div class="month-nav">
      <button class="icon-btn" id="prev" aria-label="Mois précédent">‹</button>
      <h1>${esc(monthLabel(r.month))}</h1>
      <button class="icon-btn" id="next" aria-label="Mois suivant">›</button>
    </div>
    <div class="card">
      <div class="row"><span>Total dû</span><span class="num accent">${esc(euros(r.due_cents))}</span></div>
      ${r.test_cents ? `<div class="row"><span>TEST (non déduit)</span><span class="num muted">${esc(euros(r.test_cents))}</span></div>` : ''}
      <div class="row"><span>Reste de la caution</span><span class="num ${r.remaining_cents < 0 ? 'accent' : ''}">${
        r.deposit_cents ? esc(r.remaining_cents >= 0 ? euros(r.remaining_cents) : `${euros(-r.remaining_cents)} à compléter`) : '—'}</span></div>
      <div class="row"><span>Jours libres</span><span class="num">${r.free_count}</span></div>
      <div class="row"><span>Jours sans signal</span><span class="num">${r.silent_days}</span></div>
    </div>
    <button class="btn" id="share">Partager le récap</button>
    <p class="msg" id="share-msg"></p>
    <h2>Grand livre</h2>
    ${rows}`;

  $('#prev').addEventListener('click', () => { historyMonth = shiftMonth(historyMonth, -1); renderHistory(); });
  $('#next').addEventListener('click', () => { historyMonth = shiftMonth(historyMonth, 1); renderHistory(); });
  $('#share').addEventListener('click', async () => {
    const text = recapText(r);
    if (navigator.share) {
      try {
        await navigator.share({ title: `Nonrefundable, ${monthLabel(r.month)}`, text });
      } catch {
        // partage annulé
      }
    } else {
      await copy(text, $('#share-msg'));
    }
  });
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
      <li>Touche la flèche de l'action. Laisse la méthode sur <b>GET</b>. Dans <b>En-têtes</b>, ajoute la clé <b>Authorization</b> avec la valeur ci-dessous.</li>
      <li>Touche <b>OK</b>. Recommence avec <b>TikTok</b> et l'URL TikTok.</li>
      <li>Vérifie : lance un scénario coucher ci-dessous, ouvre Instagram, reviens ici.</li>
    </ol>
    ${copyField('url-ig', 'URL Instagram', `${SIGNAL_URL}?app=instagram`)}
    ${copyField('url-tt', 'URL TikTok', `${SIGNAL_URL}?app=tiktok`)}
    ${token ? copyField('auth-header', 'Valeur de l\'en-tête Authorization', header) : ''}`;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------
function base64UrlToBytes(s) {
  const b64 = (s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function pushState() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

async function enablePush() {
  if (!('PushManager' in window) || !('Notification' in window)) {
    throw new Error(isStandalone
      ? 'Notifications non prises en charge (iOS 16.4 minimum).'
      : 'Ouvre l\'appli depuis l\'icône de l\'écran d\'accueil pour activer les notifications.');
  }
  // Demandée en premier, directement dans le geste (exigence iOS).
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Autorisation refusée. Réglages iOS, Notifications, Nonrefundable.');
  const key = await rpc('get_vapid_public_key');
  if (!key) throw new Error('Clé serveur absente. Réessaie dans une minute.');
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription())
    || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(key) });
  const j = sub.toJSON();
  await rpc('save_push_subscription', { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth });
}

const PUSH_LABELS = {
  on: 'Activées sur cet appareil.',
  off: 'Désactivées sur cet appareil.',
  denied: 'Bloquées. Réglages iOS, Notifications, Nonrefundable.',
  unsupported: 'Non disponibles ici. Ouvre l\'appli depuis l\'écran d\'accueil (iOS 16.4 minimum).',
};

async function renderSettings() {
  const { data: { user } } = DEMO ? { data: { user: { email: EMAIL } } } : await sb.auth.getUser();
  const st = DEMO ? { has_token: false } : await rpc('get_shortcut_status');
  const cfg = DEMO ? { deposit: null, real_start_date: '2026-11-06', start_editable: false } : await rpc('get_settings');
  const push = await pushState();
  const dep = cfg.deposit || {};

  const signal = st.last_signal_at
    ? `Dernier signal : ${esc(st.last_signal_app === 'tiktok' ? 'TikTok' : 'Instagram')}, ${esc(dateTime(st.last_signal_at))}.`
    : 'Aucun signal reçu.';

  app.innerHTML = `
    <h1>Réglages</h1>

    <h2>Caution</h2>
    <div class="stack">
      <div><label for="dep-amount">Montant versé (€)</label>
        <input id="dep-amount" type="number" inputmode="decimal" min="1" step="1" value="${dep.amount_cents ? dep.amount_cents / 100 : ''}"></div>
      <div><label for="dep-friend">Prénom de l'ami</label>
        <input id="dep-friend" type="text" autocomplete="off" maxlength="60" value="${esc(dep.friend_name || '')}"></div>
      <div><label for="dep-date">Date du versement</label>
        <input id="dep-date" type="date" value="${esc(dep.paid_on || '')}"></div>
      <button class="btn secondary" id="dep-save">Enregistrer la caution</button>
      <p class="msg" id="dep-msg"></p>
    </div>

    <h2>Date de début</h2>
    <div class="stack">
      <p>Réel à partir du coucher du <b>${esc(dayLabel(cfg.real_start_date))}</b>. Avant : amendes TEST, non déduites.</p>
      ${cfg.start_editable ? `
        <input id="start-date" type="date" value="${esc(cfg.real_start_date)}">
        <button class="btn secondary" id="start-save">Changer la date de début</button>` :
        '<p class="muted small">Date passée : verrouillée.</p>'}
      <p class="msg" id="start-msg"></p>
    </div>

    <h2>Notifications</h2>
    <div class="stack">
      <p id="push-state">${esc(PUSH_LABELS[push])}</p>
      ${push !== 'on' ? '<button class="btn" id="push-on">Activer les notifications</button>' : ''}
      <button class="btn secondary" id="push-test">Tester les deux notifications</button>
      <p class="msg" id="push-msg"></p>
    </div>

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
      <button class="btn secondary" id="scenario-wake">Scénario photo (s'ouvre dans 1 à 2 min)</button>
      <p class="msg" id="scenario-msg"></p>
    </div>

    <h2>Compte</h2>
    <div class="stack">
      <p class="muted">${esc(user?.email)}</p>
      <button class="btn secondary" id="logout">Se déconnecter</button>
    </div>`;

  bindCopyButtons($('#token-msg'));

  $('#dep-save').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const amount = Math.round(Number(String($('#dep-amount').value).replace(',', '.')) * 100);
      await rpc('set_deposit', { p_amount_cents: amount, p_friend_name: $('#dep-friend').value, p_paid_on: $('#dep-date').value || null });
      say($('#dep-msg'), 'Caution enregistrée.');
    } catch (err) {
      say($('#dep-msg'), err.message, true);
    } finally {
      e.target.disabled = false;
    }
  });

  $('#start-save')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await rpc('set_start_date', { p_date: $('#start-date').value });
      say($('#start-msg'), 'Date de début enregistrée.');
    } catch (err) {
      say($('#start-msg'), err.message, true);
    } finally {
      e.target.disabled = false;
    }
  });

  $('#push-on')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await enablePush();
      say($('#push-state'), PUSH_LABELS.on);
      e.target.hidden = true;
    } catch (err) {
      say($('#push-msg'), err.message, true);
    } finally {
      e.target.disabled = false;
    }
  });

  $('#push-test').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await rpc('queue_test_push');
      say($('#push-msg'), 'Envoyées. Elles arrivent en quelques secondes, même téléphone verrouillé.');
    } catch (err) {
      say($('#push-msg'), err.message, true);
    } finally {
      e.target.disabled = false;
    }
  });

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

  $('#scenario-wake').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const o = await rpc('start_scenario', { p_kind: 'wake' });
      say($('#scenario-msg'), `Fenêtre photo TEST de ${hhmm(o.window_start)} à ${hhmm(o.window_end)}. Essaie une photo maintenant (refusée), puis après l'ouverture (acceptée).`);
      setTimeout(() => { location.hash = '#/photo'; }, 2500);
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
