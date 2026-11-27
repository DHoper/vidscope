// 擴充功能的背景程式：收到 Vidscope 網站的搜尋請求後，去搜尋整個網路的影片。
import { searchWeb } from './engines.js';

const ALLOWED = [/^https:\/\/dhoper\.github\.io\/vidscope\//, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//];

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'search') return false;
  if (!ALLOWED.some((re) => re.test(sender.url || ''))) {
    sendResponse({ ok: false, error: '不允許的來源網站' });
    return false;
  }
  const tabId = sender.tab?.id;
  const ctx = {
    returnTabId: tabId,
    // 搜尋途中要告訴使用者的事（例如需要完成 Google 驗證），送回網頁顯示
    notify: (text) => tabId != null && chrome.tabs.sendMessage(tabId, { type: 'vidscope:status', text }).catch(() => {}),
  };
  const options = {
    page: Math.max(0, Number(msg.page) || 0),
    limit: msg.limit,
    includeYouTube: msg.includeYouTube === true,
    deepAll: msg.deepAll === true,
    ctx,
  };
  searchWeb(msg.q, options).then(
    (r) => sendResponse({ ok: true, ...r }),
    (e) => sendResponse({ ok: false, error: e.message }),
  );
  return true; // 非同步回應
});
