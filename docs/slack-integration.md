# Leave Desk in Slack

The Leave app is a Slack app that talks to the Apps Script web app at `APP_URL` (`…/exec`). Code lives in `src/slack/` plus `src/WebApp.gs` (`doPost`) and `src/notify/SlackChannel.gs`.

## 1. What a person can do

| Where | Action | What happens |
|---|---|---|
| `/leavedesk` (or `/leave`) | Apply | Opens the **Apply for leave** modal (type, first day, last day, reason). On Send, a card appears in the Leave app DM at once ("Sending to Leave Desk…") and is updated when filed. |
| `/leavedesk balance`, `/leave-balance` | Balance | Balance card: one bar per leave type, used / pending, Request leave button. |
| `/leavedesk requests`, `/leave-requests` | My requests | Every request this year with type, dates, working days, status, approvers, ID. |
| `/leavedesk help`, `/leave-help` | Help | Command list and where the Home tab is. |
| Leave app → **Home** tab | Dashboard | Balance, requests waiting for your decision (with Approve / Reject), your requests. Republished after every change and every ten minutes. |
| DM from the Leave app | Approve / Reject | Approvers get a card with buttons; a comment modal opens; the decision is filed in the background and the card is updated. |

**Apply form details.** Date pickers start empty (Slack itself labels today's date "Today" and tomorrow "Tomorrow"; that label is Slack's, not ours). Each pick redraws the form through `views.update` with a summary line, for example "📅 Mon 30 Nov 2026 → Fri 4 Dec 2026 · 5 days · 18 left in Paid / Casual Leave", and warns before Send when days go beyond the balance. A **Half day** checkbox under Duration files only the first day as 0.5; the last day is ignored. The typed reason survives every redraw.

Aliases accepted as the first word of the text: `balance bal status left`, `requests request list mine history`, `help ?`. Anything else shows help with "I don't know `word`".

## 2. Card design rules

Every card answers four questions with labels, never a single line:

```
📝 Your leave request
Status      ⏳ Waiting for Test Lead or Test CXO — either one is enough
Requested by  Test Employee · Employee · Test Team      Leave type   Paid / Casual Leave
Dates         Wed 18 Nov → Thu 19 Nov                   Working days 2 days
Reason        Family trip
Approvers     ⏳ Test Lead · Team Lead · waiting
              ⏳ Test CXO · C-suite · waiting
              Either approval is enough. Any rejection closes the request.
📬 Your approvers have been told. You will get a message here as soon as someone decides.
[Open in Leave Desk]
LR-2026-0014 · sent 2026-11-16 10:30 · Leave Desk
```

- **Requested by** always carries name · role (Employee / Intern / Contractor / Team Lead / C-suite) · team.
- **Approvers** is one line per person: decision emoji, name, role, state, decision time.
- **Status** is a sentence built from the approvals (`SlackCards.statusText`), not a bare code.
- Approver cards are titled "Leave request — your decision needed" and include "👉 Your decision is needed…" with the parallel-approval rule.
- Decision cards are titled "✅ You approved Name's leave" / "❌ You rejected Name's leave" and carry the comment.
- Balance uses a ten-cell bar in monospace: `` `██████░░░░` *12 of 20* days left ``.

Block Kit limits to remember: 50 blocks per message, 100 per Home view, header text ≤ 150 chars, button `value` ≤ 2000 chars, ≤ 10 fields per section.

## 3. Why the typed command disappeared, and the fix

A slash command's reply is **ephemeral** by default: Slack shows only the answer, marked "Only visible to you", and does not show the command. Vacation Tracker keeps the command on screen because it answers **in_channel**.

Leave Desk now does both:

- **Inside the Leave app DM** (Messages tab): reply `in_channel`. Slack then posts the typed command as the person's own message and the card below it, permanently.
- **In any channel or another DM**: reply `ephemeral`, prefixed with "`/leavedesk balance` · asked by @you · only you can see this reply", so the request is still visible and nobody else sees a balance.

To know whether the command came from the app DM, `SlackBot.dmChannel(user)` asks `conversations.open` once (cached six hours, also learned from `chat.postMessage` replies). That call needs the **`im:write`** scope. Without it the ephemeral + echo form is used everywhere.

## 4. The Slack timeout ("operation_timeout" / "Darn – that slash command didn't work")

Slack waits **3 seconds** for the Request URL to answer. Apps Script web apps answer slowly:

1. **Cold start.** A new execution of the script costs 0.5–2 s before any code runs, more right after a new deployment.
2. **The redirect.** Apps Script answers every `doPost` with a 302 to `script.googleusercontent.com`; Slack follows it, which is a second round trip.
3. **Slack Web API calls inside the request.** Opening a modal (`views.open`) or posting the requester card (`chat.postMessage`) is ~300–600 ms each.
4. **First contact.** The first time a Slack user talks to the app we call `users.info` and read the Sheet to find the employee. Later calls use the cache.
5. **Trigger creation.** `ScriptApp.newTrigger` inside a request costs hundreds of ms.

What the code does about it:

- Slash replies (`balance`, `requests`, `help`) read only CacheService. No Sheet, no Slack API, no trigger.
- First-contact linking is queued **without** creating a trigger; the once-a-minute trigger writes `slack_user_id` later.
- Send / Approve / Reject answer immediately (card first, file later) and create one one-off trigger so the job runs within seconds; the minute trigger is the safety net.
- Every phase is timed. Apps Script → **Executions** shows one line per Slack call, for example `Slack slash_command answered in 1840 ms (Slack allows 3000): token 40ms · snapshot(cache) 60ms · where 420ms`. If Slack still times out, these numbers say where the time went.

