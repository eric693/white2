// 稅金系統：每週（可改每日/每月）自動結算三種稅
//   1. 農地稅：依「種著作物的格數」課，空地不課 → 逼人採收，不要整片田當倉庫
//   2. 養殖稅：依牧場動物數＋魚缸魚數課 → 養越多越要顧
//   3. 所得稅：對「目前餘額」累進課徵 → 專門抽囤在錢包不花的錢
// 設計重點：只從錢包扣，不動背包/資產；扣到 0 為止不會變負數，缺繳的部分記在稅單上。
const { EmbedBuilder, MessageFlags } = require('discord.js');
const cron = require('node-cron');
const { db, guildConfig, activeGuildIds, logError } = require('../../db');
const { brandColor } = require('../../util/brand');
const { parts, localToday } = require('../../util/time');
const { livePrice } = require('../../util/market');

const cfg = (gid) => guildConfig('tax_config', gid);
const gcfg = (gid) => guildConfig('gather_config', gid);
const money = (gid, n) => {
  const c = gcfg(gid);
  return `${c.currency_emoji || '🪙'} ${Number(n || 0).toLocaleString('en-US')} ${c.currency_name || '星幣'}`;
};

// 預設級距：級距切細、稅率壓低（整筆跳級時跳一級不會突然變貴），越有錢才慢慢抽多一點。
// 舊版是 5/10/20/35 四大級，玩家反映「跳一級就爆增、感覺不出差別」→ 改成 9 小級，整體再下修 5 個百分點。
const DEFAULT_BRACKETS = [
  { over: 100000, pct: 1 },
  { over: 200000, pct: 2 },
  { over: 400000, pct: 3 },
  { over: 700000, pct: 5 },
  { over: 1000000, pct: 7 },
  { over: 2000000, pct: 10 },
  { over: 4000000, pct: 13 },
  { over: 7000000, pct: 17 },
  { over: 10000000, pct: 20 }
];

function brackets(c) {
  try {
    const b = JSON.parse(c.income_brackets || '[]');
    if (Array.isArray(b) && b.length) {
      return b.map(x => ({ over: Math.max(0, parseInt(x.over, 10) || 0), pct: Math.max(0, parseFloat(x.pct) || 0) }))
        .filter(x => x.pct > 0).sort((a, b2) => a.over - b2.over);
    }
  } catch { /* 壞掉的 JSON 就當沒設定 */ }
  return DEFAULT_BRACKETS;
}

// 兩種算法，後台 income_flat 切換：
//   flat=1（預設）整筆跳級：找出餘額落在哪一級，整個餘額乘那一級的 %（越有錢跳一級就整筆變貴）
//   flat=0 分段累進：每一級只對落在該級距內的那一段課（跟真實所得稅一樣）
function incomeTax(balance, free, bs, flat = true) {
  if (balance <= free) return 0;
  if (flat) {
    let pct = 0;
    for (const b of bs) if (balance > b.over) pct = b.pct;   // bs 已由小到大排序 → 最後一個成立的就是最高級
    return Math.floor(balance * pct / 100);
  }
  let tax = 0;
  for (let i = 0; i < bs.length; i++) {
    const lo = Math.max(bs[i].over, free);
    const hi = i + 1 < bs.length ? bs[i + 1].over : Infinity;
    if (balance > lo) tax += (Math.min(balance, hi) - lo) * bs[i].pct / 100;
  }
  return Math.floor(tax);
}

// 免稅名單：後台指定的 user_id / 身分組完全不課（管理員、活動帳號）
// 用逗號／空白／換行分隔都吃，不預設 ID 一定是純數字（避免把名單默默吃掉）
const csvIds = (s2) => String(s2 || '').split(/[\s,;、]+/).map(x => x.trim()).filter(Boolean);
function isExempt(gid, userId, member) {
  const c = cfg(gid);
  if (csvIds(c.exempt_users).includes(String(userId))) return true;
  const roles = csvIds(c.exempt_roles);
  if (roles.length && member && member.roles && member.roles.cache) {
    return roles.some(r => member.roles.cache.has(r));
  }
  return false;
}

