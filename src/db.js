const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
require('dotenv').config();

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'white2.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');

const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
db.exec(schema);

const SECRET = process.env.JWT_SECRET || 'dev-insecure-secret-change-me';

// 既有資料庫的欄位遷移（新增欄位時在此補上）
function ensureColumns(table, cols) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  for (const [name, ddl] of Object.entries(cols)) {
    if (!existing.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
  }
}

// 既有資料庫欄位遷移
ensureColumns('giveaways', {
  end_unix: 'INTEGER NOT NULL DEFAULT 0',   // 秒級截止（/giveaway 持續時間用；優先於 deadline）
  title: "TEXT NOT NULL DEFAULT ''",
  description: "TEXT NOT NULL DEFAULT ''",
  guaranteed_ids: "TEXT NOT NULL DEFAULT ''",
  start_at: "TEXT NOT NULL DEFAULT ''",
  started: 'INTEGER NOT NULL DEFAULT 1',
  creator: "TEXT NOT NULL DEFAULT ''",
  cancelled: 'INTEGER NOT NULL DEFAULT 0',   // 1=取消（作廢不開獎）
  void_if_insufficient: 'INTEGER NOT NULL DEFAULT 0',   // 1=參加人數<獎品數量時流標不開獎
  mention_roles: "TEXT NOT NULL DEFAULT ''",   // 發抽獎時要 @ 通知的身分組（逗號分隔）
  // 重複中獎限制：多少小時內中過獎的人不能再被抽到。0＝不限制（同一人可連續中獎）
  win_lock_hours: 'INTEGER NOT NULL DEFAULT 12'
});

ensureColumns('keywords', {
  use_embed: 'INTEGER NOT NULL DEFAULT 1',
  btn_label: "TEXT NOT NULL DEFAULT ''",
  btn_url: "TEXT NOT NULL DEFAULT ''",
  channels: "TEXT NOT NULL DEFAULT ''",
  reply_channel: "TEXT NOT NULL DEFAULT ''",
  cooldown: 'INTEGER NOT NULL DEFAULT 0',
  // 命中關鍵字後自動給發言者的身分組（逗號分隔的 role_id，空＝不給）
  give_roles: "TEXT NOT NULL DEFAULT ''"
});

ensureColumns('birthday_config', {
  send_time: "TEXT NOT NULL DEFAULT '09:00'",
  mention_star: 'INTEGER NOT NULL DEFAULT 1',
  remind_enabled: 'INTEGER NOT NULL DEFAULT 0',
  remind_mode: "TEXT NOT NULL DEFAULT 'channel'",
  remind_channel: "TEXT NOT NULL DEFAULT ''",
  remind_days: 'INTEGER NOT NULL DEFAULT 3',
  remind_text: "TEXT NOT NULL DEFAULT '🎂 你還沒有填寫生日資料喔！點下方按鈕填寫，生日當天會有專屬祝福。'",
  remind_role: "TEXT NOT NULL DEFAULT ''"
});

ensureColumns('role_wheels', {
  image_url: "TEXT NOT NULL DEFAULT ''",
  tags: "TEXT NOT NULL DEFAULT ''",
  listed: 'INTEGER NOT NULL DEFAULT 1',
  daily_limit: 'INTEGER NOT NULL DEFAULT 0',
  no_repeat: 'INTEGER NOT NULL DEFAULT 1',
  exclude_chatted: 'INTEGER NOT NULL DEFAULT 0',
  start_at: "TEXT NOT NULL DEFAULT ''",
  end_at: "TEXT NOT NULL DEFAULT ''",
  // 小卡左下角署名，名字與日期分開控制（兩個都關就完全不畫）。
  // 名字預設關閉：等於把「誰抽到誰」公開，先讓管理員自己決定要不要開。
  card_sign: 'INTEGER NOT NULL DEFAULT 0',      // 顯示抽卡人的 Discord 名字
  card_date: 'INTEGER NOT NULL DEFAULT 0'       // 顯示抽卡日期
});

ensureColumns('wheel_roles', {
  world: "TEXT NOT NULL DEFAULT ''",
  platform: "TEXT NOT NULL DEFAULT ''",
  tags: "TEXT NOT NULL DEFAULT ''",
  weight: 'INTEGER NOT NULL DEFAULT 1',
  enabled: 'INTEGER NOT NULL DEFAULT 1',
  start_at: "TEXT NOT NULL DEFAULT ''",
  end_at: "TEXT NOT NULL DEFAULT ''",
  draw_count: 'INTEGER NOT NULL DEFAULT 0',
  fav_count: 'INTEGER NOT NULL DEFAULT 0',
  click_count: 'INTEGER NOT NULL DEFAULT 0'
});

