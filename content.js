(function init() {
  // Avoid double-injection (programmatic + manifest) causing redeclarations
  if (window.__PCA_CONTENT_LOADED__) return;
  window.__PCA_CONTENT_LOADED__ = true;

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
  // Precompute today's ack key for listeners below
  const d0 = new Date();
  const todayKey0 = `${d0.getFullYear()}${String(d0.getMonth()+1).padStart(2,'0')}${String(d0.getDate()).padStart(2,'0')}`;
  const ackKey0 = `ack-${todayKey0}`;

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
    if (area === 'local' && changes[ackKey0]?.newValue) {
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