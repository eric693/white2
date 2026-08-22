// 財經新聞快報 ＋ 星幣股市
//
// 兩個子系統共用一組新聞：一則快報可以同時推動「物價」（market_modifiers，
// 影響 /賣出 的賣價）與「股價」（stock_symbols 的下一個 tick）。
// 預設兩個都關閉，後台 market_config.enabled / stock_enabled 打開才會運作。
//
// 價格全程用整數星幣，只有波動率計算走浮點，結果一律 Math.round。
const {
  EmbedBuilder, MessageFlags, ActionRowBuilder,
  StringSelectMenuBuilder, ButtonBuilder, ButtonStyle
} = require('discord.js');
const cron = require('node-cron');
const { db, guildConfig, logError } = require('../../db');
const { brandColor } = require('../../util/brand');
const { activeModifiers, SCOPE_LABEL, bust, normMultPct } = require('../../util/market');
const { localToday } = require('../../util/time');

const cfg = (gid) => guildConfig('market_config', gid);
const gcfg = (gid) => guildConfig('gather_config', gid);
const csv = (s) => String(s || '').split(/[\n,]/).map(x => x.trim()).filter(Boolean);
const money = (c, n) => `${c.currency_emoji || '🪙'} ${Number(n).toLocaleString('en-US')} ${c.currency_name || '星幣'}`;
const num = (n) => Number(n || 0).toLocaleString('en-US');
// 下拉選單的 emoji：自訂表情 <:name:id> 要轉成物件，unicode 直接用，空的回 undefined
const selEmoji = (e) => {
  if (!e) return undefined;
  const m = /^<(a)?:([^:]+):(\d+)>$/.exec(String(e).trim());
  return m ? { id: m[3], name: m[2], animated: !!m[1] } : e;
};

const UP = 0x2C6455, DOWN = 0x9C3F37;   // 與 rules.html 的 --deep / --thorn 同色系

// ---- 預設股票：第一次啟用時建立，之後管理員在後台自己改 ----
// [代號, 名稱, emoji, 起始價, 波動率%, 回歸強度%, 說明]
const SEED_SYMBOLS = [
  ['2330', '白光雞蛋', '🐔', 60, 4, 14, '牛皮股，波動最小，新手練習用'],
  ['2317', '秘境礦業', '🪓', 180, 9, 10, '跟著採集行情走'],
  ['2454', '星光電台', '🎵', 320, 7, 10, '音樂頻道概念股'],
  ['6666', '偷偷樂控股', '🕵️', 95, 14, 8, '高波動妖股，賭徒最愛'],
  ['8888', '幸運符生技', '🍀', 240, 11, 9, '消息面敏感'],
  ['0050', '冒險大盤', '🌿', 500, 3, 18, '定存股，最穩']
];

function seedGuild(gid) {
  const c = cfg(gid);
  if (c.seeded) return;
  // 欄位順序必須與 VALUES 一一對應：drift_pct 固定 0（預設股票不帶長期趨勢），revert_pct 才是傳入的回歸強度
  const ins = db.prepare(
    `INSERT INTO stock_symbols (guild_id,code,name,emoji,price,anchor,vol_pct,drift_pct,revert_pct,floor_price,ceil_price,description,sort,enabled)
     VALUES (@guild_id,@code,@name,@emoji,@price,@anchor,@vol_pct,0,@revert_pct,@floor_price,@ceil_price,@description,@sort,1)`);
  db.transaction(() => {
    SEED_SYMBOLS.forEach(([code, name, emoji, price, vol, revert, desc], i) => {
      const has = db.prepare('SELECT 1 FROM stock_symbols WHERE guild_id=? AND code=?').get(gid, code);
      if (has) return;
      ins.run({
        guild_id: gid, code, name, emoji, price, anchor: price, vol_pct: vol, revert_pct: revert,
        floor_price: Math.max(1, Math.round(price * 0.15)), ceil_price: price * 20, description: desc, sort: i
      });
    });
    db.prepare('UPDATE market_config SET seeded=1 WHERE guild_id=?').run(gid);
  })();
}

// ================== 定價引擎 ==================

// 常態亂數（Box-Muller），夾在 ±3σ 免得偶爾噴出離譜值
function gauss() {
  const u = Math.max(1e-9, Math.random()), v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.max(-3, Math.min(3, z));
}

const symbols = (gid) => db.prepare('SELECT * FROM stock_symbols WHERE guild_id=? AND enabled=1 ORDER BY sort, id').all(gid);
const symbolByKey = (gid, key) => db.prepare(
  'SELECT * FROM stock_symbols WHERE guild_id=? AND enabled=1 AND (code=? OR name=? OR id=?)'
).get(gid, String(key), String(key), parseInt(key, 10) || 0);

const alignDown = (ms, step) => Math.floor(ms / step) * step;

// 算下一個價：趨勢 + 均值回歸 + 新聞衝擊 + 隨機波動，最後套漲跌停與上下限
function nextPrice(c, s, fx) {
  const vol = (s.vol_pct / 100) * ((fx?.vol_mult ?? 100) / 100);
  const drift = (s.drift_pct || 0) / 100;
  // 價格可以是 0 或負數，所以幅度一律用「絕對值」當基準
  const base = Math.abs(s.price);
  const gap = base > 0 ? (s.anchor - s.price) / base : 0;
  const revert = gap * ((s.revert_pct || 0) / 100);
  const shock = (fx?.impact_pct || 0) / 100;

  let change = drift + revert + shock + vol * gauss();
  const lim = Math.max(1, c.limit_pct || 20) / 100;
  change = Math.max(-lim, Math.min(lim, change));

  // 用 base 當步幅基準：股價逼近 0 時仍留最小跳動，才能真的穿越零線變負數
  const step = Math.max(base, Math.abs(s.anchor || 0) * 0.02, 1) * change;
  let px = Math.round(s.price + step);
  // 漲跌停要對「現價」封頂。anchor 很大時上面的步幅基準會遠大於現價
  // （例：現價 100、anchor -20000 → 一盤固定跳 60 塊 = -60%），停板等於形同虛設。
  // 現價接近 0 時至少留 1 塊，才走得到零以下。
  const cap = Math.max(1, Math.round(base * lim));
  px = Math.max(s.price - cap, Math.min(s.price + cap, px));
  // 步幅小於 1 會被四捨五入吃掉 → 價格永遠卡住不動。只要這個 tick 有方向就至少走 1 塊。
  if (px === s.price && change !== 0) px = s.price + (change > 0 ? 1 : -1);
  const floor = s.floor_price == null ? 1 : s.floor_price;
  const ceil = s.ceil_price == null ? 1e9 : s.ceil_price;
  return Math.max(floor, Math.min(ceil, px));
}

