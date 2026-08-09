// 慈善基金會：/捐款 把星幣捐進公開帳戶，餘額全服可查（/基金會 或面板 ❤️基金會）
//   1. 捐款可折抵稅額（預設 10%：捐 100,000 折抵 10,000 稅金）
//   2. 基金會的錢自動流進普發池 → 捐款直接變成別人的救濟金
//   3. 結算公告會列出本期捐款榜
// 設計重點：捐出去的錢不會回到捐款人手上（不是存錢），折抵只在「本期」有效，結算後重新算。
const { EmbedBuilder, MessageFlags } = require('discord.js');
const { db, guildConfig, logError } = require('../../db');
const { brandColor } = require('../../util/brand');

const cfg = (gid) => guildConfig('charity_config', gid);
const gcfg = (gid) => guildConfig('gather_config', gid);
const money = (gid, n) => {
  const c = gcfg(gid);
  return `${c.currency_emoji || '🪙'} ${Number(n || 0).toLocaleString('en-US')} ${c.currency_name || '星幣'}`;
};
const fundName = (gid) => cfg(gid).name || '慈善基金會';

// 「本期」＝上次稅金結算之後（沒結算過就是全部）。折抵與捐款榜都以此為界。
function periodStart(gid) {
  const t = guildConfig('tax_config', gid);
  return t.last_run_at || '';
}

// 某人本期捐了多少
function periodDonated(gid, userId) {
  const since = periodStart(gid);
  const sql = 'SELECT COALESCE(SUM(amount),0) v FROM charity_donations WHERE guild_id=? AND user_id=?'
    + (since ? ' AND created_at > ?' : '');
  return (since
    ? db.prepare(sql).get(gid, userId, since)
    : db.prepare(sql).get(gid, userId)).v;
}

// 本期全服捐款榜
function periodTop(gid, limit = 10) {
  const since = periodStart(gid);
  const sql = `SELECT user_id, username, SUM(amount) amount, COUNT(*) times FROM charity_donations
    WHERE guild_id=?${since ? ' AND created_at > ?' : ''} GROUP BY user_id ORDER BY amount DESC LIMIT ${Math.max(1, limit | 0)}`;
  return since ? db.prepare(sql).all(gid, since) : db.prepare(sql).all(gid);
}

function allTimeTop(gid, limit = 10) {
  return db.prepare(
    `SELECT user_id, username, SUM(amount) amount, COUNT(*) times FROM charity_donations
      WHERE guild_id=? GROUP BY user_id ORDER BY amount DESC LIMIT ?`).all(gid, Math.max(1, limit | 0));
}

// 這期的捐款能折抵多少稅：捐款 × deduct_pct%，再受「每人上限」與「最多抵掉稅金的 %」兩道限制
function creditFor(gid, userId, taxTotal) {
  const c = cfg(gid);
  if (!c.enabled || !(c.deduct_pct > 0) || taxTotal <= 0) return { credit: 0, donated: 0 };
  const donated = periodDonated(gid, userId);
  if (donated <= 0) return { credit: 0, donated: 0 };
  let credit = Math.floor(donated * c.deduct_pct / 100);
  if (c.deduct_max > 0) credit = Math.min(credit, c.deduct_max);
  const ceiling = Math.floor(taxTotal * Math.max(0, Math.min(100, c.deduct_max_pct ?? 100)) / 100);
  credit = Math.max(0, Math.min(credit, ceiling, taxTotal));
  return { credit, donated };
}

