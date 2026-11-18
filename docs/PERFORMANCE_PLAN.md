# Leave Desk Performance & Reliability Plan

**Last updated:** 2026-11-18  
**Status:** DRAFT - Ready for Implementation  
**Goal:** Sub-500ms modal open, sub-1000ms submission, deterministic concurrency, comprehensive edge-case handling

---

## 1. Current Issues

### 1.1 Slowness Problems

| Issue | Symptom | Root Cause | Impact |
|-------|---------|-----------|--------|
| **Slow modal open** | 1-3 sec delay when user clicks `/leavedesk` | Sheet read on first contact + Slack user lookup | User waits, UX feels broken |
| **Slow form submit** | 1-3 sec after "Send request" button | Background job queuing + balance calculation | User unsure if submitted |
| **Slack timeout** | `operation_timeout` error on first use | 3-sec Slack limit hit by sheet read | Form never opens, user confused |

### 1.2 Edge Cases Not Handled

| Edge Case | Current Behavior | Problem |
|-----------|-----------------|---------|
| **New Slack user** (no emp mapping) | Timeout → no form | Error not caught; user gets "invalid_command_response" |
| **User not in Employees tab** | "Not registered" error | Good message, but form closes instead of staying |
| **Duplicate Slack user links** | Undefined behavior | Cache inconsistent with sheet |
| **Second `/leavedesk` after timeout** | May or may not work | Depends on cache state |
| **User deleted from Employees** | Form shows stale cache | Balance shows wrong numbers |
| **Slack scope missing** (`users:read.email`) | Vague error | User doesn't know to reinstall the app |
| **Concurrent modal opens** | Unknown | May lock or corrupt cache |

### 1.3 Determinism Issues

| Scenario | Current State | Need |
|----------|--------------|------|
| **Multiple approvers click simultaneously** | First one wins (maybe) | Atomic lock, deterministic winner |
| **Admin approves on Canvas, Lead rejects in Slack** | Race condition | Request locked after first decision |
| **Both approver cards update** | Manual refresh needed | Auto-update when decision made |

---

## 2. Root Cause Analysis

### 2.1 Why Modal Opens Slowly

```
User clicks /leavedesk
  ↓
Apps Script doPost() receives slash command
  ↓
SlackHandler.handle() runs
  ↓
snapshotFor_() is called
  ├─ Cache hit? → ~50ms ✅
  └─ Cache miss? → ~2000ms ❌
      ├─ SlackBot.getUser() → 500ms (Slack API)
      ├─ Directory.byEmail() → 300ms (sheet read)
      ├─ SlackCache.load() → 500ms (recalc approvers, balances)
      └─ SlackJobs.enqueue() → 100ms (write job queue)
  ↓
SlackBot.openModal() → 200ms (Slack API)
  ↓
Slack shows form to user
```

**Bottlenecks:**
1. First-contact sheet reads (Slack user → employee mapping)
2. Full snapshot build (approvers, balances, calendar)
3. Sequential instead of parallel API calls

### 2.2 Why Submission Is Slow

```
User clicks "Send request"
  ↓
applySubmission_() runs
  ├─ Validate form inputs → 100ms ✅
  ├─ Build request card (layout) → 100ms ✅
  └─ SlackBot.postMessage() → 500ms (Slack API)
  ↓
SlackJobs.enqueue() → submit job → 100ms
  ↓
Return `response_action: 'clear'`
  ↓
Slack closes modal → 100ms
```

**But then background jobs run (not in the 3-sec window):**
- Job 1: `submit` → Calculate working days, check approvers, file request → 1-2 sec
- Job 2+: Notifications, updates, etc.

**User sees:** Form closes, but balance doesn't update until background job runs.

### 2.3 Why Timeout Happens

Slack allows **3 seconds max**. If the response takes >3s, Slack shows `invalid_command_response` and discards the reply.