ensureColumns('announcements', {
  images: "TEXT NOT NULL DEFAULT '[]'",
  reaction_roles: "TEXT NOT NULL DEFAULT '[]'",
  buttons: "TEXT NOT NULL DEFAULT '[]'",
  channels: "TEXT NOT NULL DEFAULT ''",
  video_url: "TEXT NOT NULL DEFAULT ''",
  btn_label: "TEXT NOT NULL DEFAULT ''",
  btn_url: "TEXT NOT NULL DEFAULT ''",
  use_embed: 'INTEGER NOT NULL DEFAULT 1',
  mention_everyone: 'INTEGER NOT NULL DEFAULT 0',
  mention_here: 'INTEGER NOT NULL DEFAULT 0',
  mention_role_ids: "TEXT NOT NULL DEFAULT ''",
  repeat_freq: "TEXT NOT NULL DEFAULT 'none'",
  repeat_time: "TEXT NOT NULL DEFAULT '09:00'",
  repeat_dow: 'INTEGER NOT NULL DEFAULT 1',
  repeat_dom: 'INTEGER NOT NULL DEFAULT 1',
  repeat_days: 'INTEGER NOT NULL DEFAULT 1',
  last_run: "TEXT NOT NULL DEFAULT ''",
  creator: "TEXT NOT NULL DEFAULT ''",
  footer: "TEXT NOT NULL DEFAULT ''",
  thumb: "TEXT NOT NULL DEFAULT ''",
  // 已發送的訊息位置 [{channel_id, message_id}]，用於事後編輯（編輯不會再次觸發 @everyone 通知）
  sent_msgs: "TEXT NOT NULL DEFAULT '[]'",
  // 伺服器貼圖 sticker id 陣列（Discord 一則訊息最多 3 張，且不能與 Embed 併用）
  stickers: "TEXT NOT NULL DEFAULT '[]'",
  // 頻道 ↔ 標記身分組 對應：{ "頻道id": "身分組id,身分組id" }
  // 平台各自隔離時，一則公告發到三個平台頻道，各自只 @ 自己平台的身分組。
  channel_mentions: "TEXT NOT NULL DEFAULT '{}'"
});

// 等級卡背景圖（/等級 卡片用，可空＝預設漸層）
ensureColumns('xp_config', {
  card_bg: "TEXT NOT NULL DEFAULT ''"
});

// 帳號可管理的伺服器（逗號分隔的 guild_id）。空＝不限制；admin 一律全部。
ensureColumns('admin_users', {
  guild_ids: "TEXT NOT NULL DEFAULT ''"
});

// 星幣轉帳：預設關閉，開了才會出現 /轉帳。手續費與上限用來壓制洗錢與詐騙。
// 僅管理員可用（例如富豪榜這種會暴露別人財力的查詢）
ensureColumns('gather_cmd_perms', {
  admin_only: 'INTEGER NOT NULL DEFAULT 0'
});

// 工具耐久度：durability>0 才會壞；每次使用扣 1，壞了要 /修理（花星幣）
ensureColumns('gather_tools', {
  durability: 'INTEGER NOT NULL DEFAULT 0',      // 最大使用次數（0＝不會壞）
  repair_cost: 'INTEGER NOT NULL DEFAULT 0'      // 修理費（0＝自動用售價一半）
});
ensureColumns('gather_user_tools', {
  uses_left: 'INTEGER NOT NULL DEFAULT 0'        // 目前剩餘耐久（0 且該工具 durability>0 ＝壞掉）
});
// 懸賞任務：每天全服限量名額（先搶先贏）
ensureColumns('quests', {
  daily_slots: 'INTEGER NOT NULL DEFAULT 0'      // >0＝每個週期全服限這麼多人領，0＝不限
});
// 魚缸：釣到的魚可存進缸養（catch_item_id 對應 gather_items）
ensureColumns('aquarium_fish', {
  catch_item_id: 'INTEGER NOT NULL DEFAULT 0'
});
// 魚缸：單次偷魚最多偷取的星幣上限（0＝不限）
ensureColumns('aquarium_config', {
  steal_max: 'INTEGER NOT NULL DEFAULT 300',
  steal_fail_penalty: 'INTEGER NOT NULL DEFAULT 0',       // 偷失敗罰款（星幣），0＝不罰
  steal_penalty_to_victim: 'INTEGER NOT NULL DEFAULT 1'   // 1＝罰款賠給受害者，0＝直接沒收
});

// 修正貸款抵押順序的舊值：早期版本預設 'bag,fish,animal,stock'（跟實際抵押品 tool/crop/fish 對不上，
// 過濾後只剩 fish → 工具/作物押不了）。一律正規化成 'tool,crop,fish'。
try {
  db.prepare("UPDATE loan_config SET collateral_order='tool,crop,fish' WHERE collateral_order LIKE '%bag%' OR collateral_order LIKE '%animal%' OR collateral_order LIKE '%stock%'").run();
} catch {}

