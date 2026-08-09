# 星幣股市 · 完整設計

> 目標：零美術成本的星幣回收池，靠「每小時看盤」把玩家拉回來。
> 前提：完全沿用現行架構（`src/bot/features/*.js` + `src/routes/*.js` + `public/js/pages-*.js` + `db/schema.sql`），不引入新套件。

---

## 0. 先解決前置問題：星幣供給已經壞掉

上線前**必須**處理，否則股市第一天就結束：

| 帳號 | 餘額 |
|---|---|
| rie_816 | 9,999,999,999,976,370 |
| kumoru2648 | 9,999,999,999,938,548 |
| yu_mumu. | 99,999,999,935,230 |
| sweet_0722 | 9,999,999,932,294 |
| 一般玩家 | 400 ～ 800 |

三選一（建議 A＋C）：

- **A. 幣改**：把四個異常帳號歸零或壓到 5,000 以內，公告是測試餘額回收。
- **B. 不動餘額，但股市用「持股上限」隔離**：每人每支股最多持有 `max_shares_per_user`，錢再多也吃不下整個盤。
- **C. 加後台防呆**：`econ_wallets.coins` 寫入時上限檢查（例如單次給幣 ≤ 1,000,000），避免再發生。

B 是股市內建的（見 §4），A/C 是外部治理。**只做 B 也能開，但通膨問題不會被股市解決**——因為回收量相對 10^16 等於零。

---

## 1. 核心規則（玩家視角）

- 開 **6 支股**，價格單位＝星幣，起始價 50～500。
- **每小時整點**（台北時間）所有股票結算一次新價，寫一根 K 棒。
- 玩家用 `/買股`、`/賣股` 交易，**手續費 2%（買賣各收）直接銷毀**——這就是回收池。
- 有 **漲跌停 ±20%/小時**，不會一夜歸零（除非管理員刻意把 `floor_price` 設成負值）。
- 有 **持股上限**，防巨鯨。
- **沒有融資、沒有做空、沒有槓桿**：星幣不能變成負數（`/偷` 已經有負債機制了，不要再開一個坑）。
- 管理員可以發 **📰 財經新聞**，讓某支股在下一次結算暴漲暴跌。

---

## 2. 資料表（追加到 `db/schema.sql`，全部帶 `guild_id`）

