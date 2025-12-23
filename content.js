(function init() {
  console.log('[content.js] Script initializing...');
  // Avoid double-injection (programmatic + manifest) causing redeclarations
  if (window.__PCA_CONTENT_LOADED__) {
    console.log('[content.js] Already loaded, skipping initialization');
    return;
  }
  window.__PCA_CONTENT_LOADED__ = true;
  console.log('[content.js] Initialization started');

  // Keep _UNTREATED label icon and text in PCA red in the Gmail UI (left navigation)
  const PCA_RED = '#C1272D';
  const NUM_RE = /^\d{1,3}(,\d{3})*$/; // matches numbers like 1, 12, 250, 2,345, 12,345,678
  let mailboxMatchAllowed = false; // becomes true only if mailbox email == profile email
  let lastMailboxEmailSent = null; // prevent redundant MAILBOX_EMAIL messages
  let mailboxActivationDone = false;

  /**
   * First, get email from mailbox DOM
   * Then, send to background to check if it matches the profile email
   * if matched, set mailboxMatchAllowed = true and update lastMailboxEmailSent
   * 
   */
  // Extract current mailbox email heuristically from Gmail DOM
  function detectMailboxEmail_() {
    console.log('[content.js] detectMailboxEmail_() called');
    try {
      // Strategy 1: Look for account switcher img alt or div[aria-label] containing email
      const candidate = document.querySelector('a[aria-label*="@"], div[aria-label*="@"], img[aria-label*="@"]');
      const aria = candidate && (candidate.getAttribute('aria-label') || '');
      if (aria && /[A-Z0-9._%+-]+@[A-Z0-9.-]+/i.test(aria)) {
        const m = aria.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+/i);
        if (m) return m[0].toLowerCase();
      }
      // Strategy 2: Look for span elements containing an email pattern (common in header avatar tooltip)
      const spans = Array.from(document.querySelectorAll('span'));
      for (const s of spans) {
        const txt = (s.textContent || '').trim();
        if (/^[A-Z0-9._%+-]+@[A-Z0-9.-]+$/i.test(txt)) return txt.toLowerCase();
      }
    } catch (e) {
      console.error('[PCA] detectMailboxEmail_ error:', e);
    }
    return null;
  }

  // async function initMailboxBinding_() {
  //   console.log('[content.js] initMailboxBinding_() called');
  //   const email = detectMailboxEmail_();
  //   if (!email) return; // Try again later via observer below
  //   if (email === lastMailboxEmailSent) return; // already reported
  //   try {
  //     const resp = await chrome.runtime.sendMessage({ type: 'MAILBOX_EMAIL', email });
  //     if (resp && resp.ok) {
  //       const prev = mailboxMatchAllowed;
  //       mailboxMatchAllowed = !!resp.match;
  //       lastMailboxEmailSent = email;
  //       console.log('[content.js] initMailboxBinding_() response received, match:', mailboxMatchAllowed);
  //       if (mailboxMatchAllowed && !prev) {
  //         console.log('[content.js] initMailboxBinding_() mailbox matched! Activating...');
  //         activateAfterMatch_();
  //       }
  //     }
  //   } catch (e) {
  //     console.error('[PCA] initMailboxBinding_ error:', e);
  //   }
  // }
  //   // Kick initial attempt
  // console.log('[content.js] Scheduling initial initMailboxBinding_() in 400ms');
  // setTimeout(initMailboxBinding_, 400);

  async function tryBindMailbox_(email) {
    if (!email || email === lastMailboxEmailSent) return false;

    try {
      const resp = await chrome.runtime.sendMessage({ type: 'MAILBOX_EMAIL', email });
      if (resp?.ok) {
        lastMailboxEmailSent = email;
        const prev = mailboxMatchAllowed;
        mailboxMatchAllowed = !!resp.match;
        console.log('[content.js] tryBindMailbox_() response, match:', mailboxMatchAllowed);
        if (mailboxMatchAllowed && !prev) {
          console.log('[content.js] tryBindMailbox_() success! Activating...');
          activateAfterMatch_();
          return true; // success
        }
      }
    } catch (e) {
      console.warn('[mailbox] bind failed', e);
    }
    return false; // fail
  }

  // Observe for initial mailbox email appearance (Gmail loads async)
  // const mailboxObserver = new MutationObserver(() => {
  //   if (!mailboxMatchAllowed) {
  //     const found = detectMailboxEmail_();
  //     if (found) {
  //       initMailboxBinding_();
  //     }
  //   }
  // });

  const mailboxObserver = new MutationObserver(() => {
    if (mailboxMatchAllowed) {
      console.log('[content.js] mailboxObserver: match already allowed, disconnecting');
      mailboxObserver.disconnect();
      return;
    }
    const email = detectMailboxEmail_();
    if (email) {
      tryBindMailbox_(email).then(success => {
        if (success) mailboxObserver.disconnect();
      });
    }
});

  console.log('[content.js] Starting mailboxObserver...');
  mailboxObserver.observe(document.documentElement, { subtree: true, childList: true, attributes: true });

  let navObserver;
  let gUntreatedCount = 0; // updated from background
  // Style all special labels regardless of overdue count
  const styleSpecialLabels_ = () => {
    if (!mailboxMatchAllowed) return;
    const LABEL_STYLES = {
      '_UNTREATED': { color: '#C1272D', fontWeight: '700', badge: '#C1272D' },
      '_Processing': { color: '#E86C1A', fontWeight: '700', badge: '#E86C1A' },
      '_Follow-up': { color: '#E6C01A', fontWeight: '700', badge: '#E6C01A' },
      '_No action': { color: '#888', fontWeight: '400', badge: null }
    };
    for (const [label, style] of Object.entries(LABEL_STYLES)) {
      let anchors = Array.from(document.querySelectorAll(`a[href*="#label/${label}"], a[title="${label}"], a[aria-label="${label}"]`));
      if (anchors.length === 0) {
        anchors = Array.from(document.querySelectorAll('a')).filter(a => (a.textContent || '').trim() === label);
      }
      for (const a of anchors) {
        try {
          a.style.setProperty('color', style.color, 'important');
          a.style.setProperty('font-weight', style.fontWeight, 'important');
        } catch (e) {
          console.error('[PCA] styleSpecialLabels_ label color error:', e);
        }
        // Special badge for _UNTREATED, _Processing, _Follow-up
        if (style.badge) {
          const row = a.closest('[role="listitem"], tr, div');
          if (row) {
            const nodes = Array.from(row.querySelectorAll('span, div'))
              .filter(el => !a.contains(el) && !el.dataset.pcaCountStyled);
            for (const el of nodes) {
              const txt = (el.textContent || '').trim();
              if (!txt) continue;
              if (NUM_RE.test(txt)) {
                try {
                  el.style.setProperty('color', '#FFFFFF', 'important');
                  el.style.setProperty('background-color', style.badge, 'important');
                  el.style.setProperty('font-weight', '700', 'important');
                  el.style.setProperty('border-radius', '999px', 'important');
                  el.style.setProperty('padding', '0 8px', 'important');
                  el.style.setProperty('min-width', '20px', 'important');
                  el.style.setProperty('height', '20px', 'important');
                  el.style.setProperty('display', 'inline-flex', 'important');
                  el.style.setProperty('align-items', 'center', 'important');
                  el.style.setProperty('justify-content', 'center', 'important');
                  el.style.setProperty('text-align', 'center', 'important');
                  el.style.setProperty('line-height', '1', 'important');
                  el.style.setProperty('vertical-align', 'middle', 'important');
                  el.dataset.pcaCountStyled = '1';
                } catch (e) {
                  console.error('[PCA] styleSpecialLabels_ badge styling error:', e);
                }
                break;
              }
            }
          }
        }
      }
    }
  };
  
  const setupNavObserver_ = () => {
    if (navObserver) return;
    const target = document.body;
    if (!target) return;
    let timer;
    navObserver = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => styleSpecialLabels_(), 150);
    });
    console.log('[content.js] setupNavObserver_() starting observer');
    navObserver.observe(target, {
      subtree: true,
      childList: true,
      // attributes: true,
      // attributeFilter: ['style', 'class', 'color']
    });
    // Initial attempt
    styleSpecialLabels_();
  };
  // // Defer slightly to allow Gmail to render initial UI
  // setTimeout(setupNavObserver_, 600);

  // --- Top banner: "You have ... UNTREATED emails" in PCA red, centered ---
  const BANNER_ID = 'pca-untreated-banner';

  const renderBanner_ = (count) => {
    // Find the top area above the list; Gmail structure varies, target the main list container parent
    const list = document.querySelector('div[role="main"]');
    if (!list || !list.parentElement) {
      // Still update left nav styling based on count
      // styleSpecialLabels_();
      return;
    }
    const host = list.parentElement;
    let banner = document.getElementById(BANNER_ID);
    if (!banner) {
      banner = document.createElement('div');
      banner.id = BANNER_ID;
      Object.assign(banner.style, {
        display: 'none', // default hidden, shown only when count > 0
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
        padding: '2px 0 4px', // tighter vertical padding
        margin: '0',
        lineHeight: '1.15',
        gap: '1px',
        fontFamily: 'Arial, sans-serif',
        fontSize: '14px',
        color: '#C1272D',
        fontWeight: '700',
        textAlign: 'center'
      });
      host.insertBefore(banner, list);
    }
    
    if (count > 0) {
      banner.innerHTML = `
        <div style="margin:0;">You have ${count} UNTREATED email(s).</div>
        <div style="font-weight:400; margin-top:1px; margin-bottom:0;">Bạn có ${count} email chưa được xử lý.</div>
      `;
      banner.style.display = 'flex';
      banner.style.color = '#C1272D';
      // styleSpecialLabels_();
    } else {
      banner.style.display = 'none';
      // styleSpecialLabels_();
    }
  };
  const ensureBanner_ = async () => {
    if (!mailboxMatchAllowed) return; // deactivated for this mailbox
    // Ask background for latest count
    let count = gUntreatedCount;
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'GET_UNTREATED_COUNT' });
      if (resp && resp.ok) count = resp.count || 0;
    } catch (e) {
      console.error('[PCA] ensureBanner_ GET_UNTREATED_COUNT error:', e);
    }
    if (count === gUntreatedCount) {
      // No change
      return;
    }

    gUntreatedCount = count;
    console.log('[content.js] ensureBanner_() count received:', count);

    renderBanner_(count);
  };

  // Keep the banner in place as the UI updates
  let bannerObserver;
  const setupBannerObserver_ = () => {
    if (bannerObserver) return;
    // const target = document.body;
    // if (!target) return;
    // let timer;
    // bannerObserver = new MutationObserver(() => {
    //   clearTimeout(timer);
    //   timer = setTimeout(() => { ensureBanner_(); }, 300);
    // });
    // console.log('[content.js] setupBannerObserver_() starting observer');
    // bannerObserver.observe(target, { childList: true, subtree: true });
    // ensureBanner_();

    bannerObserver = new MutationObserver(() => {
    const banner = document.getElementById(BANNER_ID);
    if (!banner && gUntreatedCount > 0) {
      renderBanner_(gUntreatedCount);
    }
  });

    bannerObserver.observe(document.body, { childList: true, subtree: true });
  };
  // setTimeout(setupBannerObserver_, 900);

  // // On Gmail load, ask background to decide (time/weekend/ack). Quick pre-check avoids duplicate popups on reload
  const d = new Date();
  const todayKey = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  const ackKey = `ack-${todayKey}`;
  // const ignoreKey = `ignore-${todayKey}`;
  // chrome.storage.local.get([ackKey, ignoreKey], store => {
  //   if (!mailboxMatchAllowed) return; // will retry on activation
  //   if (!store[ackKey] && !store[ignoreKey]) {
  //     console.log('[content.js] No ack/ignore found, sending CHECK_AND_MAYBE_SHOW');
  //     chrome.runtime.sendMessage({ type: 'CHECK_AND_MAYBE_SHOW' });
  //   } else {
  //     console.log('[content.js] Already acked or ignored today');
  //   }
  // });
  // // Use today's ack key for listeners below

  // Listen for background trigger (from 4pm alarm or manual click)
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    console.log('[content.js] Received message:', msg?.type);
    if (msg?.type === 'SHOW_LOADING_MODAL') {
      showLoadingModal_();
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === 'SHOW_MODAL') {
      // Allow showing on mismatch only when explicitly forced by background
      const allowMismatch = !!msg.allowMismatch;
      if (!mailboxMatchAllowed && !allowMismatch) {
        sendResponse({ ok: false, reason: 'mismatch' });
        return;
      }
      showModal_(msg.count, !!msg.auto, msg.dateKey, allowMismatch);
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === 'REFRESH_BANNER') {
      // Pull latest cached exact count and update banner
      ensureBanner_();
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === 'CLOSE_MODAL') {
      const overlay = document.getElementById('pca-untreated-overlay');
      if (overlay) overlay.remove();
      sendResponse({ ok: true });
      return;
    }
  });

  // Also listen to storage changes so any tab acknowledging closes others
  chrome.storage.onChanged.addListener((changes, area) => {
    if (!mailboxMatchAllowed) return;
    if (area === 'local' && changes[ackKey]?.newValue) {
      console.log('[content.js] Storage changed: ack detected, closing modal');
      const overlay = document.getElementById('pca-untreated-overlay');
      if (overlay) overlay.remove();
    }
  });

  /**
   * Show loading modal with spinner
   */
  function showLoadingModal_() {
    // Remove existing modal if any
    const existing = document.getElementById('pca-untreated-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'pca-untreated-overlay';
    Object.assign(overlay.style, {
      position: 'fixed',
      inset: '0',
      background: 'rgba(0,0,0,0.6)',
      zIndex: '2147483647',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    });

    const box = document.createElement('div');
    Object.assign(box.style, {
      background: '#fff',
      padding: '32px 48px',
      borderRadius: '12px',
      boxShadow: '0 10px 30px rgba(0,0,0,0.2)',
      fontFamily: 'Arial, sans-serif',
      textAlign: 'center',
      minWidth: '300px'
    });

    // Add spinner animation style if not exists
    if (!document.getElementById('pca-spinner-style')) {
      const style = document.createElement('style');
      style.id = 'pca-spinner-style';
      style.textContent = `
        @keyframes pca-spin {
          to { transform: rotate(360deg); }
        }
      `;
      document.head.appendChild(style);
    }

    box.innerHTML = `
      <div style="margin-bottom: 16px;">
        <div style="
          width: 40px;
          height: 40px;
          border: 4px solid #e0e0e0;
          border-top-color: #C1272D;
          border-radius: 50%;
          animation: pca-spin 1s linear infinite;
          margin: 0 auto;
        "></div>
      </div>
      <div style="font-size: 16px; color: #333; font-weight: 600;">Đang kiểm tra email...</div>
      <div style="font-size: 14px; color: #666; margin-top: 4px;">Checking emails...</div>
    `;

    overlay.appendChild(box);
    document.documentElement.appendChild(overlay);
    console.log('[content.js] showLoadingModal_() displayed');
  }

  function showModal_(count, isAuto, dateKey, allowMismatch = false) {
    // Remove existing modal (including loading modal) before showing result
    const existing = document.getElementById('pca-untreated-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'pca-untreated-overlay';
    Object.assign(overlay.style, {
      position: 'fixed',
      inset: '0',
      background: 'rgba(0,0,0,0.6)',
      zIndex: '2147483647',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    });

    const box = document.createElement('div');
    Object.assign(box.style, {
      background: '#fff',
      padding: '28px 32px',
      maxWidth: '640px',
      width: '92%',
      borderRadius: '12px',
      boxShadow: '0 10px 30px rgba(0,0,0,0.2)',
      fontFamily: 'Arial, sans-serif',
      textAlign: 'center' // center all text
    });

    const stamp = buildTimestamp_(); // "HH:MM DD/MM/YYYY"

    box.innerHTML = `
      <p style="margin:0 0 6px 0; font-size:20px; font-weight:700;">
    By ${stamp}, you have ${count} UNTREATED email(s). Please treat them immediately.
      </p>
      <p style="margin:6px 0 20px 0; color:#444; font-size:18px;">
    Tính đến ${stamp}, bạn có ${count} email chưa được xử lý. Vui lòng xử lý ngay.
      </p>
      <div id="pca-btn-row" style="display:flex; gap:12px; justify-content:center; align-items:center;">
    <button id="pca-ack-btn" data-auto="${isAuto ? 'true' : 'false'}" data-date="${dateKey || ''}" style="
          padding:10px 20px;
          border:none;
          border-radius:10px;
          background:#C1272D;
          color:#fff;
          font-size:16px;
          cursor:pointer;
          font-family: inherit;
          display: flex;
          flex-direction: column;
          align-items: center;
        ">
          <span style="font-weight:700; font-size:16px;">I understand and I will take care of it now</span>
          <span style="font-weight:400; font-size:15px; margin-top:2px;">Tôi đã đọc và tôi sẽ xử lý ngay bây giờ</span>
        </button>
      </div>
    `;

    overlay.appendChild(box);
    document.documentElement.appendChild(overlay);
    console.log('[content.js] showModal_() modal displayed');

    const ackBtn = document.getElementById('pca-ack-btn');
    ackBtn.addEventListener('click', () => {
      console.log('[content.js] Ack button clicked');
      overlay.remove();
      // Always request closing modals in other tabs
      chrome.runtime.sendMessage({ type: 'CLOSE_ALL_MODALS' });
      // Only count acknowledgment when auto-triggered
      if (ackBtn.dataset.auto === 'true') {
        const dateKey = ackBtn.dataset.date;
        chrome.runtime.sendMessage({ type: 'ACK_DATE', dateKey });
      }
    }, { once: true });
  }

  function buildTimestamp_() {
    const d = new Date();
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    // Return time first (24h) then date: "HH:MM DD/MM/YYYY"
    return `${hh}:${min} ${dd}/${mm}/${yyyy}`;
  }

  function activateAfterMatch_() {
    if (!mailboxMatchAllowed || mailboxActivationDone) return;
    mailboxActivationDone = true;
    console.log('[content.js] activateAfterMatch_() starting activation sequence...');
    
    setupNavObserver_();

    setupBannerObserver_();
    
    ensureBanner_();

    // Re-run daily check precondition (ACK modal) in case we missed initial window
    const dAct = new Date();
    const todayKeyAct = `${dAct.getFullYear()}${String(dAct.getMonth()+1).padStart(2,'0')}${String(dAct.getDate()).padStart(2,'0')}`;
    const ackKeyAct = `ack-${todayKeyAct}`;
    const ignoreKeyAct = `ignore-${todayKeyAct}`;
    chrome.storage.local.get([ackKeyAct, ignoreKeyAct], store => {
      if (!store[ackKeyAct] && !store[ignoreKeyAct]) {
        chrome.runtime.sendMessage({ type: 'CHECK_AND_MAYBE_SHOW' });
      }
    });
  }

})();