// 捐款：從錢包扣、記帳、進基金池。回傳 {ok, ...} 給指令層組訊息。
function donate(gid, userId, username, amount) {
  const c = cfg(gid);
  if (!c.enabled) return { ok: false, msg: `這個伺服器目前沒有開放${fundName(gid)}。` };
  const amt = Math.floor(Number(amount) || 0);
  if (amt <= 0) return { ok: false, msg: '捐款金額要大於 0。' };
  if (amt < (c.min_donate || 0)) return { ok: false, msg: `單筆最低捐款是 ${money(gid, c.min_donate)}。` };
  const w = db.prepare('SELECT * FROM econ_wallets WHERE guild_id=? AND user_id=?').get(gid, userId);
  if (!w) return { ok: false, msg: '你還沒有錢包（先玩一下再來捐吧）。' };
  if (w.coins < 0) return { ok: false, msg: `你目前**欠稅中**（餘額 ${money(gid, w.coins)}），先把餘額弄回正數才能捐款。` };
  if (w.coins < amt) return { ok: false, msg: `餘額不足：你只有 ${money(gid, w.coins)}。` };

  const credit = Math.floor(amt * Math.max(0, c.deduct_pct || 0) / 100);
  const res = db.transaction(() => {
    db.prepare("UPDATE econ_wallets SET coins = coins - ?, updated_at = datetime('now','localtime') WHERE guild_id=? AND user_id=?")
      .run(amt, gid, userId);
    db.prepare('INSERT INTO charity_donations (guild_id,user_id,username,amount,credit) VALUES (?,?,?,?,?)')
      .run(gid, userId, username || '', amt, credit);
    db.prepare('UPDATE charity_config SET pool = pool + ?, total_in = total_in + ? WHERE guild_id=?').run(amt, amt, gid);
    return db.prepare('SELECT coins FROM econ_wallets WHERE guild_id=? AND user_id=?').get(gid, userId).coins;
  })();
  const after = cfg(gid);
  return { ok: true, amount: amt, credit, coins: res, pool: after.pool, donated: periodDonated(gid, userId) };
}

// 直接資助特定玩家：星幣直接送到對方錢包（公開透明）。
// 不進基金池、不折抵稅額、不上捐款榜（避免用小號互送刷抵稅），單純的公開善舉。
// 送到對方的錢包不計入 total_earned（跟貸款一樣不算收入），所以不會反過來被課所得稅。
function giftPlayer(gid, from, toUser, amount) {
  const c = cfg(gid);
  if (!c.enabled) return { ok: false, msg: `這個伺服器目前沒有開放${fundName(gid)}。` };
  if (toUser.bot) return { ok: false, msg: '不能資助機器人。' };
  if (toUser.id === from.id) return { ok: false, msg: '不能資助自己（要捐給基金會就不要填對象）。' };
  const amt = Math.floor(Number(amount) || 0);
  if (amt <= 0) return { ok: false, msg: '金額要大於 0。' };
  if (amt < (c.min_donate || 0)) return { ok: false, msg: `單筆最低是 ${money(gid, c.min_donate)}。` };
  const w = db.prepare('SELECT * FROM econ_wallets WHERE guild_id=? AND user_id=?').get(gid, from.id);
  if (!w) return { ok: false, msg: '你還沒有錢包（先玩一下再來）。' };
  if (w.coins < 0) return { ok: false, msg: `你目前**欠稅中**（餘額 ${money(gid, w.coins)}），先回正才能資助別人。` };
  if (w.coins < amt) return { ok: false, msg: `餘額不足：你只有 ${money(gid, w.coins)}。` };
  const { wallet } = require('./gather');
  const res = db.transaction(() => {
    db.prepare("UPDATE econ_wallets SET coins = coins - ?, updated_at = datetime('now','localtime') WHERE guild_id=? AND user_id=?").run(amt, gid, from.id);
    wallet(gid, toUser.id, toUser.username);   // 確保對方有錢包
    db.prepare("UPDATE econ_wallets SET coins = coins + ?, updated_at = datetime('now','localtime') WHERE guild_id=? AND user_id=?").run(amt, gid, toUser.id);
    return db.prepare('SELECT coins FROM econ_wallets WHERE guild_id=? AND user_id=?').get(gid, from.id).coins;
  })();
  const toCoins = db.prepare('SELECT coins FROM econ_wallets WHERE guild_id=? AND user_id=?').get(gid, toUser.id).coins;
  return { ok: true, amount: amt, coins: res, toUser, toCoins };
}

async function announceGift(client, gid, fromId, r) {
  const c = cfg(gid);
  if (!c.channel) return;
  const ch = await client.channels.fetch(c.channel).catch(() => null);
  if (!ch) return;
  await ch.send({
    embeds: [new EmbedBuilder().setColor(brandColor())
      .setTitle(`🤝 ${fundName(gid)}　愛心資助`)
      .setDescription(`<@${fromId}> 直接資助了 <@${r.toUser.id}> **${money(gid, r.amount)}**`)
      .setFooter({ text: '直接資助不折抵稅額，是純粹的善舉' })]
  }).catch(() => {});
}

