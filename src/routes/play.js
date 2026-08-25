// 玩家遊戲 App（Phase 1：唯讀）。同站 /play 路徑，手機可「加到主畫面」當 PWA 用。
// 用 HMAC 簽章 token（綁 guild+user，跟家園網頁同一把）辨識玩家 —— 唯讀、改不了東西。
// Phase 2（採集/買賣等動作）再升級成 Discord OAuth 登入。
const express = require('express');
const crypto = require('crypto');
const { db, guildConfig } = require('../db');

const router = express.Router();
const SECRET = process.env.JWT_SECRET || 'dev-insecure-secret-change-me';

// guild+user → 不可偽造的短 token（與 homepage.js 相同，家園網頁的連結也能用在 /play）
function playToken(gid, uid) {
  const body = Buffer.from(`${gid}.${uid}`).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url').slice(0, 16);
  return `${body}.${sig}`;
}
function parseToken(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const want = crypto.createHmac('sha256', SECRET).update(body).digest('base64url').slice(0, 16);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  const [gid, uid] = Buffer.from(body, 'base64url').toString().split('.');
  return gid && uid ? { gid, uid } : null;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => Number(n || 0).toLocaleString('en-US');
const livePrice = (() => { try { return require('../util/market').livePrice; } catch { return (_g, it) => it.price || 0; } })();

// ---- 撈這位玩家的所有唯讀遊戲資料 ----
function collect(gid, uid) {
  const one = (sql, ...a) => { try { return db.prepare(sql).get(gid, ...a); } catch { return null; } };
  const many = (sql, ...a) => { try { return db.prepare(sql).all(gid, ...a); } catch { return []; } };
  const gc = guildConfig('gather_config', gid);
  const cur = { emoji: gc.currency_emoji || '🪙', name: gc.currency_name || '星幣' };
  const wallet = one('SELECT * FROM econ_wallets WHERE guild_id=? AND user_id=?', uid) || { coins: 0, tax_arrears: 0, total_earned: 0 };
  const username = wallet.username || '玩家';

  // 稅單（試算）
  let tax = null;
  try {
    const tc = guildConfig('tax_config', gid);
    if (tc.enabled) { const a = require('../bot/features/tax').assess(gid, uid); if (a) tax = a; }
  } catch { tax = null; }

  // 持股
  const holdings = many(
    `SELECT s.code, s.name, s.emoji, s.price, h.shares, h.cost_sum
       FROM stock_holdings h JOIN stock_symbols s ON s.id=h.symbol_id
      WHERE h.guild_id=? AND h.user_id=? AND h.shares>0 ORDER BY (h.shares*s.price) DESC`, uid)
    .map(h => ({ ...h, value: h.shares * h.price, avg: h.shares ? Math.round(h.cost_sum / h.shares) : 0, pnl: Math.round(h.shares * h.price - h.cost_sum) }));
  const stockVal = holdings.reduce((s, h) => s + Math.max(0, h.value), 0);

  // 魚缸
  const fish = many(
    `SELECT a.slot, a.pending, f.name, f.emoji, f.coin_per_day FROM aquarium_slots a JOIN aquarium_fish f ON f.id=a.fish_id
      WHERE a.guild_id=? AND a.user_id=? ORDER BY a.slot`, uid);
  const fishPending = fish.reduce((s, x) => s + (x.pending || 0), 0);

  // 牧場
  const animals = many(
    `SELECT r.slot, r.pending, a.name, a.emoji FROM ranch_slots r JOIN ranch_animals a ON a.id=r.animal_id
      WHERE r.guild_id=? AND r.user_id=? ORDER BY r.slot`, uid);
  const ranchPending = animals.reduce((s, x) => s + (x.pending || 0), 0);

  // 農地／溫室
  const now = Date.now();
  const plots = many(
    `SELECT p.plot_type, p.slot, p.ready_at, s.name, s.emoji FROM crop_plots p JOIN crop_seeds s ON s.id=p.seed_id
      WHERE p.guild_id=? AND p.user_id=? ORDER BY p.plot_type, p.slot`, uid)
    .map(p => ({ ...p, ready: (p.ready_at || 0) <= now }));

  // 任務進度（取每支任務最新一期的進度，唯讀顯示）
  const quests = many('SELECT * FROM quests WHERE guild_id=? AND enabled=1 ORDER BY period, id')
    .map(q => {
      const pr = db.prepare('SELECT progress, claimed FROM quest_progress WHERE guild_id=? AND user_id=? AND quest_id=? ORDER BY updated_at DESC LIMIT 1').get(gid, uid, q.id) || {};
      const cur2 = Math.min(pr.progress || 0, q.goal_count);
      return { name: q.name, period: q.period, cur: cur2, goal: q.goal_count, claimed: !!pr.claimed, reward: q.reward_coins || 0, done: cur2 >= q.goal_count };
    });

  // 背包（依類別）
  const KIND = { fish: '🎣 釣魚', mine: '⛏️ 挖礦', wood: '🪓 伐木', forage: '🧺 採集', hunt: '🏹 狩獵', farm: '🥚 農牧', seed: '🌱 種子' };
  const inv = many(
    `SELECT it.name, it.emoji, it.kind, it.rarity, it.price, v.count FROM gather_inventory v JOIN gather_items it ON it.id=v.item_id
      WHERE v.guild_id=? AND v.user_id=? AND v.count>0 ORDER BY it.kind, it.price DESC`, uid);
  const bag = {}; let bagValue = 0;
  for (const it of inv) {
    const val = livePrice(gid, it) * it.count; bagValue += val;
    const k = KIND[it.kind] || '📦 其他'; (bag[k] = bag[k] || []).push({ ...it, val });
  }

  return { gid, uid, username, cur, wallet, tax, holdings, stockVal, fish, fishPending, animals, ranchPending, plots, quests, bag, bagValue };
}

// ---- 版面（手機卡片式，可安裝 PWA）----
function render(d, token, msg) {
  const c = d.cur;
  const money = (n) => `${c.emoji} ${num(n)}`;
  const coins = d.wallet.coins;
  const arrears = d.wallet.tax_arrears || 0;

  const card = (title, body) => `<section class="card"><h2>${title}</h2>${body}</section>`;
  const row = (l, r) => `<div class="row"><span>${l}</span><b>${r}</b></div>`;
  // 一鍵領取按鈕（表單 POST，安全動作：只把自己的東西收進自己身上）
  const actBtn = (path, label) => `<form method="post" action="/play/${token}/${path}" style="margin-top:10px"><button class="act">${label}</button></form>`;
  const flash = msg ? `<div class="flash">${esc(msg)}</div>` : '';

  // 稅單
  let taxBody;
  if (!d.tax) taxBody = `<p class="muted">目前沒有開徵稅金，或你在免稅名單內。</p>`;
  else {
    const t = d.tax; const lines = [];
    if (t.income) lines.push(row('💰 所得稅', money(t.income)));
    if (t.stock) lines.push(row('📈 證券稅', money(t.stock)));
    if (t.land) lines.push(row('🌾 農地稅', money(t.land)));
    if (t.breed) lines.push(row('🐄 養殖稅', money(t.breed)));
    if (t.spend) lines.push(row('🛍️ 消費稅', money(t.spend)));
    if (t.credit) lines.push(row('❤️ 慈善折抵', `−${money(t.credit)}`));
    if (t.arrears) lines.push(row('🔁 上期未繳補收', money(t.arrears)));
    taxBody = (lines.join('') || '<p class="muted">本期免稅 🎉</p>') +
      `<div class="tot">本期預估合計 <b>${money(t.total)}</b></div>` +
      (arrears ? `<p class="warn">⚠️ 你有累積欠稅 ${money(arrears)}，下次結算會補收（也可在 Discord 用 /稅單 補繳）。</p>` : '');
  }

  // 持股
  const stockBody = d.holdings.length
    ? `<table><tr><th>股票</th><th>股數</th><th>市值</th><th>損益</th></tr>` +
      d.holdings.map(h => `<tr><td>${esc((h.emoji || '') + h.name)} <span class="muted">${esc(h.code)}</span></td><td>${num(h.shares)}</td><td>${num(h.value)}</td><td class="${h.pnl >= 0 ? 'up' : 'down'}">${h.pnl >= 0 ? '+' : ''}${num(h.pnl)}</td></tr>`).join('') +
      `</table><div class="tot">持股總市值 <b>${money(d.stockVal)}</b></div>`
    : `<p class="muted">目前沒有持股。</p>`;

  // 魚缸 / 牧場 / 農地
  const aqBody = (d.fish.length
    ? d.fish.map(f => `<div class="row"><span>${esc((f.emoji || '🐠') + f.name)}（第 ${f.slot + 1} 格）</span><b>未領 ${money(f.pending)}</b></div>`).join('') + `<div class="tot">可撈金 <b>${money(d.fishPending)}</b></div>`
    : `<p class="muted">魚缸還沒養魚。</p>`) + (d.fishPending > 0 ? actBtn('collect', `🪙 一鍵撈金 ${money(d.fishPending)}`) : '');
  const ranchBody = (d.animals.length
    ? d.animals.map(a => `<div class="row"><span>${esc((a.emoji || '🐔') + a.name)}（第 ${a.slot + 1} 格）</span><b>未領 ${money(a.pending)}</b></div>`).join('') + `<div class="tot">可收 <b>${money(d.ranchPending)}</b></div>`
    : `<p class="muted">牧場還沒養動物。</p>`) + (d.ranchPending > 0 ? actBtn('harvest', '🧺 一鍵收成') : '');
  const readyN = d.plots.filter(p => p.ready).length;
  const cropBody = (d.plots.length
    ? d.plots.map(p => `<div class="row"><span>${esc((p.emoji || '🌱') + p.name)}（${p.plot_type === 'greenhouse' ? '溫室' : '農地'} 第 ${p.slot + 1} 格）</span><b class="${p.ready ? 'up' : 'muted'}">${p.ready ? '✅ 可採收' : '⏳ 成長中'}</b></div>`).join('')
    : `<p class="muted">農地／溫室還沒種東西。</p>`) + (readyN > 0 ? actBtn('reap', `🧺 一鍵採收（${readyN} 格成熟）`) : '');

  // 任務
  const qBody = d.quests.length
    ? d.quests.map(q => `<div class="qrow"><div class="qname">${q.done ? (q.claimed ? '✅' : '🎁') : '📜'} ${esc(q.name)} <span class="muted">${q.cur}/${q.goal}</span></div><div class="bar"><span style="width:${Math.min(100, Math.round(q.cur / Math.max(1, q.goal) * 100))}%"></span></div></div>`).join('')
    : `<p class="muted">目前沒有任務。</p>`;

  // 背包
  const bagBody = Object.keys(d.bag).length
    ? Object.entries(d.bag).map(([k, items]) => `<h3>${k}</h3><div class="chips">` +
      items.map(it => `<span class="chip">${esc((it.emoji || '') + it.name)} ×${num(it.count)}</span>`).join('') + `</div>`).join('') +
      `<div class="tot">全部賣掉約 <b>${money(d.bagValue)}</b></div>`
    : `<p class="muted">背包是空的。</p>`;

  const manifest = `/play/${token}/manifest.json`;
  return `<!doctype html><html lang="zh-Hant"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><title>${esc(d.username)} 的冒險</title>
<link rel="manifest" href="${manifest}">
<meta name="theme-color" content="#5865f2">
<link rel="apple-touch-icon" href="/icon-192.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="冒險">
<meta name="mobile-web-app-capable" content="yes">
<style>
:root{--bg1:#fff5fa;--bg2:#f2f0ff;--pink:#e879b9;--line:#eadaf0;--ink:#3b3340;--muted:#9b8fa3;--card:#fff}
*{box-sizing:border-box}
body{margin:0;font-family:"Noto Sans TC","PingFang TC","Microsoft JhengHei",system-ui,sans-serif;
  background:linear-gradient(160deg,var(--bg1),var(--bg2));color:var(--ink);padding:14px;padding-bottom:40px}
.wrap{max-width:640px;margin:0 auto;display:flex;flex-direction:column;gap:14px}
.hero{background:linear-gradient(135deg,#e879b9,#8b7cf6);color:#fff;border-radius:20px;padding:20px}
.hero .name{font-size:20px;font-weight:800}
.hero .coins{font-size:30px;font-weight:800;margin-top:6px}
.hero .sub{opacity:.9;font-size:13px;margin-top:4px}
.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:16px;box-shadow:0 4px 18px rgba(190,140,180,.08)}
h2{margin:0 0 12px;font-size:16px}
h3{margin:12px 0 6px;font-size:13px;color:var(--muted)}
.row{display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px dashed var(--line);font-size:14px}
.row:last-child{border:0}
.tot{margin-top:10px;text-align:right;font-size:14px}
.tot b{font-size:16px;color:var(--pink)}
.muted{color:var(--muted);font-size:13px;margin:4px 0}
.warn{color:#c0392b;font-size:13px;margin-top:8px}
table{width:100%;border-collapse:collapse;font-size:13px}
td,th{padding:6px 6px;text-align:left;border-bottom:1px solid var(--line)}
th{color:var(--muted);font-weight:600}
td:nth-child(n+2),th:nth-child(n+2){text-align:right}
.up{color:#2f9e44;font-weight:700}.down{color:#e03131;font-weight:700}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{background:var(--bg1);border:1px solid var(--line);border-radius:99px;padding:4px 10px;font-size:12px}
.qrow{padding:8px 0;border-bottom:1px dashed var(--line)}.qrow:last-child{border:0}
.qname{font-size:14px;margin-bottom:5px}
.bar{height:8px;background:#f2e8f2;border-radius:99px;overflow:hidden}
.bar span{display:block;height:100%;background:linear-gradient(90deg,#e879b9,#8b7cf6);border-radius:99px}
.foot{text-align:center;color:var(--muted);font-size:12px;margin-top:6px}
.act{width:100%;padding:11px;border:0;border-radius:12px;background:linear-gradient(135deg,#e879b9,#8b7cf6);color:#fff;font-size:15px;font-weight:700;cursor:pointer}
.act:active{opacity:.85}
.flash{background:#e7f7ec;border:1px solid #b7e4c7;color:#1b6b3a;border-radius:14px;padding:12px 14px;font-size:14px}
</style></head><body><div class="wrap">
  <div class="hero">
    <div class="name">👋 ${esc(d.username)}</div>
    <div class="coins">${c.emoji} ${num(coins)} <span style="font-size:15px">${esc(c.name)}</span></div>
    <div class="sub">總市值（含持股 ${num(d.stockVal)}）　·　背包約 ${num(d.bagValue)}</div>
  </div>
  ${flash}
  ${card('🧾 稅單（本期預估）', taxBody)}
  ${card('📈 我的持股', stockBody)}
  ${card('🐠 魚缸', aqBody)}
  ${card('🐔 牧場', ranchBody)}
  ${card('🌾 農地／溫室', cropBody)}
  ${card('📜 任務', qBody)}
  ${card('🎒 背包', bagBody)}
  <div class="foot">撈金／收成／採收可直接在這裡一鍵領取；買賣、兌換、股票等其他操作目前請回 Discord。重新整理看最新資料。</div>
</div></body></html>`;
}

// ---- 路由 ----
router.get('/play/:token/manifest.json', (req, res) => {
  const t = parseToken(req.params.token);
  if (!t) return res.status(404).json({ error: 'bad token' });
  res.json({
    name: '璃白冒險', short_name: '冒險', description: '你的冒險數據：錢包、稅單、持股、魚缸、牧場、農地、任務。',
    start_url: `/play/${req.params.token}`, scope: `/play/${req.params.token}`,
    display: 'standalone', orientation: 'portrait-primary',
    background_color: '#fff5fa', theme_color: '#5865f2', lang: 'zh-Hant-TW',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
    ]
  });
});

