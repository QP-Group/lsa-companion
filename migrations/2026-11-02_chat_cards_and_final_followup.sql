-- Chat cards + final follow-up (owner approvals, QP Operations #7 and #8, 2 Nov 2026).
--
-- 1. leads.follow_up_2_sent: the new day-3 message ("Still need a hand? Reply with your
--    postcode...") is sent once, after the 24-hour reminder, only if nobody has answered, the form
--    isn't filled in and the customer hasn't replied in the chat (send-followups).
-- 2. businesses.chat_card_url: where chat-cards sends a customer's chat reply for the owner to
--    answer. NULL = off. For Vertex: its CRM's lead-router /lsa-chat route (set below).
-- 3. conversation_messages.card_sent_at: each customer message is carded once.
-- 4. Schedule chat-cards every 5 minutes, a minute after each sync.
--
-- Secrets (set by the owner, not here): CHAT_CARD_SECRET on this project's functions, and the
-- same value as Vault secret lsa_chat_secret in Vertex's CRM.
-- Rollback: select cron.unschedule('lsa-chat-cards'); update businesses set chat_card_url = null;
--           then drop the three columns if wanted.

alter table leads add column if not exists follow_up_2_sent boolean not null default false;
alter table businesses add column if not exists chat_card_url text;
alter table conversation_messages add column if not exists card_sent_at timestamptz;

-- Don't card old chat replies from before this change: only messages from now on.
update conversation_messages set card_sent_at = now()
where card_sent_at is null and participant_type = 'CONSUMER';

-- Leads already past day 3 when this lands shouldn't suddenly get the final message.
update leads set follow_up_2_sent = true
where follow_up_sent and google_created_at < now() - interval '72 hours';

update businesses set chat_card_url = 'https://ecdghvcpqtrvsosgncmx.supabase.co/functions/v1/lead-router/lsa-chat'
where name ilike 'Vertex%' and chat_card_url is null;

select cron.schedule(
  'lsa-chat-cards',
  '1-56/5 * * * *',
  $$select dispatch_edge_function('chat-cards');$$
);
