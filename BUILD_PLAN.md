# Build Plan — LSA Companion

Phased plan based on everything confirmed during research (see history in
this file's companion `README.md` for product scope). Order matters here —
each phase proves the thing the next phase depends on, rather than building
UI on top of an unproven connection.

## Phase -1 — Confirm we're actually allowed to build this (do this FIRST)

**Added on review — this was missing entirely, and it should gate everything
else.** All prior research covered *how* to connect technically; none of it
covered whether our specific use case (multi-tenant lead tool, potentially
auto-submitting feedback on a business's behalf) is compliant with Google's
own policy. If it isn't, nothing below matters.

1. Read Google's **"Access Levels and Permissible Use"** policy in full
   (found during earlier research, never actually opened) —
   https://developers.google.com/google-ads/api/docs/api-policy/access-levels
2. Read the **"Required Minimum Functionality" (RMF)** requirements
   referenced alongside it — confirm what functionality bar a third-party
   tool must meet to get/keep API access.
3. Confirm specifically whether automated submission of Lead Feedback
   Survey responses on a business's behalf is permitted, or whether that
   needs to stay a human-in-the-loop action (business reviews our
   evidence, submits it themselves).

**Correction, 2026-08-14**: the "Local Services API" (`localservices.googleapis.com`,
documented in Google's PDF developer guide) is **deprecated** — its
`detailedLeadReports` endpoint reliably returns an empty `{}` response even
against accounts with real, matching lead data (confirmed both by our own
real test against Vertex's account and independently by other developers
on Google's forums). **The correct, current path is the general Google Ads
API's `local_services_lead` resource**, queried via `GoogleAdsService.Search`
(GAQL) using the official `google-ads` Python client library — this is what
Google itself now recommends instead. `pull_leads.py` needs rebuilding
against this before Phase 0 can actually complete.

**Findings, 2026-08-12:**
- Reporting (read-only lead/account data) fits cleanly under Google's
  "Reporting" permissible-use category — low risk.
- RMF (functionality-completeness rules) only applies to **Standard**
  Access, not Basic — not a blocker for MVP, revisit at Phase 4 if/when
  applying for Standard access.
- **Unresolved**: `ProvideLeadFeedback()` (automated dispute/feedback
  submission) doesn't clearly fall under any of the three defined
  permissible-use categories. Treat automated submission as **not
  confirmed compliant** — v1 default is the human-in-the-loop version
  (we generate evidence, business submits it themselves), not automation.
- **Unresolved**: could not find Local Services API-specific terms
  separate from the general Google Ads API policy — [UNVERIFIED] whether
  additional restrictions apply. Google's "API Compliance team" contact
  channel (referenced in RMF docs) is likely the real way to close this
  out, not more searching.

**Exit criteria**: a clear yes/no on whether this product, as scoped, is
compliant — before creating any account or writing any code. **Not yet
fully met** — reporting is clear, automated feedback submission is not.

## Phase 0 — Prove the connection works (before writing product code)

Nothing else is worth building until this is proven end-to-end with real
data, since the whole product depends on it.

1. Create our Google Ads Manager Account (free, ~5 min, business email,
   "Manage my clients' accounts" option). [Medium confidence]: sourced from
   WebSearch summaries of Google's help docs, not confirmed by reading the
   primary source directly — re-verify against Google's own page when
   actually doing this step, don't just trust this plan's summary of it.
2. Set up a Google Cloud project and generate a Google Ads API developer
   token (the Cloud project is a real prerequisite step the original plan
   skipped over). **Correction, 2026-08-14**: new developer tokens default
   to **Explorer Access**, which already permits read-only calls against
   real production accounts (2,880 operations/day, no planning/billing
   features — irrelevant to us) — this is sufficient for Phase 0's real
   API call. Basic access (15,000 ops/day) is only needed later, once
   syncing many customers exceeds Explorer's cap — apply for it in
   parallel, but it does not block this step.
3. Link Vertex's existing LSA account to our new Manager Account (real
   linking flow: get Vertex's 10-digit Customer ID → send link request →
   Vertex accepts).
4. Make **one real, READ-ONLY API call** against Vertex's linked account —
   pull a Detailed Lead Report for a short date range and confirm real
   lead data comes back correctly shaped. **Do not test any write/feedback
   capability against Vertex's live account at this stage** — Vertex
   depends on this account for real leads; any write action needs a
   read-only-first, sandbox-or-explicit-confirmation-second discipline,
   the same caution already established (and hard-won) in Vertex's own
   project conventions.
5. Pull enough of Vertex's real historical lead data here to sanity-check
   the core business pitch: how many of their charged leads actually look
   invalid, and roughly how much money is at stake? **This determines
   whether Phase 2's audit tool is worth building as scoped, before a
   single day of UI work goes into it** — do this before Phase 1, not
   after.
6. [Open question, resolve here] Test whether `disputeStatus` read access
   and any write/feedback-submission capability (`ProvideLeadFeedback`)
   both work from the same setup, or if the write path needs separate
   Google Ads API access beyond the Local Services reporting API.

**Exit criteria**: real lead data from Vertex's live account, visible
somewhere we control (even just a terminal printout), AND a real number
for "how much money is actually at stake" — not before.

**Status, 2026-08-14: first half done.** Real call succeeded against
Vertex's live account via `GoogleAdsService.Search` on `local_services_lead`
— 177 leads returned (full history, no date filter applied yet), fields
confirmed working: id, lead_type, lead_status, creation_date_time,
lead_charged. **Update, 2026-08-14**: confirmed working field set via direct live trial
(id, lead_type, lead_status, creation_date_time, lead_charged,
contact_details, locale). **Real gap found, not yet solved**: `lead_charged`
is boolean only — `local_services_lead` does not appear to carry the actual
dollar amount charged per lead. Cost data likely lives on a separate
Google Ads cost/metrics resource, cross-referenced by date/campaign rather
than attached to each lead directly — needs its own research thread before
the audit tool's ROI number can be calculated for real. `dispute_status` (bare field name) does not exist, but the real
dispute/credit field does — **`local_services_lead.credit_details.credit_state`**,
confirmed working with real data (all 10 sampled charged leads currently
show `UNSPECIFIED`, i.e. no credit decision applied yet — verified via
explicit field access, not just trusting the print repr, since default
enum/bool values get silently omitted from proto-plus's default string
output).

**Confirmed structural finding, 2026-08-14**: per-lead cost genuinely does
not exist on `local_services_lead` — tried 4 candidate field names, all
either don't exist or (`metrics.cost_micros`) are explicitly incompatible
with this resource per Google's own error message. Cost lives at a
different resource level (campaign/customer), not joinable to individual
leads in one query. **Product implication**: the audit tool cannot show
"this lead cost you £X" precisely — the realistic version is an estimate
(average cost-per-lead for the period, applied to a count of
flagged/declined-charged leads), not an exact per-lead figure. This is a
real scope change worth being upfront about, not a technical footnote.

**Confirmed working GAQL field set for `local_services_lead`** (saved in
`pull_leads.py`): id, lead_type, lead_status, creation_date_time,
lead_charged, contact_details (nested: phone_number), locale,
credit_details.credit_state.

**The cost piece, resolved 2026-08-14**: per-lead cost genuinely isn't
available (confirmed above), but **aggregate cost is** — confirmed working
against Vertex's real account: `billing_setup` (status: APPROVED, real
payments account attached) plus a `customer`-level query with
`metrics.cost_micros` segmented by `segments.date` (16 days of real spend
data over the last 30 days, £76.00 total). This closes the ROI-estimate
approach: correlate per-lead counts/status (from `local_services_lead`)
against daily aggregate cost (from `customer`/`metrics.cost_micros`) over
the same date range to compute an average cost-per-lead, applied to
flagged/declined-charged leads as an estimate — not exact per-lead
figures, but a real, defensible number rather than a guess.

**Phase 0 is now effectively complete**: real connection proven, full
confirmed field set for leads, dispute status, and cost, all tested live
against Vertex's actual account. Remaining before Phase 1: write the
actual cost-per-lead correlation calculation and run it once for real,
to get Vertex's actual ROI number (not just confirm the fields exist).

## Phase 1 — Data layer — **DONE, 2026-08-14**

Schema built (businesses, business_members, business_credentials with
Vault-backed tokens, leads, daily_cost), all RLS policies in place, Vertex
seeded as the first real business, and `sync_leads.py` run successfully:
177 leads + 16 days of cost data written into real tables, verified
directly — correct typing, correct business_id linkage, our own added
fields (responded/notes/follow_up_sent) correctly defaulted and preserved
across the sync rather than overwritten.

- New database, fully separate from Vertex's CRM/Portal Supabase projects
  (per standing project instruction — no shared schema).
- **Added on review — multi-tenant isolation must be designed here, not
  assumed.** "Separate from Vertex" only covers isolation between this
  product and Vertex; it says nothing about isolation *between different
  LSA Companion customers* once there's more than one tenant. Every table
  needs an explicit tenant/business identifier and real row-level security
  from the start — apply the exact lesson already paid for once in
  Vertex's own build (RLS must be explicitly enabled per table, and any
  policy that checks membership via a lookup table needs a self-select
  policy on that lookup table or it silently grants full access instead of
  restricting it).
- **Added on review — data privacy/compliance is a schema-time decision,
  not a later add-on.** This product holds real consumer PII (names,
  phone numbers, call data) belonging to other businesses' customers,
  across multiple tenants, at least one UK-based (GDPR applies). Before
  building the schema: decide retention period, who can access stored PII
  and how, and draft a basic privacy policy / data processing terms for
  customers. Not fully resolvable in this plan — flagging as a required
  decision before Phase 1 is considered done, not after launch.
- A synced-leads table, mapped from the API's Detailed Lead Report fields
  (leadId, leadType, chargeStatus, disputeStatus, messageLead/phoneLead
  details, etc.) **plus our own added fields Google doesn't track**:
  responded/needs-reply status, internal notes, follow-up-sent flag for
  missed calls.
- A sync job that pulls new/updated leads periodically per connected
  account (30-minute data staleness on Google's side means near-real-time
  polling, not instant). **Added on review**: before finalizing poll
  frequency, do the actual capacity math — (number of businesses) ×
  (report types per sync) × (syncs per day) against the Basic tier's
  15,000 operations/day cap. The original plan asserted this was "fine"
  without ever running the numbers.

## Phase 2 — Core v1 features (audit tool + inbox/UX, built together)

**Audit tool — revised 2026-08-14 based on real validated findings:**
- Surface `lead_status` / `credit_details.credit_state` /
  `lead_feedback_submitted` per lead (all confirmed working fields).
- Flag charged + declined-by-business + uncredited leads for review, same
  logic already validated against Vertex's real history.
- Dashboard total: real, defensible estimate ("£X tied up in flagged
  leads" — average cost-per-lead × flagged-lead count, explicitly labeled
  as an estimate, not an exact figure — see Phase 0 cost findings).
- **Do NOT build automated feedback submission via `ProvideLeadFeedback()`.**
  This isn't just the unresolved compliance question from Phase -1 anymore
  — it's now proven pointless: validated against Vertex's real data, feedback
  submission and getting credited are completely uncorrelated (2 leads had
  feedback submitted, 0 credited; the 1 real credit had no feedback
  submitted at all). Building this feature would recreate the same false
  hope Google's own tool already gives.
- Instead: an **exportable evidence record** per flagged lead (dates,
  status, cost estimate) — positioned for escalating to a human at Google
  directly, not for the automated survey channel. Be explicit in the UI
  that this does not guarantee a credit — the product's honesty here is
  now backed by real evidence, not just caution.

**Inbox / UX layer:**
- Sortable/filterable lead list (unresponded-first default, saved views).
- Responded/needs-reply toggle visible per row, no click-through required.
- Missed-call handling: flag phone leads with no connected call, prompt a
  follow-up action (this is new functionality Google doesn't provide at
  all today).

## Phase 3 — Onboarding flow

- "Connect your account" screen: business enters their Customer ID, we
  send the link request, on-screen instructions for the accept step,
  status check to confirm once linked.
- This is the first thing a second real customer (beyond Vertex) would
  touch, so it needs to be usable by a non-technical business owner.

## Phase 3 — Competitive parity with LSArespond (added 2026-08-14)

Explicit decision: build toward direct feature parity with LSArespond
(~1750 businesses served, established player — researched 2026-08-14),
not just the original narrower scope. Organized by build complexity:

**Tier 1 — buildable now, extends confirmed-working mechanisms:**
- Auto-reply to messages via `appendLeadConversation` (confirmed real).
- Automated feedback/credit submission via `ProvideLeadFeedback`
  (confirmed real mechanism — compliance question from Phase -1 must be
  actually resolved now, not left flagged, since this moves from
  hypothetical to real).
- ~~Confirm whether `lead_status` is writable~~ — **checked 2026-08-14**:
  `LocalServicesLeadService` only exposes two write operations total,
  `AppendLeadConversation` and `ProvideLeadFeedback` — there's no separate
  status-update capability. Auto Booked/Archived isn't an independent
  feature; it collapses into the same `ProvideLeadFeedback` compliance
  question already blocking that item.
- Real-time alerts (email/SMS) on new leads/replies.
- Daily/weekly recap emails (needs an email service, e.g. Resend).
- Generic webhook/Zapier CRM export (before any bespoke integration).
- **Missed-call flagging** (moved from Tier 2, see corrections below —
  went through two wrong signals before finding the right one) — trigger
  on `local_services_lead_conversation.phone_call_details.call_duration_millis
  = 0` for `PHONE_CALL` conversations. Clean, unambiguous, and available
  immediately (not subject to the 72-hour charge-review delay) — verified
  against real Vertex data.

**Correction #1, 2026-08-14 — moved missed-call handling out of Tier 2.**
The earlier conclusion ("no field exists, needs real telephony
infrastructure") was based on guessing ~4 field names on
`local_services_lead` only and giving up too early. First fix: found
`lead_charged` as a proxy (charged ≈ connected, per the deprecated API's
own definition of `phoneLeadResponsiveness`) — real but imperfect, and
then a second problem surfaced (see Correction #2).

**Correction #2, same day — `lead_charged` isn't fast enough anyway.**
User correctly identified that leads sit in Google's "in review" state
for up to 72 hours before the charge decision finalizes (confirmed via
search) — meaning `lead_charged=false` on a fresh lead is ambiguous
(genuinely invalid vs. still pending), too slow for a real-time
"follow up now" trigger. This ruled out `lead_charged` for the
speed-sensitive use case, even though it's still fine for the
(non-time-sensitive) audit/estimate feature already built.

**Correction #3, same day — the real answer was on a resource we hadn't
checked.** Queried `GoogleAdsFieldService` for the complete list of ALL
`local_services*` resources (not just `local_services_lead`), which
surfaced `local_services_lead_conversation` — 11 fields, including
**`phone_call_details.call_duration_millis`** and
**`phone_call_details.call_recording_url`**. Verified against real Vertex
data: genuine calls show real durations (e.g. 270815ms), and
**`duration_ms=0` cleanly and unambiguously indicates an unanswered
call** — no proxy, no ambiguity. Also confirmed via `event_date_time`
matching the lead's creation timestamp almost exactly that this data is
available immediately, not subject to the 72-hour review delay. This is
the correct signal — supersedes the `lead_charged` proxy entirely for
missed-call detection. **Bonus**: `call_recording_url` existing also
confirms call audio access is real, resolving the "unconfirmed" status
on the Tier 2 transcription feature below.

**Tier 2 — needs new infrastructure beyond the Ads API:**
- Call transcription/summarization/categorization: call audio access
  confirmed available (`call_recording_url`, see above) — no longer
  blocked on data access, just needs an AI service built on top.
- Follow-up sequences + after-hours logic: buildable once auto-reply
  works, just scheduling logic layered on top.

**Tier 3 — broad, shallow, many integrations:**
- Bespoke CRM integrations (Jobber, Workiz, ServiceFusion, HubSpot,
  GoHighLevel, Housecall Pro, ServiceTitan) — start with the generic
  webhook connector from Tier 1, only build bespoke ones if a specific
  real integration becomes a blocker.

**Before building any Tier 1 write features**: two things that were
previously "flag and defer" become real blockers now:
1. Resolve the permissible-use compliance question for real (Phase -1
   was never fully closed — this can't stay open once we're actually
   sending real messages/feedback through the API).
2. Decide deliberately whether auto-reply requires human
   approval-before-send, at least initially — LSArespond sends fully
   automatically with no review step; that's a real risk decision, not
   a default to copy without thinking about it.

## Auto-reply (Option 1, Tier 1 of Phase 3) — built 2026-08-14

`auto_reply.py` — fixed-template acknowledgment for new message leads,
deliberately structured so a future AI upgrade only changes
`generate_reply()`, not the trigger/send/tracking logic. Uses
`LocalServicesLeadService.AppendLeadConversation`, confirmed via direct
introspection of the installed `google-ads` library's types (WebFetch
couldn't render Google's JS-based docs pages for this one) —
`AppendLeadConversationRequest(customer_id, conversations)`,
`Conversation(local_services_lead, text)`.

Defaults to `DRY_RUN = True` — prints what would send, sends nothing
real, by design.

**Real bug caught by dry-run testing before any live send**: the first
version had no recency filter — it matched 18 real leads spanning March
to August 2026. Sending "we just received your message" to a 5-month-old
lead would have looked broken. Fixed with a `MAX_LEAD_AGE_HOURS = 24`
cutoff. Re-tested: correctly returns 0 candidates now (nothing in current
data is within 24 hours) — confirms the exclusion works, but the positive
path (correctly catching and replying to a genuinely fresh lead) hasn't
been verified yet since no test data is recent enough. That's the real
next verification, whenever a new message lead actually comes in.

**Not yet done**: flipping `DRY_RUN` to `False` — deliberately left for
the user to decide when, not something to do automatically once the code
"looks right."

## Generic webhook export (Tier 1, Phase 3) — built 2026-08-14

`webhook_export.py` — POSTs new leads to a business-configured
`webhook_url` (e.g. a Zapier trigger), tracked per lead via
`webhook_sent`, same non-resend pattern as auto-reply. No bespoke CRM
integration needed for v1 — the business points their own receiving URL.

**Tested end-to-end** with a local throwaway HTTP server standing in for
a real webhook receiver (no real external account needed to verify the
mechanism) — confirmed the POST payload structure and delivery work
correctly.

**Real bug caught by that same test, same category as the auto-reply
recency issue**: with no protection, setting a `webhook_url` for the
first time would export the entire historical backlog at once — confirmed
directly, it sent all 177 of Vertex's leads in one run. That would flood
a real downstream system (177 near-simultaneous CRM contacts, etc.).
Fixed with `set_webhook_url.py` — the only sanctioned way to set a
business's webhook, since it marks existing leads as already-exported in
the same step before the URL goes live, so only genuinely new leads
trigger it afterward. Setting `webhook_url` directly via SQL bypasses this
protection — don't do that.

## Email alerts (Tier 1, Phase 3) — built and confirmed working 2026-08-14

`send_alerts.py` — emails a business when genuinely new leads arrive,
via Resend's HTTP API (shared testing domain `onboarding@resend.dev`,
works without domain verification since it only sends to the account's
own verified email — fine for Vertex-only testing, needs a verified
sending domain before this could email other businesses). Same
non-resend tracking pattern as auto-reply/webhook (`alert_sent`).

Applied the backlog-flood lesson **proactively** this time instead of
rediscovering it a third time — `set_alert_email.py` mirrors
`set_webhook_url.py` exactly, marking existing leads as already-alerted
before the alert email goes live. Only ever set `alert_email` through
that script, never directly via SQL.

**Tested for real** (safe to do since Resend's test mode only sends to
the account's own verified email, unlike the customer-facing auto-reply):
reset one lead, ran the script, confirmed a real email arrived at
enpee.sides@gmail.com with the correct lead data formatted in a table.

**Tier 1 status**: auto-reply (dry-run), webhook export, and email
alerts are all built. Remaining: `ProvideLeadFeedback` (still blocked on
the compliance question).

## Missed-call flagging — built and tested 2026-08-14

`sync_leads.py` extended with `sync_call_durations()` — pulls
`local_services_lead_conversation` filtered to `PHONE_CALL` channel,
takes the max duration across multiple call attempts per lead (if any
attempt connected, the lead isn't "missed" overall), writes to the new
`call_duration_millis` column.

`send_missed_call_alerts.py` — emails on phone leads where
`call_duration_millis = 0`, separate `missed_call_alert_sent` tracking
column from the general new-lead alerts (a lead can be alerted as "new"
and, independently, later flagged as "missed" once call data syncs in).

**Verified against real Vertex data**: 23 of 114 phone leads confirmed
missed, **zero contradictions** against `lead_charged` (every missed call
was also uncharged — consistent with Google never billing for calls that
don't connect). Also confirms the earlier `lead_charged` proxy was too
broad: of 91 *answered* calls, 63 were still uncharged (other invalidity
reasons), which `call_duration_millis` correctly doesn't misclassify as
missed.

Applied the backlog-flood lesson **proactively a third time** (after
hitting it live twice with webhooks/alerts) — marked all 23 existing
missed calls as already-alerted before ever running the script for real,
rather than waiting to rediscover the same bug again.

**Tested for real**: reset one missed call, ran the script, confirmed a
real email arrived with correct data.

## Phase 4 — Scale considerations (later, not blocking early build)

- Our Manager Account defaults to a 50-linked-account cap (since it has no
  ad spend of its own) — fine through early customers, request an increase
  from Google before approaching that number. [Medium confidence]: this
  number came from a WebSearch summary, not Google's own primary docs read
  directly — re-confirm before treating it as a hard planning constraint.
- Revisit Standard API access (unlimited daily operations) once real usage
  approaches the Basic tier's 15,000 operations/day (see Phase 1's
  capacity-math note — we don't yet know when that actually happens).

## Added on review — a question the plan never asked

**If this lightweight, LSA-only tool is such a clear gap, why hasn't
Jobber/Housecall Pro/a standalone competitor already built it?** Possible
answers: nobody's tried; someone tried and the Manager-Account-linking
onboarding friction we just discovered killed it; or Google's
permissible-use policy (Phase -1, above) blocks the exact multi-tenant
model we're planning. We don't know which. Worth a quick search for
"Google LSA API third party tool" / "LSA lead management SaaS" before
committing real build time, specifically now that we understand the real
onboarding model — not repeating the earlier, more general competitor
search done before we knew about Manager Account linking.

## Open decisions not yet made

- **Tech stack**: not chosen yet. No constraint to match Vertex's
  plain-HTML-plus-Supabase pattern — this is a separate product — but
  worth deciding deliberately rather than defaulting silently.
- **Hosting/deployment**: not decided.
- **Pricing model**: not decided (subscription vs. cut of recovered
  credits — the audit-tool pitch supports either).

## Correction — Google's UI status/location diverge from the API (2026-08-14)

User caught a real, direct contradiction by cross-checking two specific
lead IDs (304500566, 316557066) against Google's own native UI
screenshots vs. our synced data:

- Lead 304500566: our `lead_status` = `DECLINED`. Google's UI shows
  **"Archive."**
- Lead 316557066: our `lead_status` = `BOOKED`. Google's UI shows
  **"Completed Jun 24, 2026."**

Google's own status filter dropdown lists: **New, Active, Booked,
Completed, Archive** — structurally different from the API's
`lead_status` enum (`NEW, ACTIVE, BOOKED, DECLINED, CONSUMER_DECLINED,
EXPIRED, DISABLED, WIPED_OUT, ...`). Notably, "Declined" isn't even in
Google's own UI taxonomy.

**Re-checked with a broad field search** (`%location%`, `%city%`,
`%geo%`, `%archiv%`, `%complet%`, `%area%` against all `local_services*`
fields) — confirmed nothing matches. This is a genuine, now-thoroughly-
confirmed API limitation, not a case of not looking hard enough the
first time. Google's own frontend has access to data/state (archive,
completed, per-lead location — "Long Eaton" vs "Nottingham", confirmed
genuinely per-lead not a fixed account value) that the public API does
not expose at all.

**What held up under this scrutiny**: `lead_feedback_submitted` cross-
checked correctly against Google's own "Rating submitted" UI indicator
for the same lead — that field is solid.

**Real, permanent implication**: our tool's status display will
structurally never fully match what a business sees natively in Google.
This is not fixable by more research — it's an API boundary. Fixed the
dashboard's status label to say this explicitly rather than implying
parity. The local-only `archived`/`local_status_override` approach is
still the right call (there's no way to read Google's real archive/
complete state), but it does NOT sync with whatever a business might
separately do in Google's own interface, and that limitation should stay
visible in the UI, not be quietly assumed away.

## Spend-pace anomaly alerts — built and confirmed working 2026-08-14

`check_spend_anomaly.py` — compares today's spend against a 14-day
rolling baseline, emails if >2x or <0.5x, and cross-checks
`account_budget.approved_spending_limit_micros` against a stored
previous value first so an intentional budget change doesn't trigger a
false alarm (best-effort — this field can be null/unset, confirmed true
for Vertex, in which case the cross-check is simply skipped).

**Tested for real against Vertex's live data**: caught a genuine dip
(today £2.50 vs. £5.07 baseline, ratio 0.49 — just inside the <0.5
threshold), sent a real email, and confirmed re-running the same day
correctly skips re-alerting (no duplicate).

**Worth calibration-watching**: 0.49 is right at the threshold edge —
this triggered on what could be fairly ordinary day-to-day variance, not
necessarily a real problem. If this fires too often in practice on
normal fluctuation, tighten `HIGH_RATIO`/`LOW_RATIO` or extend
`BASELINE_DAYS` — not tuned against enough real-world firing history yet
to know if the current thresholds are right.

**Context that led here**: this whole feature was almost built without
the budget-change cross-check, until the user asked about manual budget
control, which surfaced a real design gap (an intentional budget change
would otherwise look identical to a real anomaly). That same
conversation also surfaced a bigger, separate finding: Google is
migrating Local Services Ads to Performance Max campaigns, starting
August 2026 for US accounts, 2027 for non-US (Vertex is UK — not
imminent, confirmed via Google's own migration page, cross-checked
against Vertex having received no notification email). Automated budget
control was paused given this and the separately-confirmed
"frequent budget changes risk overdelivery" warning — worth revisiting
later, not now.

## Compliance/verification expiry alerts — built and confirmed working 2026-08-14

`check_verification_expiry.py` — syncs `local_services_verification_artifact`
(insurance and license are the two types with real expiration dates —
business registration and background check don't carry one, confirmed
via the earlier field sweep), alerts at 60/30/7 days before expiry.
Real stakes: a lapse can get the LSA account suspended entirely.

Tracked per (artifact, threshold) in `verification_expiry_alerts` so
each checkpoint only ever fires once.

**Tested both paths**: real sync against Vertex's actual data correctly
produced no alert (insurance expires 2027-03-13, ~211 days out, beyond
the 60-day threshold — correctly quiet). Positive path verified safely
via a synthetic artifact (5 days from expiry, not written to the real
table) — correctly fired a real email, cleaned up the test alert record
afterward so it won't block the real future alert.

This closes out all three opportunities flagged during the earlier full
data sweep (spend-pace anomalies, this one, and missed-call flagging
which was built earlier). Remaining open items: the `ProvideLeadFeedback`
compliance question (still unresolved), and no scheduled/automatic sync
yet (everything still runs by hand).

## Real reply-sending — built, deployed, and confirmed working 2026-08-15

Closes the original core gap flagged much earlier: the dashboard could
show messages but never send them, meaning replying still required going
back to Google's own site. That's fixed now.

**Architecture**: `supabase/functions/send-reply/index.ts` — a Supabase
Edge Function (Deno/TypeScript), since the browser can't safely hold the
Google Ads developer token/refresh token directly. Verifies the caller's
Supabase Auth session, checks real business-membership authorization
(not just trusting a lead_id the browser sends), fetches the refresh
token from Vault, exchanges it for an access token, and calls Google's
`AppendLeadConversation` REST endpoint directly (Deno can't use the
Python `google-ads` library). Deployed via the Supabase CLI, authenticated
via a personal access token (the browser-based `supabase login` flow
doesn't work in a non-interactive environment).

**Deliberately does not write to `conversation_messages` itself** — that
table's uniqueness is keyed on Google's own conversation id, which this
function doesn't have at send time (Google assigns it after the fact).
Writing a placeholder risked a real duplicate/collision once the next
sync pulled the real row. Frontend shows the sent message optimistically
in memory instead; the permanent record lands on the next regular sync.

**Verified in two stages, not in one leap**:
1. Tested the REST request shape safely first — a fake lead ID under
   Vertex's real account got a clean `200` with a properly structured
   Google response (failed only because the fake lead doesn't exist,
   not because of a malformed request) — confirmed auth, headers, and
   JSON shape were all correct before ever risking a real send.
2. User explicitly chose to test with a real lead and a real message
   (their call, not decided unilaterally) — sent to lead 331840108.
   Confirmed via two independent checks: `leads.responded` flipped to
   `true` in our DB, and — the definitive proof — the actual reply now
   appears in Google's own `local_services_lead_conversation` data,
   correctly attributed to `ADVERTISER`, timestamped at send time.

This is the first real write action taken against a live customer during
this whole project — treated with more caution than anything else built
so far (REST-shape dry-test before any real send, explicit user consent
for the real test, independent verification after).

## Correction — the reply-sending "confirmation" above was wrong (2026-08-15)

The verification described in the "Real reply-sending" entry above (real
reply to lead 331840108, confirmed via Google's own conversation data)
was **not actually a test of our Edge Function**. The user has since
clarified that specific reply was sent through Google's own native UI
directly, not through our dashboard's compose box. What I actually
verified was just "a message sent via Google's UI shows up in Google's
data" — true, but trivial, and it doesn't prove our `send-reply` Edge
Function works at all. Recorded here rather than quietly editing the
entry above, since the mistaken confidence is itself worth remembering,
not just the correction.

Separately, this same investigation surfaced a real, unrelated bug: three
columns (`archived`, `local_status_override`, `job_completed_locally`)
were reported as "ran clean, no errors" when their migrations were first
requested, but were confirmed genuinely absent from the database days
later — meaning Archive / Mark Booked (local) / Mark Declined (local) /
Mark job completed had likely been silently failing in the live
dashboard the whole time. Re-ran both migrations, verified directly this
time (not just trusting the "ran clean" report) — all three columns now
confirmed present.

**Real test of the actual reply-sending feature, through our own
dashboard, still has not happened.** That's the next real step, not a
completed one.

## Real reply-sending — genuinely confirmed this time (2026-08-15)

Following the correction above (previous "confirmation" was actually a
Google-UI send, not our tool), the user sent a real message through our
actual dashboard compose box: "Can you confirm your full address please"
to lead 331840108. Verified independently via Google's own
`local_services_lead_conversation` data — a new ADVERTISER message at
2026-08-15 17:09:09, distinct text and timestamp from the earlier
Google-UI-sent message at 16:47:19, confirming this was a genuinely new
send, not a repeat.

This is now actually confirmed working end-to-end through our own tool,
not just through the underlying Google API mechanism.

**Also confirmed working in this same session**: sync correctly pulls in
messages sent via Google's own UI too (not just our own sends) — a
message count went 320->321 after a re-sync picked up the earlier
Google-UI reply, proving the dashboard stays consistent regardless of
which side (ours or Google's own interface) a reply was sent from.

## Scheduled automatic sync — built and confirmed working 2026-08-15

`run_all_syncs.sh` runs `sync_leads.py` -> `send_alerts.py` ->
`check_spend_anomaly.py` -> `check_verification_expiry.py` ->
`webhook_export.py` in order (sync first, since everything else depends
on fresh data). Scheduled via macOS `launchd`
(`~/Library/LaunchAgents/com.lsacompanion.sync.plist`), every 30 minutes,
matching the Phase 1 capacity math. Runs at login too (`RunAtLoad`), and
persists across reboots.

**Deliberately excludes `auto_reply.py`** — still `DRY_RUN=True` by
explicit user choice; adding it to an unattended schedule would mean
flipping that flag later starts auto-sending on the very next scheduled
run with no further human trigger, a bigger risk change than making
silently. Add it explicitly later if that decision gets made.

**Real bug caught before trusting this**: the first run silently used a
different, package-less Python 3.9 instead of the 3.14 install everything
was built against — `launchd` doesn't inherit an interactive shell's
`PATH`. All 5 scripts failed with `ModuleNotFoundError` while the wrapper
script still logged "finished" successfully, since the wrapper itself
didn't check each script's exit status. Fixed by hardcoding the exact
Python binary path rather than relying on `PATH` resolution. Re-verified
by reading the actual log content, not just trusting completion — all 5
scripts confirmed genuinely working on the second run.

Logs: `scripts/sync.log` (application output),
`scripts/launchd_stdout.log` / `launchd_stderr.log` (launchd-level).

## Hosting — deployed and confirmed working 2026-08-15

Dashboard is now live at **https://enpeesides-ctrl.github.io/lsa-companion/**
— a real public HTTPS URL, reachable from any device, not dependent on
this Mac being on (unlike the sync scripts, which still run locally via
launchd — hosting the frontend does NOT solve that separate limitation).

**Netlify was tried first and abandoned.** New Netlify accounts default
to a mandatory team-level `site_sso_login` gate that requires a Netlify
account login just to view any deployed site. Attempted to disable it via
the API — the call returned success but silently left the setting
unchanged, indicating a plan-enforced restriction, not something fixable
via API. Rather than keep fighting an undocumented restriction, switched
to GitHub Pages instead.

**Setup**: real git repo created (`github.com/enpeesides-ctrl/lsa-companion`,
public — required for free GitHub Pages), `.gitignore` verified BEFORE
first commit to confirm `.env`/`client_secret.json`/logs were genuinely
excluded (checked via `git check-ignore -v`, not assumed). Pages serves
from `/docs` on `main` (`docs/index.html` = a copy of `site/dashboard.html`).

**Real operational risk worth flagging now, not after it causes a
problem**: this is the exact same hub-folder-vs-deploy-folder split that
caused real desync bugs in Vertex's own project (features built and
tested locally that were never actually live because the deploy copy
wasn't updated). `site/dashboard.html` is the working copy for local
testing; `docs/index.html` is what's actually live. **Any future dashboard
change must update both files and be committed+pushed, or the live site
will silently drift out of date** — applying that lesson proactively
here instead of rediscovering it the hard way a second time.

**Verified working**: polled until Pages' first build went live (~90
seconds, 404 until then), confirmed the actual page title/content is
correct — not just trusting the API's "success" response, given the
Netlify lesson earlier in this same task.

## Tier 2: after-hours logic + follow-up sequences — built and tested 2026-08-16

**Call transcription investigated and found genuinely blocked, not just
unbuilt** — `call_recording_url` is real and populated, but fetching the
actual audio returns a 500 from Google's internal "Scotty" blob-storage
infrastructure on a completely different domain (`ads.google.com`, not
`googleads.googleapis.com` like every other call this project has made).
Strongly suggests this needs a real logged-in browser session, not OAuth
API access — not something worth continuing to guess at right now.
Corrected an earlier premature claim that this was "confirmed possible."

**After-hours logic** — `businesses.business_hours_start/end` (new
columns, defaults 8/18), `auto_reply.py`'s `generate_reply()` now checks
current local time and picks between the normal template and a distinct
after-hours one. Verified directly against synthetic hour configs
(always-open, always-closed, Vertex's real 8-18) — correct template
selected in all three cases. Known limitation, not fixed: uses this
machine's local time, correct for Vertex (single UK business) but would
need a real per-business timezone field before serving businesses
elsewhere correctly.

**Follow-up sequences** — `send_followups.py`, using the `follow_up_sent`
column that had sat unused in the schema since Phase 1. Targets leads
that got the initial auto-reply, still aren't genuinely responded to,
and are 24h-7days old (the upper bound is deliberate — applying the same
"don't nudge on a lead old enough to look broken" lesson `auto_reply.py`
already learned the hard way, proactively this time). Tested both paths:
0 candidates against real current data (correct, nothing qualifies yet
since `auto_reply.py` has never actually sent for real), and the positive
path via a temporary, fully-reverted modification to one real lead —
confirmed found and would have sent, then confirmed the lead's original
state was restored exactly.

**Neither script added to the automatic schedule** — both are DRY_RUN
gated, same reasoning as `auto_reply.py` originally: adding them now
would mean flipping DRY_RUN later starts real unattended sending on the
very next scheduled run, a bigger risk change than making silently.

## Cloud migration, part 1: sync-business Edge Function — built and verified 2026-08-16

Committing to the Edge Functions rewrite (chosen over GitHub Actions or a
standalone VM) for the long-term multi-tenant architecture — one
platform, real scheduling, and a natural per-business invocation model
instead of one script looping over every business.

**Built**: `supabase/functions/_shared/google-ads.ts` (shared OAuth
token exchange + GAQL search helper, reused by every future function)
and `supabase/functions/sync-business/index.ts` — a full port of
`sync_leads.py`'s three sync functions (leads, conversations, daily
cost), one business per invocation rather than one script looping over
all of them.

**Real bug caught immediately on first test**: forgot to include
`local_services_lead_conversation.id` in the ported GAQL query — every
conversation row came back with `google_conversation_id: null`, hard
constraint violation. Simple oversight in the port, not a REST-vs-Python
API discrepancy. Fixed, redeployed, re-tested clean.

**Verified thoroughly, not just "it returned 200"**: row counts matched
the proven Python version exactly (177 leads, 322 messages, 16 cost-days)
AND spot-checked actual field values on a known lead (316557066) —
status, phone, category, and the full ordered message thread with
correct CONSUMER/ADVERTISER attribution all matched exactly. Same
discipline applied to `send-reply` earlier — a clean HTTP response alone
was never treated as sufficient proof anywhere in this project.

**Still needed before the local `launchd` job can be retired**:
`send-alerts`, `check-spend-anomaly`, `check-verification-expiry`, and
`webhook-export` Edge Functions (same port pattern), plus Supabase Cron
scheduling to trigger `sync-business` (looped per active business) and
these on a schedule. `auto-reply` and `send-followups` can stay
Python/local longer, since they're still deliberately `DRY_RUN` and not
part of the live operational path yet.

## Cloud migration, part 2: remaining four functions ported — 2026-08-16

**Built and deployed**, all following the exact `sync-business` pattern
(one business per invocation, real data verification, not just HTTP
200): `supabase/functions/_shared/resend.ts` (shared email helper,
lifted straight from the Python scripts' `send_email()`), then
`send-alerts`, `check-spend-anomaly`, `check-verification-expiry`, and
`webhook-export`.

Also set `RESEND_API_KEY` as a Supabase secret — it existed locally in
`scripts/.env` but had never been pushed to the cloud project, so the
new email-sending functions would have failed silently until this was
caught before the first test, not after.

**Architecture note**: the original `check_spend_anomaly.py` and
`check_verification_expiry.py` looped over every active business in one
process. Ported them to the same one-business-per-invocation shape as
`sync-business` instead, for the same reason that shape was chosen
originally — one business's failure (bad token, Google API hiccup)
can't stall or crash the run for everyone else.

**Verification, each one proven with real data, not just "it ran"**:

- `send-alerts`: confirmed the zero-pending case first, then flipped a
  real Vertex lead's `alert_sent` back to `false`, ran it for real,
  confirmed a genuine Resend email went out (a 200 here is only
  possible if Resend itself succeeded — a Resend failure throws and the
  function returns 500), and confirmed the DB write landed on exactly
  that lead and no others.
- `check-verification-expiry`: ran against Vertex, synced 2 real
  verification artifacts, and spot-checked the field values against the
  already-known-correct data — insurance expiring 2027-03-13 with
  £5,000,000 coverage (5,000,000,000,000 micros), business registration
  check correctly carrying no expiration date. No alert fired, correctly
  — 209 days out is past the 60-day threshold.
- `webhook-export`: didn't want to fire a real customer's phone number
  at a third-party test endpoint just to prove the code works, so
  created a throwaway synthetic business + lead (fake phone number,
  fake everything) instead of using real Vertex data, pointed its
  `webhook_url` at a temporary webhook.site capture endpoint, ran the
  function for real, and pulled back the exact captured HTTP request —
  every field in the JSON payload matched what the code should have
  sent, sent from the real deployed Deno/Supabase Edge Runtime (visible
  in the request's own user-agent). Confirmed `webhook_sent` flipped to
  `true` on the test lead. Deleted the synthetic business and lead
  afterward — nothing fake left behind in real tables.
- `check-spend-anomaly`: first ran it against real Vertex data as-is,
  which surfaced an already-existing "already alerted for this date"
  result — independently recomputed the ratio by hand from
  `daily_cost` and confirmed it matched exactly (0.49, correctly below
  the 0.5 low-anomaly threshold) and that a real alert row already
  existed for that date. That path alone didn't exercise the actual
  alert-send branch or the `account_budget.approved_spending_limit_micros`
  REST call, which had been sitting as genuinely untested REST shape
  since the `_shared/google-ads.ts` file was written — so inserted one
  synthetic future-dated `daily_cost` row with a deliberately huge spend
  spike, ran it again, and got a real fired alert: `ratio: 9.86,
  direction: "unusually HIGH"`. The Google Ads budget cross-check call
  succeeded for real (no error) and correctly came back null, matching
  Vertex's already-known unset budget limit — proving both the
  previously-unverified REST shape works and that the null-budget case
  is handled the same way the Python version handled it. Deleted the
  synthetic `daily_cost` row and the alert row it generated afterward.

All four Python scripts (`send_alerts.py`, `check_spend_anomaly.py`,
`check_verification_expiry.py`, `webhook_export.py`) now have verified
cloud equivalents. Only remaining piece before the local `launchd` job
can be retired: Supabase Cron scheduling to actually trigger
`sync-business` + these four on a schedule, looped per active business.
`auto-reply` and `send-followups` still deliberately stay Python/local
(`DRY_RUN=True`, not part of the live operational path).

## Cloud migration, part 3: Supabase Cron scheduling — 2026-08-16

**Built**: `migrations/2026-08-16_cron_scheduling.sql`. Enables
`pg_cron` and `pg_net`, adds a `dispatch_edge_function(function_name)`
Postgres function that fires one independent `net.http_post` per active
business per Edge Function (same one-invocation-per-business isolation
the functions themselves were built around — one business's failure
can't block or slow the others), and schedules all five jobs.

Matched the real existing cadence rather than guessing: the local
`com.lsacompanion.sync` launchd job runs every 30 minutes
(`StartInterval=1800`, confirmed by reading the actual plist, not
assumed from memory). `sync-business` is scheduled on that same
`*/30 * * * *` cadence; the four downstream functions are staggered 5,
5, 10, and 15 minutes after each sync window so `send-alerts` and
`check-spend-anomaly` — which read data `sync-business` just wrote —
aren't racing it.

**Deliberately did not hardcode the service_role key into the
migration file.** pg_cron needs a credential to authenticate its HTTP
calls to the Edge Functions, same as our own test calls did, but this
migration file is the kind of thing that ends up in git history
forever. Instead it's read from Supabase Vault at call time via
`vault.decrypted_secrets` — the exact same pattern already established
by `get_refresh_token()` for Google refresh tokens. Requires a one-time
manual step (documented at the top of the migration file) where the
key is pasted directly into the Supabase SQL Editor's Vault insert —
never through this chat, never through a committed file.

**Not yet done / explicitly holding off**: the local `launchd` job
(`com.lsacompanion.sync`) has NOT been disabled yet. Want to see the
cron jobs actually fire successfully in production first — there's a
real difference between "the migration ran without error" and "the
jobs are genuinely executing on schedule," and this project's own
established discipline says don't claim the second from the first.
Verification query to run in the SQL Editor after the migration's been
applied and at least one 30-minute window has passed:

```sql
select jobname, status, return_message, start_time, end_time
from cron.job_run_details
order by start_time desc
limit 20;
```

Once that shows clean runs across all five jobs for a full cycle,
`launchd unload` the local job and remove the plist.

## Cloud migration, part 3 continued: cron.job_run_details "succeeded" was misleading — real bug found and fixed, 2026-08-19

**Exactly the trap flagged above.** `cron.job_run_details` showed every
job as `status: succeeded, return_message: 1 row` from the very first
run — but that only proves `dispatch_edge_function()`'s SQL executed
without a Postgres-level error (Vault lookup worked, the loop over
active businesses ran). It says nothing about whether the async
`net.http_post` call it queues actually reached the Edge Function
successfully, since pg_net is fire-and-forget from Postgres's side.

Checked the real evidence — `net._http_response` (the table pg_net
actually writes HTTP responses to) — and found **every single call
since the migration was applied had been failing with `401
UNAUTHORIZED_INVALID_JWT_FORMAT`**. Three days of "succeeded" cron runs
had done nothing but repeatedly fail to authenticate.

**Root cause**: this Supabase project has already partially migrated to
the new publishable/secret API key system (`SUPABASE_SECRET_KEYS` /
`SUPABASE_PUBLISHABLE_KEYS` already existed as Edge Function secrets
from earlier work) alongside the legacy JWT-format `service_role` key.
The value pasted into Vault during the one-time manual setup step was
the new-format `sb_secret_...` key, not the legacy JWT — sent as
`Authorization: Bearer sb_secret_...`, Supabase's edge gateway rejects
it outright as not being shaped like a JWT at all (distinct from a
signature/expiry failure, which is why the error was specifically
"invalid format" not "unauthorized"). Confirmed the correct value by
checking `scripts/.env`'s `SUPABASE_SERVICE_ROLE_KEY` shape directly
(starts with `eyJ`, 3 dot-separated segments — genuine JWT structure)
without ever printing the actual key value into chat.

**Fixed** via `vault.update_secret(id, new_value)` against the existing
secret's UUID, swapping in the correct legacy JWT key. Re-checked
`net._http_response` after the next scheduled fire and got real,
correct results:

```
sync-business:             {"success":true,"business":"Vertex Property Care","leadsSynced":177,"conversationsSynced":{"leadsUpdated":93,"messagesSynced":322},"costDaysSynced":15}
send-alerts:                {"alertsSent":0}
check-spend-anomaly:        {"anomaly":true,"alerted":false,"reason":"already alerted for this date"}
check-verification-expiry:  {"artifactsSynced":2,"alertsSent":[]}
webhook-export:              {"skipped":true,"reason":"no webhook configured"}
```

All five match exactly what real Vertex data should produce (177
leads/322 messages is the same known-good count verified multiple
times earlier; 2 verification artifacts and no webhook match the
already-confirmed real state). Confirmed clean across **two full
30-minute cycles**, not just one.

**Cron scheduling is now genuinely, not just nominally, working.**
Ready to retire the local `launchd` job — holding off only on the
user's go-ahead, since disabling it is the last step and worth doing
deliberately rather than folded into this same check.

**Retired, 2026-08-19**: `launchctl unload`'d `com.lsacompanion.sync`,
confirmed it no longer appears in `launchctl list`, then moved the
plist to `com.lsacompanion.sync.plist.disabled` in the same
`~/Library/LaunchAgents/` directory rather than deleting it outright —
easy to restore if the cloud pipeline ever needs a fallback. The sync
pipeline (`sync-business` → `send-alerts` / `check-spend-anomaly` /
`check-verification-expiry` / `webhook-export`) now runs entirely on
Supabase Cron, no longer dependent on this Mac being on. `auto-reply`
and `send-followups` remain the only pieces still local/Python, still
deliberately `DRY_RUN=True` and outside the scheduled pipeline by
design.

**Cloud migration (parts 1–3) is now complete.**

## Booking date capture — built and verified 2026-08-19

Real gap flagged during an earlier review of the tool's usability
("does Mark Booked give you a date to select?" — it didn't) and picked
as the first thing to fix now that cloud migration is done, since it
affects Vertex's daily use directly, independent of multi-tenant work.

**Built**: `migrations/2026-08-19_booked_job_date.sql` adds
`leads.booked_job_date` (plain `date`, nullable). Dashboard changes
(`site/dashboard.html`, synced to `docs/index.html` — same
hub/deploy-folder pair flagged as a standing risk during hosting setup,
kept in sync this time by diffing before overwrite, not just copying
blind):
- A "Job date" field appears in the lead detail panel whenever a lead
  is Booked (either Google's real `lead_status` or the local override),
  right below Notes, using the same immediate-save-on-change pattern
  already used elsewhere in the dashboard.
- A small green "Job: <date>" badge shows in the list view once a date
  is set, so it's scannable without opening the lead.

**Verified without logging into the dashboard** — entering a password
into any login form isn't something done even for the project's own
tools, so full click-through UI verification wasn't possible here.
Instead: confirmed the migration genuinely landed by querying the
column directly (not just trusting "done"), round-tripped the exact
write/clear call `saveBookedDate()` makes against a real Vertex BOOKED
lead (set to 2026-09-05, read back correctly, cleared back to null,
lead left exactly as found), and confirmed the RLS policy on `leads` is
row-scoped (`for all ... using (business_members membership check)`),
not column-restricted — same policy already letting `notes`/
`local_status_override`/`archived` work from the authenticated browser
session, so the new column follows the identical path with no separate
grant needed.

## Auto-reply and follow-ups: flipped live, ported to Cron, real bug found and fixed — 2026-08-20

**`DRY_RUN` flipped to `False`** in both `auto_reply.py` and
`send_followups.py`, per explicit user decision after being walked
through exactly what each template says and when it fires. Ran
`auto_reply.py` once locally in live mode to confirm it executes
cleanly — 0 candidates existed at that moment, so nothing actually sent
yet, but the live code path (no longer just printing "would send")
ran without error.

**Real gap surfaced immediately**: flipping `DRY_RUN` alone doesn't
achieve the original point of auto-reply — response *speed*. Neither
script was ever added to the local `launchd` schedule (deliberately
excluded originally) or the new Supabase Cron migration. Without a real
trigger, nothing fires until someone remembers to run the script by
hand, which defeats the entire premise this feature was built for.
Ported both to Edge Functions to close this for real.

**Built**: `supabase/functions/auto-reply/index.ts` and
`supabase/functions/send-followups/index.ts`, same one-business-per-
invocation pattern as everything else, reusing `_shared/google-ads.ts`'s
token exchange and the exact `appendLeadConversation` REST call already
proven working in `send-reply`.

**Real correctness fix made during the port, not a blind copy**: the
Python version used `datetime.now().hour` — whichever timezone the Mac
running it happened to be in (confirmed `Europe/London` via
`readlink /etc/localtime`, currently BST/UTC+1). There's no equivalent
"local machine time" in Supabase's cloud runtime; using the server's
raw UTC hour would have been silently wrong by an hour for half the
year. Hardcoded `Europe/London` explicitly via `Intl.DateTimeFormat`
with an explicit `timeZone` option instead, matching what the Mac was
implicitly doing. Cross-checked against Python's real `zoneinfo`
database independently before trusting it. Same known limitation as
before, just now explicit instead of accidental: needs a real
per-business timezone column before this can correctly serve businesses
outside the UK.

**A real, previously-undetected bug found while testing this, affecting
the already-live `send-reply` function too**: Google's REST API returns
HTTP 200 even when `appendLeadConversation` genuinely fails — the real
result is buried per-item inside `responses[].partialFailureError`.
Confirmed directly: a deliberately invalid `google_lead_id` (a
synthetic test lead, never a real customer's data) got a clean `200`
with `partialFailureError: { code: 13, message: "An internal error
occurred" }` in the body. All three functions that call this endpoint
(`send-reply`, `auto-reply`, `send-followups`) only checked
`response.ok` — meaning a genuine Google-side failure would have been
silently recorded as a successful send (`responded`/`auto_reply_sent`/
`follow_up_sent` all flipped `true` on a message that never actually
reached the customer). This is exactly the kind of gap that stays
invisible until it actually matters — `send-reply`'s one real customer
test happened to fully succeed, so this was never triggered in
production, but the code itself was wrong the whole time.

Fixed all three to check `!responses?.[0]?.partialFailureError` in
addition to HTTP status, redeployed, and **re-verified the fix actually
catches the failure** (not just that it compiles) — re-ran the same
invalid-lead-id test post-fix and confirmed `auto-reply` now correctly
reports `failed: 1` with the real Google error surfaced, and the synthetic
lead's `auto_reply_sent` stayed `false` (previously it would have
incorrectly flipped `true`). Same re-test done for `send-followups`.
Synthetic test leads deleted after each check — nothing fake left in
real tables.

**Scheduled**: `migrations/2026-08-20_schedule_auto_reply.sql` adds
`lsa-auto-reply` (`2,32 * * * *` — 2 minutes after each `sync-business`
window, as close as reasonably possible since a lead can't be known to
us before the sync that pulls it in) and `lsa-send-followups`
(`20,50 * * * *` — lighter cadence, since a 24h+ nudge isn't as
time-sensitive as the first response). Confirmed via `net._http_response`
after both fired for real: `{"repliedTo":0}` and `{"followedUpWith":0}`,
both `200`, both correct for the current real state (no eligible leads
right now).

**Known, accepted latency characteristic, not a bug**: worst case, a
lead arriving right as a sync window starts waits up to ~32 minutes for
`sync-business` to see it plus `auto-reply` to act on it — a real
consequence of polling a 30-minute-cadence API, not something this
schedule can improve on further without `sync-business` itself running
more often.

**Still not verified**: a genuine real send succeeding for real, live,
scheduled auto-reply/follow-up messages — no eligible lead has existed
yet since this went live. That's the real next confirmation, whenever a
new message lead actually arrives.

## Privacy policy — drafted, not published, real gaps flagged — 2026-08-20

Closes the data-privacy decision flagged as required back in Phase 1
("this product holds real consumer PII... Not fully resolvable in this
plan — flagging as a required decision before Phase 1 is considered
done") and never actually resolved until now.

**Built**: `PRIVACY_POLICY.md`. Grounded in the actual current schema
and infrastructure, not written generically — checked directly rather
than assumed: the exact PII fields stored (`contact_phone`, message
text, call duration, from `leads`/`conversation_messages`), the real
Supabase hosting region (`eu-west-1`, confirmed via
`supabase projects list`), and the real sub-processors already in use
(Supabase, Google, Resend, GitHub Pages for static hosting only).

**Structural decision**: split into two distinct data relationships
rather than one blanket policy, since they're genuinely different —
LSA Companion is the **data controller** for business account data
(login, business settings), but only a **data processor** for
end-customer lead data (phone numbers, messages) collected on behalf
of each business from their own Google Local Services Ads account.
Conflating these would have misstated the product's actual legal
position.

**Decisions made explicitly, not defaulted silently**: sole trader (no
registered company yet), `enpee.sides@gmail.com` as the privacy
contact, 90-day retention after a business disconnects.

**Deliberately left unresolved, marked in the document itself rather
than glossed over**:
- `[TO CONFIRM]` — the user's actual full legal name (placeholder left
  in, not guessed).
- `[TO CONFIRM]` — Resend's international-transfer compliance position
  was never independently verified.
- `[TO BUILD]` — the stated 90-day retention policy is **not yet
  technically enforced**. No scheduled deletion job exists. The
  document explicitly says so rather than describing an aspirational
  policy as current behavior — same "don't claim what you haven't
  verified" discipline as everywhere else in this project.

**Status: draft only, not linked from the dashboard, not shown to any
real business** — per explicit decision. Needs solicitor review before
being treated as binding.

## Retention-deletion job — built and verified 2026-08-20

Closes the `[TO BUILD]` gap flagged in the privacy policy the same day
it was drafted — section 6 promised 90-day deletion after a business
disconnects, but nothing enforced it.

**Built**: `migrations/2026-08-20_retention_purge.sql` —
`purge_disconnected_business_data()`, a plain Postgres function
(`security definer`, no external API involved) that deletes `leads`
rows for any business `disconnected_at` more than 90 days ago.
Deliberately scoped to `leads` only, not `daily_cost`/
`verification_artifacts` — those describe the business's own account,
not their customers, and aren't what section 6 promises to delete.
`conversation_messages.lead_id` already has `on delete cascade` to
`leads` (confirmed by reading the migration, not assumed), so deleting
a lead automatically removes its messages too — no separate delete
needed for that table. The business's own row is never deleted, only
its former customers' lead data.

Scheduled directly via `pg_cron` at `0 3 * * *` (daily, 03:00 UTC) —
no `net.http_post`/Vault credential needed here unlike the other
scheduled jobs, since this never leaves Postgres.

Added `data_retention_purges` as an audit trail (business_id snapshot,
business_name snapshot, leads_deleted count, timestamp) — deliberately
not foreign-keyed to `businesses`, so the audit record survives
independently of whatever happens to the business row later. Real,
verifiable evidence the policy is actually being enforced, not just
asserted.

**Verified with synthetic data, never real Vertex data, given this is
a genuinely destructive operation**: created two throwaway disconnected
businesses — one `disconnected_at` 100 days ago, one 10 days ago — each
with a synthetic lead and message. Ran the purge function for real.
Confirmed: the 100-day business's lead AND message were both deleted
(cascade proven, not assumed), its business row survived, and a correct
audit record was created; the 10-day business's lead and message were
both left completely untouched, and correctly got no audit record.
Real Vertex data checked before and after — still exactly 177 leads,
business row still `active` — confirmed untouched throughout. Cleaned
up both synthetic businesses and the synthetic audit row afterward.

`PRIVACY_POLICY.md` section 6 updated from `[TO BUILD]` to describing
actual, verified, enforced behavior.

## Multi-tenant access risk — re-verified against primary docs, and a bigger live gap found — 2026-08-20

Started multi-tenant work by re-checking the open risk flagged in
`CLAUDE.md` since the project began: whether servicing multiple
unrelated third-party businesses through one Manager Account needs
anything beyond Basic/Explorer access. Phase 0's original finding on
this was explicitly marked `[Medium confidence]` (a WebSearch summary,
never checked against Google's own primary docs) — read the actual
pages directly this time.

**Good news, now actually confirmed rather than assumed**: no distinct
approval category exists for multi-client/third-party tools. Access
tiers (Test/Explorer/Basic/Standard) apply the same regardless of
whether the developer manages one account or many separately-linked
ones. Re-checked the RMF-for-external-users requirement specifically
too (worried it might contradict the original Phase -1 finding) —
confirmed it only attaches to **Standard** access, not Basic/Explorer,
even when serving external users. The original architecture assumption
holds.

**Bigger, more urgent gap surfaced in the process, unrelated to
multi-tenancy specifically but found while re-reading this policy**:
Phase -1's original compliance review only ever confirmed the *read*
path (`local_services_lead` reporting) under the "Reporting"
permissible-use category. `AppendLeadConversation` — the write
capability that `send-reply`, `auto-reply`, and `send-followups` all
use, **already live in production sending real messages to real
customers** — falls under a different category ("Ad creation/
management" per Google's access-levels page) that was explicitly
flagged as needing resolution before real sends went live
("`BUILD_PLAN.md` line 314, Phase 3: *this can't stay open once we're
actually sending real messages*") and then never actually resolved.
The calls have technically succeeded every time (Explorer/Basic tier
doesn't technically block the write call — confirmed empirically by
every real send so far working), but "technically permitted to
execute" and "compliant with our token's approved permissible use" are
different questions, and only the second one is actually still open.

**Real, actionable next step, not just more reading**: found the actual
contact channel — Google's Ads API Compliance form at
`support.google.com/adspolicy/contact/contact_ads_api`, which
explicitly covers "Policy or RMF questions." Typical response time ~2
business days. This needs the account's own developer token/MCC details
to submit, so it's a real-world action for the user to take, not
something to submit on their behalf sight-unseen.

**Not a hard blocker to continued building** — the write calls
continue to work technically, and this exact ambiguity already existed
before today for Vertex alone; it just becomes more consequential the
more businesses depend on it. Flagging clearly rather than either
overstating it as an emergency or quietly leaving it exactly as
unresolved as before.

## Real mobile bug found by the user testing on their own phone — fixed 2026-08-20

User tested the live dashboard on their actual phone (first real
on-device test since the WhatsApp-style mobile redesign) and found the
bottom action buttons (Mark Booked, Archive, etc.) hidden behind the
mobile browser's own toolbar, unclickable.

**Root cause**: `height: 100vh` used across the app shell (`body`,
`#app`, `.shell`, `.list-panel`, `.detail-panel`). On mobile, `100vh`
equals the viewport height with the browser's address/toolbar chrome
*hidden* — but that chrome is visible more often than not, so the
actual visible area is smaller than `100vh`, pushing content anchored
to the bottom of a `100vh` container off-screen behind the browser's
own UI. The `.actions` row already had correct `env(safe-area-inset-bottom)`
padding for the iOS home indicator — that wasn't the bug, the container
height was.

**Fixed**: added `height: 100dvh` (dynamic viewport height, tracks the
real visible area) alongside each `100vh` declaration as a
progressive-enhancement override — old browsers keep the `vh` fallback,
modern ones get the corrected `dvh` value. Synced to both
`site/dashboard.html` and `docs/index.html`.

**Honest limitation on verification**: could not reproduce this myself
— it depends on real mobile browser toolbar show/hide behavior, which
this environment's preview tools don't genuinely simulate (resizing a
viewport isn't the same as a real phone's dynamic chrome). Confirmed
the CSS change is syntactically correct and applied identically to both
files; the actual fix confirmation needs the user re-testing on their
real phone.

## Major incident: the entire pipeline was silently dead for ~2 months — found, diagnosed, fixed 2026-10-22

User reported "recent calls and messages aren't showing up." This
turned out to be much bigger than a display bug.

**What was actually happening**: every lead in the database had a
`synced_at` no later than 2026-08-15, and the lead count had been stuck
at exactly 177 since then. It's now 2026-10-22 — **every scheduled
function (sync, auto-reply, follow-ups, all alerts) had been failing on
every single run for roughly two months**, while `cron.job_run_details`
kept reporting "succeeded" the entire time (the dispatcher SQL runs
fine regardless of whether the downstream call actually works — the
exact same class of misleading-success gap this project got bitten by
once already during the original Cron setup, now recurring in a new
form).

**Root cause, confirmed directly, not guessed**: calling Google's OAuth
token endpoint with the stored refresh token returned `invalid_grant`.
Checked Google's own setup docs: the OAuth consent screen was in
**Testing** publishing status, and Google automatically expires
refresh tokens issued under Testing after exactly 7 days, regardless of
usage. The token was obtained once on 2026-08-14 and never renewed —
consistent with everything breaking right around the 7-day mark and
staying broken silently ever since.

**Real troubleshooting detour, worth recording honestly**: getting a
fresh token wasn't simple. Google's consent screen kept showing a
passkey-creation prompt with no visible skip option, looping back to
the account page. Investigated two wrong theories before finding the
real one:
- First suspected the test-user list didn't include the right account
  — checked directly, it was actually fine (the account listed was
  correctly the one that administers LSA Companion's Google Ads
  Manager Account, not Vertex's own account directly — API access
  flows through the Manager Account link, never required being "a user
  on Vertex's Ads account" in the first place; an earlier answer in
  this same conversation incorrectly assumed otherwise before catching
  it).
- Separately discovered the user had been looking in the wrong Google
  Cloud Console account entirely (project list showed "create a
  project" — confirmed via the project's actual `project_id` from
  `client_secret.json`, not guessed).
- Also had to re-locate the OAuth consent screen UI itself — Google
  reorganized this under new "Google Auth Platform" branding since this
  project was first built, moving "Publishing status" and "Test users"
  onto a page now called "Audience" (confirmed via Google's current
  support docs, not assumed from training-era memory).
- The actual passkey loop itself turned out to be an unrelated
  Google sign-in UX quirk, resolved by just retrying — not caused by
  any of the above.

**Fix applied and independently verified at every layer, not just
trusted**:
1. Ran `get_refresh_token.py` in the background (output redirected to
   a file, since Python buffers stdout when not attached to a
   terminal — first attempt produced no visible output until restarted
   with `-u` for unbuffered output).
2. User completed the real Google sign-in/consent themselves — the
   refresh token itself was never pasted into this chat, by either
   side; it was read from the local output file directly
   (programmatically, never printed to chat) to update Vault's
   `vertex_refresh_token` secret via `vault.update_secret()` with the
   already-known secret UUID, and to update `scripts/.env` locally for
   manual debugging scripts.
3. Verified the new token works by calling Google's API directly,
   independent of our own Edge Function: real `200`, **181 leads now
   vs. 177 before**, including genuinely new ones dated 2026-10-15.
4. Then triggered the actual deployed `sync-business` function for
   real (not just the direct-API test script) and confirmed the same
   181/328-message counts landed, with fresh `synced_at` timestamps —
   proving the whole Vault → Edge Function → database path works, not
   just the token in isolation.
5. Deleted the temporary file holding the refresh token in plaintext
   once no longer needed.

**Real consequence flagged to the user, not glossed over**: 4 leads
from the outage window (dated 2026-10-15) will NOT get an automatic
reply — `auto-reply` only acts on leads under 24 hours old by design,
so nothing retroactively catches up on a backlog. One of them (a
MESSAGE lead, still unresponded) needs a manual reply from the user
directly; this is not something the automation will ever do for leads
from this window.

**Not yet resolved — real open follow-ups**:
- The OAuth consent screen is still in Testing status. Unless moved to
  "In production," this exact failure mode will repeat every 7 days
  the token isn't manually renewed. Moving to Production may require
  Google's app verification process for this scope — not yet checked
  how long that takes or what it requires.
- **No monitoring exists that would have caught this sooner.** Two
  months of complete silent failure is a real gap — `cron.job_run_details`
  showing "succeeded" is not sufficient monitoring, as this incident
  proves for the second time. Worth a real alert (e.g. a cron job that
  checks "has `leads.synced_at` advanced in the last N hours" and emails
  if not) rather than relying on someone noticing missing customer
  messages by chance.
- Unclear whether missed-call alerting (`send_missed_call_alerts.py`
  from earlier in this project) was ever ported to the cloud pipeline
  at all — worth checking separately, since if not, that's been
  unscheduled (not just broken) this whole time, a different kind of
  gap from everything else in this incident.

## Real monitoring built, real bug fixed, sync cadence tightened — 2026-10-22/23

Closes the "no monitoring exists" gap flagged directly above, same day
it was raised.

**Real second bug found while building this**: `sync-business`'s
upsert never explicitly set `leads.synced_at` — it relied on the
column's default value, which only applies on INSERT, never on an
upsert's UPDATE path. This is exactly why every pre-existing lead kept
showing a two-month-old `synced_at` throughout the whole OAuth outage,
even on cycles where the sync was later confirmed genuinely healthy
again — the field was quietly lying regardless of real sync health.
Fixed by setting it explicitly in every upserted record. Verified for
real: the single oldest-`synced_at` lead in the whole table (unchanged
since 2026-08-14) was re-synced and its timestamp correctly jumped to
"right now."

**Built**: `check-pipeline-health` — checks whether `leads.synced_at`
has advanced recently across active businesses, deliberately scoped to
this one signal rather than monitoring all 7 functions individually,
since every other function depends on the same Google refresh token
that caused the actual incident — this single check would have caught
it. Tracks state in a new `pipeline_health_status` table and only
alerts on a healthy→unhealthy *transition* (not on every check while
already-known-broken), with a matching recovery email when it comes
back. Scheduled via a new `dispatch_platform_function()` (same
Vault-credential pattern as `dispatch_edge_function`, minus the
per-business loop, since this check isn't per-business).

**Verified the healthy path for real**: real `200`, correct
`minutesSinceSync`, a real row logged in `pipeline_health_status`.
**Deliberately did not verify the alert-send path** — doing so would
mean temporarily pushing real Vertex lead timestamps backward to fake
a stale state; asked the user first rather than mutating production
data unilaterally for a test. Still unverified as of this entry.

**Also fixed the actual root blocker encountered while deploying
this**: the Supabase CLI access token (a separate credential from the
Google OAuth token — unrelated root cause, just discovered in the same
session) had also gone invalid. Generated a fresh one with the user
(bounded expiry recommended over "Never," full access required since
this token does real deploys/secrets-sets, not just reads) — this one
fails loudly and immediately at time-of-use, unlike the Google token's
silent 7-day expiry, so it doesn't carry the same monitoring gap.

**Sync cadence tightened from 30 to 5 minutes**, per explicit user
request after establishing the real operation-count math: 144 ops/day
at 30 minutes vs. 864 ops/day at 5 minutes, against a 2,880/day cap on
the current Explorer tier for one business — enormous headroom at this
scale. `auto-reply` and `send-alerts` tightened to match (2-minute
offset after each sync) rather than left on the old 30-minute offset,
since fresh data sitting unacted-on defeats the point of a faster sync.
`check-pipeline-health`'s staleness threshold tightened correspondingly
(90 → 15 minutes) and its own check frequency tightened (30 → 10
minutes), since a monitor needs to check at least as often as the
thing it's trying to catch. `check-spend-anomaly`, `check-verification-expiry`,
`webhook-export`, and `send-followups` deliberately left unchanged —
none of them are response-time-sensitive. **Verified for real**: `net._http_response`
shows `sync-business` firing every exactly 5 minutes, `auto-reply`/
`send-alerts` 2 minutes behind each one, and `check-pipeline-health`
correctly reporting `minutesSinceSync` tracking right around 5 — not
just registered, genuinely running at the new cadence.

**Capacity math caveat, carried forward explicitly**: this multiplies
per business, not just per sync cycle — revisit before a second real
business is onboarded, same flag raised (and then forgotten about)
back when the original 30-minute figure was chosen.

## Missed-call handling — researched, not yet built

User asked about SMS/WhatsApp as a missed-call channel. Checked Meta's
actual WhatsApp Business policy first: a business cannot initiate a
WhatsApp conversation with someone who hasn't separately opted in to
WhatsApp contact specifically — contacting via Google LSA does not
count as that opt-in. Outside a 24-hour reply window, only pre-approved
Message Templates can be used. This makes WhatsApp a real compliance
problem, not just a build task, for anyone who hasn't messaged Vertex's
WhatsApp number first. Twilio SMS is technically simpler but needs a
Regulatory Compliance bundle submitted to Twilio for UK numbers —
**user already has this in place**, so Twilio is a genuinely ready
fallback/second channel if needed.

**Before reaching for either**: checked whether the already-live
`AppendLeadConversation` mechanism (used by `send-reply`/`auto-reply`)
could just be reused for missed `PHONE_CALL` leads too, since that
would mean zero new infrastructure and zero new compliance risk.
Wanted to test live but the most recent genuinely-missed call in real
data was from 2026-08-03 — nearly 3 months old; sending "sorry we
missed your call" about something that stale would look careless to a
real customer and wasn't a fair test either. User chose to skip the
live test and reason from documentation instead: `conversation_channel`
on `LocalServicesLeadConversation` is documented as **output-only**,
and our existing request never sends a channel/type field at all — good
evidence (not a live-tested guarantee) that `AppendLeadConversation`
isn't restricted by the lead's own `lead_type`. Not yet built — the
tightened 5-minute sync cadence should surface a genuinely fresh missed
call soon, which would make the real first test also genuinely useful
to that customer rather than a contrived one.

## Missed-call handling — built and deployed 2026-10-23

**Built**: `supabase/functions/missed-call-handler/index.ts`. Closes
two gaps at once: the original `send_missed_call_alerts.py` (emails
the business) was never ported to the cloud, and nothing had ever
texted the customer in real time. For each `PHONE_CALL` lead with
`call_duration_millis = 0`, not yet alerted, under 24 hours old:
sends a business-hours-aware templated text to the customer via the
same `AppendLeadConversation` mechanism already proven for message
auto-replies, and emails the business via the same Resend pattern
already proven across three other functions.

**Deliberate tracking design**: `missed_call_alert_sent` is set on the
*email's* success, not the customer text's — the email is the more
reliable, more load-bearing action (doesn't depend on Google's API at
all), and gating on the less-reliable action would mean re-emailing the
business every 5 minutes forever if the text ever failed. The text's
own success/failure is logged in the function's response regardless,
not silently dropped.

Scheduled via `migrations/2026-10-23_schedule_missed_call_handler.sql`
on the same 5-minute, 2-minute-offset cadence as `auto-reply` — a
missed call is just as time-sensitive as an unanswered message.

**Genuinely untested against a real phone-call lead as of this entry**
— `conversation_channel` being documented output-only is good evidence
the mechanism works for `PHONE_CALL` leads, not proof. First real test
is still whenever a genuinely fresh missed call arrives.

## Link rendering researched, added to both customer-facing templates — 2026-10-23

User asked how a link in a message would render to the customer, with
a view to adding one pointing to Vertex's real quote form
(`vertexcare.co.uk/book.html`). Checked Google's own support docs
directly rather than guess, and found something that reshapes the
mental model of this whole messaging feature: a reply sent via
`AppendLeadConversation` isn't delivered through any in-app Google chat
UI at all — Google actually delivers it to the customer as a real
**email or SMS text message**, routed through an anonymized alias
(quoted directly from
[Google's Local Services Ads help page](https://support.google.com/localservices/answer/6224859)).
That means link rendering is governed by ordinary SMS/email client
behavior, not some unknown Google-specific UI — both auto-linkify plain
`https://` URLs, with one documented iOS quirk (a rich preview card
only appears if the URL is at the very start or end of the message,
confirmed via
[Twilio's own guidance](https://support.twilio.com/hc/en-us/articles/360013199334-How-do-SMS-and-MMS-URL-Link-Previews-Work-on-Mobile-Devices),
though the link stays tappable regardless).

**Added to both templates**, URL placed at the message's end on
purpose (matches the iOS preview-card placement rule): `auto-reply`'s
`TEMPLATE`/`AFTER_HOURS_TEMPLATE` and `missed-call-handler`'s
equivalents. Verified the exact new template text actually gets sent
by triggering both functions against synthetic fake-lead-ID test data
(same safe pattern used throughout this project — Google rejects the
fake ID but still echoes the real template text back in the response),
confirmed both read correctly with the link at the end, then deleted
the synthetic leads. **Real side effect from that test, not a bug**:
`missed-call-handler`'s email-to-business step fired for real during
the test (doesn't depend on the Google send succeeding, by design),
so a real "Missed call from +10000000001" email landed in the
business's actual inbox — flagged to the user as test fallout, not a
real lead.

## Tagged quote-form link + "form received" return ping — built 2026-10-25, NOT YET DEPLOYED

**Problem found**: `send-followups` nudges any MESSAGE lead with `responded = false` 24h after the auto-reply ("just checking in on your enquiry…"). `responded` is only ever set by someone replying inside this Companion. When a customer follows the auto-reply's `book.html` link and fills in the form, the business then deals with them in its own system — so the Companion would still nudge someone who already had a quote coming.

**Built (code + migration written, tested locally, nothing deployed from here)**:
- `migrations/2026-10-25_form_submitted_at.sql` — `leads.form_submitted_at timestamptz` (nullable, existing rows untouched).
- `supabase/functions/form-received/index.ts` — server-to-server endpoint (deploy with `--no-verify-jwt`; self-authenticates with a shared secret in the `x-companion-secret` header, constant-time compare, fails closed if `FORM_RECEIVED_SECRET` isn't set). Takes `{ lsa_lead_id }` (must be a uuid), sets `responded = true` + `form_submitted_at = now()`, idempotent (repeat ping changes nothing), 404 on unknown id. Knows nothing about Vertex's schema — it's a generic "the customer completed the follow-up step" signal, consistent with the standing "CRM integration optional, tool stays general-purpose" rule.
- `auto-reply` and `missed-call-handler`: the quote-form link is now per-lead — `https://vertexcare.co.uk/book.html?lsa=<this lead's leads.id>` — still at the very end of the message (iOS link-preview rule from the earlier link-rendering entry). The id is this table's own random uuid, not a Google id; no personal details in the URL. (The Vertex URL is still hardcoded in both files, same as before — a known multi-tenant gap, unchanged by this work.)

**Verified locally (no Deno on this machine, so by running the real code under Node with stubs)**: form-received against an in-memory stand-in for `leads` — 405 on GET, 401 with no/wrong secret, 400 on bad JSON / non-uuid id (incl. an injection-looking string), 404 unknown lead, 200 marked on first ping (responded + timestamp set), 200 "already recorded" on repeat with the timestamp unchanged, 500 fail-closed with no server secret. Both templates, open and after-hours: each lead gets its own link, URL last. The Supabase query semantics (`update … .is('form_submitted_at', null) … select`) were exercised only against the stand-in, NOT a real database — first real ping is the true test. Also caught during this work: a first pass left a stale `text` reference in `missed-call-handler`'s response that would have thrown at runtime (a syntax-only check passes it) — fixed and re-tested.

**Deploy order matters (the other half lives in Vertex's CRM project)**:
1. Vertex side first (already done/ready): CRM column `enquiries.lsa_lead_id` ✓ applied; updated `book.html` uploaded to the live site; `lead-ack` v8 deployed ✓.
2. Here: apply the migration; `supabase functions deploy form-received --no-verify-jwt`; `supabase secrets set FORM_RECEIVED_SECRET=<secret>`.
3. On Vertex's CRM project set the matching `COMPANION_FORM_RECEIVED_SECRET` + `COMPANION_FORM_RECEIVED_URL` (= this project's `/functions/v1/form-received`).
4. Only THEN redeploy `auto-reply` and `missed-call-handler` — that's the moment tagged links start going to real customers.
5. End-to-end test: invoke Vertex's `lead-ack` with a synthetic payload carrying a real `leads.id`; expect `companionPing: "ok"` and that lead showing `responded = true` + `form_submitted_at`.

**Not built (offered)**: a "Form received" badge in `site/dashboard.html` (would also need syncing to `docs/index.html`).

## Lead-tracking deploy completed, Service type field, bulk archive — 2026-10-25/27

Closes out the Vertex-side lead-tracking work from the entry above —
this session deployed and verified the LSA Companion half of it, which
had been written and waiting locally.

**Deployed and verified for real**: `FORM_RECEIVED_SECRET` set (by the
user directly, never passed through chat), the `form_submitted_at`
migration run, and `auto-reply`/`missed-call-handler`/`form-received`
all deployed. Since the real shared secret was never visible to this
session, verification was split accordingly: confirmed `form-received`
genuinely rejects bad input for real against the live endpoint (401 on
wrong secret, 401 on no secret, 405 on wrong HTTP method — notably
401 rather than the earlier-seen 500 "not configured," confirming the
secret really is registered and being compared, not just absent), and
separately confirmed the per-lead tracking link renders correctly
(`?lsa=<the lead's own uuid>`) by triggering `auto-reply` against a
synthetic lead and reading the exact link back out of the response.
The *acceptance* path (`form-received` with the real secret) could not
be verified by this session by design — handed to the user as a
one-line `curl` command to run themselves with the real secret, using
the same synthetic lead so the result could still be checked
afterward. Synthetic lead deleted once no longer needed.

**Service type field added to the dashboard**. Checked directly
against a real lead screenshot the user shared (331136391) that
LSA Companion already captures both the "Business category" Google
shows (`category_id`, already displayed via `formatCategory()`) and
"Service type" (`service_id`) — confirmed against the real stored
value (`exterior_window_cleaning`) that it was being synced correctly
but never actually rendered anywhere in the UI. Added a matching
`formatService()` helper and a new field in the lead detail panel.
Synced to `docs/index.html`.

**Bulk archive built**. A "Select" toggle in the top bar switches the
list into multi-select mode — checkboxes per lead, a "select all
visible" checkbox scoped to the current tab/search filter (not all
leads globally), a live selected-count, and a single "Archive" button
that updates every selected lead's `archived` field in one Supabase
call. Verified the actual bulk-write call for real against three
synthetic leads (never real Vertex data) — confirmed all three flipped
`archived: true` in a single `.update().in('id', [...])` call, proving
no special RLS/grant issue, same as every other per-lead field in this
dashboard. Synced to `docs/index.html`. Full click-through verification
still wasn't possible (login still off-limits to this session), same
limitation as the Job date and webhook-export features earlier.

## Category/service filters added — 2026-10-27

User reported Business category "not showing" after the field-labeling
fix above — turned out the data and `formatCategory()` were both fine
(confirmed again: 181/181 leads carry a `category_id`), it was genuinely
just visually easy to miss in a small unlabeled subtitle, fixed by the
entry directly above this one. That investigation led into this
request: filter the lead list by category/service type, not just view
them per-lead.

**Checked the real distribution before building anything**: 2 distinct
business categories (`cleaning_service`: 38, `window_cleaner`: 143) and
12 distinct service types (`exterior_window_cleaning`: 37,
`standard_clean`: 15, `oven_cleaning`: 6, plus several with single-digit
counts; `service_id` is null on ~105 leads, mostly phone calls) — real
variety worth a dropdown filter, not a guess.

**Built**: two `<select>` dropdowns (Business category, Service type)
next to the search box, populated once at load from the actual distinct
values present in `allLeads` (not a hardcoded list — stays correct as
real data changes), displayed through the same `formatCategory()`/
`formatService()` prettifiers already used elsewhere. Both filters
combine with the existing tab and search filters (all are AND'd
together in the same `filtered` computation), so "Booked" + "window
cleaner" + a phone-number search all narrow together correctly.
Synced to `docs/index.html`.

## Telemetry chips explained, a real archived-filtering bug found and fixed — 2026-10-27

User asked what the three top-bar stats (Needs response / At risk /
Missed calls) actually track and whether they're the right ones.
Walked through the exact logic (`!responded && !archived`; average
cost-per-charged-lead × flagged-lead count; `call_duration_millis = 0`)
and noticed while checking that only "Needs response" excluded
archived leads — "At risk" and "Missed calls" didn't, so anything
already archived would keep inflating those two forever.

**Real false alarm first**: user reported "Needs response" not moving
after archiving ~165 leads. Checked the real data directly rather than
assume a bug — the archive had genuinely landed (165/181 archived) and
the correct live count really was 12; the number shown was just a
stale, unrefreshed page (this dashboard loads leads once at open, no
polling/realtime). Confirmed by the user after a real reload.

**Then fixed the actual bug**: `renderTelemetry()`'s "At risk" and
"Missed calls" now also exclude archived leads, matching "Needs
response". Deliberately did NOT change `isFlagged()`/`isMissedCall()`
themselves, since those same functions also drive the FLAGGED/MISSED
badges on individual leads — an archived lead you're actually looking
at in the Archived tab should still show accurate badges; only the
*summary count* should stop including it. Verified the real impact
before syncing: "At risk" was showing a non-zero figure from 7 flagged
leads that are now all archived (correct value: 0), "Missed calls" was
showing 23 that are now all archived (correct value: 0) — a real,
meaningful bug, not a cosmetic one. Synced to `docs/index.html`.

## First real message since the outage fix, auto-reply pipeline confirmed end-to-end — 2026-10-27

User reported a genuine new message lead had come in. Checked it
directly rather than take the report at face value: `google_lead_id
348461316`, `lead_type MESSAGE`, arrived `2026-10-27T11:46:50Z`.

Confirmed from the real row, not assumed:
- `auto_reply_sent = true`, `auto_reply_sent_at = 11:52:02Z` — about
  5-6 minutes after the lead landed, matching the tightened `*/5`
  sync + `2-57/5` auto-reply cadence set up after the OAuth outage.
- `alert_sent = true` — the business-alert email also fired.
- `responded = true` — the lead correctly drops out of "Needs
  response" without any manual action.
- `category_id = xcat:service_area_business_window_cleaner`,
  `service_id = null` for this one (Google doesn't always populate
  service_id — category isn't guaranteed to come with it).

This is the first real-world lead to go through the whole chain built
and fixed this session: fresh OAuth token → 5-minute sync → auto-reply
with the per-lead booking link → business alert. All four stages
fired correctly on a genuine customer message, not a synthetic test.

Still unverified: what the customer's phone actually displayed (did
the booking link render as a tappable link in the SMS/email they
received) — that requires either the customer's own view or checking
the conversation thread in Google's own LSA interface, neither of
which I have access to. `form_submitted_at` is still null across every
lead in the table, so the `form-received` accept path has still never
fired for real.

## Picture attachments on messages — built, not yet live-tested — 2026-10-27

User asked whether a lead sending a photo would show up in the tool.
Checked rather than guessed: confirmed directly against Google's own
v25 field reference that `local_services_lead_conversation
.message_details.attachment_urls` exists (repeated string, output-
only) — Google does track it — but our GAQL query never selected it,
`conversation_messages` had no column for it, and the dashboard's
thread renderer only ever emitted escaped text. Three gaps stacked on
top of a real Google capability we just weren't using.

**Built:**
- `migrations/2026-10-27_conversation_attachments.sql` — adds
  `conversation_messages.attachment_urls text[]`, nullable.
- `sync-business/index.ts` — GAQL query now also selects
  `message_details.attachment_urls`; `syncConversations()` stores it
  (null when empty, never an empty array).
- New `get-attachment` Edge Function — proxies the actual image bytes.
  Needed because Google's attachment URLs require an authorized OAuth
  credential to download, and the browser only ever holds a Supabase
  session, never a Google token. Same auth pattern as `send-reply`:
  verify the caller's Supabase JWT, look up `business_members` to
  confirm they actually belong to the message's business, exchange the
  stored refresh token for a Google access token via
  `get_refresh_token`, then fetch the attachment with that token
  (sending both `Authorization: Bearer` and the `developer-token`
  header, since the exact requirement is ambiguous — see below).
- Dashboard thread rendering now emits a loading placeholder per
  attachment, and a new `hydrateAttachments()` loads each one via an
  authenticated `fetch()` (an `<img src>` can't carry an auth header),
  swapping in a real `<img>` pointing at a local blob URL on success,
  or "Image unavailable" text on failure. Synced to `docs/index.html`
  (diffed first — only the intended lines differed).

**Genuinely unverified, flagged honestly rather than glossed over:**
Google's v25 docs describe the download auth as "authorized Google
Cloud project credentials" — vaguer than older API versions, which
said plainly "the developer token." Nobody has sent a picture through
this pipeline yet, so neither the GAQL field (does it actually come
back populated) nor the download auth (does our access token, or the
developer-token header, actually work against that URL) has been
tested against anything real. Checked JS syntax only (`node --check`
on the extracted inline script — passed); could not run the TypeScript
Edge Function locally (no `deno` installed) or exercise the real login
flow (would mean entering the business's real password, which I won't
do). The first real photo a lead sends is the actual test — check the
Edge Function's logs if an image doesn't load, the error detail is
deliberately passed through rather than swallowed.

**Deployed**: migration ran (first attempt went into the wrong
Supabase project — easy mix-up with two separate projects in play,
re-ran in the right one), `get-attachment` deployed. Verified directly
rather than taken on trust: `conversation_messages.attachment_urls`
confirmed present via a real REST query (returns `null` on existing
rows, as expected), and the deployed function correctly 401s with no
auth header — confirms it's gated the same way as `send-reply`, not
left wide open. Still waiting on a real picture message to prove the
actual download path end to end.

## Second OAuth-token outage, same root cause, caught fast this time — 2026-10-30

User asked "is LSA tool still working." Checked rather than assumed, and
the answer was no.

**What happened**: `leads.synced_at` had been frozen since
2026-10-29T14:05 UTC — confirmed via `pipeline_health_status`, which had
correctly flagged every check since 2026-10-29T14:20 UTC as unhealthy
(the healthy→unhealthy transition row), meaning the alert email to
`OPERATOR_ALERT_EMAIL` should have fired right then. The monitoring built
on 2026-10-22 worked exactly as designed — this is the first real proof
of that, not just the "healthy path" verified back then.

**Root cause, confirmed directly against Google again, not assumed from
the Oct 22 history**: exchanging the stored refresh token returned
`invalid_grant — Token has been expired or revoked`. This is the exact
same failure as the Oct 22 incident, for the exact same reason flagged
as an open risk at the time and never resolved: the OAuth consent screen
is still in **Testing** publishing status, and Google expires Testing-mode
refresh tokens after exactly 7 days regardless of usage. The token
renewed on 2026-10-22/23 died almost exactly 7 days later, 2026-10-29.
This will keep recurring on a ~7-day cycle until the app moves to
Production.

**Fixed and independently verified, same discipline as last time**:
1. Ran `get_refresh_token.py` in the background; user completed the real
   Google sign-in/consent themselves.
2. New refresh token read programmatically from the script's own output
   file — never pasted into chat by either side.
3. Looked up the Vault secret's id (`vertex_refresh_token`,
   `f60eb9e5-8572-4e50-8b28-dc96f1772822`) via a read-only query (name
   only, no secret value), then updated it with `vault.update_secret()`
   via `supabase db query --linked --file`, and updated `scripts/.env`'s
   `REFRESH_TOKEN` the same way. Plaintext output file deleted
   immediately after.
4. Verified the new token works against Google directly, independent of
   our own code: real `200`, fresh access token.
5. Then triggered the real deployed `sync-business` function (not just
   the direct-API check) and confirmed it for real: `184` leads, `334`
   messages, fresh `synced_at` landed at `2026-10-30T16:05:01Z` —
   essentially live at the moment of the check.

**Not yet resolved — same gap as Oct 22, now hit twice**: the consent
screen is still in Testing. User tried to switch it to Production during
this session and hit a real blocker — Google requires a valid app name,
support email, homepage URL, and privacy policy URL on the Branding page
before "Publish app" is enabled, and the homepage/privacy-policy URL
requirement is itself blocked on the still-unresolved dashboard hosting
problem (GitHub Pages 404ing since the repo went private — see the
hosting discussion elsewhere in this session). Until that's resolved,
this exact outage will keep recurring roughly weekly.

## Chat replies to the owner's lead channel + new follow-up wording — built 2026-11-02, NOT YET DEPLOYED

Owner approvals (QP Operations): **#7** follow-up wording, **#8** chat cards. The owner confirmed that
Google allows automated replies, and that customers' chat messages may appear in the Vertex Leads
Telegram bot.

**Why:** a customer who replies in the Google chat, instead of using the quote form, got no further
attention: alerts only cover brand-new leads, and the 24h nudge didn't even repeat the link.

**Follow-ups (send-followups, auto-reply):**
- First reply now points at the instant price ("You can see your price straight away here (it takes
  30 seconds), or reply with your postcode and type of home and we'll send it: <link>"), with an
  after-hours variant. URL kept at the end (iOS previews).
- 24h reminder now carries the lead's own link.
- New final message on day 3 (`leads.follow_up_2_sent`): "Still need a hand? Reply with your
  postcode, the type of home (house, bungalow or flat) and how many bedrooms, and we'll send your price."
  Worded for any service (LSA leads aren't all window cleaning).
- Both nudges now skip leads where the form was filled in or the customer has replied in the chat
  since the auto-reply (that reply goes to the owner as a card instead).

**Chat cards (new chat-cards, chat-reply):**
- `chat-cards` (cron `lsa-chat-cards`, every 5 minutes, a minute after sync): CONSUMER messages from
  the last 48h, after the auto-reply, not yet carded → POST to `businesses.chat_card_url` with the
  shared secret (`CHAT_CARD_SECRET`, header `x-companion-secret`). Sends the lead's Companion id,
  message id, text, photo count and whether the form was filled in; never the phone number.
  Marks `conversation_messages.card_sent_at`. Off for any business without `chat_card_url`.
- `chat-reply` (`--no-verify-jwt`, same secret, constant-time check): sends the text the owner
  chose through `appendLeadConversation` (checks `partialFailureError`), then marks the lead responded.
- For Vertex the URL is its CRM's `lead-router/lsa-chat` (stage 47 in QP-Group/vertex-property-care):
  the card shows the message and a suggested reply from the rate card; the owner taps Send / Write my
  own / Skip. Nothing reaches a customer without the owner's tap.
- The migration marks existing customer messages as already carded and older leads' final nudge as
  sent, so switching on doesn't flood the owner or message old leads.

**Tested (simulated data, 2026-11-02):** chat-cards (only post-auto-reply customer messages, photos-only
included, no repeats, secret sent); send-followups (24h reminder with link, day-3 message once, skips
on chat reply and on form filled, not before day 3); chat-reply (401 without secret, Google refusal
not marked responded, success marks responded). The Vertex side was tested end to end against a local
Postgres copy with simulated Telegram.

**Deploy (owner, in this order):**
1. Make one random secret (e.g. `openssl rand -hex 32`). Set it here:
   `supabase secrets set CHAT_CARD_SECRET=<secret> --project-ref clzzqqwgluazefftvphw`
   and in Vertex's CRM Vault (SQL editor): `select vault.create_secret('<secret>', 'lsa_chat_secret', 'LSA chat cards');`
2. Vertex CRM first: run stage 47 and deploy `lead-router --no-verify-jwt` (see that repo's
   `docs/instant-quote-deploy.md`, "Stage 47").
3. Here: run `migrations/2026-11-02_chat_cards_and_final_followup.sql`; deploy `auto-reply`,
   `send-followups` and `chat-cards` as before; deploy `chat-reply --no-verify-jwt`.
4. Test: reply in the Google chat to a test lead (or wait for a real one); a card should appear in the
   Vertex Leads bot within about 5 minutes.
**Undo:** `select cron.unschedule('lsa-chat-cards'); update businesses set chat_card_url = null;` and
redeploy the previous `auto-reply` / `send-followups` from main.

## OAuth consent screen moved to Production — the real fix, not another rotation — 2026-11-09

Closes the gap flagged at the end of the second outage entry above:
the 7-day refresh-token expiry recurred exactly on schedule (died
2026-11-06, 7 days after the 10-30 rotation), confirmed via
`pipeline_health_status` before fixing it properly this time instead
of just rotating again.

**What was actually blocking Production status**: Google requires a
homepage URL and privacy policy URL on a domain it can verify you own,
before the "Publish app" button is even enabled. We had neither — the
dashboard itself doesn't count as a homepage (it's app UI, not a
description of the app, and Google explicitly disallows "only a login
page"), and the hosting was still broken anyway (GitHub Pages 404ing
on the private repo).

**Built and verified at each step, not just assumed working**:
1. Repo flipped back to public by the user; confirmed directly
   (`visibility: PUBLIC`), confirmed no secrets were ever committed
   (`scripts/.env` and `client_secret.json` are gitignored, `git log`
   on those paths is empty) before recommending this.
2. GitHub Pages re-enabled via the API (`main` branch, `/docs`),
   verified live with a real `200` and real content, not just a
   "configured" response.
3. New `docs/about.html` (homepage describing what the product
   actually does) and `docs/privacy.html` (the existing
   `PRIVACY_POLICY.md`, rendered as a real page) — user explicitly
   chose to publish the privacy policy as-is rather than wait for
   solicitor review, with the draft notice kept visible on the page
   itself rather than hidden.
4. Google Search Console domain verification — first attempt failed
   for a real, specific reason: the verification meta tag was placed
   on `about.html`, but the verified property is
   `https://qp-group.github.io/lsa-companion/`, which GitHub Pages
   serves as `index.html`. Moved the tag to `index.html` (and
   `site/dashboard.html`, kept in sync), confirmed it was actually
   being served at the right URL before telling the user to retry —
   verification then passed.
5. User filled in the Branding page and clicked Publish app.
   **Confirmed directly from the console's own response**: Publishing
   status is now "In production."

**Real uncertainty, resolved by re-testing rather than assuming**: the
refresh token already in Vault (from the 11-09 rotation) was issued
*while the app was still in Testing*, before the Production switch.
One unconfirmed third-party report claimed Testing-issued tokens keep
their 7-day cap even after the app goes to Production, contradicting
Google's own docs. Rather than leave that ambiguous, re-ran the OAuth
flow once more after Production status was confirmed, so the token
now in Vault was issued under Production specifically. Verified the
usual way: real `200` from Google directly, then the real deployed
`sync-business` function run for real (`195` leads, `364` messages,
fresh `synced_at`).

**Not done, deliberately deferred**: full Google Trust & Safety scope
verification (demo video + review, per Google's docs typically 3-5
business days, real-world reports of longer) — not required to fix
the recurring outage, which was the actual goal here. It matters later
for removing the "unverified app" warning screen before onboarding a
second real business, not before.

**Real test still pending**: whether a Production-issued token
actually survives past 7 days. Won't be fully certain until this is
checked again after 2026-11-16 and `pipeline_health_status` shows no
gap — flagged honestly rather than declared solved on theory alone.
