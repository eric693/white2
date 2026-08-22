// 基金會拍賣會：限時競標特殊家具／珍稀寵物／成就稱號／稀有物品。
//
// 規則（刻意這樣設計的地方）：
//   ① 出價當場扣款、被超越自動全額退回 —— 不會有「喊了不付錢」的呆帳，也不用另收保證金
//   ② 手續費從成交價抽，成交價與手續費都進基金會池 → 拍賣是回收星幣的水龍頭，不是印鈔機
//   ③ 得標可以另外收材料（mats_cost）—— 讓只能賣錢的素材有真正的出海口；
//      材料不夠時不會沒收標的，改成按物品原價換算成星幣補收（見 settleWinner）
//   ④ 結束前幾分鐘有人出價就自動延長，避免最後一秒狙擊
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
  ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { db, guildConfig, logError } = require('../../db');
const { brandColor } = require('../../util/brand');
const { wallet, addCoins } = require('./gather');
const { bagCount, takeItems, parseMats, homeOf } = require('./home');

const cfg = (gid) => guildConfig('auction_config', gid);
const gcfg = (gid) => guildConfig('gather_config', gid);
const money = (gid, n) => {
  const c = gcfg(gid);
  return `${c.currency_emoji || '🪙'} ${Number(n || 0).toLocaleString('en-US')} ${c.currency_name || '星幣'}`;
};

const KIND_LABEL = { furniture: '🛋️ 家具', pet: '🐾 寵物', title: '🏅 成就', item: '📦 物品' };

/** 標的物的顯示資料（名稱／圖示）。後台沒填 title 就用標的物本身的名字。 */
function refInfo(gid, a) {
  const T = { furniture: 'home_furniture', pet: 'pet_defs', title: 'title_defs', item: 'gather_items' };
  const t = T[a.kind];
  let row = null;
  if (t) { try { row = db.prepare(`SELECT * FROM ${t} WHERE id=? AND guild_id=?`).get(a.ref_id, gid); } catch {} }
  return {
    name: a.title || (row ? row.name : '未知標的'),
    emoji: a.emoji || (row ? row.emoji : '') || '',
    row
  };
}

const liveAuctions = (gid) => db.prepare(
  "SELECT * FROM auctions WHERE guild_id=? AND status='live' ORDER BY end_ts").all(gid);
const topBid = (auctionId) => db.prepare(
  'SELECT * FROM auction_bids WHERE auction_id=? AND active=1 ORDER BY amount DESC, id LIMIT 1').get(auctionId);

/** 下一次至少要出多少（第一口＝起標價；之後照 % 與絕對值取大的加價） */
function nextMin(gid, a) {
  const c = cfg(gid);
  const t = topBid(a.id);
  if (!t) return a.start_price;
  const inc = Math.max(c.min_inc || 0, Math.ceil(t.amount * (c.min_inc_pct || 0) / 100));
  return t.amount + Math.max(1, inc);
}

