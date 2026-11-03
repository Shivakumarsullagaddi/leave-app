# Leave Desk: brief for a coding agent (Antigravity)

You are helping verify a local Google Apps Script project on Windows.
**Your job in this session is to INSPECT and REPORT, not to change things.**
At the end, produce the report in the exact format given in section 6.

---

## 1. What this project is

**Leave Desk** is an internal leave-management app for Darukaa.Earth.

- **Database:** a Google Sheet. Each tab is one table: Settings, Employees, Teams, LeaveTypes, Policies, ApprovalFlow, Holidays, LeaveBalances, LeaveRequests, Approvals, AuditLog, plus a README tab.
- **Backend:** Google Apps Script (V8). The script is bound to that Sheet.
- **Frontend:** an Apps Script web app (HtmlService, plain JavaScript, no framework).
- **Login:** "Sign in with Google" using the OAuth 2.0 authorization-code flow (`src/services/Auth.gs`). Sessions are stored in CacheService for 6 hours.
- **Notifications:** Slack incoming webhook, with email (MailApp) as the fallback.
- **Deploy tool:** clasp. `.clasp.json` has `rootDir: "src"`, so only `src/` is uploaded.

### Business rules

| Who applies | Who is asked | Outcome |
|---|---|---|
| Employee | Team Lead **and** team C-suite, at the same time | First approval approves; any rejection rejects (until the leave starts) |
| Team Lead | Their team's C-suite | Single approver |
| C-suite | Nobody | Auto-approved |

Other rules:
- A request over quota is allowed; the extra days become Loss of Pay (LOP).
- Weekends and holidays are not counted.
- Full-time staff get 20 Paid + 12 Sick days a year, credited quarterly. Shorter contracts are prorated.
- Unused leave does not carry forward into the next year.

### Test accounts (a "Test Team", team id T-TEST)

| emp_id | Name | Role | Email |
|---|---|---|---|
| E901 | Test CXO | CSUITE | shivakumarullagaddi855@gmail.com |
| E902 | Test Lead | LEAD | shivakumarullagaddi56@gmail.com |
| E903 | Test Employee (also admin) | EMPLOYEE | shivakumar.u@darukaa.com |

---

## 2. Expected folder layout

```
leave-desk/
├─ .clasp.json            { "scriptId": "...", "rootDir": "src" }   (not in git)
├─ .clasp.json.example
├─ package.json           scripts: test, screens, push
├─ README.md
├─ tools/build-standalone.js   builds a flat paste-ready copy into dist-standalone/
├─ test/                  gas-mock.js, load.js, flow.test.js, auth.test.js, render.js
└─ src/
   ├─ appsscript.json     timeZone Asia/Kolkata, V8, webapp executeAs USER_DEPLOYING, access ANYONE_ANONYMOUS
   ├─ Api.gs              browser endpoints; EVERY function takes `session` as its first argument
   ├─ WebApp.gs           doGet(), bootFromRequest_() handles ?code=&state= from Google
   ├─ core/               Schema, Errors, Codec, DateUtil, Repository, Db
   ├─ services/           Config, Audit, Directory, Catalog, Auth, Identity, BalanceService,
   │                      ApprovalRouter, DecisionPolicy, RequestView, LeaveService, ApprovalService
   ├─ notify/             Messages, SlackChannel, EmailChannel, Notifier
   ├─ setup/              Setup (menu, setupDatabase, setupTestTeam, checkSignIn), SheetFormatter, Seed
   └─ ui/                 Index.html, Styles.html, js/{Dom,Api,Store,Components,App}.html,
                          js/views/{Overview,Apply,Requests,Approvals}.html
```

There should be **26 `.gs` files, 11 `.html` files and `appsscript.json`** under `src/` (38 files).

### How to tell the latest version from the OLD one

| Check | Latest (correct) | Old (wrong) |
|---|---|---|
| `src/services/Auth.gs` | exists | missing |
| First function in `src/Api.gs` | `function apiBootstrap(session, returnTo) {` | `function apiBootstrap() {` |
| `src/setup/Setup.gs` contains | `function setupTestTeam()` and `function checkSignIn()` | `function applyTestEmails()` |
| `src/core/Schema.gs` contains | `TEST_ACCOUNTS:` | `TEST_EMAILS:` |
| `test/auth.test.js` | exists | missing |

---

## 3. Rules for you (important)

