// ===== Settings =====
const LABEL_NAME = '_UNTREATED';
const TARGET_HOUR = 16; 
const ACK_KEY_PREFIX = 'ack-'; // ack-YYYYMMDD
const IGNORE_KEY_PREFIX = 'ignore-'; // ignore-YYYYMMDD when user didn't ack by the acknowledgement deadline
const PENDING_KEY = 'pending-ack-date'; // stores YYYYMMDD when auto modal was shown
const ACK_DEADLINE_HOUR = 8; // Local hour when the next working day begins (ack deadline time)
const GMAIL_URL_MATCH = 'https://mail.google.com/*';
const TAB_EMAILS_KEY = 'tabMailboxEmails'; // maps tabId -> mailbox email captured from content script
let cachedProfileEmail = null;
let profileFetchAttempted = false;
async function getProfileEmail_() {
  if (cachedProfileEmail) return cachedProfileEmail;
  try {
    const token = await getToken_();
    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile?fields=emailAddress', {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (res.ok) {
      const data = await res.json();
      cachedProfileEmail = (data && data.emailAddress) ? data.emailAddress.toLowerCase() : null;
      if (!profileFetchAttempted) {
        console.log('[PCA] Profile email resolved:', cachedProfileEmail || '(null)');
      }
    } else if (!profileFetchAttempted) {
      const txt = await res.text();
      console.warn('[PCA] profile fetch failed', res.status, txt);
    }
  } catch (e) {
    if (!profileFetchAttempted) console.warn('[PCA] getProfileEmail error', e);
  }
  profileFetchAttempted = true;
  return cachedProfileEmail;
}

console.log('[PCA] SW loaded. Ext ID:', chrome.runtime.id);

// Set toolbar icon from local photo
function setActionIcon_() {
  try {
    chrome.action.setIcon({
      path: {
        16: 'pca_cropped_logo.png',
        32: 'pca_cropped_logo.png'
      }
    });
  } catch (e) {
    console.warn('[PCA] setActionIcon failed', e);
  }
}

// Schedule the daily target-hour alarm
chrome.runtime.onInstalled.addListener(() => { setActionIcon_(); scheduleNextAlarm_(); runHousekeeping_(); });
chrome.runtime.onStartup.addListener(() => { setActionIcon_(); scheduleNextAlarm_(); runHousekeeping_(); });
chrome.alarms.onAlarm.addListener(a => {
  if (a.name === 'daily-ack') {
    console.log('[PCA] Alarm fired at', new Date().toString());
    handleTimeCheckpoint_();
    scheduleNextAlarm_();
    return;
  }
  // Handle acknowledgement deadline alarms (next working day at 08:00 local)
  if (a.name?.startsWith('ack-deadline-')) {
    const dateKey = a.name.substring('ack-deadline-'.length);
    (async () => {
  console.log('[PCA] Deadline reached for', dateKey, 'at', formatShortDateTime_(new Date()));
      const ackKey = `${ACK_KEY_PREFIX}${dateKey}`;
      const ignoreKey = `${IGNORE_KEY_PREFIX}${dateKey}`;
      const st = await chrome.storage.local.get([ackKey, ignoreKey, PENDING_KEY]);
      if (!st[ackKey] && !st[ignoreKey]) {
        await chrome.storage.local.set({ [ignoreKey]: true });
        if (st[PENDING_KEY] === dateKey) await chrome.storage.local.remove(PENDING_KEY);
  // Close any lingering modals for that date
  await closeAllGmailModals_();
  console.log('[PCA] Missed acknowledgement marked for', dateKey);
      }
    })();
  }
});

// Toolbar icon: force a check (and guarantee consent UI)
chrome.action.onClicked.addListener(async () => {
  console.log('[PCA] Action clicked');
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab && activeTab.url && activeTab.url.startsWith('https://mail.google.com/')) {
    try {
      const profile = await getProfileEmail_();
      const st = await chrome.storage.local.get(TAB_EMAILS_KEY);
      const map = st[TAB_EMAILS_KEY] || {};
  const tabEmail = map[String(activeTab.id)];
  console.log('[PCA] Action context profile=', profile || '(null)', 'tabEmail=', tabEmail || '(none)');
      if (!tabEmail || !profile || tabEmail !== profile) {
        try {
          await chrome.scripting.executeScript({ target: { tabId: activeTab.id }, func: () => alert('This tool only works on the authorized internal mailbox for this Chrome profile.') });
        } catch (e) { console.warn('[PCA] alert inject failed', e); }
        return; // block feature when mismatch
      }
    } catch {}
  }
  await ensureTokenInteractive_();
  handleTimeCheckpoint_(/*force=*/true);
});

