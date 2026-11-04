// 玩家遊戲 App（Phase 1：唯讀）。同站 /play 路徑，手機可「加到主畫面」當 PWA 用。
// 用 HMAC 簽章 token（綁 guild+user，跟家園網頁同一把）辨識玩家 —— 唯讀、改不了東西。
// Phase 2（採集/買賣等動作）再升級成 Discord OAuth 登入。
const express = require('express');
const crypto = require('crypto');
const { db, guildConfig } = require('../db');
const push = require('../push');

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

// ---- Phase 2：Discord OAuth 登入 → 簽章 session cookie（花錢動作才需要）----
// 唯讀連結可轉傳（無害）；但買賣會花星幣，所以要「本人用 Discord 登入」才解鎖。
// 登入時比對 OAuth 拿到的 Discord user id 必須等於連結綁定的 uid，別人登入也不能動你的帳。
const SESS_MAX_AGE = 7 * 24 * 3600;   // 7 天
function makeSession(gid, uid) {
  const body = Buffer.from(`${gid}.${uid}.${Date.now() + SESS_MAX_AGE * 1000}`).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update('sess.' + body).digest('base64url').slice(0, 20);
  return `${body}.${sig}`;
}
function readSession(req) {
  const raw = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('play_sess='));
  if (!raw) return null;
  const [body, sig] = raw.slice('play_sess='.length).split('.');
  if (!body || !sig) return null;
  const want = crypto.createHmac('sha256', SECRET).update('sess.' + body).digest('base64url').slice(0, 20);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  const [gid, uid, exp] = Buffer.from(body, 'base64url').toString().split('.');
  if (!gid || !uid || Date.now() > Number(exp)) return null;
  return { gid, uid };
}
// 這個 request 是否已用本人身分登入、且對應到連結綁定的同一位玩家
function authedFor(req, t) {
  const s = readSession(req);
  return !!(s && t && s.gid === t.gid && s.uid === t.uid);
}
function redirectUri(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  return `${proto}://${req.get('host')}/play/auth/callback`;
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
  // 依品種彙總（有玩家養到上萬格，逐格列出手機會卡死）
  const fish = many(
    `SELECT f.name, f.emoji, COUNT(*) AS n, SUM(a.pending) AS pending FROM aquarium_slots a JOIN aquarium_fish f ON f.id=a.fish_id
      WHERE a.guild_id=? AND a.user_id=? GROUP BY a.fish_id ORDER BY n DESC, f.name`, uid);
  const fishPending = fish.reduce((s, x) => s + (x.pending || 0), 0);

  // 牧場
  const animals = many(
    `SELECT a.name, a.emoji, COUNT(*) AS n, SUM(r.pending) AS pending FROM ranch_slots r JOIN ranch_animals a ON a.id=r.animal_id
      WHERE r.guild_id=? AND r.user_id=? GROUP BY r.animal_id ORDER BY n DESC, a.name`, uid);
  const ranchPending = animals.reduce((s, x) => s + (x.pending || 0), 0);

  // 農地／溫室
  const now = Date.now();
  let plots = [];
  try { plots = db.prepare(
    `SELECT p.plot_type, s.name, s.emoji, COUNT(*) AS n,
            SUM(CASE WHEN COALESCE(p.ready_at,0) <= ? THEN 1 ELSE 0 END) AS ready,
            MIN(CASE WHEN COALESCE(p.ready_at,0) > ? THEN p.ready_at END) AS next_at
       FROM crop_plots p JOIN crop_seeds s ON s.id=p.seed_id
      WHERE p.guild_id=? AND p.user_id=? GROUP BY p.plot_type, p.seed_id ORDER BY p.plot_type, n DESC`).all(now, now, gid, uid); } catch { plots = []; }

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

// 掛牌股票（給買賣下拉用）
function tradableStocks(gid) {
  try {
    return db.prepare('SELECT code, name, emoji, price FROM stock_symbols WHERE guild_id=? ORDER BY code').all(gid);
  } catch { return []; }
}

// 可買的工具（還沒擁有的）
function buyableTools(gid, uid) {
  try {
    return db.prepare(
      `SELECT t.id, t.name, t.emoji, t.price, t.kind FROM gather_tools t
        WHERE t.guild_id=? AND t.enabled=1
          AND t.id NOT IN (SELECT tool_id FROM gather_user_tools WHERE guild_id=? AND user_id=?)
        ORDER BY t.kind, t.price`).all(gid, gid, uid);
  } catch { return []; }
}
// 可買的種子
function buyableSeeds(gid) {
  try { return db.prepare('SELECT id, name, emoji, seed_price, plot_type FROM crop_seeds WHERE guild_id=? AND enabled=1 ORDER BY sort, id').all(gid); }
  catch { return []; }
}
// 背包裡可種的種子（農地＋溫室都算）
function plantableList(gid, uid) {
  try {
    const crops = require('../bot/features/crops');
    return [...crops.plantableSeeds(gid, uid, 'field'), ...crops.plantableSeeds(gid, uid, 'greenhouse')]
      .map(x => ({ id: x.seed.id, name: x.seed.name, emoji: x.seed.emoji, have: x.have, type: x.seed.plot_type }));
  } catch { return []; }
}
// 素材兌換所今天開出的項目（附「這位玩家還能換幾次」）
function exchangeOffers(gid, uid) {
  try {
    const ex = require('../bot/features/exchange');
    if (!guildConfig('exchange_config', gid).enabled) return [];
    return ex.todayOffers(gid).map(o => ({
      id: o.id, title: o.title, emoji: o.emoji,
      cap: ex.capOf(gid, uid, o).cap
    }));
  } catch { return []; }
}

// 神秘商店可兌換的商品
function redeemItems(gid) {
  try { return db.prepare('SELECT id, name, emoji, price FROM special_items WHERE guild_id=? AND enabled=1 ORDER BY sort, price').all(gid); }
  catch { return []; }
}

// ---- 版面（手機 App 外殼：底部分頁、深淺色、可安裝 PWA）----
// 樣式與前端互動在 public/play-app.css / play-app.js（Service Worker 可快取，離線也開得起來）
const PLAY_ASSET_VER = '3';
// 主題開機程式：讀這台裝置的設定 → <html data-skin>、自訂背景圖（在 CSS 之後、內容之前執行，不會閃）
const SKIN_BOOT = `(function(){try{var s=JSON.parse(localStorage.getItem('play-skin')||'{}'),k=s.skin||'auto',r=document.documentElement;
if(k==='auto'){var d=new Date(),m=d.getMonth()+1,n=d.getDate();k=(m===10&&n>=15)||(m===11&&n===1)?'halloween':(m===12&&n<=26)?'christmas':(m===1||(m===2&&n<=15))?'newyear':'default';}
r.setAttribute('data-skin',k);var bg=localStorage.getItem('play-bg');if(bg){r.setAttribute('data-hasbg','');r.style.setProperty('--bgimg','url('+bg+')');r.style.setProperty('--dim',((s.dim==null?35:s.dim)/100));}}catch(e){}})();`;
const TABS = [
  ['home', '總覽', '<path d="M3.5 10.5 12 3.8l8.5 6.7v9.2a.8.8 0 0 1-.8.8h-5.1v-6.2H9.4v6.2H4.3a.8.8 0 0 1-.8-.8z"/>'],
  ['play', '玩法', '<circle cx="12" cy="12" r="8.5"/><path d="m15.7 8.3-2.1 5.3-5.3 2.1 2.1-5.3z"/>'],
  ['farm', '家園', '<path d="M12 21c-4.4-2.3-7-6-7-10.2C5 7 8 4 12 3c4 1 7 4 7 7.8 0 4.2-2.6 7.9-7 10.2Z"/><path d="M12 21V9"/>'],
  ['market', '市場', '<path d="M4 19V9m5.3 10V5m5.4 14v-7M20 19V8"/>'],
  ['me', '我的', '<circle cx="12" cy="8" r="4"/><path d="M4.5 21a7.5 7.5 0 0 1 15 0"/>']
];

function render(d, token, msg, authed) {
  const c = d.cur;
  const money = (n) => `${c.emoji} ${num(n)}`;
  const coins = d.wallet.coins;
  const arrears = d.wallet.tax_arrears || 0;
  const base = `/play/${token}`;

  const card = (title, body, extra = '') => `<section class="card${extra}"><h2>${title}</h2>${body}</section>`;
  const row = (l, r, cls = '') => `<div class="row"><span>${l}</span><b class="${cls}">${r}</b></div>`;
  const empty = (t) => `<p class="empty">${t}</p>`;
  // 表單一律 POST，前端 play-app.js 會在送出時鎖按鈕防連點、記住目前分頁
  const actBtn = (path, label, cls = '') => `<form method="post" action="${base}/${path}"><button class="btn primary block ${cls}">${label}</button></form>`;
  const lockNote = `<a class="lock" href="${base}/login"><span>🔐</span><span>用 Discord 登入後才能操作<small>確保是你本人，避免別人花你的星幣</small></span></a>`;
  const needAuth = (body) => authed ? body : lockNote;
  const mini = (path, name, ph, btn) => `<form method="post" action="${base}/${path}" class="inline"><input name="${name}" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" placeholder="${ph}" required><button class="btn primary">${btn}</button></form>`;
  const selForm = (path, rows, optOf, btn, withQty) => {
    if (!rows.length) return empty('目前沒有可選的項目。');
    const qty = withQty ? `<input class="qty" name="qty" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" value="1" aria-label="數量">` : '';
    return `<form method="post" action="${base}/${path}" class="inline"><select name="id" aria-label="選擇">${rows.map(optOf).join('')}</select>${qty}<button class="btn primary">${btn}</button></form>`;
  };

  // ---------- 總覽 ----------
  const readyN = d.plots.reduce((s, p) => s + (p.ready || 0), 0);
  const claim = [];
  if (d.fishPending > 0) claim.push(actBtn('collect', `🐠 撈金 ${money(d.fishPending)}`));
  if (d.ranchPending > 0) claim.push(actBtn('harvest', `🐔 牧場收成`));
  if (readyN > 0) claim.push(actBtn('reap', `🌾 採收 ${readyN} 格`));
  const claimBody = claim.length ? `<div class="stack">${claim.join('')}</div><p class="hint">一鍵領取不用登入，東西只會進你自己的錢包或背包。</p>` : empty('目前沒有可領取的東西，晚點再來看看 🌙');

  let taxBody;
  if (!d.tax) taxBody = empty('目前沒有開徵稅金，或你在免稅名單內。');
  else {
    const t = d.tax; const lines = [];
    if (t.income) lines.push(row('💰 所得稅', money(t.income)));
    if (t.stock) lines.push(row('📈 證券稅', money(t.stock)));
    if (t.land) lines.push(row('🌾 農地稅', money(t.land)));
    if (t.breed) lines.push(row('🐄 養殖稅', money(t.breed)));
    if (t.spend) lines.push(row('🛍️ 消費稅', money(t.spend)));
    if (t.credit) lines.push(row('❤️ 慈善折抵', `−${money(t.credit)}`, 'up'));
    if (t.arrears) lines.push(row('🔁 上期未繳補收', money(t.arrears), 'down'));
    taxBody = (lines.join('') || empty('本期免稅 🎉')) +
      `<div class="tot">本期預估合計 <b>${money(t.total)}</b></div>` +
      (arrears ? `<p class="warn">⚠️ 累積欠稅 ${money(arrears)}，下次結算會補收（也可在 Discord 用 /稅單 補繳）。</p>` : '');
  }

  const qBody = d.quests.length
    ? d.quests.map(q => {
        const pct = Math.min(100, Math.round(q.cur / Math.max(1, q.goal) * 100));
        const tag = q.done ? (q.claimed ? '<span class="tag ok">已領</span>' : '<span class="tag hot">可領獎</span>') : '';
        return `<div class="quest"><div class="qh"><span>${esc(q.name)} ${tag}</span><span class="muted">${q.cur}/${q.goal}</span></div><div class="bar"><span style="width:${pct}%"></span></div></div>`;
      }).join('') + (d.quests.some(q => q.done && !q.claimed) ? `<p class="hint">達成的任務請回 Discord 用 /任務 領獎。</p>` : '')
    : empty('目前沒有任務。');

  const homeTab = `
    ${card('🎁 可領取', claimBody)}
    ${card('📜 任務', qBody)}
    ${card('🧾 稅單（本期預估）', taxBody)}`;

  // ---------- 玩法 ----------
  const GATHER = [['fish', '🎣', '釣魚'], ['mine', '⛏️', '挖礦'], ['wood', '🪓', '伐木'], ['forage', '🧺', '採集'], ['hunt', '🏹', '狩獵']];
  const gatherBody = needAuth(`<div class="tiles">${GATHER.map(([k, e, l]) =>
      `<form method="post" action="${base}/gather"><input type="hidden" name="kind" value="${k}"><button class="tile"><span class="te">${e}</span><span>${l}</span></button></form>`).join('')}</div>
    <p class="hint">每次消耗體力、有冷卻時間，抽到的東西直接進背包。換地圖、看圖鑑請回 Discord。</p>`);
  const tools = buyableTools(d.gid, d.uid), seeds = buyableSeeds(d.gid), plantable = plantableList(d.gid, d.uid), redeems = redeemItems(d.gid);
  const exOffers = exchangeOffers(d.gid, d.uid);
  const plotLabel = (t) => t === 'greenhouse' ? '溫室' : '農地';
  const playTab = `
    ${card('🎮 採集玩法', gatherBody)}
    ${card('🌱 種田', needAuth(`
      <h3>買種子</h3>${selForm('buyseed', seeds, s => `<option value="${s.id}">${esc((s.emoji || '') + s.name)}｜${num(s.seed_price)}（${plotLabel(s.plot_type)}）</option>`, '買', true)}
      <h3>種下背包裡的種子</h3>${selForm('plant', plantable, p => `<option value="${p.id}">${esc((p.emoji || '') + p.name)}｜有 ${p.have}（${plotLabel(p.type)}）</option>`, '種', true)}`))}
    ${card('🐟 照顧', needAuth(`<div class="stack">${actBtn('feed', '🍤 一鍵餵魚')}</div>`))}`;

  // ---------- 家園 ----------
  const slotRow = (emoji, name, sub, right, cls) => `<div class="slot"><span class="se">${esc(emoji)}</span><span class="sn">${esc(name)}<small>${sub}</small></span><b class="${cls || ''}">${right}</b></div>`;
  const totalN = (rows) => rows.reduce((s, r) => s + (r.n || 0), 0);
  const aqBody = (d.fish.length
    ? d.fish.map(f => slotRow(f.emoji || '🐠', f.name, `${num(f.n)} 隻`, `未領 ${money(f.pending)}`)).join('') + `<div class="tot">共 ${num(totalN(d.fish))} 隻・可撈金 <b>${money(d.fishPending)}</b></div>`
    : empty('魚缸還沒養魚。')) + (d.fishPending > 0 ? actBtn('collect', `🪙 一鍵撈金 ${money(d.fishPending)}`) : '');
  const ranchBody = (d.animals.length
    ? d.animals.map(a => slotRow(a.emoji || '🐔', a.name, `${num(a.n)} 隻`, `未領 ${money(a.pending)}`)).join('') + `<div class="tot">共 ${num(totalN(d.animals))} 隻・可收 <b>${money(d.ranchPending)}</b></div>`
    : empty('牧場還沒養動物。')) + (d.ranchPending > 0 ? actBtn('harvest', '🧺 一鍵收成') : '');
  const cropBody = (d.plots.length
    ? d.plots.map(p => `<div class="slot"><span class="se">${esc(p.emoji || '🌱')}</span><span class="sn">${esc(p.name)}<small>${plotLabel(p.plot_type)}・${num(p.n)} 格${p.ready && p.ready < p.n ? `・${num(p.ready)} 格可採收` : ''}</small></span>${p.ready >= p.n ? '<b class="tag ok">可採收</b>' : `<b class="muted" data-ready="${Number(p.next_at) || 0}">成長中</b>`}</div>`).join('')
    : empty('農地／溫室還沒種東西。')) + (readyN > 0 ? actBtn('reap', `🧺 一鍵採收（${readyN} 格成熟）`) : '');
  const farmTab = `
    ${card('🐠 魚缸', aqBody)}
    ${card('🐔 牧場', ranchBody)}
    ${card('🌾 農地／溫室', cropBody)}`;

  // ---------- 市場 ----------
  const stockBody = d.holdings.length
    ? `<div class="list">${d.holdings.map(h => `<div class="slot"><span class="se">${esc(h.emoji || '📈')}</span><span class="sn">${esc(h.name)}<small>${esc(h.code)}｜${num(h.shares)} 股｜均價 ${num(h.avg)}</small></span><span class="rt"><b>${num(h.value)}</b><small class="${h.pnl >= 0 ? 'up' : 'down'}">${h.pnl >= 0 ? '+' : ''}${num(h.pnl)}</small></span></div>`).join('')}</div>
      <div class="tot">持股總市值 <b>${money(d.stockVal)}</b></div>`
    : empty('目前沒有持股。');
  const opts = tradableStocks(d.gid).map(s => `<option value="${esc(s.code)}">${esc((s.emoji || '') + s.name)} ${esc(s.code)}｜現價 ${num(s.price)}</option>`).join('');
  const tradeBody = opts
    ? `<form method="post" action="${base}/stock" class="form">
        <select name="code" aria-label="股票">${opts}</select>
        <div class="seg" role="radiogroup">
          <label><input type="radio" name="side" value="buy" checked><span>📥 買進</span></label>
          <label><input type="radio" name="side" value="sell"><span>📤 賣出</span></label>
        </div>
        <input name="shares" type="text" inputmode="numeric" autocomplete="off" placeholder="股數（賣出可填「全部」）" required>
        <button class="btn primary block">送出交易</button>
      </form><p class="hint">交易會扣手續費；買進受每人持股上限限制。</p>`
    : empty('目前沒有掛牌的股票。');
  const marketTab = `
    ${card('📈 我的持股', stockBody)}
    ${card('💹 買賣股票', needAuth(tradeBody))}
    ${card('🛠️ 買工具', needAuth(selForm('buytool', tools, t => `<option value="${t.id}">${esc((t.emoji || '') + t.name)}｜${num(t.price)}</option>`, '買', false)))}
    ${card('🛒 神秘商店', needAuth(selForm('redeem', redeems, r => `<option value="${r.id}">${esc((r.emoji || '') + r.name)}｜${num(r.price)}</option>`, '兌換', true)))}
    ${card('♻️ 素材兌換所', needAuth(exOffers.length
      ? selForm('exchange', exOffers, o => `<option value="${o.id}">${esc((o.emoji || '') + o.title)}｜可換 ${o.cap} 次</option>`, '換', true) + `<p class="hint">不花星幣，用背包裡的素材換。清單每天午夜更新。</p>`
      : empty('今天沒有開出兌換項目（或兌換所還沒開啟）。')))}`;

  // ---------- 我的 ----------
  const bagKinds = Object.keys(d.bag);
  const bagBody = bagKinds.length
    ? bagKinds.map((k, i) => `<details class="bag"${i === 0 || bagKinds.length <= 2 ? ' open' : ''}><summary>${k}<span class="muted">${d.bag[k].length} 種</span></summary><div class="chips">` +
        d.bag[k].map(it => `<span class="chip">${esc((it.emoji || '') + it.name)}<b>×${num(it.count)}</b></span>`).join('') + `</div></details>`).join('') +
      `<div class="tot">全部賣掉約 <b>${money(d.bagValue)}</b></div>` + (authed ? actBtn('sellbag', '🎒 一鍵賣光背包', 'warnbtn') : '')
    : empty('背包是空的。');
  const financeBody = needAuth(`
    <h3>❤️ 捐款慈善基金會（可折抵所得稅）</h3>${mini('donate', 'amount', '捐款金額', '捐款')}
    <h3>💳 還款</h3>${mini('repay', 'amount', '還款金額', '還款')}
    <h3>💳 信用貸款（免抵押）</h3>${mini('credit', 'amount', '借款金額', '借款')}
    <h3>📦 物資貸款（用工具／作物／魚抵押）</h3>${mini('loan', 'amount', '借款金額', '借款')}`);
  const pushOn = authed && push.enabled() && push.publicKey();
  const subscribed = pushOn && push.hasSubscription(d.gid, d.uid);
  const pushBody = `<button class="btn primary block" id="pushbtn" type="button" data-vapid="${esc(push.publicKey() || '')}">${subscribed ? '🔔 推播已開啟（重新綁定這台裝置）' : '🔔 開啟推播通知'}</button>
    <p class="hint" id="pushmsg">稅單開徵、貸款到期、魚缸／牧場滿了會推播到手機。iPhone 要先「加入主畫面」再開啟。</p>
    ${subscribed ? actBtn('push-test', '傳一則測試推播', 'ghost') : ''}`;
  const appBody = `<button class="btn block ghost" id="installBtn" type="button" hidden>📲 安裝到主畫面</button>
    <div class="ios-tip" id="iosTip" hidden>iPhone／iPad：點 Safari 下方的 <b>分享</b> → <b>加入主畫面</b>，就能像 App 一樣全螢幕開啟。</div>
    <div class="row"><span>登入狀態</span><b>${authed ? '🔓 已登入' : '🔒 唯讀'}</b></div>
    ${authed ? `<a class="btn block ghost" href="${base}/logout">登出</a>` : `<a class="btn block primary" href="${base}/login">🔐 用 Discord 登入</a>`}`;
  // 外觀主題：存在這台裝置（localStorage），前端 play-app.js 套用
  const SKINS = [['auto', '🗓️', '自動'], ['default', '💜', '預設'], ['christmas', '🎄', '聖誕節'], ['halloween', '🎃', '萬聖節'],
    ['newyear', '🧧', '新年'], ['sakura', '🌸', '春櫻'], ['osmanthus', '🍂', '秋桂']];
  const skinBody = `<div class="skins" role="radiogroup" aria-label="主題">${SKINS.map(([k, e, l]) =>
      `<label class="skin skin-${k}"><input type="radio" name="skin" value="${k}"><span class="sw"><i>${e}</i></span><span>${l}</span></label>`).join('')}</div>
    <p class="hint">「自動」會依節日切換：10/15–11/1 萬聖節、12/1–12/26 聖誕節、1/1–2/15 新年。</p>
    <h3>自訂背景圖</h3>
    <div class="bgpick">
      <div class="bgthumb" id="bgThumb"><span>尚未設定</span></div>
      <div class="bgbtns">
        <label class="btn primary">📷 上傳圖片<input id="bgFile" type="file" accept="image/*" hidden></label>
        <button class="btn ghost" id="bgClear" type="button" hidden>移除背景圖</button>
      </div>
    </div>
    <label class="slider" id="dimRow" hidden><span>背景亮度</span><input id="bgDim" type="range" min="0" max="80" step="5" value="35" aria-label="背景遮罩"><output id="bgDimOut"></output></label>
    <label class="switch"><input id="decoOn" type="checkbox" checked><span>飄落動畫（雪花、花瓣…）</span></label>
    <p class="hint">背景圖只存在這台裝置，不會上傳到伺服器。建議用直式或風景照，系統會自動縮小。</p>`;
  const meTab = `
    ${card('🎨 外觀主題', skinBody)}
    ${card('🎒 背包', bagBody)}
    ${card('🏦 金融', financeBody)}
    ${pushOn ? card('🔔 推播通知', pushBody) : ''}
    ${card('📱 App 與帳號', appBody)}`;

  const tabs = { home: homeTab, play: playTab, farm: farmTab, market: marketTab, me: meTab };
  const badge = { home: claim.length, farm: (d.fishPending > 0) + (d.ranchPending > 0) + (readyN > 0) };
  const isOk = msg && !/失敗|錯誤|不足|無法|不能|請先|請填|沒有|不認得|已經不在|冷卻|體力/.test(msg);

  return `<!doctype html><html lang="zh-Hant"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><title>${esc(d.username)} 的冒險</title>
<link rel="manifest" href="${base}/manifest.json">
<meta name="theme-color" content="#fff5fa" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#17141f" media="(prefers-color-scheme: dark)">
<link rel="icon" type="image/png" href="/icon-192.png">
<link rel="apple-touch-icon" href="/icon-192.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="璃白冒險">
<meta name="mobile-web-app-capable" content="yes">
<link rel="stylesheet" href="/play-app.css?v=${PLAY_ASSET_VER}">
<script>${SKIN_BOOT}</script>
</head><body>
<header class="appbar">
  <div class="hero">
    <div class="who"><span class="hi">👋 ${esc(d.username)}</span><span class="pill ${authed ? 'on' : ''}">${authed ? '已登入' : '唯讀'}</span></div>
    <div class="coins">${c.emoji} <b>${num(coins)}</b> <small>${esc(c.name)}</small></div>
    <div class="stats">
      <span>📈 持股 <b>${num(d.stockVal)}</b></span>
      <span>🎒 背包 <b>${num(d.bagValue)}</b></span>
      ${arrears ? `<span class="down">⚠️ 欠稅 <b>${num(arrears)}</b></span>` : ''}
    </div>
  </div>
</header>
<main class="tabs">
${TABS.map(([k]) => `<div class="tab" id="tab-${k}" data-tab="${k}">${tabs[k]}</div>`).join('\n')}
  <p class="foot">資料與 Discord 同步　·　下拉或切回 App 會自動更新</p>
</main>
<nav class="tabbar" aria-label="分頁">
${TABS.map(([k, l, svg]) => `<a href="#${k}" data-go="${k}"><span class="ic"><svg viewBox="0 0 24 24" aria-hidden="true">${svg}</svg>${badge[k] ? `<i class="dot">${badge[k]}</i>` : ''}</span><span>${l}</span></a>`).join('')}
</nav>
${msg ? `<div class="toast ${isOk ? 'ok' : 'err'}" role="status">${esc(msg)}</div>` : ''}
<div class="offline" id="offline" hidden>📡 目前離線，顯示的是上次的資料</div>
<script src="/play-app.js?v=${PLAY_ASSET_VER}" defer></script>
</body></html>`;
}

// 無 token 的說明頁（連結無效、/play 首頁）—— 沿用 App 樣式
function notice(title, body) {
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex">
<title>${esc(title)}</title><link rel="icon" type="image/png" href="/icon-192.png"><link rel="stylesheet" href="/play-app.css?v=${PLAY_ASSET_VER}">
</head><body class="notice"><main><img src="/icon-192.png" alt="" width="72" height="72"><h1>${esc(title)}</h1>${body}</main></body></html>`;
}

// ---- 路由 ----
router.get('/play/:token/manifest.json', (req, res) => {
  const t = parseToken(req.params.token);
  if (!t) return res.status(404).json({ error: 'bad token' });
  const base = `/play/${req.params.token}`;
  res.set('Cache-Control', 'no-cache');
  res.type('application/manifest+json').send(JSON.stringify({
    id: base, name: '璃白冒險', short_name: '璃白冒險',
    description: '璃白Yu光管家的網頁版：採集、種田、魚缸、牧場、股市、背包與稅單，和 Discord 同步。',
    start_url: `${base}#home`, scope: base,
    display: 'standalone', display_override: ['standalone', 'minimal-ui'], orientation: 'portrait',
    background_color: '#fff5fa', theme_color: '#fff5fa', lang: 'zh-Hant-TW', categories: ['games', 'entertainment'],
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
    ],
    shortcuts: [
      { name: '採集玩法', short_name: '玩法', url: `${base}#play`, icons: [{ src: '/icon-192.png', sizes: '192x192' }] },
      { name: '魚缸／牧場／農地', short_name: '家園', url: `${base}#farm`, icons: [{ src: '/icon-192.png', sizes: '192x192' }] },
      { name: '股市', short_name: '市場', url: `${base}#market`, icons: [{ src: '/icon-192.png', sizes: '192x192' }] }
    ]
  }));
});