// ---------- 出價 ----------
function placeBid(gid, uid, uname, auctionId, amount) {
  const c = cfg(gid);
  if (!c.enabled) return { error: '拍賣會目前沒有開放。' };
  const a = db.prepare('SELECT * FROM auctions WHERE id=? AND guild_id=?').get(auctionId, gid);
  if (!a) return { error: '找不到這場拍賣。' };
  if (a.status !== 'live') return { error: a.status === 'scheduled' ? '這場拍賣還沒開始。' : '這場拍賣已經結束了。' };
  if (a.end_ts <= Date.now()) return { error: '這場拍賣剛剛結束了。' };

  const want = Math.floor(Number(amount) || 0);
  const min = nextMin(gid, a);
  if (want < min) return { error: `至少要出 **${money(gid, min)}**（目前最高價再加上最低加價幅度）。` };

  const w = wallet(gid, uid, uname);
  const mine = db.prepare('SELECT * FROM auction_bids WHERE auction_id=? AND user_id=? AND active=1').get(auctionId, uid);
  // 已經是最高價的人再加價，只要補差額（原本那筆錢還鎖著）
  const needPay = want - (mine ? mine.amount : 0);
  if (w.coins < needPay) return { error: `餘額不夠：還需要 ${money(gid, needPay - w.coins)}。（出價會當場鎖款，被人超越就自動退回）` };
  if (c.max_bid_pct > 0) {
    const cap = Math.floor((w.coins + (mine ? mine.amount : 0)) * c.max_bid_pct / 100);
    if (want > cap) return { error: `單次出價不能超過你身家的 ${c.max_bid_pct}%（上限 ${money(gid, cap)}）。` };
  }

  const prev = topBid(auctionId);
  let extended = false;
  db.transaction(() => {
    // 退掉自己上一筆（改成補差額的形式，錢包只扣差額）
    if (mine) db.prepare('UPDATE auction_bids SET active=0 WHERE id=?').run(mine.id);
    // 退給被超越的人
    if (prev && prev.user_id !== uid) {
      db.prepare('UPDATE auction_bids SET active=0 WHERE id=?').run(prev.id);
      addCoins(gid, prev.user_id, prev.username, prev.amount);
    }
    addCoins(gid, uid, uname, -needPay);
    db.prepare('INSERT INTO auction_bids (auction_id,guild_id,user_id,username,amount) VALUES (?,?,?,?,?)')
      .run(auctionId, gid, uid, uname, want);
    // 防狙擊：結束前 antisnipe_min 分鐘內有人出價 → 延長
    const left = a.end_ts - Date.now();
    if (c.antisnipe_min > 0 && left < c.antisnipe_min * 60000) {
      db.prepare('UPDATE auctions SET end_ts=?, bids=bids+1 WHERE id=?')
        .run(a.end_ts + (c.extend_min || 3) * 60000, a.id);
      extended = true;
    } else {
      db.prepare('UPDATE auctions SET bids=bids+1 WHERE id=?').run(a.id);
    }
  })();

  return {
    ok: true, amount: want, extended,
    outbid: prev && prev.user_id !== uid ? prev : null,
    auction: db.prepare('SELECT * FROM auctions WHERE id=?').get(a.id)
  };
}

// ---------- 直接買下 ----------
function buyout(gid, uid, uname, auctionId) {
  const a = db.prepare('SELECT * FROM auctions WHERE id=? AND guild_id=?').get(auctionId, gid);
  if (!a) return { error: '找不到這場拍賣。' };
  if (!a.buyout_price) return { error: '這件標的沒有開放直接買下。' };
  if (a.status !== 'live') return { error: '這場拍賣不在進行中。' };
  const r = placeBid(gid, uid, uname, auctionId, Math.max(a.buyout_price, nextMin(gid, a)));
  if (r.error) return r;
  // 立刻結標
  db.prepare('UPDATE auctions SET end_ts=? WHERE id=?').run(Date.now(), a.id);
  return { ...r, buyout: true };
}

// ---------- 結標與交付 ----------
/**
 * 把標的物交到得標者手上。材料附加成本在這裡收：
 * 材料不夠不會沒收標的（那太傷），改成按物品原價換算補收星幣 —— 但錢也不夠就退回競標金、流標。
 */
function settleWinner(gid, a, bid) {
  const info = refInfo(gid, a);
  const mats = parseMats(a.mats_cost);
  const short = [];
  for (const m of mats) {
    const have = bagCount(gid, a.winner_id || bid.user_id, m.item);
    if (have < m.count) short.push({ ...m, have, lack: m.count - have });
  }
  let extraCoins = 0;
  if (short.length) {
    for (const s of short) {
      const it = db.prepare('SELECT price FROM gather_items WHERE guild_id=? AND name=?').get(gid, s.item);
      extraCoins += Math.max(1, (it ? it.price : 100)) * s.lack;
    }
    const w = wallet(gid, bid.user_id, bid.username);
    if (w.coins < extraCoins) {
      return { failed: true, reason: `材料不足，補收的 ${money(gid, extraCoins)} 也付不出來` };
    }
  }

  db.transaction(() => {
    // 收材料（有多少收多少）＋ 不足的部分用星幣補
    for (const m of mats) {
      const have = bagCount(gid, bid.user_id, m.item);
      const take = Math.min(have, m.count);
      if (take > 0) takeItems(gid, bid.user_id, [{ item: m.item, count: take }]);
    }
    if (extraCoins > 0) addCoins(gid, bid.user_id, bid.username, -extraCoins);

    // 交付標的
    if (a.kind === 'furniture') {
      db.prepare(`INSERT INTO home_furniture_owned (guild_id,user_id,furniture_id,count,placed) VALUES (?,?,?,1,0)
        ON CONFLICT(guild_id,user_id,furniture_id) DO UPDATE SET count = count + 1`).run(gid, bid.user_id, a.ref_id);
    } else if (a.kind === 'pet') {
      homeOf(gid, bid.user_id, bid.username);
      db.prepare(`INSERT INTO pet_owned (guild_id,user_id,pet_id,nickname,level,exp,intimacy,personality,fed_ms)
                  VALUES (?,?,?,'',1,0,40,'',?)`).run(gid, bid.user_id, a.ref_id, Date.now());
    } else if (a.kind === 'title') {
      db.prepare('INSERT OR IGNORE INTO title_owned (guild_id,user_id,title_id,slot) VALUES (?,?,?,-1)')
        .run(gid, bid.user_id, a.ref_id);
    } else if (a.kind === 'item') {
      const it = db.prepare('SELECT id FROM gather_items WHERE id=? AND guild_id=?').get(a.ref_id, gid);
      if (it) {
        db.prepare(`INSERT INTO gather_inventory (guild_id,user_id,item_id,count) VALUES (?,?,?,?)
          ON CONFLICT(guild_id,user_id,item_id) DO UPDATE SET count = count + ?`)
          .run(gid, bid.user_id, it.id, Math.max(1, a.qty), Math.max(1, a.qty));
      }
    }
  })();
  return { ok: true, extraCoins, info };
}