// From content script (on page load after 4pm)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'MAILBOX_EMAIL' && sender.tab?.id != null) {
    (async () => {
      const email = (msg.email || '').toLowerCase();
      let profile = await getProfileEmail_();
      try {
        const st = await chrome.storage.local.get(TAB_EMAILS_KEY);
        const map = st[TAB_EMAILS_KEY] || {};
        const existing = map[String(sender.tab.id)];
        if (existing !== email) {
          console.log('[PCA] Recorded mailbox email for tab', sender.tab.id, email, 'profile=', profile || '(null)');
        }
        map[String(sender.tab.id)] = email;
        await chrome.storage.local.set({ [TAB_EMAILS_KEY]: map });
      } catch {}
      const match = !!profile && !!email && profile === email;
      sendResponse({ ok: true, match, profile });
    })();
    return true; // async
  }
  if (msg?.type === 'CHECK_AND_MAYBE_SHOW') {
    handleTimeCheckpoint_()
      .then(() => sendResponse({ ok: true }))
      .catch(e => { console.error('[PCA] check error', e); sendResponse({ ok: false, err: String(e) }); });
    return true; // async
  }
  if (msg?.type === 'CLOSE_ALL_MODALS') {
    (async () => {
  await closeAllGmailModals_();
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (msg?.type === 'ACK_DATE') {
    (async () => {
      const todayKey = getTodayKey_();
      const dateKey = msg.dateKey || todayKey;
      // Accept ACK if it's before the acknowledgement deadline for the given dateKey
      const now = new Date();
      const deadline = getAckDeadlineFor_(dateKey);
      if (!(now < deadline)) {
        console.log('[PCA] ACK ignored: past deadline for', dateKey, 'deadline was', formatShortDateTime_(deadline));
  // Still close all modals for UX
  await closeAllGmailModals_();
        sendResponse({ ok: false, reason: 'late-ack-ignored' });
        return;
      }
      const ackKey = `${ACK_KEY_PREFIX}${dateKey}`;
      chrome.storage.local.set({ [ackKey]: true }, async () => {
  // Broadcast CLOSE_MODAL to all Gmail tabs using sendMessageOrInject_ for reliability
  await closeAllGmailModals_();
        // Clear pending for this date and any scheduled acknowledgement deadline alarm
        const st = await chrome.storage.local.get(PENDING_KEY);
        if (st[PENDING_KEY] === dateKey) await chrome.storage.local.remove(PENDING_KEY);
  await clearAckDeadlineAlarm_(dateKey);
  console.log('[PCA] ACK recorded for', dateKey);
        sendResponse({ ok: true });
      });
    })();
    return true;
  }
  if (msg?.type === 'GET_UNTREATED_COUNT') {
    (async () => {
      try {
        const count = await getUntreatedCount_();
        sendResponse({ ok: true, count });
      } catch (e) {
        console.warn('[PCA] GET_UNTREATED_COUNT failed', e);
        sendResponse({ ok: false, err: String(e) });
      }
    })();
    return true;
  }
});

// ===== Core logic =====
async function handleTimeCheckpoint_(force = false) {
  const now = new Date();
  const day = now.getDay();
  if (!force && (day === 0 || day === 6)) { console.log('[PCA] Weekend; skip'); return; }
  if (!force && now.getHours() < TARGET_HOUR) { console.log(`[PCA] Before target hour (${TARGET_HOUR}); skip`); return; }

  const todayKey = getTodayKey_();
  const ackKey = `${ACK_KEY_PREFIX}${todayKey}`;
  const ignoreKey = `${IGNORE_KEY_PREFIX}${todayKey}`;
  const stored = await chrome.storage.local.get([ackKey, ignoreKey]);
  if (!force && stored[ackKey]) { console.log('[PCA] Already acknowledged today; skip'); return; }
  if (!force && stored[ignoreKey]) { console.log('[PCA] Already marked ignored today; skip'); return; }

  // Debug: whose token/profile?
  try {
    const info = await chrome.identity.getProfileUserInfo();
    console.log('[PCA] Token/profile email:', info.email || '(unknown)');
  } catch {}

  const count = await getUntreatedCount_().catch(e => { console.error('[PCA] count failed', e); return 0; });
  console.log('[PCA] _UNTREATED (threads overdue >24h) =', count);

  if (count > 0) {
    const auto = !force;
    await notifyGmailTabs_(count, auto, todayKey);
    if (auto) {
      await chrome.storage.local.set({ [PENDING_KEY]: todayKey });
  const deadline = getAckDeadlineFor_(todayKey);
  console.log('[PCA] Pending set for', todayKey, 'deadline at', formatShortDateTime_(deadline));
  await scheduleAckDeadlineAlarm_(todayKey);
    }
  } else {
    console.log('[PCA] No untreated overdue >24h; nothing to show');
  }
}

async function notifyGmailTabs_(count, auto, dateKey) {
  const tabs = await chrome.tabs.query({ url: GMAIL_URL_MATCH });
  const profile = await getProfileEmail_();
  let stMap = {};
  try { const st = await chrome.storage.local.get(TAB_EMAILS_KEY); stMap = st[TAB_EMAILS_KEY] || {}; } catch {}
  let matched = 0, skipped = 0;
  for (const tab of tabs) {
    const tabEmail = stMap[String(tab.id)];
    if (!profile || !tabEmail || tabEmail !== profile) { skipped++; continue; }
    const ok = await sendMessageOrInject_(tab.id, { type: 'SHOW_MODAL', count, auto, dateKey });
    if (!ok) console.warn('[PCA] Could not contact tab', tab.id); else matched++;
  }
  console.log(`[PCA] Notified tabs matched=${matched} skipped=${skipped}`);
}

// Try sending to the tab; if no listener, inject content.js, then resend.
async function sendMessageOrInject_(tabId, message) {
  // 1) First attempt
  if (await trySend_(tabId, message)) return true;

  // 2) Inject content.js then retry
  try {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch (e) {
    console.warn('[PCA] Injection failed for tab', tabId, e);
    // Even if injection fails, attempt one more send (tab may have loaded in the meantime)
  }
  return await trySend_(tabId, message);
}

function trySend_(tabId, message) {
  return new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, message, () => {
      if (chrome.runtime.lastError) {
        // "Could not establish connection. Receiving end does not exist." etc.
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}

function scheduleNextAlarm_() {
  const now = new Date();
  const when = new Date(now);
  when.setHours(TARGET_HOUR, 0, 0, 0);
  if (when <= now) when.setDate(when.getDate() + 1);
  // Skip weekends: advance to next non-weekend day at target hour
  while (isWeekend_(when)) {
    when.setDate(when.getDate() + 1);
    when.setHours(TARGET_HOUR, 0, 0, 0);
  }
  chrome.alarms.create('daily-ack', { when: when.getTime() });
  console.log('[PCA] Next alarm scheduled at', when.toString());
}

async function scheduleAckDeadlineAlarm_(dateKey) {
  // Schedule the acknowledgement deadline at the start of the next working day (08:00 local)
  const deadline = getAckDeadlineFor_(dateKey);
  const name = `ack-deadline-${dateKey}`;
  try {
    chrome.alarms.create(name, { when: deadline.getTime() });
    console.log('[PCA] Ack deadline alarm scheduled at', deadline.toString(), 'for', dateKey);
  } catch (e) {
    console.warn('[PCA] Failed to schedule ack deadline alarm', name, e);
  }
}

async function clearAckDeadlineAlarm_(dateKey) {
  const name = `ack-deadline-${dateKey}`;
  try { await chrome.alarms.clear(name); } catch {}
}

async function runHousekeeping_() {
  const st = await chrome.storage.local.get([PENDING_KEY]);
  const pending = st[PENDING_KEY];
  if (!pending) return;

  const ackKey = `${ACK_KEY_PREFIX}${pending}`;
  const ignoreKey = `${IGNORE_KEY_PREFIX}${pending}`;
  const s2 = await chrome.storage.local.get([ackKey, ignoreKey]);
  if (s2[ackKey] || s2[ignoreKey]) {
    // Nothing to do; clear stray pending if any
    await chrome.storage.local.remove(PENDING_KEY).catch(() => {});
    await clearAckDeadlineAlarm_(pending).catch(() => {});
    return;
  }

  const now = new Date();
  const deadline = getAckDeadlineFor_(pending);
  if (now >= deadline) {
    await chrome.storage.local.set({ [ignoreKey]: true });
    await chrome.storage.local.remove(PENDING_KEY);
    await clearAckDeadlineAlarm_(pending);
  // Best-effort cleanup for any legacy EOD alarms (from previous versions)
  try { await chrome.alarms.clear(`eod-${pending}`); } catch {}
  await closeAllGmailModals_();
    console.log('[PCA] Housekeeping marked missed acknowledgement for', pending);
  } else {
    // Ensure the deadline alarm exists and is correctly scheduled
    await scheduleAckDeadlineAlarm_(pending);
  }
}

function getTodayKey_() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
}

// ===== Working day helpers =====
function isWeekend_(date) {
  const day = date.getDay();
  return day === 0 || day === 6; // Sunday(0) or Saturday(6)
}

function getNextAckDeadlineFromDate_(date) {
  // Returns a Date set to the acknowledgement deadline time on the next working day from the given Date
  const d = new Date(date);
  // Move to next day first
  d.setDate(d.getDate() + 1);
  d.setHours(ACK_DEADLINE_HOUR, 0, 0, 0);
  // If it's weekend, advance to Monday at 08:00
  while (isWeekend_(d)) {
    d.setDate(d.getDate() + 1);
    d.setHours(ACK_DEADLINE_HOUR, 0, 0, 0);
  }
  return d;
}

function getAckDeadlineFor_(dateKey) {
  // Compute the deadline (Date) for acknowledging for the provided dateKey (YYYYMMDD)
  const y = Number(dateKey.slice(0, 4));
  const m = Number(dateKey.slice(4, 6)) - 1;
  const d = Number(dateKey.slice(6, 8));
  const base = new Date(y, m, d, 0, 0, 0, 0); // start of that day
  return getNextAckDeadlineFromDate_(base);
}

function formatShortDateTime_(dt) {
  const dd = String(dt.getDate()).padStart(2, '0');
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const yyyy = dt.getFullYear();
  const hh = String(dt.getHours()).padStart(2, '0');
  const min = String(dt.getMinutes()).padStart(2, '0');
  return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
}

// Close any open modals across Gmail tabs
async function closeAllGmailModals_() {
  const tabs = await chrome.tabs.query({ url: GMAIL_URL_MATCH });
  const profile = await getProfileEmail_();
  let stMap = {};
  try { const st = await chrome.storage.local.get(TAB_EMAILS_KEY); stMap = st[TAB_EMAILS_KEY] || {}; } catch {}
  for (const tab of tabs) {
    const tabEmail = stMap[String(tab.id)];
    if (!profile || !tabEmail || tabEmail !== profile) continue;
    await sendMessageOrInject_(tab.id, { type: 'CLOSE_MODAL' });
  }
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    const st = await chrome.storage.local.get(TAB_EMAILS_KEY);
    const map = st[TAB_EMAILS_KEY] || {};
    if (map[String(tabId)]) { delete map[String(tabId)]; await chrome.storage.local.set({ [TAB_EMAILS_KEY]: map }); }
  } catch {}
});

// ===== OAuth helpers =====
async function ensureTokenInteractive_() {
  await new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, token => {
      if (chrome.runtime.lastError || !token) reject(chrome.runtime.lastError || new Error('No token'));
      else resolve(token);
    });
  });
}
function getToken_() {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: false }, token => {
      if (chrome.runtime.lastError || !token) reject(chrome.runtime.lastError || new Error('No token'));
      else resolve(token);
    });
  });
}

