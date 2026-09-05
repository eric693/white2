// 訂閱制度：每台伺服器、每隻機器人各自一份訂閱狀態（秘書買了不代表管家也能用）。
//
// 判定原則：
//   ・到期就自動降級成 free 方案，不刪任何資料（續費後原樣恢復，進度不重置）
//   ・付費功能被擋時只回一則說明訊息，不讓指令整個消失（玩家才知道要續費）
//   ・方案內容（月費／年費／開放哪些功能）全部存在 DB，後台可改，不寫死在程式裡
const { db, ensureColumns } = require('./db');
const { nowUnix } = require('./util/time');

db.exec(`CREATE TABLE IF NOT EXISTS plans (
  code        TEXT NOT NULL,
  role        TEXT NOT NULL,                       -- secretary | butler
  name        TEXT NOT NULL DEFAULT '',
  price_month INTEGER NOT NULL DEFAULT 0,
  price_year  INTEGER NOT NULL DEFAULT 0,
  features    TEXT NOT NULL DEFAULT '',            -- 逗號分隔的功能鍵；'*' ＝全部
  sort        INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (role, code)
)`);

db.exec(`CREATE TABLE IF NOT EXISTS guild_subscriptions (
  guild_id    TEXT NOT NULL,
  role        TEXT NOT NULL,                       -- secretary | butler
  plan_code   TEXT NOT NULL DEFAULT 'free',
  cycle       TEXT NOT NULL DEFAULT 'month',       -- month | year | none
  started_at  INTEGER NOT NULL DEFAULT 0,          -- unix 秒
  expires_at  INTEGER NOT NULL DEFAULT 0,          -- unix 秒；0 ＝永久（free 或人工開通）
  note        TEXT NOT NULL DEFAULT '',
  updated_at  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, role)
)`);
ensureColumns('guild_subscriptions', { note: "TEXT NOT NULL DEFAULT ''" });

// ---- 功能鍵：付費牆的最小顆粒 ----
// 鍵名沿用功能模組檔名，另加幾個跨模組的能力鍵，後台設定方案時直接勾這些。
const FEATURE_KEYS = {
  secretary: {
    keywords: '關鍵字回覆', alerts: '通知提醒', forum: '論壇整理', reactionroles: '表情身分組',
    welcome: '歡迎訊息', birthday: '生日祝賀', announcements: '公告發布', poll: '投票',
    giveaway: '抽獎', wheel: '轉盤（角色轉盤／貼文轉盤）', reminder: '排程提醒', music: '音樂播放',
    tickets: '客服單', xp: '聊天等級'
  },
  butler: {
    // 基礎遊戲
    gather: '採集冒險', crops: '農地種植', ranch: '牧場', home: '家園', dex: '圖鑑稱號',
    kitchen: '廚房料理', furniture: '家具', trades: '玩家交易', help: '指令說明', panel: '冒險面板',
    // 進階遊戲
    stock: '股市', tax: '稅務系統', loans: '銀行信貸', auction: '拍賣會', charity: '慈善基金會',
    contest: '大賽', aquarium: '魚缸', pets: '寵物', affinity: '角色好感度',
    partnerskills: '同居角色技能', special: '特殊兌換商店', facility: '設施擴充'
  }
};

// 內建預設方案（第一次啟動時寫入；之後以 DB 為準，後台改了不會被蓋回去）
const DEFAULT_PLANS = [
  { role: 'secretary', code: 'free', name: '免費版', price_month: 0, price_year: 0, sort: 0,
    features: 'welcome,poll,keywords,announcements' },
  { role: 'secretary', code: 'standard', name: '標準版', price_month: 99, price_year: 990, sort: 1,
    features: 'welcome,poll,keywords,announcements,birthday,reactionroles,giveaway,wheel,xp,reminder' },
  { role: 'secretary', code: 'pro', name: '專業版', price_month: 199, price_year: 1990, sort: 2,
    features: '*' },
  { role: 'butler', code: 'free', name: '免費版', price_month: 0, price_year: 0, sort: 0,
    features: 'gather,help,panel,home,dex' },
  { role: 'butler', code: 'basic', name: '基礎遊戲', price_month: 99, price_year: 990, sort: 1,
    features: 'gather,crops,ranch,home,dex,kitchen,furniture,trades,help,panel' },
  { role: 'butler', code: 'advanced', name: '進階遊戲', price_month: 199, price_year: 1990, sort: 2,
    features: '*' }
];
const seedPlan = db.prepare(`INSERT OR IGNORE INTO plans
  (code, role, name, price_month, price_year, features, sort) VALUES (?, ?, ?, ?, ?, ?, ?)`);
for (const p of DEFAULT_PLANS) {
  try { seedPlan.run(p.code, p.role, p.name, p.price_month, p.price_year, p.features, p.sort); } catch {}
}

// 一次性遷移：訂閱制上線前就在服務的伺服器，全部沿用「最高方案、永久」。
// 不這樣做的話，改版當下所有既有伺服器會瞬間掉回免費版，功能整片消失。
// 之後新加入的伺服器才走正常的免費版起跳流程。
(function grandfatherExistingGuilds() {
  const { getSetting, setSetting } = require('./db');
  if (getSetting('subscription_grandfathered', '0') === '1') return;
  const FULL = { secretary: 'pro', butler: 'advanced' };
  const guilds = db.prepare('SELECT guild_id FROM guilds').all();
  const ins = db.prepare(`INSERT OR IGNORE INTO guild_subscriptions
    (guild_id, role, plan_code, cycle, started_at, expires_at, note, updated_at)
    VALUES (?, ?, ?, 'none', ?, 0, '訂閱制上線前既有伺服器，永久沿用', ?)`);
  const now = nowUnix();
  for (const g of guilds) for (const [role, code] of Object.entries(FULL)) {
    try { ins.run(g.guild_id, role, code, now, now); } catch {}
  }
  setSetting('subscription_grandfathered', '1');
  if (guilds.length) console.log(`ℹ️  訂閱制：${guilds.length} 台既有伺服器已設為永久最高方案`);
})();

