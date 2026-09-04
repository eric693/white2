// 銀行：存款 ＋ 信貸。
//
// 2026-09 改版把「物資貸款／物資抵押」整套下架（見 loans.js），銀行只剩兩件事：
//   ・存款：錢包與銀行之間自由存提，存著會生利息。存提款純粹是錢換位置，
//     不算收入，也不會被課所得稅。
//   ・信貸：所有借貸統一為信用貸款，利息提高，不再需要抵押品。
//
// 利息設計：年利率預設 0.0001%（後台可調），按日累積。
// 這個利率非常低是刻意的——存款的定位是「保管」而不是「投資」，
// 真的想賺錢請去股市或做生意。因為利率低，每天的利息往往連 1 星幣都不到，
// 所以利息先累積在 accrued（小數），滿 1 星幣才整數入帳，不會被無條件捨去吃掉。
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
  ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { db, guildConfig, ensureColumns, logError } = require('../../db');
const { brandColor } = require('../../util/brand');
const { localToday } = require('../../util/time');

ensureColumns('loan_config', {
  // 存款
  deposit_enabled: 'INTEGER NOT NULL DEFAULT 1',
  deposit_apr: 'REAL NOT NULL DEFAULT 0.0001',    // 年利率 %（0.0001 ＝ 0.0001%）
  deposit_max: 'INTEGER NOT NULL DEFAULT 0',      // 單人存款上限，0＝不限
  // 物資貸款下架旗標：保留欄位讓舊資料看得懂，但預設關閉
  asset_loan_enabled: 'INTEGER NOT NULL DEFAULT 0'
});

db.exec(`CREATE TABLE IF NOT EXISTS bank_accounts (
  guild_id    TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  balance     INTEGER NOT NULL DEFAULT 0,
  accrued     REAL NOT NULL DEFAULT 0,            -- 還不滿 1 星幣的零頭利息
  interest_total INTEGER NOT NULL DEFAULT 0,      -- 累計已入帳利息（純顯示）
  last_accrue TEXT NOT NULL DEFAULT '',           -- 上次結息日 YYYY-MM-DD
  updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (guild_id, user_id)
)`);

// 信貸利息調高：免抵押的風險改由利息承擔（舊制物資貸款有抵押品兜底，
// 信貸沒有）。只調還停在舊預設 10% 的伺服器，後台自己改過的不動。
(function migrateBankDefaults() {
  const { getSetting, setSetting } = require('../../db');
  if (getSetting('bank_2026_09_migrated', '0') === '1') return;
  try {
    db.prepare('UPDATE loan_config SET credit_interest_pct = 15 WHERE credit_interest_pct = 10').run();
    db.prepare('UPDATE loan_config SET asset_loan_enabled = 0').run();
    setSetting('bank_2026_09_migrated', '1');
    console.log('  ↳ 銀行：已套用 2026-09 預設值（信貸利息調高、物資貸款停辦）');
  } catch (e) { console.error('銀行預設值搬遷失敗：', e.message); }
})();

const cfg = (gid) => guildConfig('loan_config', gid);
const gcfg = (gid) => guildConfig('gather_config', gid);
const money = (gid, n) => {
  const c = gcfg(gid);
  return `${c.currency_emoji || '🪙'} ${Number(n || 0).toLocaleString('en-US')} ${c.currency_name || '星幣'}`;
};

function account(gid, uid) {
  db.prepare('INSERT OR IGNORE INTO bank_accounts (guild_id, user_id) VALUES (?,?)').run(gid, uid);
  return db.prepare('SELECT * FROM bank_accounts WHERE guild_id=? AND user_id=?').get(gid, uid);
}

// 結息：把「上次結息日到今天」的天數補上（開機補算，不必每天準時跑）。
// 每日利息 = 餘額 × 年利率% / 100 / 365，先進 accrued，滿 1 才入帳。
function accrue(gid, uid) {
  const c = cfg(gid);
  const a = account(gid, uid);
  const today = localToday();
  if (!c.deposit_enabled || a.last_accrue === today) return a;
  if (!a.last_accrue) {
    // 第一次：只記日期，不補算開戶前的利息
    db.prepare('UPDATE bank_accounts SET last_accrue=? WHERE guild_id=? AND user_id=?').run(today, gid, uid);
    return account(gid, uid);
  }
  const days = Math.max(0, Math.round((Date.parse(today) - Date.parse(a.last_accrue)) / 86400000));
  if (days <= 0) return a;
  const daily = a.balance * Math.max(0, c.deposit_apr || 0) / 100 / 365;
  let accrued = a.accrued + daily * days;
  const whole = Math.floor(accrued);
  accrued -= whole;
  db.prepare(`UPDATE bank_accounts SET balance = balance + ?, accrued = ?, interest_total = interest_total + ?,
              last_accrue = ?, updated_at = datetime('now','localtime') WHERE guild_id=? AND user_id=?`)
    .run(whole, accrued, whole, today, gid, uid);
  return account(gid, uid);
}

