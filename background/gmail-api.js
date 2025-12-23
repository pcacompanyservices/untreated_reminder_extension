import { LABEL_NAME, TRIAGE_SCAN_DAYS, TRIAGE_MAX_THREADS } from './config.js';
import { readUntreatedCountCache, writeUntreatedCountCache } from './storage.js';

// ===== State =====
let cachedProfileEmail = null;
let profileFetchAttempted = false;
let profileFetchPromise = null;
let profileBackoffUntil = 0;
let profileCacheLoaded = false;
let countBackoffUntil = 0;
let countBackoffLoaded = false;
let untreatedCountInFlight = null;
let cachedLabelId = null; // Cache _UNTREATED label ID

// ===== Backoff Loading =====

async function ensureCountBackoffLoaded() {
  if (countBackoffLoaded) return;
  try {
    const st = await chrome.storage.local.get(['countBackoffUntil']);
    if (typeof st.countBackoffUntil === 'number') countBackoffUntil = st.countBackoffUntil;
  } catch (e) {
    console.error('[PCA] ensureCountBackoffLoaded error:', e);
  }
  countBackoffLoaded = true;
}

// ===== OAuth Helpers =====

export function getToken() {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: false }, token => {
      if (chrome.runtime.lastError || !token) {
        reject(chrome.runtime.lastError || new Error('No token'));
      } else {
        resolve(token);
      }
    });
  });
}

export async function ensureTokenInteractive() {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, token => {
      if (chrome.runtime.lastError || !token) {
        reject(chrome.runtime.lastError || new Error('No token'));
      } else {
        resolve(token);
      }
    });
  });
}

// ===== Profile Email =====

