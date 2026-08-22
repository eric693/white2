-- White2 Discord 機器人資料庫結構（SQLite / better-sqlite3）

-- ===== 後台管理員帳號 =====
CREATE TABLE IF NOT EXISTS admin_users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL DEFAULT '管理員',
  role          TEXT NOT NULL DEFAULT 'admin',   -- admin | staff
  permissions   TEXT NOT NULL DEFAULT '',        -- staff 逗號分隔模組 key
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ===== 系統設定（key-value）=====
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

-- ===== 稽核記錄（11.4）=====
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor      TEXT NOT NULL DEFAULT '',
  action     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  module     TEXT NOT NULL DEFAULT '',   -- 功能名稱
  detail     TEXT NOT NULL DEFAULT ''    -- 異動內容（修改前後）
);

-- ===== 上傳的圖片與檔案（媒體庫）=====
CREATE TABLE IF NOT EXISTS uploads (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  filename    TEXT NOT NULL,                 -- 實體檔名
  original    TEXT NOT NULL DEFAULT '',      -- 原始檔名
  url         TEXT NOT NULL,                 -- /uploads/xxx
  mime        TEXT NOT NULL DEFAULT '',
  size        INTEGER NOT NULL DEFAULT 0,
  kind        TEXT NOT NULL DEFAULT 'file',  -- image | video | file
  uploader    TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ===== 系統錯誤紀錄（11.5）=====
CREATE TABLE IF NOT EXISTS error_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  message    TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ===== 功能權限（12.1～12.5）=====
CREATE TABLE IF NOT EXISTS feature_perms (
  feature         TEXT PRIMARY KEY,           -- music | giveaways | polls | wheels | birthday ...
  role_ids        TEXT NOT NULL DEFAULT '',   -- 12.1 可使用的身分組（空=全體）
  channel_ids     TEXT NOT NULL DEFAULT '',   -- 12.4 僅限這些頻道（空=不限）
  except_user_ids TEXT NOT NULL DEFAULT '',   -- 12.5 例外使用者（不受限制）
  except_role_ids TEXT NOT NULL DEFAULT '',   -- 12.5 例外身分組
  enabled         INTEGER NOT NULL DEFAULT 1  -- 關閉=此功能全伺服器停用
);

-- ===== 關鍵字自動回覆 =====
-- keyword 欄位可放多個關鍵字（換行或逗號分隔），符合任一即觸發（4.4）
CREATE TABLE IF NOT EXISTS keywords (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword       TEXT NOT NULL,
  match_type    TEXT NOT NULL DEFAULT 'contains', -- contains | exact | starts
  reply_text    TEXT NOT NULL DEFAULT '',
  image_url     TEXT NOT NULL DEFAULT '',
  link_url      TEXT NOT NULL DEFAULT '',
  use_embed     INTEGER NOT NULL DEFAULT 1,
  btn_label     TEXT NOT NULL DEFAULT '',
  btn_url       TEXT NOT NULL DEFAULT '',
  channels      TEXT NOT NULL DEFAULT '',         -- 限定觸發頻道（逗號分隔，空=全部）4.5
  reply_channel TEXT NOT NULL DEFAULT '',         -- 指定回覆到某頻道（空=原頻道）
  cooldown      INTEGER NOT NULL DEFAULT 0,        -- 冷卻秒數 4.6
  buttons       TEXT NOT NULL DEFAULT '[]',        -- 4.3 多個連結按鈕
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 關鍵字觸發紀錄（4.9）
CREATE TABLE IF NOT EXISTS keyword_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword_id INTEGER NOT NULL,
  matched    TEXT NOT NULL DEFAULT '',
  user_id    TEXT NOT NULL DEFAULT '',
  username   TEXT NOT NULL DEFAULT '',
  channel_id TEXT NOT NULL DEFAULT '',
  message    TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ===== 關鍵字標記管理員 =====
CREATE TABLE IF NOT EXISTS keyword_mentions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword      TEXT NOT NULL,
  match_type   TEXT NOT NULL DEFAULT 'contains',
  mention_ids  TEXT NOT NULL DEFAULT '',        -- 使用者/身分組 ID，逗號分隔
  mention_type TEXT NOT NULL DEFAULT 'user',    -- user | role
  note         TEXT NOT NULL DEFAULT '',
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ===== 關鍵字通知與警告規則（5.1～5.8、5.15）=====
-- keyword 欄位可放多個關鍵字（換行或逗號分隔），符合任一即觸發（5.7）
CREATE TABLE IF NOT EXISTS alert_rules (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL DEFAULT '',        -- 規則名稱（後台辨識用）
  keyword         TEXT NOT NULL,
  match_type      TEXT NOT NULL DEFAULT 'contains',-- contains | exact | starts
  channels        TEXT NOT NULL DEFAULT '',        -- 限定監控頻道（逗號分隔，空=全伺服器）
  notify_channel  TEXT NOT NULL DEFAULT '',        -- 5.4 通知發送到的管理頻道
  notify_user_ids TEXT NOT NULL DEFAULT '',        -- 5.3 通知的管理員（逗號分隔）
  notify_role_ids TEXT NOT NULL DEFAULT '',        -- 5.3 通知的管理員身分組
  notify_dm       INTEGER NOT NULL DEFAULT 0,      -- 5.6 是否私訊上列管理員
  warn            INTEGER NOT NULL DEFAULT 0,      -- 5.8 觸發後是否給警告
  warn_reason     TEXT NOT NULL DEFAULT '',        -- 警告原因（空則用規則名稱）
  notify_member   INTEGER NOT NULL DEFAULT 1,      -- 5.9 是否通知玩家本人
  cooldown        INTEGER NOT NULL DEFAULT 0,      -- 5.15 同一玩家冷卻秒數
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 觸發紀錄（5.17）
CREATE TABLE IF NOT EXISTS alert_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id    INTEGER NOT NULL,
  rule_name  TEXT NOT NULL DEFAULT '',
  matched    TEXT NOT NULL DEFAULT '',
  user_id    TEXT NOT NULL DEFAULT '',
  username   TEXT NOT NULL DEFAULT '',
  channel_id TEXT NOT NULL DEFAULT '',
  message    TEXT NOT NULL DEFAULT '',
  warned     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
-- 冷卻判斷（5.16）靠此索引查同規則同玩家的上次觸發
CREATE INDEX IF NOT EXISTS idx_alert_logs_rule_user ON alert_logs(rule_id, user_id, created_at);

-- ===== 警告紀錄（5.10、5.14）=====
-- 以 Discord ID 為主，玩家改名/退出/重進皆不刪除
CREATE TABLE IF NOT EXISTS warnings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  username   TEXT NOT NULL DEFAULT '',
  reason     TEXT NOT NULL DEFAULT '',
  rule_id    INTEGER NOT NULL DEFAULT 0,
  source     TEXT NOT NULL DEFAULT 'auto',      -- auto | manual
  operator   TEXT NOT NULL DEFAULT '',          -- 手動新增時的管理員
  content    TEXT NOT NULL DEFAULT '',          -- 觸發當下的完整訊息
  channel_id TEXT NOT NULL DEFAULT '',
  active     INTEGER NOT NULL DEFAULT 1,        -- 0=已被管理員撤銷（不計入累計）
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_warn_user ON warnings(user_id, active, created_at);

-- ===== 禁言紀錄（5.11～5.13、5.17）=====
CREATE TABLE IF NOT EXISTS mutes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  username    TEXT NOT NULL DEFAULT '',
  reason      TEXT NOT NULL DEFAULT '',
  minutes     INTEGER NOT NULL DEFAULT 0,
  warn_count  INTEGER NOT NULL DEFAULT 0,       -- 觸發禁言時的當日累計次數
  start_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  end_at      TEXT NOT NULL DEFAULT '',
  released_at TEXT NOT NULL DEFAULT '',
  released_by TEXT NOT NULL DEFAULT '',         -- 空=時間到自動解除
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_mute_user ON mutes(user_id, active);

-- ===== 警告與禁言全域設定（5.11）=====
CREATE TABLE IF NOT EXISTS warn_config (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  threshold      INTEGER NOT NULL DEFAULT 3,     -- 當日累計幾次警告自動禁言
  mute_minutes   INTEGER NOT NULL DEFAULT 60,    -- 禁言時間（分鐘）
  notify_channel TEXT NOT NULL DEFAULT '',       -- 5.12 禁言通知的管理頻道
  dm_member      INTEGER NOT NULL DEFAULT 1      -- 5.12 是否私訊通知被禁言者
);
-- （已移除單例預設列：多伺服器改由 ensureGuild 建立各台設定）
-- ===== 加入 / 退出通知 =====
CREATE TABLE IF NOT EXISTS welcome_config (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  join_enabled  INTEGER NOT NULL DEFAULT 0,
  join_channel  TEXT NOT NULL DEFAULT '',
  join_message  TEXT NOT NULL DEFAULT '歡迎 {user} 加入 {server}！',
  join_image    TEXT NOT NULL DEFAULT '',
  leave_enabled INTEGER NOT NULL DEFAULT 0,
  leave_channel TEXT NOT NULL DEFAULT '',
  leave_message TEXT NOT NULL DEFAULT '{username} 離開了伺服器。',
  -- 6.4 歡迎內容擴充
  join_title     TEXT NOT NULL DEFAULT '',
  join_thumb     TEXT NOT NULL DEFAULT '',      -- Banner / 縮圖
  join_btn_label TEXT NOT NULL DEFAULT '',
  join_btn_url   TEXT NOT NULL DEFAULT '',
  join_use_embed INTEGER NOT NULL DEFAULT 1,
  -- 6.6 / 6.7 管理員通知
  admin_channel  TEXT NOT NULL DEFAULT '',
  admin_join     INTEGER NOT NULL DEFAULT 0,
  admin_leave    INTEGER NOT NULL DEFAULT 0,
  join_buttons   TEXT NOT NULL DEFAULT '[]'  -- 6.4 多個連結按鈕
);
-- （已移除單例預設列：多伺服器改由 ensureGuild 建立各台設定）
-- ===== 成員加入 / 離開紀錄（6.6～6.9）=====
CREATE TABLE IF NOT EXISTS member_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL,
  username     TEXT NOT NULL DEFAULT '',
  event        TEXT NOT NULL,                  -- join | leave
  roles        TEXT NOT NULL DEFAULT '',       -- 離開前擁有的身分組名稱
  account_at   TEXT NOT NULL DEFAULT '',       -- 帳號建立日期
  joined_at    TEXT NOT NULL DEFAULT '',       -- 該次加入時間
  stay_days    INTEGER NOT NULL DEFAULT 0,     -- 離開時的停留天數
  join_count   INTEGER NOT NULL DEFAULT 1,     -- 累計第幾次加入
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_member_events_user ON member_events(user_id, created_at);

-- ===== 生日驗證設定 =====
CREATE TABLE IF NOT EXISTS verify_config (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  enabled        INTEGER NOT NULL DEFAULT 0,
  min_age        INTEGER NOT NULL DEFAULT 18,
  verify_channel TEXT NOT NULL DEFAULT '',   -- 放驗證按鈕的頻道
  pass_role      TEXT NOT NULL DEFAULT '',   -- 通過後給的身分組
  kick_underage  INTEGER NOT NULL DEFAULT 1, -- 未滿年齡是否踢除
  prompt_text    TEXT NOT NULL DEFAULT '歡迎加入！請先完成年齡驗證，點下方按鈕填寫您的生日。'
);
-- （已移除單例預設列：多伺服器改由 ensureGuild 建立各台設定）
-- ===== 生日慶生設定 =====
CREATE TABLE IF NOT EXISTS birthday_config (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  enabled        INTEGER NOT NULL DEFAULT 0,
  channel        TEXT NOT NULL DEFAULT '',
  message        TEXT NOT NULL DEFAULT '🎂 今天是 {user} 的生日，大家一起祝他生日快樂！',
  birthday_role  TEXT NOT NULL DEFAULT '',   -- 當天暫時給的身分組（可空）
  reward_text    TEXT NOT NULL DEFAULT '',   -- 附帶優惠/獎勵文字
  -- 10.5 公告設定
  send_time      TEXT NOT NULL DEFAULT '09:00',
  mention_star   INTEGER NOT NULL DEFAULT 1, -- 是否標記壽星
  -- 10.2 生日資料填寫提醒
  remind_enabled INTEGER NOT NULL DEFAULT 0,
  remind_mode    TEXT NOT NULL DEFAULT 'channel', -- channel | dm | both
  remind_channel TEXT NOT NULL DEFAULT '',
  remind_days    INTEGER NOT NULL DEFAULT 3,      -- 每隔幾天提醒一次
  remind_text    TEXT NOT NULL DEFAULT '🎂 你還沒有填寫生日資料喔！點下方按鈕填寫，生日當天會有專屬祝福。',
  remind_role    TEXT NOT NULL DEFAULT ''        -- 只提醒此身分組（空=全部成員）
);
-- （已移除單例預設列：多伺服器改由 ensureGuild 建立各台設定）
-- 10.6 生日祝福發送紀錄（同一年度只發一次）
CREATE TABLE IF NOT EXISTS birthday_sends (
  user_id  TEXT NOT NULL,
  year     INTEGER NOT NULL,
  sent_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (user_id, year)
);

-- 10.7 生日資料異動紀錄
CREATE TABLE IF NOT EXISTS birthday_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  username   TEXT NOT NULL DEFAULT '',
  action     TEXT NOT NULL DEFAULT 'set',   -- set | update | delete
  old_value  TEXT NOT NULL DEFAULT '',
  new_value  TEXT NOT NULL DEFAULT '',
  operator   TEXT NOT NULL DEFAULT '',      -- 玩家自填為空
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ===== 玩家生日 =====
CREATE TABLE IF NOT EXISTS birthdays (
  user_id     TEXT PRIMARY KEY,
  username    TEXT NOT NULL DEFAULT '',
  birth_y     INTEGER NOT NULL,
  birth_m     INTEGER NOT NULL,
  birth_d     INTEGER NOT NULL,
  verified_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ===== 公告 =====
CREATE TABLE IF NOT EXISTS announcements (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL DEFAULT '',
  content      TEXT NOT NULL DEFAULT '',
  image_url    TEXT NOT NULL DEFAULT '',
  link_url     TEXT NOT NULL DEFAULT '',
  channel_id   TEXT NOT NULL DEFAULT '',
  scheduled_at TEXT NOT NULL DEFAULT '',      -- 空=立即；否則 ISO 時間
  status       TEXT NOT NULL DEFAULT 'draft', -- draft | scheduled | sent | repeating | stopped
  sent_at      TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  -- 7.5 多頻道（逗號分隔；相容舊的 channel_id）
  channels     TEXT NOT NULL DEFAULT '',
  -- 7.2 內容擴充
  video_url    TEXT NOT NULL DEFAULT '',
  btn_label    TEXT NOT NULL DEFAULT '',
  btn_url      TEXT NOT NULL DEFAULT '',
  use_embed    INTEGER NOT NULL DEFAULT 1,
  -- 7.6 標記設定
  mention_everyone INTEGER NOT NULL DEFAULT 0,
  mention_here     INTEGER NOT NULL DEFAULT 0,
  mention_role_ids TEXT NOT NULL DEFAULT '',
  -- 7.4 循環公告
  repeat_freq  TEXT NOT NULL DEFAULT 'none',  -- none | daily | weekly | monthly | custom
  repeat_time  TEXT NOT NULL DEFAULT '09:00', -- HH:MM
  repeat_dow   INTEGER NOT NULL DEFAULT 1,    -- weekly：0=日..6=六
  repeat_dom   INTEGER NOT NULL DEFAULT 1,    -- monthly：日
  repeat_days  INTEGER NOT NULL DEFAULT 1,    -- custom：每 N 天
  last_run     TEXT NOT NULL DEFAULT '',
  creator      TEXT NOT NULL DEFAULT '',
  buttons      TEXT NOT NULL DEFAULT '[]'   -- 7.2 多個連結按鈕 [{emoji,label,url}]
);

-- 7.9 公告模板
CREATE TABLE IF NOT EXISTS announcement_templates (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  payload    TEXT NOT NULL DEFAULT '{}',      -- JSON：公告各欄位
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 7.10 公告發送紀錄
CREATE TABLE IF NOT EXISTS announcement_logs (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ann_id   INTEGER NOT NULL,
  title    TEXT NOT NULL DEFAULT '',
  channels TEXT NOT NULL DEFAULT '',
  status   TEXT NOT NULL DEFAULT 'ok',        -- ok | fail
  error    TEXT NOT NULL DEFAULT '',
  creator  TEXT NOT NULL DEFAULT '',
  sent_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ===== 投票 =====
CREATE TABLE IF NOT EXISTS polls (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  question      TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  options       TEXT NOT NULL DEFAULT '[]',     -- JSON 陣列
  multi         INTEGER NOT NULL DEFAULT 0,     -- 複選
  anonymous     INTEGER NOT NULL DEFAULT 0,
  allowed_roles TEXT NOT NULL DEFAULT '',       -- 限定身分組（逗號分隔，空=全體）
  allow_change  INTEGER NOT NULL DEFAULT 1,     -- 允許截止前修改投票
  hide_results  INTEGER NOT NULL DEFAULT 0,     -- 結束後才公開結果
  channel_id    TEXT NOT NULL DEFAULT '',
  message_id    TEXT NOT NULL DEFAULT '',
  start_at      TEXT NOT NULL DEFAULT '',
  deadline      TEXT NOT NULL DEFAULT '',
  started       INTEGER NOT NULL DEFAULT 1,
  closed        INTEGER NOT NULL DEFAULT 0,
  creator       TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS poll_votes (
  poll_id      INTEGER NOT NULL,
  user_id      TEXT NOT NULL,
  option_index INTEGER NOT NULL,
  PRIMARY KEY (poll_id, user_id, option_index)
);

-- ===== 抽獎 =====
CREATE TABLE IF NOT EXISTS giveaways (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  title          TEXT NOT NULL DEFAULT '',
  description    TEXT NOT NULL DEFAULT '',
  prize          TEXT NOT NULL,
  winners        INTEGER NOT NULL DEFAULT 1,
  guaranteed_ids TEXT NOT NULL DEFAULT '',   -- 保證中獎者 ID，逗號分隔
  channel_id     TEXT NOT NULL DEFAULT '',
  message_id     TEXT NOT NULL DEFAULT '',
  start_at       TEXT NOT NULL DEFAULT '',   -- 開始時間（空=立即）
  deadline       TEXT NOT NULL DEFAULT '',   -- 結束時間（分鐘精度）
  end_unix       INTEGER NOT NULL DEFAULT 0, -- 秒級截止（/giveaway 持續時間，優先於 deadline）
  started        INTEGER NOT NULL DEFAULT 1,
  ended          INTEGER NOT NULL DEFAULT 0,
  winner_ids     TEXT NOT NULL DEFAULT '[]',
  creator        TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS giveaway_entries (
  giveaway_id INTEGER NOT NULL,
  user_id     TEXT NOT NULL,
  username    TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (giveaway_id, user_id)
);

-- ===== 功能黑名單（11.3）=====
CREATE TABLE IF NOT EXISTS blacklist (
  user_id    TEXT PRIMARY KEY,
  username   TEXT NOT NULL DEFAULT '',
  reason     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  feature    TEXT NOT NULL DEFAULT 'all',  -- all | giveaways | polls | wheels | music ...
  expires_at TEXT NOT NULL DEFAULT '',     -- 空=永久
  active     INTEGER NOT NULL DEFAULT 1,
  operator   TEXT NOT NULL DEFAULT ''
);

-- ===== 抽獎中獎紀錄（跨場次，供 12 小時限制與歷史查詢）=====
CREATE TABLE IF NOT EXISTS win_records (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  giveaway_id INTEGER NOT NULL,
  user_id     TEXT NOT NULL,
  username    TEXT NOT NULL DEFAULT '',
  prize       TEXT NOT NULL DEFAULT '',
  won_at      INTEGER NOT NULL DEFAULT 0,   -- unix 秒
  revoked     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_win_user ON win_records(user_id, revoked, won_at);

-- ===== 角色推薦轉盤（8.1～8.16）=====
CREATE TABLE IF NOT EXISTS role_wheels (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  image_url   TEXT NOT NULL DEFAULT '',
  tags        TEXT NOT NULL DEFAULT '',      -- 8.4 轉盤標籤（逗號分隔）
  listed      INTEGER NOT NULL DEFAULT 1,    -- 8.16 上架 / 下架
  daily_limit INTEGER NOT NULL DEFAULT 0,    -- 8.9 每人每日抽取次數，0=不限
  no_repeat   INTEGER NOT NULL DEFAULT 1,    -- 8.10 同轉盤不重複抽到同角色
  exclude_chatted INTEGER NOT NULL DEFAULT 0,-- 8.15 已聊過的角色不再推薦
  start_at    TEXT NOT NULL DEFAULT '',      -- 8.12 期間限定轉盤
  end_at      TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS wheel_roles (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  wheel_id  INTEGER NOT NULL,
  name      TEXT NOT NULL,
  image_url TEXT NOT NULL DEFAULT '',
  intro     TEXT NOT NULL DEFAULT '',
  chat_link TEXT NOT NULL DEFAULT '',
  sort      INTEGER NOT NULL DEFAULT 0,
  author    TEXT NOT NULL DEFAULT '',        -- 8.2 作者
  links     TEXT NOT NULL DEFAULT '[]',      -- 8.2 多個連結 [{emoji,label,url}]
  tags      TEXT NOT NULL DEFAULT '',        -- 8.3 分類標籤（逗號分隔）
  weight    INTEGER NOT NULL DEFAULT 1,      -- 8.11 推薦權重
  enabled   INTEGER NOT NULL DEFAULT 1,
  start_at  TEXT NOT NULL DEFAULT '',        -- 8.12 活動限定角色
  end_at    TEXT NOT NULL DEFAULT '',
  draw_count  INTEGER NOT NULL DEFAULT 0,    -- 8.13 統計
  fav_count   INTEGER NOT NULL DEFAULT 0,
  click_count INTEGER NOT NULL DEFAULT 0
);

-- 8.3 分類標籤主檔（管理員可自行增刪）
CREATE TABLE IF NOT EXISTS wheel_tags (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

-- 8.8 / 8.10 抽取紀錄
CREATE TABLE IF NOT EXISTS wheel_draws (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  wheel_id   INTEGER NOT NULL,
  role_id    INTEGER NOT NULL,
  user_id    TEXT NOT NULL,
  username   TEXT NOT NULL DEFAULT '',
  round      INTEGER NOT NULL DEFAULT 1,     -- 第幾輪（抽完重置後 +1）
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_draws_user ON wheel_draws(user_id, wheel_id, round);

-- 8.7 角色收藏
CREATE TABLE IF NOT EXISTS wheel_favorites (
  user_id    TEXT NOT NULL,
  role_id    INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (user_id, role_id)
);

-- 8.15 已體驗（點過聊天室連結）
CREATE TABLE IF NOT EXISTS wheel_chats (
  user_id    TEXT NOT NULL,
  role_id    INTEGER NOT NULL,
  wheel_id   INTEGER NOT NULL,
  round      INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (user_id, role_id)
);

-- 每位玩家在各轉盤的目前輪次（8.10 / 8.15 重置用）
CREATE TABLE IF NOT EXISTS wheel_rounds (
  user_id  TEXT NOT NULL,
  wheel_id INTEGER NOT NULL,
  round    INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, wheel_id)
);

-- ===== 音樂系統設定（9.2、9.15～9.18、9.21）=====
CREATE TABLE IF NOT EXISTS music_config (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  panel_channel   TEXT NOT NULL DEFAULT '',    -- 9.17 固定控制面板所在文字頻道
  panel_message   TEXT NOT NULL DEFAULT '',    -- 面板訊息 ID（全伺服器只保留一則）
  voice_channel   TEXT NOT NULL DEFAULT '',    -- 9.18 常駐語音頻道
  stay_24_7       INTEGER NOT NULL DEFAULT 0,  -- 9.18 是否常駐不離開
  default_volume  INTEGER NOT NULL DEFAULT 50, -- 9.15
  max_volume      INTEGER NOT NULL DEFAULT 100,
  allow_duplicate INTEGER NOT NULL DEFAULT 1,  -- 9.16 是否允許清單內重複歌曲
  vote_skip       INTEGER NOT NULL DEFAULT 0,  -- 9.7 一般玩家投票跳過
  log_channel     TEXT NOT NULL DEFAULT '',    -- 9.19 播放失敗訊息頻道（空=點歌頻道）
  dj_role_ids     TEXT NOT NULL DEFAULT '',    -- 9.21 可控制播放的身分組
  request_role_ids TEXT NOT NULL DEFAULT '',   -- 9.21 可點歌的身分組（空=全體）
  admin_role_ids  TEXT NOT NULL DEFAULT ''     -- 9.2 可讓機器人加入/退出語音的身分組
);
-- （已移除單例預設列：多伺服器改由 ensureGuild 建立各台設定）
-- 9.20 音樂使用紀錄
CREATE TABLE IF NOT EXISTS music_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL DEFAULT '',
  username   TEXT NOT NULL DEFAULT '',
  action     TEXT NOT NULL DEFAULT 'play',  -- play | skip | stop | fail ...
  title      TEXT NOT NULL DEFAULT '',
  url        TEXT NOT NULL DEFAULT '',
  channel_id TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'ok',    -- ok | fail
  error      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ===== 提醒 =====
CREATE TABLE IF NOT EXISTS reminders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL DEFAULT '',
  message     TEXT NOT NULL DEFAULT '',
  channel_id  TEXT NOT NULL DEFAULT '',
  mention_ids TEXT NOT NULL DEFAULT '',        -- 逗號分隔
  freq        TEXT NOT NULL DEFAULT 'once',     -- once | daily | weekly | monthly
  at_time     TEXT NOT NULL DEFAULT '09:00',    -- HH:MM（once 用 run_at）
  at_dow      INTEGER NOT NULL DEFAULT 1,        -- weekly：0=日..6=六
  at_dom      INTEGER NOT NULL DEFAULT 1,        -- monthly：日
  run_at      TEXT NOT NULL DEFAULT '',          -- once：指定時間
  enabled     INTEGER NOT NULL DEFAULT 1,
  last_run    TEXT NOT NULL DEFAULT '',
  -- 3.4 對象擴充
  mention_role_ids TEXT NOT NULL DEFAULT '',      -- 身分組 ID，逗號分隔
  mention_everyone INTEGER NOT NULL DEFAULT 0,
  do_mention       INTEGER NOT NULL DEFAULT 1,    -- 是否實際標記(ping)
  -- 3.5 內容擴充
  image_url   TEXT NOT NULL DEFAULT '',
  link_url    TEXT NOT NULL DEFAULT '',
  btn_label   TEXT NOT NULL DEFAULT '',
  btn_url     TEXT NOT NULL DEFAULT '',
  creator     TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 提醒發送紀錄（3.8 / 3.9）
CREATE TABLE IF NOT EXISTS reminder_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  reminder_id INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'ok',   -- ok | fail
  error       TEXT NOT NULL DEFAULT '',
  sent_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ===== 論壇整理（索引目錄 + 後台查詢）=====
CREATE TABLE IF NOT EXISTS forum_config (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  forum_ids     TEXT NOT NULL DEFAULT '',      -- 要整理的論壇頻道（逗號分隔，空=全部論壇）
  index_channel TEXT NOT NULL DEFAULT '',      -- 目錄發布頻道
  index_message TEXT NOT NULL DEFAULT '',      -- 目錄訊息 ID（單則，自動更新）
  group_by      TEXT NOT NULL DEFAULT 'author',-- author | tag | none
  sort_by       TEXT NOT NULL DEFAULT 'messages', -- messages | recent | created
  per_page      INTEGER NOT NULL DEFAULT 15,
  show_archived INTEGER NOT NULL DEFAULT 1,
  auto_update   INTEGER NOT NULL DEFAULT 1,    -- 有新貼文/新留言就自動更新目錄
  title         TEXT NOT NULL DEFAULT '📋 論壇整理',
  synced_at     TEXT NOT NULL DEFAULT ''
);
-- （已移除單例預設列：多伺服器改由 ensureGuild 建立各台設定）
CREATE TABLE IF NOT EXISTS forum_posts (
  thread_id     TEXT PRIMARY KEY,
  forum_id      TEXT NOT NULL DEFAULT '',
  forum_name    TEXT NOT NULL DEFAULT '',
  title         TEXT NOT NULL DEFAULT '',
  author_id     TEXT NOT NULL DEFAULT '',
  author_name   TEXT NOT NULL DEFAULT '',
  message_count INTEGER NOT NULL DEFAULT 0,
  tags          TEXT NOT NULL DEFAULT '',
  archived      INTEGER NOT NULL DEFAULT 0,
  pinned        INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT '',
  last_active   TEXT NOT NULL DEFAULT '',
  url           TEXT NOT NULL DEFAULT '',
  synced_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_forum_author ON forum_posts(author_id);
CREATE INDEX IF NOT EXISTS idx_forum_forum ON forum_posts(forum_id, message_count);

-- ===== 表情身分組（公告按表情自動給身分組）=====
CREATE TABLE IF NOT EXISTS reaction_role_maps (
  message_id TEXT NOT NULL,
  channel_id TEXT NOT NULL DEFAULT '',
  emoji      TEXT NOT NULL,
  role_id    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (message_id, emoji)
);

-- ===== 釣魚 / 挖礦掛機系統 =====
-- 一個指令 + 冷卻 → 隨機掉落（N/R/SR/SSR）→ 賣出換貨幣 → 買更好的竿子/鎬子提升稀有率。
-- 貨幣獨立成 econ_wallets，之後其他功能（商店、抽獎）也能共用。
CREATE TABLE IF NOT EXISTS gather_config (
  guild_id       TEXT PRIMARY KEY DEFAULT '',
  enabled        INTEGER NOT NULL DEFAULT 1,
  channels       TEXT NOT NULL DEFAULT '',        -- 限定可用頻道（逗號分隔，空＝全部）
  currency_name  TEXT NOT NULL DEFAULT '星幣',
  currency_emoji TEXT NOT NULL DEFAULT '🪙',
  require_tool   INTEGER NOT NULL DEFAULT 1,       -- 1＝禁止徒手採集（工具壞掉／被抵押就不能採）
  fish_cooldown  INTEGER NOT NULL DEFAULT 300,    -- 秒
  mine_cooldown  INTEGER NOT NULL DEFAULT 300,
  daily_limit    INTEGER NOT NULL DEFAULT 0,      -- 每人每日次數上限（0＝不限）
  start_coins    INTEGER NOT NULL DEFAULT 0,      -- 新玩家初始貨幣
  announce_rare  TEXT NOT NULL DEFAULT 'SSR',     -- 抽到這個稀有度以上時公開廣播（空＝不廣播）
  seeded         INTEGER NOT NULL DEFAULT 0       -- 是否已灌過預設物品/道具
);

-- 可掉落的物品（圖鑑內容）
CREATE TABLE IF NOT EXISTS gather_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id    TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL DEFAULT 'fish',       -- fish＝釣魚 / mine＝挖礦
  name        TEXT NOT NULL DEFAULT '',
  emoji       TEXT NOT NULL DEFAULT '',
  image_url   TEXT NOT NULL DEFAULT '',
  rarity      TEXT NOT NULL DEFAULT 'N',          -- N / R / SR / SSR
  weight      INTEGER NOT NULL DEFAULT 100,       -- 抽中權重（同稀有度內的相對機率）
  price       INTEGER NOT NULL DEFAULT 10,        -- 賣出單價
  description TEXT NOT NULL DEFAULT '',
  enabled     INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_gitems ON gather_items(guild_id, kind, enabled);

-- 可購買的竿子 / 鎬子
CREATE TABLE IF NOT EXISTS gather_tools (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id     TEXT NOT NULL DEFAULT '',
  kind         TEXT NOT NULL DEFAULT 'fish',
  name         TEXT NOT NULL DEFAULT '',
  emoji        TEXT NOT NULL DEFAULT '',
  tier         INTEGER NOT NULL DEFAULT 1,        -- 階級，玩家只吃自己擁有的最高階
  price        INTEGER NOT NULL DEFAULT 100,
  luck         INTEGER NOT NULL DEFAULT 0,        -- 稀有加成 %（拉高 R/SR/SSR 權重）
  cooldown_cut INTEGER NOT NULL DEFAULT 0,        -- 冷卻縮短 %
  durability   INTEGER NOT NULL DEFAULT 0,        -- 最大耐久（使用次數，0＝不會壞）
  repair_cost  INTEGER NOT NULL DEFAULT 0,        -- 修理費（0＝售價一半）
  description  TEXT NOT NULL DEFAULT '',
  enabled      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_gtools ON gather_tools(guild_id, kind, enabled);

-- 玩家錢包（獨立成經濟系統，之後其他功能可共用）
CREATE TABLE IF NOT EXISTS econ_wallets (
  guild_id     TEXT NOT NULL DEFAULT '',
  user_id      TEXT NOT NULL,
  username     TEXT NOT NULL DEFAULT '',
  coins        INTEGER NOT NULL DEFAULT 0,
  total_earned INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (guild_id, user_id)
);

-- 背包 ＋ 圖鑑（count＝目前持有，total_caught＝史上累計，賣掉也不歸零）
CREATE TABLE IF NOT EXISTS gather_inventory (
  guild_id     TEXT NOT NULL DEFAULT '',
  user_id      TEXT NOT NULL,
  item_id      INTEGER NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  total_caught INTEGER NOT NULL DEFAULT 0,
  first_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (guild_id, user_id, item_id)
);

-- 玩家已購買的道具
CREATE TABLE IF NOT EXISTS gather_user_tools (
  guild_id  TEXT NOT NULL DEFAULT '',
  user_id   TEXT NOT NULL,
  tool_id   INTEGER NOT NULL,
  uses_left INTEGER NOT NULL DEFAULT 0,   -- 目前剩餘耐久（durability>0 時有意義）
  bought_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (guild_id, user_id, tool_id)
);

-- 冷卻與每日次數
CREATE TABLE IF NOT EXISTS gather_cooldowns (
  guild_id  TEXT NOT NULL DEFAULT '',
  user_id   TEXT NOT NULL,
  kind      TEXT NOT NULL,
  next_at   INTEGER NOT NULL DEFAULT 0,           -- unix 毫秒
  day       TEXT NOT NULL DEFAULT '',             -- 台北時區的 YYYY-MM-DD
  day_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id, kind)
);

-- ===== 製作 / 鍛造：消耗材料產出新物品 =====
CREATE TABLE IF NOT EXISTS gather_recipes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id     TEXT NOT NULL DEFAULT '',
  kind         TEXT NOT NULL DEFAULT 'craft',   -- craft＝製作 / forge＝鍛造
  name         TEXT NOT NULL DEFAULT '',
  emoji        TEXT NOT NULL DEFAULT '',
  result_type  TEXT NOT NULL DEFAULT 'item',    -- item＝產出掉落物 / tool＝產出道具
  result_id    INTEGER NOT NULL DEFAULT 0,
  result_count INTEGER NOT NULL DEFAULT 1,
  materials    TEXT NOT NULL DEFAULT '[]',      -- [{item_id, count}]
  cost         INTEGER NOT NULL DEFAULT 0,      -- 額外消耗的貨幣
  success_rate INTEGER NOT NULL DEFAULT 100,    -- 成功率 %
  fail_keep    INTEGER NOT NULL DEFAULT 0,      -- 失敗時是否保留材料
  description  TEXT NOT NULL DEFAULT '',
  enabled      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_grecipes ON gather_recipes(guild_id, kind, enabled);

-- ===== 任務系統 =====
CREATE TABLE IF NOT EXISTS quests (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id          TEXT NOT NULL DEFAULT '',
  name              TEXT NOT NULL DEFAULT '',
  description       TEXT NOT NULL DEFAULT '',
  period            TEXT NOT NULL DEFAULT 'daily',   -- daily / weekly / once
  goal_type         TEXT NOT NULL DEFAULT 'gather',  -- gather＝採集次數 / rarity＝抽到稀有度 / item＝取得指定物品 / sell＝賣出金額 / craft＝製作次數
  goal_kind         TEXT NOT NULL DEFAULT '',        -- 限定種類（空＝不限）
  goal_item         INTEGER NOT NULL DEFAULT 0,
  goal_rarity       TEXT NOT NULL DEFAULT '',
  goal_count        INTEGER NOT NULL DEFAULT 10,
  reward_coins      INTEGER NOT NULL DEFAULT 0,
  reward_item       INTEGER NOT NULL DEFAULT 0,
  reward_item_count INTEGER NOT NULL DEFAULT 1,
  reward_role       TEXT NOT NULL DEFAULT '',
  daily_slots       INTEGER NOT NULL DEFAULT 0,       -- 懸賞名額：>0＝每天全服限這麼多人領（先搶先贏），0＝不限
  enabled           INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_quests ON quests(guild_id, enabled);

CREATE TABLE IF NOT EXISTS quest_progress (
  guild_id   TEXT NOT NULL DEFAULT '',
  user_id    TEXT NOT NULL,
  quest_id   INTEGER NOT NULL,
  period_key TEXT NOT NULL DEFAULT '',   -- 每日＝日期／每週＝年-週／一次性＝once
  progress   INTEGER NOT NULL DEFAULT 0,
  claimed    INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (guild_id, user_id, quest_id, period_key)
);

-- ===== 星幣轉帳紀錄（可稽核）=====
CREATE TABLE IF NOT EXISTS econ_transfers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id   TEXT NOT NULL DEFAULT '',
  from_id    TEXT NOT NULL DEFAULT '',
  from_name  TEXT NOT NULL DEFAULT '',
  to_id      TEXT NOT NULL DEFAULT '',
  to_name    TEXT NOT NULL DEFAULT '',
  amount     INTEGER NOT NULL DEFAULT 0,
  fee        INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_transfers ON econ_transfers(guild_id, created_at);

-- ===== 遊戲指令的權限與顯示範圍（逐指令設定）=====
-- roles 空＝全體可用；private=1 代表結果只有本人看得到（Discord 的 ephemeral）。
CREATE TABLE IF NOT EXISTS gather_cmd_perms (
  guild_id TEXT NOT NULL DEFAULT '',
  cmd      TEXT NOT NULL,
  enabled  INTEGER NOT NULL DEFAULT 1,
  roles    TEXT NOT NULL DEFAULT '',
  private  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, cmd)
);

-- ===== 地圖：採集地點。高級地圖每日次數少但幸運（稀有率）高，共用掉落池 =====
CREATE TABLE IF NOT EXISTS gather_maps (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id    TEXT NOT NULL DEFAULT '',
  name        TEXT NOT NULL DEFAULT '',
  emoji       TEXT NOT NULL DEFAULT '',
  daily_limit INTEGER NOT NULL DEFAULT 10,   -- 舊制：使用此地圖時每天可採集的總次數（點數制啟用後不看這個）
  cost        INTEGER NOT NULL DEFAULT 1,    -- 門票：在這張圖採集一次要扣幾點
  luck_bonus  INTEGER NOT NULL DEFAULT 0,    -- 額外幸運 %（提升 R 以上掉落率）
  is_default  INTEGER NOT NULL DEFAULT 0,    -- 新玩家的預設地圖
  sort        INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT '',
  enabled     INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_gmaps ON gather_maps(guild_id, enabled);

-- 每日採集點數的使用量（點數制用；一人一天一筆）
CREATE TABLE IF NOT EXISTS gather_points (
  guild_id TEXT NOT NULL DEFAULT '',
  user_id  TEXT NOT NULL,
  day      TEXT NOT NULL DEFAULT '',
  used     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id, day)
);

-- 玩家目前選擇的地圖
CREATE TABLE IF NOT EXISTS gather_user_map (
  guild_id TEXT NOT NULL DEFAULT '',
  user_id  TEXT NOT NULL,
  map_id   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id)
);

-- ===== 玩家物易物：以物換物，提案與成交都公開公告在頻道 =====
CREATE TABLE IF NOT EXISTS trades (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id     TEXT NOT NULL DEFAULT '',
  from_id      TEXT NOT NULL DEFAULT '',
  from_name    TEXT NOT NULL DEFAULT '',
  to_id        TEXT NOT NULL DEFAULT '',
  to_name      TEXT NOT NULL DEFAULT '',
  give_item_id INTEGER NOT NULL DEFAULT 0,
  give_count   INTEGER NOT NULL DEFAULT 1,
  want_item_id INTEGER NOT NULL DEFAULT 0,
  want_count   INTEGER NOT NULL DEFAULT 1,
  status       TEXT NOT NULL DEFAULT 'pending',   -- pending / done / declined / cancelled / failed
  channel_id   TEXT NOT NULL DEFAULT '',
  message_id   TEXT NOT NULL DEFAULT '',
  expire_at    INTEGER NOT NULL DEFAULT 0,        -- unix 毫秒
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_trades ON trades(guild_id, status);

-- ===== 每日抽籤：一天一次，可抽到星幣或「幸運符」（提升稀有掉落率一段時間）=====
CREATE TABLE IF NOT EXISTS lottery_draws (
  guild_id TEXT NOT NULL DEFAULT '',
  user_id  TEXT NOT NULL,
  day      TEXT NOT NULL DEFAULT '',      -- 台北 YYYY-MM-DD，一天一次
  PRIMARY KEY (guild_id, user_id, day)
);

-- 每日抽籤的獎池：後台可自訂獎項、權重與內容（沒資料時機器人會灌一份預設獎池）
CREATE TABLE IF NOT EXISTS lottery_prizes (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL DEFAULT '',
  name     TEXT NOT NULL DEFAULT '',       -- 獎項名稱，例如「銅獎」
  emoji    TEXT NOT NULL DEFAULT '',
  type     TEXT NOT NULL DEFAULT 'coin',   -- coin＝純星幣／luck＝純幸運符／jackpot＝星幣＋幸運符
  amount   INTEGER NOT NULL DEFAULT 0,     -- 給多少星幣（type=luck 時忽略）
  pct      INTEGER NOT NULL DEFAULT 0,     -- 當日稀有率 +%（type=coin 時忽略）
  weight   INTEGER NOT NULL DEFAULT 10,    -- 抽中權重（相對值）
  sort     INTEGER NOT NULL DEFAULT 0,
  enabled  INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_lotprizes ON lottery_prizes(guild_id, enabled);

-- 幸運加成（抽籤中的幸運符）：expire_at 前，採集稀有率額外 +pct%
CREATE TABLE IF NOT EXISTS luck_buffs (
  guild_id  TEXT NOT NULL DEFAULT '',
  user_id   TEXT NOT NULL,
  pct       INTEGER NOT NULL DEFAULT 0,
  expire_at INTEGER NOT NULL DEFAULT 0,   -- unix 毫秒
  PRIMARY KEY (guild_id, user_id)
);

-- ===== 經營系統（牧場：養動物、每日產蛋/擠奶）=====
-- 動物產出的「蛋/奶/毛」直接寫進 gather_items（kind='farm'），
-- 這樣既能出現在 /背包，也能用現成的 /賣出 賣給 NPC，不必另寫一套。
CREATE TABLE IF NOT EXISTS ranch_config (
  guild_id          TEXT PRIMARY KEY DEFAULT '',
  enabled           INTEGER NOT NULL DEFAULT 1,
  max_slots         INTEGER NOT NULL DEFAULT 6,     -- 每人最多養幾隻
  max_accrue_days   INTEGER NOT NULL DEFAULT 7,     -- 未收成最多累積幾天的產量（防無限囤積）
  steal_enabled     INTEGER NOT NULL DEFAULT 1,
  steal_daily_limit INTEGER NOT NULL DEFAULT 3,     -- 每人每日可偷次數
  steal_success_pct INTEGER NOT NULL DEFAULT 50,    -- 偷取成功機率 %
  steal_take_pct    INTEGER NOT NULL DEFAULT 50,    -- 成功時偷走對方未收成產量的 %（僅 steal_mode='pct' 時使用）
  steal_mode        TEXT NOT NULL DEFAULT 'one',    -- one＝一次只偷 1 個產物或 1 隻動物／pct＝每格各偷 take_pct%
  steal_guard       INTEGER NOT NULL DEFAULT 0,     -- 1＝看門狗/貓也可以被偷走
  hatch_slots       INTEGER NOT NULL DEFAULT 3,     -- 孵化室格數
  seeded            INTEGER NOT NULL DEFAULT 0
);

-- 可購買的動物（畜牧商店內容）
CREATE TABLE IF NOT EXISTS ranch_animals (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id        TEXT NOT NULL DEFAULT '',
  name            TEXT NOT NULL DEFAULT '',
  emoji           TEXT NOT NULL DEFAULT '',
  price           INTEGER NOT NULL DEFAULT 500,     -- 購買價（金幣）
  product_item_id INTEGER NOT NULL DEFAULT 0,       -- 對應 gather_items 的產物（蛋/奶…）
  produce_per_day INTEGER NOT NULL DEFAULT 1,       -- 每天生產數量（未設間隔時用來平均換算）
  produce_interval_minutes INTEGER NOT NULL DEFAULT 0,  -- 每產 1 單位要幾分鐘（0＝由每日產量換算）
  sort            INTEGER NOT NULL DEFAULT 0,
  description     TEXT NOT NULL DEFAULT '',
  guard_pct       INTEGER NOT NULL DEFAULT 0,        -- 看門反擊機率 %（>0＝看門動物，不產蛋奶）
  guard_penalty   INTEGER NOT NULL DEFAULT 0,        -- 反擊時小偷最多掉幾星幣
  enabled         INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_ranimals ON ranch_animals(guild_id, enabled);

-- 玩家擁有的動物（一格一隻，pending＝尚未收成、可被偷的產量）
CREATE TABLE IF NOT EXISTS ranch_slots (
  guild_id         TEXT NOT NULL DEFAULT '',
  user_id          TEXT NOT NULL,
  slot             INTEGER NOT NULL,                -- 0..max_slots-1
  animal_id        INTEGER NOT NULL,
  pending          INTEGER NOT NULL DEFAULT 0,      -- 未收成產量（可被偷）
  last_produce_day TEXT NOT NULL DEFAULT '',        -- 舊：台北日期（保留相容）
  last_produce_ms  INTEGER NOT NULL DEFAULT 0,      -- 每單位計時：上次結算的 unix 毫秒
  bought_at        TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (guild_id, user_id, slot)
);
CREATE INDEX IF NOT EXISTS idx_rslots ON ranch_slots(guild_id, user_id);

-- 玩家用「製作」開出來的額外牧場/孵化室格數（總格數＝設定的初始格 + 這裡的解鎖數）
CREATE TABLE IF NOT EXISTS ranch_unlocks (
  guild_id TEXT NOT NULL DEFAULT '',
  user_id  TEXT NOT NULL,
  ranch    INTEGER NOT NULL DEFAULT 0,
  hatch    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id)
);

-- 偷竊公告路由：依「被偷者的身分組」把公告發到對應頻道（身分組 ↔ 頻道 一組一組對）
CREATE TABLE IF NOT EXISTS ranch_steal_routes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id   TEXT NOT NULL DEFAULT '',
  role_id    TEXT NOT NULL DEFAULT '',
  channel_id TEXT NOT NULL DEFAULT '',
  sort       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_stealroutes ON ranch_steal_routes(guild_id);

-- 每人每日偷取次數
CREATE TABLE IF NOT EXISTS ranch_steal (
  guild_id TEXT NOT NULL DEFAULT '',
  user_id  TEXT NOT NULL,
  day      TEXT NOT NULL DEFAULT '',
  count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id, day)
);

-- ===== 孵化室：蛋（gather_items）→ 時間到 → 孵成牧場動物 =====
-- egg_item_id 是任何一個 gather_items（採集撿到的蛋、或動物生的蛋都行）。
CREATE TABLE IF NOT EXISTS ranch_hatch_defs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id      TEXT NOT NULL DEFAULT '',
  egg_item_id   INTEGER NOT NULL,                 -- 要放進孵化室的蛋
  animal_id     INTEGER NOT NULL,                 -- 孵出來的動物
  hatch_minutes INTEGER NOT NULL DEFAULT 240,     -- 孵化需要幾分鐘
  fail_pct      INTEGER NOT NULL DEFAULT 0,       -- 孵化失敗機率 %（失敗那顆蛋就沒了）
  sort          INTEGER NOT NULL DEFAULT 0,
  enabled       INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_rhatch ON ranch_hatch_defs(guild_id, enabled);

-- ===== 特殊兌換商店：花星幣換虛擬獎勵（捏圖等），兌換後貼到對應頻道並標記管理員 =====
CREATE TABLE IF NOT EXISTS special_config (
  guild_id    TEXT PRIMARY KEY DEFAULT '',
  enabled     INTEGER NOT NULL DEFAULT 1,
  admin_roles TEXT NOT NULL DEFAULT '',    -- 兌換時要 @ 的管理員身分組（逗號分隔 role_id）
  admin_users TEXT NOT NULL DEFAULT '',    -- 兌換時要 @ 的管理員（逗號分隔 user_id）
  log_channel TEXT NOT NULL DEFAULT '',    -- 商品沒設頻道時的預設公告頻道
  channel_scoped INTEGER NOT NULL DEFAULT 0, -- 1＝在有綁分店的頻道只顯示該分店（其他頻道仍看全部）
  -- 兌換通知去哪：shop＝商店頻道（公開，大家看得到誰換了什麼）／log＝只發到管理員通知頻道／dm＝只私訊管理員
  notify_mode TEXT NOT NULL DEFAULT 'shop',
  per_item_limit INTEGER NOT NULL DEFAULT 0,   -- 每人每期每項最多幾份（0＝不限）
  price_escalate INTEGER NOT NULL DEFAULT 0,   -- 1＝開啟累進價格
  escalate_mult  REAL NOT NULL DEFAULT 2,      -- 每多買一次就乘一次這個倍率
  limit_reset    TEXT NOT NULL DEFAULT 'month' -- month＝每月 1 號歸零／week＝每週一／none＝不重置
);

CREATE TABLE IF NOT EXISTS special_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id    TEXT NOT NULL DEFAULT '',
  name        TEXT NOT NULL DEFAULT '',
  emoji       TEXT NOT NULL DEFAULT '',
  price       INTEGER NOT NULL DEFAULT 1000,
  channel_id  TEXT NOT NULL DEFAULT '',    -- 兌換後公告要貼的頻道（對應身分組的頻道）
  role_id     TEXT NOT NULL DEFAULT '',    -- 對應身分組（顯示/標記用，可空）
  image_url   TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  stock       INTEGER NOT NULL DEFAULT -1, -- 庫存，-1＝無限
  sort        INTEGER NOT NULL DEFAULT 0,
  enabled     INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_special ON special_items(guild_id, enabled);

-- 兌換紀錄（可稽核，避免私下交易疑慮）
CREATE TABLE IF NOT EXISTS special_redeems (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id   TEXT NOT NULL DEFAULT '',
  user_id    TEXT NOT NULL DEFAULT '',
  username   TEXT NOT NULL DEFAULT '',
  item_id    INTEGER NOT NULL DEFAULT 0,
  item_name  TEXT NOT NULL DEFAULT '',
  price      INTEGER NOT NULL DEFAULT 0,        -- 單價（總價＝price×qty）
  qty        INTEGER NOT NULL DEFAULT 1,        -- 兌換份數
  paid       INTEGER NOT NULL DEFAULT 0,        -- 實付總額（累進價格時 price×qty 會有誤差，以這欄為準）
  status     TEXT NOT NULL DEFAULT 'pending',   -- pending / done
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_sredeems ON special_redeems(guild_id, created_at);

-- ===== 種植系統：農地種作物 / 溫室種花卉 =====
CREATE TABLE IF NOT EXISTS crop_config (
  guild_id         TEXT PRIMARY KEY DEFAULT '',
  enabled          INTEGER NOT NULL DEFAULT 1,
  field_slots      INTEGER NOT NULL DEFAULT 0,   -- 初始農地格（其餘靠 /製作 開）
  greenhouse_slots INTEGER NOT NULL DEFAULT 0,   -- 初始溫室格（其餘靠 /製作 開）
  seeded           INTEGER NOT NULL DEFAULT 0
);

-- ===== 設施商店：農地／溫室／牧場／孵化室，用星幣買「等級」換總格數 =====
-- 跟工具一樣分階級：買高階會取代低階（總格數以最高階為準，不是累加）。
CREATE TABLE IF NOT EXISTS facility_defs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id    TEXT NOT NULL DEFAULT '',
  type        TEXT NOT NULL DEFAULT 'field',   -- field/greenhouse/ranch/hatch
  tier        INTEGER NOT NULL DEFAULT 1,      -- 階級，同型別內遞增
  name        TEXT NOT NULL DEFAULT '',
  emoji       TEXT NOT NULL DEFAULT '',
  price       INTEGER NOT NULL DEFAULT 0,
  slots       INTEGER NOT NULL DEFAULT 1,      -- 這一階提供的「總格數」
  speed_pct   INTEGER NOT NULL DEFAULT 0,      -- 產出／成熟／孵化時間縮短 %
  resist_pct  INTEGER NOT NULL DEFAULT 0,      -- 牧場專用：被偷成功率降低 %
  description TEXT NOT NULL DEFAULT '',
  sort        INTEGER NOT NULL DEFAULT 0,
  enabled     INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_facdefs ON facility_defs(guild_id, type, tier);

-- 玩家目前擁有的設施階級（一種設施一筆，買更高階就覆蓋）
CREATE TABLE IF NOT EXISTS facility_owned (
  guild_id  TEXT NOT NULL DEFAULT '',
  user_id   TEXT NOT NULL,
  type      TEXT NOT NULL DEFAULT 'field',
  tier      INTEGER NOT NULL DEFAULT 0,
  slots     INTEGER NOT NULL DEFAULT 0,
  speed_pct  INTEGER NOT NULL DEFAULT 0,
  resist_pct INTEGER NOT NULL DEFAULT 0,
  bought_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (guild_id, user_id, type)
);

-- 可購買的種子（含成熟後的產物）
CREATE TABLE IF NOT EXISTS crop_seeds (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id        TEXT NOT NULL DEFAULT '',
  name            TEXT NOT NULL DEFAULT '',      -- 種子名稱（例如 番茄種子）
  emoji           TEXT NOT NULL DEFAULT '',
  plot_type       TEXT NOT NULL DEFAULT 'field', -- field＝農地 / greenhouse＝溫室
  seed_price      INTEGER NOT NULL DEFAULT 20,   -- 購買種子價
  grow_minutes    INTEGER NOT NULL DEFAULT 180,  -- 成熟需要幾分鐘
  product_item_id INTEGER NOT NULL DEFAULT 0,    -- 成熟收成的作物（gather_items kind='farm'）
  yield_count     INTEGER NOT NULL DEFAULT 1,    -- 一次收成幾個
  sort            INTEGER NOT NULL DEFAULT 0,
  description     TEXT NOT NULL DEFAULT '',
  enabled         INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_cropseeds ON crop_seeds(guild_id, enabled);

-- 玩家用「製作」開出來的額外農地/溫室格數（總格數＝設定的初始格 + 這裡的解鎖數）
CREATE TABLE IF NOT EXISTS crop_unlocks (
  guild_id   TEXT NOT NULL DEFAULT '',
  user_id    TEXT NOT NULL,
  field      INTEGER NOT NULL DEFAULT 0,
  greenhouse INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id)
);

-- 玩家種下的作物（一格一株，ready_at 到了可收成）
CREATE TABLE IF NOT EXISTS crop_plots (
  guild_id   TEXT NOT NULL DEFAULT '',
  user_id    TEXT NOT NULL,
  plot_type  TEXT NOT NULL DEFAULT 'field',
  slot       INTEGER NOT NULL,
  seed_id    INTEGER NOT NULL,
  ready_at   INTEGER NOT NULL DEFAULT 0,        -- unix 毫秒
  planted_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (guild_id, user_id, plot_type, slot)
);
CREATE INDEX IF NOT EXISTS idx_cropplots ON crop_plots(guild_id, user_id);

-- ===== 多間特殊商店：每間可發布面板到自己的頻道 =====
CREATE TABLE IF NOT EXISTS special_shops (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id    TEXT NOT NULL DEFAULT '',
  name        TEXT NOT NULL DEFAULT '',
  emoji       TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  channel_id  TEXT NOT NULL DEFAULT '',   -- 發布商店面板的頻道
  message_id  TEXT NOT NULL DEFAULT '',   -- 已發布面板的訊息 id
  sort        INTEGER NOT NULL DEFAULT 0,
  enabled     INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_sshops ON special_shops(guild_id, enabled);

-- 玩家的孵化室（一格一顆蛋，ready_at 到了就可孵成動物進牧場）
CREATE TABLE IF NOT EXISTS ranch_incubator (
  guild_id    TEXT NOT NULL DEFAULT '',
  user_id     TEXT NOT NULL,
  slot        INTEGER NOT NULL,                   -- 0..hatch_slots-1
  egg_item_id INTEGER NOT NULL,
  animal_id   INTEGER NOT NULL,
  ready_at    INTEGER NOT NULL DEFAULT 0,         -- unix 毫秒
  started_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (guild_id, user_id, slot)
);
CREATE INDEX IF NOT EXISTS idx_rincu ON ranch_incubator(guild_id, user_id);

-- ===================================================================
-- 財經新聞快報 ＋ 星幣股市
-- 兩個子系統共用一組「新聞」：一則新聞可以同時推動物價與股價。
-- 預設兩個都關閉（enabled / stock_enabled 皆為 0），後台開啟才會運作。
-- ===================================================================

-- 總設定（一台伺服器一筆）
CREATE TABLE IF NOT EXISTS market_config (
  guild_id          TEXT PRIMARY KEY,
  enabled           INTEGER NOT NULL DEFAULT 0,   -- 新聞快報／物價浮動（預設關）
  stock_enabled     INTEGER NOT NULL DEFAULT 0,   -- 星幣股市（預設關）
  channels          TEXT    NOT NULL DEFAULT '',  -- 允許下股市指令的頻道（空＝不限）
  news_channel      TEXT    NOT NULL DEFAULT '',  -- 快報發布頻道
  tick_minutes      INTEGER NOT NULL DEFAULT 60,  -- 股價幾分鐘結算一次
  fee_pct           REAL NOT NULL DEFAULT 2,      -- 買賣交易稅 %（銷毀）；可填小數，例如 1.5
  limit_pct         INTEGER NOT NULL DEFAULT 20,  -- 單次結算漲跌停 %
  min_trade         INTEGER NOT NULL DEFAULT 1,
  max_trade         INTEGER NOT NULL DEFAULT 100,
  max_shares        INTEGER NOT NULL DEFAULT 500, -- 每人持股上限：所有股票加總的股數（0＝不限）
  trade_cooldown_s  INTEGER NOT NULL DEFAULT 30,
  daily_trade_limit INTEGER NOT NULL DEFAULT 0,   -- 0＝不限
  mult_floor_pct    INTEGER NOT NULL DEFAULT 40,  -- 物價倍率下限 %
  mult_ceil_pct     INTEGER NOT NULL DEFAULT 250, -- 物價倍率上限 %
  burned_total      INTEGER NOT NULL DEFAULT 0,   -- 累計銷毀星幣（回收 KPI）
  last_tick_ms      INTEGER NOT NULL DEFAULT 0,
  seeded            INTEGER NOT NULL DEFAULT 0
);

-- 行情倍率：新聞的物價效果落在這裡，到期自動失效（不需要清理排程）
CREATE TABLE IF NOT EXISTS market_modifiers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id   TEXT NOT NULL DEFAULT '',
  news_id    INTEGER NOT NULL DEFAULT 0,
  scope      TEXT NOT NULL DEFAULT 'all',   -- all | item | kind | crop | ranch
  scope_key  TEXT NOT NULL DEFAULT '',      -- item→item_id；kind→fish/mine/wood/forage/hunt
  mult_pct   INTEGER NOT NULL DEFAULT 100,  -- 130＝賣價 ×1.3
  start_ts   INTEGER NOT NULL DEFAULT 0,
  end_ts     INTEGER NOT NULL DEFAULT 0,
  label      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_mmod ON market_modifiers(guild_id, end_ts);

-- 新聞快報（管理員發布；可同時帶物價效果與股價衝擊）
CREATE TABLE IF NOT EXISTS market_news (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id    TEXT NOT NULL DEFAULT '',
  headline    TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  image_url   TEXT NOT NULL DEFAULT '',
  duration_h  INTEGER NOT NULL DEFAULT 6,          -- 物價效果持續幾小時
  effects     TEXT NOT NULL DEFAULT '[]',          -- JSON：[{scope,scope_key,mult_pct}]
  stock_fx    TEXT NOT NULL DEFAULT '[]',          -- JSON：[{symbol_id,impact_pct,vol_mult}]
  effect_ts   INTEGER NOT NULL DEFAULT 0,          -- 生效時間（unix ms，0＝立即）
  applied     INTEGER NOT NULL DEFAULT 0,          -- 1＝倍率已建立
  stock_done  INTEGER NOT NULL DEFAULT 0,          -- 1＝股價衝擊已在某個 tick 套用過
  announced   INTEGER NOT NULL DEFAULT 0,          -- 1＝已發到 Discord
  created_by  TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_mnews ON market_news(guild_id, applied, announced);

-- 股票
CREATE TABLE IF NOT EXISTS stock_symbols (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id    TEXT NOT NULL DEFAULT '',
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  emoji       TEXT NOT NULL DEFAULT '',
  price       INTEGER NOT NULL DEFAULT 100,
  anchor      INTEGER NOT NULL DEFAULT 100,        -- 均值回歸的錨
  vol_pct     INTEGER NOT NULL DEFAULT 8,          -- 每 tick 波動率 %
  drift_pct   INTEGER NOT NULL DEFAULT 0,          -- 長期趨勢 %／tick
  revert_pct  INTEGER NOT NULL DEFAULT 10,         -- 回歸強度 %
  floor_price INTEGER NOT NULL DEFAULT 10,
  ceil_price  INTEGER NOT NULL DEFAULT 100000,
  description TEXT NOT NULL DEFAULT '',
  sort        INTEGER NOT NULL DEFAULT 0,
  enabled     INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_scode ON stock_symbols(guild_id, code);

-- K 線（一根＝一個 tick）
CREATE TABLE IF NOT EXISTS stock_prices (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id  TEXT NOT NULL DEFAULT '',
  symbol_id INTEGER NOT NULL,
  ts        INTEGER NOT NULL,
  open      INTEGER NOT NULL,
  high      INTEGER NOT NULL,
  low       INTEGER NOT NULL,
  close     INTEGER NOT NULL,
  volume    INTEGER NOT NULL DEFAULT 0,
  news_id   INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_spx ON stock_prices(guild_id, symbol_id, ts);

-- 持股
CREATE TABLE IF NOT EXISTS stock_holdings (
  guild_id  TEXT NOT NULL DEFAULT '',
  user_id   TEXT NOT NULL,
  symbol_id INTEGER NOT NULL,
  shares    INTEGER NOT NULL DEFAULT 0,
  cost_sum  INTEGER NOT NULL DEFAULT 0,            -- 累計成本（含手續費）
  realized  INTEGER NOT NULL DEFAULT 0,            -- 已實現損益
  PRIMARY KEY (guild_id, user_id, symbol_id)
);

-- 成交紀錄
CREATE TABLE IF NOT EXISTS stock_trades (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id  TEXT NOT NULL DEFAULT '',
  user_id   TEXT NOT NULL,
  username  TEXT NOT NULL DEFAULT '',
  symbol_id INTEGER NOT NULL,
  side      TEXT NOT NULL,
  shares    INTEGER NOT NULL,
  price     INTEGER NOT NULL,
  fee       INTEGER NOT NULL DEFAULT 0,
  pnl       INTEGER NOT NULL DEFAULT 0,
  ts        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_str ON stock_trades(guild_id, user_id, ts);

-- 交易冷卻／每日次數
CREATE TABLE IF NOT EXISTS stock_user_state (
  guild_id      TEXT NOT NULL DEFAULT '',
  user_id       TEXT NOT NULL,
  last_trade_ms INTEGER NOT NULL DEFAULT 0,
  day_key       TEXT NOT NULL DEFAULT '',
  day_trades    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id)
);

-- ===== 魚缸：只養 SSR 觀賞魚，每天要花星幣買飼料，魚會慢慢產星幣 =====
-- 跟牧場的差別：產出直接是星幣（不是背包物品）、魚很貴、沒餵會餓死、金幣可以被偷。
CREATE TABLE IF NOT EXISTS aquarium_config (
  guild_id          TEXT PRIMARY KEY DEFAULT '',
  enabled           INTEGER NOT NULL DEFAULT 1,
  max_slots         INTEGER NOT NULL DEFAULT 8,    -- 每人的魚缸格數（人人都有，不用買）
  feed_hours        INTEGER NOT NULL DEFAULT 24,   -- 餵一次可以撐幾小時
  stock_hours       INTEGER NOT NULL DEFAULT 48,   -- 最多可以先餵到幾小時後（防一次餵一年）
  starve_hours      INTEGER NOT NULL DEFAULT 48,   -- 餓超過幾小時就死掉
  max_accrue_days   INTEGER NOT NULL DEFAULT 3,    -- 未領取的星幣最多累積幾天份
  steal_enabled     INTEGER NOT NULL DEFAULT 1,
  steal_daily_limit INTEGER NOT NULL DEFAULT 2,    -- 每人每日可偷魚缸幾次
  steal_success_pct INTEGER NOT NULL DEFAULT 40,
  steal_take_pct    INTEGER NOT NULL DEFAULT 20,   -- 成功時偷走對方未領取星幣的 %
  steal_fish_pct    INTEGER NOT NULL DEFAULT 3,    -- 偷成功時，再有多少 % 機率整條魚被撈走
  seeded            INTEGER NOT NULL DEFAULT 0
);

-- 可購買的 SSR 魚（水族商店內容）
CREATE TABLE IF NOT EXISTS aquarium_fish (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id     TEXT NOT NULL DEFAULT '',
  name         TEXT NOT NULL DEFAULT '',
  emoji        TEXT NOT NULL DEFAULT '',
  price        INTEGER NOT NULL DEFAULT 3000,   -- 購買價（很貴，SSR 才養得起）
  coin_per_day INTEGER NOT NULL DEFAULT 100,    -- 每天產出的星幣（餵飽才會產）
  feed_cost    INTEGER NOT NULL DEFAULT 40,     -- 餵一次的飼料費（星幣）
  sort         INTEGER NOT NULL DEFAULT 0,
  description  TEXT NOT NULL DEFAULT '',
  catch_item_id INTEGER NOT NULL DEFAULT 0,      -- >0＝這種魚是「釣到才能存進缸」的（對應 gather_items 的 id），不在水族商店賣
  enabled      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_aqfish ON aquarium_fish(guild_id, enabled);

-- 玩家的魚缸（一格一條魚）
CREATE TABLE IF NOT EXISTS aquarium_slots (
  guild_id        TEXT NOT NULL DEFAULT '',
  user_id         TEXT NOT NULL,
  slot            INTEGER NOT NULL,             -- 0..max_slots-1
  fish_id         INTEGER NOT NULL,
  pending         INTEGER NOT NULL DEFAULT 0,   -- 尚未領取的星幣（可被偷）
  last_produce_ms INTEGER NOT NULL DEFAULT 0,   -- 上次結算時間
  fed_until_ms    INTEGER NOT NULL DEFAULT 0,   -- 飼料吃到什麼時候（過了就開始餓）
  bought_at       TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (guild_id, user_id, slot)
);
CREATE INDEX IF NOT EXISTS idx_aqslots ON aquarium_slots(guild_id, user_id);

-- 每人每日偷魚缸次數
CREATE TABLE IF NOT EXISTS aquarium_steal (
  guild_id TEXT NOT NULL DEFAULT '',
  user_id  TEXT NOT NULL,
  day      TEXT NOT NULL DEFAULT '',
  count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id, day)
);

-- 用 /製作 蓋出來的魚缸格數（跟設施商店買的相加）
CREATE TABLE IF NOT EXISTS aquarium_unlocks (
  guild_id TEXT NOT NULL DEFAULT '',
  user_id  TEXT NOT NULL,
  aquarium INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id)
);

-- ===== 稅金系統：每週結算的農地稅／養殖稅／所得稅 =====
-- 目的是把囤積的貨幣抽回去，壓制通膨；每一項都能單獨開關與調整。
CREATE TABLE IF NOT EXISTS tax_config (
  guild_id       TEXT PRIMARY KEY DEFAULT '',
  enabled        INTEGER NOT NULL DEFAULT 0,
  period         TEXT NOT NULL DEFAULT 'week',   -- week / day / month
  dow            INTEGER NOT NULL DEFAULT 1,     -- 每週幾課（0=日…6=六），period=week 用
  dom            INTEGER NOT NULL DEFAULT 1,     -- 每月幾號課，period=month 用
  run_time       TEXT NOT NULL DEFAULT '09:00',  -- 台北時間
  channel        TEXT NOT NULL DEFAULT '',       -- 公告頻道（空＝不公告）
  dm_bill        INTEGER NOT NULL DEFAULT 1,     -- 是否私訊個人稅單
  min_total      INTEGER NOT NULL DEFAULT 1,     -- 稅額低於此值就免徵（省得洗版）
  -- 所得稅（對「目前餘額」累進課徵）
  income_enabled INTEGER NOT NULL DEFAULT 1,
  income_free    INTEGER NOT NULL DEFAULT 100000,  -- 免稅額：餘額低於此不課
  income_brackets TEXT NOT NULL DEFAULT '',        -- JSON [{"over":100000,"pct":5},…]：超過 over 的部分課 pct%
  income_max_pct INTEGER NOT NULL DEFAULT 50,      -- 單次稅額上限（占餘額 %），避免一次被抄家
  income_flat    INTEGER NOT NULL DEFAULT 1,       -- 1＝整筆跳級（整個餘額 × 適用級距 %）；0＝分段累進
  income_base    TEXT NOT NULL DEFAULT 'balance', -- balance＝目前餘額／earned＝本期總收入／max＝兩者取高
  -- 農地稅（依「已種著的格數」課，空地不課）
  land_enabled   INTEGER NOT NULL DEFAULT 1,
  land_field     INTEGER NOT NULL DEFAULT 50,      -- 每格農地
  land_greenhouse INTEGER NOT NULL DEFAULT 120,    -- 每格溫室
  land_free      INTEGER NOT NULL DEFAULT 2,       -- 前幾格免稅
  -- 養殖稅（牧場動物＋魚缸的魚）
  breed_enabled  INTEGER NOT NULL DEFAULT 1,
  breed_animal   INTEGER NOT NULL DEFAULT 80,      -- 每隻牧場動物
  breed_fish     INTEGER NOT NULL DEFAULT 200,     -- 每條 SSR 魚
  breed_free     INTEGER NOT NULL DEFAULT 1,       -- 前幾隻/條免稅
  -- 證券稅（依「持股市值」課，股票也要繳稅）
  stock_enabled  INTEGER NOT NULL DEFAULT 0,
  stock_pct      REAL NOT NULL DEFAULT 5,        -- 持股市值的 %
  stock_free     INTEGER NOT NULL DEFAULT 0,     -- 市值免稅額
  -- 消費稅：本期在神秘商店兌換掉的金額（花掉的錢也要課，堵住「換圖逃稅」）
  spend_enabled  INTEGER NOT NULL DEFAULT 0,
  spend_pct      REAL NOT NULL DEFAULT 20,       -- 本期兌換金額的 %
  spend_free     INTEGER NOT NULL DEFAULT 0,     -- 兌換金額免稅額
  last_run_at    TEXT NOT NULL DEFAULT '',       -- 上次實際結算時間，界定「本期」
  -- 強制清算：課完稅還是負數的人，系統自動變賣資產抵債
  liquidate_enabled INTEGER NOT NULL DEFAULT 0,
  liquidate_order TEXT NOT NULL DEFAULT 'stock',   -- 變賣順序（預設只賣股票：農場／魚缸被收會讓人不想玩）
  -- 普發（救濟金）：課完稅後，把窮／欠稅的人拉回來，縮小貧富差距
  relief_enabled INTEGER NOT NULL DEFAULT 0,
  relief_below   INTEGER NOT NULL DEFAULT 0,       -- 餘額低於這個數字才發（0＝只發給負債的人）
  relief_mode    TEXT NOT NULL DEFAULT 'floor',    -- floor＝補到保底金額；fixed＝每人發固定金額
  relief_amount  INTEGER NOT NULL DEFAULT 10000,   -- fixed 模式：每人發多少
  relief_floor   INTEGER NOT NULL DEFAULT 0,       -- floor 模式：補到餘額至少這麼多
  relief_max     INTEGER NOT NULL DEFAULT 0,       -- 每人單期最多領多少（0＝不限）
  relief_from_tax INTEGER NOT NULL DEFAULT 1,      -- 1＝總發放不超過本期稅收（不夠就等比例縮減）
  exempt_users   TEXT NOT NULL DEFAULT '',        -- 免稅名單：user_id 逗號分隔（管理員/測試帳號）
  exempt_roles   TEXT NOT NULL DEFAULT '',        -- 免稅身分組：role_id 逗號分隔
  no_debt        INTEGER NOT NULL DEFAULT 1,       -- 1＝課完稅不讓餘額變負數（錢不夠就只課到 0，差額記為未繳）
  last_period    TEXT NOT NULL DEFAULT ''          -- 上次結算的期間代碼，避免同一期重複課
);

-- 每期每人的稅單（也是後台稅收報表的來源）
CREATE TABLE IF NOT EXISTS tax_records (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id   TEXT NOT NULL DEFAULT '',
  period     TEXT NOT NULL DEFAULT '',        -- 期間代碼，例如 2026-08-10
  user_id    TEXT NOT NULL,
  username   TEXT NOT NULL DEFAULT '',
  balance    INTEGER NOT NULL DEFAULT 0,      -- 課稅當下的餘額
  income_tax INTEGER NOT NULL DEFAULT 0,
  land_tax   INTEGER NOT NULL DEFAULT 0,
  breed_tax  INTEGER NOT NULL DEFAULT 0,
  stock_tax  INTEGER NOT NULL DEFAULT 0,      -- 證券稅（持股市值）
  spend_tax  INTEGER NOT NULL DEFAULT 0,      -- 消費稅（本期兌換金額）
  total      INTEGER NOT NULL DEFAULT 0,      -- 應繳
  paid       INTEGER NOT NULL DEFAULT 0,      -- 實繳（＝應繳全額，餘額不夠就欠稅變負數）
  detail     TEXT NOT NULL DEFAULT '',        -- 課稅明細（格數/隻數）
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_tax_records ON tax_records(guild_id, period);
CREATE INDEX IF NOT EXISTS idx_tax_records_user ON tax_records(guild_id, user_id);

-- 普發紀錄：每期發給誰、發多少（跟稅單分開，因為領普發的人不一定有繳稅）
CREATE TABLE IF NOT EXISTS tax_reliefs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id   TEXT NOT NULL DEFAULT '',
  period     TEXT NOT NULL DEFAULT '',
  user_id    TEXT NOT NULL,
  username   TEXT NOT NULL DEFAULT '',
  before_coins INTEGER NOT NULL DEFAULT 0,
  amount     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_tax_reliefs ON tax_reliefs(guild_id, period);

-- 強制清算紀錄：欠稅時系統賣掉了哪些資產、賣了多少
CREATE TABLE IF NOT EXISTS tax_liquidations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id   TEXT NOT NULL DEFAULT '',
  period     TEXT NOT NULL DEFAULT '',
  user_id    TEXT NOT NULL,
  username   TEXT NOT NULL DEFAULT '',
  kind       TEXT NOT NULL DEFAULT '',        -- bag / stock / fish / animal
  detail     TEXT NOT NULL DEFAULT '',        -- 賣了什麼
  amount     INTEGER NOT NULL DEFAULT 0,      -- 賣得多少星幣
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_tax_liq ON tax_liquidations(guild_id, period);

-- ================== 慈善基金會 ==================
-- 玩家 /捐款 把星幣捐進基金會，餘額全服公開；捐款可折抵稅額，
-- 基金會的錢再流進普發池 → 捐款直接變成救濟金。
CREATE TABLE IF NOT EXISTS charity_config (
  guild_id       TEXT PRIMARY KEY DEFAULT '',
  enabled        INTEGER NOT NULL DEFAULT 0,
  name           TEXT NOT NULL DEFAULT '慈善基金會',
  min_donate     INTEGER NOT NULL DEFAULT 1000,   -- 單筆最低捐款
  deduct_pct     REAL NOT NULL DEFAULT 10,        -- 捐款可折抵稅額的比例（10＝捐 10 萬折抵 1 萬）
  deduct_max     INTEGER NOT NULL DEFAULT 0,      -- 每人每期折抵上限（0＝不限）
  deduct_max_pct INTEGER NOT NULL DEFAULT 100,    -- 折抵最多能抵掉稅金的 %（100＝可全免）
  to_relief      INTEGER NOT NULL DEFAULT 1,      -- 1＝基金會餘額自動當普發財源
  channel        TEXT NOT NULL DEFAULT '',        -- 捐款公告頻道（空＝不公告）
  pool           INTEGER NOT NULL DEFAULT 0,      -- 目前基金會餘額
  total_in       INTEGER NOT NULL DEFAULT 0,      -- 歷史累計募得
  total_out      INTEGER NOT NULL DEFAULT 0       -- 歷史累計撥給普發
);

-- 每一筆捐款（公開透明：誰捐了多少）
CREATE TABLE IF NOT EXISTS charity_donations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id   TEXT NOT NULL DEFAULT '',
  user_id    TEXT NOT NULL,
  username   TEXT NOT NULL DEFAULT '',
  amount     INTEGER NOT NULL DEFAULT 0,
  credit     INTEGER NOT NULL DEFAULT 0,      -- 捐款當下的可折抵稅額（預估，實際折抵記在 tax_records）
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_charity_don ON charity_donations(guild_id, created_at);
CREATE INDEX IF NOT EXISTS idx_charity_don_user ON charity_donations(guild_id, user_id);

-- 基金會撥款紀錄（撥給哪一期的普發、撥了多少）
CREATE TABLE IF NOT EXISTS charity_payouts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id   TEXT NOT NULL DEFAULT '',
  period     TEXT NOT NULL DEFAULT '',
  amount     INTEGER NOT NULL DEFAULT 0,
  people     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_charity_pay ON charity_payouts(guild_id, period);

-- ================== 物資貸款（抵押借星幣） ==================
-- 拿工具／農地作物／魚缸的魚當抵押品借錢，抵押品由系統代管（借出期間不能用、不能賣）。
-- 工具被抵押走就不能採集（禁止徒手），農地作物被押走就收不到成、魚被押走就不產星幣。
-- 到期還不出來 → 沒收抵押品（延後版的強制清算，給人喘息空間）。
CREATE TABLE IF NOT EXISTS loan_config (
  guild_id     TEXT PRIMARY KEY DEFAULT '',
  enabled      INTEGER NOT NULL DEFAULT 0,
  ltv_pct      INTEGER NOT NULL DEFAULT 70,     -- 可借金額 ÷ 抵押品估值
  max_loan     INTEGER NOT NULL DEFAULT 0,      -- 單筆上限（0＝不限）
  max_open     INTEGER NOT NULL DEFAULT 1,      -- 同時最多幾筆未還清
  term_days    INTEGER NOT NULL DEFAULT 7,      -- 幾天內要還
  interest_pct REAL NOT NULL DEFAULT 5,         -- 利息（一次性，借出時就算進應還金額）
  debtor_only  INTEGER NOT NULL DEFAULT 0,      -- 1＝只有餘額負數（欠稅）的人能借
  collateral_order TEXT NOT NULL DEFAULT 'tool,crop,fish',  -- 自動挑抵押品的順序（只有這三類可抵押）
  channel      TEXT NOT NULL DEFAULT ''         -- 借款／沒收公告頻道（空＝不公告）
);

CREATE TABLE IF NOT EXISTS loans (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id    TEXT NOT NULL DEFAULT '',
  user_id     TEXT NOT NULL,
  username    TEXT NOT NULL DEFAULT '',
  principal   INTEGER NOT NULL DEFAULT 0,       -- 實際借到手的金額
  interest    INTEGER NOT NULL DEFAULT 0,       -- 利息
  owed        INTEGER NOT NULL DEFAULT 0,       -- 還欠多少（本金＋利息 −已還）
  collateral_value INTEGER NOT NULL DEFAULT 0,  -- 抵押品估值
  status      TEXT NOT NULL DEFAULT 'open',     -- open／repaid／defaulted
  due_ms      INTEGER NOT NULL DEFAULT 0,       -- 到期時間（unix 毫秒）
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  closed_at   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_loans ON loans(guild_id, user_id, status);

-- 被代管的抵押品（還清就還回去，違約就沒收）
CREATE TABLE IF NOT EXISTS loan_collaterals (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  loan_id  INTEGER NOT NULL,
  guild_id TEXT NOT NULL DEFAULT '',
  kind     TEXT NOT NULL DEFAULT '',    -- tool / crop / fish
  ref_id   INTEGER NOT NULL DEFAULT 0,  -- tool_id / seed_id / fish_id
  slot     INTEGER NOT NULL DEFAULT -1, -- 原本的格子（魚缸／農地，還回去時放回原位）
  qty      INTEGER NOT NULL DEFAULT 0,  -- 工具剩餘耐久 / 數量
  pending  INTEGER NOT NULL DEFAULT 0,  -- 魚的未領取星幣（贖回時一起還）
  meta     TEXT NOT NULL DEFAULT '',    -- 還原用的額外資料（作物成熟時間、plot_type…）
  value    INTEGER NOT NULL DEFAULT 0,  -- 估值
  detail   TEXT NOT NULL DEFAULT ''     -- 顯示用名稱
);
CREATE INDEX IF NOT EXISTS idx_loan_coll ON loan_collaterals(loan_id);


-- ============================================================
-- 家園系統（家園 → 廚房 → 料理 → 家具 → 寵物 → 圖鑑 → 稱號 → 好感度）
-- 設計主軸：採集/挖礦/農場/魚缸的產物有了長期出海口，
-- 所有加成最後都由 util/buffs.js 統一結算，避免各系統各自加成而失控。
-- ============================================================

CREATE TABLE IF NOT EXISTS home_config (
  guild_id        TEXT PRIMARY KEY,
  enabled         INTEGER NOT NULL DEFAULT 1,
  seeded          INTEGER NOT NULL DEFAULT 0,
  title_slots     INTEGER NOT NULL DEFAULT 3,   -- 同時可裝備幾個稱號
  visit_enabled   INTEGER NOT NULL DEFAULT 1,   -- 是否開放邀請角色來訪
  gift_daily_limit INTEGER NOT NULL DEFAULT 5,  -- 每日送禮次數上限（每角色）
  visit_daily_limit INTEGER NOT NULL DEFAULT 3, -- 每日邀請次數上限
  buff_cap_pct    INTEGER NOT NULL DEFAULT 30   -- 單一類型加成總和上限%（防止疊到爆）
);

-- 房屋 12 階（管理員可在後台改名稱與材料）
CREATE TABLE IF NOT EXISTS home_levels (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id      TEXT NOT NULL DEFAULT '',
  level         INTEGER NOT NULL DEFAULT 1,
  name          TEXT NOT NULL DEFAULT '',
  emoji         TEXT NOT NULL DEFAULT '',
  unlocks       TEXT NOT NULL DEFAULT '',   -- 解鎖內容說明（顯示用）
  coins         INTEGER NOT NULL DEFAULT 0, -- 升到此階要的金幣
  materials     TEXT NOT NULL DEFAULT '[]', -- [{item:"木材",count:800}]，用名稱比對 gather_items
  furniture_cap INTEGER NOT NULL DEFAULT 5, -- 可擺放家具數
  pet_cap       INTEGER NOT NULL DEFAULT 0, -- 可養寵物數
  kitchen_ok    INTEGER NOT NULL DEFAULT 0, -- 到此階可蓋廚房
  visit_ok      INTEGER NOT NULL DEFAULT 0, -- 到此階角色才願意來訪
  home_buff_pct INTEGER NOT NULL DEFAULT 0, -- 家園整體加成%
  UNIQUE (guild_id, level)
);

CREATE TABLE IF NOT EXISTS home_users (
  guild_id       TEXT NOT NULL DEFAULT '',
  user_id        TEXT NOT NULL,
  username       TEXT NOT NULL DEFAULT '',
  level          INTEGER NOT NULL DEFAULT 1,
  kitchen_built  INTEGER NOT NULL DEFAULT 0,
  kitchen_level  INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (guild_id, user_id)
);

-- ---- 家具：6 大類、可擺放、給小幅加成 ----
CREATE TABLE IF NOT EXISTS home_furniture (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id    TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL DEFAULT 'living', -- living/bedroom/kitchen/garden/collection/special
  name        TEXT NOT NULL DEFAULT '',
  emoji       TEXT NOT NULL DEFAULT '',
  price       INTEGER NOT NULL DEFAULT 0,
  materials   TEXT NOT NULL DEFAULT '[]',
  min_level   INTEGER NOT NULL DEFAULT 1,     -- 需要的房屋階級
  buff_type   TEXT NOT NULL DEFAULT '',       -- 見 util/buffs.js 的 BUFF_TYPES
  buff_pct    INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT '',
  sort        INTEGER NOT NULL DEFAULT 0,
  enabled     INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS home_furniture_owned (
  guild_id     TEXT NOT NULL DEFAULT '',
  user_id      TEXT NOT NULL,
  furniture_id INTEGER NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  placed       INTEGER NOT NULL DEFAULT 0,   -- 擺出來的數量（只有擺出來才有加成）
  PRIMARY KEY (guild_id, user_id, furniture_id)
);

-- ---- 廚房 10 級 ----
CREATE TABLE IF NOT EXISTS kitchen_levels (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id    TEXT NOT NULL DEFAULT '',
  level       INTEGER NOT NULL DEFAULT 1,
  name        TEXT NOT NULL DEFAULT '',
  emoji       TEXT NOT NULL DEFAULT '',
  coins       INTEGER NOT NULL DEFAULT 0,
  materials   TEXT NOT NULL DEFAULT '[]',
  perfect_pct INTEGER NOT NULL DEFAULT 0,  -- 完美料理額外機率%
  description TEXT NOT NULL DEFAULT '',
  UNIQUE (guild_id, level)
);

-- ---- 食譜與料理成品（品質：普通/精良/稀有/史詩/傳說） ----
CREATE TABLE IF NOT EXISTS cook_recipes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id      TEXT NOT NULL DEFAULT '',
  name          TEXT NOT NULL DEFAULT '',
  emoji         TEXT NOT NULL DEFAULT '',
  min_kitchen   INTEGER NOT NULL DEFAULT 1,
  materials     TEXT NOT NULL DEFAULT '[]',
  cook_minutes  INTEGER NOT NULL DEFAULT 10,
  base_price    INTEGER NOT NULL DEFAULT 0,   -- 普通品質售價，其餘按品質倍率
  affinity_base INTEGER NOT NULL DEFAULT 0,   -- 送禮基礎好感
  buff_type     TEXT NOT NULL DEFAULT '',     -- 吃了給的暫時 buff
  buff_pct      INTEGER NOT NULL DEFAULT 0,
  buff_minutes  INTEGER NOT NULL DEFAULT 0,
  description   TEXT NOT NULL DEFAULT '',
  sort          INTEGER NOT NULL DEFAULT 0,
  enabled       INTEGER NOT NULL DEFAULT 1
);
-- 烹飪中的鍋子（廚房等級＝同時能煮幾道）
CREATE TABLE IF NOT EXISTS cook_queue (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id  TEXT NOT NULL DEFAULT '',
  user_id   TEXT NOT NULL,
  recipe_id INTEGER NOT NULL,
  slot      INTEGER NOT NULL DEFAULT 0,
  ready_at  INTEGER NOT NULL DEFAULT 0,
  quality   INTEGER NOT NULL DEFAULT 0   -- 下鍋時就擲好，領取時揭曉
);
-- 做好的料理（同一道菜不同品質分開存）
CREATE TABLE IF NOT EXISTS cook_inventory (
  guild_id  TEXT NOT NULL DEFAULT '',
  user_id   TEXT NOT NULL,
  recipe_id INTEGER NOT NULL,
  quality   INTEGER NOT NULL DEFAULT 0,
  count     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id, recipe_id, quality)
);

-- ---- 寵物 ----
CREATE TABLE IF NOT EXISTS pet_defs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id    TEXT NOT NULL DEFAULT '',
  name        TEXT NOT NULL DEFAULT '',
  emoji       TEXT NOT NULL DEFAULT '',
  rarity      TEXT NOT NULL DEFAULT 'N',      -- N/R/SR/SSR/UR
  min_level   INTEGER NOT NULL DEFAULT 2,     -- 需要的房屋階級
  price       INTEGER NOT NULL DEFAULT 0,     -- 0＝不販售（只能特殊管道取得）
  materials   TEXT NOT NULL DEFAULT '[]',
  skill_name  TEXT NOT NULL DEFAULT '',
  buff_type   TEXT NOT NULL DEFAULT '',
  buff_pct    INTEGER NOT NULL DEFAULT 0,     -- 滿親密度時的加成，實際按親密度比例給
  feed_hours  INTEGER NOT NULL DEFAULT 24,
  description TEXT NOT NULL DEFAULT '',
  sort        INTEGER NOT NULL DEFAULT 0,
  enabled     INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS pet_owned (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id    TEXT NOT NULL DEFAULT '',
  user_id     TEXT NOT NULL,
  pet_id      INTEGER NOT NULL,
  nickname    TEXT NOT NULL DEFAULT '',
  level       INTEGER NOT NULL DEFAULT 1,
  exp         INTEGER NOT NULL DEFAULT 0,
  intimacy    INTEGER NOT NULL DEFAULT 0,   -- 0~100
  personality TEXT NOT NULL DEFAULT '',
  fed_ms      INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_pet_owned ON pet_owned(guild_id, user_id);

-- ---- 圖鑑：記錄「曾經擁有過」，賣掉也不會消失 ----
CREATE TABLE IF NOT EXISTS dex_seen (
  guild_id TEXT NOT NULL DEFAULT '',
  user_id  TEXT NOT NULL,
  cat      TEXT NOT NULL,          -- fish/crop/greenhouse/mine/cook/pet/furniture/role
  key      TEXT NOT NULL,          -- 物品名稱（跨表通用）
  first_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (guild_id, user_id, cat, key)
);

-- ---- 稱號：可無限收集，但同時只能裝備 title_slots 個 ----
CREATE TABLE IF NOT EXISTS title_defs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id    TEXT NOT NULL DEFAULT '',
  cat         TEXT NOT NULL DEFAULT '',   -- 對應 dex_seen.cat，或 wealth/home/affinity
  name        TEXT NOT NULL DEFAULT '',
  emoji       TEXT NOT NULL DEFAULT '',
  need        INTEGER NOT NULL DEFAULT 0, -- 需要的完成數（wealth＝金幣、home＝房屋階級）
  buff_type   TEXT NOT NULL DEFAULT '',
  buff_pct    INTEGER NOT NULL DEFAULT 0,
  buff2_type  TEXT NOT NULL DEFAULT '',
  buff2_pct   INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT '',
  sort        INTEGER NOT NULL DEFAULT 0,
  enabled     INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS title_owned (
  guild_id TEXT NOT NULL DEFAULT '',
  user_id  TEXT NOT NULL,
  title_id INTEGER NOT NULL,
  got_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  slot     INTEGER NOT NULL DEFAULT -1,   -- -1＝未裝備，0..n＝裝備欄位
  PRIMARY KEY (guild_id, user_id, title_id)
);

-- ---- 好感度：角色直接沿用轉盤的 wheel_roles（已有數百位角色） ----
CREATE TABLE IF NOT EXISTS affinity (
  guild_id   TEXT NOT NULL DEFAULT '',
  user_id    TEXT NOT NULL,
  role_id    INTEGER NOT NULL,
  points     INTEGER NOT NULL DEFAULT 0,
  level      INTEGER NOT NULL DEFAULT 0,
  visits     INTEGER NOT NULL DEFAULT 0,
  gift_day   TEXT NOT NULL DEFAULT '',
  gift_count INTEGER NOT NULL DEFAULT 0,
  last_visit TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (guild_id, user_id, role_id)
);
-- 角色喜好：沒設定的角色用預設權重，設了就吃這裡
CREATE TABLE IF NOT EXISTS affinity_prefs (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL DEFAULT '',
  role_id  INTEGER NOT NULL,
  item     TEXT NOT NULL DEFAULT '',    -- 物品或料理名稱
  weight   INTEGER NOT NULL DEFAULT 100 -- 100＝普通，300＝最愛，-100＝討厭
);
CREATE INDEX IF NOT EXISTS idx_aff_prefs ON affinity_prefs(guild_id, role_id);
-- 好感度階級門檻與獎勵
CREATE TABLE IF NOT EXISTS affinity_levels (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id  TEXT NOT NULL DEFAULT '',
  level     INTEGER NOT NULL DEFAULT 1,
  name      TEXT NOT NULL DEFAULT '',
  need      INTEGER NOT NULL DEFAULT 0,
  reward    TEXT NOT NULL DEFAULT '',
  title_id  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (guild_id, level)
);

-- ---- 偷竊紀錄（後台查得到誰偷誰，前台仍匿名） ----
CREATE TABLE IF NOT EXISTS steal_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id    TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL DEFAULT 'ranch',   -- ranch / aquarium
  thief_id    TEXT NOT NULL DEFAULT '',
  thief_name  TEXT NOT NULL DEFAULT '',
  victim_id   TEXT NOT NULL DEFAULT '',
  victim_name TEXT NOT NULL DEFAULT '',
  result      TEXT NOT NULL DEFAULT '',        -- success / miss / caught
  loot        TEXT NOT NULL DEFAULT '',        -- 偷到的東西（顯示用）
  coins       INTEGER NOT NULL DEFAULT 0,
  penalty     INTEGER NOT NULL DEFAULT 0,      -- 被看門動物罰掉的星幣
  channel_id  TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_steal_logs ON steal_logs(guild_id, created_at);
CREATE INDEX IF NOT EXISTS idx_steal_thief ON steal_logs(guild_id, thief_id);
CREATE INDEX IF NOT EXISTS idx_steal_victim ON steal_logs(guild_id, victim_id);

-- 暫時性加成（吃料理等），到期自動失效
CREATE TABLE IF NOT EXISTS home_buffs (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id  TEXT NOT NULL DEFAULT '',
  user_id   TEXT NOT NULL,
  buff_type TEXT NOT NULL DEFAULT '',
  buff_pct  INTEGER NOT NULL DEFAULT 0,
  source    TEXT NOT NULL DEFAULT '',
  expire_ms INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_home_buffs ON home_buffs(guild_id, user_id, expire_ms);

-- 家園每日簽到：連續簽到獎勵遞增，斷了就從頭
CREATE TABLE IF NOT EXISTS home_checkin (
  guild_id   TEXT NOT NULL DEFAULT '',
  user_id    TEXT NOT NULL,
  last_day   TEXT NOT NULL DEFAULT '',   -- 台北時區的日期
  streak     INTEGER NOT NULL DEFAULT 0, -- 目前連續天數
  best       INTEGER NOT NULL DEFAULT 0,
  total      INTEGER NOT NULL DEFAULT 0, -- 累計簽到次數
  week_start TEXT NOT NULL DEFAULT '',   -- 本週起始日（顯示週一~週日用）
  week_mask  INTEGER NOT NULL DEFAULT 0, -- 本週已簽的位元遮罩（bit0=週一）
  PRIMARY KEY (guild_id, user_id)
);

-- 成就統計：玩家在每件事上的累計次數（挖礦幾次、防守成功幾次…）。
-- 衍生得出來的數字（身家、房屋階級、圖鑑數）不進這張表，由 util/achievements.js 現算。
CREATE TABLE IF NOT EXISTS ach_stats (
  guild_id   TEXT NOT NULL DEFAULT '',
  user_id    TEXT NOT NULL,
  metric     TEXT NOT NULL,
  value      INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (guild_id, user_id, metric)
);

-- ============================================================
-- 基金會拍賣會：基金會定期推出限時競標（特殊家具／珍稀寵物／成就稱號／稀有物品）
-- 設計重點：
--   ① 出價即鎖款（當場扣星幣），被超越自動退回 —— 不會有得標不付錢的呆帳
--   ② 手續費從成交價抽，直接進基金會池 → 拍賣本身就是回收星幣的水龍頭
--   ③ 可設「材料附加成本」：得標時另外收指定材料，給只能賣錢的素材一個真正的出海口
--   ④ 結束前有人出價就自動延長（防狙擊）
-- ============================================================
CREATE TABLE IF NOT EXISTS auction_config (
  guild_id        TEXT PRIMARY KEY DEFAULT '',
  enabled         INTEGER NOT NULL DEFAULT 0,
  channel         TEXT NOT NULL DEFAULT '',      -- 拍賣公告頻道
  fee_pct         REAL NOT NULL DEFAULT 5,       -- 成交手續費 %（進基金會）
  min_inc_pct     INTEGER NOT NULL DEFAULT 5,    -- 每次至少要加價 %（與 min_inc 取大）
  min_inc         INTEGER NOT NULL DEFAULT 100,  -- 每次至少要加價的絕對值
  antisnipe_min   INTEGER NOT NULL DEFAULT 3,    -- 結束前這幾分鐘內有人出價就延長
  extend_min      INTEGER NOT NULL DEFAULT 3,    -- 每次延長幾分鐘
  max_bid_pct     INTEGER NOT NULL DEFAULT 0,    -- 單人出價上限＝餘額的 %（0＝不限）
  to_pool         INTEGER NOT NULL DEFAULT 1     -- 1＝成交價（扣手續費後）也全數進基金會
);

CREATE TABLE IF NOT EXISTS auctions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id     TEXT NOT NULL DEFAULT '',
  kind         TEXT NOT NULL DEFAULT 'item',   -- furniture / pet / title / item
  ref_id       INTEGER NOT NULL DEFAULT 0,     -- 對應 home_furniture / pet_defs / title_defs / gather_items 的 id
  qty          INTEGER NOT NULL DEFAULT 1,     -- 只有 item 類用得到
  title        TEXT NOT NULL DEFAULT '',       -- 顯示名稱（留空＝自動用標的物名稱）
  emoji        TEXT NOT NULL DEFAULT '',
  description  TEXT NOT NULL DEFAULT '',
  image_url    TEXT NOT NULL DEFAULT '',
  start_price  INTEGER NOT NULL DEFAULT 0,
  buyout_price INTEGER NOT NULL DEFAULT 0,     -- 直接買下的價格（0＝不開放）
  mats_cost    TEXT NOT NULL DEFAULT '[]',     -- 得標時另外要交的材料 [{item,count}]
  start_ts     INTEGER NOT NULL DEFAULT 0,
  end_ts       INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'scheduled', -- scheduled / live / ended / failed / cancelled
  winner_id    TEXT NOT NULL DEFAULT '',
  winner_name  TEXT NOT NULL DEFAULT '',
  final_price  INTEGER NOT NULL DEFAULT 0,
  fee          INTEGER NOT NULL DEFAULT 0,
  bids         INTEGER NOT NULL DEFAULT 0,
  created_by   TEXT NOT NULL DEFAULT '',
  message_id   TEXT NOT NULL DEFAULT '',       -- 公告訊息（開標後編輯同一則）
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_auctions ON auctions(guild_id, status, end_ts);

-- 出價紀錄。active=1 代表這筆錢還被鎖著（目前最高價），被超越就退款並設為 0。
CREATE TABLE IF NOT EXISTS auction_bids (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  auction_id INTEGER NOT NULL,
  guild_id   TEXT NOT NULL DEFAULT '',
  user_id    TEXT NOT NULL,
  username   TEXT NOT NULL DEFAULT '',
  amount     INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_auction_bids ON auction_bids(auction_id, id);

-- ============================================================
-- 大賽（週賽／月賽）：一段時間內比某個指標的成長量，前三名有獎金，冠軍可拿專屬成就。
-- 比的是「這段期間增加了多少」而不是總量 —— 否則每次都是同一批老玩家躺著贏。
-- 指標沿用 util/achievements.js 的 METRICS（誰賺最多、誰挖最多、誰做最多料理…）。
-- ============================================================
CREATE TABLE IF NOT EXISTS contests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id     TEXT NOT NULL DEFAULT '',
  name         TEXT NOT NULL DEFAULT '',
  emoji        TEXT NOT NULL DEFAULT '🏆',
  description  TEXT NOT NULL DEFAULT '',
  metric       TEXT NOT NULL DEFAULT 'total_earned',
  start_ts     INTEGER NOT NULL DEFAULT 0,
  end_ts       INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'scheduled',  -- scheduled / live / ended / cancelled
  reward1      INTEGER NOT NULL DEFAULT 0,
  reward2      INTEGER NOT NULL DEFAULT 0,
  reward3      INTEGER NOT NULL DEFAULT 0,
  title_id     INTEGER NOT NULL DEFAULT 0,   -- 冠軍拿到的成就（title_defs.id，0＝不給）
  min_score    INTEGER NOT NULL DEFAULT 1,   -- 至少要有這麼多成長才算參賽（防止 0 分掛榜）
  channel      TEXT NOT NULL DEFAULT '',
  repeat_days  INTEGER NOT NULL DEFAULT 0,   -- >0＝結束後自動開下一屆（例如 7＝每週一屆）
  message_id   TEXT NOT NULL DEFAULT '',
  created_by   TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_contests ON contests(guild_id, status, end_ts);

-- 參賽者的起跑點與目前分數。baseline 是開賽當下的指標值，score = 現在 - baseline。
CREATE TABLE IF NOT EXISTS contest_scores (
  contest_id INTEGER NOT NULL,
  guild_id   TEXT NOT NULL DEFAULT '',
  user_id    TEXT NOT NULL,
  username   TEXT NOT NULL DEFAULT '',
  baseline   INTEGER NOT NULL DEFAULT 0,
  score      INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (contest_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_contest_scores ON contest_scores(contest_id, score);
