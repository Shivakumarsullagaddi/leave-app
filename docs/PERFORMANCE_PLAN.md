# Leave Desk — speed, determinism and edge cases (Slack)

Last updated: 2026-11-18 · Status: **implemented, all tests pass, live** (commit 91c5b16, deployment AKfycbzX… @57)

This replaces the first draft of this plan. That draft promised things Apps Script cannot do
(a 10-second trigger, async work after replying, sub-500 ms replies). This version describes what
was built and the real limits.

## 1. What was wrong

| Symptom | Real cause |
|---|---|
| First `/leavedesk` → `operation_timeout`, second one works | Only employees whose `slack_user_id` was already in the sheet were cached. A new person cost `users.info` + an Employees read + a full snapshot build (~8 tab reads) + `views.open` inside Slack's 3 s. The second try hit the cache. |
| **Send request** takes 1–3 s to close | Every Send created a one-off trigger (`ScriptApp.newTrigger`, one of the slowest Apps Script calls) and took the same lock the job uses while it writes the sheet. One-off triggers also fire 20–60 s late, so the cost bought nothing. |
| Lead approves, CXO rejects a minute later, rejection wins | Setting `DECISION_LOCK = LEAVE_START` allowed an approval to be overturned until the leave starts, and the other approvers' cards kept live buttons. |
| Decisions in the Sheets dashboard reach nobody | The dashboard writes `LeaveRequests` directly: no Slack message, Approvals rows stay PENDING, balance not moved. |
| `invalid_command_response` | A different bug (`blocks:[null]` in error replies), fixed earlier. |

## 2. Platform limits (honest numbers)

- **Apps Script start-up + one Slack API call ≈ 0.8–1.5 s.** That is the floor for opening a modal. Getting below 500 ms needs a different host (e.g. Cloud Run). Everything else was removed from the path.
- **Triggers run at most once a minute.** There is no 10-second trigger. Work queued by Slack (filing a request, recording a decision, adopting a dashboard decision) happens within **≈ 1 minute**.
- **No async after replying.** A Slack request can't answer and keep working, so speed comes from caching ahead of time, not from lazy loading.
- **CacheService has no compare-and-set.** The first-click claim (below) can, in theory, let two submits in the same few milliseconds through. The job queue still files them one at a time, so the data stays deterministic.

## 3. What was built

### 3.1 First `/leavedesk` never times out
- `SlackCache.refresh()` (setupSlack + every 10 min) now links **every active employee** to their Slack ID by work email, in one parallel batch (`UrlFetchApp.fetchAll`), writes it to `Employees.slack_user_id` and caches it. Misses are remembered for 6 h.
- Result: even a person's very first command is a cache hit. Path: verify token → cache → `views.open`. **One Slack call, no sheet read.**
- If someone still isn't cached (added a minute ago, cache evicted), a **"Getting your balance…" modal opens immediately**, then turns into the form. Problems (not in Employees, missing `users:read.email` scope) are explained **inside that modal**, not as a vanishing error.