/** 結標：算手續費、把錢送進基金會、交付標的、回傳公告用資料 */
function closeAuction(gid, a) {
  const c = cfg(gid);
  const bid = topBid(a.id);
  if (!bid) {
    db.prepare("UPDATE auctions SET status='failed' WHERE id=?").run(a.id);
    return { failed: true, reason: '沒有人出價' };
  }
  const settled = settleWinner(gid, a, bid);
  if (settled.failed) {
    // 付不出來 → 全額退款、流標（標的留著，管理員可以再開一次）
    addCoins(gid, bid.user_id, bid.username, bid.amount);
    db.prepare('UPDATE auction_bids SET active=0 WHERE id=?').run(bid.id);
    db.prepare("UPDATE auctions SET status='failed' WHERE id=?").run(a.id);
    return { failed: true, reason: settled.reason, bidder: bid };
  }

  const fee = Math.floor(bid.amount * Math.max(0, c.fee_pct || 0) / 100);
  db.transaction(() => {
    db.prepare('UPDATE auction_bids SET active=0 WHERE id=?').run(bid.id);
    db.prepare(`UPDATE auctions SET status='ended', winner_id=?, winner_name=?, final_price=?, fee=? WHERE id=?`)
      .run(bid.user_id, bid.username, bid.amount, fee, a.id);
  })();

  // 得標金已經在出價時就從玩家身上扣走了，這裡只是把它送進基金會（而不是憑空消失）
  if (c.to_pool) {
    try { require('./charity').fundGet(gid, bid.amount, `拍賣成交：${refInfo(gid, a).name}`); } catch {}
  }
  return { ok: true, bid, fee, extraCoins: settled.extraCoins, info: settled.info };
}

// ---------- 面板 ----------
function auctionEmbed(gid, a) {
  const info = refInfo(gid, a);
  const t = topBid(a.id);
  const mats = parseMats(a.mats_cost);
  const e = new EmbedBuilder().setColor(brandColor())
    .setTitle(`${info.emoji || '🔨'} ${info.name}`)
    .setDescription([
      a.description || (info.row && info.row.description) || '',
      `**類別**：${KIND_LABEL[a.kind] || a.kind}${a.kind === 'item' && a.qty > 1 ? ` ×${a.qty}` : ''}`
    ].filter(Boolean).join('\n'))
    .addFields(
      { name: '目前最高價', value: t ? `${money(gid, t.amount)}\n by **${t.username}**` : `尚無人出價\n起標 ${money(gid, a.start_price)}`, inline: true },
      { name: '下次最低出價', value: money(gid, nextMin(gid, a)), inline: true },
      { name: a.status === 'live' ? '結束時間' : '狀態',
        value: a.status === 'live' ? `<t:${Math.floor(a.end_ts / 1000)}:R>` : (a.status === 'scheduled' ? `<t:${Math.floor(a.start_ts / 1000)}:R> 開始` : '已結束'), inline: true });
  if (a.buyout_price > 0) e.addFields({ name: '直接買下', value: money(gid, a.buyout_price), inline: true });
  if (mats.length) e.addFields({ name: '得標另收材料', value: mats.map(m => `${m.item} ×${m.count}`).join('、') + '\n（材料不夠會按原價折算星幣補收）', inline: false });
  if (a.image_url) e.setImage(a.image_url);
  e.setFooter({ text: `拍賣 #${a.id}｜出價 ${a.bids} 次｜出價即鎖款，被超越自動全額退回` });
  return e;
}

