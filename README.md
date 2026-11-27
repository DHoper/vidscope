# Vidscope：多平台影片搜尋聚合站

跨平台影片搜尋：把 YouTube、Vimeo、Internet Archive、Wikimedia Commons、Pexels、Pixabay、Dailymotion 和任意網站的影片整理在同一個地方搜尋、篩選、播放。

- **純前端網站**：放在 GitHub Pages，不需要伺服器。
- **爬蟲跑在 GitHub Actions**：每 3 小時自動抓一次，結果存成 `data/videos.json`。
- **插件式來源**：每個平台是一個 adapter，要加新來源只要寫一個檔案。
- **下載**：只有來源本身提供下載時才顯示下載按鈕（Internet Archive、Wikimedia Commons、Pexels、Pixabay、創作者開放下載的 Vimeo 影片，以及頁面上有 `<a download>` 連結的網站）。

## 架構

```
GitHub Actions（每 3 小時）
  └─ node crawler/index.mjs
       ├─ adapters/youtube.mjs      YouTube Data API（需金鑰，只嵌入播放）
       ├─ adapters/vimeo.mjs        Vimeo API（需 token）
       ├─ adapters/archive.mjs      Internet Archive（免金鑰，可下載）
       ├─ adapters/wikimedia.mjs    Wikimedia Commons（免金鑰，可下載）
       ├─ adapters/pexels.mjs       Pexels（需金鑰，可下載）
       ├─ adapters/pixabay.mjs      Pixabay（需金鑰，可下載）
       ├─ adapters/dailymotion.mjs  Dailymotion（免金鑰，只嵌入播放）
       └─ adapters/web.mjs          通用網頁爬蟲（任意網站）
            ↓
       data/videos.json + data/meta.json（commit 回 repo）
            ↓
GitHub Pages：index.html + assets/app.js 讀 JSON，在瀏覽器內搜尋
```

## 設定 API 金鑰

沒設定金鑰的來源會自動略過，不會報錯。免金鑰的來源（Internet Archive、Wikimedia Commons、Dailymotion、通用網頁爬蟲）不設定也能跑。

到 repo 的 **Settings → Secrets and variables → Actions → New repository secret** 新增：

| Secret 名稱 | 去哪裡申請 |
| --- | --- |
| `YOUTUBE_API_KEY` | Google Cloud Console → 建立專案 → 啟用「YouTube Data API v3」→ 建立 API 金鑰 |
| `PEXELS_API_KEY` | https://www.pexels.com/api/ |
| `PIXABAY_API_KEY` | https://pixabay.com/api/docs/ （登入後頁面上就有） |
| `VIMEO_TOKEN` | https://developer.vimeo.com/apps → 建立 App → 產生 access token（Public 權限即可） |
| `DAILYMOTION_PLAYER_ID` | Dailymotion Partner HQ 建立播放器後取得的 Player ID。沒設定時 Dailymotion 影片不嵌入播放，只連回原始頁面 |

設好後到 **Actions → Crawl videos → Run workflow** 手動跑一次。

## 調整要抓什麼

編輯 `crawler/config.json`：

- `queries`：各平台要搜尋的關鍵字
- `perQuery`：每個關鍵字抓幾筆
- `maxItems`：資料庫最多保留幾筆（JSON 檔太大會拖慢網站載入）
- `sources.<名稱>.enabled`：開關某個來源
- `sources.youtube.maxQueries`：YouTube 只用前幾個關鍵字（免費配額每天 10,000 單位，每次搜尋耗 100）
- `web.seeds`：通用爬蟲的起始網址

### 通用網頁爬蟲

`web.seeds` 裡放任何網址，爬蟲會從那裡開始抓：

```json
{ "url": "https://example.com/videos/", "depth": 1, "maxPages": 30, "sameHost": true, "include": "/videos/" }
```

- `depth`：從起始頁往下跟連結幾層
- `maxPages`：這個起點最多抓幾頁
- `sameHost`：只跟同網域的連結（預設 true）
- `include`：只跟網址符合這個正規表示式的連結（選填）

它讀的是網站自己公開標註的影片資訊：schema.org `VideoObject`（JSON-LD）、Open Graph `og:video`、`<video>` 標籤。爬蟲會遵守 robots.txt，同一網站每次請求間隔 `delayMs` 毫秒。

## 新增來源

在 `crawler/adapters/` 新增一個檔案，匯出：

```js
export const name = 'mysource';       // 代號
export const label = '我的來源';       // 顯示名稱
export const needs = ['MY_API_KEY'];  // 需要的環境變數，沒有就 []
export async function search(query, { limit }) { /* 回傳 makeVideo(...) 陣列 */ }
// 或者不吃關鍵字的來源，改匯出 crawl(config)
```

然後加進 `crawler/index.mjs` 的 `ADAPTERS` 陣列。資料格式見 `crawler/lib/normalize.mjs`。

## 本機開發

```bash
node crawler/test.mjs            # 離線測試解析邏輯
node crawler/index.mjs           # 跑全部來源
node crawler/index.mjs archive   # 只跑某個來源
python3 -m http.server 8000      # 在 http://localhost:8000 預覽網站
```

需要 Node.js 18 以上（用內建 fetch），沒有任何 npm 相依套件。

## 聲明

影片版權屬原作者與原平台所有。本站只建立索引、嵌入原平台播放器或連回原始頁面，不轉存影片。
