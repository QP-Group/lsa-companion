-- Records when a customer filled in Vertex's book.html quote form after
-- arriving via the link this Companion sent them. Set by the new
-- form-received Edge Function (pinged from Vertex's CRM), which also sets
-- responded = true so send-followups never nudges this lead and it drops out
-- of "needs response".
--
-- Nullable on purpose: null = no form received (the normal case for every
-- existing and every not-yet-converted lead). Existing rows are untouched.

alter table leads
  add column if not exists form_submitted_at timestamptz;

comment on column leads.form_submitted_at is
  'When the customer submitted the book.html quote form via this lead''s tagged link (set by the form-received function). Null = no form received.';
