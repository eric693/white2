// 稅金系統：每週（可改每日/每月）自動結算四種稅，四者各自獨立計算。
//   1. 所得稅：只課「這一期實際賺到的錢」——賣東西、任務、簽到等真正的收入，
//      再加上股票「賣掉之後」的淨損益（含買賣手續費）。
//   2. 同居稅：依同居角色數量，倍增累進（第 1 位＝基礎、第 2 位×2、第 3 位×4…）
//   3. 寵物稅：依寵物數量，倍增累進（同上）
//   4. 房屋稅：依房屋等級，等級越高越重
//
// 2026-09 改版把「依資產課稅」整套拿掉：農地稅、養殖稅、證券稅、消費稅全部移除。
// 理由是那些都在對「既有資產」重複課稅——玩家沒有賺到錢也要繳，錢包餘額被
// 慢慢刮掉；證券稅更直接跟「股票只收買賣手續費、不另收稅」衝突。
// 相關欄位保留在 tax_config 裡（舊資料不刪），但一律不再計入稅額。
//
// 不列入所得的項目：資產移動（轉帳）、銀行存提款、信貸本金與還款、各種退款、
// 交易返還、股票未實現漲跌。這些都只是錢換位置，不是賺到。
//
// 設計重點：只從錢包扣，不動背包/資產；扣到 0 為止不會變負數，缺繳的部分記在稅單上。
const { EmbedBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { nameOf } = require('../../util/names');
const cron = require('node-cron');
const { db, guildConfig, activeGuildIds, logError } = require('../../db');
const { brandColor } = require('../../util/brand');
const { parts, localToday } = require('../../util/time');
const { livePrice } = require('../../util/market');

const { ensureColumns } = require('../../db');
ensureColumns('econ_wallets', {
  // 上次結算時的「股票累計已實現損益」水位，用來算這一期的股票淨損益
  stock_mark: 'INTEGER NOT NULL DEFAULT 0'
});
ensureColumns('tax_config', {
  // 同居稅／寵物稅：倍增累進的「基礎稅額」（第 1 位／第 1 隻的金額），後台可調
  partner_step: 'INTEGER NOT NULL DEFAULT 2',       // 每多一位乘幾倍（2＝倍增）
  pet_enabled: 'INTEGER NOT NULL DEFAULT 1',
  pet_base: 'INTEGER NOT NULL DEFAULT 3000',
  pet_step: 'INTEGER NOT NULL DEFAULT 2',
  // 房屋稅：整體調高，仍照等級指數成長
  house_lv_table: "TEXT NOT NULL DEFAULT ''"        // 選填：各級固定稅額 JSON，如 {"1":2000,"2":5000}
});

// 一次性調整：2026-09 稅制改版的預設值搬遷。
//   ・房屋稅整體調高（基礎 300 → 900）：家園加成是永久的，稅太輕蓋房子就是純賺。
//   ・房屋稅裡的「寵物加課」歸零：寵物已經另有寵物稅，留著會變成同一隻課兩次。
//   ・農地／養殖／證券／消費四種資產稅一律關閉（欄位保留，之後想查舊設定還在）。
// 後台改過的值不會被蓋掉——只動還停在舊預設的那些。
(function migrateTaxDefaults() {
  const { getSetting, setSetting } = require('../../db');
  if (getSetting('tax_2026_09_migrated', '0') === '1') return;
  try {
    db.prepare(`UPDATE tax_config SET
      house_base = CASE WHEN house_base = 300 THEN 900 ELSE house_base END,
      house_pet = 0,
      land_enabled = 0, breed_enabled = 0, stock_enabled = 0, spend_enabled = 0`).run();
    // 股票已實現損益的水位要先對齊「現在」。
    // 不做這件事的話 stock_mark 會停在 0，改版後第一次結算就把每個人**歷年
    // 累計**的已實現損益整筆當成本期所得課下去——實測最高的帳號會被課到
    // 七億星幣，等於一次抄家。新制只該課改版之後才實現的損益。
    db.prepare(`UPDATE econ_wallets SET stock_mark = (
                  SELECT COALESCE(SUM(h.realized),0) FROM stock_holdings h
                   WHERE h.guild_id = econ_wallets.guild_id AND h.user_id = econ_wallets.user_id)`).run();
    setSetting('tax_2026_09_migrated', '1');
    console.log('  ↳ 稅制：已套用 2026-09 預設值（房屋稅調高、資產稅關閉、股票損益水位對齊）');
  } catch (e) { console.error('稅制預設值搬遷失敗：', e.message); }
})();

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

// ================== 實際獲利（所得稅的稅基） ==================
// 「賺到」才課稅，錢換位置不課。判斷依據是星幣明細（econ_ledger）的 reason，
// 那是一組由程式寫死的固定字串，不是玩家能自由輸入的東西，所以可以直接白名單。
//
// 為什麼用白名單而不是黑名單：漏掉一個新的收入來源，最多是少收一點稅；
// 漏掉一個新的「錢換位置」項目，卻會讓玩家因為搬了一次錢就被課稅——
// 後者是會讓人不敢玩的錯誤，寧可少收。
const INCOME_REASONS = new Set([
  '賣出', '賣動物', '賣魚', '賣家具', '賣料理', '魚缸收成',
  '任務獎勵', '每日簽到', '成就獎金', '大賽獎金', '同居能力',
  '偷魚成功', '偷偷樂成功', '抓到小偷賠償', '普發現金', '收到資助'
]);

// 明確不列入所得（寫出來是為了讓「為什麼不課」有據可查，程式上白名單已經擋掉了）：
//   轉帳給人／收到轉帳          → 資產移動
//   存款／提款                  → 資產移動
//   信用貸款撥款／還款／逾期扣款 → 信貸本金，不是收入
//   拍賣退款／管理員退款／拍賣出價退回 → 退款
//   買股票／賣股票              → 另以「已實現損益」計算，見下
//   繳稅／補繳欠稅／強制清算抵稅／捐款 → 支出
//   各種罰款                    → 支出

// 這一期的實際獲利。
// 以「上次結算之後的星幣明細」為範圍，加上股票已實現損益的增量。
function realizedIncome(gid, userId, since) {
  const rows = since
    ? db.prepare('SELECT reason, delta FROM econ_ledger WHERE guild_id=? AND user_id=? AND created_at > ?').all(gid, userId, since)
    : db.prepare('SELECT reason, delta FROM econ_ledger WHERE guild_id=? AND user_id=?').all(gid, userId);
  let income = 0;
  for (const r of rows) if (r.delta > 0 && INCOME_REASONS.has(r.reason)) income += r.delta;

  // 股票：只有「賣出之後」的淨損益才算所得，未實現漲跌不課。
  // stock_holdings.realized 是累計已實現損益（買賣手續費已經扣在裡面），
  // 減掉上次結算時記下的水位就是這一期真正賺到／賠掉的。
  const realizedNow = db.prepare(
    'SELECT COALESCE(SUM(realized),0) v FROM stock_holdings WHERE guild_id=? AND user_id=?').get(gid, userId).v;
  const mark = (db.prepare(
    'SELECT stock_mark FROM econ_wallets WHERE guild_id=? AND user_id=?').get(gid, userId) || {}).stock_mark || 0;
  const stockPnl = realizedNow - mark;

  // 股票賠錢可以抵掉同期其他收入，但不會把所得壓成負數（不退稅）
  return { income, stockPnl, taxable: Math.max(0, income + stockPnl), realizedNow };
}

// 倍增累進：第 1 個＝base，第 2 個＝base×step，第 3 個＝base×step²…
// 合計＝base × (step^n − 1) / (step − 1)。step=2 時就是 base×(2^n − 1)。
function progressiveTax(base, count, step = 2) {
  const n = Math.max(0, Math.floor(count));
  if (!base || !n) return 0;
  const k = Math.max(2, Math.floor(step) || 2);
  // 數量爆炸時金額會失控（2^40 已經超過安全整數），上限壓在 30 個
  const capped = Math.min(n, 30);
  return Math.floor(base * (Math.pow(k, capped) - 1) / (k - 1));
}

// 算一個人這期該繳多少（不扣款，/稅單 的預估也走這支）
function assess(gid, userId) {
  const c = cfg(gid);
  const w = db.prepare('SELECT * FROM econ_wallets WHERE guild_id=? AND user_id=?').get(gid, userId);
  if (!w) return null;

  // 農地／養殖／證券／消費四種「依資產課稅」已在 2026-09 移除，
  // 這裡不再統計格數、動物數、持股市值與兌換金額。

  // ---- 房屋稅 ----
  // 房子越大稅越重（指數成長）。2026-09 整體調高：家園加成是永久的，
  // 稅太輕的話蓋房子等於純賺，人人衝頂。擺出來的家具另計。
  // house_lv_table 有填就照表走（後台想直接指定每級多少錢時用），否則用曲線公式。
  const hu = db.prepare('SELECT level FROM home_users WHERE guild_id=? AND user_id=?').get(gid, userId);
  const houseLv = hu ? hu.level : 0;
  const placed = db.prepare('SELECT COALESCE(SUM(placed),0) n FROM home_furniture_owned WHERE guild_id=? AND user_id=?').get(gid, userId).n;
  const petCount = db.prepare('SELECT COUNT(*) n FROM pet_owned WHERE guild_id=? AND user_id=?').get(gid, userId).n;
  const houseTaxedLv = Math.max(0, houseLv - (c.house_free || 0));
  let houseTable = null;
  try { const t = JSON.parse(c.house_lv_table || 'null'); if (t && typeof t === 'object') houseTable = t; } catch { /* 壞掉的 JSON 就當沒設定 */ }
  const house = c.house_enabled && houseTaxedLv > 0
    ? (houseTable && houseTable[String(houseLv)] != null
        ? Math.max(0, Math.floor(Number(houseTable[String(houseLv)]) || 0))
        : Math.floor(Math.pow(houseTaxedLv, c.house_curve || 1.6) * (c.house_base || 0)))
      + placed * (c.house_furniture || 0)
    : 0;

  // ---- 同居稅 ----（倍增累進：第 1 位＝基礎、第 2 位×2、第 3 位×4…）
  // 同居名額已經取消上限，改用稅金自然節制：養得起就儘管養。
  const partners = db.prepare(
    `SELECT p.role_id FROM home_partners p WHERE p.guild_id=? AND p.user_id=?`).all(gid, userId);
  const partner = c.partner_enabled
    ? progressiveTax(c.partner_base || 0, partners.length, c.partner_step || 2)
    : 0;

  // ---- 寵物稅 ----（同樣倍增累進；寵物數量上限也取消了）
  const pet = c.pet_enabled
    ? progressiveTax(c.pet_base || 0, petCount, c.pet_step || 2)
    : 0;

  // ---- 所得稅 ----（只課這一期實際賺到的錢）
  const since = c.last_run_at || '';
  const ri = realizedIncome(gid, userId, since);
  const base = ri.taxable;
  let income = c.income_enabled ? incomeTax(base, c.income_free || 0, brackets(c), !!c.income_flat) : 0;

  // 單次上限：四稅合計不超過餘額的 income_max_pct %，避免一次被抄家
  const cap = Math.floor(w.coins * Math.max(0, Math.min(100, c.income_max_pct ?? 50)) / 100);
  let total = income + house + partner + pet;
  if (cap > 0 && total > cap) {
    // 超過上限時先砍所得稅（同居／寵物／房屋是固定持有稅，該繳還是要繳）
    income = Math.max(0, cap - house - partner - pet);
    total = income + house + partner + pet;
  }
  // 慈善捐款折抵：本期捐款 × 折抵比例，直接從應繳稅額扣掉（不會扣成負數）
  const gross = total;
  const { credit, donated } = require('./charity').creditFor(gid, userId, total);
  const curTax = Math.max(0, total - credit);   // 這一期新產生的稅（折抵後）
  // 上期沒繳完、延到這期的欠稅（no_debt 模式才有；一起補收）
  const arrears = c.no_debt ? Math.max(0, w.tax_arrears || 0) : 0;
  total = curTax + arrears;
  return {
    wallet: w, balance: w.coins, income, house, partner, pet, partnerCount: partners.length,
    // 已移除的稅目仍回傳 0，讓還沒改完的顯示端不會變成 undefined
    land: 0, breed: 0, stock: 0, spend: 0,
    gross, credit, donated, curTax, arrears, total,
    earned: ri.income, stockPnl: ri.stockPnl, incomeBase: base, stockRealizedNow: ri.realizedNow,
    counts: {
      houseLv, houseTaxedLv, placed, petCount, partnerCount: partners.length,
      earned: ri.income, stockPnl: ri.stockPnl, taxableIncome: base, donated, credit
    }
  };
}

// ================== 強制清算：欠稅就變賣資產抵債 ==================
// 只賣到「剛好把債還清」為止。股票／魚／動物是整份資產，賣不了半股，所以
// 一律「便宜的先賣」，讓最後那一份的超賣金額最小；超賣的部分會留在玩家錢包裡。
// 動物與魚回收半價（跟 /放生、/賣魚 一致），
// 背包物品照 /賣出 的即時賣價，股票照現價扣手續費（負價股不賣，賣了只會更負）。
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
        require('./gather').logCoins(gid, d.user_id, r.total, '強制清算抵稅', '系統代賣資產');
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
      require('./gather').logCoins(gid, r.userId, r.amount, '普發現金', period);
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
        require('./gather').logCoins(gid, b.userId, -paid, '繳稅', period);
        // 沒繳完的（含上期延過來的）存成新欠稅，延到下一期繼續補收；繳清就歸 0
        if (c.no_debt) db.prepare('UPDATE econ_wallets SET tax_arrears=? WHERE guild_id=? AND user_id=?').run(Math.max(0, b.total - paid), gid, b.userId);
        db.prepare(
          `INSERT INTO tax_records (guild_id, period, user_id, username, balance, income_tax, land_tax, breed_tax, stock_tax, spend_tax, charity_credit, total, paid, detail)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).run(gid, period, b.userId, b.wallet.username || '', b.balance, b.income,
          // land_tax／breed_tax 兩個舊欄位改放同居稅與寵物稅：稅目換了，但欄位名稱
          // 動不了（舊紀錄還在用）。實際金額與名目一律以 detail 裡的 JSON 為準。
          b.partner || 0, b.pet || 0, 0, 0, b.credit || 0, b.total, paid,
          JSON.stringify({ ...b.counts, partnerTax: b.partner, petTax: b.pet, houseTax: b.house, incomeTax: b.income }));
        b.paid = paid;
      }
      // 推進本期界線（全服一起，沒繳到稅的人也要推，否則下一期會重複課到同一批收入）
      db.prepare('UPDATE econ_wallets SET earned_mark = total_earned WHERE guild_id=?').run(gid);
      // 股票已實現損益的水位：下一期只算這個時間點之後新實現的損益
      db.prepare(`UPDATE econ_wallets SET stock_mark = (
                    SELECT COALESCE(SUM(h.realized),0) FROM stock_holdings h
                     WHERE h.guild_id = econ_wallets.guild_id AND h.user_id = econ_wallets.user_id)
                  WHERE guild_id=?`).run(gid);
      db.prepare("UPDATE tax_config SET last_period=?, last_run_at=datetime('now','localtime') WHERE guild_id=?").run(period, gid);
    });
    pay();
    // 推播到 /play App（best-effort，有訂閱才會收到）
    for (const b of bills) {
      const arr = c.no_debt ? Math.max(0, b.total - (b.paid ?? 0)) : 0;
      try {
        require('../../push').sendPush(gid, b.userId, {
          title: '🧾 本期稅單已開徵',
          body: `本期課稅 ${money(gid, b.paid ?? b.total)}` + (arr > 0 ? `，另有欠稅 ${money(gid, arr)} 下期補收（可在 App 或 /稅單 補繳）。` : '。'),
          tag: 'tax'
        });
      } catch (e) {}
    }
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
        .setFooter({ text: '所得稅算餘額／證券稅算持股市值／消費稅算本期兌換金額／農地稅算種著的格數／養殖稅算動物與魚／房屋稅算階級與家具寵物。用 /稅單 查明細。' })
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
  if (b.income) lines.push(`💰 所得稅　${money(gid, b.income)}（本期實際獲利 ${Number(b.incomeBase || 0).toLocaleString('en-US')}`
    + `＝收入 ${Number(b.earned || 0).toLocaleString('en-US')}`
    + ` ${b.stockPnl >= 0 ? '＋' : '−'} 股票已實現 ${Math.abs(b.stockPnl || 0).toLocaleString('en-US')}）`);
  if (b.partner) lines.push(`💞 同居稅　${money(gid, b.partner)}（同居 ${b.partnerCount} 位，倍增累進）`);
  if (b.pet) lines.push(`🐾 寵物稅　${money(gid, b.pet)}（寵物 ${b.counts.petCount} 隻，倍增累進）`);
  if (b.house) lines.push(`🏡 房屋稅　${money(gid, b.house)}（房屋 Lv.${b.counts.houseLv}｜家具 ${b.counts.placed} 件）`);
  if (b.credit) lines.push(`❤️ 慈善折抵　**−${money(gid, b.credit)}**（本期捐款 ${Number(b.donated || 0).toLocaleString('en-US')}）`);
  if (b.arrears) lines.push(`🔁 上期未繳補收　${money(gid, b.arrears)}（延過來一起收）`);
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
      name: '⚠️ 餘額不足，未繳延到下期',
      value: `應繳 ${money(gid, b.total)}，但你只有 ${money(gid, b.balance)}，這期**只課到餘額歸零**。未繳的 **${money(gid, b.total - b.paid)}** 會**延到下一次結算一起補收**（不會變成負債，也不會消失）。`,
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
    lines.push(c.income_flat
      ? `💰 **所得稅**　整筆跳級 ${range}，免稅 ${money(gid, c.income_free || 0)}`
      : `💰 **所得稅**　免稅 ${money(gid, c.income_free || 0)}，超過的部分累進 ${range}`);
    // 「不課」清單只列這台伺服器真的有開的功能 —— 玩家看到「不課：轉帳…」
    // 卻找不到轉帳指令（這台是關的），會以為說明寫錯或功能壞了。
    const gc2 = require('../../db').guildConfig('gather_config', gid);
    const notTaxed = [];
    if (gc2.transfer_enabled) notTaxed.push('轉帳');
    notTaxed.push('銀行存提款', '信貸本金', '退款');
    notTaxed.push('交易返還', '股票未實現漲跌');
    lines.push('　　⤷ 只課**這一期實際賺到的錢**：賣東西、任務、簽到等收入，'
      + '＋股票**賣掉之後**的淨損益（含買賣手續費）。\n'
      + `　　⤷ 不課：${notTaxed.join('、')}，以及你原本就有的資產與餘額。\n`
      + '　　⤷ ⚠️ **錢藏進銀行不會少課稅**：課的是「這一期賺了多少」，跟錢最後放在錢包還是銀行無關。'
      + '存款本身不課稅，但賺到的當下就已經算進所得了。');
  }
  if (c.partner_enabled) lines.push(`💞 **同居稅**　倍增累進：第 1 位 ${money(gid, c.partner_base || 0)}、`
    + `第 2 位 ×${c.partner_step || 2}、第 3 位 ×${Math.pow(c.partner_step || 2, 2)}…（同居人數已無上限，靠稅金節制）`);
  if (c.pet_enabled) lines.push(`🐾 **寵物稅**　倍增累進：第 1 隻 ${money(gid, c.pet_base || 0)}、`
    + `第 2 隻 ×${c.pet_step || 2}、第 3 隻 ×${Math.pow(c.pet_step || 2, 2)}…（寵物數量已無上限）`);
  if (c.house_enabled) lines.push(`🏡 **房屋稅**　房子越大稅越重（Lv.${(c.house_free || 0) + 1} 起課，指數成長），`
    + `另加家具 ${money(gid, c.house_furniture || 0)}／件`);
  lines.push('_四種稅各自獨立計算：所得稅看實際獲利、同居稅看角色數量、寵物稅看寵物數量、房屋稅看房屋持有。_');
  if (!lines.length) lines.push('目前沒有開徵稅金。');
  emb.setDescription(lines.join('\n'));

  // 你這期預估（本人最在意的）
  const a = assess(gid, userId);
  if (a) {
    const detail = [];
    if (a.income) detail.push(`💰所得 ${money(gid, a.income)}`);
    if (a.partner) detail.push(`💞同居 ${money(gid, a.partner)}（${a.partnerCount} 位）`);
    if (a.pet) detail.push(`🐾寵物 ${money(gid, a.pet)}（${a.counts.petCount} 隻）`);
    if (a.house) detail.push(`🏡房屋 ${money(gid, a.house)}（Lv.${a.counts.houseLv}）`);
    if (a.credit) detail.push(`❤️折抵 −${money(gid, a.credit)}`);
    if (a.arrears) detail.push(`🔁上期未繳補收 ${money(gid, a.arrears)}`);
    emb.addFields({
      name: '你這期預估要繳',
      value: (detail.length ? detail.join('　') + `\n**合計 ${money(gid, a.total)}**` : '本期免稅 🎉') + `　（餘額 ${money(gid, a.balance)}）`
    });
    // 所得稅是新制，玩家最會問「為什麼是這個數字」→ 把稅基攤開
    emb.addFields({
      name: '本期實際獲利（所得稅的計算基準）',
      value: `收入 ${money(gid, a.earned)}　股票已實現損益 ${a.stockPnl >= 0 ? '+' : '−'}${money(gid, Math.abs(a.stockPnl))}\n`
        + `→ 課稅所得 **${money(gid, a.incomeBase)}**（免稅額 ${money(gid, c.income_free || 0)}）\n`
        + '_轉帳、存提款、信貸本金、退款與股票未實現漲跌都不算在裡面。_'
    });
  }

  // 重點提醒濃縮成一欄，不再一堆欄位
  const notes = [c.no_debt ? '課稅只扣錢包、**不會課成負數**：錢不夠只課到 0，**未繳的延到下一次一起補收**（不會消失）' : '錢不夠會欠稅、餘額變負數'];
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

// 主動補繳累積的欠稅：從錢包扣、減 tax_arrears、錢進基金會池
function payArrears(gid, userId, amount) {
  const w = db.prepare('SELECT * FROM econ_wallets WHERE guild_id=? AND user_id=?').get(gid, userId);
  if (!w) return { ok: false, msg: '你還沒有錢包。' };
  const arrears = Math.max(0, w.tax_arrears || 0);
  if (arrears <= 0) return { ok: false, msg: '你目前沒有欠稅，不用補繳 🎉' };
  if (w.coins <= 0) return { ok: false, msg: `你目前餘額 ${money(gid, w.coins)}，沒有錢可以補繳，先賺一點再來。` };
  const want = amount != null ? Math.max(0, Math.floor(amount)) : arrears;
  const pay = Math.min(want, arrears, w.coins);
  if (pay <= 0) return { ok: false, msg: '沒有可補繳的金額。' };
  db.transaction(() => {
    db.prepare("UPDATE econ_wallets SET coins = coins - ?, tax_arrears = tax_arrears - ?, updated_at=datetime('now','localtime') WHERE guild_id=? AND user_id=?").run(pay, pay, gid, userId);
    require('./gather').logCoins(gid, userId, -pay, '補繳欠稅', '');
    require('./charity').addTax(gid, pay);   // 補的稅一樣進慈善基金會
    // 補繳也要留紀錄，不然「累計繳稅」成就算不到這筆（期間碼加 -補繳，跟正式稅單分開）
    db.prepare(
      `INSERT INTO tax_records (guild_id, period, user_id, username, balance, income_tax, land_tax, breed_tax, stock_tax, spend_tax, charity_credit, total, paid, detail)
       VALUES (?,?,?,?,?,0,0,0,0,0,0,?,?,?)`
    ).run(gid, periodCode() + '-補繳', userId, w.username || '', w.coins, pay, pay, JSON.stringify({ arrears: 1 }));
  })();
  const nw = db.prepare('SELECT coins, tax_arrears FROM econ_wallets WHERE guild_id=? AND user_id=?').get(gid, userId);
  return { ok: true, paid: pay, left: Math.max(0, nw.tax_arrears || 0), coins: nw.coins };
}

// 稅務面板要不要附「補繳欠稅」按鈕（有欠稅才顯示）
function arrearsRow(gid, userId) {
  const w = db.prepare('SELECT tax_arrears FROM econ_wallets WHERE guild_id=? AND user_id=?').get(gid, userId);
  if (!w || (w.tax_arrears || 0) <= 0) return [];
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tax:payArrears').setLabel(`補繳欠稅 ${Number(w.tax_arrears).toLocaleString('en-US')}`).setEmoji('💸').setStyle(ButtonStyle.Danger))];
}

function init(client) {
  // 冒險面板的 🧾稅務按鈕
  client.on('interactionCreate', async (i) => {
    if (i.isButton() && i.customId === 'tax:payArrears') {
      try {
        const r = payArrears(i.guildId, i.user.id);
        if (!r.ok) return await i.reply({ content: `❌ ${r.msg}`, flags: MessageFlags.Ephemeral });
        return await i.reply({ content: `✅ 已補繳欠稅 ${money(i.guildId, r.paid)}——${r.left > 0 ? `還欠 ${money(i.guildId, r.left)}` : '**欠稅全部繳清！**'}　目前餘額 ${money(i.guildId, r.coins)}`, flags: MessageFlags.Ephemeral });
      } catch (e) {
        logError(i.guildId, '補繳欠稅失敗：', e && e.stack ? e.stack : e);
        if (!i.replied && !i.deferred) i.reply({ content: '補繳時發生錯誤。', flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      return;
    }
    // 面板的 🧾 按鈕：玩家真正想看的是「我這期要繳多少」，而不是稅制說明。
    // 所以預設開自己的稅單，稅制規則改成稅單下面的一顆按鈕。
    if (!i.isButton() || (i.customId !== 'adv:tax' && i.customId !== 'taxrules')) return;
    try {
      const gid = i.guildId, c = cfg(gid);
      if (i.customId === 'taxrules') {
        return await i.reply({ embeds: [infoEmbed(gid, i.user.id, i.user.username)], flags: MessageFlags.Ephemeral });
      }
      if (!c.enabled) return await i.reply({ content: '這個伺服器目前沒有開徵稅金。', flags: MessageFlags.Ephemeral });
      if (isExempt(gid, i.user.id, i.member)) {
        return await i.reply({ content: '✅ 你在免稅名單內，不會被課稅。', flags: MessageFlags.Ephemeral });
      }
      const a = assess(gid, i.user.id);
      if (!a) return await i.reply({ content: '找不到錢包資料（先玩一下再來看稅單吧）。', flags: MessageFlags.Ephemeral });
      const last = db.prepare("SELECT * FROM tax_records WHERE guild_id=? AND user_id=? AND period NOT LIKE '%-補繳' ORDER BY id DESC LIMIT 1").get(gid, i.user.id);
      const emb = billEmbed(gid, a, null)
        .setTitle(`🧾 ${nameOf(i)} 的稅單預估`)
        .setFooter({
          text: last
            ? `上期（${last.period}）實繳 ${last.paid.toLocaleString('en-US')}　·　下次結算：${nextRunText(c)}`
            : `下次結算：${nextRunText(c)}`
        });
      const rows = arrearsRow(gid, i.user.id);
      const extra = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('taxrules').setLabel('📖 稅制說明').setStyle(ButtonStyle.Secondary));
      return await i.reply({ embeds: [emb], components: [...rows, extra], flags: MessageFlags.Ephemeral });
    } catch (e) {
      logError(i.guildId, '稅單面板失敗：', e && e.stack ? e.stack : e);
      if (!i.replied && !i.deferred) i.reply({ content: '查詢稅單時發生錯誤。', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  });

  client.on('interactionCreate', async (i) => {
    if (!i.isChatInputCommand() || i.commandName !== '稅單') return;
    try {
      const gid = i.guildId, c = cfg(gid);
      if (!c.enabled) {
        return i.reply({ content: '這個伺服器目前沒有開徵稅金。', flags: MessageFlags.Ephemeral });
      }
      const { resolveTarget } = require('../privacy');
      const t = resolveTarget(i, 'tax');
      if (t.denied) return i.reply({ content: t.denied, flags: MessageFlags.Ephemeral });
      const target = t.user;
      if (isExempt(gid, target.id, i.guild && i.guild.members.cache.get(target.id))) {
        return i.reply({ content: `✅ ${nameOf(i, target)} 在免稅名單內，不會被課稅。`, flags: MessageFlags.Ephemeral });
      }
      const a = assess(gid, target.id);
      if (!a) return i.reply({ content: '找不到錢包資料（先玩一下再來看稅單吧）。', flags: MessageFlags.Ephemeral });
      const last = db.prepare(
        "SELECT * FROM tax_records WHERE guild_id=? AND user_id=? AND period NOT LIKE '%-補繳' ORDER BY id DESC LIMIT 1"
      ).get(gid, target.id);
      const emb = billEmbed(gid, a, null)
        .setTitle(`🧾 ${nameOf(i, target)} 的稅單預估`)
        .setFooter({
          text: last
            ? `上期（${last.period}）實繳 ${last.paid.toLocaleString('en-US')}　·　下次結算：${nextRunText(c)}`
            : `下次結算：${nextRunText(c)}`
        });
      // 查自己的稅單且有欠稅 → 附「補繳欠稅」按鈕
      const comps = target.id === i.user.id ? arrearsRow(gid, i.user.id) : [];
      return i.reply({ embeds: [emb], components: comps, flags: MessageFlags.Ephemeral });
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
  // 後台跑在秘書的行程，那邊沒有這個模組 → 走 bot_jobs 派工過來
  client._jobHandlers = client._jobHandlers || {};
  client._jobHandlers.run_tax = ({ guildId, opts }) => runGuild(client, guildId, opts);
  console.log('  ↳ 稅金模組已載入（農地稅／養殖稅／房屋稅／所得稅，每分鐘檢查結算時間；面板 🧾我的稅單）');
}

const DOW = ['日', '一', '二', '三', '四', '五', '六'];
function nextRunText(c) {
  if (c.period === 'day') return `每日 ${c.run_time}`;
  if (c.period === 'month') return `每月 ${c.dom} 號 ${c.run_time}`;
  return `每週${DOW[c.dow ?? 1]} ${c.run_time}`;
}

module.exports = { init, assess, runGuild, incomeTax, DEFAULT_BRACKETS, nextRunText, infoEmbed, isExempt, planRelief, liquidate, runLiquidation };