// 算一個人這期該繳多少（不扣款，/稅單 的預估也走這支）
function assess(gid, userId) {
  const c = cfg(gid);
  const w = db.prepare('SELECT * FROM econ_wallets WHERE guild_id=? AND user_id=?').get(gid, userId);
  if (!w) return null;

  const plots = db.prepare(
    'SELECT plot_type, COUNT(*) n FROM crop_plots WHERE guild_id=? AND user_id=? GROUP BY plot_type'
  ).all(gid, userId);
  let field = 0, green = 0;
  for (const p of plots) { if (p.plot_type === 'greenhouse') green = p.n; else field += p.n; }
  const animals = db.prepare('SELECT COUNT(*) n FROM ranch_slots WHERE guild_id=? AND user_id=?').get(gid, userId).n;
  const fish = db.prepare('SELECT COUNT(*) n FROM aquarium_slots WHERE guild_id=? AND user_id=?').get(gid, userId).n;
  // 本期兌換金額：上次結算之後在神秘商店花掉的錢（沒結算過就算全部）
  const since = c.last_run_at || '';
  const spent = since
    ? db.prepare('SELECT COALESCE(SUM(CASE WHEN paid>0 THEN paid ELSE price*qty END),0) v FROM special_redeems WHERE guild_id=? AND user_id=? AND created_at > ?').get(gid, userId, since).v
    : db.prepare('SELECT COALESCE(SUM(CASE WHEN paid>0 THEN paid ELSE price*qty END),0) v FROM special_redeems WHERE guild_id=? AND user_id=?').get(gid, userId).v;
  // 持股市值：只算「現價為正」的股票，負價股不會反過來變成退稅
  const stockVal = db.prepare(
    `SELECT COALESCE(SUM(h.shares * s.price),0) v FROM stock_holdings h JOIN stock_symbols s ON s.id=h.symbol_id
      WHERE h.guild_id=? AND h.user_id=? AND h.shares>0 AND s.price>0`
  ).get(gid, userId).v;

  // 免稅額度先抵便宜的那一項（農地→溫室、動物→魚），對玩家有利
  let freeLeft = Math.max(0, c.land_free || 0);
  const fieldTaxed = Math.max(0, field - freeLeft); freeLeft = Math.max(0, freeLeft - field);
  const greenTaxed = Math.max(0, green - freeLeft);
  let bFree = Math.max(0, c.breed_free || 0);
  const animalTaxed = Math.max(0, animals - bFree); bFree = Math.max(0, bFree - animals);
  const fishTaxed = Math.max(0, fish - bFree);

  const land = c.land_enabled ? fieldTaxed * (c.land_field || 0) + greenTaxed * (c.land_greenhouse || 0) : 0;
  const breed = c.breed_enabled ? animalTaxed * (c.breed_animal || 0) + fishTaxed * (c.breed_fish || 0) : 0;
  // 證券稅：持股市值扣掉免稅額後，乘上稅率
  const stockTaxed = Math.max(0, stockVal - (c.stock_free || 0));
  const stock = c.stock_enabled ? Math.floor(stockTaxed * (c.stock_pct || 0) / 100) : 0;
  // 消費稅：把錢換成圖也要繳，否則結算前掃貨就能完全逃稅
  const spendTaxed = Math.max(0, spent - (c.spend_free || 0));
  const spend = c.spend_enabled ? Math.floor(spendTaxed * (c.spend_pct || 0) / 100) : 0;
  // 所得稅的稅基：餘額／本期總收入／兩者取高。取高＝錢花掉也逃不掉，囤著也逃不掉，但不會被課兩次。
  const earned = Math.max(0, (w.total_earned || 0) - (w.earned_mark || 0));
  const base = c.income_base === 'earned' ? earned
    : c.income_base === 'max' ? Math.max(w.coins, earned)
      : w.coins;
  let income = c.income_enabled ? incomeTax(base, c.income_free || 0, brackets(c), !!c.income_flat) : 0;
  // 單次上限：三稅合計不超過餘額的 income_max_pct %，避免一次被抄家
  const cap = Math.floor(w.coins * Math.max(0, Math.min(100, c.income_max_pct ?? 50)) / 100);
  let total = income + land + breed + stock + spend;
  if (cap > 0 && total > cap) {
    // 超過上限時先砍所得稅（農地/養殖/證券/消費是固定規費，該繳還是要繳）
    income = Math.max(0, cap - land - breed - stock - spend);
    total = income + land + breed + stock + spend;
  }
  // 慈善捐款折抵：本期捐款 × 折抵比例，直接從應繳稅額扣掉（不會扣成負數）
  const gross = total;
  const { credit, donated } = require('./charity').creditFor(gid, userId, total);
  total = Math.max(0, total - credit);
  return {
    wallet: w, balance: w.coins, income, land, breed, stock, spend, gross, credit, donated, total, earned, incomeBase: base,
    counts: { field, green, animals, fish, fieldTaxed, greenTaxed, animalTaxed, fishTaxed, stockVal, stockTaxed, spent, spendTaxed, earned, donated, credit }
  };
}

// ================== 強制清算：欠稅就變賣資產抵債 ==================
// 只賣到「剛好把債還清」為止。股票／魚／動物是整份資產，賣不了半股，所以
// 一律「便宜的先賣」，讓最後那一份的超賣金額最小；超賣的部分會留在玩家錢包裡。
// 動物與魚回收半價（跟 /放生、/賣魚 一致），
// 背包物品照 /賣出 的即時賣價，股票照現價扣交易稅（負價股不賣，賣了只會更負）。
// ⚠️ 預設只賣**股票**：農場／魚缸／背包被系統收掉會讓玩家直接不想玩，
//    要動那些資產只能由管理員在後台自己把順序加回去。
const LIQ_LABEL = { bag: '🎒 背包物品', stock: '📈 股票', fish: '🐠 魚缸的魚', animal: '🐄 牧場動物' };
const SELL_PCT = 0.5;   // 動物／魚的回收比例，與 ranch.js／aquarium.js 相同