// 信用貸款（免抵押）：靠信用借小額，到期沒還就直接扣錢包（餘額可負），不押任何資產
ensureColumns('loan_config', {
  credit_enabled:      'INTEGER NOT NULL DEFAULT 1',
  credit_max:          'INTEGER NOT NULL DEFAULT 50000',   // 單筆信用貸款上限
  credit_interest_pct: 'INTEGER NOT NULL DEFAULT 10',      // 免抵押風險高，利息比物資貸款高
  credit_term_days:    'INTEGER NOT NULL DEFAULT 7',
  credit_max_open:     'INTEGER NOT NULL DEFAULT 1'        // 同時最多幾筆未還清的信用貸款
});
ensureColumns('loans', {
  loan_type: "TEXT NOT NULL DEFAULT 'asset'"   // 'asset'＝物資抵押、'credit'＝信用貸款
});

ensureColumns('gather_config', {
  // 禁止徒手採集：工具壞掉／被抵押走就不能採（1＝禁止，0＝像以前一樣可以徒手）
  require_tool: 'INTEGER NOT NULL DEFAULT 1',
  // 伐木/採集/狩獵共用一組冷卻，不必為每個新種類都開一個欄位
  other_cooldown: 'INTEGER NOT NULL DEFAULT 300',
  transfer_enabled:   'INTEGER NOT NULL DEFAULT 0',
  transfer_fee_pct:   'INTEGER NOT NULL DEFAULT 5',
  transfer_min:       'INTEGER NOT NULL DEFAULT 10',
  transfer_daily_max: 'INTEGER NOT NULL DEFAULT 5000'
});

ensureColumns('ranch_config', {
  hatch_slots: 'INTEGER NOT NULL DEFAULT 3',   // 孵化室格數（同時能孵幾顆蛋）
  steal_channel: "TEXT NOT NULL DEFAULT ''"    // 偷竊成功時公開公告的頻道（空＝只私訊被偷者）
});

// 多商店：把既有的 special_items 歸到某一間店（0＝未分類）
ensureColumns('special_items', {
  shop_id: 'INTEGER NOT NULL DEFAULT 0'
});

// 孵化失敗機率：領取時擲一次，失敗那顆蛋就沒了
ensureColumns('ranch_hatch_defs', {
  fail_pct: 'INTEGER NOT NULL DEFAULT 0'
});

// 看門動物（狗/貓）：被偷時有機率反擊，小偷隨機掉星幣。guard_pct>0 即為看門動物、不產蛋奶。
ensureColumns('ranch_animals', {
  guard_pct: 'INTEGER NOT NULL DEFAULT 0',       // 反擊觸發機率 %
  guard_penalty: 'INTEGER NOT NULL DEFAULT 0',   // 小偷最多掉多少星幣（隨機 1~此值，賠給被偷者）
  produce_interval_minutes: 'INTEGER NOT NULL DEFAULT 0'   // 每產 1 單位要幾分鐘（0＝由每日產量自動換算，一天平均分配）
});

// 動物生產改成「每單位獨立計時」：記錄上次結算時間（unix 毫秒），成熟一單位就能收一單位
ensureColumns('ranch_slots', {
  last_produce_ms: 'INTEGER NOT NULL DEFAULT 0'
});

// 財經新聞：股價衝擊是一次性的，套用過就標記，避免每個 tick 重複加成
ensureColumns('market_news', {
  stock_done: 'INTEGER NOT NULL DEFAULT 0'
});

// 偷竊可整隻搶走動物的機率、以及看門/防禦相關
ensureColumns('ranch_config', {
  steal_animal_pct: 'INTEGER NOT NULL DEFAULT 0',  // 偷成功時，再有多少 % 機率把整隻動物也搶走
  // 偷取模式：one＝一次只拿 1 個產物或 1 隻動物（被偷的人不會一次被清空）；pct＝舊制的每格各拿 %
  steal_mode: "TEXT NOT NULL DEFAULT 'one'",
  // 看門狗/貓能不能被偷走。關著＝防禦動物是安全區；開了＝連保鑣都會被搶
  steal_guard: 'INTEGER NOT NULL DEFAULT 0'
});

// 每家店可綁自己的通知頻道（channel_id 已存在，發布面板＋兌換通知共用）與要標記的身分組
ensureColumns('special_shops', {
  notify_roles: "TEXT NOT NULL DEFAULT ''"
});

