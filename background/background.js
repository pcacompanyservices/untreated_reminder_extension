import { TARGET_HOUR, TAB_EMAILS_KEY, ACK_RECORDS_KEY, CLEANUP_DAYS } from './config.js';
import { getTodayKey, isWeekend, isWithinWorkingHours, formatShortDateTime, getAckDeadlineFor } from './utils.js';
import { getAckRecord, setAckRecord, getAllAckRecords, setAllAckRecords, setTabEmail, removeTabEmail, readUntreatedCountCache } from './storage.js';
import { getProfileEmail, getUntreatedCount, getUntreatedEstimate, ensureTokenInteractive, clearProfileCache, refreshUntreatedCountCache, triageMailboxToUNTREATED } from './gmail-api.js';
import { scheduleNextAlarm, scheduleHourlyCount, scheduleAckDeadlineAlarm, clearAckDeadlineAlarm } from './alarm-handlers.js';
import { getMatchedGmailTabs, notifyGmailTabs, refreshBannersOnGmailTabs, closeAllGmailModals, updateActionStateForTab, sendMessageOrInject } from './tab-manager.js';

console.log('[PCA] SW loaded. Ext ID:', chrome.runtime.id);

// ===== Shared Helper: Triage + Count + Banner =====

/**
 * Run triage, refresh count cache, and update banners
 * @param {Object} opts - Options
 * @param {boolean} opts.triage - Whether to run triage (default: true)
 * @param {boolean} opts.refreshCount - Whether to refresh count cache (default: true)
 * @param {boolean} opts.refreshBanners - Whether to refresh banners (default: true)
 * @param {string} opts.source - Log source identifier
 * @returns {Promise<{triaged: {labeled: number, cleaned: number}, count: number}>}
 */
async function runTriageAndRefresh(opts = {}) {
  const { triage = true, refreshCount = true, refreshBanners = true, source = 'unknown', profile = null } = opts;
  
  let triageResult = { labeled: 0, cleaned: 0 };
  let count = 0;
  if (!profile) {
    console.log('[PCA] Skipped triage/count/banner: no profile email');
    return ;
  }
  // 1) Triage: label unread/unlabeled emails as _UNTREATED
  if (triage) {
    triageResult = await triageMailboxToUNTREATED().catch(e => {
      console.warn(`[PCA] ${source} triage failed:`, e);
      return { labeled: 0, cleaned: 0 };
    });
    if (triageResult.labeled > 0 || triageResult.cleaned > 0) {
      console.log(`[PCA] ${source} triage: labeled=${triageResult.labeled}, cleaned=${triageResult.cleaned}`);
    }
  }
  
  // 2) Refresh count cache
  if (refreshCount) {
    count = await refreshUntreatedCountCache(profile);
    
  }
  
  // 3) Update banners on Gmail tabs
  if (refreshBanners) {
    await refreshBannersOnGmailTabs(profile).catch(e => {
      console.warn(`[PCA] ${source} refresh banners failed:`, e);
    });
  }
  
  return { triaged: triageResult, count };
}

// ===== Sign-in Change Handler =====
try {
  chrome.identity.onSignInChanged.addListener(async () => {
    clearProfileCache();
    try {
      await chrome.storage.local.remove(['profileEmailCache', 'profileBackoffUntil', 'untreatedCountCache', 'countBackoffUntil']);
    } catch (e) {
      console.error('[PCA] onSignInChanged storage remove error:', e);
    }
    console.log('[PCA] Sign-in changed: cleared profile cache');
  });
} catch (e) {
  console.error('[PCA] onSignInChanged addListener error:', e);
}

// ===== Lifecycle =====

/**
 * Common initialization for install/startup
 */
async function initializeExtension(source, profile) {
  scheduleNextAlarm();
  scheduleHourlyCount();
  runHousekeeping(profile)
  
  const now = new Date();
  if (!isWeekend(now) && isWithinWorkingHours(now)) {
    await runTriageAndRefresh({ source, refreshBanners: true, triage: true, refreshCount: true, profile });
  }
}

// On install or update
chrome.runtime.onInstalled.addListener(async () => {
  const profile = await getProfileEmail();
  if (!profile) {
    console.log('[PCA] onInstalled skipped: no profile email');
    return;
  }
  initializeExtension('onInstalled', profile).catch(e => {
    console.error('[PCA] onInstalled error:', e);
  });
  console.log('[PCA] onInstalled completed for profile:', profile);
});

