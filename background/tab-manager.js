import { GMAIL_URL_MATCH, TAB_EMAILS_KEY } from './config.js';
import { getTabEmailsMap } from './storage.js';
import { getProfileEmail } from './gmail-api.js';
import { isGmailUrl } from './utils.js';

// ===== Tab Matching =====

export async function getMatchedGmailTabs(profile) {
  const tabs = await chrome.tabs.query({ url: GMAIL_URL_MATCH });
  const map = await getTabEmailsMap();
  const matchedTabs = [];
  let skipped = 0;
  
  for (const tab of tabs) {
    const tabEmail = map[String(tab.id)];
    if (!profile || !tabEmail || tabEmail !== profile) {
      skipped++;
      continue;
    }
    matchedTabs.push(tab);
  }
  
  return { matchedTabs, skipped };
}

// ===== Messaging =====

export async function sendMessageOrInject(tabId, message) {
  // 1) First attempt
  if (await trySend(tabId, message)) return true;

  // 2) Inject content.js then retry
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch (e) {
    console.warn('[PCA] Injection failed for tab', tabId, e);
  }
  return await trySend(tabId, message);
}

function trySend(tabId, message) {
  return new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, message, () => {
      if (chrome.runtime.lastError) {
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}

// ===== Notifications =====

export async function notifyGmailTabs(profile, count, auto, dateKey) {
  const { matchedTabs, skipped } = await getMatchedGmailTabs(profile);
  let matched = 0;
  
  for (const tab of matchedTabs) {
    const ok = await sendMessageOrInject(tab.id, { type: 'SHOW_MODAL', count, auto, dateKey });
    if (!ok) {
      console.warn('[PCA] Could not contact tab', tab.id);
    } else {
      matched++;
    }
  }
  console.log(`[PCA] Notified tabs matched=${matched} skipped=${skipped}`);
}

export async function refreshBannersOnGmailTabs(profile) {
  const tabs = await chrome.tabs.query({ url: GMAIL_URL_MATCH });
  const map = await getTabEmailsMap();
  let matched = 0;
  
  for (const tab of tabs) {
    const tabEmail = map[String(tab.id)];
    if (!profile || !tabEmail || tabEmail !== profile) continue;
    const ok = await sendMessageOrInject(tab.id, { type: 'REFRESH_BANNER' });
    if (ok) matched++;
  }
  
  if (matched) {
    console.log(`[PCA] Banner refresh requested on ${matched} tab(s)`);
  }
}

export async function closeAllGmailModals(profile) {
  const { matchedTabs } = await getMatchedGmailTabs(profile);
  for (const tab of matchedTabs) {
    await sendMessageOrInject(tab.id, { type: 'CLOSE_MODAL' });
  }
}

/**
 * Show loading modal on all matched Gmail tabs
 * @param {string} profile - Profile email to match
 * @returns {Promise<number>} Number of tabs notified
 */
export async function showLoadingModalOnGmailTabs(profile) {
  const { matchedTabs } = await getMatchedGmailTabs(profile);
  let count = 0;
  
  for (const tab of matchedTabs) {
    try {
      const ok = await sendMessageOrInject(tab.id, { type: 'SHOW_LOADING_MODAL' });
      if (ok) count++;
    } catch (e) {
      console.warn('[PCA] showLoadingModal failed for tab', tab.id, e);
    }
  }
  
  console.log('[PCA] Showed loading modal on', count, 'Gmail tabs');
  return count;
}

// ===== Action State =====

export async function updateActionStateForTab(tabId, url) {
  try {
    if (!isGmailUrl(url)) {
      await chrome.action.disable(tabId);
      await chrome.action.setTitle({ tabId, title: 'Inactive: open your authorized Gmail mailbox' });
      return;
    }
    
    const profile = await getProfileEmail();
    const st = await chrome.storage.local.get(TAB_EMAILS_KEY);
    const map = st[TAB_EMAILS_KEY] || {};
    const tabEmail = map[String(tabId)];
    const match = !!profile && !!tabEmail && profile === tabEmail;
    
    await chrome.action.enable(tabId);
    await chrome.action.setTitle({
      tabId,
      title: match ? 'PCA Untreated Reminder – Force check' : 'Mailbox does not match this Chrome profile'
    });
  } catch (e) {
    console.error('[PCA] updateActionStateForTab error:', e);
    try { await chrome.action.disable(tabId); } catch (disableErr) {
      console.error('[PCA] updateActionStateForTab disable fallback error:', disableErr);
    }
  }
}
