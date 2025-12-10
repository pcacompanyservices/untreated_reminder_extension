import { AckService } from './modules/AckService.js';
import { GmailApiClient } from './modules/GmailApiClient.js';
import { StorageKeys } from './modules/StorageKeys.js';
import { closeAllGmailModals_ } from './modules/ModalHelpers.js';
import { getAckDeadlineFor_, formatShortDateTime_, clearAckDeadlineAlarm_} from './modules/AckHelpers.js';
import { ensureTokenInteractive_, getToken_} from './modules/OAuthHelpers.js';

// ===== Settings =====

const LABEL_NAME = '_UNTREATED';
const TARGET_HOUR = 16; 
// const ACK_KEY_PREFIX = 'ack-'; // ack-YYYYMMDD
// const IGNORE_KEY_PREFIX = 'ignore-'; // ignore-YYYYMMDD when user didn't ack by the acknowledgement deadline
// const PENDING_KEY = 'pending-ack-date'; // stores YYYYMMDD when auto modal was shown
// const ACK_DEADLINE_HOUR = 8; // Local hour when the next working day begins (ack deadline time)
const WORK_START_HOUR = 8; // Working hours start (08:00 local)
const WORK_END_HOUR = 18; // Working hours end (18:00 local, exclusive)
const GMAIL_URL_MATCH = 'https://mail.google.com/*';
const TAB_EMAILS_KEY = 'tabMailboxEmails'; // maps tabId -> mailbox email captured from content script



// ===== Gmail API client =====
async function getProfileEmail_(){
  return GmailApiClient.getProfileEmail();
}

async function getUntreatedCountExact_(){
  return GmailApiClient.getUntreatedCountExact()
}

async function getUntreatedEstimate_(){
  return GmailApiClient.getUntreatedEstimate();
}

async function resetProfileCache_(){
  return GmailApiClient.resetProfileCache();
}

// async function ensureProfileCacheLoaded_(){
//   return GmailApiClient.ensureProfileCacheLoaded();
// }

async function ensureCountBackoffLoaded_(){
  return GmailApiClient.ensureCountBackoffLoaded();
}


// ===== Acknowledgement service =====

async function runHousekeeping_() {
  return AckService.runHousekeeping();
}


console.log('[PCA] SW loaded. Ext ID:', chrome.runtime.id);

// Clear profile cache when sign-in state changes
try {
  chrome.identity.onSignInChanged.addListener(async () => {
    await resetProfileCache_();
    console.log('[PCA] Sign-in changed: cleared profile cache');
  });
} catch {}


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
    try { await chrome.action.disable(tabId); } catch {}
  }
}

// Schedule the daily target-hour alarm
chrome.runtime.onInstalled.addListener(() => { 
  setActionIcon_(); 
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
  setActionIcon_(); 
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

    if (a.name?.startsWith('ack-deadline-')) {
  const dateKey = a.name.substring('ack-deadline-'.length);
  (async () => {
    await AckService.handleDeadlineAlarm(dateKey);
  })();
  return;
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
      } catch {}
      const match = !!profile && !!email && profile === email;
  // Update action state for this tab immediately
  try { await updateActionStateForTab_(sender.tab.id, sender.tab.url || ''); } catch {}
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

      const now = new Date();
      const deadline = getAckDeadlineFor_(dateKey);

      if (!(now < deadline)) {
        console.log(
          '[PCA] ACK ignored: past deadline for',
          dateKey,
          'deadline was',
          formatShortDateTime_(deadline)
        );
        // Still close all modals for UX
        await closeAllGmailModals_();
        sendResponse({ ok: false, reason: 'late-ack-ignored' });
        return;
      }

      const ackKey = StorageKeys.ack(dateKey);

      chrome.storage.local.set({ [ackKey]: true }, async () => {
        // Broadcast CLOSE_MODAL to all Gmail tabs using sendMessageOrInject_ for reliability
        await closeAllGmailModals_();

        // Clear pending & deadline alarm nếu still pending cho dateKey này
        const st = await chrome.storage.local.get(StorageKeys.pending);
        if (st[StorageKeys.pending] === dateKey) {
          await chrome.storage.local.remove(StorageKeys.pending);
        }

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
        // const email = await getProfileEmail_();

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
    } catch {}
  });
} catch {}

// Refresh action state when a tab is updated (URL changes, Gmail loads)
try {
  chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (!changeInfo.url && changeInfo.status !== 'complete') return;
    await updateActionStateForTab_(tabId, (changeInfo.url || tab.url || ''));
  });
} catch {}