// On browser startup
chrome.runtime.onStartup.addListener(async () => {
  const profile = await getProfileEmail();
  if (!profile) {
    console.log('[PCA] onStartup skipped: no profile email');
    return;
  }
  initializeExtension('onStartup', profile).catch(e => {
    console.error('[PCA] onStartup error:', e);
  });
  console.log('[PCA] onStartup completed for profile:', profile);
});

// ===== Alarms =====
chrome.alarms.onAlarm.addListener(async (a) => {
  const profile = await getProfileEmail();
  if (!profile) {
    console.log('[PCA] onAlarm skipped: no profile email');
    return;
  }
  if (a.name === 'daily-ack') {
    console.log('[PCA] Alarm fired at', new Date().toString());
    handleTimeCheckpoint(profile);
    scheduleNextAlarm();
    return;
  }
  
  if (a.name === 'untreated-hourly') {
    (async () => {
      const now = new Date();
      if (isWeekend(now) || !isWithinWorkingHours(now)) return;
      
      await runTriageAndRefresh({ source: 'untreated-hourly', profile });
    })();
    return;
  }
  
  if (a.name?.startsWith('ack-deadline-')) {
    handleAckDeadlineAlarm(a.name, profile);
  }
});


// ===== Toolbar Action =====
chrome.action.onClicked.addListener(async () => {
  console.log('[PCA] Action clicked');
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  
  if (!activeTab?.url?.startsWith('https://mail.google.com/')) {
    console.warn('[PCA] Action clicked outside Gmail, ignoring');
    return;
  }
  const profile = await getProfileEmail();
  if (!profile) {
    console.warn('[PCA] No profile email, abort action');
    return;
  }
  try {
    const st = await chrome.storage.local.get(TAB_EMAILS_KEY);
    const map = st[TAB_EMAILS_KEY] || {};
    const tabEmail = map[String(activeTab.id)];
    console.log('[PCA] Action context profile=', profile || '(null)', 'tabEmail=', tabEmail || '(none)');
    const match = !!profile && !!tabEmail && tabEmail === profile;
    if (!match) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: activeTab.id },
          func: () => alert('This tool only works on the authorized internal mailbox for this Chrome profile.')
        });
      } catch (e) { console.warn('[PCA] alert inject failed', e); }
      return;
    }
  } catch (e) {
    console.error('[PCA] Action context email check error:', e);
    return;
  }
  await ensureTokenInteractive();
  await handleTimeCheckpoint(profile, true);
  
});

// ===== Messages =====
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'MAILBOX_EMAIL' && sender.tab?.id != null) {
    getProfileEmail().then(profile => {
      handleMailboxEmailMessage(msg, sender, profile).then(sendResponse);
    });
    return true;
  }
  
  if (msg?.type === 'CHECK_AND_MAYBE_SHOW') {
    getProfileEmail().then(profile => {
      handleTimeCheckpoint(profile, false)
        .then(() => sendResponse({ ok: true }))
        .catch(e => { console.error('[PCA] check error', e); sendResponse({ ok: false, err: String(e) }); });
    });
    return true;
  }
  
  if (msg?.type === 'CLOSE_ALL_MODALS') {
    getProfileEmail().then(profile => {
      closeAllGmailModals(profile).then(() => sendResponse({ ok: true }));
    });
    return true;
  }
  
  if (msg?.type === 'ACK_DATE') {
    getProfileEmail().then(profile => {
      handleAckDateMessage(profile, msg).then(sendResponse);
    });
    return true;
  }
  
  if (msg?.type === 'GET_UNTREATED_COUNT') {
    getProfileEmail().then(profile => {
      handleGetUntreatedCountMessage(profile).then(sendResponse);
    });
    return true;
  }
});

// ===== Tab Events =====
try {
  chrome.tabs.onActivated.addListener(async ({ tabId }) => {
    try {
      const tab = await chrome.tabs.get(tabId);
      await updateActionStateForTab(tabId, tab.url || '');
    } catch (e) {
      console.error('[PCA] onActivated updateActionStateForTab error:', e);
    }
  });
} catch (e) {
  console.error('[PCA] onActivated addListener error:', e);
}

try {
  chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (!changeInfo.url && changeInfo.status !== 'complete') return;
    await updateActionStateForTab(tabId, (changeInfo.url || tab.url || ''));
  });
} catch (e) {
  console.error('[PCA] onUpdated addListener error:', e);
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await removeTabEmail(tabId);
});

/**
 * Handle MAILBOX_EMAIL message
 */
