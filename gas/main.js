/***** CONFIG *****/
const UNTREATED_LABEL      = '_UNTREATED';
const PROCESSING_LABEL     = '_PROCESSING';
const FOLLOWUP_LABEL       = '_FOLLOW-UP';

const WORK_START_HOUR      = 8;     // inclusive
const WORK_END_HOUR        = 18;    // exclusive
const DAILY_REMINDER_HOUR  = 16;    // 4 PM
const SCAN_WINDOW_DAYS     = 5;     // triage window: 5 days
const SCAN_WINDOW_HOURLY   = 2;     // scan for 2 days on hourly run
const ENFORCE_RECENT_QUERY = `label:${UNTREATED_LABEL} newer_than:${SCAN_WINDOW_HOURLY}d -in:trash -in:spam`;
const MAX_ENFORCE_THREADS  = 500;   // safety cap per run to avoid quota spikes

/***** GMAIL API UNIT ESTIMATOR (per-run) *****/
// counts only Advanced Gmail API units (not GmailApp)
var __GMAIL_API_UNITS__ = 0;
function resetApiUnits_()   { __GMAIL_API_UNITS__ = 0; }
function addApiUnits_(n)    { __GMAIL_API_UNITS__ += n; }
function getApiUnits_()     { return __GMAIL_API_UNITS__ || 0; }

/***** PUBLIC: 1) HOURLY TRIAGE + CLEANUP + UNREAD *****/
function triageMailboxToUNTREATED() {
  if (!isWorkingWindow_()) return;

  resetApiUnits_(); // start unit count for this run

  const label = getOrCreateUntreatedLabel_();
  const dateFilter = `newer_than:${SCAN_WINDOW_DAYS}d`;

  // 1) Collect: unread OR unlabeled in the recent window (skip spam/trash)
  const queries = [
    `is:unread -in:spam -in:trash ${dateFilter}`,
    `has:nouserlabels -in:spam -in:trash ${dateFilter}`,
  ];

  const seen = Object.create(null);
  let triaged = 0;
  queries.forEach(q => {
    fetchAllThreadsByQuery_(q).forEach(t => {
      const id = t.getId();
      if (!seen[id]) {
        t.addLabel(label); // idempotent if already present
        seen[id] = true;
        triaged++;
      }
    });
  });

  // 2) Cleanup: remove _UNTREATED when (fully read) AND (has another user label)
  const cleaned  = cleanupUNTREATED_(label);

  // 3) Enforcement: pivot mode + per-message label propagation (only _PROCESSING/_FOLLOW-UP) on recent threads
  const enforced = enforceUnreadAndLabelsRecent_(label);

  console.log(`_UNTREATED triage: labeled=${triaged}, cleaned=${cleaned}, unread_enforced=${enforced}, est_gmail_api_units=${getApiUnits_()}`);
}

/***** PUBLIC: 2) DAILY 4PM REMINDER *****/
function createUntreatedSummaryTask() {
  if (!isWeekday_()) return;

  resetApiUnits_(); // track Gmail API units used during this task

  const count = countUNTREATED_('threads'); // uses Gmail.Users.Threads.list (10u)
  if (count <= 0) {
    console.log(`No _UNTREATED — no task created. est_gmail_api_units=${getApiUnits_()}`);
    return;
  }

  const title = `You have ${count} _UNTREATED email(s).`;
  const tasklistId = getPrimaryTasklistId_();

  // Due at 18:00 yesterday (local project timezone) to avoid piling up
  const due = new Date();
  due.setDate(due.getDate() - 1);
  due.setHours(18, 0, 0, 0);
  const dueIso = due.toISOString();

  // Avoid duplicates for that day
  const { start, end } = dayBounds_(due);
  const existing = Tasks.Tasks.list(tasklistId, {
    showCompleted: false,
    showDeleted:   false,
    showHidden:    false,
    dueMin:        start.toISOString(),
    dueMax:        end.toISOString(),
  });

  if (existing.items && existing.items.some(t => t.title === title && t.status === 'needsAction')) {
    console.log(`Task already exists for yesterday — skipping. est_gmail_api_units=${getApiUnits_()}`);
    return;
  }

  Tasks.Tasks.insert({ title, due: dueIso, notes: 'Please treat them immediately.', status: 'needsAction' }, tasklistId);
  console.log(`Created task (due ${dueIso}): "${title}". est_gmail_api_units=${getApiUnits_()}`);
}

