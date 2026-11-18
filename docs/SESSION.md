# Leave Desk — session hand-over

Last updated: 2026-11-18 (session "Slack leave desk docs").
Read this first in a new session. Then read `docs/slack-integration.md` if the work touches Slack.

## 1. What the product is

Leave Desk is Darukaa.Earth's internal leave-management app on Google Workspace.

- **Database:** one Google Sheet, one tab per table (Settings, Employees, Teams, LeaveTypes, Policies, ApprovalFlow, Holidays, LeaveBalances, LeaveRequests, Approvals, AuditLog, README, Overview).
- **Backend:** Google Apps Script (V8) bound to that Sheet. Deployed with clasp 3.4.1 (`npx clasp …`, `rootDir: "src"`).
- **Frontend:** Apps Script web app (HtmlService, vanilla JS) under `src/ui/`.
- **Slack:** a Slack app ("Leave app") with slash commands, modals, App Home and DM notifications. See `docs/slack-integration.md`.
- **Login (prototype):** role picker, `LOGIN_MODE=PICKER`. Buttons Employee / Intern / Team Lead / CXO / Admin open that persona's dashboard. `setupDemo()` creates the personas. There is also an email + password mode (`LOGIN_MODE=PASSWORD`, `src/setup/LoginAccounts.gs`, git-ignored, currently **not** present in `src/setup/`).

### Business rules (fixed, change only when asked)

| Who applies | Who is asked | Outcome |
|---|---|---|
| Employee / Intern | Team Lead **and** team C-suite **and** the admin, in parallel | **The first decision is final** (approve or reject); the others are closed out (`DECISION_LOCK = FIRST_DECISION`, since 2026-11-18). `LEAVE_START` keeps the old rule. |
| Team Lead | Their team's C-suite **and** the admin, in parallel | Same rule |
| C-suite | Nobody | Auto-approved |

The admin is everyone listed in Settings → `ADMIN_EMAILS` who is an active employee (after `setupDemo` that is Leave Admin, E900). It comes from ApprovalFlow rows **F5** (EMPLOYEE, rule `ADMIN`) and **F6** (LEAD, rule `ADMIN`). Untick `active` on those rows to stop asking the admin. `setupDatabase` adds F5/F6 to an older sheet once and never overwrites an existing row. Requests filed before F5/F6 existed have no admin approval row.

- Over quota is allowed with a warning; the extra days are Loss of Pay (LOP).
- **Balance is only reduced on approval.** `available = accrued + adjusted − used`. Days in requests waiting for approval are shown as "waiting for approval" and do not reduce "days left". They are still reserved for the LOP split (`free = available − pending`), so two pending requests can't spend the same days. Rejection or cancellation releases them; the shown balance never moved.
- Weekends and Holidays-tab dates are not counted. Half day = 0.5.
- Full-time: 20 Paid + 12 Sick per year, credited quarterly. Interns and contractors prorated by contract months.
- No carry-forward.

### Test team (team T-TEST)

| emp_id | Name | Role | Email |
|---|---|---|---|
| E901 | Test CXO | CSUITE | shivakumarullagaddi855@gmail.com |
| E902 | Test Lead | LEAD | shivakumarullagaddi56@gmail.com |
| E903 | Test Employee | EMPLOYEE | shivakumar.u@darukaa.com |
| E904 | Test Intern | EMPLOYEE (INT) | test.intern@leavedesk.test |
| E900 | Leave Admin (only admin) | CSUITE, team T-CXO | admin@leavedesk.test |

## 2. What is implemented (by commit, newest first)

| Commit / state | Feature |
|---|---|
| `e59f77a` (main, pushed) | Slack app: `/leavedesk` commands, Apply modal, requester card, Approve/Reject from DM and App Home, background job queue, per-person cache, `setupSlack()` / `checkSlack()`. Sheet styling (banding, status pills, frozen first column) and an **Overview** tab with live formulas (`SheetFormatter.writeOverview`). Notifications switched from incoming webhook to bot DMs (`SlackChannel.gs`). |
| `f37ed36` | Download reports as Excel (CSV, UTF-8 BOM, formula-safe) or PDF (print) for any period; `ReportService.exportData`, `apiReportExport`, `test/export.test.js`. |
| `f85aedf` | Reports tab for every role (Me; leads/C-suite see their teams; Admin sees everything) and the Admin console: Dashboard, People, Teams, Requests, Policies. `ReportService.gs`, `AdminService.gs`, `test/admin.test.js`. |
| `28312b1` | Prototype role-picker entrance (`LOGIN_MODE=PICKER`), `setupDemo()`, admin dashboard. |
| `c5bde35` | Google built-in sign-in for testing. Email + password sign-in exists as a patch workflow (see CLAUDE.md "Current setup task"). |
| earlier | Core: Schema-driven Sheet DB, services (LeaveService, ApprovalService, BalanceService, ApprovalRouter, DecisionPolicy), web UI, email notifications, setup menu, in-memory Apps Script mock for tests. |