```sql
-- 每台伺服器一組設定
CREATE TABLE IF NOT EXISTS stock_config (
  guild_id          TEXT PRIMARY KEY,
  enabled           INTEGER NOT NULL DEFAULT 1,
  channels          TEXT    NOT NULL DEFAULT '',   -- 允許下指令的頻道（沿用 gather_config.channels 格式）
  tick_minutes      INTEGER NOT NULL DEFAULT 60,   -- 幾分鐘結算一次
  fee_pct           INTEGER NOT NULL DEFAULT 2,    -- 買賣手續費 %（銷毀，不進任何人口袋）
  limit_pct         INTEGER NOT NULL DEFAULT 20,   -- 單次結算漲跌停 %
  min_trade         INTEGER NOT NULL DEFAULT 1,    -- 單筆最少股數
  max_trade         INTEGER NOT NULL DEFAULT 100,  -- 單筆最多股數
  max_shares        INTEGER NOT NULL DEFAULT 500,  -- 每人每支股持有上限（0＝無限）
  trade_cooldown_s  INTEGER NOT NULL DEFAULT 30,   -- 兩次交易間隔
  daily_trade_limit INTEGER NOT NULL DEFAULT 0,    -- 每日交易次數上限（0＝無限）
  news_channel      TEXT    NOT NULL DEFAULT '',   -- 財經新聞＋收盤報告發哪
  report_hour       INTEGER NOT NULL DEFAULT 21,   -- 每日收盤報告時間（台北時）
  burned_total      INTEGER NOT NULL DEFAULT 0,    -- 累計銷毀的星幣（回收 KPI）
  seeded            INTEGER NOT NULL DEFAULT 0
);

-- 股票本身
CREATE TABLE IF NOT EXISTS stock_symbols (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id     TEXT NOT NULL DEFAULT '',
  code         TEXT NOT NULL,                      -- 4 碼代號，例如 2330
  name         TEXT NOT NULL,
  emoji        TEXT NOT NULL DEFAULT '',
  price        INTEGER NOT NULL DEFAULT 100,       -- 目前價（整數，避免浮點誤差）
  anchor       INTEGER NOT NULL DEFAULT 100,       -- 均值回歸的錨（長期合理價）
  vol_pct      INTEGER NOT NULL DEFAULT 8,         -- 波動率 %（每 tick 標準差）
  drift_pct    INTEGER NOT NULL DEFAULT 0,         -- 長期趨勢 %／tick，可負
  revert_pct   INTEGER NOT NULL DEFAULT 10,        -- 回歸強度 %（0＝純隨機遊走）
  floor_price  INTEGER NOT NULL DEFAULT 10,        -- 下限；設 0 或負值該股就能跌破零
  ceil_price   INTEGER NOT NULL DEFAULT 100000,
  description  TEXT NOT NULL DEFAULT '',
  sort         INTEGER NOT NULL DEFAULT 0,
  enabled      INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_code ON stock_symbols(guild_id, code);

-- K 線（一根＝一個 tick）
CREATE TABLE IF NOT EXISTS stock_prices (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id  TEXT NOT NULL DEFAULT '',
  symbol_id INTEGER NOT NULL,
  ts        INTEGER NOT NULL,                      -- 該 tick 的整點 unix ms
  open      INTEGER NOT NULL,
  high      INTEGER NOT NULL,
  low       INTEGER NOT NULL,
  close     INTEGER NOT NULL,
  volume    INTEGER NOT NULL DEFAULT 0,            -- 該 tick 內的成交股數
  news_id   INTEGER NOT NULL DEFAULT 0             -- 有新聞影響時記下來
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_px ON stock_prices(guild_id, symbol_id, ts);

-- 持股
CREATE TABLE IF NOT EXISTS stock_holdings (
  guild_id  TEXT NOT NULL DEFAULT '',
  user_id   TEXT NOT NULL,
  symbol_id INTEGER NOT NULL,
  shares    INTEGER NOT NULL DEFAULT 0,
  cost_sum  INTEGER NOT NULL DEFAULT 0,            -- 累計成本（含手續費）→ 算平均成本與損益
  PRIMARY KEY (guild_id, user_id, symbol_id)
);

-- 成交紀錄（對帳、排行、防作弊都靠它）
CREATE TABLE IF NOT EXISTS stock_trades (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id  TEXT NOT NULL DEFAULT '',
  user_id   TEXT NOT NULL,
  username  TEXT NOT NULL DEFAULT '',
  symbol_id INTEGER NOT NULL,
  side      TEXT NOT NULL,                         -- 'buy' | 'sell'
  shares    INTEGER NOT NULL,
  price     INTEGER NOT NULL,                      -- 成交單價
  fee       INTEGER NOT NULL,
  pnl       INTEGER NOT NULL DEFAULT 0,            -- 賣出才有：已實現損益
  ts        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stock_tr ON stock_trades(guild_id, user_id, ts);

-- 財經新聞（管理員發的事件）
CREATE TABLE IF NOT EXISTS stock_news (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id    TEXT NOT NULL DEFAULT '',
  symbol_id   INTEGER NOT NULL DEFAULT 0,          -- 0＝影響全市場
  headline    TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  impact_pct  INTEGER NOT NULL DEFAULT 0,          -- 對下一個 tick 的額外漲跌 %
  vol_mult    INTEGER NOT NULL DEFAULT 100,        -- 波動率倍率 %（150＝當 tick 波動 ×1.5）
  effect_ts   INTEGER NOT NULL DEFAULT 0,          -- 生效的 tick（0＝下一個 tick）
  applied     INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 交易冷卻／每日次數
CREATE TABLE IF NOT EXISTS stock_user_state (
  guild_id     TEXT NOT NULL DEFAULT '',
  user_id      TEXT NOT NULL,
  last_trade_ms INTEGER NOT NULL DEFAULT 0,
  day_key      TEXT NOT NULL DEFAULT '',
  day_trades   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id)
);
```