// 兌換通知的去向：shop＝發在商店頻道（公開）／log＝只發到管理員通知頻道／dm＝只私訊管理員
ensureColumns('special_config', {
  notify_mode: "TEXT NOT NULL DEFAULT 'shop'",
  // 每人兌換限制：每期每項最多幾份（0＝不限）
  per_item_limit: 'INTEGER NOT NULL DEFAULT 0',
  // 累進價格：同一項每多買一次就乘一次倍率（第 1 次原價、第 2 次 ×mult、第 3 次 ×mult²…）
  price_escalate: 'INTEGER NOT NULL DEFAULT 0',
  escalate_mult: 'REAL NOT NULL DEFAULT 2',
  // 上限與累進的重置週期：month＝每月 1 號歸零／week＝每週一／none＝永不重置
  limit_reset: "TEXT NOT NULL DEFAULT 'month'"
});

// 個別商品可覆寫每人上限（0＝跟隨全域設定）
ensureColumns('special_items', {
  per_user_limit: 'INTEGER NOT NULL DEFAULT 0'
});

// 一次兌換多份：qty＝份數，price 仍是單價（總價＝price×qty）
ensureColumns('special_redeems', {
  qty: 'INTEGER NOT NULL DEFAULT 1',
  // 實付總額。累進價格時 price 只是平均單價，price×qty 會有進位誤差，一律以這欄為準
  paid: 'INTEGER NOT NULL DEFAULT 0'
});

// 稅金免稅名單：這些人／身分組完全不課稅（管理員、活動帳號等）
ensureColumns('tax_config', {
  exempt_users: "TEXT NOT NULL DEFAULT ''",
  exempt_roles: "TEXT NOT NULL DEFAULT ''",
  // 1＝整筆跳級：整個餘額乘上適用級距的 %；0＝像真實所得稅那樣分段累進
  income_flat: 'INTEGER NOT NULL DEFAULT 1',
  // 證券稅：按「持股市值」課（股票也要繳稅）
  stock_enabled: 'INTEGER NOT NULL DEFAULT 0',
  stock_pct: 'REAL NOT NULL DEFAULT 5',        // 市值的百分比
  stock_free: 'INTEGER NOT NULL DEFAULT 0',    // 市值免稅額
  // 普發（救濟金）：課完稅後把窮／欠稅的人拉回來
  relief_enabled: 'INTEGER NOT NULL DEFAULT 0',
  relief_below: 'INTEGER NOT NULL DEFAULT 0',
  relief_mode: "TEXT NOT NULL DEFAULT 'floor'",
  relief_amount: 'INTEGER NOT NULL DEFAULT 10000',
  relief_floor: 'INTEGER NOT NULL DEFAULT 0',
  relief_max: 'INTEGER NOT NULL DEFAULT 0',
  relief_from_tax: 'INTEGER NOT NULL DEFAULT 1',
  // 消費稅：本期在神秘商店兌換掉的金額也要課，避免結算前把錢換成圖來逃稅
  spend_enabled: 'INTEGER NOT NULL DEFAULT 0',
  spend_pct: 'REAL NOT NULL DEFAULT 20',
  spend_free: 'INTEGER NOT NULL DEFAULT 0',
  last_run_at: "TEXT NOT NULL DEFAULT ''",    // 上次實際結算的時間，用來界定「本期」兌換
  // 所得稅的稅基：balance＝目前餘額／earned＝本期總收入／max＝兩者取高（花掉也逃不掉）
  income_base: "TEXT NOT NULL DEFAULT 'balance'",
  // 強制清算：欠稅的人由系統自動變賣資產抵債
  liquidate_enabled: 'INTEGER NOT NULL DEFAULT 0',
  liquidate_order: "TEXT NOT NULL DEFAULT 'stock'"
});

// 本期收入的起算點：earned_mark＝上次結算時的 total_earned，
// 本期收入 = total_earned - earned_mark。新增欄位時先對齊現值，避免把歷史收入一次課下去。
{
  const had = db.prepare('PRAGMA table_info(econ_wallets)').all().some(c => c.name === 'earned_mark');
  ensureColumns('econ_wallets', { earned_mark: 'INTEGER NOT NULL DEFAULT 0' });
  if (!had) db.exec('UPDATE econ_wallets SET earned_mark = total_earned');
}

// 強制清算預設改成「只賣股票」：玩家反映農場／魚缸被收掉會完全不想玩。
// 只搬移還停在舊預設值的伺服器，管理員自己改過的順序不動。
try { db.prepare("UPDATE tax_config SET liquidate_order='stock' WHERE liquidate_order='bag,stock,fish,animal'").run(); } catch {}

// 稅金：課完稅不讓餘額變負數（錢不夠就只課到 0，差額當「未繳」記在稅單上）
ensureColumns('tax_config', { no_debt: 'INTEGER NOT NULL DEFAULT 1' });

