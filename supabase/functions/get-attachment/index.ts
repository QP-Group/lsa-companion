// Proxies a single message attachment (e.g. a photo a lead sent) from
// Google to the dashboard. Exists because Google's attachment_urls
// require an authorized OAuth credential to actually download the
// bytes — the browser only ever holds a Supabase session, never a
// Google token, so it can't fetch those URLs directly. This function
// holds the one thing that can: the business's refresh token.
//
// [UNVERIFIED]: Google's own v25 field reference says these URLs "can
// be used to download the contents of the attachment using authorized
// Google Cloud project credentials" — vaguer than the plain developer-
// token wording older API versions used for this same field. The
// closest, most likely reading is an OAuth bearer token from a client
// under the authorized Cloud project (i.e. the same access token every
// other call in this project already uses), so that's what's sent
// below, with the developer-token header also attached since it's
// free to include and was the documented requirement on older
// versions. Neither has been tested against a real attachment as of
// writing — there has been no real picture-bearing lead yet. Treat the
// first real attachment load as the actual test, and check the error
// detail carefully if it 401s/403s.
//
// Secrets needed (already set for this project):
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_DEVELOPER_TOKEN
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY are auto-injected.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'GET') return jsonResponse({ error: 'method not allowed' }, 405)

  try {
    const url = new URL(req.url)
    const messageId = url.searchParams.get('message_id')
    const index = parseInt(url.searchParams.get('index') || '0', 10)
    if (!messageId) return jsonResponse({ error: 'message_id is required' }, 400)

    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
    const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!

    // Same pattern as send-reply: verify the caller is a real logged-in
    // user before doing anything privileged.
    const authHeader = req.headers.get('Authorization') ?? ''
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: { user }, error: authError } = await userClient.auth.getUser()
    if (authError || !user) return jsonResponse({ error: 'unauthorized' }, 401)

    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

    const { data: message } = await adminClient
      .from('conversation_messages')
      .select('id, business_id, attachment_urls')
      .eq('id', messageId)
      .single()
    if (!message) return jsonResponse({ error: 'message not found' }, 404)

    const attachmentUrl = message.attachment_urls?.[index]
    if (!attachmentUrl) return jsonResponse({ error: 'no attachment at that index' }, 404)

    // Explicit authorization check — don't rely on the caller only being
    // able to construct valid message_ids for their own business.
    const { data: membership } = await adminClient
      .from('business_members')
      .select('business_id')
      .eq('business_id', message.business_id)
      .eq('user_id', user.id)
      .single()
    if (!membership) return jsonResponse({ error: 'not authorized for this message' }, 403)

    const { data: refreshToken } = await adminClient.rpc('get_refresh_token', {
      p_business_id: message.business_id,
    })
    if (!refreshToken) return jsonResponse({ error: 'no refresh token configured for this business' }, 500)

    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: Deno.env.get('GOOGLE_CLIENT_ID')!,
        client_secret: Deno.env.get('GOOGLE_CLIENT_SECRET')!,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    })
    const tokenData = await tokenResponse.json()
    if (!tokenData.access_token) {
      return jsonResponse({ error: 'failed to refresh Google access token', detail: tokenData }, 500)
    }

    const attachmentResponse = await fetch(attachmentUrl, {
      headers: {
        'Authorization': `Bearer ${tokenData.access_token}`,
        'developer-token': Deno.env.get('GOOGLE_DEVELOPER_TOKEN')!,
      },
    })
    if (!attachmentResponse.ok) {
      const detail = await attachmentResponse.text()
      return jsonResponse({
        error: 'failed to fetch attachment from Google',
        status: attachmentResponse.status,
        detail,
      }, 502)
    }

    const contentType = attachmentResponse.headers.get('content-type') || 'application/octet-stream'
    return new Response(attachmentResponse.body, {
      headers: { ...corsHeaders, 'Content-Type': contentType, 'Cache-Control': 'private, max-age=3600' },
    })
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500)
  }
})
