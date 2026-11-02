// chat-cards — when a customer replies in the Google LSA chat (instead of using the quote form),
// send their message to the business's own lead channel so the owner can answer in seconds.
// Owner approval (QP Operations #8, 2 Nov 2026): for Vertex the channel is the "Vertex Leads"
// Telegram bot, which runs in Vertex's CRM (lead-router function, route /lsa-chat). The card there
// shows the message and a suggested reply; the owner taps Send / Write my own / Skip, and the
// reply comes back through this project's chat-reply function to Google.
//
// Runs on the cron schedule (dispatch_edge_function, one call per active business). A business
// takes part only when businesses.chat_card_url is set; otherwise this does nothing for it.
//
// Which messages: CONSUMER messages in the last 48 hours, after this Companion's auto-reply to
// that lead (the first message already got the auto-reply), not yet carded. Each message is
// carded once (conversation_messages.card_sent_at). Oldest first.
//
// Data: the customer's message text leaves this project for the business's own channel. The
// owner agreed to this for Vertex (2 Nov 2026). The lead's phone number is not sent.
//
// Secret: CHAT_CARD_SECRET (the same value is set on Vertex's CRM as Vault secret
// lsa_chat_secret). Sent in the x-companion-secret header. If it isn't set, nothing is sent.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const WINDOW_HOURS = 48

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

Deno.serve(async (req) => {
  try {
    const { business_id } = await req.json()
    if (!business_id) return jsonResponse({ error: 'business_id is required' }, 400)
    const secret = Deno.env.get('CHAT_CARD_SECRET') ?? ''
    if (!secret) return jsonResponse({ skipped: true, reason: 'CHAT_CARD_SECRET not set' })

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    const { data: business } = await supabase
      .from('businesses')
      .select('id, status, chat_card_url')
      .eq('id', business_id)
      .single()
    if (!business) return jsonResponse({ error: 'business not found' }, 404)
    if (business.status !== 'active' || !business.chat_card_url) return jsonResponse({ skipped: true })

    const since = new Date(Date.now() - WINDOW_HOURS * 3600_000).toISOString()
    const { data: messages } = await supabase
      .from('conversation_messages')
      .select('id, lead_id, text, event_date_time, attachment_urls')
      .eq('business_id', business_id)
      .eq('participant_type', 'CONSUMER')
      .is('card_sent_at', null)
      .gte('event_date_time', since)
      .order('event_date_time', { ascending: true })
      .limit(20)
    if (!messages || !messages.length) return jsonResponse({ carded: 0 })

    const { data: leads } = await supabase
      .from('leads')
      .select('id, auto_reply_sent_at, form_submitted_at, archived')
      .in('id', [...new Set(messages.map((m) => m.lead_id))])
    const byId = new Map((leads ?? []).map((l) => [l.id, l]))

    let carded = 0
    const failures: { message_id: string; error: string }[] = []
    for (const m of messages) {
      const lead = byId.get(m.lead_id)
      // Only replies that came after our auto-reply; the first message already had one.
      if (!lead || lead.archived || !lead.auto_reply_sent_at || !m.event_date_time ||
          Date.parse(m.event_date_time) <= Date.parse(lead.auto_reply_sent_at)) continue
      const hasText = !!(m.text && String(m.text).trim())
      const photos = (m.attachment_urls ?? []).length
      if (!hasText && !photos) continue
      try {
        const res = await fetch(business.chat_card_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-companion-secret': secret },
          body: JSON.stringify({
            lsa_lead_id: m.lead_id,
            message_id: m.id,
            text: hasText ? String(m.text).slice(0, 2000) : '',
            photos,
            received_at: m.event_date_time,
            form_submitted: !!lead.form_submitted_at,
          }),
          signal: AbortSignal.timeout(10_000),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
        await supabase.from('conversation_messages').update({ card_sent_at: new Date().toISOString() }).eq('id', m.id)
        carded++
      } catch (e) {
        failures.push({ message_id: m.id, error: String(e) })
      }
    }
    return jsonResponse({ carded, failed: failures.length, failures })
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500)
  }
})