---

## 3. 定價引擎

### 3.1 每 tick 的公式

整數運算，`price` 用星幣整數存，避免浮點漂移：

```js
// 常態亂數（Box-Muller），限制在 ±3σ 免得偶爾出現離譜值
function gauss() {
  const u = Math.max(1e-9, Math.random()), v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.max(-3, Math.min(3, z));
}

function nextPrice(s, news) {
  const vol   = (s.vol_pct / 100) * ((news?.vol_mult ?? 100) / 100);
  const drift = s.drift_pct / 100;
  // 均值回歸：離錨越遠，拉回力道越大（避免長期單邊跑飛）
  const gap    = (s.anchor - s.price) / s.price;
  const revert = gap * (s.revert_pct / 100);
  const shock  = (news?.impact_pct ?? 0) / 100;

  let change = drift + revert + shock + vol * gauss();

  // 漲跌停
  const lim = cfg.limit_pct / 100;
  change = Math.max(-lim, Math.min(lim, change));

  // 步幅用「絕對值」當基準，股價逼近 0 時仍留最小跳動，才能真的穿越零線
  const base = Math.abs(s.price);
  const step = Math.max(base, Math.abs(s.anchor) * 0.02, 1) * change;
  const px = Math.round(s.price + step);
  return Math.max(s.floor_price, Math.min(s.ceil_price, px));
}
```

**為什麼步幅要改成加法**：原本寫 `price * (1 + change)` 是純乘法，數學上永遠碰不到 0，
`floor_price` 又被寫死至少 1，股價不可能變負數。改成「基準 × 漲跌% 的加法步幅」後，
只要把該股的 `floor_price` 設成 0 或負值，股價就能真的跌破零。相關配套：

- `changePct` 的分母改用 `|前價|`，前價為負時漲跌方向才不會顛倒
- K 棒的 `low` 不再夾在 1，振幅用 `|open|` 計算
- **現價 ≤ 0 禁止買進**（否則買股票等於白領錢）
- **負價賣出＝認賠出清**，拿 0 星幣但不會倒扣錢包

**為什麼要有 `revert`（均值回歸）**：純隨機遊走跑一個月會出現「某支 3 元、某支 40 萬」的畸形盤，玩家會覺得系統壞了。10% 的回歸強度可以讓價格在錨附近呼吸，但短期照樣刺激。

**為什麼 K 棒的 high/low 要另外擲**：只有 open/close 的 K 線很醜。`high = max(open,close) * (1 + |gauss()| * vol/3)`、`low` 反之，純視覺用，不影響成交。

### 3.2 tick 怎麼跑（重要：這台機器會重啟）

`pm2` 顯示 white2 已重啟 21 次。**單純靠 `cron.schedule('0 * * * *')` 會斷檔**，K 線出現破洞。做法：

```js
// 啟動時 + 每個整點都呼叫，內部自己補齊漏掉的 tick
function catchUp(gid) {
  const cfg = scfg(gid);
  const step = cfg.tick_minutes * 60000;
  const last = lastTickTs(gid) || alignDown(Date.now(), step);
  for (let ts = last + step; ts <= alignDown(Date.now(), step); ts += step) {
    runTick(gid, ts);                  // 每個缺的 tick 都補一根
  }
}
cron.schedule('0 * * * *', () => { for (const g of enabledGuilds()) catchUp(g); },
  { timezone: 'Asia/Taipei' });        // ← 伺服器是 UTC，一定要指定
```

一次補太多（例如停機三天＝72 根）時，補完只公告「已補齊 N 根」，不要每根都發訊息。

### 3.3 成交價：用現價，不用下一 tick

一開始就用「下一 tick 結算」聽起來公平，但玩家體感是「我下單了卻不知道買到多少」，會很煩。**直接用現價成交**，配上 §5 的內線防護就夠了。成交會累加該 tick 的 `volume`，收盤報告拿來當「成交量」呈現（純展示，不影響定價——真做量價連動會被巨鯨操縱）。

---

## 4. 交易規則