// 稅單紀錄多幾欄：證券稅、消費稅、慈善捐款折抵
ensureColumns('tax_records', {
  stock_tax: 'INTEGER NOT NULL DEFAULT 0',
  spend_tax: 'INTEGER NOT NULL DEFAULT 0',
  charity_credit: 'INTEGER NOT NULL DEFAULT 0'   // 本期捐款折抵掉的稅額
});

ensureColumns('welcome_config', {
  // 新成員一進來就自動掛上的身分組（逗號分隔的 role_id，空＝不給）
  join_roles: "TEXT NOT NULL DEFAULT ''",
  join_title: "TEXT NOT NULL DEFAULT ''",
  join_thumb: "TEXT NOT NULL DEFAULT ''",
  join_btn_label: "TEXT NOT NULL DEFAULT ''",
  join_btn_url: "TEXT NOT NULL DEFAULT ''",
  join_use_embed: 'INTEGER NOT NULL DEFAULT 1',
  admin_channel: "TEXT NOT NULL DEFAULT ''",
  admin_join: 'INTEGER NOT NULL DEFAULT 0',
  admin_leave: 'INTEGER NOT NULL DEFAULT 0',
  // 伺服器貼圖 sticker id 陣列（最多 3 張，Embed 模式下 Discord 不接受，會另外補一則）
  join_stickers: "TEXT NOT NULL DEFAULT '[]'",
  leave_stickers: "TEXT NOT NULL DEFAULT '[]'"
});

// 客服面板的多圖：開單訊息／面板本身都能放整組圖（沿用公告的圖庫排法）
ensureColumns('ticket_panels', {
  open_images: "TEXT NOT NULL DEFAULT '[]'",
  images: "TEXT NOT NULL DEFAULT '[]'"
});

// 入群驗證提示的送法。以前一律在驗證頻道公開發一則並 @ 當事人，
// 同一個人反覆進出就會疊出一整排，版面很亂。
ensureColumns('verify_config', {
  // dm＝私訊本人（預設）／channel＝頻道公開發／panel＝不主動發，只靠常駐面板
  join_prompt_mode: "TEXT NOT NULL DEFAULT 'dm'",
  // 退回頻道發送時，幾秒後自動刪除（0＝不刪）
  prompt_delete_sec: 'INTEGER NOT NULL DEFAULT 120'
});

ensureColumns('polls', {
  description: "TEXT NOT NULL DEFAULT ''",
  allowed_roles: "TEXT NOT NULL DEFAULT ''",
  allow_change: 'INTEGER NOT NULL DEFAULT 1',
  hide_results: 'INTEGER NOT NULL DEFAULT 0',
  start_at: "TEXT NOT NULL DEFAULT ''",
  started: 'INTEGER NOT NULL DEFAULT 1',
  creator: "TEXT NOT NULL DEFAULT ''"
});

ensureColumns('reminders', {
  mention_role_ids: "TEXT NOT NULL DEFAULT ''",
  mention_everyone: 'INTEGER NOT NULL DEFAULT 0',
  do_mention: 'INTEGER NOT NULL DEFAULT 1',
  image_url: "TEXT NOT NULL DEFAULT ''",
  link_url: "TEXT NOT NULL DEFAULT ''",
  btn_label: "TEXT NOT NULL DEFAULT ''",
  btn_url: "TEXT NOT NULL DEFAULT ''",
  creator: "TEXT NOT NULL DEFAULT ''"
});

// 特殊商店：分店綁頻道後，玩家在該頻道打 /特殊商店 只看得到那間店（沒綁店的頻道仍看全部）
ensureColumns('special_config', {
  channel_scoped: 'INTEGER NOT NULL DEFAULT 0'
});

// 設施加成：買高階除了格數變多，還能加快產出／成熟／孵化，牧場另有防竊
// 採集改成「每日點數池」：不同地圖每次消耗的點數不同（門票制）
ensureColumns('gather_config', {
  daily_points: 'INTEGER NOT NULL DEFAULT 0'   // 0＝沿用舊的地圖每日次數制
});
ensureColumns('gather_maps', {
  cost: 'INTEGER NOT NULL DEFAULT 1'           // 在這張圖採集一次扣幾點
});

ensureColumns('facility_defs', {
  speed_pct: 'INTEGER NOT NULL DEFAULT 0',
  resist_pct: 'INTEGER NOT NULL DEFAULT 0'
});
ensureColumns('facility_owned', {
  speed_pct: 'INTEGER NOT NULL DEFAULT 0',
  resist_pct: 'INTEGER NOT NULL DEFAULT 0'
});

ensureColumns('audit_log', {
  module: "TEXT NOT NULL DEFAULT ''",
  detail: "TEXT NOT NULL DEFAULT ''"
});

