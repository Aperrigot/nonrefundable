// Reçoit la photo de réveil (JPEG brut, < 150 Ko), l'horodate avec l'heure de
// Postgres une fois le corps entièrement reçu, puis la range dans Storage.
// La décision (fenêtre, seconde limite) est prise en SQL : edge_stamp_wake_proof.
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';

const ORIGIN = 'https://aperrigot.github.io';
const MAX_BYTES = 153600;

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const cors = {
  'Access-Control-Allow-Origin': ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Vary': 'Origin',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ accepted: false, reason: 'Méthode non autorisée.' }, 405);

  const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  const { data: auth, error: authError } = await sb.auth.getUser(jwt);
  if (authError || !auth?.user) return json({ accepted: false, reason: 'Session expirée. Reconnecte-toi.' }, 401);

  // Corps entièrement reçu avant l'horodatage : c'est l'heure de réception qui compte.
  const photo = new Uint8Array(await req.arrayBuffer());
  if (photo.length === 0) return json({ accepted: false, reason: 'Photo vide.' }, 400);
  if (photo.length > MAX_BYTES) return json({ accepted: false, reason: 'Photo trop lourde (150 Ko max).' }, 413);
  if (photo[0] !== 0xff || photo[1] !== 0xd8 || photo[2] !== 0xff) {
    return json({ accepted: false, reason: 'Format non reconnu (JPEG attendu).' }, 415);
  }

  const { data: stamp, error } = await sb.rpc('edge_stamp_wake_proof', { p_user: auth.user.id, p_bytes: photo.length });
  if (error) return json({ accepted: false, reason: error.message }, 400);
  if (!stamp.accepted) return json(stamp, 422);

  const { error: uploadError } = await sb.storage.from('proofs').upload(stamp.storage_path, photo, {
    contentType: 'image/jpeg',
    upsert: false,
  });
  if (uploadError) {
    // Reçue à temps : acceptée quand même, la faute est au stockage.
    await sb.rpc('edge_proof_storage_failed', { p_proof: stamp.proof_id });
    return json({ ...stamp, storage_failed: true });
  }
  return json(stamp);
});