| 項目 | 值 | 理由 |
|---|---|---|
| 手續費 | 買賣各 2% | 回收池主體；來回一趟吃掉 4%，抑制無腦當沖 |
| 單筆股數 | 1 ～ 100 | 防一次吃光 |
| 每人每支股上限 | 500 股 | **巨鯨防線**，錢再多也買不完 |
| 交易冷卻 | 30 秒 | 防洗量、防搶新聞 |
| 每日交易次數 | 預設不限，可設 | 需要時再收緊 |
| 漲跌停 | ±20%／tick | 一天最多 ×1.2^24，但實務上有回歸壓著 |
| 融資／做空 | **不做** | 星幣不能負；要避免第二個負債系統 |

**買入**
1. 檢查 enabled／頻道／冷卻／每日次數
2. `cost = price * shares`、`fee = ceil(cost * fee_pct / 100)`
3. 餘額 ≥ `cost + fee`，且 `holdings.shares + shares ≤ max_shares`
4. 交易內：扣 `econ_wallets.coins`、`holdings.shares += shares`、`cost_sum += cost + fee`、寫 `stock_trades`、`stock_config.burned_total += fee`

**賣出**
1. 持股足夠
2. `gross = price * shares`、`fee = ceil(gross * fee_pct/100)`、`net = gross - fee`
3. 平均成本 `avg = cost_sum / shares`，已實現損益 `pnl = net - avg * shares`
4. 加錢、扣股、`cost_sum -= avg * shares`、寫紀錄、`burned_total += fee`

**注意**：所有寫入包在 `db.transaction()` 裡（`facility.js:130` 已是這個寫法）。按鈕互動可能連點，交易前先 `deferReply` 再處理。

---

## 5. 財經新聞（管理員事件）

後台「發布新聞」表單：標的（或全市場）、標題、內文、`impact_pct`、`vol_mult`、生效時間。

- 生效點固定在**下一個整點 tick**，公告時就寫明「將於 XX:00 反映」。
- 這是刻意的：公告到生效之間的空窗，就是**喊單與搶進的黃金時段**，社群行為從這裡長出來。
- **內線防護**：發布新聞的管理員帳號，從發布到生效期間**禁止交易該股**（`stock_trades` 有紀錄，事後也查得到）。這條寫進程式，不靠自律。
- 隨機新聞（可選）：後台建一個新聞池，每天挑 1～2 則自動發，`impact_pct` 從池子的區間隨機。管理員不在線也有波瀾。

範例（用伺服器的梗命名，這裡先放預設 6 支）：

| 代號 | 名稱 | 起始價 | 波動率 | 個性 |
|---|---|---|---|---|
| 2330 | 🐔 白光雞蛋 | 60 | 4% | 牛皮股，新手練習 |
| 2317 | 🪓 秘境礦業 | 180 | 9% | 跟著採集梗走 |
| 2454 | 🎵 星光電台 | 320 | 7% | 音樂頻道梗 |
| 6666 | 🕵️ 偷偷樂控股 | 95 | 14% | 高波動，賭徒最愛 |
| 8888 | 🍀 幸運符生技 | 240 | 11% | 抽籤梗 |
| 0050 | 🌿 冒險大盤 | 500 | 3% | 定存股，穩 |

`vol_pct` 一定要拉開差距：牛皮股給新手安全感，妖股給老手刺激。全部設成 8% 的話盤面會很無聊。

---

---

## 5.5 全服新聞快報：一則新聞同時打股票、菜價、副產品

**做得到，而且不用改任何既有價格資料。**做法是在「基準價」之上加一層**行情倍率**，新聞只寫倍率，不動 `gather_items.price`。隨時可以關掉，關掉就回到原價。

### 為什麼技術上可行

賣價目前是直接讀 `gather_items.price`。而分類資訊已經現成：

- **菜價** ← `crop_seeds.product_item_id`（20 種種子對應的作物與花卉）
- **副產品** ← `ranch_animals.product_item_id`（雞蛋、羊毛、牛奶、蜂蜜…）
- **採集素材** ← `gather_items.kind`（fish / mine / wood / forage / hunt）
- **個別物品** ← `gather_items.id`