async function handleMailboxEmailMessage(msg, sender, profile) {
  const email = (msg.email || '').toLowerCase();
  
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
  
  try {
    await updateActionStateForTab(sender.tab.id, sender.tab.url || '');
  } catch (e) {
    console.error('[PCA] MAILBOX_EMAIL updateActionStateForTab error:', e);
  }
  
  return { ok: true, match, profile };
}

/**
 * Handle ACK_DATE message
 */
async function handleAckDateMessage(profile, msg) {
  const todayKey = getTodayKey();
  const dateKey = msg.dateKey || todayKey;
  const now = new Date();
  
  const record = await getAckRecord(dateKey);
  if (!record) {
    console.log('[PCA] ACK ignored: no record for', dateKey);
    await closeAllGmailModals(profile);
    return { ok: false, reason: 'no-record' };
  }
  
  if (now.getTime() >= record.deadlineAt) {
    console.log('[PCA] ACK ignored: past deadline for', dateKey, 'deadline was', formatShortDateTime(new Date(record.deadlineAt)));
    await closeAllGmailModals(profile);
    return { ok: false, reason: 'late-ack-ignored' };
  }
  
  record.state = 'ack';
  await setAckRecord(dateKey, record);
  await closeAllGmailModals(profile);
  await clearAckDeadlineAlarm(dateKey);
  console.log('[PCA] ACK recorded for', dateKey);
  return { ok: true };
}

/**
 * Handle GET_UNTREATED_COUNT message
 */
async function handleGetUntreatedCountMessage(profile) {
  try {
    let count = 0;
    if (profile) {
      const cached = await readUntreatedCountCache(profile);
      if (typeof cached === 'number') count = cached;
    }
    return { ok: true, count };
  } catch (e) {
    console.warn('[PCA] GET_UNTREATED_COUNT failed', e);
    return { ok: false, err: String(e) };
  }
}


/**
 * Handle ack deadline alarm
 */
async function handleAckDeadlineAlarm(alarmName, profile) {
  const dateKey = alarmName.substring('ack-deadline-'.length);
  
  console.log('[PCA] Deadline reached for', dateKey, 'at', formatShortDateTime(new Date()));
  const record = await getAckRecord(dateKey);
  
  if (!record) {
    console.log('[PCA] No record for deadline', dateKey);
    return;
  }
  
  if (record.state === 'ack') {
    console.log('[PCA] Already acked, deadline cleanup for', dateKey);
    await clearAckDeadlineAlarm(dateKey);
    return;
  }
  
  if (record.state === 'pending') {
    record.state = 'ignored';
    await setAckRecord(dateKey, record);
    await closeAllGmailModals(profile);
    console.log('[PCA] Missed acknowledgement marked for', dateKey);
  }
}


// ===== Core Logic =====

/**
 * Main checkpoint handler - runs at TARGET_HOUR or on manual trigger
 * @param {boolean} force - Skip time/weekend checks
 */
async function handleTimeCheckpoint(profile, force = false) {
  const now = new Date();
  
  // Time-based guards (skip on weekends and before TARGET_HOUR unless forced)
  if (!force) {
    if (isWeekend(now)) {
      console.log('[PCA] Weekend; skip');
      return;
    }
    if (now.getHours() < TARGET_HOUR) {
      console.log(`[PCA] Before target hour (${TARGET_HOUR}); skip`);
      return;
    }
  }

  const todayKey = getTodayKey();
  const record = await getAckRecord(todayKey);
  
  // State-based guards (skip if already handled unless forced)
  if (!force && record) {
    if (record.state === 'ack') {
      console.log('[PCA] Already acknowledged today; skip');
      return;
    }
    if (record.state === 'ignored') {
      console.log('[PCA] Already marked ignored today; skip');
      return;
    }
    if (record.state === 'pending' && now.getTime() < record.deadlineAt) {
      console.log('[PCA] Modal already shown today, waiting for ACK or deadline; skip');
      return;
    }
  }

  // Debug: log profile info
  try {
    const info = await chrome.identity.getProfileUserInfo();
    console.log('[PCA] Token/profile email:', info.email || '(unknown)');
  } catch {}

  // Run triage + refresh count + refresh banners
  const { count } = await runTriageAndRefresh({ source: 'checkpoint', profile });
  
  // Fallback: if triage/count failed, try estimate
  let finalCount = count;
  if (finalCount <= 0) {
    try {
      finalCount = await getUntreatedCount({ exact: true, profile });
    } catch (e) {
      console.warn('[PCA] exact count failed', e);
      const estimate = await getUntreatedEstimate().catch(() => 0);
      if (estimate <= 0) {
        console.log('[PCA] No _UNTREATED by estimate; nothing to show');
        return;
      }
      finalCount = estimate;
    }
  }
  
  console.log('[PCA] _UNTREATED count =', finalCount);

  if (finalCount > 0) {
    const source = force ? 'manual' : 'auto';
    const deadline = getAckDeadlineFor(todayKey);
    
    await setAckRecord(todayKey, {
      state: 'pending',
      shownAt: now.getTime(),
      deadlineAt: deadline.getTime(),
      source
    });
    
    await notifyGmailTabs(profile, finalCount, !force, todayKey);
    
    if (!force) {
      console.log('[PCA] Pending set for', todayKey, 'deadline at', formatShortDateTime(deadline));
      await scheduleAckDeadlineAlarm(todayKey);
    }
  } else {
    console.log('[PCA] No _UNTREATED threads; nothing to show');
  }
}