router.get('/play/:token', (req, res) => {
  const t = parseToken(req.params.token);
  if (!t) return res.status(403).type('html').send('<h2 style="font-family:sans-serif">連結無效或已過期</h2><p>請回 Discord 用 <b>/家園網頁</b> 或 <b>/遊戲</b> 重新取得你的連結。</p>');
  const d = collect(t.gid, t.uid);
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(render(d, req.params.token, String(req.query.msg || '').slice(0, 200)));
});

// ---- 安全的「一鍵領取」動作（只把自己的東西收進自己身上，連結被轉傳也無害）----
function doAct(req, res, fn) {
  const t = parseToken(req.params.token);
  if (!t) return res.redirect('/play');
  let msg = '';
  try { msg = fn(t.gid, t.uid) || ''; } catch { msg = '操作失敗，請稍後再試。'; }
  res.redirect(`/play/${req.params.token}?msg=${encodeURIComponent(msg)}`);
}
router.post('/play/:token/collect', (req, res) => doAct(req, res, (gid, uid) => {
  const uname = (db.prepare('SELECT username FROM econ_wallets WHERE guild_id=? AND user_id=?').get(gid, uid) || {}).username || '玩家';
  const r = require('../bot/features/aquarium').collect(gid, uid, uname);
  return r.error ? r.error : '🪙 撈金成功，魚缸的星幣已領進錢包！';
}));
router.post('/play/:token/harvest', (req, res) => doAct(req, res, (gid, uid) => {
  const r = require('../bot/features/ranch').harvest(gid, uid);
  return r.empty ? '目前沒有可收成的產物。' : `🧺 收成成功：${r.lines.join('、')}，已放進背包。`;
}));
router.post('/play/:token/reap', (req, res) => doAct(req, res, (gid, uid) => {
  const r = require('../bot/features/crops').reap(gid, uid);
  return r.empty ? '目前沒有成熟的作物。' : `🧺 採收成功：${r.lines.join('、')}，已放進背包。`;
}));

router.get('/play', (req, res) => {
  res.type('html').send('<h2 style="font-family:sans-serif">璃白冒險 App</h2><p>請回 Discord 用 <b>/遊戲</b>（或 /家園網頁）取得你的專屬連結，就能在手機上看自己的冒險數據，還能「加到主畫面」當 App 用。</p>');
});

module.exports = router;
module.exports.playToken = playToken;