What only the user can check:

- The deployment is **Execute as: Me, Who has access: Anyone**. With any other access setting the 302 lands on a Google sign-in page and Slack times out every time.
- `APP_URL` is the `/exec` URL of the deployment that is live, with no trailing slash.
- Cold-start timeouts right after `clasp push` + new version are expected once or twice; warm calls are fast.

If timeouts persist on warm calls, the next step is to move the `views.open` call off the request path: answer the slash command with an ephemeral "Opening the form…" and open the modal from a job. That loses the modal (trigger IDs expire after 3 s), so it would mean a Home-tab button instead of a modal from the command.

## 5. Setup checklist (Slack side)

1. **api.slack.com → Create app → From scratch.** Name "Leave Desk".
2. **OAuth & Permissions → Bot Token Scopes:** `commands`, `chat:write`, `users:read`, `users:read.email`, `im:write`. Install to workspace. Copy the Bot User OAuth Token into Script Properties `SLACK_BOT_TOKEN`.
3. **Basic Information → Verification Token** → Script Properties `SLACK_VERIFICATION_TOKEN`.
4. **Slash Commands → Create:** `/leavedesk`, Request URL = `APP_URL`, description "Leave Desk: apply, balance, requests", usage hint `[balance | requests | help]`. Optional: `/leave-balance`, `/leave-requests`, `/leave-help` with the same URL.
5. **Interactivity & Shortcuts:** On, Request URL = `APP_URL`.
6. **Event Subscriptions:** On, Request URL = `APP_URL` (Slack sends `url_verification`; the app echoes the challenge), subscribe to bot event `app_home_opened`.
7. **App Home:** Home Tab on; "Allow users to send Slash commands and messages from the messages tab" on.
8. Apps Script editor: run `setupSlack()` (installs the minute trigger, warms the cache) and read `checkSlack()` until every line is ✔.
9. Settings tab: `SLACK_ENABLED = TRUE` so notifications go by DM.

After changing scopes: **Reinstall to workspace** and paste the new token.

## 6. Who is who: matching a Slack user to an employee

What Slack sends with a slash command or button click: `user_id` (e.g. `U04ABC123`), `user_name` (handle), `team_id`, `channel_id`, `trigger_id`, `response_url`. **It never sends the email.** A Slack handle is not a reliable key either; people change it.

How Leave Desk identifies the person:

1. `user_id` → cache (`slack:user:<id>` → `emp_id`), filled from the Employees tab's `slack_user_id` column.
2. On a miss, `users.info` (scope `users:read.email`) returns the profile email. That email is matched, case-insensitively, against `Employees.email`.
3. The match is cached and written back to `Employees.slack_user_id` by the background job, so the lookup happens once per person.
4. The **role** (Employee, Intern, Team Lead, C-suite) and the **team** come from the Employees row, never from Slack. The approval route follows from `role_level` through `ApprovalFlow`.

**Testing with one Slack account.** One Slack member ID maps to exactly one row. Put the ID (and the Slack profile email) on the row of the persona you are testing and nowhere else. After editing the sheet run `setupSlack()`; otherwise the cache refreshes within ten minutes. An ID moved to another row re-points on refresh; an ID removed from every row is forgotten on refresh. You cannot request as Employee and approve as CXO from the same Slack account in one flow; do the other half in the web app with the role picker.

Production implications:

- Every employee's Slack account must use the same email as the Employees tab (normally the Google Workspace address). If someone's Slack email differs, the admin fills `slack_user_id` for them once (Admin → People could expose this field; the column already exists).
- A person not in Employees gets "… is not in the Leave Desk directory. Ask the admin to add you." and nothing else.
- Interns and contractors are ordinary rows with `emp_type = INT / CON`; their quota is prorated, their approval route is the Employee route.
- Only the deploying Google account runs the script, so the Sheet is never shared with Slack users.
- Security: Apps Script cannot read request headers, so Slack's signing secret cannot be verified. The legacy verification token is checked on every call; keep it secret and keep `APP_URL` out of public channels.

## 7. Files

| File | Job |
|---|---|
| `src/WebApp.gs` | `doPost` parses the three Slack shapes (form fields, `payload` JSON, Events JSON), logs timing. |
| `src/slack/SlackHandler.gs` | Routes commands, buttons, modal submissions, Home opened. Never throws; never reads the Sheet after first contact. |
| `src/slack/SlackCards.gs` | Block Kit only. Cards, modals, Home, slash replies, `reply()` (in_channel vs ephemeral). |
| `src/slack/SlackBot.gs` | Slack Web API with the bot token (form-encoded). DM channel and email ↔ user caches. |
| `src/slack/SlackCache.gs` | Per-person snapshot (profile, balances, requests, inbox) in CacheService, rebuilt by the job. |
| `src/slack/SlackJobs.gs` | Queue in Script Properties, one-off + minute triggers, `submit` / `decide` / `link` jobs, Home republish. |
| `src/slack/SlackSetup.gs` | `setupSlack()`, `checkSlack()`. |
| `src/notify/SlackChannel.gs` | Notifications as DMs via `SlackCards.fromMessage`. |
| `test/slack.test.js` | End-to-end: first contact, commands, in_channel vs ephemeral, submit, approve, reject, Home, checkSlack. |