所以「花卉全面漲三成」「蛋價腰斬」「礦價暴漲」都只是一句 SQL 條件。

### 新增一張表

```sql
-- 行情倍率：新聞的效果都落在這裡，有時效，過期自動失效
CREATE TABLE IF NOT EXISTS market_modifiers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id   TEXT NOT NULL DEFAULT '',
  news_id    INTEGER NOT NULL DEFAULT 0,
  scope      TEXT NOT NULL,        -- 'item' | 'crop' | 'ranch' | 'kind' | 'stock' | 'all'
  scope_key  TEXT NOT NULL DEFAULT '',  -- scope='item'→item_id；'kind'→'mine'；'stock'→symbol_id
  mult_pct   INTEGER NOT NULL DEFAULT 100,  -- 130＝漲三成、70＝跌三成
  start_ts   INTEGER NOT NULL,
  end_ts     INTEGER NOT NULL,     -- 到期自動失效，不需要清理排程
  label      TEXT NOT NULL DEFAULT ''   -- 顯示用：「蛋荒」「花季」
);
CREATE INDEX IF NOT EXISTS idx_mm ON market_modifiers(guild_id, end_ts);
```

`stock_news` 改名為 **`market_news`**（一則新聞可以掛好幾條 modifier），欄位加：

```sql
kind        TEXT NOT NULL DEFAULT 'market',  -- 'market' | 'stock' | 'both'
duration_h  INTEGER NOT NULL DEFAULT 6,      -- 物價效果持續幾小時（股票是一次性衝擊）
image_url   TEXT NOT NULL DEFAULT ''         -- 快報配圖，可留空
```

### 價格 helper（唯一入口）

```js
// 一則物品的「現在賣價」＝ 基準價 × 所有生效中的倍率
function livePrice(gid, item) {
  const now = Date.now();
  const mods = activeMods(gid, now);              // 一次查詢，同一次互動內快取
  let mult = 1;
  for (const m of mods) {
    if (m.scope === 'all') mult *= m.mult_pct / 100;
    else if (m.scope === 'item'  && +m.scope_key === item.id)   mult *= m.mult_pct / 100;
    else if (m.scope === 'kind'  && m.scope_key === item.kind)  mult *= m.mult_pct / 100;
    else if (m.scope === 'crop'  && cropItemIds(gid).has(item.id))  mult *= m.mult_pct / 100;
    else if (m.scope === 'ranch' && ranchItemIds(gid).has(item.id)) mult *= m.mult_pct / 100;
  }
  mult = Math.max(0.4, Math.min(2.5, mult));      // 硬上下限，防疊加失控
  return Math.max(1, Math.round(item.price * mult));
}
```

**改動範圍**：`gather.js`／`ranch.js`／`crops.js` 裡跟 `.price` 有關的約 43 處，其中真正要改的是**賣出與顯示賣價的約 10 處**。

**刻意不套用倍率的地方**（重要）：
- 工具售價、修理費
- 種子售價、動物售價、設施等級價
- 特殊兌換商店

理由：如果「買價」和「賣價」同時浮動，玩家會找到無風險套利。目前系統天然安全——**買的東西和賣的東西不是同一個物品**（買種子賣作物、買動物賣蛋），中間隔著時間成本。這條界線一旦破了就會被印鈔，別動它。

### 新聞快報長什麼樣

發在 `news_channel`，一則 embed：

```
📰 白光財經快報 · 8/1 20:00

🥚 蛋雞流感席捲南區牧場
產蛋量預估下滑三成，蛋商已開始搶貨。

📈 影響（未來 6 小時）
　🥚 副產品　賣價 ×1.4
　🐔 白光雞蛋 2330　下一盤 +12%
　🌾 菜價　　賣價 ×0.9

⏰ 20:00 ～ 02:00　·　輸入 /行情 查看目前價格
```

同一則新聞同時推高蛋價（實物）與雞蛋股（股票），這就是你要的「認知上的一則新聞快報」。玩家的反應鏈會自己長出來：**看到快報 → 衝去收成賣蛋 → 順手買雞蛋股 → 六小時後蛋價回落，沒賣掉的人哀嚎**。