export async function getProfileEmail() {
  // Load cache from storage once (survives SW restarts)
  if (!profileCacheLoaded) {
    try {
      const st = await chrome.storage.local.get(['profileEmailCache', 'profileBackoffUntil']);
      if (typeof st.profileBackoffUntil === 'number') profileBackoffUntil = st.profileBackoffUntil;
      if (typeof st.profileEmailCache === 'string' && st.profileEmailCache) {
        cachedProfileEmail = st.profileEmailCache.toLowerCase();
      }
    } catch (e) {
      console.error('[PCA] getProfileEmail cache load error:', e);
    }
    profileCacheLoaded = true;
  }

  if (cachedProfileEmail) return cachedProfileEmail;
  if (Date.now() < profileBackoffUntil) return null;
  if (profileFetchPromise) return profileFetchPromise;

  profileFetchPromise = (async () => {
    try {
      const token = await getToken();
      const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile?fields=emailAddress', {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (res.ok) {
        let data = {};
        try { data = await res.json(); } catch (e) {
          console.error('[PCA] getProfileEmail json parse error:', e);
        }
        cachedProfileEmail = (data && data.emailAddress) ? String(data.emailAddress).toLowerCase() : null;
        try { await chrome.storage.local.set({ profileEmailCache: cachedProfileEmail || '' }); } catch (e) {
          console.error('[PCA] getProfileEmail cache write error:', e);
        }
        if (!profileFetchAttempted) {
          console.log('[PCA] Profile email resolved:', cachedProfileEmail || '(null)');
        }
        return cachedProfileEmail;
      }

      // Handle 429 backoff
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
            const m = bodyText.match(/Retry after\s+([0-9T:\-.Z+]+)/i);
            if (m && m[1]) {
              const t = Date.parse(m[1]);
              if (!Number.isNaN(t)) retryAtMs = t;
            }
            if (!retryAtMs && bodyText.trim()) console.warn('[PCA] profile 429 body:', bodyText);
          } catch (e) {
            console.error('[PCA] getProfileEmail 429 body parse error:', e);
          }
        }
        if (!retryAtMs) retryAtMs = Date.now() + 2 * 60 * 1000;
        profileBackoffUntil = retryAtMs;
        try { await chrome.storage.local.set({ profileBackoffUntil }); } catch (e) {
          console.error('[PCA] getProfileEmail backoff storage error:', e);
        }
        if (!profileFetchAttempted) console.warn('[PCA] profile fetch 429; backoff until', new Date(profileBackoffUntil).toISOString());
        return null;
      }

      // Other non-OK statuses
      if (!profileFetchAttempted) {
        let txt = '';
        try { txt = await res.text(); } catch (e) {
          console.error('[PCA] getProfileEmail error text parse error:', e);
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


export function clearProfileCache() {
  cachedProfileEmail = null;
  profileFetchAttempted = false;
  profileFetchPromise = null;
  profileBackoffUntil = 0;
}

// ===== Untreated Count =====

export async function getUntreatedCount(opts = {}) {
  const { exact = false, useCache = true, profile } = opts;
  

  // Try cache first when allowed
  if (useCache) {
    const cached = await readUntreatedCountCache(profile);
    if (cached != null && !exact) return cached;
  }

  // If an exact computation is already in-flight, share it
  if (untreatedCountInFlight) {
    try {
      const res = await untreatedCountInFlight;
      if (res && res.profile === profile) return res.count;
    } catch (e) {
      console.error('[PCA] getUntreatedCount untreatedCountInFlight error:', e);
    }
  }

  // Compute exact count now
  untreatedCountInFlight = (async () => {
    const count = await getExactUntreatedCountFromApi();
    await writeUntreatedCountCache(profile, count).catch((e) => {
      console.error('[PCA] getUntreatedCount writeUntreatedCountCache error:', e);
    });
    return { profile, count };
  })();

  try {
    const res = await untreatedCountInFlight;
    return res.count;
  } finally {
    untreatedCountInFlight = null;
  }
}

export async function refreshUntreatedCountCache(profile) {
  let count;

  try {
    count = await getUntreatedCount({
      exact: true,
      useCache: false,
      profile
    });
  } catch (e) {
    console.warn('[PCA] refresh cache skipped (exact failed)', e);
    const c = await readUntreatedCountCache(profile);
    count = typeof c === 'number' ? c : 0;
  }

  if (typeof count === 'number') {
    await writeUntreatedCountCache(profile, count);
  }

  console.log('[PCA] Exact _UNTREATED count cached for', profile, '=', count);
  return count;
}

async function getExactUntreatedCountFromApi() {
  await ensureCountBackoffLoaded();
  if (Date.now() < countBackoffUntil) {
    throw new Error(`count-backoff-active-until:${new Date(countBackoffUntil).toISOString()}`);
  }
  const token = await getToken();
  let total = 0;
  let pageToken;
  do {
    const params = new URLSearchParams({ maxResults: '500', q: `label:${LABEL_NAME} -in:trash -in:spam` });
    if (pageToken) params.set('pageToken', pageToken);
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/threads?${params.toString()}&fields=nextPageToken,threads/id`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      let txt = '';
      try { txt = await res.text(); } catch (e) {
        console.error('[PCA] getExactUntreatedCountFromApi error text parse error:', e);
      }
      if (res.status === 429) {
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
          console.error('[PCA] getExactUntreatedCountFromApi retry parse error:', e);
        }
        if (!retryAtMs) retryAtMs = Date.now() + 2 * 60 * 1000;
        countBackoffUntil = retryAtMs;
        try { await chrome.storage.local.set({ countBackoffUntil }); } catch (e) {
          console.error('[PCA] getExactUntreatedCountFromApi countBackoffUntil storage error:', e);
        }
        throw new Error(`threads.list failed: 429 backoff-until ${new Date(retryAtMs).toISOString()}`);
      }
      throw new Error(`threads.list failed: ${res.status} ${txt}`);
    }
    let data = {};
    try { data = await res.json(); } catch (e) {
      console.error('[PCA] getExactUntreatedCountFromApi json response parse error:', e);
    }
    const arr = Array.isArray(data.threads) ? data.threads : [];
    total += arr.length;
    pageToken = data.nextPageToken;
  } while (pageToken);
  return total;
}

export async function getUntreatedEstimate() {
  const token = await getToken();
  const params = new URLSearchParams({ maxResults: '1', q: `label:${LABEL_NAME} -in:trash -in:spam` });
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/threads?${params.toString()}&fields=resultSizeEstimate`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return 0;
  try {
    const data = await res.json();
    return Number(data.resultSizeEstimate) || 0;
  } catch (e) {
    console.error('[PCA] getUntreatedEstimate error:', e);
    return 0;
  }
}

// ===== Triage: Label Emails as _UNTREATED =====

/**
 * Get or create _UNTREATED label, returns label ID
 */
async function getOrCreateUntreatedLabelId() {
  if (cachedLabelId) return cachedLabelId;
  
  const token = await getToken();
  
  // List all labels to find _UNTREATED
  const listRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/labels', {
    headers: { Authorization: `Bearer ${token}` }
  });
  
  if (listRes.ok) {
    try {
      const data = await listRes.json();
      const existing = (data.labels || []).find(l => l.name === LABEL_NAME);
      if (existing) {
        cachedLabelId = existing.id;
        return cachedLabelId;
      }
    } catch (e) {
      console.warn('[PCA] getOrCreateUntreatedLabelId list parse error:', e);
    }
  }
  
  // Create label if not exists
  const createRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/labels', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: LABEL_NAME,
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show'
    })
  });
  
  if (createRes.ok) {
    try {
      const created = await createRes.json();
      cachedLabelId = created.id;
      console.log('[PCA] Created label', LABEL_NAME, 'with ID', cachedLabelId);
      return cachedLabelId;
    } catch (e) {
      console.warn('[PCA] getOrCreateUntreatedLabelId create parse error:', e);
    }
  }
  
  throw new Error(`Failed to get/create label ${LABEL_NAME}`);
}