const walletCoins = (gid, uid) =>
  (db.prepare('SELECT coins FROM econ_wallets WHERE guild_id=? AND user_id=?').get(gid, uid) || {}).coins ?? null;

// 存入：錢包 → 銀行
function deposit(gid, uid, uname, amount) {
  const c = cfg(gid);
  if (!c.deposit_enabled) return { ok: false, msg: '這個伺服器目前沒有開放銀行存款。' };
  accrue(gid, uid);
  const coins = walletCoins(gid, uid);
  if (coins == null) return { ok: false, msg: '你還沒有錢包（先玩一下再來存錢吧）。' };
  const a = account(gid, uid);
  const want = amount == null ? coins : Math.floor(Number(amount) || 0);
  if (want <= 0) return { ok: false, msg: '存款金額要大於 0。' };
  if (want > coins) return { ok: false, msg: `錢包只有 ${money(gid, coins)}，存不了 ${money(gid, want)}。` };
  const cap = Math.max(0, c.deposit_max || 0);
  if (cap > 0 && a.balance + want > cap) {
    return { ok: false, msg: `存款上限是 ${money(gid, cap)}，你目前存了 ${money(gid, a.balance)}，最多還能存 ${money(gid, Math.max(0, cap - a.balance))}。` };
  }
  db.transaction(() => {
    db.prepare("UPDATE econ_wallets SET coins = coins - ?, updated_at=datetime('now','localtime') WHERE guild_id=? AND user_id=?").run(want, gid, uid);
    db.prepare("UPDATE bank_accounts SET balance = balance + ?, updated_at=datetime('now','localtime') WHERE guild_id=? AND user_id=?").run(want, gid, uid);
    // 存提款是資產移動，不是收入 —— reason 用「存款」，不在所得稅的收入白名單裡
    require('./gather').logCoins(gid, uid, -want, '存款', '存進銀行');
  })();
  return { ok: true, amount: want, coins: walletCoins(gid, uid), balance: account(gid, uid).balance };
}

// 提出：銀行 → 錢包
function withdraw(gid, uid, uname, amount) {
  const c = cfg(gid);
  if (!c.deposit_enabled) return { ok: false, msg: '這個伺服器目前沒有開放銀行存款。' };
  accrue(gid, uid);
  const a = account(gid, uid);
  const want = amount == null ? a.balance : Math.floor(Number(amount) || 0);
  if (want <= 0) return { ok: false, msg: '提款金額要大於 0。' };
  if (want > a.balance) return { ok: false, msg: `銀行裡只有 ${money(gid, a.balance)}，提不出 ${money(gid, want)}。` };
  db.transaction(() => {
    db.prepare("UPDATE bank_accounts SET balance = balance - ?, updated_at=datetime('now','localtime') WHERE guild_id=? AND user_id=?").run(want, gid, uid);
    db.prepare("UPDATE econ_wallets SET coins = coins + ?, updated_at=datetime('now','localtime') WHERE guild_id=? AND user_id=?").run(want, gid, uid);
    require('./gather').logCoins(gid, uid, want, '提款', '從銀行領出');
  })();
  return { ok: true, amount: want, coins: walletCoins(gid, uid), balance: account(gid, uid).balance };
}

// 銀行面板：存款狀況 ＋ 信貸明細（本金／利率／利息／剩餘本金／應還總額／還款狀態）
function bankEmbed(gid, uid, uname) {
  const c = cfg(gid);
  const a = accrue(gid, uid);
  const coins = walletCoins(gid, uid) ?? 0;
  const apr = Math.max(0, c.deposit_apr || 0);
  const yearly = Math.floor(a.balance * apr / 100);

  const e = new EmbedBuilder().setColor(brandColor()).setTitle('🏦 銀行')
    .setDescription(
      `**錢包** ${money(gid, coins)}　→←　**存款** ${money(gid, a.balance)}\n`
      + '錢包與銀行可以自由存提，**存提款都不算收入**，不會被課所得稅。')
    .addFields({
      name: '💰 存款',
      value: `目前存款　**${money(gid, a.balance)}**\n`
        + `年利率　**${apr}%**（按日累積，不足 1 星幣會先累著，滿 1 才入帳）\n`
        + `這樣存滿一年約可領　${money(gid, yearly)}\n`
        + `累計已領利息　${money(gid, a.interest_total)}`
        + (c.deposit_max > 0 ? `\n存款上限　${money(gid, c.deposit_max)}` : '')
    });

  // 信貸明細
  const loans = db.prepare(
    "SELECT * FROM loans WHERE guild_id=? AND user_id=? AND status='open' ORDER BY due_ms").all(gid, uid);
  if (loans.length) {
    e.addFields({
      name: '🪪 信貸（未還清）',
      value: loans.map(l => {
        const paid = Math.max(0, (l.principal + l.interest) - l.owed);
        const leftPrincipal = Math.max(0, l.principal - Math.min(paid, l.principal));
        const rate = l.principal > 0 ? (l.interest / l.principal * 100).toFixed(2) : '0';
        const overdue = l.due_ms && l.due_ms < Date.now();
        return `**#${l.id}**${l.loan_type === 'asset' ? '（舊制物資貸款）' : ''}\n`
          + `　本金 ${money(gid, l.principal)}　利率 ${rate}%　利息 ${money(gid, l.interest)}\n`
          + `　剩餘本金 ${money(gid, leftPrincipal)}　應還總額 **${money(gid, l.owed)}**\n`
          + `　狀態：${overdue ? '⚠️ 已逾期' : `到期 <t:${Math.floor(l.due_ms / 1000)}:R>`}`
          + `　已還 ${money(gid, paid)}`;
      }).join('\n\n').slice(0, 1024)
    });
  } else {
    e.addFields({
      name: '🪪 信貸',
      value: c.credit_enabled
        ? `目前沒有未還清的貸款。\n單筆上限 ${money(gid, c.credit_max || 0)}　利率 ${c.credit_interest_pct || 0}%　期限 ${c.credit_term_days || 7} 天`
        : '目前沒有開放信用貸款。'
    });
  }
  e.setFooter({ text: '物資貸款／物資抵押已下架，所有借貸統一為信用貸款' });
  return e;
}