// 跑一個 tick：所有股票結算一根 K 棒
function runTick(gid, ts) {
  const c = cfg(gid);
  const list = symbols(gid);
  if (!list.length) return [];

  // 這個 tick 落在「新聞時段內」的新聞都套用（12–15 的每個整點都朝設定方向動，不是只跳一次）
  const news = db.prepare(
    'SELECT * FROM market_news WHERE guild_id=? AND applied=1 AND effect_ts>0 AND effect_ts<=? AND (effect_ts + duration_h*3600000) > ? ORDER BY id'
  ).all(gid, ts, ts);
  const fxBySymbol = new Map();
  let newsId = 0;
  for (const n of news) {
    let arr = [];
    try { arr = JSON.parse(n.stock_fx || '[]'); } catch { arr = []; }
    for (const f of arr) {
      if (!f || !f.symbol_id) continue;
      const cur = fxBySymbol.get(f.symbol_id) || { impact_pct: 0, vol_mult: 100 };
      cur.impact_pct += Number(f.impact_pct || 0);
      cur.vol_mult = Math.max(cur.vol_mult, Number(f.vol_mult || 100));
      fxBySymbol.set(f.symbol_id, cur);
      newsId = n.id;
    }
  }

  const insPx = db.prepare(
    'INSERT OR IGNORE INTO stock_prices (guild_id,symbol_id,ts,open,high,low,close,volume,news_id) VALUES (?,?,?,?,?,?,?,?,?)');
  const updS = db.prepare('UPDATE stock_symbols SET price=? WHERE id=?');
  const out = [];

  db.transaction(() => {
    for (const s of list) {
      const fx = fxBySymbol.get(s.id);
      const open = s.price;
      const close = nextPrice(c, s, fx);
      // high/low 只是視覺用，不影響成交
      const spread = Math.max(1, Math.round(Math.abs(close - open) * 0.4 + Math.abs(open) * (s.vol_pct / 100) * 0.3));
      const high = Math.max(open, close) + Math.round(Math.abs(gauss()) * spread * 0.5);
      const low = Math.min(open, close) - Math.round(Math.abs(gauss()) * spread * 0.5);
      insPx.run(gid, s.id, ts, open, high, low, close, 0, fx ? newsId : 0);
      updS.run(close, s.id);
      out.push({ ...s, open, close });
    }
    // 新聞在「時段內」每次結算都套用（漲跌持續整個時段），不再標記一次性完成
    db.prepare('UPDATE market_config SET last_tick_ms=? WHERE guild_id=?').run(ts, gid);
  })();
  return out;
}

// 補齊漏掉的 tick：機器人重啟過就會斷檔，K 線不能有洞
function catchUp(gid) {
  const c = cfg(gid);
  if (!c.stock_enabled) return 0;
  const step = Math.max(1, c.tick_minutes || 60) * 60000;
  const now = alignDown(Date.now(), step);
  let last = c.last_tick_ms || 0;
  if (!last) {
    const row = db.prepare('SELECT MAX(ts) t FROM stock_prices WHERE guild_id=?').get(gid);
    last = row?.t || now - step;
  }
  let n = 0;
  // 一次最多補 240 根（10 天），停太久就不要補到天荒地老
  for (let ts = last + step; ts <= now && n < 240; ts += step) { runTick(gid, ts); n++; }
  return n;
}

// ================== K 線（純文字）==================
const BARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
function sparkline(closes) {
  if (!closes.length) return '—';
  const lo = Math.min(...closes), hi = Math.max(...closes);
  if (hi === lo) return BARS[3].repeat(closes.length);
  return closes.map(v => BARS[Math.round(((v - lo) / (hi - lo)) * 7)]).join('');
}

const history = (gid, symbolId, n = 24) =>
  db.prepare('SELECT * FROM stock_prices WHERE guild_id=? AND symbol_id=? ORDER BY ts DESC LIMIT ?')
    .all(gid, symbolId, n).reverse();

// 這一盤的漲跌：開盤 → 現價
function changeOf(gid, s) {
  const h = history(gid, s.id, 2);
  const prev = h.length ? h[h.length - 1].open : s.price;
  const d = s.price - prev;
  // 股價可以是 0 或負數，這種時候百分比沒有意義（40 跌到 -20 不是「跌 150%」），只報金額
  const p = prev > 0 && s.price > 0 ? (d / prev) * 100 : null;
  return { d, p };
}
const arrow = (d) => (d > 0 ? '▲' : d < 0 ? '▼' : '－');
const sign = (n) => `${n > 0 ? '+' : ''}${num(n)}`;
// 「本盤」講明白：使用者只在整點後看一眼，很容易把它當成「跟我上次看到的價比」
const chgStr = ({ d, p }) => `${arrow(d)} ${sign(d)}${p == null ? '' : `（${p > 0 ? '+' : ''}${p.toFixed(1)}%）`}`;

// ================== 錢包 / 持股 ==================
function wallet(gid, uid, username) {
  let w = db.prepare('SELECT * FROM econ_wallets WHERE guild_id=? AND user_id=?').get(gid, uid);
  if (!w) {
    db.prepare('INSERT INTO econ_wallets (guild_id,user_id,username,coins) VALUES (?,?,?,0)').run(gid, uid, username || '');
    w = db.prepare('SELECT * FROM econ_wallets WHERE guild_id=? AND user_id=?').get(gid, uid);
  }
  return w;
}
const holding = (gid, uid, sid) =>
  db.prepare('SELECT * FROM stock_holdings WHERE guild_id=? AND user_id=? AND symbol_id=?').get(gid, uid, sid)
  || { shares: 0, cost_sum: 0, realized: 0 };
// 持股上限算「所有股票加總」，不是每支各算一份
const totalShares = (gid, uid) =>
  db.prepare('SELECT COALESCE(SUM(shares),0) n FROM stock_holdings WHERE guild_id=? AND user_id=? AND shares>0').get(gid, uid).n;

// 交易冷卻與每日次數
function checkRate(gid, uid, c) {
  const st = db.prepare('SELECT * FROM stock_user_state WHERE guild_id=? AND user_id=?').get(gid, uid)
    || { last_trade_ms: 0, day_key: '', day_trades: 0 };
  const now = Date.now();
  const cd = (c.trade_cooldown_s || 0) * 1000;
  if (cd && now - st.last_trade_ms < cd) {
    return { error: `冷靜一下：<t:${Math.ceil((st.last_trade_ms + cd) / 1000)}:R> 才能再交易。` };
  }
  const day = localToday();
  const used = st.day_key === day ? st.day_trades : 0;
  if (c.daily_trade_limit > 0 && used >= c.daily_trade_limit) {
    return { error: `今天的交易次數用完了（上限 ${c.daily_trade_limit} 次），明天再來。` };
  }
  return { ok: true, day, used };
}
function bumpRate(gid, uid, day, used) {
  db.prepare(
    `INSERT INTO stock_user_state (guild_id,user_id,last_trade_ms,day_key,day_trades) VALUES (?,?,?,?,?)
     ON CONFLICT(guild_id,user_id) DO UPDATE SET last_trade_ms=excluded.last_trade_ms,
       day_key=excluded.day_key, day_trades=excluded.day_trades`
  ).run(gid, uid, Date.now(), day, used + 1);
}

