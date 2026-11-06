// Envoie une notification Web Push à tous les appareils d'un utilisateur.
// Appelée uniquement par Postgres (pg_net) avec le secret interne rangé dans Vault.
// Au premier appel, crée les clés VAPID et les range dans Vault (jamais ailleurs).
import * as webpush from 'jsr:@negrel/webpush@0.5.0';
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';

const CONTACT = 'https://aperrigot.github.io/nonrefundable/';

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let appServer: webpush.ApplicationServer | null = null;
let internalSecret = '';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function sameSecret(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function init() {
  const { data, error } = await sb.rpc('edge_push_config');
  if (error) throw new Error(error.message);
  internalSecret = data.internal_secret ?? '';
  let exported = data.vapid_keys;
  if (!exported) {
    const keys = await webpush.generateVapidKeys({ extractable: true });
    const stored = await sb.rpc('edge_store_vapid_keys', {
      p_keys: await webpush.exportVapidKeys(keys),
      p_public: await webpush.exportApplicationServerKey(keys),
    });
    if (stored.error) throw new Error(stored.error.message);
    exported = stored.data;
  }
  const vapidKeys = await webpush.importVapidKeys(exported, { extractable: false });
  appServer = await webpush.ApplicationServer.new({ contactInformation: CONTACT, vapidKeys });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ ok: false, error: 'method' }, 405);
  try {
    if (!appServer) await init();
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
  if (!sameSecret(req.headers.get('x-internal-secret') ?? '', internalSecret)) {
    return json({ ok: false, error: 'secret' }, 401);
  }

  const body = await req.json().catch(() => ({}));
  if (body.action === 'init') return json({ ok: true });

  const { data: subs } = await sb.from('push_subscriptions')
    .select('id, endpoint, p256dh, auth').eq('user_id', body.user_id);
  const payload = JSON.stringify({ title: body.title, body: body.body, url: body.url });
  const errors: string[] = [];
  let sent = 0;

  for (const s of subs ?? []) {
    try {
      await appServer!.subscribe({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } })
        .pushTextMessage(payload, { ttl: 3600 });
      sent++;
      await sb.from('push_subscriptions').update({ last_ok_at: new Date().toISOString() }).eq('id', s.id);
    } catch (e) {
      const status = (e as { response?: Response }).response?.status;
      if (status === 404 || status === 410) await sb.from('push_subscriptions').delete().eq('id', s.id);
      errors.push(`${status ?? ''} ${String(e)}`.trim());
    }
  }

  const status = !subs?.length ? 'no_subscription' : sent ? 'sent' : 'failed';
  if (body.log_id) await sb.from('notification_log').update({ status }).eq('id', body.log_id);
  return json({ ok: sent > 0, sent, status, errors });
});
