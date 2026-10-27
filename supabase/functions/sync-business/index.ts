// Cloud-native port of sync_leads.py — the foundational piece everything
// else (alerts, anomaly checks, follow-ups) depends on having fresh data
// first. One invocation per business (not one big loop over all
// businesses), so one business's API hiccup can't stall or crash
// everyone else's sync — the architectural upgrade that was the actual
// point of this rewrite, not just a language port.
//
// Read-only against Google (same as the Python version) — this function
// only writes to our own Supabase tables, never to Google.
//
// Secrets needed (set via `supabase secrets set`):
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_DEVELOPER_TOKEN,
//   MANAGER_CUSTOMER_ID
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are auto-injected.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getAccessToken, gaqlSearch } from '../_shared/google-ads.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

async function syncLeads(supabase: any, accessToken: string, opts: any, businessId: string) {
  const query = `
    SELECT
      local_services_lead.id,
      local_services_lead.lead_type,
      local_services_lead.lead_status,
      local_services_lead.lead_charged,
      local_services_lead.lead_feedback_submitted,
      local_services_lead.contact_details,
      local_services_lead.locale,
      local_services_lead.creation_date_time,
      local_services_lead.credit_details.credit_state,
      local_services_lead.category_id,
      local_services_lead.service_id
    FROM local_services_lead
  `
  const rows = await gaqlSearch({ ...opts, accessToken, query })

  const now = new Date().toISOString()
  const records = rows.map((row) => {
    const l = row.localServicesLead
    return {
      business_id: businessId,
      google_lead_id: parseInt(l.id),
      lead_type: l.leadType,
      lead_status: l.leadStatus,
      lead_charged: l.leadCharged || false,
      lead_feedback_submitted: l.leadFeedbackSubmitted || false,
      contact_phone: l.contactDetails?.phoneNumber || null,
      locale: l.locale || null,
      google_created_at: l.creationDateTime ? l.creationDateTime.split('.')[0] : null,
      credit_state: l.creditDetails?.creditState || 'UNSPECIFIED',
      category_id: l.categoryId || null,
      service_id: l.serviceId || null,
      // Explicit, not relied on as a column default — a default only
      // applies on INSERT, never on an upsert's UPDATE path, which is
      // exactly why every pre-existing lead kept showing a two-month-old
      // synced_at even while the sync was (when the token worked)
      // genuinely re-confirming them successfully every 30 minutes.
      synced_at: now,
    }
  })

  if (records.length) {
    const { error } = await supabase
      .from('leads')
      .upsert(records, { onConflict: 'business_id,google_lead_id' })
    if (error) throw new Error(`leads upsert failed: ${JSON.stringify(error)}`)
  }
  return records.length
}