```
Current first-contact flow:
  Slash command received (0ms)
  ├─ token verify (20ms)
  ├─ Slack user lookup (500ms)
  ├─ Sheet read to find employee (300ms)
  ├─ Approvers calculation (200ms)
  ├─ Balance recalc (300ms)
  ├─ Cache build (200ms)
  └─ Modal open (500ms)
  
Total: ~2000ms ✅ (barely under 3s limit, fragile)

If any step adds 500ms → TIMEOUT ❌
```

---

## 3. Solution Strategy

### 3.1 Phase 1: Fast Modal Open (Target: <500ms)

**Strategy:** Decouple user experience from data freshness.

#### 3.1.1 Lazy-Load Snapshot
- **Fast path:** Return empty form immediately (200ms)
- **Background path:** Load approvers & balances asynchronously (happens while user fills form)
- **UX:** Form shows "Loading approvers..." then updates when ready

#### 3.1.2 Parallel API Calls
- Slack user lookup + Sheet read in parallel (not sequential)
- Use `SlackBot.getUserAsync()` / cache fallback

#### 3.1.3 Aggressive Caching
- Pre-warm cache on `setupSlack()` (runs once, offline)
- Cache includes: employees, teams, leave types, approvers, holidays
- TTL: 1 hour (or manual refresh via menu)

#### 3.1.4 Optimistic UI
- Show form with **default/cached approvers** immediately
- If fresh data loads differently, update in-place
- Don't block on freshness

### 3.2 Phase 2: Fast Submission (Target: <1000ms perceived)

**Strategy:** Return immediately, process in background.

#### 3.2.1 Instant Acknowledgment
- Validation: 50ms (client-side + quick checks)
- Post requester's card: 400ms (Slack API)
- Return `response_action: 'clear'` to close modal: 50ms
- **Total user sees:** <500ms ✓

#### 3.2.2 Background Processing
- File request, recalc balances, notify approvers → all in background job
- User sees card immediately (accurate but incomplete)
- Card updates as approvals come in

#### 3.2.3 Perceived Speed
- Modal closes → user feels submission worked
- Cards update in real time as approvers respond
- Latency is acceptable because user is not blocked

### 3.3 Phase 3: Atomic Concurrency (Target: Deterministic)

**Strategy:** Lock requests on first decision.

#### 3.3.1 Database-Level Atomicity
- Add `locked_at` and `locked_by` fields to LeaveRequests
- When someone approves/rejects:
  ```
  IF status == PENDING:
    SET status = APPROVED, locked_by = approver, locked_at = now
    RETURN success
  ELSE:
    RETURN error "Already decided by [name]"
  ```
- Atomic operation: no race condition possible

#### 3.3.2 Slack Message Sync
- Store **both approver message IDs** (Lead's + CXO's)
- When one decides → update both cards immediately
- Buttons disabled + message shows "Locked by [name]"

#### 3.3.3 Admin Canvas Consistency
- Same locking rule applies to admin approvals
- 10-sec trigger to sync decisions back to Slack cards

### 3.4 Phase 4: Comprehensive Edge Case Handling

#### 3.4.1 New User (Missing Slack → Employee Mapping)

**Current:** Timeout → no form  
**New flow:**

```
/leavedesk received
  ↓
SlackBot.getUser() → no email
  ↓
Catch error: Show form with "Loading your profile…"
  ↓
Background: Link Slack user to employee
  ├─ Try email match (most common)
  ├─ If no match → Show picker: "Which employee are you?"
  ├─ User picks → Forms updates
  ↓
If still no match → Friendly error:
  "We don't have your profile yet.
   Contact admin@leavedesk.test to get set up."
```

#### 3.4.2 User Not in Employees Tab

**Current:** "Not registered" error (good, but abrupt)  
**New:**

```
Catch error → Show inline notice instead of dismissing form:
  "⚠️ You're not in our employee directory yet.
   Ask your team lead or admin."

Keep form open so user can try again after being added.
```

#### 3.4.3 Slack Scope Missing (`users:read.email`)

