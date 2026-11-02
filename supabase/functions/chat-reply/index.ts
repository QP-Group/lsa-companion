// chat-reply — sends a reply to an LSA customer through Google, on the business owner's say-so
// from their own lead channel (for Vertex: the "Vertex Leads" Telegram bot, where the owner taps
// Send on a suggested reply or writes their own). Owner approval: QP Operations #8, 2 Nov 2026.
//
// The owner chooses every message sent through here: the caller only passes on what the owner
// tapped or typed. Marks the lead responded (so no automatic follow-up goes after a real answer).
//
// Auth: server-to-server only, like form-received. Deploy with --no-verify-jwt; the shared secret
// in x-companion-secret must match CHAT_CARD_SECRET (constant-time). Fails closed without it.
//
// Body: { lsa_lead_id: uuid, text: string (1-1000 characters) }
// Deploy:  supabase functions deploy chat-reply --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getAccessToken } from '../_shared/google-ads.ts'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const x = enc.encode(a), y = enc.encode(b)
  let diff = x.length ^ y.length
  const n = Math.max(x.length, y.length)
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return jsonResponse({ error: 'method not allowed' }, 405)
  const expected = Deno.env.get('CHAT_CARD_SECRET') ?? ''
  if (!expected) return jsonResponse({ error: 'not configured' }, 500)
  if (!timingSafeEqual(req.headers.get('x-companion-secret') ?? '', expected)) return jsonResponse({ error: 'unauthorized' }, 401)

  let body: { lsa_lead_id?: unknown; text?: unknown }
  try { body = await req.json() } catch { return jsonResponse({ error: 'invalid json' }, 400) }
  const leadId = String(body?.lsa_lead_id ?? '')
  const text = String(body?.text ?? '').trim()
  if (!UUID_RE.test(leadId)) return jsonResponse({ error: 'lsa_lead_id must be a uuid' }, 400)
  if (!text || text.length > 1000) return jsonResponse({ error: 'text must be 1-1000 characters' }, 400)

  try {
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const { data: lead } = await supabase
      .from('leads')
      .select('id, business_id, google_lead_id, lead_type')
      .eq('id', leadId)
      .single()
    if (!lead) return jsonResponse({ error: 'lead not found' }, 404)
    if (lead.lead_type !== 'MESSAGE') return jsonResponse({ error: 'not a message lead' }, 400)

    const { data: business } = await supabase
      .from('businesses')
      .select('id, status, google_ads_customer_id')
      .eq('id', lead.business_id)
      .single()
    if (!business || business.status !== 'active') return jsonResponse({ error: 'business not active' }, 400)

    const { data: refreshToken } = await supabase.rpc('get_refresh_token', { p_business_id: business.id })
    if (!refreshToken) return jsonResponse({ error: 'no refresh token configured' }, 500)
    const accessToken = await getAccessToken(refreshToken, Deno.env.get('GOOGLE_CLIENT_ID')!, Deno.env.get('GOOGLE_CLIENT_SECRET')!)
    const customerId = business.google_ads_customer_id.replace(/-/g, '')

    const response = await fetch(
      `https://googleads.googleapis.com/v25/customers/${customerId}/localServices:appendLeadConversation`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'developer-token': Deno.env.get('GOOGLE_DEVELOPER_TOKEN')!,
          'login-customer-id': Deno.env.get('MANAGER_CUSTOMER_ID')!,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          conversations: [{ localServicesLead: `customers/${customerId}/localServicesLeads/${lead.google_lead_id}`, text }],
        }),
      },
    )
    const detail = await response.json().catch(() => ({}))
    // Google answers HTTP 200 even when the append failed; the real result is per item.
    const partialFailure = (detail as any)?.responses?.[0]?.partialFailureError
    if (!response.ok || partialFailure) {
      console.error('chat-reply', JSON.stringify(detail).slice(0, 500))
      return jsonResponse({ ok: false, error: 'Google did not accept the message' }, 502)
    }

    await supabase.from('leads').update({ responded: true }).eq('id', lead.id)
    return jsonResponse({ ok: true })
  } catch (err) {
    console.error('chat-reply', String(err))
    return jsonResponse({ ok: false, error: String(err) }, 500)
  }
})
