// 特殊兌換商店（可分多間店，每間可發布面板到自己的頻道）
// 兌換不做內部代幣交易，而是把「兌換通知」貼到指定頻道並 @ 管理員，由人工處理。
const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, MessageFlags } = require('discord.js');
const { db, guildConfig, logError } = require('../../db');
const { brandColor } = require('../../util/brand');
const { absUrl } = require('../../util/url');
const { wallet } = require('./gather');

const scfg = (gid) => guildConfig('special_config', gid);
const gcfg = (gid) => guildConfig('gather_config', gid);
const csv = (s) => String(s || '').split(/[\n,]/).map(x => x.trim()).filter(Boolean);
const money = (c, n) => `${c.currency_emoji || '🪙'} ${Number(n).toLocaleString('en-US')} ${c.currency_name || '星幣'}`;

const shopsOf = (gid) => db.prepare('SELECT * FROM special_shops WHERE guild_id=? AND enabled=1 ORDER BY sort, id').all(gid);
const itemsOfShop = (gid, shopId) => db.prepare('SELECT * FROM special_items WHERE guild_id=? AND enabled=1 AND shop_id=? ORDER BY sort, price').all(gid, shopId);

// 一次可以兌換幾份：受庫存與餘額夾擊，上限 25（下拉選單最多 25 個選項）
const QTY_MAX = 25;
function qtyCap(gid, item, uid, uname) {
  const w = wallet(gid, uid, uname);
  const afford = item.price > 0 ? Math.floor(w.coins / item.price) : QTY_MAX;
  const stock = item.stock < 0 ? QTY_MAX : item.stock;
  return { cap: Math.max(0, Math.min(QTY_MAX, stock, afford)), coins: w.coins };
}

// 共用兌換邏輯：扣星幣、扣庫存、記錄、通知管理員。回傳給玩家看的 embed。
async function doRedeem(client, gid, item, user, uname, qtyRaw = 1) {
  const c = scfg(gid), gc = gcfg(gid);
  const qty = Math.max(1, Math.min(QTY_MAX, Math.floor(Number(qtyRaw) || 1)));
  if (item.stock === 0) return { error: `**${item.name}** 已經兌換完了（庫存 0）。` };
  if (item.stock > 0 && qty > item.stock) return { error: `**${item.name}** 只剩 ${item.stock} 份，沒辦法一次換 ${qty} 份。` };
  const w = wallet(gid, user.id, uname);
  const total = item.price * qty;
  if (w.coins < total) return { error: `${gc.currency_name}不夠：需要 ${total.toLocaleString('en-US')}（${item.price.toLocaleString('en-US')} × ${qty}），你只有 ${w.coins.toLocaleString('en-US')}。` };

  let redeemId;
  const tx = db.transaction(() => {
    db.prepare('UPDATE econ_wallets SET coins = coins - ? WHERE guild_id=? AND user_id=?').run(total, gid, user.id);
    if (item.stock > 0) db.prepare('UPDATE special_items SET stock = stock - ? WHERE id=?').run(qty, item.id);
    redeemId = db.prepare('INSERT INTO special_redeems (guild_id,user_id,username,item_id,item_name,price,qty) VALUES (?,?,?,?,?,?,?)')
      .run(gid, user.id, uname, item.id, item.name, item.price, qty).lastInsertRowid;
  });
  tx();

  // 通知目標：優先用商品所屬「商店」綁定的頻道與身分組，其次商品自訂，最後全域預設
  const shop = item.shop_id ? db.prepare('SELECT * FROM special_shops WHERE id=? AND guild_id=?').get(item.shop_id, gid) : null;
  const chId = item.channel_id || (shop && shop.channel_id) || c.log_channel;
  const roleIds = (shop && shop.notify_roles) ? shop.notify_roles : c.admin_roles;
  let posted = false;
  if (chId) {
    const ch = client.channels.cache.get(chId) || await client.channels.fetch(chId).catch(() => null);
    if (ch) {
      const mentions = [...csv(roleIds).map(r => `<@&${r}>`), ...csv(c.admin_users).map(u => `<@${u}>`)];
      const notify = new EmbedBuilder().setColor(brandColor()).setTitle('🎁 收到一筆兌換')
        .setDescription(`<@${user.id}> 用 ${money(gc, total)} 兌換了 **${item.emoji || ''}${item.name}** × **${qty}**` +
          (item.role_id ? `\n對應身分組：<@&${item.role_id}>` : '') +
          (item.description ? `\n\n${item.description}` : '') +
          `\n\n請管理員協助處理，完成後可到後台把這筆標記為已處理。`)
        .setFooter({ text: `兌換單 #${redeemId}｜${uname}` });
      if (item.image_url) notify.setThumbnail(absUrl(item.image_url));
      await ch.send({ content: `🔔 ${mentions.join(' ')} 有新的兌換需要處理！`.trim(), embeds: [notify] })
        .catch(e => logError(gid, '兌換公告發送失敗：', e.message));
      posted = true;
    }
  }
  const embed = new EmbedBuilder().setColor(brandColor()).setTitle('✅ 兌換成功')
    .setDescription(`你兌換了 ${item.emoji || '🎁'} **${item.name}** × **${qty}**！\n` +
      `共花費 ${money(gc, total)}\n` +
      (posted ? '已通知管理員為你處理，請留意對應頻道或私訊。' : '⚠️ 尚未設定通知頻道，請管理員盡快處理。') +
      `\n\n兌換單編號：#${redeemId}`)
    .setFooter({ text: `餘額 ${(w.coins - total).toLocaleString('en-US')} ${gc.currency_name}` });
  return { embed };
}