function auctionRow(gid, a) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`aucbid:${a.id}`).setLabel(`💰 出價（最低 ${nextMin(gid, a).toLocaleString('en-US')}）`)
      .setStyle(ButtonStyle.Success).setDisabled(a.status !== 'live'));
  if (a.buyout_price > 0) row.addComponents(
    new ButtonBuilder().setCustomId(`aucbuy:${a.id}`).setLabel(`⚡ 直接買下 ${a.buyout_price.toLocaleString('en-US')}`)
      .setStyle(ButtonStyle.Primary).setDisabled(a.status !== 'live'));
  return row;
}

function auctionPanel(gid) {
  const list = liveAuctions(gid);
  const soon = db.prepare("SELECT * FROM auctions WHERE guild_id=? AND status='scheduled' ORDER BY start_ts LIMIT 5").all(gid);
  if (!list.length) {
    const e = new EmbedBuilder().setColor(brandColor()).setTitle('🔨 基金會拍賣會')
      .setDescription(soon.length
        ? '目前沒有進行中的拍賣，但有排定的場次：\n' + soon.map(a =>
          `${a.emoji || '🔨'} **${refInfo(gid, a).name}**　<t:${Math.floor(a.start_ts / 1000)}:R> 開始`).join('\n')
        : '目前沒有拍賣會。基金會會不定期推出特殊家具、珍稀寵物與成就稱號的限時競標。');
    return { embeds: [e] };
  }
  return {
    embeds: list.slice(0, 5).map(a => auctionEmbed(gid, a)),
    components: list.slice(0, 5).map(a => auctionRow(gid, a))
  };
}

// ---------- 排程：開標 / 結標 ----------
async function tick(client) {
  const now = Date.now();
  for (const [gid] of client.guilds.cache) {
    const c = cfg(gid);
    if (!c.enabled) continue;
    try {
      // 開標
      const starting = db.prepare("SELECT * FROM auctions WHERE guild_id=? AND status='scheduled' AND start_ts<=?").all(gid, now);
      for (const a of starting) {
        db.prepare("UPDATE auctions SET status='live' WHERE id=?").run(a.id);
        const live = db.prepare('SELECT * FROM auctions WHERE id=?').get(a.id);
        if (c.channel) {
          const ch = await client.channels.fetch(c.channel).catch(() => null);
          if (ch) {
            const msg = await ch.send({ content: '🔨 **拍賣開始！**', embeds: [auctionEmbed(gid, live)], components: [auctionRow(gid, live)] }).catch(() => null);
            if (msg) db.prepare('UPDATE auctions SET message_id=? WHERE id=?').run(msg.id, a.id);
          }
        }
      }
      // 結標
      const ending = db.prepare("SELECT * FROM auctions WHERE guild_id=? AND status='live' AND end_ts<=?").all(gid, now);
      for (const a of ending) {
        const r = closeAuction(gid, a);
        if (!c.channel) continue;
        const ch = await client.channels.fetch(c.channel).catch(() => null);
        if (!ch) continue;
        const info = refInfo(gid, a);
        const e = new EmbedBuilder().setColor(r.failed ? 0x99aab5 : 0xf1c40f)
          .setTitle(r.failed ? `🔨 流標：${info.name}` : `🎉 成交：${info.name}`)
          .setDescription(r.failed
            ? `這件標的沒有找到新主人（${r.reason}）。`
            : `**${r.bid.username}** 以 **${money(gid, r.bid.amount)}** 得標！`
            + (r.fee ? `\n手續費 ${money(gid, r.fee)} 已進基金會。` : '')
            + (r.extraCoins ? `\n材料不足，另外折算補收了 ${money(gid, r.extraCoins)}。` : ''));
        await ch.send({ embeds: [e] }).catch(() => {});
        // 把原本那則公告的按鈕收掉，避免有人一直點
        if (a.message_id) {
          const msg = await ch.messages.fetch(a.message_id).catch(() => null);
          if (msg) await msg.edit({ embeds: [auctionEmbed(gid, db.prepare('SELECT * FROM auctions WHERE id=?').get(a.id))], components: [] }).catch(() => {});
        }
      }
    } catch (e) { logError(gid, '拍賣排程失敗：', e.message); }
  }
}

