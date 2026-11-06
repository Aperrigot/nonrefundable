// Appelée par l'automatisation Raccourcis à l'ouverture et à la fermeture
// d'Instagram ou de TikTok. Authentification par jeton secret (pas de JWT).
// Toute la logique (heure serveur, fenêtre de coucher, amende unique) est en SQL.
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ ok: false, error: 'method' }, 405);

  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return json({ ok: false, error: 'token' }, 401);

  // L'app peut venir du corps JSON {"app": "instagram"} ou de ?app=instagram.
  let app = new URL(req.url).searchParams.get('app') ?? '';
  if (!app) {
    try {
      const body = await req.json();
      app = String(body?.app ?? '');
    } catch {
      // corps absent ou non JSON
    }
  }

  const { data, error } = await sb.rpc('edge_app_signal', { p_token: token, p_app: app.trim() });
  if (error) return json({ ok: false, error: error.message }, 400);
  if (!data?.ok) return json(data, 401);
  return json(data);
});
