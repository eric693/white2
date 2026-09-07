// 咒語簿 App（/spell/:token）：資料夾式的常用台詞剪貼庫，手機可「加到主畫面」當 PWA。
//
// 流程就是使用者原本在做的那件事：開咒語簿 → 點一下複製 → 切回 Discord 貼上。
// （iOS 沒辦法把網頁塞進 Discord 的打字框，那要做系統鍵盤擴充；這裡不追求那個。）
//
// 權限：這裡的東西是私人的，連結被轉傳也不能看 —— 一律要 Discord OAuth 登入，
// 而且登入的帳號要等於連結綁定的人，再加上後台的開通名單（spellbook.access）。
//
// OAuth 回呼沿用 /play/auth/callback（state 帶 `spell.` 前綴），
// 這樣 Discord 開發者後台不必再多加一組 Redirect URI。
const express = require('express');
const crypto = require('crypto');
const sb = require('../spellbook');

const router = express.Router();
const SECRET = process.env.JWT_SECRET || 'dev-insecure-secret-change-me';
const SESS_MAX_AGE = 30 * 24 * 3600;   // 30 天（每天要用的東西，別老是要重登）

// 與 /play、/home 同一種簽章 token（guild+user）
function parseToken(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const want = crypto.createHmac('sha256', SECRET).update(body).digest('base64url').slice(0, 16);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  const [gid, uid] = Buffer.from(body, 'base64url').toString().split('.');
  return gid && uid ? { gid, uid } : null;
}
function spellToken(gid, uid) {
  const body = Buffer.from(`${gid}.${uid}`).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url').slice(0, 16);
  return `${body}.${sig}`;
}

// ---- 登入 session（跟 /play 的分開簽，兩邊不能互用）----
function makeSession(gid, uid) {
  const body = Buffer.from(`${gid}.${uid}.${Date.now() + SESS_MAX_AGE * 1000}`).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update('spell.' + body).digest('base64url').slice(0, 20);
  return `${body}.${sig}`;
}
function readSession(req) {
  const raw = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('spell_sess='));
  if (!raw) return null;
  const [body, sig] = raw.slice('spell_sess='.length).split('.');
  if (!body || !sig) return null;
  const want = crypto.createHmac('sha256', SECRET).update('spell.' + body).digest('base64url').slice(0, 20);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  const [gid, uid, exp] = Buffer.from(body, 'base64url').toString().split('.');
  if (!gid || !uid || Date.now() > Number(exp)) return null;
  return { gid, uid };
}
// 給 /play/auth/callback 用：登入成功後種下咒語簿的 session
function setSessionCookie(res, gid, uid) {
  res.setHeader('Set-Cookie',
    `spell_sess=${makeSession(gid, uid)}; Path=/spell; Max-Age=${SESS_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---- 每個請求的守門：token 有效 → 本人登入 → 後台開通 ----
// 回傳 { t } 或 null（null 表示已經回應過了）
async function gate(req, res, { json = false } = {}) {
  const t = parseToken(req.params.token);
  if (!t) {
    if (json) res.status(403).json({ error: '連結無效' });
    else res.status(403).type('html').send(page('連結無效或已過期', '請回 Discord 用 <b>/咒語簿</b> 重新取得你的連結。'));
    return null;
  }
  const s = readSession(req);
  if (!s || s.gid !== t.gid || s.uid !== t.uid) {
    if (json) res.status(401).json({ error: '請重新登入', login: `/spell/${req.params.token}/login` });
    else res.redirect(`/spell/${req.params.token}/login`);
    return null;
  }
  const a = await sb.accessAsync(t.gid, t.uid);
  if (!a.ok) {
    const msg = sb.DENY_TEXT[a.reason] || '沒有使用權限。';
    if (json) res.status(403).json({ error: msg });
    else res.status(403).type('html').send(page('還沒開通', esc(msg)));
    return null;
  }
  return t;
}

// 簡單的訊息頁（錯誤／提示共用）
function page(title, html) {
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>📖 咒語簿</title><link rel="stylesheet" href="/css/spellbook.css"></head>
<body class="msg-page"><div class="msg"><h2>${esc(title)}</h2><p>${html}</p></div></body></html>`;
}

// PWA：service worker。放在 /spell/ 底下才管得到 /spell/:token（scope 規則）。
// 只快取殼與靜態檔，資料一律走網路 —— 內容是私人的，不要留在快取裡。
router.get('/spell/sw.js', (req, res) => {
  res.set('Cache-Control', 'no-cache').type('application/javascript').send(`
const CACHE = 'spellbook-v1';
const SHELL = ['/css/spellbook.css', '/js/spellbook-app.js', '/icon-192.png', '/icon-512.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (SHELL.includes(url.pathname)) {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
  }
});
`);
});

// ---- App 主頁 ----
router.get('/spell/:token', async (req, res) => {
  const t = await gate(req, res);
  if (!t) return;
  const c = sb.config(t.gid);
  res.set('Cache-Control', 'no-store');
  res.type('html').send(`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#6f5bd7">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="咒語簿">
<title>📖 咒語簿</title>
<link rel="manifest" href="/spell/${esc(req.params.token)}/manifest.json">
<link rel="apple-touch-icon" href="/icon-192.png">
<link rel="stylesheet" href="/css/spellbook.css">
</head><body>
<div id="app"></div>
<script>window.SPELL = ${JSON.stringify({
    token: req.params.token,
    share: !!c.share_enabled,
    maxLen: c.max_len || 4000,
    notice: c.notice || ''
  })};</script>
<script src="/js/spellbook-app.js"></script>
</body></html>`);
});

// PWA：manifest（每人一份，start_url 帶自己的 token）
router.get('/spell/:token/manifest.json', (req, res) => {
  if (!parseToken(req.params.token)) return res.status(404).json({ error: 'bad token' });
  res.json({
    name: '咒語簿', short_name: '咒語簿', description: '你的常用台詞剪貼庫：點一下複製，切回聊天室貼上。',
    start_url: `/spell/${req.params.token}`, scope: '/spell/',
    display: 'standalone', orientation: 'portrait-primary',
    background_color: '#f7f4ff', theme_color: '#6f5bd7', lang: 'zh-Hant-TW',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
    ]
  });
});

