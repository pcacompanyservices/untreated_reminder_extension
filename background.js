// ===== Settings =====
const LABEL_NAME = '_UNTREATED';
const TARGET_HOUR = 16; 
const ACK_KEY_PREFIX = 'ack-'; // ack-YYYYMMDD
const IGNORE_KEY_PREFIX = 'ignore-'; // ignore-YYYYMMDD when user didn't ack by the acknowledgement deadline
const PENDING_KEY = 'pending-ack-date'; // stores YYYYMMDD when auto modal was shown
const ACK_DEADLINE_HOUR = 8; // Local hour when the next working day begins (ack deadline time)
const WORK_START_HOUR = 8; // Working hours start (08:00 local)
const WORK_END_HOUR = 18; // Working hours end (18:00 local, exclusive)
const GMAIL_URL_MATCH = 'https://mail.google.com/*';
const TAB_EMAILS_KEY = 'tabMailboxEmails'; // maps tabId -> mailbox email captured from content script
let cachedProfileEmail = null;
let profileFetchAttempted = false;
let profileFetchPromise = null; // de-dupe concurrent fetches
let profileBackoffUntil = 0; // epoch ms until which we should not refetch after 429
let profileCacheLoaded = false; // ensure we load persisted cache once
let countBackoffUntil = 0; // epoch ms to pause exact count after 429
let countBackoffLoaded = false;

async function ensureCountBackoffLoaded_() {
  if (countBackoffLoaded) return;
  try {
    const st = await chrome.storage.local.get(['countBackoffUntil']);
    if (typeof st.countBackoffUntil === 'number') countBackoffUntil = st.countBackoffUntil;
  } catch (e) {
    console.error('[PCA] ensureCountBackoffLoaded_ error:', e);
  }
  countBackoffLoaded = true;
}

async function getProfileEmail_() {
  // Load cache from storage once (survives SW restarts)
  if (!profileCacheLoaded) {
    try {
      const st = await chrome.storage.local.get(['profileEmailCache', 'profileBackoffUntil']);
      if (typeof st.profileBackoffUntil === 'number') profileBackoffUntil = st.profileBackoffUntil;
      if (typeof st.profileEmailCache === 'string' && st.profileEmailCache) {
        cachedProfileEmail = st.profileEmailCache.toLowerCase();
      }
    } catch (e) {
      console.error('[PCA] getProfileEmail_ cache load error:', e);
    }
    profileCacheLoaded = true;
  }

  if (cachedProfileEmail) return cachedProfileEmail;
  if (Date.now() < profileBackoffUntil) {
    // Still in backoff window, avoid hammering the API
    return null;
  }
  if (profileFetchPromise) return profileFetchPromise;

  profileFetchPromise = (async () => {
    try {
      const token = await getToken_();
      const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile?fields=emailAddress', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        let data = {};
        try { data = await res.json(); } catch (e) {
          console.error('[PCA] getProfileEmail_ json parse error:', e);
        }
        cachedProfileEmail = (data && data.emailAddress) ? String(data.emailAddress).toLowerCase() : null;
        try { await chrome.storage.local.set({ profileEmailCache: cachedProfileEmail || '' }); } catch (e) {
          console.error('[PCA] getProfileEmail_ cache write error:', e);
        }
        if (!profileFetchAttempted) {
          console.log('[PCA] Profile email resolved:', cachedProfileEmail || '(null)');
        }
        return cachedProfileEmail;
      }

      // Handle 429 backoff explicitly
      if (res.status === 429) {
        let retryAtMs = 0;
        const retryHdr = res.headers.get('retry-after');
        if (retryHdr) {
          const secs = Number(retryHdr);
          if (!Number.isNaN(secs) && secs > 0) retryAtMs = Date.now() + secs * 1000;
          else {
            const t = Date.parse(retryHdr);
            if (!Number.isNaN(t)) retryAtMs = t;
          }
        }
        if (!retryAtMs) {
          try {
            const bodyText = await res.text();
            // Attempt to extract ISO datetime from error message
            const m = bodyText.match(/Retry after\s+([0-9T:\-.Z+]+)/i);
            if (m && m[1]) {
              const t = Date.parse(m[1]);
              if (!Number.isNaN(t)) retryAtMs = t;
            }
            if (!retryAtMs && bodyText.trim()) console.warn('[PCA] profile 429 body:', bodyText);
          } catch (e) {
            console.error('[PCA] getProfileEmail_ 429 body parse error:', e);
          }
        }
        // Fallback: 2 minutes backoff if not provided
        if (!retryAtMs) retryAtMs = Date.now() + 2 * 60 * 1000;
        profileBackoffUntil = retryAtMs;
        try { await chrome.storage.local.set({ profileBackoffUntil: profileBackoffUntil }); } catch (e) {
          console.error('[PCA] getProfileEmail_ backoff storage error:', e);
        }
        if (!profileFetchAttempted) console.warn('[PCA] profile fetch 429; backoff until', new Date(profileBackoffUntil).toISOString());
        return null;
      }

      // Other non-OK statuses
      if (!profileFetchAttempted) {
        let txt = '';
        try { txt = await res.text(); } catch (e) {
          console.error('[PCA] getProfileEmail_ error text parse error:', e);
        }
        console.warn('[PCA] profile fetch failed', res.status, txt);
      }
      return null;
    } catch (e) {
      if (!profileFetchAttempted) console.warn('[PCA] getProfileEmail error', e);
      return null;
    } finally {
      profileFetchAttempted = true;
      profileFetchPromise = null;
    }
  })();

  return profileFetchPromise;
}