// 商店面板（一則含商品清單 + 兌換下拉選單）
function shopPanel(gid, shop) {
  const gc = gcfg(gid);
  const items = itemsOfShop(gid, shop.id);
  const embed = new EmbedBuilder().setColor(brandColor())
    .setTitle(`${shop.emoji || '🎁'} ${shop.name}`)
    .setDescription((shop.description ? shop.description + '\n\n' : '') +
      (items.length ? items.map(it => {
        const stock = it.stock < 0 ? '' : `　庫存 ${it.stock}`;
        return `${it.emoji || '🎁'} **${it.name}**　${money(gc, it.price)}${stock}${it.description ? `\n　　${it.description}` : ''}`;
      }).join('\n') : '（尚無商品）'))
    .setFooter({ text: '從下方選單選一項即可兌換，系統會通知管理員處理' });
  const components = [];
  if (items.length) {
    components.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(`sredeem:${shop.id}`).setPlaceholder('選擇要兌換的獎勵…')
        .addOptions(items.slice(0, 25).map(it => ({
          label: `${it.name}`.slice(0, 100),
          description: `${money(gc, it.price)}${it.stock < 0 ? '' : `｜庫存 ${it.stock}`}`.slice(0, 100),
          value: String(it.id)
        })))
    ));
  }
  return { embeds: [embed], components };
}

async function publishShop(client, shopId) {
  const shop = db.prepare('SELECT * FROM special_shops WHERE id=?').get(shopId);
  if (!shop) throw new Error('找不到商店');
  if (!shop.channel_id) throw new Error('這間店還沒設定發布頻道');
  const ch = client.channels.cache.get(shop.channel_id) || await client.channels.fetch(shop.channel_id).catch(() => null);
  if (!ch) throw new Error('找不到發布頻道');
  const payload = shopPanel(shop.guild_id, shop);
  // 已發布過就編輯原訊息，否則發新的
  if (shop.message_id) {
    const msg = await ch.messages.fetch(shop.message_id).catch(() => null);
    if (msg) { await msg.edit(payload); return; }
  }
  const sent = await ch.send(payload);
  db.prepare('UPDATE special_shops SET message_id=? WHERE id=?').run(sent.id, shopId);
}