// ---- 登入：轉去 Discord OAuth（回呼借用 /play/auth/callback）----
router.get('/spell/:token/login', (req, res) => {
  const t = parseToken(req.params.token);
  if (!t) return res.status(403).type('html').send(page('連結無效', '請回 Discord 用 <b>/咒語簿</b> 重新取得連結。'));
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const p = new URLSearchParams({
    client_id: require('../bot').roleClientId('butler'),
    redirect_uri: `${proto}://${req.get('host')}/play/auth/callback`,
    response_type: 'code', scope: 'identify', state: 'spell.' + req.params.token
  });
  res.redirect('https://discord.com/oauth2/authorize?' + p.toString());
});

router.get('/spell/:token/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'spell_sess=; Path=/spell; Max-Age=0; HttpOnly; Secure; SameSite=Lax');
  res.redirect(`/spell/${req.params.token}/login`);
});

// ---- JSON API（全部要過 gate）----
const api = (handler) => async (req, res) => {
  const t = await gate(req, res, { json: true });
  if (!t) return;
  try {
    const out = await handler(t, req, res);
    if (out && out.error) return res.status(400).json(out);
    res.json(out || { ok: true });
  } catch (e) {
    require('../db').logError(t.gid, '咒語簿 API 失敗：', e.message);
    res.status(500).json({ error: '操作失敗，請稍後再試。' });
  }
};
const id = (v) => Math.floor(Number(v) || 0);

router.get('/spell/:token/api/state', api((t) => {
  const c = sb.config(t.gid);
  return { folders: sb.folders(t.gid, t.uid), notice: c.notice || '', share: !!c.share_enabled, max_len: c.max_len };
}));

router.get('/spell/:token/api/folders/:id', api((t, req) => {
  const f = sb.folders(t.gid, t.uid).find(x => x.id === id(req.params.id));
  if (!f) return { error: '找不到這個資料夾。' };
  return { folder: f, entries: sb.entries(t.gid, t.uid, f.id) };
}));

router.post('/spell/:token/api/folders', api((t, req) => sb.addFolder(t.gid, t.uid, req.body || {})));
router.put('/spell/:token/api/folders/:id', api((t, req) => sb.editFolder(t.gid, t.uid, id(req.params.id), req.body || {})));
router.delete('/spell/:token/api/folders/:id', api((t, req) => sb.delFolder(t.gid, t.uid, id(req.params.id))));
router.post('/spell/:token/api/folders/:id/pin', api((t, req) =>
  sb.pinFolder(t.gid, t.uid, id(req.params.id), !!(req.body || {}).on)));

router.post('/spell/:token/api/entries', api((t, req) =>
  sb.addEntry(t.gid, t.uid, id((req.body || {}).folder_id), req.body || {})));
router.put('/spell/:token/api/entries/:id', api((t, req) => sb.editEntry(t.gid, t.uid, id(req.params.id), req.body || {})));
router.delete('/spell/:token/api/entries/:id', api((t, req) => sb.delEntry(t.gid, t.uid, id(req.params.id))));
router.post('/spell/:token/api/entries/:id/pin', api((t, req) =>
  sb.pinEntry(t.gid, t.uid, id(req.params.id), !!(req.body || {}).on)));
router.post('/spell/:token/api/entries/:id/copied', api((t, req) => {
  sb.bumpCopy(t.gid, t.uid, id(req.params.id));
  return { ok: true };
}));

// 分享／匯入
router.post('/spell/:token/api/share', api((t, req) => {
  const b = req.body || {};
  return sb.shareFolder(t.gid, t.uid, id(b.folder_id), { password: String(b.password || ''), days: Number(b.days) || 30 });
}));
router.post('/spell/:token/api/import', api((t, req) => {
  const b = req.body || {};
  return sb.importShare(t.gid, t.uid, String(b.code || ''), String(b.password || ''));
}));

// 備份
router.get('/spell/:token/api/export', api((t) => sb.exportAll(t.gid, t.uid)));
router.post('/spell/:token/api/import-json', api((t, req) => sb.importAll(t.gid, t.uid, (req.body || {}).data)));

router.get('/spell', (req, res) => {
  res.type('html').send(page('📖 咒語簿',
    '請回 Discord 用 <b>/咒語簿</b> 取得你的專屬連結。<br>咒語簿要由管理員在後台開通才能使用。'));
});

module.exports = router;
module.exports.spellToken = spellToken;
module.exports.parseToken = parseToken;
module.exports.setSessionCookie = setSessionCookie;
