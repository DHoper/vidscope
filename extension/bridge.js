// 只在 Vidscope 網站上執行：讓網頁知道擴充功能已安裝，並把搜尋請求轉給背景程式。
// 網頁與擴充功能之間只傳「關鍵字」和「搜尋結果」，不碰網頁上的其他東西。
document.documentElement.dataset.vidscopeExt = chrome.runtime.getManifest().version;

window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== location.origin) return;
  const msg = event.data;
  if (!msg || msg.type !== 'vidscope:search' || typeof msg.q !== 'string') return;

  chrome.runtime.sendMessage({ type: 'search', q: msg.q.slice(0, 200), limit: Number(msg.limit) || 24 }, (resp) => {
    const error = chrome.runtime.lastError?.message;
    window.postMessage(
      { type: 'vidscope:result', id: msg.id, ...(error ? { ok: false, error } : resp) },
      location.origin,
    );
  });
});