console.log('[PCA] SW loaded. Ext ID:', chrome.runtime.id);

// Clear profile cache when sign-in state changes
try {
  chrome.identity.onSignInChanged.addListener(async () => {
    cachedProfileEmail = null;
    profileFetchAttempted = false;
    profileFetchPromise = null;
    profileBackoffUntil = 0;
  try { await chrome.storage.local.remove(['profileEmailCache', 'profileBackoffUntil', 'untreatedCountCache', 'countBackoffUntil']); } catch (e) {
      console.error('[PCA] onSignInChanged storage remove error:', e);
    }
    console.log('[PCA] Sign-in changed: cleared profile cache');
  });
} catch (e) {
  console.error('[PCA] onSignInChanged addListener error:', e);
}

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

function isGmailUrl_(url) {
  return typeof url === 'string' && url.startsWith('https://mail.google.com/');
}

// Enable or disable the toolbar icon for a specific tab based on URL and mailbox/profile match
async function updateActionStateForTab_(tabId, url) {
  try {
    if (!isGmailUrl_(url)) {
      await chrome.action.disable(tabId);
      await chrome.action.setTitle({ tabId, title: 'Inactive: open your authorized Gmail mailbox' });
      return;
    }
    const profile = await getProfileEmail_();
    const st = await chrome.storage.local.get(TAB_EMAILS_KEY);
    const map = st[TAB_EMAILS_KEY] || {};
    const tabEmail = map[String(tabId)];
    const match = !!profile && !!tabEmail && profile === tabEmail;
  await chrome.action.enable(tabId);
  await chrome.action.setTitle({ tabId, title: match ? 'PCA Untreated Reminder – Force check' : 'Mailbox does not match this Chrome profile' });
  } catch (e) {
    // Best-effort: if any error, disable to be safe
    console.error('[PCA] updateActionStateForTab_ error:', e);
    try { await chrome.action.disable(tabId); } catch (disableErr) {
      console.error('[PCA] updateActionStateForTab_ disable fallback error:', disableErr);
    }
  }
}

/**
 * Run on install or update extension
 */
chrome.runtime.onInstalled.addListener(() => { 
  // setActionIcon_(); 
  scheduleNextAlarm_(); 
  scheduleHourlyCount_(); 
  runHousekeeping_(); 
  // Seed cache once on install
  const now = new Date();
  if (!isWeekend_(now) && isWithinWorkingHours_(now)) {
    refreshUntreatedCountCache_().catch(() => {});
  }
});

chrome.runtime.onStartup.addListener(() => { 
  // setActionIcon_(); 
  scheduleNextAlarm_(); 
  scheduleHourlyCount_(); 
  runHousekeeping_(); 
  // Seed cache on startup so UI has an exact number without triggering heavy calls from content
  const now = new Date();
  if (!isWeekend_(now) && isWithinWorkingHours_(now)) {
    refreshUntreatedCountCache_().catch(() => {});
  }
});