// ---- 買 ----
function buy(gid, uid, username, key, shares) {
  const c = cfg(gid);
  if (!c.stock_enabled) return { error: '股市目前沒有開放。' };
  const s = symbolByKey(gid, key);
  if (!s) return { error: `找不到「${key}」這支股，用 \`/股市\` 看代號。` };
  shares = Math.floor(shares);
  if (!(shares >= (c.min_trade || 1))) return { error: `一次最少買 ${c.min_trade || 1} 股。` };
  if (c.max_trade > 0 && shares > c.max_trade) return { error: `一次最多買 ${c.max_trade} 股。` };

  const rate = checkRate(gid, uid, c);
  if (rate.error) return { error: rate.error };

  const gc = gcfg(gid);
  const h = holding(gid, uid, s.id);
  const owned = totalShares(gid, uid);
  if (c.max_shares > 0 && owned + shares > c.max_shares) {
    return { error: `每人所有股票加總最多持有 ${num(c.max_shares)} 股，你目前總共有 ${num(owned)} 股，還能再買 ${num(Math.max(0, c.max_shares - owned))} 股。` };
  }
  // 股價可能跌成 0 或負數，這種狀態禁止買進（否則買股票反而會拿到錢）
  if (s.price <= 0) return { error: `${s.name} 現價 ${num(s.price)}，已經跌到零以下，暫停買進。` };
  const cost = s.price * shares;
  const fee = Math.ceil(cost * (c.fee_pct || 0) / 100);
  const w = wallet(gid, uid, username);
  if (w.coins < cost + fee) {
    return { error: `${gc.currency_name || '星幣'}不夠：需要 ${num(cost + fee)}（含交易稅 ${num(fee)}），你只有 ${num(w.coins)}。` };
  }

  db.transaction(() => {
    db.prepare('UPDATE econ_wallets SET coins = coins - ? WHERE guild_id=? AND user_id=?').run(cost + fee, gid, uid);
    db.prepare(
      `INSERT INTO stock_holdings (guild_id,user_id,symbol_id,shares,cost_sum) VALUES (?,?,?,?,?)
       ON CONFLICT(guild_id,user_id,symbol_id) DO UPDATE SET shares=shares+excluded.shares, cost_sum=cost_sum+excluded.cost_sum`
    ).run(gid, uid, s.id, shares, cost + fee);
    db.prepare('INSERT INTO stock_trades (guild_id,user_id,username,symbol_id,side,shares,price,fee,pnl,ts) VALUES (?,?,?,?,\'buy\',?,?,?,0,?)')
      .run(gid, uid, username || '', s.id, shares, s.price, fee, Date.now());
    db.prepare('UPDATE stock_prices SET volume = volume + ? WHERE guild_id=? AND symbol_id=? AND ts=(SELECT MAX(ts) FROM stock_prices WHERE guild_id=? AND symbol_id=?)')
      .run(shares, gid, s.id, gid, s.id);
    // 交易稅直接銷毀（不進任何人口袋）＝ 星幣回收
    db.prepare('UPDATE market_config SET burned_total = burned_total + ? WHERE guild_id=?').run(fee, gid);
    bumpRate(gid, uid, rate.day, rate.used);
  })();

  const nh = holding(gid, uid, s.id);
  return {
    embed: new EmbedBuilder().setColor(UP).setTitle('📥 買進成交')
      .setDescription(`${s.emoji} **${s.name}** \`${s.code}\`\n成交 **${num(shares)}** 股 × ${num(s.price)}`)
      .addFields(
        { name: '總支出', value: `${num(cost + fee)}（交易稅 ${num(fee)}）`, inline: true },
        { name: '持有', value: `${num(nh.shares)} 股`, inline: true },
        { name: '餘額', value: num(wallet(gid, uid).coins), inline: true })
  };
}

// ---- 賣 ----
function sell(gid, uid, username, key, sharesRaw) {
  const c = cfg(gid);
  if (!c.stock_enabled) return { error: '股市目前沒有開放。' };
  const s = symbolByKey(gid, key);
  if (!s) return { error: `找不到「${key}」這支股，用 \`/股市\` 看代號。` };

  const h = holding(gid, uid, s.id);
  if (h.shares <= 0) return { error: `你沒有 ${s.emoji}${s.name} 的持股。` };

  let shares = String(sharesRaw).trim() === '全部' ? h.shares : Math.floor(Number(sharesRaw));
  if (!(shares > 0)) return { error: '股數要是正整數，或填「全部」。' };
  if (shares > h.shares) return { error: `你只有 ${num(h.shares)} 股。` };
  if (c.max_trade > 0 && shares > c.max_trade) return { error: `一次最多賣 ${c.max_trade} 股。` };

  const rate = checkRate(gid, uid, c);
  if (rate.error) return { error: rate.error };

  // 負股價時賣出＝真的背負債：gross 是負數，會從錢包倒扣（餘額可以變負）
  const gross = s.price * shares;
  // 交易稅只對「有收到錢」的部分抽，賠錢出場不再多抽一筆
  const fee = Math.ceil(Math.max(0, gross) * (c.fee_pct || 0) / 100);
  const net = gross - fee;
  const avg = h.shares > 0 ? h.cost_sum / h.shares : 0;
  const costPart = Math.round(avg * shares);
  const pnl = net - costPart;

  db.transaction(() => {
    // 賣股的實收也算收入（total_earned），才不會讓「本期收入」漏掉股市這一大塊
    db.prepare('UPDATE econ_wallets SET coins = coins + ?, total_earned = total_earned + ? WHERE guild_id=? AND user_id=?')
      .run(net, Math.max(0, net), gid, uid);
    if (shares === h.shares) {
      db.prepare('UPDATE stock_holdings SET shares=0, cost_sum=0, realized=realized+? WHERE guild_id=? AND user_id=? AND symbol_id=?')
        .run(pnl, gid, uid, s.id);
    } else {
      db.prepare('UPDATE stock_holdings SET shares=shares-?, cost_sum=cost_sum-?, realized=realized+? WHERE guild_id=? AND user_id=? AND symbol_id=?')
        .run(shares, costPart, pnl, gid, uid, s.id);
    }
    db.prepare('INSERT INTO stock_trades (guild_id,user_id,username,symbol_id,side,shares,price,fee,pnl,ts) VALUES (?,?,?,?,\'sell\',?,?,?,?,?)')
      .run(gid, uid, username || '', s.id, shares, s.price, fee, pnl, Date.now());
    db.prepare('UPDATE stock_prices SET volume = volume + ? WHERE guild_id=? AND symbol_id=? AND ts=(SELECT MAX(ts) FROM stock_prices WHERE guild_id=? AND symbol_id=?)')
      .run(shares, gid, s.id, gid, s.id);
    db.prepare('UPDATE market_config SET burned_total = burned_total + ? WHERE guild_id=?').run(fee, gid);
    bumpRate(gid, uid, rate.day, rate.used);
  })();

  return {
    embed: new EmbedBuilder().setColor(pnl >= 0 ? UP : DOWN).setTitle('📤 賣出成交')
      .setDescription(`${s.emoji} **${s.name}** \`${s.code}\`\n賣出 **${num(shares)}** 股 × ${num(s.price)}`
        + (net < 0 ? `\n⚠️ 這是負股價，出清要**倒賠 ${num(-net)}**` : ''))
      .addFields(
        { name: net < 0 ? '倒扣' : '實收', value: `${num(net)}（交易稅 ${num(fee)}）`, inline: true },
        { name: '這筆損益', value: `${pnl >= 0 ? '📈 +' : '📉 '}${num(pnl)}`, inline: true },
        { name: '餘額', value: num(wallet(gid, uid).coins), inline: true })
  };
}


