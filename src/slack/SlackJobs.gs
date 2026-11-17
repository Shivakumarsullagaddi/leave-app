/**
 * SlackJobs.gs — work Slack can't wait for.
 *
 * Slack gives a request 3 seconds. Filing a leave request or a decision is several sheet
 * writes plus notifications, so the Slack reply goes out at once and the job is queued in
 * Script Properties. A one-off trigger is created to run it right away; a once-a-minute
 * trigger (installed by setupSlack, self-healing here) is the safety net. After the jobs,
 * the snapshots are refreshed and every App Home that was ever opened is republished.
 *
 * Job kinds: submit · decide · link (write slack_user_id to Employees) · home
 */
const SlackJobs = (() => {
  const KEY = 'SLACK_JOBS';
  const HOME_USERS = 'SLACK_HOME_USERS';
  const MINUTE_TRIGGER = 'SLACK_MINUTE_TRIGGER';
  const TRIGGER = 'slackRunJobs';
  const props = () => PropertiesService.getScriptProperties();
  const readList = (key) => JSON.parse(props().getProperty(key) || '[]');
  const writeList = (key, list) => props().setProperty(key, JSON.stringify(list));
  const locked = (fn) => {
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try { return fn(); } finally { lock.releaseLock(); }
  };

  /** opts.kick = false leaves the job to the minute trigger (cheaper; used on the slash-command fast path). */
  function enqueue(job, opts) {
    locked(() => writeList(KEY, readList(KEY).concat([job])));
    if (opts && opts.kick === false) return;
    try { ScriptApp.newTrigger(TRIGGER).timeBased().after(1000).create(); } catch (err) { console.error('SlackJobs: could not kick: ' + err); }
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
  /** One-off kicks stay listed after they fire; clear them so the 20-trigger limit is never hit. */
  function clearKicks() {
    const keep = props().getProperty(MINUTE_TRIGGER);
    triggers().forEach((t) => { if (t.getUniqueId() !== keep) ScriptApp.deleteTrigger(t); });
  }

  function runAll() {
    const jobs = locked(() => { const j = readList(KEY); if (j.length) writeList(KEY, []); return j; });
    jobs.forEach((job) => { try { RUN[job.kind](job); } catch (err) { console.error('SlackJobs: ' + job.kind + ' failed: ' + (err && err.stack ? err.stack : err)); } });
    clearKicks();
    install();
    if (jobs.length || SlackCache.isStale()) {
      SlackCache.refresh();
      publishHomes();
    }
    props().setProperty('SLACK_LAST_RUN', String(Date.now()));
    return jobs.length;
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
    if (!emp) throw Errors.notRegistered('');
    return emp;
  }

  /** Approver list for a card, with their role and decision time. */
  const approversOf = (saved) => saved.approvals.filter((a) => a.approver_id !== Directory.SYSTEM)
    .map((a) => ({ name: a.name, role: a.role, decision: a.decision, decided_at: a.decided_at || '' }));
  const cardOf = (saved, extra) => Object.assign({
    employee: saved.employee.name, role: SlackCards.personRole(saved.employee), team: saved.employee.team_name, type: saved.type_name,
    start_date: saved.start_date, end_date: saved.end_date, days: saved.days, lop: saved.lop_days, reason: saved.reason,
    status: saved.status, approvers: approversOf(saved), req_id: saved.req_id, submitted_at: saved.submitted_at,
  }, extra || {});

  const RUN = {
    submit(job) {
      try {
        const emp = Directory.employee(job.emp_id);
        if (!emp) throw Errors.notRegistered('');
        const saved = LeaveService.submit(emp, job.input);
        const card = cardOf(saved);
        show(job, 'Leave request ' + saved.req_id + ': ' + SlackCards.statusText(saved.status, card.approvers), SlackCards.requestCard(card));
      } catch (err) {
        if (!(err instanceof AppError)) console.error('SlackJobs: submit: ' + (err.stack || err));
        const card = Object.assign({}, job.card, { status: '❌ Not filed', note: '⚠️ ' + reason(err) + '\nNothing was saved. Click *Request leave* to try again.' });
        show(job, 'Leave request not filed: ' + reason(err), SlackCards.requestCard(card));
      }
    },

    decide(job) {
      const label = job.decision === 'APPROVED' ? 'approved' : 'rejected';
      try {
        const approver = employeeForSlackUser(job.slack_user_id);
        const saved = ApprovalService.decide(approver, job.req_id, job.decision, job.comment);
        const blocks = SlackCards.requestCard(cardOf(saved, {
          title: (job.decision === 'APPROVED' ? '✅ You approved ' : '❌ You rejected ') + saved.employee.name + '’s leave',
          note: '🗒 Your decision (' + label + ') was recorded at ' + DateUtil.now() + (job.comment ? ' with the comment “' + job.comment + '”' : '') + '.' +
            (saved.status === 'PENDING' ? ' The request is still waiting for the other approver.' : ''),
        }));
        if (job.channel && job.ts) SlackBot.updateMessage(job.channel, job.ts, 'You ' + label + ' ' + saved.req_id, blocks);
        else SlackBot.postMessage(job.slack_user_id, 'You ' + label + ' ' + saved.req_id, blocks);
      } catch (err) {
        if (!(err instanceof AppError)) console.error('SlackJobs: decide: ' + (err.stack || err));
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

/** Trigger target: one-off kicks and the once-a-minute safety net. */
function slackRunJobs() { return SlackJobs.runAll(); }
