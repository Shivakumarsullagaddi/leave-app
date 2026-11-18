/**
 * SlackJobs.gs — work Slack can't wait for.
 *
 * Slack gives a request 3 seconds. Filing a leave request or a decision is several sheet
 * writes plus notifications, so the Slack reply goes out at once and the job is queued.
 *
 * Queue: one Script Property per job (SLACK_JOB_<time>_<random>), so queueing is a single write
 * with no lock — a Send never waits behind a job that is busy writing the sheet. Jobs run in the
 * order they were queued (the key starts with the time), one runner at a time, from the
 * once-a-minute trigger installed by setupSlack (self-healing here). No trigger is ever created
 * inside a Slack request: ScriptApp.newTrigger is slow, and one-off triggers fire late anyway.
 *
 * After the jobs: requests that still have open approver cards but were decided outside Leave Desk
 * (the Sheets dashboard) are adopted — approvers closed, balance recalculated, people told, cards closed.
 * Then the snapshots are refreshed and every App Home that was ever opened is republished.
 *
 * Job kinds: submit · decide · link (write slack_user_id to Employees) · home
 */
const SlackJobs = (() => {
  const LEGACY = 'SLACK_JOBS';           // the old single-list queue, still drained after an upgrade
  const PREFIX = 'SLACK_JOB_';
  const HOME_USERS = 'SLACK_HOME_USERS';
  const MINUTE_TRIGGER = 'SLACK_MINUTE_TRIGGER';
  const TRIGGER = 'slackRunJobs';
  const props = () => PropertiesService.getScriptProperties();
  const readList = (key) => JSON.parse(props().getProperty(key) || '[]');
  const writeList = (key, list) => props().setProperty(key, JSON.stringify(list));
  let seq = 0;

  /** Queues a job: one property write, no lock, no trigger. */
  function enqueue(job) {
    const key = PREFIX + String(Date.now()).padStart(15, '0') + '_' + String(++seq).padStart(3, '0') + Math.random().toString(36).slice(2, 8);
    props().setProperty(key, JSON.stringify(job));
  }

  /** Every queued job, oldest first, removed from the queue as it is taken. */
  function takeAll() {
    const all = props().getProperties();
    const jobs = [];
    if (all[LEGACY]) { JSON.parse(all[LEGACY]).forEach((j) => jobs.push(j)); props().deleteProperty(LEGACY); }
    Object.keys(all).filter((k) => k.indexOf(PREFIX) === 0).sort().forEach((k) => {
      props().deleteProperty(k);
      try { jobs.push(JSON.parse(all[k])); } catch (err) { console.error('SlackJobs: unreadable job ' + k); }
    });
    return jobs;
  }

  function rememberHomeUser(slackUserId) {
    const users = readList(HOME_USERS);
    if (users.indexOf(slackUserId) === -1) writeList(HOME_USERS, users.concat([slackUserId]));
  }

  const triggers = () => ScriptApp.getProjectTriggers().filter((t) => t.getHandlerFunction() === TRIGGER);
  const isInstalled = () => triggers().some((t) => t.getUniqueId() === props().getProperty(MINUTE_TRIGGER));
  function install() {
    if (isInstalled()) return false;
    const t = ScriptApp.newTrigger(TRIGGER).timeBased().everyMinutes(1).create();
    props().setProperty(MINUTE_TRIGGER, t.getUniqueId());
    return true;
  }
  /** One-off kicks from older versions stay listed after they fire; clear them so the 20-trigger limit is never hit. */
  function clearKicks() {
    const keep = props().getProperty(MINUTE_TRIGGER);
    triggers().forEach((t) => { if (t.getUniqueId() !== keep) ScriptApp.deleteTrigger(t); });
  }

  /** Only one runner at a time (a separate lock from the sheet's, so Slack requests never wait on it). */
  function exclusive(fn) {
    let lock = null;
    try { lock = LockService.getUserLock(); } catch (e) { lock = null; }
    if (lock && !lock.tryLock(1000)) return 0;
    try { return fn(); } finally { if (lock) lock.releaseLock(); }
  }

  function runAll() {
    return exclusive(() => {
      const jobs = takeAll();
      jobs.forEach((job) => { try { RUN[job.kind](job); } catch (err) { console.error('SlackJobs: ' + job.kind + ' failed: ' + (err && err.stack ? err.stack : err)); } });
      const adopted = adoptOutside();
      clearKicks();
      install();
      if (jobs.length || adopted || SlackCache.isStale()) {
        SlackCache.refresh();
        publishHomes();
      }
      props().setProperty('SLACK_LAST_RUN', String(Date.now()));
      return jobs.length;
    });
  }

  /**
   * Requests whose approver cards are still open but whose status is no longer PENDING were decided
   * outside Leave Desk (Leave Desk closes the cards itself). Adopt them. Returns how many.
   */
  function adoptOutside() {
    const open = SlackCache.openCardRequests();
    if (!open.length) return 0;
    Db.refresh();
    let adopted = 0;
    open.forEach((reqId) => {
      try {
        const r = Db.table('LeaveRequests').get(reqId);
        if (r && r.status === 'PENDING') return;
        if (r && r.status === 'APPROVED' && !DecisionPolicy.firstIsFinal()) return;   // LEAVE_START: others may still reject
        if (r) { ApprovalService.adoptOutside(reqId); adopted++; }
      } catch (err) {
        console.error('SlackJobs: adopt ' + reqId + ': ' + (err.stack || err));
      } finally {
        const r = Db.table('LeaveRequests').get(reqId);
        if (!r || r.status !== 'PENDING') SlackCache.takeCards(reqId);   // never handled twice
      }
    });
    return adopted;
  }

  function publishHomes() {
    const appUrl = SlackBot.prop('APP_URL');
    readList(HOME_USERS).forEach((u) => {
      const snap = SlackCache.snapshot(SlackCache.empIdForUser(u));
      if (!snap) return;
      try { SlackBot.publishHome(u, SlackCards.home(snap, appUrl)); } catch (err) { console.error('SlackJobs: home for ' + u + ': ' + err); }
    });
  }

  const reason = (err) => (err instanceof AppError ? err.message : 'something went wrong. Please try again or use the web app.');
  function show(job, text, blocks) {
    if (job.channel && job.ts) return SlackBot.updateMessage(job.channel, job.ts, text, blocks);
    return SlackBot.postMessage(job.slack_user_id, text, blocks);
  }

  function employeeForSlackUser(slackUserId) {
    let empId = SlackCache.empIdForUser(slackUserId) || (Directory.activeEmployees().find((e) => e.slack_user_id === slackUserId) || {}).emp_id;
    if (!empId) {
      const info = SlackBot.getUser(slackUserId);
      const email = info.user && info.user.profile && info.user.profile.email;
      if (email) {
        const emp = Directory.byEmail(email);
        if (emp) {
          empId = emp.emp_id;
          SlackCache.linkUser(slackUserId, empId);
        }
      }
    }
    const emp = Directory.employee(empId);
    if (!emp || emp.status !== 'Active') throw Errors.notRegistered('');
    return emp;
  }

  const RUN = {
    submit(job) {
      try {
        const emp = Directory.employee(job.emp_id);
        if (!emp || emp.status !== 'Active') throw Errors.notRegistered('');
        const saved = LeaveService.submit(emp, job.input);
        const card = SlackCards.cardOf(saved);
        show(job, 'Leave request ' + saved.req_id + ': ' + SlackCards.statusText(saved.status, card.approvers), SlackCards.requestCard(card));
      } catch (err) {
        if (!(err instanceof AppError)) console.error('SlackJobs: submit: ' + (err.stack || err));
        const card = Object.assign({}, job.card, { status: '❌ Not filed', note: '⚠️ ' + reason(err) + '\nNothing was saved. Click *Request leave* to try again.' });
        show(job, 'Leave request not filed: ' + reason(err), SlackCards.requestCard(card));
        SlackCache.markDirty();   // drop the optimistic "waiting" entry on the next refresh
      }
    },

    decide(job) {
      const label = job.decision === 'APPROVED' ? 'approved' : 'rejected';
      try {
        const approver = employeeForSlackUser(job.slack_user_id);
        const saved = ApprovalService.decide(approver, job.req_id, job.decision, job.comment);
        const blocks = SlackCards.requestCard(SlackCards.cardOf(saved, {
          title: (job.decision === 'APPROVED' ? '✅ You approved ' : '❌ You rejected ') + saved.employee.name + '’s leave',
          note: '🗒 Your decision (' + label + ') was recorded at ' + DateUtil.now() + (job.comment ? ' with the comment “' + job.comment + '”' : '') + '.' +
            (saved.status === 'PENDING' ? ' The request is still waiting for the other approver.' : ''),
        }));
        if (job.channel && job.ts) SlackBot.updateMessage(job.channel, job.ts, 'You ' + label + ' ' + saved.req_id, blocks);
        else SlackBot.postMessage(job.slack_user_id, 'You ' + label + ' ' + saved.req_id, blocks);
      } catch (err) {
        if (!(err instanceof AppError)) console.error('SlackJobs: decide: ' + (err.stack || err));
        SlackCache.releaseClaim(job.req_id, job.slack_user_id);
        SlackBot.postMessage(job.slack_user_id, '⚠️ Your decision on ' + job.req_id + ' (' + job.who + ', ' + job.when + ') was not recorded: ' + reason(err));
      }
    },

    link(job) {
      Db.table('Employees').update(job.emp_id, { slack_user_id: job.slack_user_id, updated_at: DateUtil.now() });
      Audit.log({ actor: 'slack', action: 'UPDATE', entity: 'Employees', entity_id: job.emp_id, field: 'slack_user_id', new_value: job.slack_user_id });
    },

    home(job) { rememberHomeUser(job.slack_user_id); },
  };

  return { enqueue, runAll, install, isInstalled, rememberHomeUser };
})();

/** Trigger target: the once-a-minute runner. */
function slackRunJobs() { return SlackJobs.runAll(); }