function liquidate(gid, userId, debt) {
  const c = cfg(gid);
  const order = String(c.liquidate_order || 'stock').split(',').map(x => x.trim()).filter(Boolean);
  const sold = [];
  let left = debt;   // 還差多少才回到 0（正數）

  const take = (kind, detail, amount) => {
    if (amount <= 0) return;
    sold.push({ kind, detail, amount });
    left -= amount;
  };

  for (const kind of order) {
    if (left <= 0) break;

    if (kind === 'bag') {
      // 貴的先賣，賣到夠了就停；同一種物品可以只賣一部分
      const rows = db.prepare(
        `SELECT v.count, it.* FROM gather_inventory v JOIN gather_items it ON it.id=v.item_id
          WHERE v.guild_id=? AND v.user_id=? AND v.count>0`).all(gid, userId);
      rows.map(r => ({ ...r, unit: livePrice(gid, r) }))
        .filter(r => r.unit > 0)
        .sort((a, b) => b.unit - a.unit)
        .forEach(r => {
          if (left <= 0) return;
          const need = Math.min(r.count, Math.ceil(left / r.unit));
          db.prepare('UPDATE gather_inventory SET count = count - ? WHERE guild_id=? AND user_id=? AND item_id=?')
            .run(need, gid, userId, r.id);
          take('bag', `${r.emoji || ''}${r.name} ×${need}`, need * r.unit);
        });

    } else if (kind === 'stock') {
      const rows = db.prepare(
        `SELECT h.shares, s.id, s.code, s.name, s.emoji, s.price FROM stock_holdings h
           JOIN stock_symbols s ON s.id=h.symbol_id
          WHERE h.guild_id=? AND h.user_id=? AND h.shares>0 AND s.price>0
          ORDER BY s.price ASC`).all(gid, userId);
      const fee = (mc => Math.max(0, mc.fee_pct || 0))(guildConfig('market_config', gid));
      for (const r of rows) {
        if (left <= 0) break;
        const unitNet = r.price - (r.price * fee / 100);
        if (unitNet <= 0) continue;
        const n = Math.min(r.shares, Math.ceil(left / unitNet));
        const gross = r.price * n;
        const cut = Math.ceil(gross * fee / 100);
        const net = gross - cut;
        const h = db.prepare('SELECT shares, cost_sum FROM stock_holdings WHERE guild_id=? AND user_id=? AND symbol_id=?').get(gid, userId, r.id);
        const costPart = h.shares > 0 ? Math.round((h.cost_sum / h.shares) * n) : 0;
        db.prepare('UPDATE stock_holdings SET shares=shares-?, cost_sum=cost_sum-?, realized=realized+? WHERE guild_id=? AND user_id=? AND symbol_id=?')
          .run(n, costPart, net - costPart, gid, userId, r.id);
        db.prepare("INSERT INTO stock_trades (guild_id,user_id,username,symbol_id,side,shares,price,fee,pnl,ts) VALUES (?,?,'系統強制清算',?,'sell',?,?,?,?,?)")
          .run(gid, userId, r.id, n, r.price, cut, net - costPart, Date.now());
        db.prepare('UPDATE market_config SET burned_total = burned_total + ? WHERE guild_id=?').run(cut, gid);
        take('stock', `${r.emoji || ''}${r.name} ${n} 股`, net);
      }

    } else if (kind === 'fish') {
      const rows = db.prepare(
        `SELECT a.slot, a.pending, f.name, f.emoji, f.price FROM aquarium_slots a
           JOIN aquarium_fish f ON f.id=a.fish_id WHERE a.guild_id=? AND a.user_id=? ORDER BY f.price ASC`).all(gid, userId);
      for (const r of rows) {
        if (left <= 0) break;
        const amt = Math.max(1, Math.floor((r.price || 0) * SELL_PCT)) + (r.pending || 0);
        db.prepare('DELETE FROM aquarium_slots WHERE guild_id=? AND user_id=? AND slot=?').run(gid, userId, r.slot);
        take('fish', `${r.emoji || ''}${r.name}`, amt);
      }

    } else if (kind === 'animal') {
      const rows = db.prepare(
        `SELECT r.slot, a.name, a.emoji, a.price FROM ranch_slots r
           JOIN ranch_animals a ON a.id=r.animal_id WHERE r.guild_id=? AND r.user_id=? ORDER BY a.price ASC`).all(gid, userId);
      for (const r of rows) {
        if (left <= 0) break;
        const amt = Math.max(1, Math.floor((r.price || 0) * SELL_PCT));
        db.prepare('DELETE FROM ranch_slots WHERE guild_id=? AND user_id=? AND slot=?').run(gid, userId, r.slot);
        take('animal', `${r.emoji || ''}${r.name}`, amt);
      }
    }
  }
  return { sold, total: sold.reduce((a, b) => a + b.amount, 0) };
}

