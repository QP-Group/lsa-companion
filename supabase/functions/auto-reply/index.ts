// Port of auto_reply.py — fixed-template auto-acknowledgment for new
// message leads, sent the moment they qualify rather than whenever
// someone remembers to run a script by hand. This is the piece that
// actually closes the original "response time" gap; DRY_RUN alone
// being off was never enough without this being on a real schedule.
//
// generate_reply() is deliberately the only thing a future AI upgrade
// would touch — trigger/send/tracking logic stays the same either way,
// same as the Python version's own design note.
//
// Real correctness fix made during this port, not a straight copy: the
// Python version used `datetime.now().hour`, i.e. whatever timezone
// the Mac running it happened to be in (confirmed Europe/London).
// There is no equivalent "local machine time" once this runs in
// Supabase's cloud infrastructure — using the server's raw UTC hour
// would silently be off by an hour for half the year (BST vs GMT).
// Hardcodes Europe/London explicitly via Intl instead, matching what
// the Mac was implicitly doing. Same known limitation as before, just
// now explicit: needs a real per-business timezone column before this
// can correctly serve businesses outside the UK.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getAccessToken } from '../_shared/google-ads.ts'

const MAX_LEAD_AGE_HOURS = 24
const BUSINESS_TIMEZONE = 'Europe/London' // see note above — hardcoded until a real per-business field exists

// Per-lead link (2026-10-25): the quote-form link now carries THIS lead's own
// id (?lsa=<uuid>) so Vertex's book.html can tag the enquiry with it and ping
// the form-received function when the form is filled in — which stops the
// 24h follow-up nudge. The id is the Companion's own random uuid, not a Google
// id, and no personal details travel in the link. URL stays at the very end of
// the message on purpose (iOS only renders a link preview card for a URL at the
// start or end).
const bookingLink = (leadId: string) => `https://vertexcare.co.uk/book.html?lsa=${leadId}`

// Wording approved by the owner (QP Operations approval #7, 2 Nov 2026): book.html now shows an
// instant price, and a customer who'd rather reply here is invited to send the details we need.
const TEMPLATE = (leadId: string) =>
  `Thanks for your message! You can see your price straight away here (it takes 30 seconds), or reply with your postcode and type of home and we'll send it: ${bookingLink(leadId)}`

const AFTER_HOURS_TEMPLATE = (leadId: string) =>
  `Thanks for your message! We're closed right now, but you can see your price straight away here (it takes 30 seconds), or reply with your postcode and type of home and we'll send it when we reopen: ${bookingLink(leadId)}`

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function currentHourInTimezone(timeZone: string): number {
  const hourStr = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: 'numeric',
    hourCycle: 'h23',
  }).format(new Date())
  return parseInt(hourStr, 10)
}

function generateReply(business: { business_hours_start: number; business_hours_end: number }, leadId: string): string {
  const hour = currentHourInTimezone(BUSINESS_TIMEZONE)
  const isAfterHours = !(hour >= business.business_hours_start && hour < business.business_hours_end)
  return isAfterHours ? AFTER_HOURS_TEMPLATE(leadId) : TEMPLATE(leadId)
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
  // Google's REST API returns HTTP 200 even when the append itself
  // failed — the real result is per-item inside responses[].
  // partialFailureError. Confirmed directly against a deliberately
  // invalid lead ID: got a clean 200 with an INTERNAL_ERROR buried in
  // the body. Checking response.ok alone would silently mark a failed
  // send as successful.
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
      .select('id, name, google_ads_customer_id, business_hours_start, business_hours_end, status')
      .eq('id', business_id)
      .single()
    if (!business) return jsonResponse({ error: 'business not found' }, 404)
    if (business.status !== 'active') return jsonResponse({ skipped: true, reason: 'not active' })

    const cutoff = new Date(Date.now() - MAX_LEAD_AGE_HOURS * 3600_000).toISOString()
    const { data: candidates } = await supabase
      .from('leads')
      .select('id, google_lead_id')
      .eq('business_id', business_id)
      .eq('lead_type', 'MESSAGE')
      .eq('lead_status', 'NEW')
      .eq('auto_reply_sent', false)
      .gte('google_created_at', cutoff)

    if (!candidates || !candidates.length) return jsonResponse({ repliedTo: 0 })

    const { data: refreshToken } = await supabase.rpc('get_refresh_token', { p_business_id: business_id })
    if (!refreshToken) return jsonResponse({ error: 'no refresh token configured' }, 500)

    const accessToken = await getAccessToken(
      refreshToken,
      Deno.env.get('GOOGLE_CLIENT_ID')!,
      Deno.env.get('GOOGLE_CLIENT_SECRET')!,
    )
    const customerId = business.google_ads_customer_id.replace(/-/g, '')
    let lastText = ''

    let repliedTo = 0
    const failures: { lead_id: number; error: unknown }[] = []

    for (const lead of candidates) {
      const leadResourceName = `customers/${customerId}/localServicesLeads/${lead.google_lead_id}`
      const text = generateReply(business, lead.id)
      lastText = text
      const result = await sendConversation(customerId, leadResourceName, text, accessToken)
      if (result.ok) {
        await supabase
          .from('leads')
          .update({ auto_reply_sent: true, auto_reply_sent_at: new Date().toISOString() })
          .eq('id', lead.id)
        repliedTo++
      } else {
        failures.push({ lead_id: lead.google_lead_id, error: result.detail })
      }
    }

    return jsonResponse({ repliedTo, failed: failures.length, failures, template: lastText })
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500)
  }
})