ensureColumns('blacklist', {
  feature: "TEXT NOT NULL DEFAULT 'all'",
  expires_at: "TEXT NOT NULL DEFAULT ''",
  active: 'INTEGER NOT NULL DEFAULT 1',
  operator: "TEXT NOT NULL DEFAULT ''"
});

// 音樂播放清單的存檔：機器人重啟後可以把歌單接回去（歌單原本只存在記憶體，一重啟就沒了）
db.exec(`CREATE TABLE IF NOT EXISTS music_state (
  guild_id         TEXT PRIMARY KEY,
  voice_channel_id TEXT NOT NULL DEFAULT '',
  text_channel_id  TEXT NOT NULL DEFAULT '',
  songs            TEXT NOT NULL DEFAULT '[]',
  loop             TEXT NOT NULL DEFAULT 'off',
  volume           INTEGER NOT NULL DEFAULT 100,
  updated_at       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
)`);

// ============================================================
// 多伺服器（per-guild）地基
// ============================================================
const HOME_GUILD = process.env.GUILD_ID || '';

// 機器人所在伺服器清單
db.exec(`CREATE TABLE IF NOT EXISTS guilds (
  guild_id   TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  icon       TEXT NOT NULL DEFAULT '',
  active     INTEGER NOT NULL DEFAULT 1,
  joined_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
)`);
if (HOME_GUILD) {
  db.prepare('INSERT OR IGNORE INTO guilds (guild_id, name) VALUES (?, ?)').run(HOME_GUILD, '主伺服器');
}

// 需要 guild_id 的業務資料表（單例設定表 + 多筆資料表）。純全域表（admin_users/guilds）不列入。
// error_logs 另外處理：有 guild_id，但允許空字串代表「全站層級」（如登入失敗、斷線）。
const GUILD_TABLES = [
  'warn_config', 'welcome_config', 'birthday_config', 'verify_config', 'music_config',
  'xp_config', 'ticket_config', 'forum_config', 'gather_config',
  'gather_items', 'gather_tools', 'gather_inventory', 'gather_user_tools',
  'gather_cooldowns', 'econ_wallets', 'gather_recipes', 'quests', 'quest_progress',
  'econ_transfers', 'gather_cmd_perms',
  'ranch_config', 'ranch_animals', 'ranch_slots', 'ranch_steal', 'ranch_steal_routes',
  'ranch_hatch_defs', 'ranch_incubator', 'ranch_unlocks',
  'special_config', 'special_items', 'special_redeems', 'special_shops',
  'crop_config', 'crop_seeds', 'crop_plots', 'crop_unlocks',
  'aquarium_config', 'aquarium_fish', 'aquarium_slots', 'aquarium_steal', 'aquarium_unlocks',
  'charity_config', 'charity_donations', 'charity_payouts',
  'loan_config', 'loans', 'loan_collaterals',
  'facility_defs', 'facility_owned',
  'gather_points', 'lottery_draws', 'lottery_prizes', 'luck_buffs', 'trades', 'gather_maps', 'gather_user_map',
  'keywords', 'keyword_logs', 'keyword_mentions', 'alert_rules', 'alert_logs',
  'warnings', 'mutes', 'announcements', 'announcement_logs', 'announcement_templates',
  'polls', 'poll_votes', 'giveaways', 'giveaway_entries', 'win_records',
  'role_wheels', 'wheel_roles', 'wheel_tags', 'wheel_draws', 'wheel_favorites',
  'wheel_chats', 'wheel_rounds', 'reminders', 'reminder_logs', 'tickets', 'ticket_panels',
  'level_roles', 'user_xp', 'member_events', 'birthdays', 'birthday_history', 'birthday_sends',
  'blacklist', 'feature_perms', 'reaction_role_maps', 'forum_posts', 'music_logs', 'audit_log',
  'uploads',       // 媒體庫改為分伺服器（各台獨立、重置時清除）
  'custom_emojis'  // 自訂圖示（連結按鈕圖標）同樣分伺服器
];

// 對每張表加 guild_id 欄位，並把現有資料回填為主伺服器
function migrateGuildColumn(table) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes('guild_id')) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN guild_id TEXT NOT NULL DEFAULT ''`);
    if (HOME_GUILD) db.prepare(`UPDATE ${table} SET guild_id = ? WHERE guild_id = ''`).run(HOME_GUILD);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_guild ON ${table}(guild_id)`);
  }
}
for (const t of GUILD_TABLES) {
  try { migrateGuildColumn(t); } catch (e) { console.error(`遷移 ${t}.guild_id 失敗：`, e.message); }
}