1. **Do not edit, delete or move any file** unless the user explicitly asks in this chat.
2. **Do not run** `clasp push`, `clasp pull`, `clasp deploy`, or anything that changes the online project or the Sheet.
3. **Never print secrets.** Never print OAuth client secrets, Slack webhook URLs or anything from `~/.clasprc.json`. Printing the `scriptId` is fine.
4. **`clasp pull` overwrites local files.** To look at the online copy, clone it into a separate temporary folder (section 4, step 8).
5. **clasp v3 renamed some commands.** Run `npx clasp --help` first and use the names it shows. Expected names: `show-file-status`, `list-deployments`, `clone-script`.
6. **The shell is Windows `cmd`.** Use `dir`, `type` and `findstr`, or PowerShell equivalents.

---

## 4. Verification steps (run in order, from the `leave-desk` folder)

1. **Tools**
   ```
   node -v
   npm -v
   npx clasp --version
   npx clasp --help
   ```
2. **Project config**
   ```
   type .clasp.json
   type src\appsscript.json
   type package.json
   ```
3. **Files present**
   ```
   dir /s /b src
   ```
   Count the `.gs` and `.html` files and compare with section 2.
4. **Latest version or old?** Do every check in the table in section 2. For example:
   ```
   findstr /n "function apiBootstrap" src\Api.gs
   findstr /n "function setupTestTeam function checkSignIn function applyTestEmails" src\setup\Setup.gs
   findstr /n "TEST_ACCOUNTS TEST_EMAILS" src\core\Schema.gs
   if exist src\services\Auth.gs (echo Auth.gs present) else (echo Auth.gs MISSING)
   ```
5. **Run the local tests.** They use in-memory mocks and need no internet.
   ```
   npm test
   ```
   Expected output ends with `ALL TESTS PASSED` and `AUTH TESTS PASSED`. If a test fails, copy the first ~20 lines of the error.
6. **Online project status**
   ```
   npx clasp show-file-status
   ```
   This lists which local files would be pushed. Note any file that is missing or unexpected.
7. **Deployments**
   ```
   npx clasp list-deployments
   ```
   List each deployment id and description. Say which one is `@HEAD`, the test deployment.
8. **Compare the online code with the local code (read-only).** Clone into a temporary folder **outside** `leave-desk`, then compare:
   ```
   mkdir ..\leave-desk-remote-check
   npx clasp clone-script <scriptId from .clasp.json> --rootDir ..\leave-desk-remote-check
   ```
   - For each file, say whether the online copy is the same as local, older, or missing.
   - The quickest test: does `..\leave-desk-remote-check\Api.js` (or `Api.gs`) contain `apiBootstrap(session`?
   - clasp may save script files as `.js`. That's normal.
   - Delete `..\leave-desk-remote-check` afterwards only if the user agrees.
9. **Git status (if this is a git repo)**
   ```
   git status --short
   git log --oneline -5
   ```

---

## 5. Things you CANNOT see. List them as "needs the user"

- Script Properties (`OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, `SLACK_WEBHOOK_URL`, `SPREADSHEET_ID`).
  - The user checks these by running **checkSignIn** in the Apps Script editor.
- The Settings tab values in the Sheet (`APP_URL`, `TEST_MODE`, `SLACK_ENABLED`).
- Google Cloud OAuth client settings (redirect URI, test users).
- The web app deployment settings: Execute as and Who has access.

---

## 6. Report format (reply with exactly this, filled in)

```
LEAVE DESK — VERIFICATION REPORT
Date/time:
Folder: C:\...\leave-desk

1. Tools
   node: ...   npm: ...   clasp: ...
   clasp command names seen in --help: ...

2. Config
   .clasp.json scriptId: ...   rootDir: ...
   appsscript.json webapp: executeAs=...  access=...

3. Local files
   .gs count: ..   .html count: ..   appsscript.json: yes/no
   Missing vs expected list: ...
   Extra/unexpected files: ...

4. Version check (LATEST or OLD for each)
   services/Auth.gs: ...
   apiBootstrap signature: ...
   setupTestTeam/checkSignIn present: ...
   TEST_ACCOUNTS present: ...
   auth.test.js present: ...
   VERDICT: local code is LATEST / OLD / MIXED

5. Tests (npm test)
   Result: PASS / FAIL
   If FAIL, first error lines: ...

6. Online project
   show-file-status summary: ...
   Deployments: (id, version, description) ...
   Online code vs local: SAME / ONLINE IS OLDER / ONLINE IS NEWER / DIFFERENT
   Files that differ: ...

7. Git
   branch / changed files / last commits: ...

8. Needs the user (cannot be checked from the CLI)
   - Run checkSignIn in the Apps Script editor and paste its output
   - ...

9. Problems found + suggested fix (do NOT apply)
   - ...
```
