// ===== Gmail API client (encapsulated state) =====
import { StorageKeys } from './StorageKeys.js';
import { getToken_ } from './OAuthHelpers.js';
const LABEL_NAME = '_UNTREATED';
export const GmailApiClient = (() => {
  // --- Internal state for profile ---
  let cachedProfileEmail = null;
  let profileFetchAttempted = false;
  let profileFetchPromise = null;  // de-dup concurrent profile fetches
  let profileBackoffUntil = 0;     // epoch ms until which we should not refetch after 429
  let profileCacheLoaded = false;

  // --- Internal state for untreated count backoff ---
  let countBackoffUntil = 0;       // epoch ms to pause exact count after 429
  let countBackoffLoaded = false;

  // --- Helpers ---

  async function ensureProfileCacheLoaded() {
    if (profileCacheLoaded) return;
    try {
      const st = await chrome.storage.local.get([
        StorageKeys.profileEmailCache,
        StorageKeys.profileBackoffUntil,
      ]);

      const cached = st[StorageKeys.profileEmailCache];
      if (typeof cached === 'string' && cached) {
        cachedProfileEmail = cached.toLowerCase();
      }

      const backoff = st[StorageKeys.profileBackoffUntil];
      if (typeof backoff === 'number') {
        profileBackoffUntil = backoff;
      }
    } catch {
      // ignore
    }
    profileCacheLoaded = true;
  }

  async function ensureCountBackoffLoaded() {
    if (countBackoffLoaded) return;
    try {
      const st = await chrome.storage.local.get(StorageKeys.countBackoffUntil);
      const v = st[StorageKeys.countBackoffUntil];
      if (typeof v === 'number') {
        countBackoffUntil = v;
      }
    } catch {
      // ignore
    }
    countBackoffLoaded = true;
  }

  // Parse retry-after from headers and/or body
  function parseRetryAfter_(res, bodyText) {
    let retryAtMs = 0;
    try {
      const hdr = res.headers.get('retry-after');
      if (hdr) {
        const secs = Number(hdr);
        if (!Number.isNaN(secs) && secs > 0) {
          retryAtMs = Date.now() + secs * 1000;
        } else {
          const t = Date.parse(hdr);
          if (!Number.isNaN(t)) retryAtMs = t;
        }
      }
      if (!retryAtMs && bodyText) {
        const m = bodyText.match(/Retry after\s+([0-9T:\-.Z+]+)/i);
        if (m && m[1]) {
          const t = Date.parse(m[1]);
          if (!Number.isNaN(t)) retryAtMs = t;
        }
      }
    } catch {
      // ignore
    }
    // Fallback: 2 minutes backoff if not provided
    if (!retryAtMs) retryAtMs = Date.now() + 2 * 60 * 1000;
    return retryAtMs;
  }

  // --- Public methods ---

  async function getProfileEmail() {
    await ensureProfileCacheLoaded();

    // Nếu đã có cache hợp lệ → trả ngay
    if (cachedProfileEmail) return cachedProfileEmail;

    // Nếu đang trong backoff 429 → trả null, không gọi API
    if (Date.now() < profileBackoffUntil) return null;

    // Nếu đã có một fetch đang chạy → dùng chung promise đó
    if (profileFetchPromise) return profileFetchPromise;

    profileFetchPromise = (async () => {
      try {
        const token = await getToken_();
        const res = await fetch(
          'https://gmail.googleapis.com/gmail/v1/users/me/profile?fields=emailAddress',
          { headers: { Authorization: `Bearer ${token}` } }
        );

        if (res.ok) {
          let data = {};
          try {
            data = await res.json();
          } catch {
            data = {};
          }

          const email = data && data.emailAddress
            ? String(data.emailAddress).toLowerCase()
            : null;

          cachedProfileEmail = email;

          // Persist cache
          try {
            await chrome.storage.local.set({
              [StorageKeys.profileEmailCache]: email || '',
            });
          } catch {
            // ignore
          }

          if (!profileFetchAttempted) {
            console.log('[PCA] Profile email resolved:', email || '(null)');
          }

          return email;
        }

        // Handle 429 backoff explicitly
        if (res.status === 429) {
          let bodyText = '';
          try { bodyText = await res.text(); } catch { bodyText = ''; }

          const retryAtMs = parseRetryAfter_(res, bodyText);
          profileBackoffUntil = retryAtMs;

          try {
            await chrome.storage.local.set({
              [StorageKeys.profileBackoffUntil]: profileBackoffUntil,
            });
          } catch {
            // ignore
          }

          if (!profileFetchAttempted) {
            console.warn(
              '[PCA] profile fetch 429; backoff until',
              new Date(profileBackoffUntil).toISOString()
            );
          }

          return null;
        }

        // Other non-OK statuses
        if (!profileFetchAttempted) {
          let txt = '';
          try { txt = await res.text(); } catch { txt = ''; }
          console.warn('[PCA] profile fetch failed', res.status, txt);
        }
        return null;

      } catch (e) {
        if (!profileFetchAttempted) {
          console.warn('[PCA] getProfileEmail error', e);
        }
        return null;

      } finally {
        profileFetchAttempted = true;
        profileFetchPromise = null;
      }
    })();

    return profileFetchPromise;
  }

  async function getUntreatedCountExact() {
    await ensureCountBackoffLoaded();
    if (Date.now() < countBackoffUntil) {
      throw new Error(
        `count-backoff-active-until:${new Date(countBackoffUntil).toISOString()}`
      );
    }

    const token = await getToken_();
    let total = 0;
    let pageToken;

    do {
      const params = new URLSearchParams({
        maxResults: '500',
        q: `label:${LABEL_NAME} -in:trash -in:spam`,
      });
      if (pageToken) params.set('pageToken', pageToken);

      const url =
        `https://gmail.googleapis.com/gmail/v1/users/me/threads?` +
        `${params.toString()}&fields=nextPageToken,threads/id`;

      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) {
        let txt = '';
        try { txt = await res.text(); } catch { txt = ''; }

        if (res.status === 429) {
          const retryAtMs = parseRetryAfter_(res, txt);
          countBackoffUntil = retryAtMs;
          try {
            await chrome.storage.local.set({
              [StorageKeys.countBackoffUntil]: countBackoffUntil,
            });
          } catch {
            // ignore
          }

          throw new Error(
            `threads.list failed: 429 backoff-until ${new Date(retryAtMs).toISOString()}`
          );
        }

        throw new Error(`threads.list failed: ${res.status} ${txt}`);
      }

      let data = {};
      try { data = await res.json(); } catch { data = {}; }

      const arr = Array.isArray(data.threads) ? data.threads : [];
      total += arr.length;
      pageToken = data.nextPageToken;

    } while (pageToken);

    return total;
  }

  async function getUntreatedEstimate() {
    const token = await getToken_();
    const params = new URLSearchParams({
      maxResults: '1',
      q: `label:${LABEL_NAME} -in:trash -in:spam`,
    });
    const url =
      `https://gmail.googleapis.com/gmail/v1/users/me/threads?` +
      `${params.toString()}&fields=resultSizeEstimate`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) return 0;

    try {
      const data = await res.json();
      return Number(data.resultSizeEstimate) || 0;
    } catch {
      return 0;
    }
  }

  async function resetProfileCache() {
    // reset in-memory
    cachedProfileEmail = null;
    profileFetchAttempted = false;
    profileFetchPromise = null;
    profileBackoffUntil = 0;
    profileCacheLoaded = false;

    // reset count-backoff too (safe)
    countBackoffUntil = 0;
    countBackoffLoaded = false;

    // clear persisted storage
    try {
      await chrome.storage.local.remove([
        StorageKeys.profileEmailCache,
        StorageKeys.profileBackoffUntil,
        StorageKeys.untreatedCountCache,
        StorageKeys.countBackoffUntil,
      ]);
    } catch {
      // ignore
    }
  }

  return {
    getProfileEmail,
    getUntreatedCountExact,
    getUntreatedEstimate,
    resetProfileCache,
    // Expose token nếu sau này cần:
    getAuthToken: () => getToken_(),
  };
})();