### 玩家怎麼看得到

- 新增 `/行情`：列出目前所有生效中的倍率，漲的綠、跌的紅，附到期倒數
- `/賣出` 面板在有倍率時，單價後面標記 `120（📈 ×1.4）`，讓人知道現在賣賺到
- `/背包` 顯示「目前總值」時一併套用
- 新聞快報結束時自動發一則「行情回穩」小公告（可關閉）

### 管理員怎麼控制漲跌

後台「發布快報」一頁到底：

1. 標題、內文、配圖
2. 加效果（可加很多條）：選 scope（某物品／菜價／副產品／某類採集／某支股／全市場）＋ 倍率或漲跌 %
3. 持續時間（物價）；股票是下一個 tick 一次性衝擊
4. **預覽**：送出前顯示「雞蛋 6 → 8、羊毛 17 → 24」，避免手滑打錯一個零
5. 排程或立即發布

**同時準備一個新聞範本庫**：常用的十幾則（蛋荒、花季、礦坑崩塌、豐收、大盤震盪…）存成範本，一鍵套用改個數字就發，不用每次重寫。管理員懶得寫文案時，這個決定了功能會不會被持續使用。

### 兩個必須守住的護欄

1. **長期要對稱**。只發利多＝變相印鈔，三週後星幣又爆炸。建議後台儀表板放一個「近 30 天平均倍率」，維持在 1.0 附近；偏離就自動提醒。
2. **不要影響已經收成的東西**。倍率只作用在「賣出當下」，不追溯背包裡的庫存價值——不然會有人囤一年的蛋等一次蛋荒，變成純儲值遊戲。真想防囤積可以加「庫存超過 N 個時，超出部分只能賣 base 價」，但先不做，觀察再說。

### 這件事的順序

**建議物價新聞先做、股票後做**。理由：物價新聞立刻對所有玩家有感（大家都在賣東西），不需要學任何新概念；股市要玩家先理解買賣損益，門檻高。先用新聞把「每天回來看快報」的習慣養起來，股市推出時才有人氣。

對應到 §9 的階段表，插在最前面：

| 階段 | 內容 |
|---|---|
| **0** | `market_modifiers` ＋ `livePrice()` ＋ `/行情` ＋ 後台發快報 → **只有物價浮動，沒有股票** |
| 1～5 | 照原表，股市接上同一套新聞系統 |

---

## 6. 指令與介面

### 指令（加進 `src/bot/commands.js`，目前 65 個）

| 指令 | 說明 |
|---|---|
| `/股市` | 全盤報價：代號、現價、漲跌幅、迷你走勢 |
| `/個股 <代號>` | 單支詳情＋K 線＋你的持股損益 |
| `/買股 <代號> <股數>` | 買 |
| `/賣股 <代號> <股數>` | 賣（股數可填「全部」） |
| `/持股` | 我的投資組合、總市值、總損益 |
| `/股神榜` | 依「已實現損益＋未實現損益」排行 |

面板按鈕沿用現行 `adv:` 慣例：`adv:stock`（開盤面板）、`stk:buy:<id>`、`stk:sell:<id>`、`stk:chart:<id>`。回覆一律 `MessageFlags.Ephemeral`（`rules.html` 已經對玩家承諾「結果只有你自己看得到」）。

### K 線：純文字就夠

Discord 端用 sparkline，零成本、手機看得清楚：

```
🪓 秘境礦業 2317        184 ▲ +4.5%
▁▂▃▅▄▆█▇▅▄▃▄▆█▇▆▅▄▅▆▇█  24h
高 201 · 低 168 · 量 3,420
```

用 `▁▂▃▄▅▆▇█` 八階，把 24 根 close 正規化到 0-7。漲綠跌紅用 embed 顏色（現行 `brandColor()` 之外，漲用 `0x2C6455`、跌用 `0x9C3F37`，和 `rules.html` 的 `--deep`／`--thorn` 同色系）。

