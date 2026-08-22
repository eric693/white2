require('dotenv').config();
// 時區保險：伺服器可能是 UTC，強制用台北時間，確保所有時間戳與排程正確（在載入 db/Date 前設定）
process.env.TZ = process.env.TZ || 'Asia/Taipei';
const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const { db, getSetting, setSetting, UI_TEXT_KEYS, audit } = require('./db');
const {
  signToken, setAuthCookie, clearAuthCookie, requireAuth, requireModule,
  MODULES, MODULE_KEYS, parsePermissions,
  loginLockedMinutes, loginFailed, loginSucceeded, rateLimit
} = require('./auth');
const bot = require('./bot');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: false }));

const loginRateLimit = rateLimit({ windowMs: 5 * 60 * 1000, max: 30, prefix: 'login:' });

// ---- 登入 ----
app.post('/api/login', loginRateLimit, (req, res) => {
  const { username, password } = req.body || {};
  const lockKey = `admin:${username || ''}`;
  const locked = loginLockedMinutes(lockKey);
  if (locked) return res.status(429).json({ error: `登入失敗次數過多，請 ${locked} 分鐘後再試` });
  const user = db.prepare('SELECT * FROM admin_users WHERE username = ? AND active = 1').get(username || '');
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    loginFailed(lockKey);
    return res.status(401).json({ error: '帳號或密碼錯誤' });
  }
  loginSucceeded(lockKey);
  setAuthCookie(res, signToken({ id: user.id }));
  audit(user.name, '登入後台');
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => { clearAuthCookie(res); res.json({ ok: true }); });

app.get('/api/me', requireAuth(), (req, res) => {
  res.json({
    id: req.user.id, username: req.user.username, name: req.user.name, role: req.user.role,
    modules: req.user.role === 'admin' ? MODULE_KEYS : parsePermissions(req.user.permissions),
    all_modules: MODULES,
    bot_online: bot.isReady(),
    brand_title: getSetting('brand_title', 'White2 後台'),
    brand_sub: getSetting('brand_sub', 'Discord 機器人管理')
  });
});

// ---- 外觀自訂 ----
app.get('/api/appearance', requireAuth(), requireModule('appearance'), (req, res) => {
  const out = {};
  for (const k of UI_TEXT_KEYS) out[k] = getSetting(k);
  res.json(out);
});
app.put('/api/appearance', requireAuth(), requireModule('appearance'), async (req, res) => {
  for (const k of UI_TEXT_KEYS) if (k in req.body) setSetting(k, req.body[k]);
  audit(req.user.name, '更新外觀設定');
  try { await bot.applyAppearance(); } catch {}
  res.json({ ok: true });
});

// ---- 全域設定（管理員通知頻道等，多系統共用）----
const GLOBAL_KEYS = ['admin_channel'];
app.get('/api/settings', requireAuth(), (req, res) => {
  const out = {}; for (const k of GLOBAL_KEYS) out[k] = getSetting(k); res.json(out);
});
app.put('/api/settings', requireAuth(), (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '僅總管理員可調整' });
  for (const k of GLOBAL_KEYS) if (k in req.body) setSetting(k, req.body[k]);
  audit(req.user.name, '更新全域設定');
  res.json({ ok: true });
});

// ---- 功能路由 ----
app.use('/api', require('./routes/discord'));
app.use('/api', require('./routes/keywords'));
app.use('/api', require('./routes/alerts'));
app.use('/api', require('./routes/welcome'));
app.use('/api', require('./routes/birthday'));
app.use('/api', require('./routes/announcements'));
app.use('/api', require('./routes/polls'));
app.use('/api', require('./routes/giveaways'));
app.use('/api', require('./routes/blacklist'));
app.use('/api', require('./routes/wheels'));
app.use('/api', require('./routes/music'));
app.use('/api', require('./routes/system'));
app.use('/api', require('./routes/uploads'));
app.use('/api', require('./routes/forum'));
app.use('/api', require('./routes/tickets'));

// 上傳的圖片/檔案（公開路徑，Discord 需要能直接讀取）
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads'), { maxAge: '7d' }));
app.use('/api', require('./routes/reminders'));
app.use('/api', require('./routes/gather'));
app.use('/api', require('./routes/ranch'));
app.use('/api', require('./routes/crops'));
app.use('/api', require('./routes/aquarium'));
app.use('/api', require('./routes/special'));
app.use('/api', require('./routes/stock'));
app.use('/api', require('./routes/tax'));
app.use('/api', require('./routes/charity'));
app.use('/api', require('./routes/loans'));
app.use('/api', require('./routes/home'));
app.use('/api', require('./routes/auction'));
app.use('/api', require('./routes/contest'));
app.use('/api', require('./routes/users'));
// 玩家的個人家園網頁（唯讀，不需登入，網址帶簽章 token）
app.use('/', require('./routes/homepage'));

// 公開功能介紹頁（乾淨網址 /intro，不需登入）
app.get('/intro', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'intro.html')));

// 公開的玩家規則手冊（給 Discord 玩家看，不需登入）；不快取，改了手冊玩家立刻看到新版
app.get('/rules', (req, res) => { res.set('Cache-Control', 'no-cache'); res.sendFile(path.join(__dirname, '..', 'public', 'rules.html')); });

// ---- 首頁（後台 SPA）：動態注入版本號做快取破壞（cache-busting）----
// 手機瀏覽器會把 /js/*.js 舊版本快取住不更新，導致改了後台看不到、甚至顯示過期的狀態。
// 這裡把 index.html 設成「每次都重新驗證」，並在每個 js/css 網址後面加 ?v=<檔案最新修改時間>，
// 只要前端檔案有更新，網址就會變、瀏覽器就會抓新版；沒更新則沿用快取，不會多下載。
const fs = require('fs');
const PUB = path.join(__dirname, '..', 'public');
function assetVersion() {
  let mx = 0;
  for (const dir of ['js', 'css']) {
    try { for (const f of fs.readdirSync(path.join(PUB, dir))) { const m = fs.statSync(path.join(PUB, dir, f)).mtimeMs; if (m > mx) mx = m; } } catch {}
  }
  return Math.floor(mx).toString(36);
}
function serveIndex(req, res) {
  try {
    const v = assetVersion();
    const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8')
      .replace(/(src|href)="(\/(?:js|css)\/[A-Za-z0-9_-]+\.(?:js|css))"/g, `$1="$2?v=${v}"`);
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.type('html').send(html);
  } catch { res.sendFile(path.join(PUB, 'index.html')); }
}
app.get(['/', '/index.html'], serveIndex);

// ---- 靜態後台網站 ----
// 後台的 JS/CSS 改版後，瀏覽器（尤其 iOS Safari）常常還吃舊檔，造成「明明改好了卻看不到新欄位」。
// 這些檔案很小，一律要求每次重新驗證（有改才重新下載，沒改回 304），換取所見即最新。
app.use(['/js', '/css'], (req, res, next) => {
  res.set('Cache-Control', 'no-cache');
  next();
});
app.use(express.static(PUB));

// ---- 統一錯誤處理：讓 API 一律回 JSON，不要吐出 express 預設的 HTML 錯誤頁 ----
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const bad = err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError);
  if (!bad) console.error('未處理的路由錯誤：', err && err.message);
  res.status(bad ? 400 : 500).json({ error: bad ? 'request body 不是合法的 JSON' : '伺服器內部錯誤' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 後台網站已啟動： http://localhost:${PORT}`));

// ---- 啟動 Discord 機器人 ----
bot.start();