async function syncConversations(supabase: any, accessToken: string, opts: any, businessId: string) {
  const query = `
    SELECT
      local_services_lead_conversation.id,
      local_services_lead_conversation.lead,
      local_services_lead_conversation.conversation_channel,
      local_services_lead_conversation.participant_type,
      local_services_lead_conversation.event_date_time,
      local_services_lead_conversation.phone_call_details.call_duration_millis,
      local_services_lead_conversation.message_details.text,
      local_services_lead_conversation.message_details.attachment_urls
    FROM local_services_lead_conversation
  `
  const rows = await gaqlSearch({ ...opts, accessToken, query })

  const { data: leadRows } = await supabase
    .from('leads')
    .select('id, google_lead_id')
    .eq('business_id', businessId)
  const internalIdByGoogleId = new Map(leadRows.map((r: any) => [r.google_lead_id, r.id]))

  const maxDurationByLead = new Map<number, number>()
  const messageRows: any[] = []

  for (const row of rows) {
    const conv = row.localServicesLeadConversation
    const googleLeadId = parseInt(conv.lead.split('/').pop())

    const duration = conv.phoneCallDetails?.callDurationMillis
      ? parseInt(conv.phoneCallDetails.callDurationMillis)
      : null
    if (duration !== null) {
      maxDurationByLead.set(googleLeadId, Math.max(duration, maxDurationByLead.get(googleLeadId) || 0))
    }

    const internalLeadId = internalIdByGoogleId.get(googleLeadId)
    if (internalLeadId) {
      messageRows.push({
        business_id: businessId,
        lead_id: internalLeadId,
        google_conversation_id: parseInt(conv.id),
        participant_type: conv.participantType,
        channel: conv.conversationChannel,
        text: conv.messageDetails?.text || null,
        attachment_urls: conv.messageDetails?.attachmentUrls?.length ? conv.messageDetails.attachmentUrls : null,
        event_date_time: conv.eventDateTime ? conv.eventDateTime.split('.')[0] : null,
      })
    }
  }

  let updated = 0
  for (const [googleLeadId, duration] of maxDurationByLead.entries()) {
    const { error, count } = await supabase
      .from('leads')
      .update({ call_duration_millis: duration }, { count: 'exact' })
      .eq('business_id', businessId)
      .eq('google_lead_id', googleLeadId)
    if (!error && count) updated++
  }

  if (messageRows.length) {
    const { error } = await supabase
      .from('conversation_messages')
      .upsert(messageRows, { onConflict: 'business_id,google_conversation_id' })
    if (error) throw new Error(`conversation_messages upsert failed: ${JSON.stringify(error)}`)
  }

  return { leadsUpdated: updated, messagesSynced: messageRows.length }
}

async function syncDailyCost(supabase: any, accessToken: string, opts: any, businessId: string) {
  const end = new Date()
  const start = new Date(end.getTime() - 30 * 86400000)
  const fmt = (d: Date) => d.toISOString().split('T')[0]

  const query = `
    SELECT metrics.cost_micros, segments.date
    FROM customer
    WHERE segments.date BETWEEN "${fmt(start)}" AND "${fmt(end)}"
  `
  const rows = await gaqlSearch({ ...opts, accessToken, query })

  const records = rows.map((row) => ({
    business_id: businessId,
    date: row.segments.date,
    cost_micros: parseInt(row.metrics.costMicros || '0'),
  }))

  if (records.length) {
    const { error } = await supabase
      .from('daily_cost')
      .upsert(records, { onConflict: 'business_id,date' })
    if (error) throw new Error(`daily_cost upsert failed: ${JSON.stringify(error)}`)
  }
  return records.length
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const { business_id } = await req.json()
    if (!business_id) return jsonResponse({ error: 'business_id is required' }, 400)

    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
    const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

    const { data: business } = await supabase
      .from('businesses')
      .select('id, name, google_ads_customer_id, status')
      .eq('id', business_id)
      .single()
    if (!business) return jsonResponse({ error: 'business not found' }, 404)
    if (business.status !== 'active') return jsonResponse({ skipped: true, reason: 'not active' })

    const { data: refreshToken } = await supabase.rpc('get_refresh_token', { p_business_id: business_id })
    if (!refreshToken) return jsonResponse({ error: 'no refresh token configured' }, 500)

    const accessToken = await getAccessToken(
      refreshToken,
      Deno.env.get('GOOGLE_CLIENT_ID')!,
      Deno.env.get('GOOGLE_CLIENT_SECRET')!,
    )

    const customerId = business.google_ads_customer_id.replace(/-/g, '')
    const opts = {
      customerId,
      developerToken: Deno.env.get('GOOGLE_DEVELOPER_TOKEN')!,
      loginCustomerId: Deno.env.get('MANAGER_CUSTOMER_ID')!,
    }

    const leadsCount = await syncLeads(supabase, accessToken, opts, business_id)
    const conversationResult = await syncConversations(supabase, accessToken, opts, business_id)
    const costDaysCount = await syncDailyCost(supabase, accessToken, opts, business_id)

    return jsonResponse({
      success: true,
      business: business.name,
      leadsSynced: leadsCount,
      conversationsSynced: conversationResult,
      costDaysSynced: costDaysCount,
    })
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500)
  }
})
