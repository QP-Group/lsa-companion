// Port of send_followups.py — nudges a lead that got the initial
// auto-reply but still hasn't had a genuine human response, sent
// automatically on schedule rather than whenever someone remembers to
// run this by hand (same reasoning as auto-reply's port).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getAccessToken } from '../_shared/google-ads.ts'

const FOLLOWUP_DELAY_HOURS = 24
const FINAL_FOLLOWUP_DELAY_HOURS = 72 // day 3: the last message, then we stop
const FOLLOWUP_MAX_AGE_HOURS = 24 * 7 // don't nudge on leads older than a week

// Wording approved by the owner (QP Operations approval #7, 2 Nov 2026). The link is the same
// per-lead book.html link the auto-reply sends; the URL stays at the end (iOS link previews).
const bookingLink = (leadId: string) => `https://vertexcare.co.uk/book.html?lsa=${leadId}`
const FOLLOWUP_TEMPLATE = (leadId: string) =>
  `Hi again, just checking in. You can see your price and book in 30 seconds here: ${bookingLink(leadId)}`
const FINAL_FOLLOWUP_TEMPLATE =
  "Still need a hand? Reply with your postcode, the type of home (house, bungalow or flat) and how many bedrooms, and we'll send your price."

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function sendConversation(
  customerId: string,
  leadResourceName: string,
  text: string,
  accessToken: string,
): Promise<{ ok: boolean; detail: unknown }> {
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
        conversations: [{ localServicesLead: leadResourceName, text }],
      }),
    },
  )
  const detail = await response.json()
  // See auto-reply/index.ts for why this checks partialFailureError,
  // not just response.ok — Google returns HTTP 200 even on a genuine
  // per-item failure.
  const partialFailure = (detail as any)?.responses?.[0]?.partialFailureError
  return { ok: response.ok && !partialFailure, detail }
}

Deno.serve(async (req) => {
  try {
    const { business_id } = await req.json()
    if (!business_id) return jsonResponse({ error: 'business_id is required' }, 400)

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    const { data: business } = await supabase
      .from('businesses')
      .select('id, name, google_ads_customer_id, status')
      .eq('id', business_id)
      .single()
    if (!business) return jsonResponse({ error: 'business not found' }, 404)
    if (business.status !== 'active') return jsonResponse({ skipped: true, reason: 'not active' })

    const now = Date.now()
    const hoursAgo = (h: number) => new Date(now - h * 3600_000).toISOString()

    // Two nudges, each only for leads nobody has answered, whose customer hasn't filled in the
    // form and hasn't replied in the chat either (a chat reply goes to the owner as a card
    // instead, see chat-cards). 1st: 24h after the lead. 2nd and last: day 3.
    const base = () => supabase
      .from('leads')
      .select('id, google_lead_id, auto_reply_sent_at, follow_up_sent')
      .eq('business_id', business_id)
      .eq('lead_type', 'MESSAGE')
      .eq('responded', false)
      .eq('auto_reply_sent', true)
      .is('form_submitted_at', null)
      .gte('google_created_at', hoursAgo(FOLLOWUP_MAX_AGE_HOURS))
    const { data: first } = await base().eq('follow_up_sent', false).lte('google_created_at', hoursAgo(FOLLOWUP_DELAY_HOURS))
    const { data: final } = await base().eq('follow_up_sent', true).eq('follow_up_2_sent', false)
      .lte('google_created_at', hoursAgo(FINAL_FOLLOWUP_DELAY_HOURS))
    let candidates = [...(first ?? []), ...(final ?? [])]

    if (candidates.length) {
      const { data: replies } = await supabase
        .from('conversation_messages')
        .select('lead_id, event_date_time')
        .in('lead_id', candidates.map((c) => c.id))
        .eq('participant_type', 'CONSUMER')
      const repliedAfterUs = new Set(
        (replies ?? [])
          .filter((m) => {
            const lead = candidates.find((c) => c.id === m.lead_id)
            return lead?.auto_reply_sent_at && m.event_date_time && Date.parse(m.event_date_time) > Date.parse(lead.auto_reply_sent_at)
          })
          .map((m) => m.lead_id),
      )
      candidates = candidates.filter((c) => !repliedAfterUs.has(c.id))
    }

    if (!candidates.length) return jsonResponse({ followedUpWith: 0 })

    const { data: refreshToken } = await supabase.rpc('get_refresh_token', { p_business_id: business_id })
    if (!refreshToken) return jsonResponse({ error: 'no refresh token configured' }, 500)

    const accessToken = await getAccessToken(
      refreshToken,
      Deno.env.get('GOOGLE_CLIENT_ID')!,
      Deno.env.get('GOOGLE_CLIENT_SECRET')!,
    )
    const customerId = business.google_ads_customer_id.replace(/-/g, '')

    let followedUpWith = 0
    const failures: { lead_id: number; error: unknown }[] = []

    for (const lead of candidates) {
      const leadResourceName = `customers/${customerId}/localServicesLeads/${lead.google_lead_id}`
      const isFinal = lead.follow_up_sent === true
      const text = isFinal ? FINAL_FOLLOWUP_TEMPLATE : FOLLOWUP_TEMPLATE(lead.id)
      const result = await sendConversation(customerId, leadResourceName, text, accessToken)
      if (result.ok) {
        await supabase.from('leads').update(isFinal ? { follow_up_2_sent: true } : { follow_up_sent: true }).eq('id', lead.id)
        followedUpWith++
      } else {
        failures.push({ lead_id: lead.google_lead_id, error: result.detail })
      }
    }

    return jsonResponse({ followedUpWith, failed: failures.length, failures })
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500)
  }
})
