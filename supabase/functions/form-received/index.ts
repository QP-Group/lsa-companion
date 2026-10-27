// form-received — called BY Vertex's CRM (its lead-ack function) the moment a
// customer fills in the book.html quote form after arriving via the link
// this Companion sent them (book.html?lsa=<this lead's id>).
//
// Why it exists: send-followups nudges any message lead still marked
// responded = false 24 hours after the auto-reply ("just checking in on your
// enquiry…"). "Responded" is only set when someone replies inside this
// Companion — so a customer who had already filled in the form and been
// quoted from Vertex's own system would still get that nudge. This endpoint
// closes that gap: it marks the lead responded and records when the form
// arrived, so the nudge never fires and the lead drops out of "needs response".
//
// Auth: server-to-server only. Must be deployed with --no-verify-jwt (the
// caller has no Supabase login) and protects itself with a shared secret in
// the x-companion-secret header, compared in constant time against the
// FORM_RECEIVED_SECRET secret. Fails CLOSED if that secret isn't set.
//
// Idempotent: a repeat ping for the same lead changes nothing and still
// returns ok. Unknown lead id → 404 (so a wrong/forged id is visible, not
// silently accepted).
//
// Deploy:   supabase functions deploy form-received --no-verify-jwt
// Secret:   supabase secrets set FORM_RECEIVED_SECRET=<same value Vertex uses>

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// Constant-time string compare so response timing can't leak the secret.
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const x = enc.encode(a)
  const y = enc.encode(b)
  let diff = x.length ^ y.length
  const n = Math.max(x.length, y.length)
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return jsonResponse({ error: 'method not allowed' }, 405)

  const expected = Deno.env.get('FORM_RECEIVED_SECRET') ?? ''
  if (!expected) return jsonResponse({ error: 'not configured' }, 500)
  const provided = req.headers.get('x-companion-secret') ?? ''
  if (!timingSafeEqual(provided, expected)) return jsonResponse({ error: 'unauthorized' }, 401)

  let body: { lsa_lead_id?: unknown }
  try {
    body = await req.json()
  } catch {
    return jsonResponse({ error: 'invalid json' }, 400)
  }
  const leadId = String(body?.lsa_lead_id ?? '')
  if (!UUID_RE.test(leadId)) return jsonResponse({ error: 'lsa_lead_id must be a uuid' }, 400)

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  // Only flips a lead that hasn't already been marked — that's what makes a
  // repeat ping harmless.
  const { data: updated, error } = await supabase
    .from('leads')
    .update({ responded: true, form_submitted_at: new Date().toISOString() })
    .eq('id', leadId)
    .is('form_submitted_at', null)
    .select('id')
  if (error) return jsonResponse({ error: error.message }, 500)
  if (updated && updated.length) return jsonResponse({ ok: true, marked: true })

  const { data: existing, error: lookupError } = await supabase
    .from('leads')
    .select('id')
    .eq('id', leadId)
    .maybeSingle()
  if (lookupError) return jsonResponse({ error: lookupError.message }, 500)
  if (!existing) return jsonResponse({ error: 'lead not found' }, 404)
  return jsonResponse({ ok: true, marked: false, reason: 'already recorded' })
})