// ===== Core logic =====
async function handleTimeCheckpoint_(force = false) {
  const now = new Date();
  const day = now.getDay();
  if (!force && (day === 0 || day === 6)) { console.log('[PCA] Weekend; skip'); return; }
  if (!force && now.getHours() < TARGET_HOUR) { console.log(`[PCA] Before target hour (${TARGET_HOUR}); skip`); return; }

  const todayKey  = getTodayKey_();
  const ackKey    = StorageKeys.ack(todayKey);
  const ignoreKey = StorageKeys.ignore(todayKey);

  const stored = await chrome.storage.local.get([ackKey, ignoreKey]);

  if (!force && stored[ackKey]) {
    console.log('[PCA] Already acknowledged today; skip');
    return;
  }
  if (!force && stored[ignoreKey]) {
    console.log('[PCA] Already ignored today; skip');
    return;
  }


  // Debug: whose token/profile?
  try {
    const info = await chrome.identity.getProfileUserInfo();
    console.log('[PCA] Token/profile email:', info.email || '(unknown)');
  } catch {}

  let count = 0;
  try {
    count = await getUntreatedCountExact_()();
  } catch (e) {
    console.warn('[PCA] exact count failed', e);
    // Fallback: use cached exact (if any) and estimate to decide modal
    
    // const email = await getProfileEmail_();
    const email = await getProfileEmail_();

    let cached = 0;
    if (email) {
      const c = await readUntreatedCountCacheForEmail_(email);
      if (typeof c === 'number') cached = c;
    }
    const estimate = await getUntreatedEstimate_().catch(() => 0);
    // Prefer cached count for display; use estimate>0 to decide
    count = cached;
    if (estimate <= 0 && cached <= 0) {
      console.log('[PCA] No _UNTREATED by estimate/cache; nothing to show');
      return;
    }
  }
  console.log('[PCA] _UNTREATED (threads exact) =', count);
  // Ensure banner reflects the latest exact count
  try { await refreshBannersOnGmailTabs_(); } catch {}

  if (count > 0) {
    const auto = !force;
    await notifyGmailTabs_(count, auto, todayKey);
    if (auto) {
      await AckService.markPending(todayKey);
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
  try { const st = await chrome.storage.local.get(TAB_EMAILS_KEY); stMap = st[TAB_EMAILS_KEY] || {}; } catch {}
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
  } catch {
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

function scheduleHourlyCount_() {
  try {
    const now = new Date();
    const next = new Date(now);
    next.setMinutes(0, 0, 0); // top of the hour
    if (next <= now) next.setHours(next.getHours() + 1);
    chrome.alarms.create('untreated-hourly', { when: next.getTime(), periodInMinutes: 60 });
    console.log('[PCA] Hourly count refresh scheduled at', next.toString());
  } catch (e) {
    console.warn('[PCA] scheduleHourlyCount failed', e);
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




// Working hours helper: true if local time within [WORK_START_HOUR, WORK_END_HOUR)
function isWithinWorkingHours_(date) {
  const h = date.getHours();
  return h >= WORK_START_HOUR && h < WORK_END_HOUR;
}



chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    const st = await chrome.storage.local.get(TAB_EMAILS_KEY);
    const map = st[TAB_EMAILS_KEY] || {};
    if (map[String(tabId)]) { delete map[String(tabId)]; await chrome.storage.local.set({ [TAB_EMAILS_KEY]: map }); }
  } catch {}
});




// Force refresh of cached exact count (used by hourly alarm)
async function refreshUntreatedCountCache_() {
  // const email = await getProfileEmail_();
  const email = await getProfileEmail_();

  if (!email) return; // no-op when profile unknown or in backoff
  const count = await getUntreatedCountExact_()().catch(async (e) => {
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
      try { txt = await res.text(); } catch {}
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
        } catch {}
        if (!retryAtMs) retryAtMs = Date.now() + 2 * 60 * 1000; // default 2 min
        countBackoffUntil = retryAtMs;
        try { await chrome.storage.local.set({ countBackoffUntil }); } catch {}
        throw new Error(`threads.list failed: 429 backoff-until ${new Date(retryAtMs).toISOString()}`);
      }
      throw new Error(`threads.list failed: ${res.status} ${txt}`);
    }
    let data = {};
    try { data = await res.json(); } catch {}
    const arr = Array.isArray(data.threads) ? data.threads : [];
    total += arr.length;
    pageToken = data.nextPageToken;
  } while (pageToken);
  return total;
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
  } catch {
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


