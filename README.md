# White2 — Discord 多功能機器人 + 網頁後台

單一 Node 程序同時執行 **Discord 機器人**與**管理後台網站**。技術棧沿用 kidcare：
Express + better-sqlite3 + 原生 JS SPA + cookie-JWT 帳密登入。

## 快速開始

```bash
npm install              # 安裝套件
cp .env.example .env     # 建立設定檔，填入 Discord Token 等
npm run seed             # 建立初始管理員帳號（讀 .env 的 ADMIN_*）
npm start                # 啟動機器人 + 後台網站
```

後台網址：`http://localhost:3999`（可用 .env 的 `PORT` 調整）

## .env 設定

| 變數 | 說明 |
|------|------|
| `DISCORD_TOKEN` | 機器人 Token（Developer Portal → Bot） |
| `DISCORD_CLIENT_ID` | 應用程式的 Client/Application ID |
| `GUILD_ID` | 主要服務的伺服器 ID |
| `PORT` | 後台網站埠號（預設 3999） |
| `JWT_SECRET` | 登入 JWT 密鑰，請用 `openssl rand -hex 32` 產生 |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `npm run seed` 建立的初始管理員 |

## Discord 機器人必要設定

到 [Developer Portal](https://discord.com/developers/applications) → 你的應用程式 → **Bot**，
開啟以下 **Privileged Gateway Intents**（否則部分功能無法運作）：

- ✅ **Server Members Intent**（加入/退出通知、生日身分組）
- ✅ **Message Content Intent**（關鍵字偵測）

## 專案結構

```
white2/
├── src/
│   ├── server.js      Express 入口（掛 API + 靜態網站 + 啟動機器人）
│   ├── db.js          better-sqlite3 連線、per-guild 設定存取
│   ├── auth.js        cookie-JWT 登入、模組權限、限流
│   ├── bot/
│   │   ├── index.js   discord.js 機器人核心（載入所有 features）
│   │   ├── commands.js  79 個 slash 指令定義
│   │   ├── perm.js    指令權限判定
│   │   └── features/  各功能模組（見下方功能總覽）
│   ├── routes/        各功能後台 API（與 features 一一對應）
│   └── util/          共用工具（brand 品牌色、time 時區、market 經濟、
│                      rankcard/rolecard/welcomecard 圖卡、ytdlp 音樂下載）
├── public/            後台網站（原生 SPA）
│   ├── index.html     後台主頁
│   ├── intro.html     機器人介紹頁（對外）
│   ├── rules.html     玩家規則手冊（冒險區完整數值與機率）
│   ├── css/style.css  設計語言（Discord blurple 主題）
│   └── js/            api.js ui.js app.js pages-*.js（每個功能一支頁面）
├── docs/stock-design.md  股市／財經新聞設計文件
├── db/schema.sql      資料庫結構
├── scripts/
│   ├── seed.js        建立管理員
│   └── register-commands.js  註冊 slash 指令
└── data/              SQLite 資料庫檔（自動產生，勿入版控）
```

## 功能總覽

每個功能都是「機器人模組 `src/bot/features/*.js` ＋ 後台 API `src/routes/*.js` ＋ 後台頁面
`public/js/pages-*.js`」三件一組，全部依 `guild_id` 分家，同一隻機器人可服務多個伺服器。

### 社群管理

| 模組 | 功能 |
|------|------|
| `keywords` | 關鍵字自動回覆（多關鍵字／限定頻道／冷卻／觸發紀錄） |
| `alerts` | 關鍵字通知與警告：通知管理員、警告累計、三次自動禁言、處分紀錄 |
| `welcome` | 加入／退出通知，歡迎圖卡、入群通知、離群明細、歷史紀錄 |
| `birthday` | 生日驗證與慶生：填寫提醒、發送去重、異動紀錄、生日身分組 |
| `announcements` | 公告：多頻道、標記、排程、循環、發送紀錄 |
| `poll` | 投票：身分組限制、修改開關、結果隱藏、倒數 |
| `giveaway` | 抽獎：保證中獎、重複中獎限制、補抽、撤銷、取消、倒數、黑名單 |
| `reminder` | 提醒：多對象、圖片、按鈕、失敗通知 |
| `tickets` | 客服單：開單、專屬頻道、關單、紀錄 |
| `reactionroles` | 表情身分組：按表情取得／移除身分組 |
| `wheel` | 角色轉盤：標籤篩選、收藏、權重、不重複、每日限制、統計 |
| `forum` | 論壇整理：貼文同步、目錄自動更新（依玩家／標籤／留言數／活動排序） |
| `xp` | 經驗值：聊天得 XP、升級身分組、排行榜圖卡 |
| `music` | 音樂：歌單、控制面板、音量、常駐語音、權限、播放紀錄 |

### 冒險生活（星幣經濟）

所有玩法共用同一份**星幣錢包**與**背包**，玩家端說明在 `/幫助` 與 `public/rules.html`。

| 模組 | 功能 |
|------|------|
| `gather` | 採集本體：`/釣魚` `/挖礦` `/伐木` `/採集` `/狩獵`，冷卻、稀有掉落、地圖每日次數、工具耐久與修理、商店購買、製作／鍛造配方、圖鑑、每日抽籤、任務與限量懸賞、賣出與富豪榜 |
| `facility` | 設施商店：農地／溫室／牧場／孵化室分 3 階購買，與 `/製作` 蓋的格子相加 |
| `ranch` | 牧場：飼養動物、各自計時產出、收成、放生、看門動物防竊、孵化室孵蛋 |
| `crops` | 種植：農地種作物、溫室種花卉、成熟倒數、採收 |
| `aquarium` | 魚缸：固定 8 格只養 SSR 魚，自動產星幣、定期餵食（餓 48 小時會死）、撈金、賣魚、偷魚 |
| `trades` | 物易物：玩家一對一以物換物，公開提案與成交公告，完全不涉及星幣 |
| `special` | 特殊兌換商店：多分店、面板發布、兌換後通知管理員處理 |
| `stock` | 財經新聞／星幣股市：掛牌股票、K 棒 tick、漲跌停、新聞衝擊、買賣手續費（銷毀回收星幣）、持股與股神榜。**預設關閉，後台開啟**。設計文件見 `docs/stock-design.md` |
| `home` | 家園：小屋 15 階、小屋簽到、家具、廚房與料理（36 道食譜／5 種品質／可複選多道與份數）、寵物、成就（59 個）、好感度與同居 |
| `affinity` | 角色：逛街隨機偶遇、送禮（喜好倍率、角色多時自動翻頁）、同居與同居能力 |
| `dex` | 圖鑑與成就：圖鑑由各系統資料自動長出，成就可裝備 3 個吃加成 |
| `tax` | 稅金：所得稅（累進）／農地稅／養殖稅、強制清算、普發救濟金 |
| `charity` | 慈善基金會：捐款抵稅、帳目公開、基金池是普發與大賽獎金的財源 |
| `auction` | 拍賣會：限時競標、出價鎖款、防狙擊延長、拍賣限定標的（稱號／寵物／素材／農地等格子）、手續費進基金會 |
| `contest` | 大賽：週賽月賽比成長量、前三名獎金（優先從基金會撥）、冠軍拿大賽限定稱號 |
| `loans` | 物資貸款：抵押工具／作物／魚、信用貸款、到期沒收 |
| `panel` | 冒險面板：管理員發布的一鍵按鈕面板，自動釘選；6 大分類＋常用捷徑下拉 |
| `help` | `/幫助` 冒險生活指令總表（僅本人可見） |

### 偷竊機制

`/偷`（牧場未收成產物）與 `/偷魚`（魚缸未領星幣）是目前唯二的玩家互相影響玩法：
有每日限次與成功率設定，看門動物／設施等級可降低被偷機率，被逮到會罰星幣，
**罰到不夠會倒扣成負數（欠款）**，要賺回來才回正。

## 後台操作備忘

- **權限**：`admin` 角色看得到全部功能；`staff` 只看得到「帳號權限」頁勾選的模組。
  常見狀況是某一頁「找不到」，其實是那個帳號沒勾到該模組（例如 `home` 小屋與成就）。
- **分頁式頁面**：「小屋與成就」把家具／廚房／寵物／成就／好感度／同居能力／角色能力／
  逛街角色／玩家現況做成標題下方那排按鈕，手機上會折成兩三行。
- **清單表格**：40 列以上會出現搜尋、欄位篩選、排序與每頁筆數；**預設全部顯示**，
  超過 200 列才自動分頁（`public/js/table-tools.js`）。
- **玩家欄位**：畫面上會自動補「伺服器暱稱」（`/api/discord/nicknames` ＋ `H.paintNicks`），
  只印名字的清單用 `H.who(user_id, username)` 產生欄位即可自動生效。
- **時間欄位**：財經快報與拍賣的開始時間只給選到「整點」（日期＋小時），因為兩者都是整點結算。
- **前端改動要升版**：`public/sw.js` 的 `SHELL` 版本號沒改，PWA 會繼續吃舊快取。

## 部署（已上線）

- 後台網址：**https://white.crownai.ink**（nginx 反向代理 → 127.0.0.1:3999，已配 Let's Encrypt 憑證）
- 以 pm2 常駐：`pm2 start src/server.js --name white2`
- 更新程式後：`pm2 restart white2`

## 加新伺服器的流程

1. 用下方邀請連結把機器人加進去
2. 陌生伺服器會被**白名單**擋下（機器人自動退出並通知你），到後台核准後再邀一次
3. 機器人上線時會**即時註冊 79 個 slash 指令**到每個已核准的伺服器，不必手動跑 `npm run register`

邀請連結（權限含禁言、踢出、管理身分組、語音）：

```
https://discord.com/oauth2/authorize?client_id=1528399550006689882&scope=bot%20applications.commands&permissions=1099783466050
```

## 多伺服器架構（已完成）

目標：同一隻機器人服務多個伺服器，單一總後台管理全部。

- [x] **階段 1：資料層地基**（已完成，2026-07-20）
  - `guilds` 表記錄所在伺服器；機器人啟動 / 被邀請時自動登錄並初始化設定
  - 所有業務資料表加 `guild_id` 欄位，現有資料回填為主伺服器
  - 8 張單例設定表（warn/welcome/birthday/verify/music/xp/ticket/forum_config）重建為 per-guild
  - `db.js` 提供 `guildConfig(table, guildId)`、`ensureGuild(guildId)`
  - 改造前備份：`backups/white2-before-multiguild-*.db`
- [x] **階段 2：機器人各模組讀寫依 guild**（全部模組完成）
- [x] **階段 3：後台伺服器切換器 + API 依 guild scope**（X-Guild-Id header + 所有路由 scope）
- [x] **階段 4：slash 指令全域註冊**（79 個指令，所有伺服器通用；機器人上線時即時註冊）
- [x] **伺服器白名單**：陌生伺服器邀請後機器人自動退出並通知你，核准後才可用

### 穩定性設定
- `client.setMaxListeners(50)`（20+ 模組共用事件）
- `unhandledRejection` / `uncaughtException` 攔截，不讓單一錯誤拖垮整個機器人
- Discord 斷線 / 重連 / 恢復都會記錄
- pm2：`--max-memory-restart 500M`、指數退避重啟、`pm2 startup` 開機自動啟動
