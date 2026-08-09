// 物資貸款：拿「工具／農地作物／魚缸的魚」當抵押品借星幣
//   ・可借金額＝抵押品估值 × LTV%（預設 70%）
//   ・抵押品由系統代管：借出期間工具不能用（禁止徒手＝不能採集）、作物收不到、魚不產錢
//   ・到期還不出來 → 沒收抵押品（延後版的強制清算，給人喘息空間）
// 為什麼不押股票／背包：欠稅的強制清算已經在收股票，這裡故意只收「生產工具」，
// 讓借錢的代價是「暫時少賺」，還得出來就全部原封不動還回去。
const { EmbedBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const cron = require('node-cron');
const { db, guildConfig, activeGuildIds, logError } = require('../../db');
const { brandColor } = require('../../util/brand');
const { livePrice } = require('../../util/market');

const cfg = (gid) => guildConfig('loan_config', gid);
const gcfg = (gid) => guildConfig('gather_config', gid);
const money = (gid, n) => {
  const c = gcfg(gid);
  return `${c.currency_emoji || '🪙'} ${Number(n || 0).toLocaleString('en-US')} ${c.currency_name || '星幣'}`;
};

const KINDS = ['tool', 'crop', 'fish'];
const KIND_LABEL = { tool: '🔨 工具', crop: '🌾 農地作物', fish: '🐠 魚缸的魚' };
const FISH_SELL_PCT = 0.5;   // 魚的回收比例，與 aquarium.js／強制清算一致

function order(gid) {
  const list = String(cfg(gid).collateral_order || 'tool,crop,fish').split(/[\s,;、]+/)
    .map(x => x.trim()).filter(x => KINDS.includes(x));
  return list.length ? list : KINDS;
}

// ---- 抵押品清單與估值（只看不動）----
function assets(gid, userId) {
  const out = [];

  // 工具：估值＝售價 × 剩餘耐久比例（會壞的工具押到快壞就借不多）
  for (const t of db.prepare(
    `SELECT t.id, t.name, t.emoji, t.price, t.durability, t.kind, u.uses_left
       FROM gather_user_tools u JOIN gather_tools t ON t.id=u.tool_id
      WHERE u.guild_id=? AND u.user_id=? AND t.guild_id=? AND t.price>0`).all(gid, userId, gid)) {
    const ratio = t.durability > 0 ? Math.max(0, Math.min(1, (t.uses_left ?? t.durability) / t.durability)) : 1;
    const value = Math.floor(t.price * ratio);
    if (value > 0) out.push({ kind: 'tool', refId: t.id, slot: -1, qty: t.uses_left ?? t.durability, pending: 0, value, detail: `${t.emoji || ''}${t.name}`, meta: '' });
  }

  // 農地／溫室作物：估值＝收成物的即時賣價 × 產量（查不到就用種子價）
  for (const p of db.prepare(
    `SELECT p.plot_type, p.slot, p.seed_id, p.ready_at, p.planted_at, s.name, s.emoji, s.seed_price, s.yield_count, s.product_item_id
       FROM crop_plots p JOIN crop_seeds s ON s.id=p.seed_id
      WHERE p.guild_id=? AND p.user_id=?`).all(gid, userId)) {
    let unit = 0;
    if (p.product_item_id) {
      const it = db.prepare('SELECT * FROM gather_items WHERE id=? AND guild_id=?').get(p.product_item_id, gid);
      if (it) unit = livePrice(gid, it);
    }
    const value = Math.max(0, unit > 0 ? unit * Math.max(1, p.yield_count || 1) : (p.seed_price || 0));
    if (value > 0) {
      out.push({
        kind: 'crop', refId: p.seed_id, slot: p.slot, qty: 1, pending: 0, value,
        detail: `${p.emoji || ''}${p.name}（${p.plot_type === 'greenhouse' ? '溫室' : '農地'} 第 ${p.slot + 1} 格）`,
        meta: JSON.stringify({ plot_type: p.plot_type, ready_at: p.ready_at, planted_at: p.planted_at })
      });
    }
  }

  // 魚缸的魚：估值＝回收半價 ＋ 未領取的星幣（贖回時未領取的錢一起還回去）
  for (const f of db.prepare(
    `SELECT a.slot, a.pending, a.last_produce_ms, a.fed_until_ms, f.id, f.name, f.emoji, f.price
       FROM aquarium_slots a JOIN aquarium_fish f ON f.id=a.fish_id
      WHERE a.guild_id=? AND a.user_id=?`).all(gid, userId)) {
    const value = Math.max(0, Math.floor((f.price || 0) * FISH_SELL_PCT)) + (f.pending || 0);
    if (value > 0) {
      out.push({
        kind: 'fish', refId: f.id, slot: f.slot, qty: 1, pending: f.pending || 0, value,
        detail: `${f.emoji || ''}${f.name}（魚缸 第 ${f.slot + 1} 格）`,
        meta: JSON.stringify({ last_produce_ms: f.last_produce_ms, fed_until_ms: f.fed_until_ms })
      });
    }
  }
  return out;
}

const openLoans = (gid, userId) =>
  db.prepare("SELECT * FROM loans WHERE guild_id=? AND user_id=? AND status='open' ORDER BY id ASC").all(gid, userId);
const collateralsOf = (loanId) => db.prepare('SELECT * FROM loan_collaterals WHERE loan_id=? ORDER BY value DESC').all(loanId);

// 已被代管的抵押品不能再押第二次（工具靠 tool_id、作物與魚靠格子比對）
function freeAssets(gid, userId) {
  const held = db.prepare(
    `SELECT c.kind, c.ref_id, c.slot FROM loan_collaterals c JOIN loans l ON l.id=c.loan_id
      WHERE l.guild_id=? AND l.user_id=? AND l.status='open'`).all(gid, userId);
  const key = (x) => `${x.kind}:${x.ref_id ?? x.refId}:${x.slot}`;
  const heldSet = new Set(held.map(h => `${h.kind}:${h.ref_id}:${h.slot}`));
  return assets(gid, userId).filter(a => !heldSet.has(key(a)));
}

// 借 amount 需要的抵押品：照設定的類別順序，每類「便宜的先押」，湊到夠了就停。
// 便宜的先押＝盡量少押到貴的東西，對玩家有利。
function pick(gid, userId, amount) {
  const c = cfg(gid);
  const ltv = Math.max(1, Math.min(100, c.ltv_pct || 70));
  const need = Math.ceil(amount * 100 / ltv);        // 需要的抵押品估值
  const pool = freeAssets(gid, userId);
  const picked = [];
  let got = 0;
  for (const kind of order(gid)) {
    if (got >= need) break;
    for (const a of pool.filter(x => x.kind === kind).sort((x, y) => x.value - y.value)) {
      if (got >= need) break;
      picked.push(a); got += a.value;
    }
  }
  const maxLoan = Math.floor(pool.reduce((s, a) => s + a.value, 0) * ltv / 100);
  return { picked, collateralValue: got, need, enough: got >= need, maxLoan, ltv };
}

// ---- 借款 ----
function borrow(gid, userId, username, amount) {
  const c = cfg(gid);
  if (!c.enabled) return { ok: false, msg: '這個伺服器目前沒有開放物資貸款。' };
  const w = db.prepare('SELECT * FROM econ_wallets WHERE guild_id=? AND user_id=?').get(gid, userId);
  if (!w) return { ok: false, msg: '你還沒有錢包（先玩一下再來借吧）。' };
  if (c.debtor_only && w.coins >= 0) return { ok: false, msg: '目前只有**餘額是負數（欠稅／負債）**的人才能貸款。' };
  const openAsset = db.prepare("SELECT COUNT(*) n FROM loans WHERE guild_id=? AND user_id=? AND status='open' AND loan_type='asset'").get(gid, userId).n;
  if (openAsset >= Math.max(1, c.max_open || 1)) {
    return { ok: false, msg: `你已經有 ${openAsset} 筆未還清的物資貸款（同時上限 ${Math.max(1, c.max_open || 1)} 筆），先用 \`/還款\` 還掉再借。` };
  }
  let amt = Math.floor(Number(amount) || 0);
  if (amt <= 0) return { ok: false, msg: '借款金額要大於 0。' };
  if (c.max_loan > 0 && amt > c.max_loan) return { ok: false, msg: `單筆貸款上限是 ${money(gid, c.max_loan)}。` };

  const q = pick(gid, userId, amt);
  if (!q.enough) {
    return {
      ok: false,
      msg: q.maxLoan > 0
        ? `你的可抵押物資不夠：最多只能借 ${money(gid, q.maxLoan)}（抵押率 ${q.ltv}%）。`
        : '你沒有可以抵押的物資（可抵押：工具、農地／溫室的作物、魚缸的魚）。'
    };
  }

  const interest = Math.ceil(amt * Math.max(0, c.interest_pct || 0) / 100);
  const dueMs = Date.now() + Math.max(1, c.term_days || 7) * 86400000;

  // 借的錢從基金會池出：池不夠就不能借
  const charity = require('./charity');
  if (charity.cfg(gid).enabled && (charity.cfg(gid).pool || 0) < amt) {
    return { ok: false, msg: `慈善基金會目前餘額不足以放貸（池只剩 ${money(gid, charity.cfg(gid).pool || 0)}），請改小金額或稍後再試。` };
  }
  const loanId = db.transaction(() => {
    charity.fundPay(gid, amt);   // 從基金會池扣出借款
    const info = db.prepare(
      `INSERT INTO loans (guild_id,user_id,username,principal,interest,owed,collateral_value,status,due_ms)
       VALUES (?,?,?,?,?,?,?,'open',?)`
    ).run(gid, userId, username || '', amt, interest, amt + interest, q.collateralValue, dueMs);
    const id = info.lastInsertRowid;
    const ins = db.prepare(
      'INSERT INTO loan_collaterals (loan_id,guild_id,kind,ref_id,slot,qty,pending,meta,value,detail) VALUES (?,?,?,?,?,?,?,?,?,?)');
    for (const a of q.picked) {
      // 從玩家身上「拿走」抵押品（代管），借款期間不能用
      if (a.kind === 'tool') {
        db.prepare('DELETE FROM gather_user_tools WHERE guild_id=? AND user_id=? AND tool_id=?').run(gid, userId, a.refId);
      } else if (a.kind === 'crop') {
        const meta = JSON.parse(a.meta || '{}');
        db.prepare('DELETE FROM crop_plots WHERE guild_id=? AND user_id=? AND plot_type=? AND slot=?')
          .run(gid, userId, meta.plot_type || 'field', a.slot);
      } else if (a.kind === 'fish') {
        db.prepare('DELETE FROM aquarium_slots WHERE guild_id=? AND user_id=? AND slot=?').run(gid, userId, a.slot);
      }
      ins.run(id, gid, a.kind, a.refId, a.slot, a.qty, a.pending, a.meta, a.value, a.detail);
    }
    // 借到的錢不計入 total_earned：借款不是收入，不該被所得稅當成本期賺到的錢
    db.prepare("UPDATE econ_wallets SET coins = coins + ?, updated_at = datetime('now','localtime') WHERE guild_id=? AND user_id=?")
      .run(amt, gid, userId);
    return id;
  })();

  const loan = db.prepare('SELECT * FROM loans WHERE id=?').get(loanId);
  return { ok: true, loan, picked: q.picked, coins: db.prepare('SELECT coins FROM econ_wallets WHERE guild_id=? AND user_id=?').get(gid, userId).coins };
}

// ---- 信用貸款（免抵押）----
// 不押任何資產，靠信用借小額；到期沒還就直接把應還金額從錢包扣掉（餘額可負），賴不掉。
function borrowCredit(gid, userId, username, amount) {
  const c = cfg(gid);
  if (!c.credit_enabled) return { ok: false, msg: '這個伺服器目前沒有開放信用貸款。' };
  const w = db.prepare('SELECT * FROM econ_wallets WHERE guild_id=? AND user_id=?').get(gid, userId);
  if (!w) return { ok: false, msg: '你還沒有錢包（先玩一下再來借吧）。' };
  const openC = db.prepare("SELECT COUNT(*) n FROM loans WHERE guild_id=? AND user_id=? AND status='open' AND loan_type='credit'").get(gid, userId).n;
  if (openC >= Math.max(1, c.credit_max_open || 1)) {
    return { ok: false, msg: `你已經有 ${openC} 筆未還清的信用貸款（同時上限 ${Math.max(1, c.credit_max_open || 1)} 筆），先用 \`/還款\` 還掉再借。` };
  }
  const amt = Math.floor(Number(amount) || 0);
  if (amt <= 0) return { ok: false, msg: '借款金額要大於 0。' };
  const max = Math.max(1, c.credit_max || 50000);
  if (amt > max) return { ok: false, msg: `信用貸款單筆上限是 ${money(gid, max)}。` };
  const interest = Math.ceil(amt * Math.max(0, c.credit_interest_pct || 0) / 100);
  const dueMs = Date.now() + Math.max(1, c.credit_term_days || 7) * 86400000;
  // 借的錢從基金會池出：池不夠就不能借
  const charity = require('./charity');
  if (charity.cfg(gid).enabled && (charity.cfg(gid).pool || 0) < amt) {
    return { ok: false, msg: `慈善基金會目前餘額不足以放貸（池只剩 ${money(gid, charity.cfg(gid).pool || 0)}），請改小金額或稍後再試。` };
  }
  const loanId = db.transaction(() => {
    charity.fundPay(gid, amt);   // 從基金會池扣出借款
    const info = db.prepare(
      `INSERT INTO loans (guild_id,user_id,username,principal,interest,owed,collateral_value,status,due_ms,loan_type)
       VALUES (?,?,?,?,?,?,0,'open',?,'credit')`
    ).run(gid, userId, username || '', amt, interest, amt + interest, dueMs);
    // 借到的錢不算收入，不會被多課所得稅（跟物資貸款一致）
    db.prepare("UPDATE econ_wallets SET coins = coins + ?, updated_at = datetime('now','localtime') WHERE guild_id=? AND user_id=?").run(amt, gid, userId);
    return info.lastInsertRowid;
  })();
  const loan = db.prepare('SELECT * FROM loans WHERE id=?').get(loanId);
  return { ok: true, loan, coins: db.prepare('SELECT coins FROM econ_wallets WHERE guild_id=? AND user_id=?').get(gid, userId).coins };
}

// ---- 贖回抵押品（還清時）----
// 原本的格子被佔走了就沒辦法塞回去 → 折現成星幣還給玩家（照當初估值）。
function giveBack(gid, userId, loanId) {
  const back = [], cash = [];
  for (const c of collateralsOf(loanId)) {
    const meta = (() => { try { return JSON.parse(c.meta || '{}'); } catch { return {}; } })();
    let ok = false;
    if (c.kind === 'tool') {
      db.prepare('INSERT OR REPLACE INTO gather_user_tools (guild_id,user_id,tool_id,uses_left) VALUES (?,?,?,?)')
        .run(gid, userId, c.ref_id, c.qty);
      ok = true;
    } else if (c.kind === 'crop') {
      const r = db.prepare(
        `INSERT OR IGNORE INTO crop_plots (guild_id,user_id,plot_type,slot,seed_id,ready_at,planted_at)
         VALUES (?,?,?,?,?,?,?)`
      ).run(gid, userId, meta.plot_type || 'field', c.slot, c.ref_id, meta.ready_at || 0, meta.planted_at || '');
      ok = r.changes > 0;
    } else if (c.kind === 'fish') {
      const r = db.prepare(
        `INSERT OR IGNORE INTO aquarium_slots (guild_id,user_id,slot,fish_id,pending,last_produce_ms,fed_until_ms)
         VALUES (?,?,?,?,?,?,?)`
      ).run(gid, userId, c.slot, c.ref_id, c.pending, meta.last_produce_ms || 0, meta.fed_until_ms || 0);
      ok = r.changes > 0;
    }
    if (ok) back.push(c);
    else {
      // 格子被佔走：折現
      db.prepare("UPDATE econ_wallets SET coins = coins + ?, updated_at = datetime('now','localtime') WHERE guild_id=? AND user_id=?")
        .run(c.value, gid, userId);
      cash.push(c);
    }
  }
  db.prepare('DELETE FROM loan_collaterals WHERE loan_id=?').run(loanId);
  return { back, cash };
}

// ---- 還款 ----（不填金額＝把最早那筆全部還清）
function repay(gid, userId, amount) {
  const open = openLoans(gid, userId);
  if (!open.length) return { ok: false, msg: '你目前沒有未還清的貸款。' };
  const loan = open[0];
  const w = db.prepare('SELECT * FROM econ_wallets WHERE guild_id=? AND user_id=?').get(gid, userId);
  let amt = amount == null ? loan.owed : Math.floor(Number(amount) || 0);
  if (amt <= 0) return { ok: false, msg: '還款金額要大於 0。' };
  amt = Math.min(amt, loan.owed);
  if (!w || w.coins < amt) return { ok: false, msg: `餘額不足：要還 ${money(gid, amt)}，你只有 ${money(gid, w ? w.coins : 0)}。` };

  const res = db.transaction(() => {
    db.prepare("UPDATE econ_wallets SET coins = coins - ?, updated_at = datetime('now','localtime') WHERE guild_id=? AND user_id=?")
      .run(amt, gid, userId);
    require('./charity').fundGet(gid, amt);   // 還的錢回基金會池（利息也回，基金會會變大）
    const left = loan.owed - amt;
    db.prepare('UPDATE loans SET owed=? WHERE id=?').run(left, loan.id);
    if (left > 0) return { cleared: false, left };
    db.prepare("UPDATE loans SET status='repaid', closed_at=datetime('now','localtime') WHERE id=?").run(loan.id);
    return { cleared: true, left: 0, ...giveBack(gid, userId, loan.id) };
  })();
  return { ok: true, loan, paid: amt, ...res, coins: db.prepare('SELECT coins FROM econ_wallets WHERE guild_id=? AND user_id=?').get(gid, userId).coins };
}

// ---- 到期沒還 → 沒收抵押品 ----
function defaultLoan(gid, loan) {
  db.transaction(() => {
    // 信用貸款沒有抵押品 → 直接把應還金額從錢包扣掉（餘額可負），賴不掉；扣回的錢回基金會池
    if (loan.loan_type === 'credit') {
      db.prepare("UPDATE econ_wallets SET coins = coins - ?, updated_at=datetime('now','localtime') WHERE guild_id=? AND user_id=?").run(loan.owed, gid, loan.user_id);
      require('./charity').fundGet(gid, loan.owed);
    }
    db.prepare("UPDATE loans SET status='defaulted', closed_at=datetime('now','localtime') WHERE id=?").run(loan.id);
    db.prepare('DELETE FROM loan_collaterals WHERE loan_id=?').run(loan.id);   // 物資貸款：抵押品沒收（本來就已經不在玩家身上）
  })();
}

async function sweepOverdue(client, gid) {
  const c = cfg(gid);
  if (!c.enabled && !c.credit_enabled) return [];
  const due = db.prepare("SELECT * FROM loans WHERE guild_id=? AND status='open' AND due_ms>0 AND due_ms<=?").all(gid, Date.now());
  const out = [];
  for (const loan of due) {
    const items = collateralsOf(loan.id);
    defaultLoan(gid, loan);
    out.push({ loan, items });
    const u = await client.users.fetch(loan.user_id).catch(() => null);
    const emb = loan.loan_type === 'credit'
      ? new EmbedBuilder().setColor(brandColor())
        .setTitle('⚠️ 信用貸款到期未還，已直接扣款')
        .setDescription(`信用借款 ${money(gid, loan.principal)}（應還 ${money(gid, loan.owed)}）到期未還，已直接從你的餘額扣掉 **${money(gid, loan.owed)}**（餘額可能因此變負數）。`)
        .setFooter({ text: '信用貸款沒有抵押品、賴不掉——把餘額賺回正數就好' })
      : new EmbedBuilder().setColor(brandColor())
        .setTitle('⚠️ 貸款到期未還，抵押品已被沒收')
        .setDescription(`借款 ${money(gid, loan.principal)}（含利息應還 ${money(gid, loan.principal + loan.interest)}），到期仍欠 ${money(gid, loan.owed)}。`)
        .addFields({ name: '被沒收的抵押品', value: items.map(x => `・${x.detail} — 估值 ${money(gid, x.value)}`).join('\n').slice(0, 1024) || '—' })
        .setFooter({ text: '債務已一併結清，之後可以重新貸款' });
    if (u) await u.send({ embeds: [emb] }).catch(() => {});
    if (c.channel) {
      const ch = await client.channels.fetch(c.channel).catch(() => null);
      if (ch) await ch.send({ embeds: [emb.setDescription(`<@${loan.user_id}> ` + emb.data.description)] }).catch(() => {});
    }
  }
  return out;
}

// ---- 查詢畫面 ----
function infoEmbed(gid, userId) {
  const c = cfg(gid);
  const emb = new EmbedBuilder().setColor(brandColor()).setTitle('🏦 物資貸款');
  if (!c.enabled) {
    return emb.setDescription('這個伺服器目前**沒有開放物資貸款**。');
  }
  const w = db.prepare('SELECT * FROM econ_wallets WHERE guild_id=? AND user_id=?').get(gid, userId);
  emb.setDescription(
    `拿**工具／農地作物／魚缸的魚**當抵押品借星幣，可借 ＝ 抵押品估值 × **${c.ltv_pct || 70}%**。\n`
    + `期限 **${Math.max(1, c.term_days || 7)} 天**，利息 **${c.interest_pct || 0}%**（借出時就算進應還金額）。\n`
    + `抵押品由系統代管：**工具押出去就不能採集**（禁止徒手）、作物收不到成、魚不產星幣。\n`
    + `還清 → 抵押品**原封不動還你**；到期沒還 → **沒收抵押品**、債務一併結清。`
    + (c.debtor_only ? '\n⚠️ 目前只有**餘額是負數**的人可以貸款。' : '')
  );

  const open = openLoans(gid, userId);
  if (open.length) {
    for (const l of open) {
      const items = collateralsOf(l.id);
      emb.addFields({
        name: `📄 未還貸款 #${l.id}　還欠 ${money(gid, l.owed)}`,
        value: `借了 ${money(gid, l.principal)}　利息 ${money(gid, l.interest)}\n`
          + `到期：<t:${Math.floor(l.due_ms / 1000)}:f>（<t:${Math.floor(l.due_ms / 1000)}:R>）\n`
          + `抵押中：${items.map(x => x.detail).join('、').slice(0, 700) || '—'}\n`
          + `用 \`/還款\` 全部還清就能贖回。`
      });
    }
  }

  const free = freeAssets(gid, userId);
  const ltv = Math.max(1, Math.min(100, c.ltv_pct || 70));
  const total = free.reduce((s, a) => s + a.value, 0);
  let maxLoan = Math.floor(total * ltv / 100);
  if (c.max_loan > 0) maxLoan = Math.min(maxLoan, c.max_loan);
  const byKind = KINDS.map(k => {
    const rows = free.filter(a => a.kind === k);
    return rows.length ? `${KIND_LABEL[k]}　${rows.length} 項　估值 ${money(gid, rows.reduce((s, a) => s + a.value, 0))}` : null;
  }).filter(Boolean);
  emb.addFields({
    name: '你可以抵押的物資',
    value: (byKind.join('\n') || '沒有可抵押的物資。')
      + `\n\n**目前最多可借 ${money(gid, maxLoan)}**`
      + (open.length >= Math.max(1, c.max_open || 1) ? '（但你已達同時貸款上限，要先還清）' : '')
      + (w ? `\n目前餘額 ${money(gid, w.coins)}` : '')
  });
  const past = db.prepare("SELECT status, COUNT(*) n FROM loans WHERE guild_id=? AND user_id=? AND status<>'open' GROUP BY status").all(gid, userId);
  if (past.length) {
    emb.addFields({
      name: '過往紀錄',
      value: past.map(p => `${p.status === 'repaid' ? '✅ 已還清' : '❌ 違約沒收'}　${p.n} 筆`).join('　')
    });
  }
  if (c.credit_enabled) {
    emb.addFields({
      name: '🪪 也可以「信用貸款」（免抵押）',
      value: `不用押任何東西，直接借 —— 單筆最多 **${money(gid, c.credit_max || 50000)}**、利息 ${c.credit_interest_pct || 0}%、期限 ${Math.max(1, c.credit_term_days || 7)} 天。\n`
        + `⚠️ 沒有抵押品、賴不掉：**到期沒還會直接從你的餘額扣款**（可能變負數）。\n用 \`/信用貸款 金額\` 借。`
    });
  }
  return emb.setFooter({ text: '用 /貸款 金額（物資）或 /信用貸款 金額（免抵押）借錢　·　/還款 還錢' });
}

async function announceBorrow(client, gid, userId, r) {
  const c = cfg(gid);
  if (!c.channel) return;
  const ch = await client.channels.fetch(c.channel).catch(() => null);
  if (!ch) return;
  await ch.send({
    embeds: [new EmbedBuilder().setColor(brandColor())
      .setTitle('🏦 有人辦了物資貸款')
      .setDescription(`<@${userId}> 借了 **${money(gid, r.loan.principal)}**（應還 ${money(gid, r.loan.owed)}）`)
      .addFields({ name: '抵押品', value: r.picked.map(x => `・${x.detail}`).join('\n').slice(0, 1024) })
      .setFooter({ text: `到期沒還就沒收抵押品` })]
  }).catch(() => {});
}

function init(client) {
  client.on('interactionCreate', async (i) => {
    try {
      // 貸款面板按鈕：查詢 + 三顆動作鈕（免記指令）
      if (i.isButton() && i.customId === 'adv:loan') {
        const lc = cfg(i.guildId);
        const btns = [new ButtonBuilder().setCustomId('loan:borrow').setLabel('物資借款').setEmoji('🏦').setStyle(ButtonStyle.Primary)];
        if (lc.credit_enabled) btns.push(new ButtonBuilder().setCustomId('loan:credit').setLabel('信用借款').setEmoji('🪪').setStyle(ButtonStyle.Primary));
        btns.push(new ButtonBuilder().setCustomId('loan:repay').setLabel('還款').setEmoji('💸').setStyle(ButtonStyle.Success));
        return await i.reply({ embeds: [infoEmbed(i.guildId, i.user.id)], components: [new ActionRowBuilder().addComponents(btns)], flags: MessageFlags.Ephemeral });
      }
      // 三顆按鈕 → 跳出輸入金額的視窗
      if (i.isButton() && (i.customId === 'loan:borrow' || i.customId === 'loan:credit' || i.customId === 'loan:repay')) {
        const map = {
          'loan:borrow': ['loan:borrowModal', '物資借款', '要借多少星幣？（會自動挑抵押品）', false],
          'loan:credit': ['loan:creditModal', '信用借款（免抵押）', '要借多少星幣？', false],
          'loan:repay': ['loan:repayModal', '還款', '要還多少？（留空＝全部還清）', true]
        };
        const [mid, title, label, optional] = map[i.customId];
        const modal = new ModalBuilder().setCustomId(mid).setTitle(title)
          .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('amount').setLabel(label).setStyle(TextInputStyle.Short)
              .setPlaceholder('例如 10000').setRequired(!optional)));
        return await i.showModal(modal).catch(() => {});
      }
      // 送出借/還款視窗
      if (i.isModalSubmit() && (i.customId === 'loan:borrowModal' || i.customId === 'loan:creditModal' || i.customId === 'loan:repayModal')) {
        const gid = i.guildId;
        const raw = String(i.fields.getTextInputValue('amount') || '').replace(/[^\d]/g, '');
        const amt = raw ? parseInt(raw, 10) : null;
        if (i.customId === 'loan:repayModal') {
          const r = repay(gid, i.user.id, amt);
          if (!r.ok) return await i.reply({ content: `❌ ${r.msg}`, flags: MessageFlags.Ephemeral });
          const emb = new EmbedBuilder().setColor(brandColor()).setTitle(r.cleared ? '✅ 貸款已還清' : '💸 已部分還款')
            .setDescription(`還了 **${money(gid, r.paid)}**，目前餘額 ${money(gid, r.coins)}`
              + (r.cleared ? '' : `\n這筆貸款還欠 **${money(gid, r.left)}**（全部還清才會贖回抵押品）`));
          if (r.cleared && r.back && r.back.length) emb.addFields({ name: '贖回的抵押品', value: r.back.map(x => `・${x.detail}`).join('\n').slice(0, 1024) });
          if (r.cleared && r.cash && r.cash.length) emb.addFields({ name: '格子被佔走，改折現還你', value: r.cash.map(x => `・${x.detail} → ${money(gid, x.value)}`).join('\n').slice(0, 1024) });
          return await i.reply({ embeds: [emb], flags: MessageFlags.Ephemeral });
        }
        const isCredit = i.customId === 'loan:creditModal';
        const r = isCredit ? borrowCredit(gid, i.user.id, i.user.username, amt) : borrow(gid, i.user.id, i.user.username, amt);
        if (!r.ok) return await i.reply({ content: `❌ ${r.msg}`, flags: MessageFlags.Ephemeral });
        const emb = new EmbedBuilder().setColor(brandColor())
          .setTitle(isCredit ? '🪪 信用貸款成功' : '🏦 貸款成功')
          .setDescription(`借到 **${money(gid, r.loan.principal)}**（利息 ${money(gid, r.loan.interest)}，應還 **${money(gid, r.loan.owed)}**）\n`
            + `目前餘額 ${money(gid, r.coins)}\n到期：<t:${Math.floor(r.loan.due_ms / 1000)}:R>`);
        if (!isCredit && r.picked) emb.addFields({ name: '被代管的抵押品（還清就還你）', value: r.picked.map(x => `・${x.detail} — 估值 ${money(gid, x.value)}`).join('\n').slice(0, 1024) });
        else emb.setFooter({ text: '到期沒還會直接從餘額扣款（可能變負數）' });
        return await i.reply({ embeds: [emb], flags: MessageFlags.Ephemeral });
      }
      if (!i.isChatInputCommand()) return;
      const gid = i.guildId;

      if (i.commandName === '貸款') {
        const amount = i.options.getInteger('金額');
        if (amount == null) return await i.reply({ embeds: [infoEmbed(gid, i.user.id)], flags: MessageFlags.Ephemeral });
        const r = borrow(gid, i.user.id, i.user.username, amount);
        if (!r.ok) return await i.reply({ content: `❌ ${r.msg}`, flags: MessageFlags.Ephemeral });
        const emb = new EmbedBuilder().setColor(brandColor())
          .setTitle('🏦 貸款成功')
          .setDescription(`借到 **${money(gid, r.loan.principal)}**（利息 ${money(gid, r.loan.interest)}，應還 **${money(gid, r.loan.owed)}**）\n`
            + `目前餘額 ${money(gid, r.coins)}\n到期：<t:${Math.floor(r.loan.due_ms / 1000)}:f>（<t:${Math.floor(r.loan.due_ms / 1000)}:R>）`)
          .addFields({
            name: '被代管的抵押品（還清就還你）',
            value: r.picked.map(x => `・${x.detail} — 估值 ${money(gid, x.value)}`).join('\n').slice(0, 1024)
          })
          .setFooter({ text: '工具被押走期間不能採集；到期沒還會沒收抵押品' });
        return await i.reply({ embeds: [emb], flags: MessageFlags.Ephemeral });
      }

      if (i.commandName === '信用貸款') {
        const amount = i.options.getInteger('金額');
        if (amount == null) return await i.reply({ embeds: [infoEmbed(gid, i.user.id)], flags: MessageFlags.Ephemeral });
        const r = borrowCredit(gid, i.user.id, i.user.username, amount);
        if (!r.ok) return await i.reply({ content: `❌ ${r.msg}`, flags: MessageFlags.Ephemeral });
        const emb = new EmbedBuilder().setColor(brandColor())
          .setTitle('🪪 信用貸款成功')
          .setDescription(`免抵押借到 **${money(gid, r.loan.principal)}**（利息 ${money(gid, r.loan.interest)}，應還 **${money(gid, r.loan.owed)}**）\n`
            + `目前餘額 ${money(gid, r.coins)}\n到期：<t:${Math.floor(r.loan.due_ms / 1000)}:f>（<t:${Math.floor(r.loan.due_ms / 1000)}:R>）`)
          .setFooter({ text: '到期沒還會直接從餘額扣款（可能變負數）；用 /還款 還錢' });
        return await i.reply({ embeds: [emb], flags: MessageFlags.Ephemeral });
      }

      if (i.commandName === '還款') {
        const amount = i.options.getInteger('金額');
        const r = repay(gid, i.user.id, amount == null ? null : amount);
        if (!r.ok) return await i.reply({ content: `❌ ${r.msg}`, flags: MessageFlags.Ephemeral });
        const emb = new EmbedBuilder().setColor(brandColor()).setTitle(r.cleared ? '✅ 貸款已還清' : '💸 已部分還款')
          .setDescription(`還了 **${money(gid, r.paid)}**，目前餘額 ${money(gid, r.coins)}`
            + (r.cleared ? '' : `\n這筆貸款還欠 **${money(gid, r.left)}**（抵押品要全部還清才會贖回）`));
        if (r.cleared) {
          if (r.back && r.back.length) emb.addFields({ name: '贖回的抵押品', value: r.back.map(x => `・${x.detail}`).join('\n').slice(0, 1024) });
          if (r.cash && r.cash.length) {
            emb.addFields({
              name: '格子被佔走，改折現還你',
              value: r.cash.map(x => `・${x.detail} → ${money(gid, x.value)}`).join('\n').slice(0, 1024)
            });
          }
        }
        return await i.reply({ embeds: [emb], flags: MessageFlags.Ephemeral });
      }
    } catch (e) {
      logError(i.guildId, '物資貸款操作失敗：', e && e.stack ? e.stack : e);
      if (!i.replied && !i.deferred) i.reply({ content: '處理貸款時發生錯誤。', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  });

  // 每 10 分鐘掃一次到期未還的貸款
  cron.schedule('*/10 * * * *', async () => {
    for (const gid of activeGuildIds()) {
      try { await sweepOverdue(client, gid); }
      catch (e) { logError(gid, '貸款到期處理失敗：', e && e.stack ? e.stack : e); }
    }
  }, { timezone: 'Asia/Taipei' });

  client._sweepLoans = (gid) => sweepOverdue(client, gid);
  console.log('  ↳ 物資貸款已載入（/貸款、/還款；抵押工具／作物／魚，到期沒收）');
}

module.exports = { init, cfg, assets, freeAssets, pick, borrow, borrowCredit, repay, giveBack, sweepOverdue, infoEmbed, openLoans, collateralsOf, KINDS, KIND_LABEL };