**Current:** Vague "Slack did not share your email" error  
**New:**

```
Catch error: Show clear instructions:
  "⚠️ The Leave app needs permission to read your email.
  
   Steps:
   1. Go to Slack app settings → Leave app
   2. Click 'Reinstall' or 'Reauthorize'
   3. Grant 'users:read.email' permission
   4. Try /leavedesk again
  
   If you don't have access, ask your Slack admin."
```

#### 3.4.4 Duplicate Slack User Links

**Current:** Undefined  
**New:**

```
On cache.linkUser():
  - Check if this emp_id already has a different slack_user_id
  - If yes: Log audit warning, update to new ID
  - Invalidate old cache entry
```

#### 3.4.5 Concurrent Modal Opens

**Current:** Unknown behavior  
**New:**

```
Add request deduplication:
  - If user has open modal, /leavedesk second time → 
    Just return empty (Slack won't show duplicate)
  - Add flag: request.user_has_open_modal = true
  - Clear on `response_action: 'clear'`
```

#### 3.4.6 User Deleted from Employees

**Current:** Stale cache shows old data  
**New:**

```
On snapshot load:
  - Check if emp_id is still active in Employees
  - If deleted/inactive → 
    Show: "⚠️ Your profile is inactive. 
           Contact admin."
    Disable form submission
```

---

## 4. Implementation Plan

### Phase 1: Fast Modal (Week 1)

- [ ] Extract snapshot-building logic into separate, cacheable parts
- [ ] Add `SnapshotBuilder.lazy()` that returns partial snapshot fast
- [ ] Implement `approversLoader()` as background async task
- [ ] Add `loadingUI` modal state
- [ ] Test: modal open <500ms on cache hit, ~1200ms on miss with async load

### Phase 2: Fast Submission (Week 1)

- [ ] Extract validation logic (move to client-side where possible)
- [ ] Separate card-posting from request-filing
- [ ] Ensure post happens before background job
- [ ] Test: modal closes <500ms after clicking Send

### Phase 3: Atomic Concurrency (Week 2)

- [ ] Add `locked_at`, `locked_by` to LeaveRequests schema
- [ ] Implement atomic approval in `ApprovalService.decide()`
- [ ] Store Slack message IDs for both approvers
- [ ] Add `SlackCards.updateApprovalCard()` to sync decisions
- [ ] Reduce trigger from 1 min → 10 sec
- [ ] Test: concurrent approvals always pick first responder deterministically

### Phase 4: Edge Case Handling (Week 2)