/**
 * Search threads by query with pagination, returns array of thread IDs
 */
async function searchThreadIds(query, maxResults = TRIAGE_MAX_THREADS) {
  const token = await getToken();
  const threadIds = [];
  let pageToken;
  
  do {
    const params = new URLSearchParams({
      maxResults: String(Math.min(100, maxResults - threadIds.length)),
      q: query
    });
    if (pageToken) params.set('pageToken', pageToken);
    
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/threads?${params.toString()}&fields=nextPageToken,threads/id`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      console.warn('[PCA] searchThreadIds failed:', res.status, txt);
      break;
    }
    
    // Get response text first to check if empty
    const text = await res.text().catch(() => '');
    if (!text || !text.trim()) {
      // Empty response = no results
      break;
    }
    
    let data = {};
    try {
      data = JSON.parse(text);
    } catch (e) {
      console.warn('[PCA] searchThreadIds parse error:', e, 'text:', text.substring(0, 100));
      break;
    }
    
    const threads = data.threads || [];
    if (threads.length === 0) break; // No more results
    
    for (const t of threads) {
      threadIds.push(t.id);
      if (threadIds.length >= maxResults) break;
    }
    
    pageToken = data.nextPageToken;
  } while (pageToken && threadIds.length < maxResults);
  
  return threadIds;
}

/**
 * Add label to a single thread
 */
async function addLabelToThread(threadId, labelId) {
  const token = await getToken();
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}/modify`;
  
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ addLabelIds: [labelId] })
  });
  
  return res.ok;
}

/**
 * Remove label from a single thread
 */
async function removeLabelFromThread(threadId, labelId) {
  const token = await getToken();
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}/modify`;
  
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ removeLabelIds: [labelId] })
  });
  
  return res.ok;
}

/**
 * Get thread details (labels, messages)
 */
async function getThreadDetails(threadId) {
  const token = await getToken();
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=metadata&metadataHeaders=From`;
  
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  
  try {
    return await res.json();
  } catch (e) {
    console.warn('[PCA] getThreadDetails parse error:', e);
    return null;
  }
}

/**
 * Check if thread is fully read (no UNREAD label on any message)
 */
function isThreadFullyRead(threadData) {
  if (!threadData?.messages) return true;
  return !threadData.messages.some(m => (m.labelIds || []).includes('UNREAD'));
}

/**
 * Check if thread has any user label other than _UNTREATED
 */
function hasOtherUserLabel(threadData, untreatedLabelId) {
  if (!threadData?.messages) return false;
  
  // System labels start with uppercase or are specific IDs
  const systemLabels = new Set([
    'INBOX', 'SENT', 'DRAFT', 'SPAM', 'TRASH', 'UNREAD', 'STARRED',
    'IMPORTANT', 'CATEGORY_PERSONAL', 'CATEGORY_SOCIAL', 'CATEGORY_PROMOTIONS',
    'CATEGORY_UPDATES', 'CATEGORY_FORUMS'
  ]);
  
  for (const msg of threadData.messages) {
    for (const labelId of (msg.labelIds || [])) {
      if (labelId !== untreatedLabelId && !systemLabels.has(labelId)) {
        return true; // Has another user label
      }
    }
  }
  return false;
}

/**
 * Main triage function: label unread/unlabeled emails as _UNTREATED
 * Similar to GAS triageMailboxToUNTREATED()
 */
