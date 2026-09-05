# White2 — Discord 多功能機器人 + 網頁後台

**兩隻 Discord 機器人＋一套管理後台**，同一份程式碼、同一個資料庫。用 `BOT_ROLE`
決定每個行程扮演哪一隻，各自只載入自己那一半的功能與 slash 指令：

- **璃白Yu光秘書**（`secretary`）＝功能型：音樂、抽獎、投票、客服單、論壇、歡迎、等級…（27 個指令）
- **璃白Yu光管家**（`butler`）＝遊戲型：冒險、農牧、家園、股市、稅務、拍賣…（76 個指令）

拆成兩隻的主因是**單一機器人最多只能註冊 100 個 slash 指令**，而全部功能加起來已達 103 個。
順帶的好處是秘書不會跑遊戲排程、管家不會佔著語音頻道。

技術棧沿用 kidcare：Express + better-sqlite3 + 原生 JS SPA + cookie-JWT 帳密登入。

## 快速開始

```bash
npm install              # 安裝套件
cp .env.example .env     # 建立設定檔，填入 Discord Token 等
npm run seed             # 建立初始管理員帳號（讀 .env 的 ADMIN_*）
npm run start:secretary  # 秘書 + 後台網站
npm run start:butler     # 管家（WEB=0，只跑機器人）
```

兩個行程都要開。第二隻一定要帶 `WEB=0`，否則會搶同一個埠（EADDRINUSE）。

後台網址：`http://localhost:3999`（可用 .env 的 `PORT` 調整），掛在秘書那個行程上。

## .env 設定

| 變數 | 說明 |
|------|------|
| `BOT_ROLE` | 這個行程扮演誰：`secretary` / `butler`；不設＝`both`（舊的單機器人模式，會超過指令上限） |
| `WEB` | `0` ＝這個行程不啟動後台網站。兩隻裡的第二隻必須設 |
| `DISCORD_TOKEN` | 秘書的 Bot Token（Developer Portal → Bot） |
| `DISCORD_TOKEN_BUTLER` | 管家的 Bot Token（另一個 Application） |
| `DISCORD_CLIENT_ID` | 秘書應用程式的 Client/Application ID |
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
│   ├── subscription.js  每台伺服器 × 每隻機器人的訂閱方案與付費牆
│   ├── bot/
│   │   ├── index.js   discord.js 機器人核心（載入所有 features）
│   │   ├── commands.js  103 個 slash 指令定義（秘書 27 ＋ 管家 76）
│   │   ├── roles.js   BOT_ROLE 角色拆分：誰載入哪些模組、註冊哪些指令
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

下面兩張表也就是**秘書／管家的分工界線**：社群管理歸秘書，冒險生活歸管家。
哪個模組歸誰定義在 `src/bot/roles.js`。

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
| `wheel` | 角色轉盤：標籤篩選、收藏、權重、不重複、每日限制、統計、**換底圖排程**（排好幾月幾號換哪張，時間到自動換） |
| `postwheel` | 貼文轉盤：`/貼文轉盤` 從指定貼文的留言者中隨機抽選（貼文欄位留空＝自動抓該頻道最近那則）。預設一人一票，洗留言不加機率；後台「貼文轉盤」頁存每次抽選紀錄，可看中獎名單並排除已中獎的人**補抽** |
| `forum` | 論壇整理：貼文同步、目錄自動更新（依玩家／標籤／留言數／活動排序） |
| `xp` | 經驗值：聊天得 XP、升級身分組、排行榜圖卡 |
| `music` | 音樂：歌單、控制面板、音量、常駐語音、權限、播放紀錄 |

### 冒險生活（星幣經濟）

所有玩法共用同一份**星幣錢包**與**背包**，玩家端說明在 `/幫助` 與 `public/rules.html`。