// 單例設定表原有 `id INTEGER PRIMARY KEY CHECK (id = 1)`，阻止每 guild 一筆。
// 重建為：id 自增、guild_id UNIQUE，去掉 CHECK。冪等（偵測到 CHECK 才重建）。
const SINGLETON_TABLES = ['warn_config', 'welcome_config', 'birthday_config', 'verify_config', 'music_config', 'xp_config', 'ticket_config', 'forum_config'];
function rebuildSingleton(table) {
  const info = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(table);
  if (!info || !/CHECK\s*\(\s*id\s*=\s*1\s*\)/i.test(info.sql)) return; // 已無 CHECK
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  const colNames = cols.map(c => c.name);
  // 重建：把 id 的 PRIMARY KEY CHECK 換成一般自增主鍵，guild_id 唯一
  const defs = cols.map(c => {
    if (c.name === 'id') return 'id INTEGER PRIMARY KEY AUTOINCREMENT';
    let d = `${c.name} ${c.type || 'TEXT'}`;
    if (c.notnull) d += ' NOT NULL';
    if (c.dflt_value != null) d += ` DEFAULT (${c.dflt_value})`;
    return d;
  });
  const tmp = `${table}__mg`;
  const tx = db.transaction(() => {
    db.exec(`CREATE TABLE ${tmp} (${defs.join(', ')}, UNIQUE(guild_id))`);
    db.exec(`INSERT INTO ${tmp} (${colNames.join(',')}) SELECT ${colNames.join(',')} FROM ${table}`);
    db.exec(`DROP TABLE ${table}`);
    db.exec(`ALTER TABLE ${tmp} RENAME TO ${table}`);
  });
  tx();
  console.log(`  ↳ 已重建設定表 ${table}（改為 per-guild）`);
}
for (const t of SINGLETON_TABLES) {
  try { rebuildSingleton(t); } catch (e) { console.error(`重建 ${t} 失敗：`, e.message); }
}

// 主鍵含自然鍵（user_id/feature/level…）的表，跨伺服器會衝突 → 重建為含 guild_id 的複合主鍵。
// 冪等：偵測目前主鍵是否已含 guild_id，否則重建。
function rebuildWithPK(table, pkCols) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  const curPk = cols.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name);
  if (curPk.length === pkCols.length && curPk.every((c, i) => c === pkCols[i])) return; // 已是目標主鍵
  const colNames = cols.map(c => c.name);
  const defs = cols.map(c => {
    let d = `${c.name} ${c.type || 'TEXT'}`;
    if (c.notnull) d += ' NOT NULL';
    if (c.dflt_value != null) d += ` DEFAULT (${c.dflt_value})`;
    return d;
  });
  const tmp = `${table}__pk`;
  const tx = db.transaction(() => {
    db.exec(`CREATE TABLE ${tmp} (${defs.join(', ')}, PRIMARY KEY (${pkCols.join(',')}))`);
    db.exec(`INSERT OR IGNORE INTO ${tmp} (${colNames.join(',')}) SELECT ${colNames.join(',')} FROM ${table}`);
    db.exec(`DROP TABLE ${table}`);
    db.exec(`ALTER TABLE ${tmp} RENAME TO ${table}`);
  });
  tx();
  console.log(`  ↳ 已重建 ${table} 主鍵為 (${pkCols.join(',')})`);
}
const PK_REBUILDS = {
  user_xp: ['guild_id', 'user_id'],
  level_roles: ['guild_id', 'level'],
  birthdays: ['guild_id', 'user_id'],
  birthday_sends: ['guild_id', 'user_id', 'year'],
  blacklist: ['guild_id', 'user_id'],
  feature_perms: ['guild_id', 'feature']
};
for (const [t, pk] of Object.entries(PK_REBUILDS)) {
  try { rebuildWithPK(t, pk); } catch (e) { console.error(`重建 ${t} 主鍵失敗：`, e.message); }
}

// 單例設定表（原本 id=1 一筆）→ 改為每個 guild 一筆。回傳該 guild 的設定列，不存在則以主伺服器那筆為範本建立。
const SINGLETON_DEFAULTS = {
  warn_config: () => db.prepare("SELECT * FROM warn_config WHERE guild_id=? OR id=1 LIMIT 1"),
};
function guildConfig(table, guildId) {
  if (!guildId) guildId = HOME_GUILD;
  let row = db.prepare(`SELECT * FROM ${table} WHERE guild_id = ? LIMIT 1`).get(guildId);
  if (row) return row;
  // 新伺服器 → 建立「空白預設」設定（用各欄位自己的 DEFAULT，不複製其他伺服器的頻道/身分組值）
  try {
    db.prepare(`INSERT INTO ${table} (guild_id) VALUES (?)`).run(guildId);
  } catch { /* 併發或無此表就略過 */ }
  row = db.prepare(`SELECT * FROM ${table} WHERE guild_id = ? LIMIT 1`).get(guildId);
  return row || {};
}