// activeOnly＝只列「還在販售」的方案（停用的方案不能再指定給伺服器，
// 但已經在用的伺服器不受影響——他們付過錢了，見 getPlan 不看 active）
function listPlans(role, { activeOnly = false } = {}) {
  const cond = [];
  const args = [];
  if (role) { cond.push('role = ?'); args.push(role); }
  if (activeOnly) cond.push('active = 1');
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM plans ${where} ORDER BY role, sort, code`).all(...args);
}

// 這個方案現在還能不能賣（後台指定／續訂時檢查）
function planSellable(role, code) {
  const row = db.prepare('SELECT active FROM plans WHERE role = ? AND code = ?').get(role, code);
  return !!row && row.active === 1;
}
function getPlan(role, code) {
  return db.prepare('SELECT * FROM plans WHERE role = ? AND code = ?').get(role, code || 'free')
    || db.prepare('SELECT * FROM plans WHERE role = ? AND code = ?').get(role, 'free')
    || { code: 'free', role, name: '免費版', features: '' };
}

// 某台伺服器某隻機器人的訂閱狀態；沒有紀錄就當免費版。
function getSubscription(guildId, role) {
  const row = db.prepare('SELECT * FROM guild_subscriptions WHERE guild_id = ? AND role = ?').get(guildId, role);
  const sub = row || { guild_id: guildId, role, plan_code: 'free', cycle: 'none', started_at: 0, expires_at: 0, note: '' };
  const expired = sub.expires_at > 0 && sub.expires_at <= nowUnix();
  // 到期 → 判定上直接視為 free，但 DB 紀錄保留（續費只要改 expires_at 就回來）
  const effectiveCode = expired ? 'free' : sub.plan_code;
  return { ...sub, expired, effective_plan: effectiveCode, plan: getPlan(role, effectiveCode) };
}

// 續費／開通：從現有到期日往後加（未過期則接續，已過期則從今天起算）
function extendSubscription(guildId, role, planCode, cycle = 'month', units = 1, note = '') {
  const now = nowUnix();
  const cur = getSubscription(guildId, role);
  const base = (!cur.expired && cur.expires_at > now) ? cur.expires_at : now;
  const per = cycle === 'year' ? 365 * 86400 : 30 * 86400;
  const expires = base + per * Math.max(1, Number(units) || 1);
  db.prepare(`INSERT INTO guild_subscriptions (guild_id, role, plan_code, cycle, started_at, expires_at, note, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(guild_id, role) DO UPDATE SET
                plan_code=excluded.plan_code, cycle=excluded.cycle, expires_at=excluded.expires_at,
                note=excluded.note, updated_at=excluded.updated_at`)
    .run(guildId, role, planCode, cycle, cur.started_at || now, expires, note, now);
  return getSubscription(guildId, role);
}

// 後台直接指定（含永久開通：expiresAt 傳 0）
function setSubscription(guildId, role, planCode, expiresAt = 0, note = '') {
  const now = nowUnix();
  db.prepare(`INSERT INTO guild_subscriptions (guild_id, role, plan_code, cycle, started_at, expires_at, note, updated_at)
              VALUES (?, ?, ?, 'none', ?, ?, ?, ?)
              ON CONFLICT(guild_id, role) DO UPDATE SET
                plan_code=excluded.plan_code, expires_at=excluded.expires_at,
                note=excluded.note, updated_at=excluded.updated_at`)
    .run(guildId, role, planCode, now, Number(expiresAt) || 0, note, now);
  return getSubscription(guildId, role);
}

// 這個功能鍵屬於哪一隻機器人（訂閱是分開賣的，鍵名不重複）
function roleOfFeature(featureKey) {
  if (FEATURE_KEYS.secretary[featureKey]) return 'secretary';
  if (FEATURE_KEYS.butler[featureKey]) return 'butler';
  return null;
}

// 單機器人模式（BOT_ROLE=both）沒有自己的訂閱資料表 —— 直接拿 'both' 去查會查不到
// 任何方案，結果變成「所有付費功能一律擋掉」。這裡把它換成功能鍵真正所屬的角色，
// 讓 both 模式沿用秘書／管家各自的訂閱狀態。
function resolveRole(role, featureKey) {
  if (role && role !== 'both') return role;
  return roleOfFeature(featureKey) || role || 'butler';
}

// 這台伺服器現在能不能用某個功能
function hasFeature(guildId, role, featureKey) {
  if (!guildId) return true;                       // 私訊／後台情境不擋
  const feats = String(getSubscription(guildId, resolveRole(role, featureKey)).plan.features || '');
  if (feats.trim() === '*') return true;
  return feats.split(',').map(s => s.trim()).filter(Boolean).includes(featureKey);
}

// 被擋時給玩家看的說明（各功能自己決定要不要 reply）
function lockedMessage(guildId, role, featureKey) {
  const r = resolveRole(role, featureKey);
  const sub = getSubscription(guildId, r);
  const name = (FEATURE_KEYS[r] || {})[featureKey] || featureKey;
  const why = sub.expired ? '訂閱已到期' : `目前方案「${sub.plan.name}」未包含`;
  return `🔒 **${name}** 無法使用：${why}。\n請伺服器管理員到後台續訂或升級方案後即可恢復（資料與進度都會保留）。`;
}

module.exports = {
  FEATURE_KEYS, listPlans, getPlan, planSellable, getSubscription,
  extendSubscription, setSubscription, hasFeature, lockedMessage, roleOfFeature
};