// ================== 強制清算 ==================
//
// 玩家發現的漏洞：負股價的股票「不賣就不用認賠」，於是明明有錢也故意卡著不處理，
// 那筆負部位就變成沒有成本的死當，回收機制形同虛設；持股上限也一樣，
// 買進時會擋，但既有超額部位放著不動就永遠不用降下來。
//
// 規則：偵測到違規就開始計時 → 到期前幾天私訊警告 → 寬限期滿由系統直接代為賣出。
//   negative：整筆出清，虧損從錢包倒扣（餘額可為負，跟自己賣是一樣的結果）
//   over limit：只賣掉超出的部分，從「現價最高的」開始賣（讓玩家保留最想留的低價股…
//               不，反過來：先賣現價最高的最不痛，因為那是最容易回補的流動部位）
const DAY_MS = 86400000;

function violationRow(gid, uid, kind, symbolId = 0) {
  let row = db.prepare('SELECT * FROM stock_violations WHERE guild_id=? AND user_id=? AND kind=? AND symbol_id=?')
    .get(gid, uid, kind, symbolId);
  if (!row) {
    db.prepare('INSERT INTO stock_violations (guild_id,user_id,kind,symbol_id,since_ms) VALUES (?,?,?,?,?)')
      .run(gid, uid, kind, symbolId, Date.now());
    row = db.prepare('SELECT * FROM stock_violations WHERE guild_id=? AND user_id=? AND kind=? AND symbol_id=?')
      .get(gid, uid, kind, symbolId);
  }
  return row;
}
const clearViolation = (gid, uid, kind, symbolId = 0) =>
  db.prepare('DELETE FROM stock_violations WHERE guild_id=? AND user_id=? AND kind=? AND symbol_id=?')
    .run(gid, uid, kind, symbolId);

/** 系統代為賣出（不受單次上限、冷卻、每日次數限制 —— 這是強制執行，不是玩家操作） */
function forceSell(gid, uid, username, symbolId, shares) {
  const s = db.prepare('SELECT * FROM stock_symbols WHERE id=? AND guild_id=?').get(symbolId, gid);
  const h = db.prepare('SELECT * FROM stock_holdings WHERE guild_id=? AND user_id=? AND symbol_id=?').get(gid, uid, symbolId);
  if (!s || !h || h.shares <= 0) return null;
  const c = cfg(gid);
  const n = Math.min(shares, h.shares);
  const gross = s.price * n;
  const fee = Math.ceil(Math.max(0, gross) * (c.fee_pct || 0) / 100);
  const net = gross - fee;
  const avg = h.shares > 0 ? h.cost_sum / h.shares : 0;
  const costPart = Math.round(avg * n);
  const pnl = net - costPart;
  db.transaction(() => {
    db.prepare('UPDATE econ_wallets SET coins = coins + ?, total_earned = total_earned + ? WHERE guild_id=? AND user_id=?')
      .run(net, Math.max(0, net), gid, uid);
    if (n >= h.shares) {
      db.prepare('UPDATE stock_holdings SET shares=0, cost_sum=0, realized=realized+? WHERE guild_id=? AND user_id=? AND symbol_id=?')
        .run(pnl, gid, uid, symbolId);
    } else {
      db.prepare('UPDATE stock_holdings SET shares=shares-?, cost_sum=cost_sum-?, realized=realized+? WHERE guild_id=? AND user_id=? AND symbol_id=?')
        .run(n, costPart, pnl, gid, uid, symbolId);
    }
    db.prepare("INSERT INTO stock_trades (guild_id,user_id,username,symbol_id,side,shares,price,fee,pnl,ts) VALUES (?,?,?,?,'sell',?,?,?,?,?)")
      .run(gid, uid, username || '', symbolId, n, s.price, fee, pnl, Date.now());
    db.prepare('UPDATE market_config SET burned_total = burned_total + ? WHERE guild_id=?').run(fee, gid);
  })();
  return { symbol: s, shares: n, net, fee, pnl };
}

async function dm(client, uid, content) {
  try { const u = await client.users.fetch(uid); await u.send(content); } catch { /* 關私訊就算了 */ }
}

/**
 * 每天跑一次：檢查所有人的負股價持股與超額持股，該警告的警告、該強制賣的賣。
 * 只在股市開著、且 force_sell_enabled 時執行。
 */
async function enforceHoldings(client, gid) {
  const c = cfg(gid);
  if (!c.stock_enabled || !c.force_sell_enabled) return;
  const now = Date.now();
  const negDays = Math.max(1, c.force_neg_days || 7);
  const overDays = Math.max(1, c.force_over_days || 7);
  const warnDays = Math.max(0, c.force_warn_days || 2);

  // ---- ① 負股價持股 ----
  const negHoldings = db.prepare(
    `SELECT h.user_id, h.shares, h.symbol_id, s.name, s.emoji, s.price
       FROM stock_holdings h JOIN stock_symbols s ON s.id = h.symbol_id
      WHERE h.guild_id=? AND h.shares > 0 AND s.price <= 0`).all(gid);
  const stillNeg = new Set();
  for (const h of negHoldings) {
    stillNeg.add(`${h.user_id}:${h.symbol_id}`);
    const v = violationRow(gid, h.user_id, 'neg', h.symbol_id);
    const dueMs = v.since_ms + negDays * DAY_MS;
    const uname = (db.prepare('SELECT username FROM econ_wallets WHERE guild_id=? AND user_id=?').get(gid, h.user_id) || {}).username || '';
    if (now >= dueMs) {
      const r = forceSell(gid, h.user_id, uname, h.symbol_id, h.shares);
      clearViolation(gid, h.user_id, 'neg', h.symbol_id);
      if (r) await dm(client, h.user_id,
        `⚖️ **強制清算通知**\n你持有的 ${r.symbol.emoji || ''}**${r.symbol.name}** 已經是負股價超過 ${negDays} 天，`
        + `系統依規定代為出清 **${r.shares}** 股。\n`
        + `${r.net < 0 ? `已從你的錢包倒扣 **${num(-r.net)}**（餘額可能變負數，去 \`/貸款\` 或多賺一點補回來）。` : `入帳 **${num(r.net)}**。`}\n`
        + `負股價的部位不能無限期放著不處理 —— 下次記得早點停損。`);
    } else if (warnDays > 0 && now >= dueMs - warnDays * DAY_MS && now - v.warned_ms > DAY_MS) {
      db.prepare('UPDATE stock_violations SET warned_ms=? WHERE guild_id=? AND user_id=? AND kind=? AND symbol_id=?')
        .run(now, gid, h.user_id, 'neg', h.symbol_id);
      await dm(client, h.user_id,
        `⚠️ **負股價持股即將被強制清算**\n${h.emoji || ''}**${h.name}** 現價 ${num(h.price)}，你還有 **${num(h.shares)}** 股。\n`
        + `<t:${Math.floor(dueMs / 1000)}:R> 系統就會代為賣出並從錢包倒扣。要自己處理請用 \`/賣股\`。`);
    }
  }
  // 已經不是負股價（或已賣掉）的就把觀察紀錄清掉，計時重來
  for (const v of db.prepare("SELECT * FROM stock_violations WHERE guild_id=? AND kind='neg'").all(gid)) {
    if (!stillNeg.has(`${v.user_id}:${v.symbol_id}`)) clearViolation(gid, v.user_id, 'neg', v.symbol_id);
  }

  // ---- ② 總持股超過上限 ----
  if (!(c.max_shares > 0)) {
    db.prepare("DELETE FROM stock_violations WHERE guild_id=? AND kind='over'").run(gid);
    return;
  }
  const totals = db.prepare(
    'SELECT user_id, SUM(shares) total FROM stock_holdings WHERE guild_id=? GROUP BY user_id HAVING total > ?')
    .all(gid, c.max_shares);
  const stillOver = new Set(totals.map(t => t.user_id));
  for (const t of totals) {
    const v = violationRow(gid, t.user_id, 'over', 0);
    const dueMs = v.since_ms + overDays * DAY_MS;
    const uname = (db.prepare('SELECT username FROM econ_wallets WHERE guild_id=? AND user_id=?').get(gid, t.user_id) || {}).username || '';
    const excess = t.total - c.max_shares;
    if (now >= dueMs) {
      // 從現價最高的開始賣：那是最容易再買回來的部位，而且賣掉最不虧
      let left = excess;
      const mine = db.prepare(
        `SELECT h.symbol_id, h.shares, s.price, s.name, s.emoji FROM stock_holdings h
           JOIN stock_symbols s ON s.id=h.symbol_id
          WHERE h.guild_id=? AND h.user_id=? AND h.shares>0 ORDER BY s.price DESC`).all(gid, t.user_id);
      const sold = [];
      for (const m of mine) {
        if (left <= 0) break;
        const n = Math.min(left, m.shares);
        const r = forceSell(gid, t.user_id, uname, m.symbol_id, n);
        if (r) { sold.push(r); left -= n; }
      }
      clearViolation(gid, t.user_id, 'over', 0);
      if (sold.length) await dm(client, t.user_id,
        `⚖️ **持股上限強制減碼**\n你的總持股 ${num(t.total)} 股超過上限 ${num(c.max_shares)} 股已超過 ${overDays} 天，`
        + `系統代為賣出 **${num(excess)}** 股：\n`
        + sold.map(r => `　${r.symbol.emoji || ''}${r.symbol.name} ${num(r.shares)} 股 → ${num(r.net)}`).join('\n'));
    } else if (warnDays > 0 && now >= dueMs - warnDays * DAY_MS && now - v.warned_ms > DAY_MS) {
      db.prepare("UPDATE stock_violations SET warned_ms=? WHERE guild_id=? AND user_id=? AND kind='over' AND symbol_id=0")
        .run(now, gid, t.user_id);
      await dm(client, t.user_id,
        `⚠️ **持股超過上限**\n你目前總共 **${num(t.total)}** 股，上限是 ${num(c.max_shares)} 股。\n`
        + `<t:${Math.floor(dueMs / 1000)}:R> 之前沒有自己降到上限以內，系統會代為賣出超出的 **${num(excess)}** 股。`);
    }
  }
  for (const v of db.prepare("SELECT * FROM stock_violations WHERE guild_id=? AND kind='over'").all(gid)) {
    if (!stillOver.has(v.user_id)) clearViolation(gid, v.user_id, 'over', 0);
  }
}