function init(client) {
  for (const [gid] of client.guilds.cache) { try { cfg(gid); } catch {} }
  setInterval(() => tick(client).catch(() => {}), 30000);

  client.on('interactionCreate', async (i) => {
    try {
      if (!i.guildId) return;
      const gid = i.guildId, uid = i.user.id, uname = i.user.username;
      const eph = { flags: MessageFlags.Ephemeral };

      if (i.isChatInputCommand() && i.commandName === '拍賣') {
        if (!cfg(gid).enabled) return i.reply({ content: '拍賣會目前沒有開放。', ...eph }).catch(() => {});
        return i.reply({ ...auctionPanel(gid), ...eph }).catch(() => {});
      }

      if (i.isButton() && (i.customId.startsWith('aucbid:') || i.customId === 'adv:auction')) {
        if (i.customId === 'adv:auction') return i.reply({ ...auctionPanel(gid), ...eph }).catch(() => {});
        const id = parseInt(i.customId.split(':')[1], 10);
        const a = db.prepare('SELECT * FROM auctions WHERE id=? AND guild_id=?').get(id, gid);
        if (!a) return i.reply({ content: '找不到這場拍賣。', ...eph }).catch(() => {});
        const min = nextMin(gid, a);
        const modal = new ModalBuilder().setCustomId(`aucmodal:${id}`).setTitle(`出價：${refInfo(gid, a).name}`.slice(0, 45))
          .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('amount').setLabel(`出價金額（至少 ${min}）`)
              .setStyle(TextInputStyle.Short).setPlaceholder(String(min)).setRequired(true)));
        return i.showModal(modal).catch(() => {});
      }

      if (i.isModalSubmit() && i.customId.startsWith('aucmodal:')) {
        const id = parseInt(i.customId.split(':')[1], 10);
        const raw = i.fields.getTextInputValue('amount').replace(/[,\s]/g, '');
        const out = placeBid(gid, uid, uname, id, parseInt(raw, 10));
        if (out.error) return i.reply({ content: out.error, ...eph }).catch(() => {});
        await i.reply({
          content: `✅ 已出價 **${money(gid, out.amount)}**，這筆錢先鎖住了；被人超越會自動全額退回。`
            + (out.extended ? '\n⏰ 因為接近結束時間，拍賣已自動延長。' : ''), ...eph
        }).catch(() => {});
        // 通知被超越的人
        if (out.outbid) {
          const u = await i.client.users.fetch(out.outbid.user_id).catch(() => null);
          if (u) u.send(`💸 你在拍賣 **${refInfo(gid, out.auction).name}** 的出價被超越了，${money(gid, out.outbid.amount)} 已全額退回你的錢包。\n想搶回來就再去 \`/拍賣\` 出價。`).catch(() => {});
        }
        // 更新公告訊息
        const a2 = out.auction;
        if (a2.message_id) {
          const ch = await i.client.channels.fetch(cfg(gid).channel).catch(() => null);
          const msg = ch && await ch.messages.fetch(a2.message_id).catch(() => null);
          if (msg) msg.edit({ embeds: [auctionEmbed(gid, a2)], components: [auctionRow(gid, a2)] }).catch(() => {});
        }
        return;
      }

      if (i.isButton() && i.customId.startsWith('aucbuy:')) {
        const id = parseInt(i.customId.split(':')[1], 10);
        const out = buyout(gid, uid, uname, id);
        if (out.error) return i.reply({ content: out.error, ...eph }).catch(() => {});
        return i.reply({ content: `⚡ 你直接買下了！成交金額 **${money(gid, out.amount)}**，一分鐘內會完成交付與公告。`, ...eph }).catch(() => {});
      }
    } catch (e) {
      logError(i.guildId, '拍賣操作失敗：', e.message);
      const msg = { content: '執行失敗，管理員可到後台的系統錯誤紀錄查看原因。', flags: MessageFlags.Ephemeral };
      if (i.replied || i.deferred) await i.followUp(msg).catch(() => {}); else await i.reply(msg).catch(() => {});
    }
  });

  console.log('  ↳ 基金會拍賣會已載入（限時競標／出價鎖款／手續費進基金會）');
}

module.exports = { init, auctionPanel, placeBid, buyout, closeAuction, nextMin, refInfo };
