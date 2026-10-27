// Closes two gaps at once: the original send_missed_call_alerts.py
// (emails the business so a human calls back) was built months ago but
// never ported to the cloud pipeline, and separately, nothing has ever
// told the CUSTOMER their call was missed in real time.
//
// Reuses AppendLeadConversation — the same mechanism already proven
// live for message auto-replies — on a PHONE_CALL lead instead of a
// MESSAGE one. This is genuinely untested against a real phone-call
// lead as of writing (conversation_channel on LocalServicesLeadConversation
// is documented as output-only, and our request never specifies a
// channel/type at all, which is good evidence it isn't restricted by
// lead_type — but it's still evidence, not proof). First real use
// against a genuinely fresh missed call is the actual test.
//
// Tracking design: missed_call_alert_sent is set true once the EMAIL
// to the business succeeds, not once the customer text succeeds. The
// email is the more important, more reliable action (same Resend path
// already proven across three other functions) and the one actually
// load-bearing for making sure a human follows up. If the customer
// text fails, re-trying it every 5 minutes forever would spam the
// business with duplicate "missed call" emails — so the text is
// best-effort, logged either way, but doesn't gate the tracking flag.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getAccessToken } from '../_shared/google-ads.ts'
import { sendEmail } from '../_shared/resend.ts'

const MAX_LEAD_AGE_HOURS = 24
const BUSINESS_TIMEZONE = 'Europe/London' // same hardcoded-until-per-business-field limitation as auto-reply

// Per-lead link — see the matching note in auto-reply/index.ts (same tag,
// same reason). URL kept at the very end of the message.
const bookingLink = (leadId: string) => `https://vertexcare.co.uk/book.html?lsa=${leadId}`

const TEMPLATE = (leadId: string) =>
  `Sorry we missed your call! We'll call you back as soon as we can. While you wait, feel free to fill in our quick quote form: ${bookingLink(leadId)}`

const AFTER_HOURS_TEMPLATE = (leadId: string) =>
  `Sorry we missed your call! We're currently closed — we'll call you back when we reopen. While you wait, feel free to fill in our quick quote form: ${bookingLink(leadId)}`

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

function generateText(business: { business_hours_start: number; business_hours_end: number }, leadId: string): string {
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
  // See auto-reply/index.ts — Google returns HTTP 200 even on a
  // genuine per-item failure, the real result is in
  // responses[].partialFailureError.
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
      .select('id, name, google_ads_customer_id, business_hours_start, business_hours_end, alert_email, status')
      .eq('id', business_id)
      .single()
    if (!business) return jsonResponse({ error: 'business not found' }, 404)
    if (business.status !== 'active') return jsonResponse({ skipped: true, reason: 'not active' })

    const cutoff = new Date(Date.now() - MAX_LEAD_AGE_HOURS * 3600_000).toISOString()
    const { data: candidates } = await supabase
      .from('leads')
      .select('id, google_lead_id, contact_phone')
      .eq('business_id', business_id)
      .eq('lead_type', 'PHONE_CALL')
      .eq('call_duration_millis', 0)
      .eq('missed_call_alert_sent', false)
      .gte('google_created_at', cutoff)

    if (!candidates || !candidates.length) return jsonResponse({ handled: 0 })

    let accessToken: string | null = null
    let customerId: string | null = null
    if (candidates.length) {
      const { data: refreshToken } = await supabase.rpc('get_refresh_token', { p_business_id: business_id })
      if (refreshToken) {
        accessToken = await getAccessToken(
          refreshToken,
          Deno.env.get('GOOGLE_CLIENT_ID')!,
          Deno.env.get('GOOGLE_CLIENT_SECRET')!,
        )
        customerId = business.google_ads_customer_id.replace(/-/g, '')
      }
    }

    let lastText = ''
    let handled = 0
    const textFailures: { lead_id: number; error: unknown }[] = []

    for (const lead of candidates) {
      let textResult: { ok: boolean; detail: unknown } = { ok: false, detail: 'no access token available' }
      if (accessToken && customerId) {
        const leadResourceName = `customers/${customerId}/localServicesLeads/${lead.google_lead_id}`
        const text = generateText(business, lead.id)
        lastText = text
        textResult = await sendConversation(customerId, leadResourceName, text, accessToken)
      }
      if (!textResult.ok) textFailures.push({ lead_id: lead.google_lead_id, error: textResult.detail })

      if (business.alert_email) {
        await sendEmail(
          business.alert_email,
          `Missed call${lead.contact_phone ? ' from ' + lead.contact_phone : ''}`,
          `<h2>Missed call for ${business.name}</h2>
           <p>Phone: <strong>${lead.contact_phone || 'unknown'}</strong></p>
           <p>${textResult.ok
             ? 'An automatic "sorry we missed your call" message was sent to the customer.'
             : 'The automatic text to the customer failed — call them back directly.'}</p>`,
        )
        await supabase.from('leads').update({ missed_call_alert_sent: true }).eq('id', lead.id)
        handled++
      }
    }

    return jsonResponse({ handled, textFailed: textFailures.length, textFailures, template: lastText })
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500)
  }
})