// ================== 畫面 ==================
function marketEmbed(gid) {
  const c = cfg(gid);
  const list = symbols(gid);
  if (!list.length) return new EmbedBuilder().setColor(brandColor()).setTitle('📈 星幣股市').setDescription('目前沒有掛牌的股票。');
  const lines = list.map(s => {
    const chg = changeOf(gid, s);
    const h = history(gid, s.id, 24).map(r => r.close);
    return `\`${s.code}\` ${s.emoji} **${s.name}**　**${num(s.price)}** ${chgStr(chg)}\n\`${sparkline(h)}\``;
  });
  const step = Math.max(1, c.tick_minutes || 60) * 60000;
  const next = alignDown(Date.now(), step) + step;
  return new EmbedBuilder().setColor(brandColor())
    .setTitle('📈 星幣股市')
    .setDescription(lines.join('\n'))
    .setFooter({ text: `下次結算 ${new Date(next).toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit' })}　交易稅 ${c.fee_pct}%　漲跌停 ±${c.limit_pct}%` });
}

function symbolEmbed(gid, uid, s) {
  const chg = changeOf(gid, s);
  const h = history(gid, s.id, 24);
  const closes = h.map(r => r.close);
  const hold = holding(gid, uid, s.id);
  const e = new EmbedBuilder().setColor(chg.d >= 0 ? UP : DOWN)
    .setTitle(`${s.emoji} ${s.name}　\`${s.code}\``)
    .setDescription(`**${num(s.price)}** ${chgStr(chg)}　本盤\n\`${sparkline(closes)}\`　近 ${closes.length} 盤`);
  if (closes.length) {
    e.addFields({ name: '近期', value: `高 ${num(Math.max(...h.map(r => r.high)))}　低 ${num(Math.min(...h.map(r => r.low)))}　量 ${num(h.reduce((a, r) => a + r.volume, 0))}`, inline: false });
  }
  if (hold.shares > 0) {
    const avg = hold.cost_sum / hold.shares;
    const val = s.price * hold.shares;
    const upnl = Math.round(val - hold.cost_sum);
    e.addFields({
      name: '你的持股',
      value: `${num(hold.shares)} 股　均價 ${avg.toFixed(1)}　市值 ${num(val)}\n未實現損益 ${upnl >= 0 ? '📈 +' : '📉 '}${num(upnl)}`,
      inline: false
    });
  }
  if (s.description) e.setFooter({ text: s.description });
  return e;
}

function portfolioEmbed(gid, uid, username) {
  const rows = db.prepare(
    `SELECT h.*, s.code, s.name, s.emoji, s.price FROM stock_holdings h
       JOIN stock_symbols s ON s.id=h.symbol_id
      WHERE h.guild_id=? AND h.user_id=? AND h.shares>0 ORDER BY s.sort, s.id`
  ).all(gid, uid);
  const realized = db.prepare('SELECT COALESCE(SUM(realized),0) r FROM stock_holdings WHERE guild_id=? AND user_id=?').get(gid, uid).r;
  const w = wallet(gid, uid, username);
  if (!rows.length) {
    return new EmbedBuilder().setColor(brandColor()).setTitle('💼 我的持股')
      .setDescription(`目前沒有持股。\n用 \`/股市\` 看行情，\`/買股 <代號> <股數>\` 進場。`)
      .setFooter({ text: `餘額 ${num(w.coins)}　已實現損益 ${num(realized)}` });
  }
  let val = 0, cost = 0;
  const lines = rows.map(r => {
    const v = r.price * r.shares;
    val += v; cost += r.cost_sum;
    const pnl = Math.round(v - r.cost_sum);
    return `\`${r.code}\` ${r.emoji} **${r.name}**　${num(r.shares)} 股\n　均價 ${(r.cost_sum / r.shares).toFixed(1)}　現價 ${num(r.price)}　市值 ${num(v)}　${pnl >= 0 ? '📈 +' : '📉 '}${num(pnl)}`;
  });
  const total = Math.round(val - cost);
  return new EmbedBuilder().setColor(total >= 0 ? UP : DOWN).setTitle('💼 我的持股')
    .setDescription(lines.join('\n'))
    .addFields(
      { name: '總市值', value: num(val), inline: true },
      { name: '未實現損益', value: `${total >= 0 ? '+' : ''}${num(total)}`, inline: true },
      { name: '已實現損益', value: `${realized >= 0 ? '+' : ''}${num(realized)}`, inline: true })
    .setFooter({ text: `餘額 ${num(w.coins)}` });
}