// 普發撥款：從基金池取出最多 amount，回傳實際取出的金額（不足就給有多少算多少）
function takeFromPool(gid, amount) {
  const c = cfg(gid);
  if (!c.enabled || !c.to_relief) return 0;
  const take = Math.max(0, Math.min(Math.floor(amount || 0), c.pool || 0));
  if (take <= 0) return 0;
  db.prepare('UPDATE charity_config SET pool = pool - ?, total_out = total_out + ? WHERE guild_id=?').run(take, take, gid);
  return take;
}

// 給普發用的可動用財源（試算時只看不動）
function reliefBudget(gid) {
  const c = cfg(gid);
  return c.enabled && c.to_relief ? Math.max(0, c.pool || 0) : 0;
}

function logPayout(gid, period, amount, people) {
  if (amount <= 0) return;
  db.prepare('INSERT INTO charity_payouts (guild_id,period,amount,people) VALUES (?,?,?,?)').run(gid, period, amount, people || 0);
}

// /基金會 與面板按鈕：公開帳目
function infoEmbed(gid, userId) {
  const c = cfg(gid);
  const emb = new EmbedBuilder().setColor(brandColor()).setTitle(`❤️ ${fundName(gid)}`);
  if (!c.enabled) {
    return emb.setDescription('這個伺服器目前**沒有開放基金會**。開放後可以用 `/捐款` 捐星幣，帳目全服公開。');
  }
  const lines = [
    `目前餘額　**${money(gid, c.pool)}**`,
    `累計募得　${money(gid, c.total_in)}`,
    `已撥出當救濟金　${money(gid, c.total_out)}`
  ];
  emb.setDescription(lines.join('\n'));

  if (c.deduct_pct > 0) {
    emb.addFields({
      name: '🧾 捐款可折抵稅額',
      value: `捐款金額的 **${c.deduct_pct}%** 可以折抵你這期的稅金`
        + `（捐 ${Number(100000).toLocaleString('en-US')} → 折抵 ${money(gid, Math.floor(100000 * c.deduct_pct / 100))}）。`
        + (c.deduct_max > 0 ? `\n每人每期折抵上限 ${money(gid, c.deduct_max)}。` : '')
        + ((c.deduct_max_pct ?? 100) < 100 ? `\n折抵最多只能抵掉稅金的 ${c.deduct_max_pct}%（其餘還是要繳）。` : '')
        + `\n折抵只算**上次結算之後**的捐款，結算後重新起算。`
    });
  }
  if (c.to_relief) {
    emb.addFields({
      name: '🤝 錢去哪了',
      value: '基金會的餘額會自動當成**普發（救濟金）的財源**，跟稅收一起發給窮／欠稅的人。你捐的錢會直接變成別人的救濟金。'
    });
  }

  const top = periodTop(gid, 10);
  emb.addFields({
    name: '本期捐款榜',
    value: top.length
      ? top.map((t, i) => `${['🥇', '🥈', '🥉'][i] || `${i + 1}.`} <@${t.user_id}> — ${money(gid, t.amount)}（${t.times} 筆）`).join('\n').slice(0, 1024)
      : '這期還沒有人捐款。'
  });
  const all = allTimeTop(gid, 5);
  if (all.length) {
    emb.addFields({
      name: '歷代大善人',
      value: all.map((t, i) => `${i + 1}. <@${t.user_id}> — ${money(gid, t.amount)}`).join('\n').slice(0, 1024)
    });
  }
  if (userId) {
    const mine = periodDonated(gid, userId);
    const total = db.prepare('SELECT COALESCE(SUM(amount),0) v FROM charity_donations WHERE guild_id=? AND user_id=?').get(gid, userId).v;
    emb.addFields({
      name: '你的捐款',
      value: `本期 ${money(gid, mine)}`
        + (c.deduct_pct > 0 ? `（可折抵稅額約 ${money(gid, Math.floor(mine * c.deduct_pct / 100))}）` : '')
        + `\n歷史累計 ${money(gid, total)}`
    });
  }
  const pay = db.prepare('SELECT period, amount, people FROM charity_payouts WHERE guild_id=? ORDER BY id DESC LIMIT 3').all(gid);
  if (pay.length) {
    emb.addFields({
      name: '最近撥款',
      value: pay.map(p => `${p.period}　${money(gid, p.amount)}　→ ${p.people} 人`).join('\n')
    });
  }
  return emb.setFooter({ text: `用 /捐款 金額 捐星幣　·　帳目全服公開，誰捐了多少大家都看得到` });
}