**真 K 線畫在後台網頁**：`public/js/pages-stock.js` 用 `<canvas>` 畫蠟燭圖，不需要任何外部函式庫，也不受 CSP 限制。玩家想看漂亮版就開 white.crownai.ink。

---

## 7. 後台

- `src/routes/stock.js`：設定、股票 CRUD、新聞發布、成交紀錄查詢、回收統計
- `public/js/pages-stock.js`：沿用現有頁面寫法（參考 `pages-special.js`）
- `src/auth.js` 的 `MODULES` 加一行 `{ key: 'stock', label: '星幣股市' }`
- `src/bot/perm.js` 同步加，讓 staff 可以只開股市權限

儀表板要有的三個數字：**本週銷毀星幣**、**流通市值**、**參與人數**。這是判斷「回收池有沒有在運作」的唯一依據。

---

## 8. 通膨回收：算給你看

以真實玩家量級（餘額 400～800、每日採集收入約 200～400 星幣）估：

- 假設 20 人參與，每人每天來回交易 2 趟、每趟 300 星幣
- 手續費銷毀 = 20 × 2 × 300 × 4% ≈ **480 星幣／天**
- 相對於 20 人每天產出約 6,000 星幣，回收率約 **8%**

**8% 不夠**。想真的當回收池，要再加下面至少一項：

1. **上市抽籤**：新股上市用星幣抽，抽不中退款、抽中的錢一部分銷毀
2. **股利再投資稅**：發股利時扣 10%
3. **持有稅**：市值每天扣 0.5%（逼人交易，但會被罵，慎用）
4. **把手續費調到 3～5%**：最直接，但抑制交易量

我的建議：**開盤先用 2%，觀察兩週的 `burned_total` 和交易人數，再決定要不要加碼**。一開始就收重稅會沒人玩，沒人玩就回收不到任何東西。

而且要講清楚：**面對 10^16 的巨鯨餘額，任何回收設計都是杯水車薪**。股市能解決的是「未來的通膨」，過去的必須靠 §0 的幣改。

---

## 9. 分階段實作

| 階段 | 內容 | 產出 |
|---|---|---|
| **1** | schema、`stock.js` 骨架、定價引擎＋cron 補檔、`/股市` `/個股` | 盤面會自己動，玩家只能看 |
| **2** | `/買股` `/賣股` `/持股`、手續費銷毀、上限與冷卻 | 可以玩了 |
| **3** | 後台頁：設定、股票 CRUD、成交紀錄、canvas K 線 | 管理員能調參數 |
| **4** | 財經新聞＋內線防護＋每日收盤報告公告 | 事件驅動，社群開始喊單 |
| **5** | `/股神榜`、面板按鈕、任務串接（「今天看盤一次」進 `quests`） | 留存與回訪 |

階段 1＋2 就能上線試水溫。**建議先只在一台伺服器開**（用 `stock_config.enabled` 控制），觀察一週再開第二台。

---

## 10. 已知風險

| 風險 | 處理 |
|---|---|
| 巨鯨壟斷 | `max_shares` 持股上限；配合 §0 幣改 |
| 管理員內線 | 發布者在生效前禁止交易該股，交易紀錄可稽核 |
| 機器人重啟造成 K 線斷檔 | `catchUp()` 補齊（已是設計的一部分） |
| 玩家輸光棄坑 | 不做融資／做空；有價格下限；`floor_price` 預設為正，股票不會歸零（要玩負股價才手動調成 0／負值） |
| 「這是賭博」的觀感 | 只用遊戲內星幣，星幣本來就禁止私下買賣（`/幫助` 已標註）；不接任何真實金流 |
| 連點按鈕重複下單 | 交易前 `deferReply`、資料庫交易內再驗一次餘額與持股 |
| 浮點誤差 | 全程整數星幣，只有波動率計算用浮點，結果一律 `Math.round` |

---

## 11. 待你決定

1. **六支股的名字**——用伺服器的梗最有感，上面那組是佔位用的。
2. **先開哪一台**——建議璃白Yu光（68 個錢包，有人氣），eric1222's server 只有 2 個錢包。
3. **§0 的幣改要不要做**——不做的話股市只是好玩，達不到回收目的。