// 新伺服器加入時，確保 8 張設定表各有一筆
const SETTING_TABLES = ['warn_config', 'welcome_config', 'birthday_config', 'verify_config', 'music_config', 'xp_config', 'ticket_config', 'forum_config', 'gather_config', 'ranch_config', 'special_config', 'crop_config', 'aquarium_config', 'tax_config', 'charity_config', 'loan_config'];
function ensureGuild(guildId, name, icon) {
  if (!guildId) return;
  db.prepare('INSERT INTO guilds (guild_id, name, icon, active) VALUES (?, ?, ?, 1) ON CONFLICT(guild_id) DO UPDATE SET name=excluded.name, icon=excluded.icon, active=1')
    .run(guildId, name || '', icon || '');
  for (const t of SETTING_TABLES) { try { guildConfig(t, guildId); } catch {} }
}

// 重置某台伺服器：清空該 guild 的所有業務資料，設定回預設（回到全新狀態）。
// 不動 guilds 表本身（保留核准/在線狀態），也不影響其他伺服器。
function resetGuildData(guildId) {
  if (!guildId) return { ok: false, cleared: 0 };
  let cleared = 0;
  const wipe = db.transaction((gid) => {
    for (const t of GUILD_TABLES) {
      try { const info = db.prepare(`DELETE FROM ${t} WHERE guild_id = ?`).run(gid); cleared += info.changes; } catch {}
    }
    // 重新建立各功能的預設設定（單例設定表刪掉後這裡補回預設值）
    for (const t of SETTING_TABLES) { try { guildConfig(t, gid); } catch {} }
  });
  wipe(guildId);
  return { ok: true, cleared };
}

// ---- 設定 key-value 便捷存取 ----
const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSettingStmt = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);
function getSetting(key, fallback = '') {
  const row = getSettingStmt.get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  setSettingStmt.run(key, String(value ?? ''));
}

// 可由後台「自訂外觀」頁編輯的設定（14.1～14.3）
const UI_TEXT_KEYS = [
  'bot_name', 'bot_avatar', 'brand_title', 'brand_sub',
  'bot_status', 'bot_activity_type', 'bot_activity_text',   // 14.1 狀態與活動
  'embed_color', 'embed_footer', 'embed_thumb',             // 14.2 Embed 樣式
  'invite_contact'                                          // 邀請制：未開通伺服器看到的聯繫訊息
];

function audit(actor, action, module = '', detail = '', guildId = '') {
  db.prepare('INSERT INTO audit_log (actor, action, module, detail, guild_id) VALUES (?, ?, ?, ?, ?)')
    .run(actor || '', action || '', module || '', detail || '', guildId || HOME_GUILD);
}

// error_logs 的 guild_id：空字串＝全站層級（登入/斷線/載入失敗等，所有伺服器都看得到）
if (!db.prepare('PRAGMA table_info(error_logs)').all().some(c => c.name === 'guild_id')) {
  db.exec("ALTER TABLE error_logs ADD COLUMN guild_id TEXT NOT NULL DEFAULT ''");
  db.exec('CREATE INDEX IF NOT EXISTS idx_error_logs_guild ON error_logs(guild_id)');
  // 既有紀錄沒有來源資訊，保持空字串（全站）而不亂歸給某一台
}

// 11.5 系統錯誤紀錄：攔截 console.error 一併寫入資料庫
const origError = console.error.bind(console);

// 寫一筆錯誤紀錄。guildId 留空＝全站層級。
function writeError(msg, guildId) {
  try {
    db.prepare('INSERT INTO error_logs (message, guild_id) VALUES (?, ?)')
      .run(String(msg).slice(0, 1000), guildId || '');
    // 只保留最近 500 筆
    db.prepare('DELETE FROM error_logs WHERE id <= (SELECT MAX(id) - 500 FROM error_logs)').run();
  } catch {}
}

const fmt = (args) => args.map(a => (a && a.stack) ? a.stack : String(a)).join(' ');

console.error = (...args) => {
  origError(...args);
  writeError(fmt(args));
};

// 有伺服器上下文的錯誤請用這個，紀錄才會歸到正確的伺服器。
// 用法：logError(guildId, '播放失敗：', e.message)
function logError(guildId, ...args) {
  origError(...args);
  writeError(fmt(args), guildId);
}

// 目前啟用中的伺服器 id 清單（排程模組遍歷用）
function activeGuildIds() {
  return db.prepare('SELECT guild_id FROM guilds WHERE active = 1').all().map(r => r.guild_id);
}

module.exports = {
  db, SECRET, ensureColumns, getSetting, setSetting, UI_TEXT_KEYS, audit,
  HOME_GUILD, guildConfig, ensureGuild, resetGuildData, activeGuildIds, GUILD_TABLES, logError
};