| 模組 | 功能 |
|------|------|
| `gather` | 採集本體：`/釣魚` `/挖礦` `/伐木` `/採集` `/狩獵`，冷卻、稀有掉落、地圖每日次數、工具耐久與修理、商店購買、製作／鍛造配方（依分類選擇，可設**製作手續費 %** 與**全域額外失敗率 %**）、圖鑑、任務與限量懸賞、賣出。**工具壞掉＝直接沒工具**，不會自動退回低階那把。**每日抽籤已於 2026-09 下架**，簽到成為唯一的每日免費星幣來源；**富豪榜改管理端專用** |
| `facility` | 設施商店：農地／溫室／牧場／孵化室分 3 階購買，與 `/製作` 蓋的格子相加 |
| `ranch` | 牧場：飼養動物、各自計時產出、收成、放生、看門動物防竊、孵化室孵蛋。可設**產物腐壞率**（每份各自擲骰，壞掉直接丟） |
| `crops` | 種植：農地種作物、溫室種花卉、成熟倒數、採收。可設**枯死率**（採收時每格擲骰，中了整格沒收成） |
| `aquarium` | 魚缸：固定 8 格只養 SSR 魚，自動產星幣、定期餵食（餓 48 小時會死）、撈金、賣魚、偷魚 |
| `trades` | 物易物與轉帳：玩家一對一以物換物，公開提案與成交公告。**轉帳手續費 200 星幣＋二次確認**；禮物**禁止交易**，只能低價賣回 |
| `special` | 特殊兌換商店：多分店、面板發布、兌換後通知管理員處理 |
| `stock` | 世界動態／星幣股市：掛牌股票、K 棒 tick、漲跌停、新聞衝擊、買賣手續費 1.5%（銷毀回收星幣）、持股。原「財經新聞」已擴充為**世界動態**（整合遊戲公告）；**股神榜改管理端專用**，玩家只看得到自己的損益。持股上限 500（所有股票加總）、禁當沖。**預設關閉，後台開啟**。**大標（分類）可自訂**，玩家端依大標分組顯示，一則可附最多 5 個連結。設計文件見 `docs/stock-design.md` |
| `home` | 家園：小屋 15 階、小屋簽到、家具、廚房與料理（36 道食譜／5 種品質／可複選多道與份數）、寵物、成就（59 個）、好感度與同居 |
| `affinity` | 角色：逛街**隨機事件制**（遇到角色的機率已大幅降低）、送禮（喜好倍率、角色多時自動翻頁）、同居與同居能力。同居與寵物**沒有數量上限**，轉盤名單與同居名單完全分離；同居角色可指派「工作區域」，一位角色即可包辦該區完整自動化；**收成／照顧類每 5 分鐘不間斷執行**（成熟就收、收完補種），只有每日配給類是每天 8:40 一次。工作區域**鎖定對應能力**（挖礦助手不能去種田），對不上的角色會**罷工**；區域含 🌾農地／🏡溫室／🐄牧場／🥚孵化室／🐠魚缸／🍳廚房。玩家請同居對象**搬走＝好感度歸零**（只留「相遇過」），擋掉「繳稅前先請人搬走」的規避玩法。玩家與後台都查得到**同居明細**（他今天做了什麼） |
| `dex` | 圖鑑與成就：圖鑑由各系統資料自動長出，成就可裝備 3 個吃加成 |
| `tax` | 稅金：**四稅各自獨立計算**——所得稅（只課本期實際賺到的錢，含股票已實現損益）／同居稅（依同居角色數倍增累進）／寵物稅（依寵物數倍增累進）／房屋稅（依房屋等級）。只從錢包扣、扣到 0 為止不會變負數，缺繳記在稅單上。**依資產課稅的農地稅／養殖稅預設停徵但可在後台重新開徵**（計算已恢復，含免稅格數與設施等級加成）；證券稅／消費稅則整套移除 |
| `charity` | 慈善基金會：捐款抵稅、帳目公開、基金池是普發與大賽獎金的財源 |
| `auction` | 拍賣會：限時競標、出價鎖款、防狙擊延長、拍賣限定標的（稱號／寵物／素材／農地等格子）、手續費進基金會、**可設定參加資格身分組**或**累計捐款門檻** |
| `contest` | 大賽：週賽月賽比成長量、前三名獎金（優先從基金會撥）、冠軍拿大賽限定稱號 |
| `loans` / `bank` | 銀行：**存款**（錢包↔銀行自由存提、按日生息，存提款不算收入不課稅）＋**信用貸款**（免抵押、利息較高）。**物資貸款／物資抵押已於 2026-09 停辦**，既有未還清的仍可 `/還款` 並贖回抵押品 |
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
- **管家才做得到的按鈕**：神秘商店「發布面板」、稅金「立即結算／試算」、貸款「立即處理到期貸款」
  是派工給管家執行的（見下方「兩隻機器人之間怎麼合作」），按下去要等幾秒；
  管家沒上線會提示「工作已排入佇列」，上線後自動補做。
- **前端改動要升版**：`public/sw.js` 的 `SHELL` 版本號沒改，PWA 會繼續吃舊快取。

## 兩隻機器人之間怎麼合作（跨行程派工）

拆成兩個行程之後有兩條**不能違反的規則**，違反了功能會整個不能用（神秘商店就踩過）：

1. **面板要由誰發，互動就只會回給誰。** Discord 把按鈕／下拉選單的互動送給
   「發出那則訊息的應用程式」。遊戲類面板（神秘商店、冒險面板…）一定要由**管家**發，
   秘書代發的面板玩家點了沒有任何人接。舊的單機器人時代發的面板都已失效，
   重新發布一次即可（`publishShop()` 會自動刪掉別人發的舊訊息再重發）。
2. **後台網站跑在秘書的行程裡，拿不到管家的 `client._xxx`。** 後台要觸發只有管家做得到的
   動作時，不能直接呼叫 —— 那個函式在這個行程根本不存在，只會回「機器人尚未上線」。

所以有一張 `bot_jobs` 工作佇列當橋（`db.js`）：

```js
// 後台端：本行程有就直接呼叫，沒有就派工給管家，等它做完拿回傳值（預設等 10 秒）
const r = (client && client._runTax) ? await client._runTax(gid, opts)
        : await runBotJob('butler', 'run_tax', { guildId: gid, opts }, { timeoutMs: 30000 });

// 機器人端（功能模組的 init 裡）：登記自己接哪種工作
client._jobHandlers.run_tax = ({ guildId, opts }) => runGuild(client, guildId, opts);
```