// ===== Housekeeping =====
async function runHousekeeping(profile) {
  const records = await getAllAckRecords();
  const now = Date.now();
  const daysAgo = now - CLEANUP_DAYS * 24 * 60 * 60 * 1000;
  let cleaned = 0;
  let updated = false;
  
  for (const [dateKey, record] of Object.entries(records)) {
    // Cleanup old records
    if (record.shownAt < daysAgo) {
      delete records[dateKey];
      cleaned++;
      try { await chrome.alarms.clear(`ack-deadline-${dateKey}`); } catch (e) {
        console.error('[PCA] runHousekeeping clear old alarm error:', e);
      }
      updated = true;
      continue;
    }
    
    // Handle pending records that passed deadline
    if (record.state === 'pending' && now >= record.deadlineAt) {
      record.state = 'ignored';
      records[dateKey] = record;
      updated = true;
      await closeAllGmailModals(profile);
      console.log('[PCA] Housekeeping marked missed acknowledgement for', dateKey);
    }
    
    // Ensure pending records have their alarm scheduled
    if (record.state === 'pending' && now < record.deadlineAt) {
      await scheduleAckDeadlineAlarm(dateKey);
    }
  }
  
  if (updated) {
    await setAllAckRecords(records);
  }
  
  if (cleaned > 0) {
    console.log('[PCA] Housekeeping cleaned', cleaned, 'old records');
  }
  
  // Migrate legacy keys
  await migrateLegacyAckKeys();
}

async function migrateLegacyAckKeys() {
  try {
    const st = await chrome.storage.local.get(null);
    const records = st[ACK_RECORDS_KEY] || {};
    const toRemove = [];
    let migrated = 0;
    
    const pendingDateKey = st['pending-ack-date'];
    if (pendingDateKey && !records[pendingDateKey]) {
      const deadline = getAckDeadlineFor(pendingDateKey);
      records[pendingDateKey] = {
        state: 'pending',
        shownAt: Date.now(),
        deadlineAt: deadline.getTime(),
        source: 'auto'
      };
      migrated++;
      toRemove.push('pending-ack-date');
    }
    
    for (const key of Object.keys(st)) {
      if (key.startsWith('ack-') && key !== ACK_RECORDS_KEY) {
        const dateKey = key.substring(4);
        if (/^\d{8}$/.test(dateKey) && !records[dateKey]) {
          const deadline = getAckDeadlineFor(dateKey);
          records[dateKey] = {
            state: 'ack',
            shownAt: Date.now(),
            deadlineAt: deadline.getTime(),
            source: 'auto'
          };
          migrated++;
          toRemove.push(key);
        }
      } else if (key.startsWith('ignore-')) {
        const dateKey = key.substring(7);
        if (/^\d{8}$/.test(dateKey) && !records[dateKey]) {
          const deadline = getAckDeadlineFor(dateKey);
          records[dateKey] = {
            state: 'ignored',
            shownAt: Date.now(),
            deadlineAt: deadline.getTime(),
            source: 'auto'
          };
          migrated++;
          toRemove.push(key);
        }
      }
    }
    
    if (migrated > 0) {
      await chrome.storage.local.set({ [ACK_RECORDS_KEY]: records });
      await chrome.storage.local.remove(toRemove);
      console.log('[PCA] Migrated', migrated, 'legacy ack/ignore keys');
    }
  } catch (e) {
    console.error('[PCA] migrateLegacyAckKeys error:', e);
  }
}