function panelRows(gid, uid) {
  const c = cfg(gid);
  const a = account(gid, uid);
  const coins = walletCoins(gid, uid) ?? 0;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('bank:deposit').setLabel('存入').setEmoji('📥').setStyle(ButtonStyle.Primary).setDisabled(!c.deposit_enabled || coins <= 0),
    new ButtonBuilder().setCustomId('bank:withdraw').setLabel('提出').setEmoji('📤').setStyle(ButtonStyle.Primary).setDisabled(!c.deposit_enabled || a.balance <= 0),
    new ButtonBuilder().setCustomId('loan:credit').setLabel('信用借款').setEmoji('🪪').setStyle(ButtonStyle.Secondary).setDisabled(!c.credit_enabled),
    new ButtonBuilder().setCustomId('loan:repay').setLabel('還款').setEmoji('💸').setStyle(ButtonStyle.Success)
  );
  return [row];
}

function init(client) {
  client.on('interactionCreate', async (i) => {
    try {
      const eph = { flags: MessageFlags.Ephemeral };
      if (i.isChatInputCommand?.() && i.commandName === '銀行') {
        if (!i.guildId) return i.reply({ content: '這個指令只能在伺服器裡使用。', ...eph });
        return i.reply({ embeds: [bankEmbed(i.guildId, i.user.id, i.user.username)], components: panelRows(i.guildId, i.user.id), ...eph });
      }
      if (i.isButton?.() && (i.customId === 'adv:bank' || i.customId === 'bank:panel')) {
        return i.reply({ embeds: [bankEmbed(i.guildId, i.user.id, i.user.username)], components: panelRows(i.guildId, i.user.id), ...eph });
      }
      if (i.isButton?.() && (i.customId === 'bank:deposit' || i.customId === 'bank:withdraw')) {
        const isDep = i.customId === 'bank:deposit';
        const modal = new ModalBuilder().setCustomId(isDep ? 'bank:depositModal' : 'bank:withdrawModal')
          .setTitle(isDep ? '存入銀行' : '從銀行提出')
          .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('amount')
              .setLabel(isDep ? '要存多少？（留空＝全部存入）' : '要提多少？（留空＝全部提出）')
              .setStyle(TextInputStyle.Short).setPlaceholder('例如 10000').setRequired(false)));
        return i.showModal(modal).catch(() => {});
      }
      if (i.isModalSubmit?.() && (i.customId === 'bank:depositModal' || i.customId === 'bank:withdrawModal')) {
        const raw = String(i.fields.getTextInputValue('amount') || '').replace(/[^\d]/g, '');
        const amt = raw ? parseInt(raw, 10) : null;
        const isDep = i.customId === 'bank:depositModal';
        const r = isDep ? deposit(i.guildId, i.user.id, i.user.username, amt)
                        : withdraw(i.guildId, i.user.id, i.user.username, amt);
        if (!r.ok) return i.reply({ content: `❌ ${r.msg}`, ...eph });
        return i.reply({
          content: `${isDep ? '📥 已存入' : '📤 已提出'} **${money(i.guildId, r.amount)}**\n`
            + `錢包 ${money(i.guildId, r.coins)}　·　存款 ${money(i.guildId, r.balance)}`,
          ...eph
        });
      }
    } catch (e) {
      logError(i.guildId, '銀行互動失敗：', e.message);
      const msg = { content: '⚠️ 銀行忙碌中，請再試一次。', flags: MessageFlags.Ephemeral };
      if (i.deferred || i.replied) i.editReply({ content: msg.content }).catch(() => {});
      else i.reply(msg).catch(() => {});
    }
  });
  console.log('  ↳ 銀行模組已載入（存款生息＋信貸）');
}

module.exports = { init, account, accrue, deposit, withdraw, bankEmbed, panelRows };