// 對全服欠稅的人跑一次清算（課完稅之後、普發之前）
function runLiquidation(gid, period, client, dryRun) {
  const c = cfg(gid);
  if (!c.liquidate_enabled) return [];
  const guild = client && client.guilds ? client.guilds.cache.get(gid) : null;
  const debtors = db.prepare('SELECT user_id, username, coins FROM econ_wallets WHERE guild_id=? AND coins < 0').all(gid);
  const out = [];
  for (const d of debtors) {
    if (isExempt(gid, d.user_id, guild && guild.members.cache.get(d.user_id))) continue;
    if (dryRun) {
      // 試算不動資料：另外開一個交易算完就 rollback
      let res;
      try {
        db.transaction(() => { res = liquidate(gid, d.user_id, -d.coins); throw new Error('__rollback__'); })();
      } catch (e) { if (e.message !== '__rollback__') throw e; }
      if (res && res.total > 0) out.push({ userId: d.user_id, username: d.username, before: d.coins, ...res });
      continue;
    }
    const res = db.transaction(() => {
      const r = liquidate(gid, d.user_id, -d.coins);
      if (r.total > 0) {
        db.prepare("UPDATE econ_wallets SET coins = coins + ?, updated_at = datetime('now','localtime') WHERE guild_id=? AND user_id=?")
          .run(r.total, gid, d.user_id);
        const ins = db.prepare('INSERT INTO tax_liquidations (guild_id,period,user_id,username,kind,detail,amount) VALUES (?,?,?,?,?,?,?)');
        for (const x of r.sold) ins.run(gid, period, d.user_id, d.username || '', x.kind, x.detail, x.amount);
      }
      return r;
    })();
    if (res.total > 0) out.push({ userId: d.user_id, username: d.username, before: d.coins, ...res });
  }
  return out;
}

// 普發（救濟金）：課完稅之後跑。條件是「餘額低於 relief_below」，
//   floor 模式＝補到 relief_floor（負債的人會先被填平）
//   fixed 模式＝每人固定發 relief_amount
// relief_from_tax=1 時，總發放不會超過本期實收稅金，超過就等比例縮減（國庫不會憑空印錢）。
// after：{user_id: 課稅後餘額}。試算模式錢包還沒被扣，一定要靠這份對照表才算得準。
function planRelief(gid, extraBudget, client, after = new Map()) {
  const c = cfg(gid);
  if (!c.relief_enabled) return [];
  const guild = client && client.guilds ? client.guilds.cache.get(gid) : null;
  const below = c.relief_below || 0;
  const all = db.prepare('SELECT user_id, username, coins FROM econ_wallets WHERE guild_id=?').all(gid);
  const rows = all
    .map(w => ({ ...w, coins: after.has(w.user_id) ? after.get(w.user_id) : w.coins }))
    .filter(w => w.coins < below);
  let list = [];
  for (const w of rows) {
    if (isExempt(gid, w.user_id, guild && guild.members.cache.get(w.user_id))) continue;   // 管理員不領普發
    let amt = c.relief_mode === 'fixed'
      ? Math.max(0, c.relief_amount || 0)
      : Math.max(0, (c.relief_floor || 0) - w.coins);
    if (c.relief_max > 0) amt = Math.min(amt, c.relief_max);
    if (amt > 0) list.push({ userId: w.user_id, username: w.username || '', before: w.coins, amount: Math.floor(amt) });
  }
  // 預算控管：發不出這麼多就等比例縮減（至少留 1 塊，免得縮成 0 還記一筆）
  // 財源＝慈善基金會餘額（本期稅收已在結算時存入基金會）；試算時稅還沒進池，用 extraBudget 補上預估稅收
  if (c.relief_from_tax) {
    const budget = Math.max(0, extraBudget) + require('./charity').reliefBudget(gid);
    const want = list.reduce((a, b) => a + b.amount, 0);
    if (want > budget) {
      const ratio = budget / want;
      list = list.map(x => ({ ...x, amount: Math.floor(x.amount * ratio) })).filter(x => x.amount > 0);
    }
  }
  return list;
}