function init(client) {
  client._publishShop = (shopId) => publishShop(client, shopId);

  // 兌換收尾：扣款 → 回覆玩家 → 刷新面板庫存。
  // 從份數選單來的是自己的暫時訊息（可 update）；直接從商品選單來的是公開面板（只能另外私訊回覆）
  const finishRedeem = async (i, gid, item, shopId, qty) => {
    const res = await doRedeem(client, gid, item, i.user, i.user.username, qty);
    const payload = res.error
      ? { content: res.error, embeds: [], components: [] }
      : { content: '', embeds: [res.embed], components: [] };
    if (i.customId.startsWith('sqty:')) await i.update(payload).catch(() => {});
    else await i.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {});
    if (!res.error) {
      const sid = shopId || item.shop_id;
      if (sid) publishShop(client, sid).catch(() => {});
    }
  };

  client.on('interactionCreate', async (i) => {
    try {
      // ---- 面板下拉選單兌換：選商品 → 選份數 ----
      if (i.isStringSelectMenu() && i.customId.startsWith('sredeem:')) {
        const gid = i.guildId;
        const c = scfg(gid), gc = gcfg(gid);
        if (!c.enabled) return i.reply({ content: '特殊商店目前停用中。', flags: MessageFlags.Ephemeral });
        const shopId = parseInt(i.customId.split(':')[1], 10) || 0;
        const item = db.prepare('SELECT * FROM special_items WHERE guild_id=? AND enabled=1 AND id=?').get(gid, parseInt(i.values[0], 10));
        if (!item) return i.reply({ content: '這個獎勵已不存在。', flags: MessageFlags.Ephemeral });
        if (item.stock === 0) return i.reply({ content: `**${item.name}** 已經兌換完了（庫存 0）。`, flags: MessageFlags.Ephemeral });
        const { cap, coins } = qtyCap(gid, item, i.user.id, i.user.username);
        if (cap <= 0) {
          return i.reply({ content: `${gc.currency_name}不夠：**${item.name}** 一份要 ${item.price.toLocaleString('en-US')}，你只有 ${coins.toLocaleString('en-US')}。`, flags: MessageFlags.Ephemeral });
        }
        // 只能換一份就不用問了，直接兌換
        if (cap === 1) return await finishRedeem(i, gid, item, shopId, 1);
        const opts = [];
        for (let n = 1; n <= cap; n++) opts.push({ label: `${n} 份`, description: `共 ${(item.price * n).toLocaleString('en-US')} ${gc.currency_name}`.slice(0, 100), value: String(n) });
        const menu = new StringSelectMenuBuilder().setCustomId(`sqty:${shopId}:${item.id}`)
          .setPlaceholder('要兌換幾份？').setMinValues(1).setMaxValues(1).addOptions(opts);
        return i.reply({
          content: `${item.emoji || '🎁'} **${item.name}**　單價 ${money(gc, item.price)}${item.stock < 0 ? '' : `　庫存 ${item.stock}`}\n要兌換幾份？（最多 ${cap} 份）`,
          components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral
        });
      }
      // ---- 選好份數 → 真正兌換 ----
      if (i.isStringSelectMenu() && i.customId.startsWith('sqty:')) {
        const gid = i.guildId;
        if (!scfg(gid).enabled) return i.update({ content: '特殊商店目前停用中。', components: [], embeds: [] }).catch(() => {});
        const [, shopIdRaw, itemIdRaw] = i.customId.split(':');
        const item = db.prepare('SELECT * FROM special_items WHERE guild_id=? AND enabled=1 AND id=?').get(gid, parseInt(itemIdRaw, 10));
        if (!item) return i.update({ content: '這個獎勵已不存在。', components: [], embeds: [] }).catch(() => {});
        return await finishRedeem(i, gid, item, parseInt(shopIdRaw, 10) || 0, parseInt(i.values[0], 10));
      }

      // 面板按鈕 adv:shop → 等同 /特殊商店
      const cmdName = (i.isButton() && i.customId === 'adv:shop') ? '特殊商店'
        : (i.isChatInputCommand() ? i.commandName : null);
      if (!['特殊商店', '兌換'].includes(cmdName)) return;
      const gid = i.guildId;
      if (!gid) return i.reply({ content: '這個指令只能在伺服器裡使用。', flags: MessageFlags.Ephemeral });
      const c = scfg(gid), gc = gcfg(gid);
      if (!c.enabled) return i.reply({ content: '特殊商店目前停用中。', flags: MessageFlags.Ephemeral });
      const uid = i.user.id, uname = i.user.username;
      const reply = (payload) => i.reply({ ...payload, flags: MessageFlags.Ephemeral });

      // ---- 特殊商店：列出各分店與商品 ----
      if (cmdName === '特殊商店') {
        // 頻道限定：這個頻道有綁分店 → 只列那幾間；沒綁的頻道維持列全部
        const all = shopsOf(gid);
        const here = c.channel_scoped ? all.filter(s => s.channel_id && s.channel_id === i.channelId) : [];
        const shops = here.length ? here : all;
        const scoped = here.length > 0;
        const w = wallet(gid, uid, uname);
        const embed = new EmbedBuilder().setColor(brandColor()).setTitle('🎁 特殊兌換商店')
          .setFooter({ text: `你的餘額：${w.coins.toLocaleString('en-US')} ${gc.currency_name}｜用 /兌換 商品名稱 兌換` });
        const blocks = [];
        for (const s of shops) {
          const its = itemsOfShop(gid, s.id);
          if (!its.length) continue;
          blocks.push(`**${s.emoji || '🏷️'} ${s.name}**\n` + its.map(it =>
            `　${it.emoji || '🎁'} ${it.name}　${money(gc, it.price)}${it.stock < 0 ? '' : `（庫存 ${it.stock}）`}`).join('\n'));
        }
        // 未分類（shop_id=0）的商品。限定到某間分店時不列，免得別店的東西混進來
        const loose = scoped ? [] : db.prepare('SELECT * FROM special_items WHERE guild_id=? AND enabled=1 AND (shop_id=0 OR shop_id IS NULL) ORDER BY sort, price').all(gid);
        if (loose.length) blocks.push('**🏷️ 其他**\n' + loose.map(it =>
          `　${it.emoji || '🎁'} ${it.name}　${money(gc, it.price)}${it.stock < 0 ? '' : `（庫存 ${it.stock}）`}`).join('\n'));
        if (!blocks.length) return await reply({ content: scoped ? '這個頻道的商店目前沒有上架任何獎勵。' : '特殊商店目前還沒有任何獎勵。' });
        if (scoped) embed.setTitle('🎁 ' + shops.map(s => `${s.emoji || '🏷️'} ${s.name}`).join('・'));
        embed.setDescription(blocks.join('\n\n'));
        // 兌換選單：跟商店面板一樣點一下就換，不用打 /兌換 名稱
        const pool = [];
        for (const sp of shops) for (const it of itemsOfShop(gid, sp.id)) pool.push({ it, shop: sp });
        if (!scoped) for (const it of loose) pool.push({ it, shop: null });
        const avail = pool.filter(x => x.it.stock !== 0);
        const rows = avail.length ? [new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder().setCustomId('sredeem:0').setPlaceholder('選擇要兌換的獎勵…')
            .addOptions(avail.slice(0, 25).map(({ it, shop }) => ({
              label: `${shop ? shop.name + '：' : ''}${it.name}`.slice(0, 100),
              description: `${it.price.toLocaleString('en-US')} ${gc.currency_name}${it.stock < 0 ? '' : `　庫存 ${it.stock}`}`.slice(0, 100),
              value: String(it.id), emoji: it.emoji || '🎁'
            })))) ] : [];
        return await reply({ embeds: [embed], components: rows });
      }

      // ---- 兌換 ----
      if (i.commandName === '兌換') {
        const what = (i.options.getString('商品') || '').trim();
        const item = db.prepare('SELECT * FROM special_items WHERE guild_id=? AND enabled=1 AND name=?').get(gid, what);
        if (!item) return await reply({ content: `找不到獎勵「${what}」，用 \`/特殊商店\` 看看有哪些。` });
        // 頻道限定：這個頻道有綁分店時，只能兌換該店的商品（否則等於繞過頻道限制）
        if (c.channel_scoped) {
          const here = shopsOf(gid).filter(s => s.channel_id && s.channel_id === i.channelId);
          if (here.length && !here.some(s => s.id === item.shop_id)) {
            return await reply({ content: `「${item.name}」不屬於這個頻道的商店，請到它自己的頻道兌換。` });
          }
        }
        const res = await doRedeem(client, gid, item, i.user, uname, i.options.getInteger('數量') || 1);
        if (res.error) return await reply({ content: res.error });
        // 若該商品所屬分店有發布面板，順手刷新庫存
        if (item.shop_id) publishShop(client, item.shop_id).catch(() => {});
        return await reply({ embeds: [res.embed] });
      }
    } catch (e) {
      logError(i.guildId || '', '特殊商店指令失敗：', e.message);
      const msg = { content: '執行失敗，管理員可到後台的系統錯誤紀錄查看原因。', flags: MessageFlags.Ephemeral };
      if (i.isRepliable && !i.replied && !i.deferred) await i.reply(msg).catch(() => {});
    }
  });

  console.log('  ↳ 特殊兌換商店模組已載入（多分店／面板發布／通知管理員）');
}

module.exports = { init, doRedeem, qtyCap };
