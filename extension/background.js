// 擴充功能的背景程式：收到 Vidscope 網站的搜尋請求後，去搜尋整個網路的影片。
import { searchWeb } from './engines.js';

const ALLOWED = [/^https:\/\/dhoper\.github\.io\/vidscope\//, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//];

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'search') return false;
  if (!ALLOWED.some((re) => re.test(sender.url || ''))) {
    sendResponse({ ok: false, error: '不允許的來源網站' });
    return false;
  }
  searchWeb(msg.q, msg.limit).then(
    (r) => sendResponse({ ok: true, ...r }),
    (e) => sendResponse({ ok: false, error: e.message }),
  );
  return true; // 非同步回應
});
