import { LABEL_NAME } from './config.js';
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
  const { exact = false, useCache = true } = opts;
  const email = await getProfileEmail();
  if (!email) return 0;

  // Try cache first when allowed
  if (useCache) {
    const cached = await readUntreatedCountCache(email);
    if (cached != null && !exact) return cached;
  }

  // If an exact computation is already in-flight, share it
  if (untreatedCountInFlight) {
    try {
      const res = await untreatedCountInFlight;
      if (res && res.email === email) return res.count;
    } catch (e) {
      console.error('[PCA] getUntreatedCount untreatedCountInFlight error:', e);
    }
  }

  // Compute exact count now
  untreatedCountInFlight = (async () => {
    const count = await getExactUntreatedCountFromApi();
    await writeUntreatedCountCache(email, count).catch((e) => {
      console.error('[PCA] getUntreatedCount writeUntreatedCountCache error:', e);
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

export async function refreshUntreatedCountCache() {
  const email = await getProfileEmail();
  if (!email) return;
  const count = await getUntreatedCount({ exact: true, useCache: false }).catch(async (e) => {
    console.warn('[PCA] refresh cache skipped (exact failed)', e);
    const c = await readUntreatedCountCache(email);
    return typeof c === 'number' ? c : 0;
  });
  if (typeof count === 'number') {
    await writeUntreatedCountCache(email, count);
  }
  console.log('[PCA] Hourly exact _UNTREATED count cached for', email, '=', count);
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