/***** TRIGGERS *****/
function setupTriggers() {
  const handlers = new Set(['triageMailboxToUNTREATED', 'createUntreatedSummaryTask']);
  ScriptApp.getProjectTriggers().forEach(tr => {
    if (handlers.has(tr.getHandlerFunction())) ScriptApp.deleteTrigger(tr);
  });

  ScriptApp.newTrigger('triageMailboxToUNTREATED').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('createUntreatedSummaryTask').timeBased().atHour(DAILY_REMINDER_HOUR).everyDays(1).create();

  console.log('Triggers created.');
}

/***** HELPERS: TIME & LABELS *****/
function isWeekday_() {
  const d = new Date().getDay(); // 0=Sun..6=Sat
  return d !== 0 && d !== 6;
}
function isWorkingWindow_() {
  if (!isWeekday_()) return false;
  const h = new Date().getHours();
  return h >= WORK_START_HOUR && h < WORK_END_HOUR;
}
function getOrCreateUntreatedLabel_() {
  return GmailApp.getUserLabelByName(UNTREATED_LABEL) || GmailApp.createLabel(UNTREATED_LABEL);
}
function dayBounds_(d) {
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  const end   = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
  return { start, end };
}

/***** HELPERS: SEARCH/PAGINATION *****/
function fetchAllThreadsByQuery_(query) {
  const all = [];
  let start = 0, size = 500;
  while (true) {
    const batch = GmailApp.search(query, start, size);
    if (!batch.length) break;
    all.push.apply(all, batch);
    if (batch.length < size) break;
    start += size;
  }
  return all;
}

// Early-stop at cap (avoids fetching more than we’ll process)
function fetchThreadsByQueryWithCap_(query, cap) {
  const out = [];
  let start = 0;
  while (out.length < cap) {
    const remaining = cap - out.length;
    const page = Math.min(500, remaining);
    const batch = GmailApp.search(query, start, page);
    if (!batch.length) break;
    out.push.apply(out, batch);
    if (batch.length < page) break;
    start += page;
  }
  return out;
}

function fetchAllThreadsInLabel_(label) {
  const all = [];
  let start = 0, size = 500;
  while (true) {
    const batch = label.getThreads(start, size);
    if (!batch.length) break;
    all.push.apply(all, batch);
    if (batch.length < size) break;
    start += size;
  }
  return all;
}

/***** COUNT (Advanced Gmail) *****/
// Excludes Trash/Spam to match the extension’s definition
function countUNTREATED_(mode = 'threads') {
  if (mode !== 'messages') {
    // Fast estimate of threads excluding Trash/Spam
    const res = Gmail.Users.Threads.list('me', {
      q: `label:${UNTREATED_LABEL} -in:trash -in:spam`,
      maxResults: 1,
      fields: 'resultSizeEstimate'
    });
    addApiUnits_(10); // threads.list
    return (res && typeof res.resultSizeEstimate === 'number') ? res.resultSizeEstimate : 0;
  }

  // messages mode: count messages from threads excluding Trash/Spam
  const threads = fetchAllThreadsByQuery_(`label:${UNTREATED_LABEL} -in:trash -in:spam`);
  return threads.reduce((s, t) => s + t.getMessages().length, 0);
}

/***** CLEANUP *****/
/** Remove _UNTREATED if treated = (thread is READ) AND (has any user label other than _UNTREATED). */
function cleanupUNTREATED_(untreatedLabel) {
  const threads = fetchAllThreadsInLabel_(untreatedLabel);
  let cleaned = 0;
  threads.forEach(thread => {
    if (thread.isUnread()) return; // fast-path: unread still needs attention
    const userLabels = thread.getLabels(); // user labels only
    const hasOther   = userLabels.some(l => l.getName() !== UNTREATED_LABEL);
    if (hasOther) {
      thread.removeLabel(untreatedLabel);
      cleaned++;
    }
  });
  return cleaned;
}