function leaderboardEmbed(gid) {
  const rows = db.prepare(
    `SELECT h.user_id,
            COALESCE(SUM(h.realized),0) realized,
            COALESCE(SUM(h.shares * s.price - h.cost_sum),0) unreal
       FROM stock_holdings h JOIN stock_symbols s ON s.id=h.symbol_id
      WHERE h.guild_id=? GROUP BY h.user_id`
  ).all(gid);
  const named = rows.map(r => {
    const w = db.prepare('SELECT username FROM econ_wallets WHERE guild_id=? AND user_id=?').get(gid, r.user_id);
    return { name: w?.username || r.user_id, total: Math.round(r.realized + r.unreal) };
  }).sort((a, b) => b.total - a.total).slice(0, 10);
  const medal = ['🥇', '🥈', '🥉'];
  return new EmbedBuilder().setColor(brandColor()).setTitle('🏆 股神榜')
    .setDescription(named.length
      ? named.map((r, i) => `${medal[i] || `${i + 1}.`} **${r.name}**　${r.total >= 0 ? '+' : ''}${num(r.total)}`).join('\n')
      : '還沒有人交易過。')
    .setFooter({ text: '已實現損益 ＋ 未實現損益' });
}

// /行情：目前生效中的新聞倍率
function quotesEmbed(gid) {
  const c = cfg(gid);
  if (!c.enabled) {
    return new EmbedBuilder().setColor(brandColor()).setTitle('📰 行情')
      .setDescription('目前沒有開放財經新聞，物價都是固定的。');
  }
  const mods = activeModifiers(gid);
  if (!mods.length) {
    return new EmbedBuilder().setColor(brandColor()).setTitle('📰 行情')
      .setDescription('市場平靜，目前所有物品都是正常價格。');
  }
  const lines = mods.map(m => {
    const mult = (m.mult_pct || 100) / 100;
    let what = SCOPE_LABEL[m.scope] || m.scope;
    if (m.scope === 'item') {
      const it = db.prepare('SELECT name, emoji FROM gather_items WHERE id=?').get(m.scope_key);
      what = it ? `${it.emoji || ''}${it.name}` : `#${m.scope_key}`;
    } else if (m.scope === 'kind') {
      what = { fish: '🎣 釣魚', mine: '⛏️ 挖礦', wood: '🪓 伐木', forage: '🧺 採集', hunt: '🏹 狩獵', farm: '🥚 農牧產物' }[m.scope_key] || m.scope_key;
    }
    return `${mult > 1 ? '📈' : '📉'} ${what}　賣價 **×${mult.toFixed(2)}**${m.label ? `\n　　_${m.label}_` : ''}`;
  });
  return new EmbedBuilder().setColor(brandColor()).setTitle('📰 目前行情')
    .setDescription(lines.join('\n'))
    .setFooter({ text: '倍率只影響賣出價格，買東西的價格不變' });
}

// 玩家在面板點「📰新聞」看到的：最近已生效／排程中的財經新聞（不用靠頻道公告）
function newsEmbed(gid) {
  const now = Date.now();
  // 只給玩家看「正在生效中」的新聞：已觸發(applied=1) 且 時段還沒結束；排程中/已結束的都不顯示
  const rows = db.prepare('SELECT * FROM market_news WHERE guild_id=? AND applied=1 ORDER BY effect_ts DESC, id DESC LIMIT 20').all(gid)
    .filter(n => (n.effect_ts || 0) + Math.max(1, n.duration_h || 6) * 3600000 > now).slice(0, 6);
  const embed = new EmbedBuilder().setColor(brandColor()).setTitle('📰 財經新聞');
  if (!rows.length) return embed.setDescription('目前沒有財經新聞，市場一片平靜。');
  // 只給玩家看標題與劇情內文，不顯示實際漲跌數字（避免玩家照著新聞去買賣套利）
  for (const n of rows.slice(0, 6)) {
    embed.addFields({ name: n.headline.slice(0, 250), value: (n.body || '　').slice(0, 1024) });
  }
  return embed.setFooter({ text: '📰 璃白Yu財經 · 最新市場動態' });
}

// ================== 新聞發布（後台建立 → 機器人發到頻道）==================
function applyNews(client, gid) {
  const c = cfg(gid);
  if (!c.enabled && !c.stock_enabled) return;
  const now = Date.now();
  const pending = db.prepare(
    'SELECT * FROM market_news WHERE guild_id=? AND applied=0 AND (effect_ts=0 OR effect_ts<=?) ORDER BY id'
  ).all(gid, now);

  for (const n of pending) {
    let effects = [];
    try { effects = JSON.parse(n.effects || '[]'); } catch { effects = []; }
    const start = n.effect_ts || now;
    const end = start + Math.max(1, n.duration_h || 6) * 3600000;
    db.transaction(() => {
      if (c.enabled) {
        const ins = db.prepare(
          'INSERT INTO market_modifiers (guild_id,news_id,scope,scope_key,mult_pct,start_ts,end_ts,label) VALUES (?,?,?,?,?,?,?,?)');
        for (const e of effects) {
          if (!e || !e.scope) continue;
          const mp = normMultPct(e.mult_pct);
          ins.run(gid, n.id, e.scope, String(e.scope_key || ''), mp, start, end, n.headline);
        }
      }
      db.prepare('UPDATE market_news SET applied=1, effect_ts=? WHERE id=?').run(start, n.id);
    })();
    bust(gid);
    announce(client, gid, n, effects, end).catch(() => {});
  }
}

async function announce(client, gid, n, effects, end) {
  const c = cfg(gid);
  if (n.announced || !c.news_channel) return;
  const ch = await client.channels.fetch(c.news_channel).catch(() => null);
  if (!ch) return;

  const fx = [];
  if (c.enabled) {
    for (const e of effects) {
      const mult = normMultPct(e.mult_pct) / 100;
      let what = SCOPE_LABEL[e.scope] || e.scope;
      if (e.scope === 'item') {
        const it = db.prepare('SELECT name, emoji FROM gather_items WHERE id=?').get(e.scope_key);
        if (it) what = `${it.emoji || ''}${it.name}`;
      } else if (e.scope === 'kind') {
        what = { fish: '🎣 釣魚', mine: '⛏️ 挖礦', wood: '🪓 伐木', forage: '🧺 採集', hunt: '🏹 狩獵', farm: '🥚 農牧產物' }[e.scope_key] || e.scope_key;
      }
      const pct = Math.round((mult - 1) * 100);
      fx.push(`　${mult > 1 ? '📈' : '📉'} ${what}　賣價 ${pct >= 0 ? '+' : ''}${pct}%（×${mult.toFixed(2)}）`);
    }
  }
  if (c.stock_enabled) {
    let arr = [];
    try { arr = JSON.parse(n.stock_fx || '[]'); } catch { arr = []; }
    for (const f of arr) {
      const s = db.prepare('SELECT code,name,emoji FROM stock_symbols WHERE id=?').get(f.symbol_id);
      if (!s) continue;
      const imp = Number(f.impact_pct || 0);
      fx.push(`　${imp >= 0 ? '📈' : '📉'} ${s.emoji}${s.name} \`${s.code}\`　下一盤 ${imp >= 0 ? '+' : ''}${imp}%`);
    }
  }

  const e = new EmbedBuilder().setColor(brandColor())
    .setTitle(`📰 ${n.headline}`)
    .setDescription(n.body || '　');
  if (fx.length) e.addFields({ name: '影響', value: fx.join('\n') });
  if (n.image_url) e.setImage(n.image_url);
  e.setFooter({ text: '輸入 /行情 查看目前價格' });

  await ch.send({ embeds: [e] }).catch(() => {});
  db.prepare('UPDATE market_news SET announced=1 WHERE id=?').run(n.id);
}

