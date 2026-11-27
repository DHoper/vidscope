# Vidscope：多平台影片搜尋聚合站

跨平台影片搜尋：把 YouTube、Vimeo、Internet Archive、Wikimedia Commons、Pexels、Pixabay、Dailymotion 和任意網站的影片整理在同一個地方搜尋、篩選、播放。

- **純前端網站**：放在 GitHub Pages，不需要伺服器。
- **爬蟲跑在 GitHub Actions**：每 3 小時自動抓一次，結果存成 `data/videos.json`。
- **全網自動搜尋**：依關鍵字自動找出全網的影片頁面，不用手動填網址（Brave 影片搜尋 API），找到的頁面再自動打開解析播放器與影片檔。
- **插件式來源**：每個平台是一個 adapter，要加新來源只要寫一個檔案。
- **下載**：只有來源本身提供下載時才顯示下載按鈕（Internet Archive、Wikimedia Commons、Pexels、Pixabay、創作者開放下載的 Vimeo 影片，以及頁面上有 `<a download>` 連結的網站）。

## 兩種用法

| | 網頁版（GitHub Pages） | 本機完整版 |
| --- | --- | --- |
| 怎麼用 | 直接打開 https://dhoper.github.io/vidscope/ | 下載後 `docker compose up -d` |
| 搜尋時即時查詢 | Internet Archive、Wikimedia Commons、Dailymotion | 以上全部，加上**全網搜尋**（SearXNG），以及有設金鑰的 YouTube、Vimeo、Pexels、Pixabay |
| 預先爬好的索引 | 有（每 3 小時更新） | 有，而且你搜過的結果會存進本機索引 |

## 本機完整版（全網即時搜尋）

需要先安裝 [Docker Desktop](https://www.docker.com/products/docker-desktop/)。

```bash
git clone https://github.com/DHoper/vidscope.git
cd vidscope
docker compose up -d
```

打開 http://localhost:8080 。每次搜尋，本機的 SearXNG 會即時去多個搜尋引擎找影片，不認得的網站會再打開頁面找播放器。關閉用 `docker compose down`。

想加上 YouTube 等需要金鑰的來源：把 `.env.example` 複製成 `.env`，填入金鑰後重新 `docker compose up -d`。

不想用 Docker 也可以 `node server/index.mjs`（Node.js 18 以上），但這樣沒有全網搜尋，除非你另外跑一個 SearXNG 並設定 `SEARXNG_URL`。

## 架構

```
GitHub Actions（每 3 小時）
  └─ node crawler/index.mjs
       ├─ adapters/discover.mjs     全網影片搜尋（Brave API，需金鑰）→ 自動打開結果頁解析
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
| `BRAVE_API_KEY` | https://api-dashboard.search.brave.com → 訂閱 Search 方案 → 建立 API key。每月有 5 美元免費額度（需綁卡驗證），全網自動搜尋靠這把金鑰 |
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

### 全網自動搜尋（discover）

預設用 **SearXNG**（免費開源的搜尋聚合器）：workflow 每次執行時在 GitHub Actions 裡臨時啟動一個 SearXNG（設定在 `searxng/settings.yml`），不需要任何金鑰。若 SearXNG 啟動失敗而你有設 `BRAVE_API_KEY`，會改用 Brave；用 Brave 時建議把 `minIntervalHours` 設成 6 以控制費用。

每個關鍵字向搜尋提供者要影片結果（任何網站都可能出現），YouTube、Vimeo、Bilibili 的結果直接轉成嵌入播放；其他網站會實際打開頁面，用通用爬蟲的解析器找播放器、影片檔與下載連結。

`sources.discover` 的設定：

- `perQuery`：每個關鍵字取幾筆結果（最多 50）
- `deepLimit`：每次執行最多打開幾個結果頁做深入解析
- `minIntervalHours`：最短執行間隔。預設 6 小時，6 個關鍵字一個月約 720 次請求，在免費額度內
- `country` / `searchLang` / `safesearch`：搜尋地區、語言、安全搜尋（off / moderate / strict）

### 通用網頁爬蟲（選用）

全網搜尋已經會自動找網站；`web.seeds` 是給你想「固定深入爬某個網站」時用的：

```json
{ "url": "https://example.com/videos/", "depth": 1, "maxPages": 30, "sameHost": true, "include": "/videos/" }
{ "search": "https://example.com/search?q={query}", "depth": 1, "maxPages": 10 }
{ "sitemap": "https://example.com/video-sitemap.xml" }
```

- `search`：站內搜尋網址模板，`{query}` 會自動換成 `queries` 裡的每個關鍵字
- `sitemap`：網站的影片 sitemap，一次拿到整站影片清單
- `depth`：從起始頁往下跟連結幾層
- `maxPages`：這個起點最多抓幾頁
- `sameHost`：只跟同網域的連結（預設 true）
- `include`：只跟網址符合這個正規表示式的連結（選填）

解析順序：schema.org `VideoObject`（JSON-LD）→ Open Graph `og:video` / Twitter Card → `<video>` 標籤 → 嵌入播放器 `<iframe>` → 直接連到影片檔的連結。爬蟲會遵守 robots.txt，同一網站每次請求間隔 `delayMs` 毫秒。

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