router.get('/play/:token', (req, res) => {
  const t = parseToken(req.params.token);
  if (!t) return res.status(403).type('html').send(notice('連結無效或已過期', '<p>請回 Discord 用 <b>/遊戲</b> 或 <b>/家園網頁</b> 重新取得你的專屬連結。</p>'));
  const d = collect(t.gid, t.uid);
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(render(d, req.params.token, String(req.query.msg || '').slice(0, 200), authedFor(req, t)));
});

// ---- Discord OAuth：登入 → 回呼 → 種下 session cookie ----
router.get('/play/:token/login', (req, res) => {
  const t = parseToken(req.params.token);
  if (!t) return res.redirect('/play');
  const p = new URLSearchParams({
    client_id: require('../bot').roleClientId('butler'), redirect_uri: redirectUri(req),
    response_type: 'code', scope: 'identify', state: req.params.token, prompt: 'consent'
  });
  res.redirect('https://discord.com/oauth2/authorize?' + p.toString());
});

// 回呼共用給咒語簿（/spell）：state 帶 `spell.` 前綴就是它送來的。
// 共用一組 Redirect URI，Discord 開發者後台才不必為每個小 App 再加一條。
router.get('/play/auth/callback', async (req, res) => {
  const state = String(req.query.state || '');
  const forSpell = state.startsWith('spell.');
  const token = forSpell ? state.slice('spell.'.length) : state;
  const t = parseToken(token);
  if (!t) return res.status(400).type('html').send(notice('登入狀態無效', '<p>請回 Discord 用 <b>/遊戲</b> 重新取得連結。</p>'));
  const code = req.query.code;
  const home = forSpell ? `/spell/${token}` : `/play/${token}`;
  const back = (m) => res.redirect(`${home}?msg=${encodeURIComponent(m)}`);
  if (!code) return back('已取消登入。');
  try {
    const form = new URLSearchParams({
      client_id: require('../bot').roleClientId('butler'),
      client_secret: require('../bot').roleClientSecret('butler'),
      grant_type: 'authorization_code', code: String(code), redirect_uri: redirectUri(req)
    });
    const tokRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString()
    });
    const tok = await tokRes.json();
    if (!tok || !tok.access_token) return back('登入失敗，請再試一次。');
    const meRes = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${tok.access_token}` } });
    const me = await meRes.json();
    if (!me || !me.id) return back('讀不到 Discord 帳號，請再試一次。');
    if (me.id !== t.uid) return res.status(403).type('html').send(notice('帳號不符', '<p>你登入的 Discord 帳號跟這個連結綁定的不是同一人，無法代為操作。請用自己的連結。</p>'));
    if (forSpell) {
      require('./spell').setSessionCookie(res, t.gid, t.uid);
      return res.redirect(home);
    }
    res.setHeader('Set-Cookie',
      `play_sess=${makeSession(t.gid, t.uid)}; Path=/play; Max-Age=${SESS_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`);
    return back('🔓 已登入，現在可以在這裡買賣操作了！');
  } catch (e) {
    return back('登入過程出錯，請稍後再試。');
  }
});

router.get('/play/:token/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'play_sess=; Path=/play; Max-Age=0; HttpOnly; Secure; SameSite=Lax');
  res.redirect(`/play/${req.params.token}?msg=${encodeURIComponent('已登出。')}`);
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

// ---- 需登入的花錢動作（session 必須對應到連結綁定的同一位玩家）----
function doAuthedAct(req, res, fn) {
  const t = parseToken(req.params.token);
  if (!t) return res.redirect('/play');
  if (!authedFor(req, t)) return res.redirect(`/play/${req.params.token}/login`);
  let msg = '';
  try { msg = fn(t.gid, t.uid) || ''; } catch (e) { msg = '操作失敗，請稍後再試。'; }
  res.redirect(`/play/${req.params.token}?msg=${encodeURIComponent(msg)}`);
}
async function doAuthedActAsync(req, res, fn) {
  const t = parseToken(req.params.token);
  if (!t) return res.redirect('/play');
  if (!authedFor(req, t)) return res.redirect(`/play/${req.params.token}/login`);
  let msg = '';
  try { msg = (await fn(t.gid, t.uid)) || ''; } catch (e) { msg = '操作失敗，請稍後再試。'; }
  res.redirect(`/play/${req.params.token}?msg=${encodeURIComponent(msg)}`);
}
router.post('/play/:token/stock', (req, res) => doAuthedAct(req, res, (gid, uid) => {
  const stock = require('../bot/features/stock');
  const code = String((req.body && req.body.code) || '').trim();
  const side = (req.body && req.body.side) === 'sell' ? 'sell' : 'buy';
  const rawShares = String((req.body && req.body.shares) || '').trim();
  if (!code) return '請先選一支股票。';
  const uname = (db.prepare('SELECT username FROM econ_wallets WHERE guild_id=? AND user_id=?').get(gid, uid) || {}).username || '玩家';
  const r = side === 'sell'
    ? stock.sell(gid, uid, uname, code, rawShares || '全部')
    : stock.buy(gid, uid, uname, code, Math.floor(Number(rawShares)));
  if (r && r.error) return r.error;
  const coins = (db.prepare('SELECT coins FROM econ_wallets WHERE guild_id=? AND user_id=?').get(gid, uid) || {}).coins || 0;
  return `${side === 'sell' ? '📤 賣出' : '📥 買進'}成交！目前餘額 ${num(coins)}。`;
}));

const uname = (gid, uid) => (db.prepare('SELECT username FROM econ_wallets WHERE guild_id=? AND user_id=?').get(gid, uid) || {}).username || '玩家';

const GATHER_LABEL = { fish: '釣魚', mine: '挖礦', wood: '伐木', forage: '採集', hunt: '狩獵' };
router.post('/play/:token/gather', (req, res) => doAuthedAct(req, res, (gid, uid) => {
  const kind = String((req.body && req.body.kind) || '');
  if (!GATHER_LABEL[kind]) return '不認得的玩法。';
  const r = require('../bot/features/gather').doGather(gid, uid, uname(gid, uid), kind);
  if (r.error) return r.error;
  const rare = r.item.rarity ? `〔${r.item.rarity}〕` : '';
  const bits = [`🎉 ${GATHER_LABEL[kind]}到 ${(r.item.emoji || '') + r.item.name}${rare}${r.isNew ? ' 🆕圖鑑新收錄' : ''}`,
    `可賣 ${num(r.sellPrice)}，持有 ${num(r.count)}`];
  if (r.stLeft != null) bits.push(`體力剩 ${r.stLeft}/${r.stMax}`);
  if (r.toolBroke) bits.push(`⚠️ ${(r.tool.emoji || '') + r.tool.name} 壞了，去 /修理`);
  else if (r.toolLeft != null && r.toolLeft <= 5) bits.push(`工具耐久 ${r.toolLeft}/${r.toolDur}（快壞）`);
  if (r.doneQuests && r.doneQuests.length) bits.push(`📜 任務達成 ${r.doneQuests.length} 個，回 Discord /任務 領獎`);
  return bits.join('｜');
}));

// 推播：儲存這台裝置的訂閱（fetch/JSON，回 JSON；一樣要本人登入）
router.post('/play/:token/push-subscribe', (req, res) => {
  const t = parseToken(req.params.token);
  if (!t || !authedFor(req, t)) return res.status(403).json({ error: 'not authed' });
  try {
    const ok = push.saveSubscription(t.gid, t.uid, req.body);
    return ok ? res.json({ ok: true }) : res.status(400).json({ error: 'bad subscription' });
  } catch (e) { return res.status(500).json({ error: 'save failed' }); }
});
router.post('/play/:token/push-test', (req, res) => doAuthedActAsync(req, res, async (gid, uid) => {
  if (!push.enabled()) return '這個伺服器還沒設定推播。';
  const r = await push.sendPush(gid, uid, { title: '🔔 測試推播', body: '你的推播設定成功了！以後稅單/貸款到期會通知你。', url: `/play/${req.params.token}` });
  if (r.sent > 0) return `已送出測試推播（${r.sent} 台裝置），看看手機通知～`;
  if (r.tried > 0) return '裝置沒收到（訂閱可能過期），請再按一次「開啟推播通知」重新綁定。';
  return '還沒有已訂閱的裝置，請先按「開啟推播通知」。';
}));

router.post('/play/:token/feed', (req, res) => doAuthedAct(req, res, (gid, uid) => {
  const r = require('../bot/features/aquarium').feedAll(gid, uid, uname(gid, uid));
  return r.error ? r.error : '🍤 餵魚完成！魚兒又能撐一陣子了。';
}));
router.post('/play/:token/sellbag', (req, res) => doAuthedAct(req, res, (gid, uid) => {
  const r = require('../bot/features/gather').sellAllBag(gid, uid, uname(gid, uid));
  if (r.empty) return '背包沒有可賣的東西（工具賣不掉；📦 倉庫裡的東西不會被賣掉）。';
  return `🎒 賣光背包：${r.kinds} 種，共 +${num(r.total)} 星幣。`;
}));
router.post('/play/:token/donate', (req, res) => doAuthedAct(req, res, (gid, uid) => {
  const amt = Math.floor(Number((req.body && req.body.amount) || 0));
  if (!(amt > 0)) return '請填要捐的金額。';
  const r = require('../bot/features/charity').donate(gid, uid, uname(gid, uid), amt);
  return r.ok ? `❤️ 捐款成功 ${num(r.amount)}！折抵稅額 ${num(r.credit || 0)}，餘額 ${num(r.coins)}。` : r.msg;
}));
router.post('/play/:token/repay', (req, res) => doAuthedAct(req, res, (gid, uid) => {
  const amt = Math.floor(Number((req.body && req.body.amount) || 0));
  if (!(amt > 0)) return '請填要還的金額。';
  const r = require('../bot/features/loans').repay(gid, uid, amt);
  return r.ok ? `💳 還款 ${num(r.paid)}${r.cleared ? '，這筆已還清 ✅' : ''}，餘額 ${num(r.coins)}。` : r.msg;
}));
router.post('/play/:token/credit', (req, res) => doAuthedAct(req, res, (gid, uid) => {
  const amt = Math.floor(Number((req.body && req.body.amount) || 0));
  if (!(amt > 0)) return '請填要借的金額。';
  const r = require('../bot/features/loans').borrowCredit(gid, uid, uname(gid, uid), amt);
  return r.ok ? `💳 信用貸款核准！到手 ${num(amt)}，餘額 ${num(r.coins)}（記得準時 /還款）。` : r.msg;
}));
router.post('/play/:token/loan', (req, res) => doAuthedAct(req, res, (gid, uid) => {
  const amt = Math.floor(Number((req.body && req.body.amount) || 0));
  if (!(amt > 0)) return '請填要借的金額。';
  const r = require('../bot/features/loans').borrow(gid, uid, uname(gid, uid), amt);
  return r.ok ? `📦 物資貸款核准！到手 ${num(amt)}（已用你的資產抵押），餘額 ${num(r.coins)}。` : r.msg;
}));
router.post('/play/:token/buytool', (req, res) => doAuthedAct(req, res, (gid, uid) => {
  const id = Math.floor(Number((req.body && req.body.id) || 0));
  if (!id) return '請先選一個工具。';
  const r = require('../bot/features/gather').buyThing(gid, uid, uname(gid, uid), 'tool', id, 1);
  return r.error ? r.error : '🛠️ 工具買好了，去玩法就能用！';
}));
router.post('/play/:token/buyseed', (req, res) => doAuthedAct(req, res, (gid, uid) => {
  const id = Math.floor(Number((req.body && req.body.id) || 0));
  const qty = Math.max(1, Math.floor(Number((req.body && req.body.qty) || 1)));
  if (!id) return '請先選一種種子。';
  const r = require('../bot/features/crops').buySeeds(gid, uid, uname(gid, uid), id, qty);
  return r.error ? r.error : `🌱 種子買好了，進背包了，可以在下面「種植」種下。`;
}));
router.post('/play/:token/plant', (req, res) => doAuthedAct(req, res, (gid, uid) => {
  const id = Math.floor(Number((req.body && req.body.id) || 0));
  const qty = Math.max(1, Math.floor(Number((req.body && req.body.qty) || 1)));
  if (!id) return '請先選一種種子。';
  const r = require('../bot/features/crops').plantSeeds(gid, uid, uname(gid, uid), id, qty);
  return r.error ? r.error : `🌾 種好了！等成熟就能一鍵採收。`;
}));
// 素材兌換所：純素材進出，不碰星幣也不需要 bot client → 同步版就夠
router.post('/play/:token/exchange', (req, res) => doAuthedAct(req, res, (gid, uid) => {
  const id = Math.floor(Number((req.body && req.body.id) || 0));
  const qty = Math.max(1, Math.floor(Number((req.body && req.body.qty) || 1)));
  if (!id) return '請先選一個兌換項目。';
  const r = require('../bot/features/exchange').doExchange(gid, uid, uname(gid, uid), id, qty);
  return r.error ? r.error : '♻️ 兌換完成！換到的素材已經進背包。';
}));

// 神秘商店兌換：需要 bot client 與伺服器成員（限定商店資格檢查、管理員通知）→ 用 async 版
router.post('/play/:token/redeem', (req, res) => doAuthedActAsync(req, res, async (gid, uid) => {
  const id = Math.floor(Number((req.body && req.body.id) || 0));
  const qty = Math.max(1, Math.floor(Number((req.body && req.body.qty) || 1)));
  if (!id) return '請先選一個商品。';
  const item = db.prepare('SELECT * FROM special_items WHERE guild_id=? AND enabled=1 AND id=?').get(gid, id);
  if (!item) return '這個商品已經不在了。';
  const client = require('../bot').client;
  const guild = client && client.guilds ? client.guilds.cache.get(gid) : null;
  const member = guild ? await guild.members.fetch(uid).catch(() => null) : null;
  const un = uname(gid, uid);
  const r = await require('../bot/features/special').doRedeem(client, gid, item, { id: uid, username: un, bot: false }, un, qty, member);
  return r.error ? r.error : `🛒 兌換完成！（詳情看 Discord 通知或你的背包）`;
}));

router.get('/play', (req, res) => {
  res.type('html').send(notice('璃白冒險 App', '<p>在 Discord 輸入 <b>/遊戲</b>（或 /家園網頁），機器人會私訊你的專屬連結。</p><ol><li>打開連結就能看錢包、背包、魚缸、牧場、農地與股票</li><li>用 Discord 登入後，可以採集、種田、買賣股票</li><li>「加入主畫面」就能像 App 一樣使用，還能收推播</li></ol>'));
});

module.exports = router;
module.exports.playToken = playToken;
