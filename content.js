(function init() {
  // Avoid double-injection (programmatic + manifest) causing redeclarations
  if (window.__PCA_CONTENT_LOADED__) return;
  window.__PCA_CONTENT_LOADED__ = true;

  // Keep _UNTREATED label icon and text in PCA red in the Gmail UI (left navigation)
  const PCA_RED = '#C1272D';
  const NUM_RE = /^\d{1,3}(,\d{3})*$/; // matches numbers like 1, 12, 250, 2,345, 12,345,678
  let navObserver;
  let gUntreatedCount = 0; // updated from background
  const styleUntreatedLabel_ = (shouldStyle) => {
    try {
      // Prefer anchor with label href; fall back to text match
      let anchors = Array.from(document.querySelectorAll('a[href*="#label/_UNTREATED"], a[title="_UNTREATED"], a[aria-label="_UNTREATED"]'));
      if (anchors.length === 0) {
        anchors = Array.from(document.querySelectorAll('a')).filter(a => (a.textContent || '').trim() === '_UNTREATED');
      }
      for (const a of anchors) {
        const row = a.closest('[role="listitem"], tr, div');
        // Cleanup: if any previous version forced icon styles, remove them to let Gmail's color setting apply
        const prevIcons = a.querySelectorAll('[data-pca-icon-styled]');
        prevIcons.forEach(el => {
          try { el.style.removeProperty('background-color'); } catch {}
          try { el.style.removeProperty('border-color'); } catch {}
          try { el.style.removeProperty('fill'); } catch {}
          try { el.style.removeProperty('stroke'); } catch {}
          el.removeAttribute('data-pca-icon-styled');
          if (el.dataset) delete el.dataset.pcaIconStyled;
        });

        if (shouldStyle) {
          // Label text (re-assert every pass while active)
          try { a.style.setProperty('color', PCA_RED, 'important'); } catch {}
          a.dataset.pcaStyled = '1';

          // Right-aligned numeric count
          if (row) {
            const nodes = Array.from(row.querySelectorAll('span, div'))
              .filter(el => !a.contains(el) && !el.dataset.pcaCountStyled);
            for (const el of nodes) {
              const txt = (el.textContent || '').trim();
              if (!txt) continue;
              if (NUM_RE.test(txt)) {
                try {
                  // Badge style: white text on PCA red background, centered
                  el.style.setProperty('color', '#FFFFFF', 'important');
                  el.style.setProperty('background-color', PCA_RED, 'important');
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
                } catch {}
                break;
              }
            }
          }
        } else {
          // Remove text/count styling only; keep icon enforced red
          if (a.dataset.pcaStyled) {
            try { a.style.removeProperty('color'); } catch {}
            a.removeAttribute('data-pca-styled');
            delete a.dataset.pcaStyled;
          }
          if (row) {
            const prev = row.querySelectorAll('[data-pca-count-styled]');
            prev.forEach(el => {
              try { el.style.removeProperty('color'); } catch {}
              try { el.style.removeProperty('background-color'); } catch {}
              try { el.style.removeProperty('font-weight'); } catch {}
              try { el.style.removeProperty('border-radius'); } catch {}
              try { el.style.removeProperty('padding'); } catch {}
              try { el.style.removeProperty('min-width'); } catch {}
              try { el.style.removeProperty('height'); } catch {}
              try { el.style.removeProperty('display'); } catch {}
              try { el.style.removeProperty('align-items'); } catch {}
              try { el.style.removeProperty('justify-content'); } catch {}
              try { el.style.removeProperty('text-align'); } catch {}
              try { el.style.removeProperty('line-height'); } catch {}
              try { el.style.removeProperty('vertical-align'); } catch {}
              el.removeAttribute('data-pca-count-styled');
              if (el.dataset) delete el.dataset.pcaCountStyled;
            });
          }
        }
      }
    } catch {}
  };
  const setupNavObserver_ = () => {
    if (navObserver) return;
    const target = document.body;
    if (!target) return;
    let timer;
    navObserver = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => styleUntreatedLabel_(gUntreatedCount > 0), 150);
    });
    navObserver.observe(target, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'color']
    });
    // Initial attempt
    styleUntreatedLabel_(gUntreatedCount > 0);
  };
  // Defer slightly to allow Gmail to render initial UI
  setTimeout(setupNavObserver_, 600);

  // --- Top banner: "You have ... UNTREATED emails" in PCA red, centered ---
  const BANNER_ID = 'pca-untreated-banner';
  const ensureBanner_ = async () => {
    // Ask background for latest count
    let count = 0;
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'GET_UNTREATED_COUNT' });
      if (resp && resp.ok) count = resp.count || 0;
    } catch {}
    gUntreatedCount = count;

    // Find the top area above the list; Gmail structure varies, target the main list container parent
    const list = document.querySelector('div[role="main"]');
    if (!list || !list.parentElement) {
      // Still update left nav styling based on count
      styleUntreatedLabel_(gUntreatedCount > 0);
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
        padding: '8px 0',
        fontFamily: 'Arial, sans-serif',
        fontSize: '14px',
        color: '#C1272D',
        fontWeight: '700',
        textAlign: 'center'
      });
      // Insert just before the main list
      host.insertBefore(banner, list);
    }
    if (count > 0) {
      banner.textContent = `You have ${count} UNTREATED emails overdue by over 24 hours.`;
      banner.style.display = 'flex';
      banner.style.color = '#C1272D';
      styleUntreatedLabel_(true);
    } else {
      banner.style.display = 'none';
      styleUntreatedLabel_(false);
    }
  };

  // Keep the banner in place as the UI updates
  let bannerObserver;
  const setupBannerObserver_ = () => {
    if (bannerObserver) return;
    const target = document.body;
    if (!target) return;
    let timer;
    bannerObserver = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => { ensureBanner_(); }, 300);
    });
    bannerObserver.observe(target, { childList: true, subtree: true });
    ensureBanner_();
  };
  setTimeout(setupBannerObserver_, 900);

  // On Gmail load, ask background to decide (time/weekend/ack). Quick pre-check avoids duplicate popups on reload
  const d = new Date();
  const todayKey = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  const ackKey = `ack-${todayKey}`;
  const ignoreKey = `ignore-${todayKey}`;
  chrome.storage.local.get([ackKey, ignoreKey], store => {
    if (!store[ackKey] && !store[ignoreKey]) {
      chrome.runtime.sendMessage({ type: 'CHECK_AND_MAYBE_SHOW' });
    }
  });
  // Use today's ack key for listeners below

  // Listen for background trigger (from 4pm alarm or manual click)
  chrome.runtime.onMessage.addListener(msg => {
    if (msg?.type === 'SHOW_MODAL') {
      showModal_(msg.count, !!msg.auto, msg.dateKey);
    }
    if (msg?.type === 'CLOSE_MODAL') {
      const overlay = document.getElementById('pca-untreated-overlay');
      if (overlay) overlay.remove();
    }
  });

  // Also listen to storage changes so any tab acknowledging closes others
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[ackKey]?.newValue) {
      const overlay = document.getElementById('pca-untreated-overlay');
      if (overlay) overlay.remove();
    }
  });
  function showModal_(count, isAuto, dateKey) {
  if (document.getElementById('pca-untreated-overlay')) return; // avoid duplicates

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

  const stamp = buildTimestamp_(); // "DD/MM/YYYY HHhMM"

  box.innerHTML = `
    <p style="margin:0 0 6px 0; font-size:20px; font-weight:700;">
      By ${stamp}, you have ${count} UNTREATED email(s) overdue by over 24 hours. Please treat them immediately.
    </p>
    <p style="margin:6px 0 20px 0; color:#444; font-size:18px;">
      Tính đến ${stamp}, bạn có ${count} email chưa được xử lý trong hơn 24h. Vui lòng xử lý ngay.
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

  const ackBtn = document.getElementById('pca-ack-btn');
  ackBtn.addEventListener('click', () => {
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
  return `${dd}/${mm}/${yyyy} ${hh}h${min}`;
  }
})();