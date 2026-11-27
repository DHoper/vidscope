// 只在 Vidscope 網站上執行：讓網頁知道擴充功能已安裝，並把搜尋請求轉給背景程式。
// 網頁與擴充功能之間只傳「關鍵字」和「搜尋結果」，不碰網頁上的其他東西。
document.documentElement.dataset.vidscopeExt = chrome.runtime.getManifest().version;

window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== location.origin) return;
  const msg = event.data;
  if (!msg || msg.type !== 'vidscope:search' || typeof msg.q !== 'string') return;

  const request = {
    type: 'search',
    q: msg.q.slice(0, 200),
    page: Math.max(0, Math.floor(Number(msg.page) || 0)),
    limit: Math.min(Number(msg.limit) || 500, 500),
    includeYouTube: msg.includeYouTube === true,
    deepAll: msg.deepAll === true,
  };
  chrome.runtime.sendMessage(request, (resp) => {
    const error = chrome.runtime.lastError?.message;
    window.postMessage(
      { type: 'vidscope:result', id: msg.id, ...(error ? { ok: false, error } : resp) },
      location.origin,
    );
  });
});

// 搜尋途中的提示（例如請使用者完成 Google 驗證），轉給網頁顯示
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'vidscope:status' && typeof msg.text === 'string') {
    window.postMessage({ type: 'vidscope:status', text: msg.text }, location.origin);
  }
});