chrome.alarms.onAlarm.addListener(a => {
  if (a.name === 'daily-ack') {
    console.log('[PCA] Alarm fired at', new Date().toString());
    handleTimeCheckpoint_();
    scheduleNextAlarm_();
    return;
  }
  // Hourly refresh of exact _UNTREATED count cache
  if (a.name === 'untreated-hourly') {
    (async () => {
      try {
        const now = new Date();
        if (!isWeekend_(now) && isWithinWorkingHours_(now)) {
          await refreshUntreatedCountCache_();
          await refreshBannersOnGmailTabs_();
        } else {
          // Skip refresh outside working hours/weekends
        }
      } catch (e) {
        console.warn('[PCA] Hourly count refresh failed', e);
      }
    })();
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
      const match = !!profile && !!tabEmail && tabEmail === profile;
      if (!match) {
        // On mismatch, show the original info modal/alert and do nothing else
        try {
          await chrome.scripting.executeScript({ target: { tabId: activeTab.id }, func: () => alert('This tool only works on the authorized internal mailbox for this Chrome profile.') });
        } catch (e) { console.warn('[PCA] alert inject failed', e); }
        return;
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
      } catch (e) {
        console.error('[PCA] MAILBOX_EMAIL storage set error:', e);
      }
      const match = !!profile && !!email && profile === email;
  // Update action state for this tab immediately
  try { await updateActionStateForTab_(sender.tab.id, sender.tab.url || ''); } catch (e) {
        console.error('[PCA] MAILBOX_EMAIL updateActionStateForTab_ error:', e);
      }
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
        const email = await getProfileEmail_();
        let count = 0;
        if (email) {
          const cached = await readUntreatedCountCacheForEmail_(email);
          if (typeof cached === 'number') count = cached;
        }
        sendResponse({ ok: true, count }); // content defaults to 0 when missing
      } catch (e) {
        console.warn('[PCA] GET_UNTREATED_COUNT failed', e);
        sendResponse({ ok: false, err: String(e) });
      }
    })();
    return true;
  }
});

// Refresh action state when the active tab changes
try {
  chrome.tabs.onActivated.addListener(async ({ tabId }) => {
    try {
      const tab = await chrome.tabs.get(tabId);
      await updateActionStateForTab_(tabId, tab.url || '');
    } catch (e) {
      console.error('[PCA] onActivated updateActionStateForTab_ error:', e);
    }
  });
} catch (e) {
  console.error('[PCA] onActivated addListener error:', e);
}

// Refresh action state when a tab is updated (URL changes, Gmail loads)
try {
  chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (!changeInfo.url && changeInfo.status !== 'complete') return;
    await updateActionStateForTab_(tabId, (changeInfo.url || tab.url || ''));
  });
} catch (e) {
  console.error('[PCA] onUpdated addListener error:', e);
}

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

  let count = 0;
  try {
    count = await getUntreatedCount_({ exact: true });
  } catch (e) {
    console.warn('[PCA] exact count failed', e);
    // Fallback: use cached exact (if any) and estimate to decide modal
    const email = await getProfileEmail_();
    let cached = 0;
    if (email) {
      const c = await readUntreatedCountCacheForEmail_(email);
      if (typeof c === 'number') cached = c;
    }
    const estimate = await getUntreatedEstimate_().catch((e) => {
      console.error('[PCA] handleTimeCheckpoint_ getUntreatedEstimate_ error:', e);
      return 0;
    });
    // Prefer cached count for display; use estimate>0 to decide
    count = cached;
    if (estimate <= 0 && cached <= 0) {
      console.log('[PCA] No _UNTREATED by estimate/cache; nothing to show');
      return;
    }
  }
  console.log('[PCA] _UNTREATED (threads exact) =', count);
  // Ensure banner reflects the latest exact count
  try { await refreshBannersOnGmailTabs_(); } catch (e) {
    console.error('[PCA] handleTimeCheckpoint_ refreshBannersOnGmailTabs_ error:', e);
  }

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
  console.log('[PCA] No _UNTREATED threads; nothing to show');
  }
}