// ===== Gmail helpers =====

// Cache the label id so we can query by labelIds (faster & exact)
async function getLabelIdByName_(name) {
  const cacheKey = 'labelIdCache';
  const token = await getToken_();

  // Try cache first
  const cache = await chrome.storage.local.get(cacheKey);
  if (cache[cacheKey] && cache[cacheKey][name]) return cache[cacheKey][name];

  // Fetch labels (id + name only)
  const res = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/labels?fields=labels(id,name)',
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error('labels.list failed');
  const data = await res.json();
  const found = (data.labels || []).find(l => l.name === name);
  const id = found ? found.id : null;

  // Update cache
  const next = cache[cacheKey] || {};
  next[name] = id;
  await chrome.storage.local.set({ [cacheKey]: next });

  return id;
}

// Exact thread count for label:_UNTREATED that are older than 24 hours (excludes trash/spam)
async function getUntreatedCount_() {
  const token = await getToken_();
  const labelId = await getLabelIdByName_(LABEL_NAME);
  if (!labelId) return 0; // label not present yet

  let total = 0;
  let pageToken;

  do {
    const base = 'https://gmail.googleapis.com/gmail/v1/users/me/threads';
    const params = new URLSearchParams({
      maxResults: '500',
      labelIds: labelId,
      q: 'older_than:1d -in:trash -in:spam' // overdue > 24 hours
    });
    if (pageToken) params.set('pageToken', pageToken);

    const url = `${base}?${params.toString()}&fields=nextPageToken,threads/id`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`threads.list failed: ${res.status} ${txt}`);
    }
    const data = await res.json();
    total += Array.isArray(data.threads) ? data.threads.length : 0;
    pageToken = data.nextPageToken;
  } while (pageToken);

  return total; // exact thread count (overdue >24h)
}