// 普發全額從基金會池撥出（本期稅收已在結算時存入基金會，所以池子裡就有錢）。
function payRelief(gid, period, list) {
  if (!list.length) return 0;
  db.transaction(() => {
    for (const r of list) {
      db.prepare("UPDATE econ_wallets SET coins = coins + ?, updated_at = datetime('now','localtime') WHERE guild_id=? AND user_id=?")
        .run(r.amount, gid, r.userId);
      db.prepare('INSERT INTO tax_reliefs (guild_id,period,user_id,username,before_coins,amount) VALUES (?,?,?,?,?,?)')
        .run(gid, period, r.userId, r.username, r.before, r.amount);
    }
  })();
  const sum = list.reduce((a, b) => a + b.amount, 0);
  const fromPool = require('./charity').takeFromPool(gid, sum);
  if (fromPool > 0) require('./charity').logPayout(gid, period, fromPool, list.length);
  return sum;
}

// 期間代碼：同一期只課一次（用結算日的日期字串當代碼）
function periodCode() { return localToday(); }

// 這一刻是否輪到這台伺服器課稅
function isDue(c) {
  const p = parts();
  if (`${p.hh}:${p.mm}` !== (c.run_time || '09:00')) return false;
  if (c.period === 'day') return true;
  if (c.period === 'month') return p.d === (c.dom || 1);
  return p.dow === (c.dow ?? 1);
}