- [ ] Add `ErrorHandler` module for consistent error messages
- [ ] Implement each edge case flow listed in 3.4
- [ ] Add inline error UI (don't dismiss form)
- [ ] Test: each edge case with proper UX

### Phase 5: Performance Testing & Optimization (Week 3)

- [ ] Load test: 10 concurrent `/leavedesk` requests
- [ ] Measure sheet read time, cache performance
- [ ] Profile SlackBot API calls (parallel opportunities)
- [ ] Benchmark: modal open, form submit, background jobs
- [ ] Optimize hotspots (cache strategy, batch operations, etc.)

---

## 5. Test Cases

### 5.1 Happy Path

```
✓ User 1 clicks /leavedesk → modal opens <500ms
✓ Fills form → clicks Send → modal closes <1000ms
✓ Requester gets card in Slack immediately
✓ Lead & CXO both get notification cards
✓ Lead approves → Lead's card updates + CXO's card shows "Locked"
✓ CXO cannot reject (button disabled)
```

### 5.2 Edge Cases

```
✓ New Slack user (no email) → Form shows "Loading…" → User picks employee → Form updates
✓ User not in Employees → Friendly error, form stays open
✓ Missing scope → Clear instructions shown
✓ Second /leavedesk while form open → No duplicate
✓ User deleted from Employees → "Inactive" warning, form disabled
✓ Concurrent approvals (Lead + CXO click same millisecond) → Database atomicity decides winner
✓ Admin approves on Canvas → Both Slack cards update <10 sec
✓ Network timeout during form open → Retry logic, user sees "Retrying…"
```

### 5.3 Performance Benchmarks

```
Target 1: Modal open time
  ✓ Cache hit: <300ms
  ✓ Cache miss: <1200ms (with async background load)
  ✓ Slack user lookup: <500ms
  ✓ Form render: <100ms

Target 2: Form submission
  ✓ Validation: <50ms
  ✓ Post card: <400ms
  ✓ Close modal: <50ms
  ✓ Background job start: immediate
  
Target 3: Concurrency
  ✓ First approver locks: <100ms database operation
  ✓ Second approver sees "Locked": <10 sec via trigger
  ✓ No race condition in 100 test runs
```

---

## 6. Architecture Decisions

### 6.1 Why Lazy-Load Snapshot?

| Option | Pros | Cons |
|--------|------|------|
| Load everything before modal | Accurate data | Often times out (slow) |
| **Lazy-load (chosen)** | Fast modal, accurate eventually | Need async + UI state |
| Load nothing (empty form) | Fastest | User can't see balance |

**Decision:** Lazy-load is best UX → speed + completeness.

### 6.2 Why 10-Sec Trigger Instead of onEdit?

- `onEdit` doesn't fire on Canvas edits (Canvas uses API, not direct edit)
- 10 sec is 6x faster than 1 min, still efficient
- Can upgrade to webhook later if Canvas API supports it

### 6.3 Why Atomic Lock Instead of "First Wins Eventually"?

- Atomic = deterministic, no weird states
- Clear to user: "Already locked by X"
- Prevents approval overrides (which were a business problem)

---

## 7. Success Criteria

✅ **Performance:**
- Modal opens <500ms (cached) or <1200ms (first-time, with async load)
- Form submits with modal close <1000ms
- Approval decision is atomic + locked <100ms

✅ **Reliability:**
- Zero timeouts in 1000 `/leavedesk` test runs
- All 10 edge cases handled gracefully
- Concurrent approvals always have clear winner

✅ **Determinism:**
- Same user + same form = consistent behavior
- Multiple approvers get consistent views
- Canvas + Slack approvals are in sync

✅ **User Experience:**
- Form never abruptly closes on error
- Clear error messages with actionable steps
- Real-time card updates when decisions are made

---

## 8. Rollout Plan

1. **Local testing:** All test cases pass on local machine
2. **Staging:** Deploy to test Sheet, test with real Slack bot
3. **Production:** 
   - Run on main sheet, test team only
   - Monitor Executions log for errors
   - Gradually roll out to real approvers
4. **Monitoring:**
   - Track modal open time (Executions log)
   - Track submission time
   - Alert on any timeout or concurrency issues

---

## Appendix: Code Files to Modify

| File | Changes | Priority |
|------|---------|----------|
| `src/slack/SlackHandler.gs` | Error handling, edge cases | P0 |
| `src/slack/SlackCache.gs` | Lazy snapshot, background load | P0 |
| `src/slack/SlackCards.gs` | Optimistic UI, error messages | P0 |
| `src/slack/SlackJobs.gs` | 10-sec trigger, Slack card sync | P0 |
| `src/core/Schema.gs` | Add locked_at, locked_by fields | P1 |
| `src/services/ApprovalService.gs` | Atomic decision logic | P1 |
| `test/slack.test.js` | Edge case + performance tests | P1 |

---

## Notes for Implementation

- **Cache invalidation:** Need strategy (1 hour TTL? Manual refresh?)
- **Async patterns in Apps Script:** Use `ScriptApp.newTrigger()` carefully
- **Slack API rate limits:** Parallel calls might hit limits (handle gracefully)
- **Testing complexity:** Mock slow sheet reads, simulate Slack delays
- **Backwards compatibility:** Old cached snapshots may break — add version field