async function notifyGmailTabs_(count, auto, dateKey) {
  const { matchedTabs, skipped } = await getMatchedGmailTabs_();
  let matched = 0;
  for (const tab of matchedTabs) {
    const ok = await sendMessageOrInject_(tab.id, { type: 'SHOW_MODAL', count, auto, dateKey });
    if (!ok) console.warn('[PCA] Could not contact tab', tab.id); else matched++;
  }
  console.log(`[PCA] Notified tabs matched=${matched} skipped=${skipped}`);
}

// Ask matched Gmail tabs to refresh their banner (pulls cached exact count)
async function refreshBannersOnGmailTabs_() {
  const tabs = await chrome.tabs.query({ url: GMAIL_URL_MATCH });
  const profile = await getProfileEmail_();
  let stMap = {};
  try { const st = await chrome.storage.local.get(TAB_EMAILS_KEY); stMap = st[TAB_EMAILS_KEY] || {}; } catch (e) {
    console.error('[PCA] refreshBannersOnGmailTabs_ getTabEmailsMap error:', e);
  }
  let matched = 0;
  for (const tab of tabs) {
    const tabEmail = stMap[String(tab.id)];
    if (!profile || !tabEmail || tabEmail !== profile) continue;
    const ok = await sendMessageOrInject_(tab.id, { type: 'REFRESH_BANNER' });
    if (ok) matched++;
  }
  if (matched) console.log(`[PCA] Banner refresh requested on ${matched} tab(s)`);
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

async function getTabEmailsMap_() {
  try {
    const st = await chrome.storage.local.get(TAB_EMAILS_KEY);
    return st[TAB_EMAILS_KEY] || {};
  } catch (e) {
    console.error('[PCA] getTabEmailsMap_ error:', e);
    return {};
  }
}

// Returns { matchedTabs, skipped } where matchedTabs are Gmail tabs whose mailbox matches the profile
async function getMatchedGmailTabs_() {
  const tabs = await chrome.tabs.query({ url: GMAIL_URL_MATCH });
  const profile = await getProfileEmail_();
  const map = await getTabEmailsMap_();
  const matchedTabs = [];
  let skipped = 0;
  for (const tab of tabs) {
    const tabEmail = map[String(tab.id)];
    if (!profile || !tabEmail || tabEmail !== profile) { skipped++; continue; }
    matchedTabs.push(tab);
  }
  return { matchedTabs, skipped };
}

/**
 * function scheduleNextDailyAlarm_
 * Schedules the next daily alarm at TARGET_HOUR on the next working day.
 */
function scheduleNextAlarm_() {
  const now = new Date();
  const nextRun = new Date(now);
  nextRun.setHours(TARGET_HOUR, 0, 0, 0);
  if (nextRun <= now) nextRun.setDate(nextRun.getDate() + 1);
  // Skip weekends
  while (isWeekend_(nextRun)) {
    nextRun.setDate(nextRun.getDate() + 1);
    nextRun.setHours(TARGET_HOUR, 0, 0, 0);
  }

  // clear existing alarm before creating a new one
  chrome.alarms.clear('daily-ack', () => {
    chrome.alarms.create('daily-ack', { when: nextRun.getTime() });
    console.log('[PCA] Next daily ACK alarm scheduled at', nextRun.toString());
  });
}


/**
 * function scheduleHourlyUntreatedCount_
 * Schedules an hourly alarm at the top of the hour to refresh exact _UNTREATED count cache.
 */
function scheduleHourlyCount_() {
  try {
    const now = new Date();

    const nextRun = new Date(now);
    nextRun.setMinutes(0, 0, 0); // top of the hour
    if (nextRun <= now) {
        nextRun.setHours(nextRun.getHours() + 1);
    }

    chrome.alarms.clear('untreated-hourly', () => {
      chrome.alarms.create('untreated-hourly', {
        when: nextRun.getTime(),
        periodInMinutes: 60,
      });
    
    console.log(
        '[PCA] Hourly untreated count refresh scheduled at',
        nextRun.toString()
      );
    });
  } catch (e) {
    console.warn('[PCA] scheduleHourlyCount failed', e);
  }
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
  try { await chrome.alarms.clear(name); } catch (e) {
    console.error('[PCA] clearAckDeadlineAlarm_ error:', e);
  }
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
    await chrome.storage.local.remove(PENDING_KEY).catch((e) => {
      console.error('[PCA] runHousekeeping_ remove PENDING_KEY error:', e);
    });
    await clearAckDeadlineAlarm_(pending).catch((e) => {
      console.error('[PCA] runHousekeeping_ clearAckDeadlineAlarm_ error:', e);
    });
    return;
  }

  const now = new Date();
  const deadline = getAckDeadlineFor_(pending);
  if (now >= deadline) {
    await chrome.storage.local.set({ [ignoreKey]: true });
    await chrome.storage.local.remove(PENDING_KEY);
    await clearAckDeadlineAlarm_(pending);
    // Best-effort cleanup for any legacy EOD alarms (from previous versions)
    try { await chrome.alarms.clear(`eod-${pending}`); } catch (e) {
      console.error('[PCA] runHousekeeping_ clear legacy alarm error:', e);
    }
    await closeAllGmailModals_();
      console.log('[PCA] Housekeeping marked missed acknowledgement for', pending);
    }
  else {
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
  // Return time first (24h) then date: "HH:MM DD/MM/YYYY"
  return `${hh}:${min} ${dd}/${mm}/${yyyy}`;
}

// Working hours helper: true if local time within [WORK_START_HOUR, WORK_END_HOUR)
function isWithinWorkingHours_(date) {
  const h = date.getHours();
  return h >= WORK_START_HOUR && h < WORK_END_HOUR;
}

// Close any open modals across Gmail tabs
async function closeAllGmailModals_() {
  const { matchedTabs } = await getMatchedGmailTabs_();
  for (const tab of matchedTabs) {
    await sendMessageOrInject_(tab.id, { type: 'CLOSE_MODAL' });
  }
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    const st = await chrome.storage.local.get(TAB_EMAILS_KEY);
    const map = st[TAB_EMAILS_KEY] || {};
    if (map[String(tabId)]) { delete map[String(tabId)]; await chrome.storage.local.set({ [TAB_EMAILS_KEY]: map }); }
  } catch (e) {
    console.error('[PCA] onRemoved tab storage cleanup error:', e);
  }
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

// In-flight de-duplication for exact counting
let untreatedCountInFlight = null; // Promise<{email, count}> or null

// Get _UNTREATED threads count with options:
// - exact: if true, compute via pagination (accurate)
// - useCache: if true, return cached value when available
async function getUntreatedCount_(opts = {}) {
  const { exact = false, useCache = true } = opts;
  const email = await getProfileEmail_();
  if (!email) {
    // No profile/email known; best we can do is 0 (also prevents accidental cross-account cache use)
    return 0;
  }

  // Try cache first when allowed
  if (useCache) {
    const cached = await readUntreatedCountCacheForEmail_(email);
    if (cached != null && !exact) return cached;
  }

  // If an exact computation is already in-flight, share it
  if (untreatedCountInFlight) {
    try {
      const res = await untreatedCountInFlight;
      if (res && res.email === email) return res.count;
    } catch (e) {
      console.error('[PCA] getUntreatedCount_ untreatedCountInFlight error:', e);
      // ignore and proceed to compute
    }
  }

  // Compute exact count now
  untreatedCountInFlight = (async () => {
    const count = await getExactUntreatedCountFromApi_();
    await writeUntreatedCountCacheForEmail_(email, count).catch((e) => {
      console.error('[PCA] getUntreatedCount_ writeUntreatedCountCacheForEmail_ error:', e);
    });
    return { email, count };
  })();

  try {
    const res = await untreatedCountInFlight;
    return res.count;
  } finally {
    untreatedCountInFlight = null;
  }
}

// Force refresh of cached exact count (used by hourly alarm)
async function refreshUntreatedCountCache_() {
  const email = await getProfileEmail_();
  if (!email) return; // no-op when profile unknown or in backoff
  const count = await getUntreatedCount_({ exact: true, useCache: false }).catch(async (e) => {
    // On failure, keep existing cache; simply skip update
    console.warn('[PCA] refresh cache skipped (exact failed)', e);
    const c = await readUntreatedCountCacheForEmail_(email);
    return typeof c === 'number' ? c : 0;
  });
  if (typeof count === 'number') {
    await writeUntreatedCountCacheForEmail_(email, count);
  }
  console.log('[PCA] Hourly exact _UNTREATED count cached for', email, '=', count);
}

// Perform paginated threads.list to count all matching threads exactly
async function getExactUntreatedCountFromApi_() {
  await ensureCountBackoffLoaded_();
  if (Date.now() < countBackoffUntil) {
    throw new Error(`count-backoff-active-until:${new Date(countBackoffUntil).toISOString()}`);
  }
  const token = await getToken_();
  let total = 0;
  let pageToken;
  do {
    const params = new URLSearchParams({ maxResults: '500', q: `label:${LABEL_NAME} -in:trash -in:spam` });
    if (pageToken) params.set('pageToken', pageToken);
    // Only fetch minimal fields to reduce payload
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/threads?${params.toString()}&fields=nextPageToken,threads/id`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      let txt = '';
      try { txt = await res.text(); } catch (e) {
        console.error('[PCA] getExactUntreatedCountFromApi_ error text parse error:', e);
      }
      if (res.status === 429) {
        // Parse retry-after and set backoff
        let retryAtMs = 0;
        try {
          const hdr = res.headers.get('retry-after');
          if (hdr) {
            const secs = Number(hdr);
            if (!Number.isNaN(secs) && secs > 0) retryAtMs = Date.now() + secs * 1000;
            else {
              const t = Date.parse(hdr);
              if (!Number.isNaN(t)) retryAtMs = t;
            }
          }
          if (!retryAtMs && txt) {
            const m = txt.match(/Retry after\s+([0-9T:\-.Z+]+)/i);
            if (m && m[1]) {
              const t = Date.parse(m[1]);
              if (!Number.isNaN(t)) retryAtMs = t;
            }
          }
        } catch (e) {
          console.error('[PCA] getExactUntreatedCountFromApi_ retry parse error:', e);
        }
        if (!retryAtMs) retryAtMs = Date.now() + 2 * 60 * 1000; // default 2 min
        countBackoffUntil = retryAtMs;
        try { await chrome.storage.local.set({ countBackoffUntil }); } catch (e) {
          console.error('[PCA] getExactUntreatedCountFromApi_ countBackoffUntil storage error:', e);
        }
        throw new Error(`threads.list failed: 429 backoff-until ${new Date(retryAtMs).toISOString()}`);
      }
      throw new Error(`threads.list failed: ${res.status} ${txt}`);
    }
    let data = {};
    try { data = await res.json(); } catch (e) {
      console.error('[PCA] getExactUntreatedCountFromApi_ json response parse error:', e);
    }
    const arr = Array.isArray(data.threads) ? data.threads : [];
    total += arr.length;
    pageToken = data.nextPageToken;
  } while (pageToken);
  return total;
}

// Low-cost estimate used as a fallback to decide presence of untreated items
async function getUntreatedEstimate_() {
  const token = await getToken_();
  const params = new URLSearchParams({ maxResults: '1', q: `label:${LABEL_NAME} -in:trash -in:spam` });
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/threads?${params.toString()}&fields=resultSizeEstimate`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return 0;
  try {
    const data = await res.json();
    return Number(data.resultSizeEstimate) || 0;
  } catch (e) {
    console.error('[PCA] getUntreatedEstimate_ error:', e);
    return 0;
  }
}

// Storage helpers for per-email cached counts
async function readUntreatedCountCacheForEmail_(email) {
  try {
    const st = await chrome.storage.local.get('untreatedCountCache');
    const cache = st.untreatedCountCache || {};
    const entry = cache[email];
    if (!entry) return null;
    // Optional: could check staleness here if desired
    return typeof entry.count === 'number' ? entry.count : null;
  } catch (e) {
    console.error('[PCA] readUntreatedCountCacheForEmail_ error:', e);
    return null;
  }
}

async function writeUntreatedCountCacheForEmail_(email, count) {
  try {
    const st = await chrome.storage.local.get('untreatedCountCache');
    const cache = st.untreatedCountCache || {};
    cache[email] = { count, ts: Date.now() };
    await chrome.storage.local.set({ untreatedCountCache: cache });
  } catch (e) {
    console.warn('[PCA] Failed to write untreatedCountCache', e);
  }
}