// ===== Settings =====
const LABEL_NAME = '_UNTREATED';
const TARGET_HOUR = 16; // 4pm local time
const ACK_KEY_PREFIX = 'ack-'; // ack-YYYYMMDD

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

// Schedule the daily 4pm alarm
chrome.runtime.onInstalled.addListener(() => { setActionIcon_(); scheduleNextAlarm_(); });
chrome.runtime.onStartup.addListener(() => { setActionIcon_(); scheduleNextAlarm_(); });
chrome.alarms.onAlarm.addListener(a => {
  if (a.name === 'daily-ack') {
  console.log('[PCA] Alarm fired at', new Date().toString());
    handleTimeCheckpoint_();
    scheduleNextAlarm_();
  }
});

// Toolbar icon: force a check (and guarantee consent UI)
chrome.action.onClicked.addListener(async () => {
  console.log('[PCA] Action clicked: forcing check');
  await ensureTokenInteractive_(); // shows consent if needed
  handleTimeCheckpoint_(/*force=*/true);
});

// From content script (on page load after 4pm)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'CHECK_AND_MAYBE_SHOW') {
    handleTimeCheckpoint_()
      .then(() => sendResponse({ ok: true }))
      .catch(e => { console.error('[PCA] check error', e); sendResponse({ ok: false, err: String(e) }); });
    return true; // async
  }
  if (msg?.type === 'CLOSE_ALL_MODALS') {
    (async () => {
      const tabs = await chrome.tabs.query({ url: 'https://mail.google.com/*' });
      for (const tab of tabs) {
        await sendMessageOrInject_(tab.id, { type: 'CLOSE_MODAL' });
      }
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (msg?.type === 'ACK_TODAY') {
    const todayKey = getTodayKey_();
    const ackKey = `${ACK_KEY_PREFIX}${todayKey}`;
    chrome.storage.local.set({ [ackKey]: true }, async () => {
      // Broadcast CLOSE_MODAL to all Gmail tabs using sendMessageOrInject_ for reliability
      const tabs = await chrome.tabs.query({ url: 'https://mail.google.com/*' });
      for (const tab of tabs) {
        await sendMessageOrInject_(tab.id, { type: 'CLOSE_MODAL' });
      }
      sendResponse({ ok: true });
    });
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
  const stored = await chrome.storage.local.get(ackKey);
  if (!force && stored[ackKey]) { console.log('[PCA] Already acknowledged today; skip'); return; }

  // Debug: whose token/profile?
  try {
    const info = await chrome.identity.getProfileUserInfo();
    console.log('[PCA] Token/profile email:', info.email || '(unknown)');
  } catch {}

  const count = await getUntreatedCount_().catch(e => { console.error('[PCA] count failed', e); return 0; });
  console.log('[PCA] _UNTREATED (threads overdue >24h) =', count);

  if (count > 0) {
    await notifyGmailTabs_(count, !force);
  } else {
    console.log('[PCA] No untreated overdue >24h; nothing to show');
  }
}

async function notifyGmailTabs_(count, auto) {
  const tabs = await chrome.tabs.query({ url: 'https://mail.google.com/*' });
  console.log('[PCA] Notifying tabs:', tabs.length);
  for (const tab of tabs) {
    const ok = await sendMessageOrInject_(tab.id, { type: 'SHOW_MODAL', count, auto });
    if (!ok) console.warn('[PCA] Could not contact tab', tab.id);
  }
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
  chrome.alarms.create('daily-ack', { when: when.getTime() });
  console.log('[PCA] Next alarm scheduled at', when.toString());
}

function getTodayKey_() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
}

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