`1e7ab40` (admin passcode on the entrance) was reverted in `ff0a808`. Do not reintroduce it unless asked.

## 3. Where the code is

```
src/
  Api.gs, WebApp.gs (doGet + doPost for Slack)
  core/      Schema, Errors, Codec, DateUtil, Repository, Db
  services/  Config, Audit, Directory, Catalog, Auth, Identity, BalanceService, ApprovalRouter,
             DecisionPolicy, RequestView, LeaveService, ApprovalService, ReportService, AdminService
  notify/    Messages (what to say), SlackChannel (bot DMs), EmailChannel, Notifier (fallback chain)
  slack/     SlackHandler (routes Slack calls), SlackCards (Block Kit), SlackBot (Web API), SlackCache
             (per-person snapshots), SlackJobs (background queue + triggers), SlackSetup (setupSlack/checkSlack)
  setup/     Setup (menu, setupDatabase, setupDemo, setupTestTeam, checkSignIn), SheetFormatter, Seed
  ui/        Index.html, Styles.html, js/{Dom,Api,Store,Components,App}.html, js/views/*.html
test/        gas-mock.js (in-memory Apps Script incl. Slack API, triggers, cache), load.js,
             flow / auth / upgrade / demo / admin / export / slack tests, render.js (screenshots)
tools/       build-standalone.js
docs/        this folder
```

Layering: ui → Api → services → core. Services never call `SpreadsheetApp`; views never call `google.script.run`. All `.gs` files share one global scope, so never declare a top-level name twice.

Root also holds `debug_*.js` scratch scripts from the Slack work. They are untracked and can be deleted.

## 4. Commands

| Command | Purpose |
|---|---|
| `npm test` | Runs flow, auth, upgrade, demo, admin, export and slack tests. Each prints `… PASSED`. |
| `npx clasp show-file-status` | What would be pushed. |
| `npx clasp push --force` | Upload `src/` (ask the user first). |
| `npx clasp list-deployments` / `update-deployment <id>` | Update the existing web app deployment only. **Never** `create-deployment`. |
| `node tools/build-standalone.js` | Flat copy for pasting by hand. |

Rules: never print secrets (bot token, verification token, OAuth secret, passwords, `.clasprc.json`); never `clasp pull`; run `npm test` before every commit and push; commit on `claude/<topic>`; ask before pushing to GitHub or Apps Script; never hand-edit Sheet data.

## 5. Script Properties and Settings that matter

| Where | Key | Meaning |
|---|---|---|
| Script Properties | `SLACK_BOT_TOKEN` | Bot User OAuth token (`xoxb-…`). Secret. |
| Script Properties | `SLACK_VERIFICATION_TOKEN` | Slack "Verification Token"; the only proof of origin Apps Script can check. Secret. |
| Script Properties | `APP_URL` | The `/exec` URL. Also the Request URL in the Slack app. |
| Script Properties | `LOGIN_MODE` | `PICKER` (prototype) or `PASSWORD`. |
| Settings tab | `SLACK_ENABLED` | TRUE sends approver/requester notifications as Slack DMs; email is the fallback. |
| Settings tab | `EMAIL_FALLBACK` | Email when Slack is off or fails. |

## 6. What this session changed (2026-11-16)

User feedback: Slack replies were one-liners with no labels, the typed command vanished after the reply, `balance` had to be typed in full, and Slack sometimes showed its timeout error. Done:

1. **Cards redesigned** (`SlackCards.gs`): every card is labelled (Requested by · Leave type · Dates · Working days · Reason · Status · Approvers with role and decision time), balances show a ten-cell bar, approver cards say "Your decision is needed" and explain the parallel rule, decision cards are titled "You approved X's leave".
2. **Request stays visible**: inside the Leave app DM replies are `in_channel`, so Slack keeps the typed command above the answer. In channels replies stay private and start with "`/leavedesk balance` · asked by @you". Needs the `im:write` scope (`conversations.open`); without it the echo line is used everywhere.
3. **Commands**: `/leave-balance`, `/leave-requests`, `/leave-help` route by command name; `/leavedesk bal|status|left|list|mine|history|?` aliases. Slack's `/` autocomplete lists them.
4. **Timeout work**: first-contact linking no longer creates a trigger inside the Slack request; every phase is timed and logged (`SlackHandler.timing()` in the Executions log). Explanation and remaining causes in `docs/slack-integration.md`.
5. **Docs folder** created; project memory saved for Claude Code.
6. **Apply form (later the same day):** date pickers start empty, every pick redraws the form with exact dates + working days + balance left (`views.update`, `dispatch_action`), over-quota warning before Send, **Half day** checkbox (0.5, first day only). Auto-approved cards say "Approved automatically". Slack IDs moved or removed in the sheet are re-pointed or forgotten on refresh (`SlackCache.forgetMovedLinks`).

