import { ACK_RECORDS_KEY, TAB_EMAILS_KEY } from './config.js';

// ===== Ack Records Helpers =====
// Record structure: { state: "pending"|"ack"|"ignored", shownAt: timestamp, deadlineAt: timestamp, source: "auto"|"manual" }

export async function getAckRecord(dateKey) {
  try {
    const st = await chrome.storage.local.get(ACK_RECORDS_KEY);
    const records = st[ACK_RECORDS_KEY] || {};
    return records[dateKey] || null;
  } catch (e) {
    console.error('[PCA] getAckRecord error:', e);
    return null;
  }
}

export async function setAckRecord(dateKey, record) {
  try {
    const st = await chrome.storage.local.get(ACK_RECORDS_KEY);
    const records = st[ACK_RECORDS_KEY] || {};
    records[dateKey] = record;
    await chrome.storage.local.set({ [ACK_RECORDS_KEY]: records });
  } catch (e) {
    console.error('[PCA] setAckRecord error:', e);
  }
}

export async function getAllAckRecords() {
  try {
    const st = await chrome.storage.local.get(ACK_RECORDS_KEY);
    return st[ACK_RECORDS_KEY] || {};
  } catch (e) {
    console.error('[PCA] getAllAckRecords error:', e);
    return {};
  }
}

export async function setAllAckRecords(records) {
  try {
    await chrome.storage.local.set({ [ACK_RECORDS_KEY]: records });
  } catch (e) {
    console.error('[PCA] setAllAckRecords error:', e);
  }
}

// ===== Tab Emails Helpers =====

export async function getTabEmailsMap() {
  try {
    const st = await chrome.storage.local.get(TAB_EMAILS_KEY);
    return st[TAB_EMAILS_KEY] || {};
  } catch (e) {
    console.error('[PCA] getTabEmailsMap error:', e);
    return {};
  }
}

export async function setTabEmail(tabId, email) {
  try {
    const st = await chrome.storage.local.get(TAB_EMAILS_KEY);
    const map = st[TAB_EMAILS_KEY] || {};
    map[String(tabId)] = email;
    await chrome.storage.local.set({ [TAB_EMAILS_KEY]: map });
  } catch (e) {
    console.error('[PCA] setTabEmail error:', e);
  }
}

export async function removeTabEmail(tabId) {
  try {
    const st = await chrome.storage.local.get(TAB_EMAILS_KEY);
    const map = st[TAB_EMAILS_KEY] || {};
    if (map[String(tabId)]) {
      delete map[String(tabId)];
      await chrome.storage.local.set({ [TAB_EMAILS_KEY]: map });
    }
  } catch (e) {
    console.error('[PCA] removeTabEmail error:', e);
  }
}

// ===== Count Cache Helpers =====

export async function readUntreatedCountCache(profile) {
  try {
    const st = await chrome.storage.local.get('untreatedCountCache');
    const cache = st.untreatedCountCache || {};
    const entry = cache[profile];
    if (!entry) return null;
    return typeof entry.count === 'number' ? entry.count : null;
  } catch (e) {
    console.error('[PCA] readUntreatedCountCache error:', e);
    return null;
  }
}

export async function writeUntreatedCountCache(profile, count) {
  try {
    const st = await chrome.storage.local.get('untreatedCountCache');
    const cache = st.untreatedCountCache || {};
    cache[profile] = { count, ts: Date.now() };
    await chrome.storage.local.set({ untreatedCountCache: cache });
  } catch (e) {
    console.warn('[PCA] writeUntreatedCountCache failed', e);
  }
}
