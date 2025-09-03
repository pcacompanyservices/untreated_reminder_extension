const TARGET_HOUR = 16;

(function init() {
  // On Gmail load, if it's after 4pm, ask background to check and maybe show
  if (new Date().getHours() >= TARGET_HOUR) {
    chrome.runtime.sendMessage({ type: 'CHECK_AND_MAYBE_SHOW' });
  }
  // Listen for background trigger (from 4pm alarm or manual click)
  let lastModalAuto = false;
  chrome.runtime.onMessage.addListener(msg => {
    if (msg?.type === 'SHOW_MODAL') {
      lastModalAuto = !!msg.auto;
      showModal_(msg.count);
    }
    if (msg?.type === 'CLOSE_MODAL') {
      const overlay = document.getElementById('pca-untreated-overlay');
      if (overlay) overlay.remove();
    }
  });
})();

function showModal_(count) {
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
      <button id="pca-ack-btn" style="
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

  document.getElementById('pca-ack-btn').addEventListener('click', () => {
    overlay.remove();
    if (lastModalAuto) {
      chrome.runtime.sendMessage({ type: 'ACK_TODAY' });
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