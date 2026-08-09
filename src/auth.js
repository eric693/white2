const jwt = require('jsonwebtoken');
const { db, SECRET } = require('./db');

const COOKIE = 'w2_admin';
const TOKEN_TTL = '7d';

// 後台功能模組（staff 帳號逐一勾選；admin 全開）。權限設定頁用得到。
const MODULES = [
  { key: 'dashboard',    label: '總覽' },
  { key: 'keywords',     label: '關鍵字自動回覆' },
  { key: 'mentions',     label: '關鍵字標記管理員' },
  { key: 'alerts',       label: '關鍵字通知與警告' },
  { key: 'warnings',     label: '警告與禁言紀錄' },
  { key: 'welcome',      label: '加入/退出通知' },
  { key: 'birthday',     label: '生日驗證與慶生' },
  { key: 'announcements',label: '公告' },
  { key: 'polls',        label: '投票' },
  { key: 'giveaways',    label: '抽獎' },
  { key: 'wheels',       label: '角色轉盤' },
  { key: 'reminders',    label: '提醒' },
  { key: 'music',        label: '音樂' },
  { key: 'blacklist',    label: '黑名單' },
  { key: 'forum',        label: '論壇整理' },
  { key: 'tickets',      label: '客服單' },
  { key: 'levels',       label: '經驗值等級' },
  { key: 'gather',       label: '釣魚挖礦' },
  { key: 'stock',        label: '財經新聞與股市' },
  { key: 'media',        label: '媒體庫' },
  { key: 'appearance',   label: '外觀自訂' },
  { key: 'perms',        label: '功能權限設定' },
  { key: 'system',       label: '系統狀態與紀錄' },
  { key: 'guilds',       label: '伺服器管理' },
  { key: 'users',        label: '帳號權限' }
];
const MODULE_KEYS = MODULES.map(m => m.key);

function parsePermissions(str) {
  return String(str || '').split(',').map(s => s.trim()).filter(Boolean);
}

// ---- 登入暴力嘗試防護：同一帳號連續失敗 5 次鎖定 15 分鐘 ----
const loginAttempts = new Map();
const LOGIN_MAX_FAILS = 5, LOGIN_LOCK_MS = 15 * 60 * 1000;
function loginLockedMinutes(key) {
  const a = loginAttempts.get(key);
  if (a && a.lockedUntil && a.lockedUntil > Date.now()) return Math.ceil((a.lockedUntil - Date.now()) / 60000);
  return 0;
}
function loginFailed(key) {
  if (loginAttempts.size > 10000) loginAttempts.clear();
  const a = loginAttempts.get(key) || { fails: 0 };
  a.fails++;
  if (a.fails >= LOGIN_MAX_FAILS) { a.lockedUntil = Date.now() + LOGIN_LOCK_MS; a.fails = 0; }
  loginAttempts.set(key, a);
}
function loginSucceeded(key) { loginAttempts.delete(key); }

function clientIp(req) {
  return (req.headers['x-real-ip'] || '').trim()
    || (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress || 'unknown';
}

// 通用 IP 限流（僅套在未登入攻擊面，如登入）
function rateLimit({ windowMs, max, prefix = '' }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = prefix + clientIp(req);
    if (hits.size > 20000) for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
    let e = hits.get(key);
    if (!e || e.reset <= now) { e = { count: 0, reset: now + windowMs }; hits.set(key, e); }
    e.count++;
    if (e.count > max) {
      res.setHeader('Retry-After', Math.ceil((e.reset - now) / 1000));
      return res.status(429).json({ error: '請求過於頻繁，請稍後再試' });
    }
    next();
  };
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx > 0) out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

function signToken(payload) {
  return jwt.sign(payload, SECRET, { expiresIn: TOKEN_TTL });
}
// 部署在 nginx HTTPS 後方，帶 Secure 旗標（本機開發用 http 時可設 INSECURE_COOKIE=1）
const COOKIE_SECURE = process.env.INSECURE_COOKIE ? '' : ' Secure;';
function setAuthCookie(res, token) {
  res.setHeader('Set-Cookie',
    `${COOKIE}=${encodeURIComponent(token)}; HttpOnly;${COOKIE_SECURE} Path=/; Max-Age=${7 * 86400}; SameSite=Lax`);
}
function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly;${COOKIE_SECURE} Path=/; Max-Age=0; SameSite=Lax`);
}

const HOME_GUILD = process.env.GUILD_ID || '';

// 這個帳號可以管理哪些伺服器：
// - admin（總管理員）→ 全部啟用中的伺服器
// - staff 有綁定 → 只有綁定且啟用中的那幾台
// - staff 沒綁定 → 只有主伺服器（避免看到全部）
function allowedGuildsFor(user) {
  const active = db.prepare('SELECT guild_id FROM guilds WHERE active = 1').all().map(r => r.guild_id);
  if (user.role === 'admin') return active.length ? active : [HOME_GUILD];
  const bound = String(user.guild_ids || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!bound.length) return active.includes(HOME_GUILD) ? [HOME_GUILD] : active.slice(0, 1);
  const allow = bound.filter(g => active.includes(g));
  return allow.length ? allow : (active.includes(HOME_GUILD) ? [HOME_GUILD] : active.slice(0, 1));
}

// 登入驗證中介層（同時解析目前操作的伺服器）
function requireAuth() {
  return (req, res, next) => {
    const token = parseCookies(req)[COOKIE];
    if (!token) return res.status(401).json({ error: '未登入' });
    let data;
    try { data = jwt.verify(token, SECRET); } catch { return res.status(401).json({ error: '登入已過期' }); }
    const user = db.prepare('SELECT * FROM admin_users WHERE id = ? AND active = 1').get(data.id);
    if (!user) return res.status(401).json({ error: '帳號不存在' });
    req.user = user;
    // 多伺服器：前端用 X-Guild-Id header 指定目前管理的伺服器。
    // 帳號只能存取自己被允許的伺服器；越權指定會退回第一個允許的伺服器。
    const allowed = allowedGuildsFor(user);
    req.allowedGuilds = allowed;
    const gid = (req.headers['x-guild-id'] || '').trim();
    req.guildId = (gid && allowed.includes(gid)) ? gid : (allowed[0] || HOME_GUILD);
    next();
  };
}

// 模組權限中介層
function requireModule(mod) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: '未登入' });
    if (req.user.role === 'admin' || parsePermissions(req.user.permissions).includes(mod)) return next();
    res.status(403).json({ error: '無此功能權限' });
  };
}

// 給「掛在共用 /api 前綴」的功能 router 用的守衛：有權限就放行；
// 沒權限就用 next('router') 跳過「本 router」，讓請求繼續交給後面的 router 處理。
// 這樣才不會因為多個 router 共用 /api，某個 router 的權限守衛把「其他功能」的請求也一起擋掉。
// （沒權限存取本 router 自己的路由時，會因後面沒有相符路由而自然變成 404，功能仍受保護。）
function guardModule(mod) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: '未登入' });
    if (req.user.role === 'admin' || parsePermissions(req.user.permissions).includes(mod)) return next();
    return next('router');
  };
}

module.exports = {
  COOKIE, MODULES, MODULE_KEYS, parsePermissions,
  signToken, setAuthCookie, clearAuthCookie, requireAuth, requireModule, guardModule,
  loginLockedMinutes, loginFailed, loginSucceeded, rateLimit, clientIp
};