/***** ENFORCEMENT: PIVOT MODE + PER-MESSAGE LABEL PROPAGATION (ONLY _PROCESSING / _FOLLOW-UP, BATCHED) *****/
/**
 * Process only recent _UNTREATED threads (quota-friendly).
 * Behavior (pivot mode, unchanged):
 *  - Find newest unread message (pivot). If none unread, pivot = last message.
 *  - Mark ALL messages BEFORE pivot as READ.
 *  - For messages pivot..END:
 *      * Add UNREAD.
 *      * If the thread has _PROCESSING and/or _FOLLOW-UP, add those labels to the messages
 *        (so their sidebar counters pop when the thread has unread).
 * Notes: uses batchModify (≤2 calls per thread).
 */
function enforceUnreadAndLabelsRecent_(untreatedLabel) {
  const threads = fetchThreadsByQueryWithCap_(ENFORCE_RECENT_QUERY, MAX_ENFORCE_THREADS);

  // Resolve IDs for the two special labels once per run
  const labelIdByName = getLabelIdMap_(); // labels.list (1u)
  addApiUnits_(1);

  let touched = 0;

  threads.forEach(thread => {
    const msgs = thread.getMessages(); // oldest -> newest
    if (!msgs.length) return;

    const pivot = newestUnreadPivotIndex_(msgs);

    // Collect message IDs
    const beforeIds = [];
    const afterIds  = [];
    for (let i = 0; i < pivot; i++) beforeIds.push(msgs[i].getId());
    for (let i = pivot; i < msgs.length; i++) afterIds.push(msgs[i].getId());

    // Determine if the thread has either/both special labels
    const threadLabelNames = thread.getLabels().map(l => l.getName());
    const addSpecialIds = [];
    if (threadLabelNames.indexOf(PROCESSING_LABEL) !== -1 && labelIdByName[PROCESSING_LABEL]) {
      addSpecialIds.push(labelIdByName[PROCESSING_LABEL]);
    }
    if (threadLabelNames.indexOf(FOLLOWUP_LABEL) !== -1 && labelIdByName[FOLLOWUP_LABEL]) {
      addSpecialIds.push(labelIdByName[FOLLOWUP_LABEL]);
    }

    // 1) Before pivot => READ (remove UNREAD in one batch; idempotent)
    if (beforeIds.length) {
      Gmail.Users.Messages.batchModify(
        { ids: beforeIds, addLabelIds: [], removeLabelIds: ['UNREAD'] },
        'me'
      );
      addApiUnits_(50); // batchModify
      touched += beforeIds.length;
    }

    // 2) Pivot..end => UNREAD + (optional) _PROCESSING/_FOLLOW-UP in one batch
    if (afterIds.length) {
      const addLabels = addSpecialIds.length ? ['UNREAD', ...addSpecialIds] : ['UNREAD'];
      Gmail.Users.Messages.batchModify(
        { ids: afterIds, addLabelIds: addLabels, removeLabelIds: [] },
        'me'
      );
      addApiUnits_(50); // batchModify
      touched += afterIds.length;
    }
  });

  return touched;
}

/***** INTERNAL HELPERS (ENFORCEMENT) *****/
function newestUnreadPivotIndex_(messages) {
  // newest unread; if none unread, last message
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].isUnread()) return i;
  }
  return messages.length - 1;
}

function getLabelIdMap_() {
  // Build a minimal name->id map; we only care about _PROCESSING and _FOLLOW-UP here
  const map = {};
  const res = Gmail.Users.Labels.list('me');
  (res.labels || []).forEach(l => {
    if (l.name === PROCESSING_LABEL || l.name === FOLLOWUP_LABEL) {
      map[l.name] = l.id;
    }
  });
  return map;
}

/***** TASKS HELPERS *****/
function getPrimaryTasklistId_() {
  const lists = Tasks.Tasklists.list();
  if (lists.items && lists.items.length) return lists.items[0].id;
  const created = Tasks.Tasklists.insert({ title: 'Tasks (Apps Script)' });
  return created.id;
}