// ================== 指令 ==================
const CMDS = ['股市', '個股', '買股', '賣股', '持股', '股神榜', '行情'];

function channelOk(gid, chId) {
  const list = csv(cfg(gid).channels);
  return !list.length || list.includes(chId);
}

function init(client) {
  for (const [gid] of client.guilds.cache) {
    try { cfg(gid); seedGuild(gid); catchUp(gid); } catch (e) { logError(gid, '股市初始化失敗：', e.message); }
  }

  client.on('interactionCreate', async (i) => {
    try {
      // ---- 按鈕 / 選單 ----
      if (i.isButton() && i.customId.startsWith('stk:')) {
        const [, act, key] = i.customId.split(':');
        if (act === 'market') return i.reply({ embeds: [marketEmbed(i.guildId)], flags: MessageFlags.Ephemeral });
        if (act === 'quotes') return i.reply({ embeds: [quotesEmbed(i.guildId)], flags: MessageFlags.Ephemeral });
        if (act === 'news') return i.reply({ embeds: [newsEmbed(i.guildId)], flags: MessageFlags.Ephemeral });
        if (act === 'mine') return i.reply({ embeds: [portfolioEmbed(i.guildId, i.user.id, i.user.username)], flags: MessageFlags.Ephemeral });
        if (act === 'chart') {
          const s = symbolByKey(i.guildId, key);
          if (!s) return i.reply({ content: '找不到這支股。', flags: MessageFlags.Ephemeral });
          return i.reply({ embeds: [symbolEmbed(i.guildId, i.user.id, s)], flags: MessageFlags.Ephemeral });
        }
        // 買股：選股票（點選買賣，不用打指令）
        if (act === 'buymenu') {
          const gid = i.guildId, c = cfg(gid);
          if (!c.stock_enabled) return i.reply({ content: '股市目前沒有開放。', flags: MessageFlags.Ephemeral });
          const list = symbols(gid);
          if (!list.length) return i.reply({ content: '目前沒有掛牌股票。', flags: MessageFlags.Ephemeral });
          const rows = [];
          for (let p = 0; p < list.length && rows.length < 5; p += 25) {
            const slice = list.slice(p, p + 25);
            rows.push(new ActionRowBuilder().addComponents(
              new StringSelectMenuBuilder().setCustomId(`stk:buypick:${p / 25}`)
                .setPlaceholder(list.length > 25 ? `選要買的股票（${p + 1}-${p + slice.length}）` : '選要買的股票')
                .setMinValues(1).setMaxValues(1)
                .addOptions(slice.map(s => ({ label: `${s.code} ${s.name}`.slice(0, 100), description: `現價 ${num(s.price)}`.slice(0, 100), value: s.code, emoji: selEmoji(s.emoji) })))));
          }
          return i.reply({ content: '要買哪支股？', components: rows, flags: MessageFlags.Ephemeral });
        }
        // 賣股：選你持有的股票
        if (act === 'sellmenu') {
          const gid = i.guildId, uid = i.user.id;
          const held = db.prepare('SELECT h.shares, s.code, s.name, s.emoji, s.price FROM stock_holdings h JOIN stock_symbols s ON s.id=h.symbol_id WHERE h.guild_id=? AND h.user_id=? AND h.shares>0 ORDER BY s.sort').all(gid, uid);
          if (!held.length) return i.reply({ content: '你目前沒有持股。', flags: MessageFlags.Ephemeral });
          const rows = [];
          for (let p = 0; p < held.length && rows.length < 5; p += 25) {
            const slice = held.slice(p, p + 25);
            rows.push(new ActionRowBuilder().addComponents(
              new StringSelectMenuBuilder().setCustomId(`stk:sellpick:${p / 25}`)
                .setPlaceholder(held.length > 25 ? `選要賣的股票（${p + 1}-${p + slice.length}）` : '選要賣的股票')
                .setMinValues(1).setMaxValues(1)
                .addOptions(slice.map(h => ({ label: `${h.code} ${h.name}（${num(h.shares)} 股）`.slice(0, 100), description: `現價 ${num(h.price)}`.slice(0, 100), value: h.code, emoji: selEmoji(h.emoji) })))));
          }
          return i.reply({ content: '要賣哪支股？', components: rows, flags: MessageFlags.Ephemeral });
        }
        return;
      }
      if (i.isStringSelectMenu() && i.customId === 'stk:pick') {
        const s = symbolByKey(i.guildId, i.values[0]);
        if (!s) return i.reply({ content: '找不到這支股。', flags: MessageFlags.Ephemeral });
        return i.reply({ embeds: [symbolEmbed(i.guildId, i.user.id, s)], flags: MessageFlags.Ephemeral });
      }
      // 買股：選好股票 → 選股數
      if (i.isStringSelectMenu() && i.customId.startsWith('stk:buypick')) {
        const gid = i.guildId, uid = i.user.id, c = cfg(gid), s = symbolByKey(gid, i.values[0]);
        if (!s) return i.update({ content: '找不到這支股。', components: [], embeds: [] }).catch(() => {});
        const per = s.price * (1 + (c.fee_pct || 0) / 100);
        const afford = Math.floor(wallet(gid, uid, i.user.username).coins / Math.max(1, per));
        const room = (c.max_shares > 0 ? c.max_shares - totalShares(gid, uid) : 99999);
        const cap = Math.min(c.max_trade || 100, Math.max(0, room), afford);
        if (cap <= 0) return i.update({ content: `買不起或已達持股上限（現價 ${num(s.price)}）。`, components: [], embeds: [] }).catch(() => {});
        const amts = [...new Set([1, 5, 10, 25, 50, 100].filter(x => x < cap).concat([cap]))].sort((a, b) => a - b);
        const menu = new StringSelectMenuBuilder().setCustomId('stk:buyqty:' + s.code).setPlaceholder('要買幾股？').setMinValues(1).setMaxValues(1)
          .addOptions(amts.slice(0, 25).map(x => ({ label: x === cap ? `買 ${num(x)} 股（最多）` : `買 ${num(x)} 股`, description: `約花 ${num(Math.round(per * x))}（含交易稅）`.slice(0, 100), value: String(x) })));
        return i.update({ content: `${s.emoji || ''}${s.name} \`${s.code}\` 現價 ${num(s.price)}：要買幾股？`, components: [new ActionRowBuilder().addComponents(menu)], embeds: [] }).catch(() => {});
      }
      if (i.isStringSelectMenu() && i.customId.startsWith('stk:buyqty:')) {
        const code = i.customId.slice('stk:buyqty:'.length), shares = parseInt(i.values[0], 10);
        const r = buy(i.guildId, i.user.id, i.user.username, code, shares);
        return i.update(r.error ? { content: r.error, components: [], embeds: [] } : { content: '', embeds: [r.embed], components: [] }).catch(() => {});
      }
      // 賣股：選好股票 → 選股數
      if (i.isStringSelectMenu() && i.customId.startsWith('stk:sellpick')) {
        const gid = i.guildId, uid = i.user.id, c = cfg(gid), s = symbolByKey(gid, i.values[0]);
        if (!s) return i.update({ content: '找不到這支股。', components: [], embeds: [] }).catch(() => {});
        const held = holding(gid, uid, s.id).shares;
        if (held <= 0) return i.update({ content: '你沒有這支股的持股了。', components: [], embeds: [] }).catch(() => {});
        const cap = Math.min(held, c.max_trade || held);
        const amts = [...new Set([1, 5, 10, 25, 50, 100].filter(x => x < cap).concat([cap]))].sort((a, b) => a - b);
        const menu = new StringSelectMenuBuilder().setCustomId('stk:sellqty:' + s.code).setPlaceholder('要賣幾股？').setMinValues(1).setMaxValues(1)
          .addOptions(amts.slice(0, 25).map(x => ({ label: x === cap ? (cap === held ? `全部賣掉（${num(x)} 股）` : `賣 ${num(x)} 股（單次上限）`) : `賣 ${num(x)} 股`, description: (s.price < 0 ? `倒扣 ${num(Math.abs(s.price) * x)}` : `約得 ${num(Math.round(s.price * x * (1 - (c.fee_pct || 0) / 100)))}`).slice(0, 100), value: String(x) })));
        return i.update({ content: `${s.emoji || ''}${s.name} \`${s.code}\`（持有 ${num(held)}）現價 ${num(s.price)}：要賣幾股？`
          + (s.price < 0 ? '\n⚠️ 現在是負股價，賣出會**從錢包倒扣**（餘額可能變負數）。' : ''), components: [new ActionRowBuilder().addComponents(menu)], embeds: [] }).catch(() => {});
      }
      if (i.isStringSelectMenu() && i.customId.startsWith('stk:sellqty:')) {
        const code = i.customId.slice('stk:sellqty:'.length), shares = parseInt(i.values[0], 10);
        const r = sell(i.guildId, i.user.id, i.user.username, code, shares);
        return i.update(r.error ? { content: r.error, components: [], embeds: [] } : { content: '', embeds: [r.embed], components: [] }).catch(() => {});
      }

      if (!i.isChatInputCommand() || !CMDS.includes(i.commandName)) return;
      const gid = i.guildId;
      if (!gid) return i.reply({ content: '這個指令只能在伺服器裡使用。', flags: MessageFlags.Ephemeral });
      const c = cfg(gid);

      // 行情（物價新聞）只吃 enabled；其餘是股市指令
      if (i.commandName === '行情') {
        if (!c.enabled) return i.reply({ content: '財經新聞目前沒有開放。', flags: MessageFlags.Ephemeral });
        return i.reply({ embeds: [quotesEmbed(gid)], flags: MessageFlags.Ephemeral });
      }
      if (!c.stock_enabled) return i.reply({ content: '股市目前沒有開放。', flags: MessageFlags.Ephemeral });
      if (!channelOk(gid, i.channelId)) {
        const list = csv(c.channels);
        return i.reply({ content: `這個指令只能在 ${list.map(id => `<#${id}>`).join('、')} 使用。`, flags: MessageFlags.Ephemeral });
      }

      if (i.commandName === '股市') {
        const list = symbols(gid);
        const rows = [];
        if (list.length) {
          rows.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder().setCustomId('stk:pick').setPlaceholder('選一支看 K 線與你的持股')
              .addOptions(list.slice(0, 25).map(s => ({
                label: `${s.name}（${s.code}）`.slice(0, 100),
                description: `現價 ${num(s.price)}`.slice(0, 100), value: s.code, emoji: selEmoji(s.emoji)
              })))));
          rows.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('stk:mine').setLabel('💼 我的持股').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('stk:quotes').setLabel('📰 行情').setStyle(ButtonStyle.Secondary)));
        }
        return i.reply({ embeds: [marketEmbed(gid)], components: rows, flags: MessageFlags.Ephemeral });
      }

      if (i.commandName === '個股') {
        const s = symbolByKey(gid, i.options.getString('代號'));
        if (!s) return i.reply({ content: '找不到這支股，用 `/股市` 看代號。', flags: MessageFlags.Ephemeral });
        return i.reply({ embeds: [symbolEmbed(gid, i.user.id, s)], flags: MessageFlags.Ephemeral });
      }

      if (i.commandName === '買股' || i.commandName === '賣股') {
        await i.deferReply({ flags: MessageFlags.Ephemeral });   // 連點防重複下單
        const key = i.options.getString('代號');
        const n = i.commandName === '買股'
          ? buy(gid, i.user.id, i.user.username, key, i.options.getInteger('股數'))
          : sell(gid, i.user.id, i.user.username, key, i.options.getString('股數'));
        if (n.error) return i.editReply({ content: `⚠️ ${n.error}` });
        return i.editReply({ embeds: [n.embed] });
      }

      if (i.commandName === '持股') return i.reply({ embeds: [portfolioEmbed(gid, i.user.id, i.user.username)], flags: MessageFlags.Ephemeral });
      if (i.commandName === '股神榜') return i.reply({ embeds: [leaderboardEmbed(gid)], flags: MessageFlags.Ephemeral });
    } catch (e) {
      logError(i.guildId, '股市互動失敗：', e.message);
      const msg = { content: '⚠️ 系統忙碌，請再試一次。', flags: MessageFlags.Ephemeral };
      if (i.deferred || i.replied) i.editReply({ content: msg.content }).catch(() => {});
      else i.reply(msg).catch(() => {});
    }
  });

  // 股價結算：每個整點跑，內部自己補齊漏掉的 tick（重啟不會斷檔）
  cron.schedule('0 * * * *', () => {
    for (const [gid] of client.guilds.cache) {
      try { catchUp(gid); } catch (e) { logError(gid, '股市結算失敗：', e.message); }
    }
  }, { timezone: 'Asia/Taipei' });

  // 強制清算：每天早上 10 點檢查一次（負股價死當部位、超過持股上限）
  cron.schedule('0 10 * * *', () => {
    for (const [gid] of client.guilds.cache) {
      enforceHoldings(client, gid).catch(e => logError(gid, '股市強制清算失敗：', e.message));
    }
  }, { timezone: 'Asia/Taipei' });

  // 新聞生效與發布：每分鐘檢查一次
  cron.schedule('* * * * *', () => {
    for (const [gid] of client.guilds.cache) {
      try { applyNews(client, gid); } catch (e) { logError(gid, '新聞發布失敗：', e.message); }
    }
  }, { timezone: 'Asia/Taipei' });

  console.log('  ↳ 財經新聞／星幣股市模組已載入（預設關閉，後台開啟）');
}

module.exports = { init, enforceHoldings, forceSell, catchUp, runTick, seedGuild, buy, sell, sparkline };