2026-11-17: **Admin can approve.** New ApprovalFlow rule `ADMIN` (`ApprovalRouter.RULES.ADMIN`), approver role `ADMIN` shown as "Admin", seed rows F5/F6, `Setup.missingOnly` tops up ApprovalFlow as well as Settings. Wording says "any one approval is enough" when three or more are asked.

2026-11-17 (later): **Balance only cut on approval** (`BalanceService.available`, `recalcAll()` run by `setupDatabase` fixes stored values). **Approvers known up front**: `SlackCache` stores each person's approvers (`ApprovalRouter.route`), the Apply form shows a "Who approves" block, and the requester's first card is already complete (status, days, approvers); the background job only adds the request ID. "Open in Leave Desk" removed from the requester's card (still on approver notification cards). "Your approvers have been told" line removed.

2026-11-17: **Daily leave post** like Vacation Tracker (`SlackDaily.gs`, `test/daily.test.js`). Settings `SLACK_DAILY_CHANNEL` (test channel C0CJK6ELW2Y) and `SLACK_DAILY_TIME` (11:00, exact minute). Plan: run it in the test channel, then switch to #ooo once people apply through Leave Desk, run side by side with Vacation Tracker for a few days, then turn Vacation Tracker's notification off.

2026-11-18: **Slack speed, determinism, edge cases** (full write-up: [PERFORMANCE_PLAN.md](PERFORMANCE_PLAN.md)).
- Error replies no longer send `blocks:[null]` (that was `invalid_command_response`).
- Refresh pre-links every employee to Slack by email (parallel `fetchAll`), so the first `/leavedesk` is a cache hit; a cache miss opens a loading modal first, and errors show in the modal.
- Send creates no trigger and takes no lock (queue = one Script Property per job, run in order by the minute trigger); overlap, weekend-only and no-approver are refused in the form.
- Later the same day: a Slack request never reads the sheet (stranger answered from a cached email directory; evicted person gets a "Setting up…" modal filled by the job), so the timeout next to the "not in directory" modal is gone. Slack IDs live in the cache only: never written to Employees, never printed by checkSlack; run forgetSlackIds() once to clear IDs written earlier.
- First decision is final: instant claim in Slack, sheet-level refusal naming who decided, all approver cards closed together on settle.
- Sheets dashboard decisions are adopted by the minute job (approvers closed, balance reconciled, requester told, cards closed, audited).
- `clearTestData` and the "Setup Slack" menu item were removed from Setup.gs by the user (uncommitted at the time of writing). `clearTestData` also wiped LeaveBalances; don't bring it back as written.

## 7. Next steps (in order)

0. Done 2026-11-18: pushed to GitHub + Apps Script, deployment AKfycbzX… updated to @57. **User:** set Settings `DECISION_LOCK` = `FIRST_DECISION`, run `setupSlack()` once, test from two Slack accounts.

1. **User:** in Slack app settings add Bot Token Scope `im:write`, reinstall, paste the new token into `SLACK_BOT_TOKEN`; optionally add commands `/leave-balance`, `/leave-requests` (same Request URL); set the `/leavedesk` usage hint to `[balance | requests | help]`.
2. **User:** `npx clasp push --force` (ask), update the existing deployment, run `setupSlack()` in the editor, then test `/leavedesk balance` from the Leave app's Messages tab.
3. Watch Apps Script → Executions for the line `Slack slash_command answered in N ms …` and send the numbers back if Slack still times out.
4. Commit directly on `main` and push to GitHub (the user's standing choice, 2026-11-16); no attribution lines in commit messages.
5. Production identity: decide whether Slack work emails will always equal the Employees `email` column, or whether Admin → People should get a "Slack member ID" field (column `slack_user_id` already exists).
6. Open questions: should balance replies in channels be allowed at all, or forced to the DM? Should `/leavedesk` alone show a menu instead of the apply form?
