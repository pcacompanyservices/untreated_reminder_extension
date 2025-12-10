// ===== OAuth helpers =====
export async function ensureTokenInteractive_() {
  await new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, token => {
      if (chrome.runtime.lastError || !token) reject(chrome.runtime.lastError || new Error('No token'));
      else resolve(token);
    });
  });
}
export function getToken_() {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: false }, token => {
      if (chrome.runtime.lastError || !token) reject(chrome.runtime.lastError || new Error('No token'));
      else resolve(token);
    });
  });
}