### 3.2 Send closes fast
- No trigger is created. Queueing is **one Script Property write, no lock** (`SLACK_JOB_<time>_<random>`), so Send never waits behind a job writing the sheet.
- Send makes one Slack call (the requester's card, already complete from the cache).
- Overlapping dates, weekend-only ranges, crossing the year and "no approver" are refused **inside the form**, from the cache, before anything is posted.
- The person's cached balance immediately shows the new days as "waiting for approval".

### 3.3 First decision is final, in Slack and in the sheet
- New default `DECISION_LOCK = FIRST_DECISION`. The first approve/reject decides; the other approvers' rows become `NO_ACTION`. The old rule is still available as `LEAVE_START`.
- **Slack, instantly:** the first Approve/Reject *submitted* claims the request in the cache. Anyone after that gets "**Test Lead approved this at 10:42. The first decision is final, so no action is needed from you.**", either on the card (button click, no modal) or inside their open modal.
- **Sheet, authoritatively:** the job files decisions oldest first under the sheet lock. A late one is refused with who decided and when, and that person gets a DM.
- **Everyone sees the same state:** where each approver's card was posted is remembered. When the request settles (approved, rejected or cancelled), **all approver cards are rewritten in one parallel call without buttons**: "You approved…" for the decider, "Test Lead approved it… no action needed" for the others.
- The same happens for decisions made in the web app.

### 3.4 Sheets dashboard decisions are adopted
Every minute the job checks requests that still have open approver cards. If the status is no longer PENDING, the decision was made outside Leave Desk, and the job will:
1. close the waiting approvers (`NO_ACTION`),
2. recalculate that person's used/pending from LeaveRequests (`BalanceService.reconcile`),
3. normalise `final_by` (an email becomes an emp_id) and write an AuditLog row,
4. DM the requester ("Approved by Leave Admin"), and close every approver card.

This happens once per request, within about a minute.

## 4. Edge cases

| Case | Behaviour | Test |
|---|---|---|
| Brand-new Slack user who is in Employees | Pre-linked by email; first command is a cache hit | slack.test.js |
| Not cached (evicted / added just now) | Loading modal at once → form | slack.test.js |
| Slack user not in Employees | Modal: "Your account is not in the Leave Desk directory. Ask the admin to add you." | slack.test.js |
| `users:read.email` scope missing | Modal says which scope to add and to reinstall | code path |
| Two employees with the same Slack account | Second row is not linked (no hijack) | code path |
| Slack ID cleared or moved in the sheet | Re-linked by email / re-pointed on refresh; dropped IDs forgotten | slack.test.js |
| Employee made Inactive | Snapshot and link removed on refresh; jobs refuse them | slack.test.js |
| Overlap / weekend-only / crosses year / no approver | Refused in the form from cache; the sheet re-checks in the job ("Not filed") | slack.test.js |
| Double-click Send / Approve | Same person's second submit is a no-op | slack.test.js |
| Two approvers decide at once | First submit wins at once; same-millisecond case decided by queue order | slack.test.js |
| Click Approve on an old card | Card replaced with who decided; no modal | slack.test.js |
| Requester cancels | Approver cards closed as "cancelled, no action needed" | code path |
| Decision in the Sheets dashboard | Adopted within a minute (3.4) | slack.test.js |
| Decision recording fails | Claim released so others can still act; person gets a DM with the reason | code path |
| Upgrade with old queued jobs | Old `SLACK_JOBS` list still drained; old one-off triggers deleted | code path |

## 5. Files changed

`SlackBot` (parallel calls, batch email lookup) · `SlackCache` (pre-linking, inactive cleanup, claims, card store, optimistic pending) · `SlackHandler` (loading modal, claims, cache validation, no triggers) · `SlackJobs` (lock-free ordered queue, single runner, dashboard adoption) · `SlackCards` (settled / claimed / loading / message cards) · `Notifier` + `SlackChannel` (settle hook closes cards) · `DecisionPolicy` (`FIRST_DECISION`) · `ApprovalService` (close others, "already decided by", `adoptOutside`) · `BalanceService.reconcile` · `Seed` (new default) · tests.

## 6. To switch it on

1. Done: pushed and deployment updated to @57. (clasp in Git Bash fails with "Content directory is a symlink"; run it from PowerShell in `C:SERS�`.)
2. In the Settings tab, set **`DECISION_LOCK` = `FIRST_DECISION`**. Existing sheets keep their old value (`LEAVE_START`); new sheets get the new default.
3. Run **`setupSlack()`** once. It links everyone to Slack and warms the cache.
4. Watch Apps Script → Executions for `Slack slash_command answered in N ms`. A cached `/leavedesk` shows `token · snapshot(cache) · views.open`.

## 7. Not done (and why)

- **Faster than ~1 s modal open:** needs moving the Slack endpoint off Apps Script.
- **Dashboard decisions faster than ~1 minute:** the dashboard writes the sheet directly, and Apps Script can't watch API writes. The real fix is to approve only in Slack or the web app and make the dashboard read-only.