// 對一台伺服器結算。force=true 給後台「立即試算/課徵」用，會略過時間與去重檢查。
async function runGuild(client, gid, { force = false, dryRun = false } = {}) {
  const c = cfg(gid);
  if (!c.enabled && !force) return null;
  if (!force) {
    if (!isDue(c)) return null;
    if (c.last_period === periodCode()) return null;   // 同一期已經課過
  }
  const period = periodCode();
  // 本期捐款榜要先抓：結算會把 last_run_at 推到現在，之後就查不到「本期」捐款了
  const charity = require('./charity');
  const donTop = charity.cfg(gid).enabled ? charity.periodTop(gid, 5) : [];
  const wallets = db.prepare('SELECT user_id FROM econ_wallets WHERE guild_id=?').all(gid);
  const guild = client && client.guilds ? client.guilds.cache.get(gid) : null;
  const bills = [];
  for (const { user_id } of wallets) {
    if (isExempt(gid, user_id, guild && guild.members.cache.get(user_id))) continue;   // 免稅名單直接跳過
    const a = assess(gid, user_id);
    if (!a || a.total < Math.max(1, c.min_total || 1)) continue;
    bills.push({ userId: user_id, ...a });
  }

  if (!dryRun) {
    const pay = db.transaction(() => {
      for (const b of bills) {
        // no_debt（預設開）：最多只課到餘額歸零，差額當「未繳」記在稅單上，不會把人課成負債。
        const paid = c.no_debt ? Math.max(0, Math.min(b.total, b.balance)) : b.total;
        db.prepare("UPDATE econ_wallets SET coins = coins - ?, updated_at = datetime('now','localtime') WHERE guild_id=? AND user_id=?")
          .run(paid, gid, b.userId);
        db.prepare(
          `INSERT INTO tax_records (guild_id, period, user_id, username, balance, income_tax, land_tax, breed_tax, stock_tax, spend_tax, charity_credit, total, paid, detail)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).run(gid, period, b.userId, b.wallet.username || '', b.balance, b.income, b.land, b.breed, b.stock || 0, b.spend || 0, b.credit || 0, b.total, paid,
          JSON.stringify(b.counts));
        b.paid = paid;
      }
      // 推進本期界線：下一期的消費稅只算這個時間點之後的兌換；收入也重新起算（全服一起，沒繳稅的人也要）
      db.prepare('UPDATE econ_wallets SET earned_mark = total_earned WHERE guild_id=?').run(gid);
      db.prepare("UPDATE tax_config SET last_period=?, last_run_at=datetime('now','localtime') WHERE guild_id=?").run(period, gid);
    });
    pay();
  }
  if (dryRun) for (const b of bills) b.paid = c.no_debt ? Math.max(0, Math.min(b.total, b.balance)) : b.total;
  const sum = bills.reduce((s, b) => s + (b.paid ?? b.total), 0);
  // 試算時錢包還沒被扣，先把「課稅後餘額」寫進去，清算與普發才算得準
  const after = new Map(bills.map(b => [b.userId, b.balance - (b.paid ?? b.total)]));
  if (dryRun) {
    for (const [uid, v] of after) db.prepare('UPDATE econ_wallets SET coins=? WHERE guild_id=? AND user_id=?').run(v, gid, uid);
  }
  const liq = runLiquidation(gid, period, client, dryRun);
  for (const l of liq) after.set(l.userId, (after.has(l.userId) ? after.get(l.userId) : l.before) + l.total);
  if (dryRun) {
    // 還原試算時動到的餘額
    for (const b of bills) db.prepare('UPDATE econ_wallets SET coins=? WHERE guild_id=? AND user_id=?').run(b.balance, gid, b.userId);
  }
  // 收的稅存入慈善基金會（正式結算才做）：稅收變基金會的錢，普發從基金會撥、剩的累積下來
  if (!dryRun && sum > 0) require('./charity').addTax(gid, sum);
  const relief = planRelief(gid, dryRun ? sum : 0, client, after);
  const reliefSum = dryRun ? relief.reduce((a, b) => a + b.amount, 0) : payRelief(gid, period, relief);
  if (!dryRun) await announce(client, gid, period, bills, relief, reliefSum, liq, donTop).catch(() => {});
  return { period, bills, sum, relief, reliefSum, liq, donTop };
}

// 公告本期稅收＋納稅大戶，並（可選）私訊每個人自己的稅單
async function announce(client, gid, period, bills, relief = [], reliefSum = 0, liq = [], donTop = []) {
  const c = cfg(gid);
  if (!bills.length && !relief.length && !liq.length) return;
  const sum = bills.reduce((s, b) => s + b.paid, 0);
  if (c.channel) {
    const ch = await client.channels.fetch(c.channel).catch(() => null);
    if (ch) {
      const top = [...bills].sort((a, b) => b.paid - a.paid).slice(0, 10);
      const emb = new EmbedBuilder()
        .setTitle('🧾 本期稅金結算')
        .setDescription(`期間代碼：\`${period}\`\n共 **${bills.length}** 人繳稅，總稅收 ${money(gid, sum)}`)
        .addFields({
          name: '納稅大戶',
          value: top.map((b, i) => `${['🥇', '🥈', '🥉'][i] || `${i + 1}.`} <@${b.userId}> — ${money(gid, b.paid)}`).join('\n') || '—'
        })
        .setFooter({ text: '所得稅算餘額／證券稅算持股市值／消費稅算本期兌換金額／農地稅算種著的格數／養殖稅算動物與魚。用 /稅單 查明細。' })
        .setColor(brandColor());
      if (liq.length) {
        emb.addFields({
          name: `⚖️ 欠稅強制清算　${liq.length} 人被變賣資產`,
          value: liq.slice(0, 10).map(l => `<@${l.userId}> — 變賣 ${money(gid, l.total)}（${l.sold.length} 項）`).join('\n').slice(0, 1024)
        });
      }
      if (donTop.length) {
        const credited = bills.reduce((a, b) => a + (b.credit || 0), 0);
        emb.addFields({
          name: `❤️ 本期捐款榜（${require('./charity').fundName(gid)}）`
            + (credited > 0 ? `　·　共折抵 ${money(gid, credited)} 稅金` : ''),
          value: donTop.map((d, i) => `${['🥇', '🥈', '🥉'][i] || `${i + 1}.`} <@${d.user_id}> — ${money(gid, d.amount)}`).join('\n').slice(0, 1024)
        });
      }
      if (relief.length) {
        const topR = [...relief].sort((a, b) => b.amount - a.amount).slice(0, 10);
        emb.addFields({
          name: `🤝 本期普發　共 ${relief.length} 人領到 ${money(gid, reliefSum)}`,
          value: topR.map(r => `<@${r.userId}> — ${money(gid, r.amount)}`).join('\n').slice(0, 1024)
        });
      }
      await ch.send({ embeds: [emb] }).catch(() => {});
    }
  }
  if (!c.dm_bill) return;
  for (const b of bills) {
    const u = await client.users.fetch(b.userId).catch(() => null);
    if (!u) continue;
    await u.send({ embeds: [billEmbed(gid, b, period)] }).catch(() => {});
  }
}

function billEmbed(gid, b, period) {
  // 每項一行、後面括號附計算依據——玩家喜歡這種乾淨版面
  const lines = [];
  if (b.income) lines.push(`💰 所得稅　${money(gid, b.income)}（課稅基準 ${Number(b.incomeBase ?? b.balance).toLocaleString('en-US')}｜餘額 ${b.balance.toLocaleString('en-US')}、本期收入 ${Number(b.earned || 0).toLocaleString('en-US')}）`);
  if (b.land) lines.push(`🌾 農地稅　${money(gid, b.land)}（農地 ${b.counts.fieldTaxed} 格／溫室 ${b.counts.greenTaxed} 格）`);
  if (b.breed) lines.push(`🐄 養殖稅　${money(gid, b.breed)}（動物 ${b.counts.animalTaxed} 隻／魚 ${b.counts.fishTaxed} 條）`);
  if (b.stock) lines.push(`📈 證券稅　${money(gid, b.stock)}（持股市值 ${Number(b.counts.stockVal || 0).toLocaleString('en-US')}）`);
  if (b.spend) lines.push(`🛍️ 消費稅　${money(gid, b.spend)}（本期兌換 ${Number(b.counts.spent || 0).toLocaleString('en-US')}）`);
  if (b.credit) lines.push(`❤️ 慈善折抵　**−${money(gid, b.credit)}**（本期捐款 ${Number(b.donated || 0).toLocaleString('en-US')}）`);
  const emb = new EmbedBuilder()
    .setTitle('🧾 你的稅單')
    .setDescription(lines.join('\n') || '本期免稅 🎉')
    .addFields(
      { name: '合計', value: money(gid, b.total) + (b.credit ? `（折抵前 ${Number(b.gross || 0).toLocaleString('en-US')}）` : ''), inline: true },
      { name: '你目前的錢包餘額', value: money(gid, b.balance), inline: true }
    )
    .setColor(brandColor());
  if (period) emb.setFooter({ text: `期間 ${period}` });
  // 課稅不會把人課成負數（no_debt）：錢不夠時只課到 0，差額記為未繳
  if (b.paid !== undefined && b.total > b.paid) {
    emb.addFields({
      name: '⚠️ 餘額不足',
      value: `應繳 ${money(gid, b.total)}，但你只有 ${money(gid, b.balance)}，這期**只課到餘額歸零**（未繳 ${money(gid, b.total - b.paid)}，不會變成負債）。`,
      inline: true
    });
  } else if (b.paid !== undefined && b.balance !== undefined && b.balance - b.paid < 0) {
    emb.addFields({
      name: '⚠️ 欠稅',
      value: `餘額不足，繳完後變成 ${money(gid, b.balance - b.paid)}（負債），要先賺回來才會回到正數。`,
      inline: true
    });
  }
  return emb;
}

// 冒險面板的 🧾稅務：一次講清楚「課什麼、怎麼算、何時收」，再附上自己的預估稅單
function infoEmbed(gid, userId, username) {
  const c = cfg(gid);
  const emb = new EmbedBuilder().setColor(brandColor()).setTitle('🧾 稅務資訊');
  if (!c.enabled) {
    return emb.setDescription('這個伺服器目前**沒有開徵稅金**，錢包不會被扣。\n開徵後這裡會顯示稅率、結算時間與你自己的預估稅單。');
  }
  if (isExempt(gid, userId)) {
    return emb.setDescription(`✅ 你在**免稅名單**內，這個伺服器的稅金不會扣到你。`);
  }
  // 稅率：一稅一行、精簡好讀
  const lines = [];
  if (c.income_enabled) {
    const bs = brackets(c);
    const range = bs.length ? `${bs[0].pct}%〜${bs[bs.length - 1].pct}%（${bs.length} 級）` : '';
    const baseLabel = c.income_base === 'earned' ? '本期總收入' : c.income_base === 'max' ? '餘額與本期收入取高' : '錢包餘額';
    lines.push(c.income_flat
      ? `💰 **所得稅**　整筆跳級 ${range}，免稅 ${money(gid, c.income_free || 0)}（基準：${baseLabel}）`
      : `💰 **所得稅**　免稅 ${money(gid, c.income_free || 0)}，超過的部分累進 ${range}（基準：${baseLabel}）`);
  }
  if (c.stock_enabled) lines.push(`📈 **證券稅**　持股市值 × ${c.stock_pct || 0}%${(c.stock_free || 0) > 0 ? `（${money(gid, c.stock_free)} 以內免稅）` : ''}，負價股不算`);
  if (c.land_enabled) lines.push(`🌾 **農地稅**　種著的作物：農地 ${money(gid, c.land_field || 0)}／溫室 ${money(gid, c.land_greenhouse || 0)} 每格${c.land_free ? `（前 ${c.land_free} 格免稅）` : ''}`);
  if (c.breed_enabled) lines.push(`🐄 **養殖稅**　動物 ${money(gid, c.breed_animal || 0)}／隻、魚 ${money(gid, c.breed_fish || 0)}／條${c.breed_free ? `（前 ${c.breed_free} 隻免稅）` : ''}`);
  if (c.spend_enabled) lines.push(`🛍️ **消費稅**　神秘商店花掉的金額 × ${c.spend_pct || 0}%${(c.spend_free || 0) > 0 ? `（${money(gid, c.spend_free)} 以內免稅）` : ''}`);
  if (!lines.length) lines.push('目前沒有開徵稅金。');
  emb.setDescription(lines.join('\n'));

  // 你這期預估（本人最在意的）
  const a = assess(gid, userId);
  if (a) {
    const detail = [];
    if (a.income) detail.push(`💰所得 ${money(gid, a.income)}`);
    if (a.stock) detail.push(`📈證券 ${money(gid, a.stock)}`);
    if (a.land) detail.push(`🌾農地 ${money(gid, a.land)}`);
    if (a.breed) detail.push(`🐄養殖 ${money(gid, a.breed)}`);
    if (a.spend) detail.push(`🛍️消費 ${money(gid, a.spend)}`);
    if (a.credit) detail.push(`❤️折抵 −${money(gid, a.credit)}`);
    emb.addFields({
      name: '你這期預估要繳',
      value: (detail.length ? detail.join('　') + `\n**合計 ${money(gid, a.total)}**` : '本期免稅 🎉') + `　（餘額 ${money(gid, a.balance)}）`
    });
  }

  // 重點提醒濃縮成一欄，不再一堆欄位
  const notes = [c.no_debt ? '課稅只扣錢包、**不會課成負數**（不夠只課到 0，差額算未繳）' : '錢不夠會欠稅、餘額變負數'];
  if (c.liquidate_enabled) {
    const order = String(c.liquidate_order || 'stock').split(',').map(x => LIQ_LABEL[x.trim()] || x.trim());
    notes.push(`欠稅會自動變賣 ${order.join('→')} 抵債（只賣到剛好還清）`);
  }
  const cc = require('./charity').cfg(gid);
  if (cc.enabled && cc.deduct_pct > 0) notes.push(`\`/捐款\` 捐基金會可折抵 **${cc.deduct_pct}%** 稅`);
  if (c.relief_enabled) notes.push(`結算後餘額 < ${money(gid, c.relief_below || 0)} 的人可領普發救濟金`);
  emb.addFields({ name: '📌 重點', value: '・' + notes.join('\n・') });

  emb.addFields({ name: '結算', value: `${nextRunText(c)}${(c.income_max_pct ?? 50) > 0 ? `　·　單期最多課走餘額的 ${c.income_max_pct}%` : ''}` });
  return emb.setFooter({ text: '用 /稅單 查自己的完整明細與上期紀錄' });
}

function init(client) {
  // 冒險面板的 🧾稅務按鈕
  client.on('interactionCreate', async (i) => {
    if (!i.isButton() || i.customId !== 'adv:tax') return;
    try {
      return await i.reply({ embeds: [infoEmbed(i.guildId, i.user.id, i.user.username)], flags: MessageFlags.Ephemeral });
    } catch (e) {
      logError(i.guildId, '稅務面板失敗：', e && e.stack ? e.stack : e);
      if (!i.replied && !i.deferred) i.reply({ content: '查詢稅務資訊時發生錯誤。', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  });

  client.on('interactionCreate', async (i) => {
    if (!i.isChatInputCommand() || i.commandName !== '稅單') return;
    try {
      const gid = i.guildId, c = cfg(gid);
      if (!c.enabled) {
        return i.reply({ content: '這個伺服器目前沒有開徵稅金。', flags: MessageFlags.Ephemeral });
      }
      const target = i.options.getUser('玩家') || i.user;
      if (isExempt(gid, target.id, i.guild && i.guild.members.cache.get(target.id))) {
        return i.reply({ content: `✅ ${target.username} 在免稅名單內，不會被課稅。`, flags: MessageFlags.Ephemeral });
      }
      const a = assess(gid, target.id);
      if (!a) return i.reply({ content: '找不到錢包資料（先玩一下再來看稅單吧）。', flags: MessageFlags.Ephemeral });
      const last = db.prepare(
        'SELECT * FROM tax_records WHERE guild_id=? AND user_id=? ORDER BY id DESC LIMIT 1'
      ).get(gid, target.id);
      const emb = billEmbed(gid, a, null)
        .setTitle(`🧾 ${target.username} 的稅單預估`)
        .setFooter({
          text: last
            ? `上期（${last.period}）實繳 ${last.paid.toLocaleString('en-US')}　·　下次結算：${nextRunText(c)}`
            : `下次結算：${nextRunText(c)}`
        });
      return i.reply({ embeds: [emb], flags: MessageFlags.Ephemeral });
    } catch (e) {
      logError(i.guildId, '稅單查詢失敗：', e && e.stack ? e.stack : e);
      if (!i.replied && !i.deferred) i.reply({ content: '查詢稅單時發生錯誤。', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  });

  // 每分鐘檢查一次，由各伺服器自己的 period/dow/run_time 決定要不要課（多伺服器各自獨立）
  cron.schedule('* * * * *', async () => {
    for (const gid of activeGuildIds()) {
      try { await runGuild(client, gid); }
      catch (e) { logError(gid, '稅金結算失敗：', e && e.stack ? e.stack : e); }
    }
  }, { timezone: 'Asia/Taipei' });

  client._runTax = (gid, opts) => runGuild(client, gid, opts);
  console.log('  ↳ 稅金模組已載入（農地稅／養殖稅／所得稅，每分鐘檢查結算時間；面板 🧾稅務）');
}

const DOW = ['日', '一', '二', '三', '四', '五', '六'];
function nextRunText(c) {
  if (c.period === 'day') return `每日 ${c.run_time}`;
  if (c.period === 'month') return `每月 ${c.dom} 號 ${c.run_time}`;
  return `每週${DOW[c.dow ?? 1]} ${c.run_time}`;
}

module.exports = { init, assess, runGuild, incomeTax, DEFAULT_BRACKETS, nextRunText, infoEmbed, isExempt, planRelief, liquidate, runLiquidation };