export async function triageMailboxToUNTREATED() {
  // const email = await getProfileEmail();
  // if (!email) {
  //   console.log('[PCA] Triage skipped: no profile email');
  //   return { labeled: 0, cleaned: 0 };
  // }
  
  await ensureCountBackoffLoaded();
  if (Date.now() < countBackoffUntil) {
    console.log('[PCA] Triage skipped: in backoff period');
    return { labeled: 0, cleaned: 0 };
  }
  
  const labelId = await getOrCreateUntreatedLabelId();
  const dateFilter = `newer_than:${TRIAGE_SCAN_DAYS}d`;
  
  // 1) Collect: unread OR unlabeled in recent window
  const queries = [
    `is:unread -in:spam -in:trash ${dateFilter}`,
    `has:nouserlabels -in:spam -in:trash ${dateFilter}`
  ];
  
  const seen = new Set();
  let labeled = 0;
  
  for (const q of queries) {
    const threadIds = await searchThreadIds(q, TRIAGE_MAX_THREADS);
    for (const id of threadIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      
      const ok = await addLabelToThread(id, labelId);
      if (ok) labeled++;
    }
  }
  
  // 2) Cleanup: remove _UNTREATED if (fully read) AND (has other user label)
  const untreatedThreadIds = await searchThreadIds(
    `label:${LABEL_NAME} -in:spam -in:trash ${dateFilter}`,
    TRIAGE_MAX_THREADS
  );
  
  let cleaned = 0;
  for (const id of untreatedThreadIds) {
    const details = await getThreadDetails(id);
    if (!details) continue;
    
    const fullyRead = isThreadFullyRead(details);
    const hasOther = hasOtherUserLabel(details, labelId);
    
    if (fullyRead && hasOther) {
      const ok = await removeLabelFromThread(id, labelId);
      if (ok) cleaned++;
    }
  }
  await markAllUntreatedAsUnread();
  return { labeled, cleaned };
}

/**
 * Mark only the latest message in each _UNTREATED thread as UNREAD,
 * and mark all older messages as READ
 * @returns {Promise<{markedUnread: number, markedRead: number, threadCount: number}>}
 */
export async function markAllUntreatedAsUnread() {
  await ensureCountBackoffLoaded();
  if (Date.now() < countBackoffUntil) {
    console.log('[PCA] markAllUntreatedAsUnread skipped: in backoff period');
    return { markedUnread: 0, markedRead: 0, threadCount: 0 };
  }
  
  const token = await getToken();
 
  // Search for all _UNTREATED threads
  const threadIds = await searchThreadIds(
    `label:${LABEL_NAME} -in:spam -in:trash`,
    500 // reasonable cap
  );
  
  if (threadIds.length === 0) {
    console.log('[PCA] markAllUntreatedAsUnread: no _UNTREATED threads found');
    return { markedUnread: 0, markedRead: 0, threadCount: 0 };
  }
  
  // Collect message IDs to mark as UNREAD (latest) and READ (older)
  const latestMsgIds = [];  // Will be marked UNREAD
  const olderMsgIds = [];   // Will be marked READ (remove UNREAD)
  
  for (const threadId of threadIds) {
    const details = await getThreadDetails(threadId);
    if (!details?.messages || details.messages.length === 0) continue;
    
    // Messages are ordered oldest -> newest, so last one is latest
    const messages = details.messages;
    const latestMsg = messages[messages.length - 1];
    
    // Latest message -> mark UNREAD (if not already)
    if (!(latestMsg.labelIds || []).includes('UNREAD')) {
      latestMsgIds.push(latestMsg.id);
    }
    
    // Older messages -> mark READ (remove UNREAD if present)
    for (let i = 0; i < messages.length - 1; i++) {
      const msg = messages[i];
      if ((msg.labelIds || []).includes('UNREAD')) {
        olderMsgIds.push(msg.id);
      }
    }
  }
  
  const batchSize = 1000;
  let markedUnread = 0;
  let markedRead = 0;
  
  // Batch modify: add UNREAD to latest messages
  for (let i = 0; i < latestMsgIds.length; i += batchSize) {
    const batch = latestMsgIds.slice(i, i + batchSize);
    
    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        ids: batch,
        addLabelIds: ['UNREAD'],
        removeLabelIds: []
      })
    });
    
    if (res.ok) {
      markedUnread += batch.length;
    } else {
      const txt = await res.text().catch(() => '');
      console.warn('[PCA] markAllUntreatedAsUnread add UNREAD failed:', res.status, txt);
    }
  }
  
  // Batch modify: remove UNREAD from older messages
  for (let i = 0; i < olderMsgIds.length; i += batchSize) {
    const batch = olderMsgIds.slice(i, i + batchSize);
    
    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        ids: batch,
        addLabelIds: [],
        removeLabelIds: ['UNREAD']
      })
    });
    
    if (res.ok) {
      markedRead += batch.length;
    } else {
      const txt = await res.text().catch(() => '');
      console.warn('[PCA] markAllUntreatedAsUnread remove UNREAD failed:', res.status, txt);
    }
  }
  
  console.log('[PCA] markAllUntreatedAsUnread:', markedUnread, 'latest marked UNREAD,', markedRead, 'older marked READ in', threadIds.length, 'threads');
  return { markedUnread, markedRead, threadCount: threadIds.length };
}
