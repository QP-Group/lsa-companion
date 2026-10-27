-- Stores the attachment URLs Google returns for a message/SMS/email
-- conversation (local_services_lead_conversation.message_details.attachment_urls),
-- e.g. a picture a lead sent. The URLs themselves are Google-hosted and
-- require an authorized OAuth token to actually download — the new
-- get-attachment Edge Function proxies that, the dashboard never talks
-- to Google directly.
--
-- Nullable on purpose: null/empty = no attachment (the normal case for
-- every text-only message, past and future). Existing rows untouched.

alter table conversation_messages
  add column if not exists attachment_urls text[];

comment on column conversation_messages.attachment_urls is
  'Google-hosted URLs for any SMS/email attachments on this message (e.g. a photo the lead sent). Null/empty = no attachment. Fetched via the get-attachment Edge Function, never directly by the browser.';