各行程每 1.5 秒撈一次屬於自己角色的工作（`bot/index.js` 的 `startJobWatch()`），
執行結果寫回 `bot_jobs.result`／`error`。那隻沒上線時工作留在佇列，上線後自動補做，
後台則顯示「已排入佇列」。目前走這條路的有：**神秘商店發布面板、稅金結算／試算、
貸款到期催收**。日後在後台加「管家才做得到」的按鈕，照同一個模式加一個 `kind` 即可。

## 訂閱制度

每台伺服器、**每隻機器人各自一份**訂閱狀態（秘書買了不代表管家也能用），存在
`guild_subscriptions`，方案內容存在 `plans`，全部可在後台「訂閱管理」頁改，不寫死在程式裡。

- 付費牆做在**指令註冊層**：方案沒包含的功能，指令直接不註冊到那台伺服器——
  玩家看不到也點不到，比「點了才說要付費」乾淨（見 `bot/index.js` 的 `allowedCommands()`）
- 到期自動降級成 `free`，**不刪任何資料**，續費後原樣恢復、進度不重置
- 續費／升降級／到期後呼叫 `refreshGuildCommands()` 即時生效，不必重啟
- 功能鍵（付費牆的最小顆粒）定義在 `subscription.js` 的 `FEATURE_KEYS`，
  指令對應到哪個功能鍵見 `roles.js` 的 `COMMAND_FEATURE`；沒列到的指令視為
  基本功能，任何方案都能用（例如 `/幫助`、`/錢包`、`/簽到`）

內建方案：秘書 `free` / `standard` / `pro`，管家 `free` / `basic` / `advanced`。

## 部署（已上線）

- 後台網址：**https://white.crownai.ink**（nginx 反向代理 → 127.0.0.1:3999，已配 Let's Encrypt 憑證）
- 以 pm2 常駐**兩個行程**：

  ```bash
  BOT_ROLE=secretary pm2 start src/server.js --name white2-secretary --cwd /root/discord/white2 --update-env
  BOT_ROLE=butler WEB=0 pm2 start src/server.js --name white2-butler --cwd /root/discord/white2 --update-env
  ```

- 更新程式後：`pm2 restart white2-secretary white2-butler`
- 只改了其中一隻的 Token／功能時，也可以只重啟那一隻

## 加新伺服器的流程

1. 用下方邀請連結把機器人加進去——**兩隻要各邀一次**，秘書和管家是不同的 Discord 應用程式
2. 陌生伺服器會被**白名單**擋下（機器人自動退出並通知你），到後台核准後再邀一次
3. 機器人上線／被邀請時會**即時註冊** slash 指令到該伺服器（秘書 27 個、管家 76 個，
   實際數量再依該台的訂閱方案過濾），不必手動跑 `npm run register`

邀請連結（權限含禁言、踢出、管理身分組、語音）：

```
# 璃白Yu光秘書
https://discord.com/oauth2/authorize?client_id=1528399550006689882&scope=bot%20applications.commands&permissions=1099783466050

# 璃白Yu光管家
https://discord.com/oauth2/authorize?client_id=1545612660656185344&scope=bot%20applications.commands&permissions=1099783466050
```

⚠️ 授權頁的伺服器下拉選單要選對，選錯就會把機器人加進不相干的伺服器。

## 憑證放哪裡

兩隻的 Token / Client ID / Client Secret 都可以在後台**「機器人帳號」頁**設定，
不必 SSH 上機器改 `.env`。優先序：**後台設定 → 角色專屬環境變數 → 舊的 `DISCORD_TOKEN`**。

- Token 與 Client Secret 存檔後只顯示末 4 碼，原文不會回到瀏覽器；欄位留空＝不變更
- 名稱／頭像／狀態存檔即時套用；**Token 改了要重啟該行程**才生效
- 管家的 Client ID／Secret 另外用於 `/play` 玩家 App 的 Discord 登入
  （`routes/play.js`），Developer Portal 要把
  `https://white.crownai.ink/play/auth/callback` 加進該應用程式的 OAuth2 Redirects

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
- [x] **階段 4：slash 指令即時註冊**（機器人上線／被邀請時直接註冊到該伺服器，立即生效）
- [x] **階段 5：秘書／管家拆成兩隻機器人**（解除 100 指令上限）＋**每台伺服器的訂閱制度**
- [x] **伺服器白名單**：陌生伺服器邀請後機器人自動退出並通知你，核准後才可用

### 穩定性設定
- `client.setMaxListeners(50)`（20+ 模組共用事件）
- `unhandledRejection` / `uncaughtException` 攔截，不讓單一錯誤拖垮整個機器人
- Discord 斷線 / 重連 / 恢復都會記錄
- pm2：`--max-memory-restart 500M`、指數退避重啟、`pm2 startup` 開機自動啟動
- Discord 連不上超過一定時間會主動 `process.exit(1)`，讓 pm2 重新拉起（見 `bot/index.js`）