// 捐款公告：讓大家看到誰捐了（也是社群壓力的來源）
async function announceDonation(client, gid, userId, r) {
  const c = cfg(gid);
  if (!c.channel) return;
  const ch = await client.channels.fetch(c.channel).catch(() => null);
  if (!ch) return;
  const emb = new EmbedBuilder()
    .setColor(brandColor())
    .setTitle(`❤️ ${fundName(gid)}　收到新捐款`)
    .setDescription(`<@${userId}> 捐了 **${money(gid, r.amount)}**`
      + (r.credit > 0 ? `\n可折抵稅額 ${money(gid, r.credit)}` : ''))
    .addFields({ name: '基金會目前餘額', value: money(gid, r.pool) })
    .setFooter({ text: '這筆錢會變成普發救濟金。用 /基金會 查帳目' });
  await ch.send({ embeds: [emb] }).catch(() => {});
}

function init(client) {
  client.on('interactionCreate', async (i) => {
    try {
      if (i.isButton() && i.customId === 'adv:charity') {
        return await i.reply({ embeds: [infoEmbed(i.guildId, i.user.id)], flags: MessageFlags.Ephemeral });
      }
      if (i.isChatInputCommand() && i.commandName === '基金會') {
        return await i.reply({ embeds: [infoEmbed(i.guildId, i.user.id)] });
      }
      if (i.isChatInputCommand() && i.commandName === '捐款') {
        const gid = i.guildId;
        const amount = i.options.getInteger('金額');
        const target = i.options.getUser('對象');
        // 有填對象 → 直接資助那位玩家（不折抵稅、不上榜）
        if (target) {
          const g = giftPlayer(gid, i.user, target, amount);
          if (!g.ok) return await i.reply({ content: `❌ ${g.msg}`, flags: MessageFlags.Ephemeral });
          const emb = new EmbedBuilder().setColor(brandColor())
            .setTitle('🤝 愛心資助成功')
            .setDescription(`你資助了 <@${target.id}> **${money(gid, g.amount)}**\n你的餘額 ${money(gid, g.coins)}`)
            .setFooter({ text: '直接資助不折抵稅額；想折抵稅就用 /捐款 金額（不填對象）捐給基金會' });
          await i.reply({ embeds: [emb] });
          return announceGift(client, gid, i.user.id, g).catch(() => {});
        }
        const r = donate(gid, i.user.id, i.user.username, amount);
        if (!r.ok) return await i.reply({ content: `❌ ${r.msg}`, flags: MessageFlags.Ephemeral });
        const emb = new EmbedBuilder()
          .setColor(brandColor())
          .setTitle(`❤️ 感謝你捐給${fundName(gid)}`)
          .setDescription(`捐出 **${money(gid, r.amount)}**\n剩餘餘額 ${money(gid, r.coins)}`)
          .addFields(
            { name: '本期累計捐款', value: money(gid, r.donated), inline: true },
            { name: '可折抵稅額', value: r.credit > 0 ? money(gid, r.credit) : '—', inline: true },
            { name: '基金會餘額', value: money(gid, r.pool), inline: true }
          )
          .setFooter({ text: '折抵會在下次稅金結算時自動生效（用 /稅單 看預估）' });
        await i.reply({ embeds: [emb] });
        return announceDonation(client, gid, i.user.id, r).catch(() => {});
      }
    } catch (e) {
      logError(i.guildId, '基金會操作失敗：', e && e.stack ? e.stack : e);
      if (!i.replied && !i.deferred) i.reply({ content: '處理基金會請求時發生錯誤。', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  });
  console.log('  ↳ 慈善基金會已載入（/捐款、/基金會，捐款折抵稅額＋自動撥入普發池）');
}

module.exports = {
  init, cfg, donate, creditFor, takeFromPool, reliefBudget, logPayout,
  periodDonated, periodTop, allTimeTop, infoEmbed, fundName
};
