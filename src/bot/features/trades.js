// 玩家物易物：以物換物。提案與成交都公開公告在頻道（避免私下交易疑慮）。
// /交易 對象 給的物品 給的數量 換的物品 換的數量 → 公開提案（附「接受/拒絕」按鈕，只有對方能按）
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
  UserSelectMenuBuilder, StringSelectMenuBuilder } = require('discord.js');
const { db, guildConfig, logError } = require('../../db');
const { brandColor } = require('../../util/brand');
const { addToBag } = require('./gather');

const gcfg = (gid) => guildConfig('gather_config', gid);
const TRADE_TTL = 60 * 60 * 1000;   // 提案 1 小時內有效

const itemByName = (gid, name) => db.prepare("SELECT * FROM gather_items WHERE guild_id=? AND enabled=1 AND name=?").get(gid, name);
const invCount = (gid, uid, itemId) => (db.prepare('SELECT count FROM gather_inventory WHERE guild_id=? AND user_id=? AND item_id=?').get(gid, uid, itemId) || {}).count || 0;
const takeFromBag = (gid, uid, itemId, n) => db.prepare('UPDATE gather_inventory SET count = count - ? WHERE guild_id=? AND user_id=? AND item_id=?').run(n, gid, uid, itemId);
const label = (it, n) => `${it.emoji || ''}${it.name} ×${n}`;

// 建立一筆交易提案（/交易 與 面板交易按鈕共用）。回傳 {error} 或 {payload, tid}。
function createProposal(gid, fromUser, to, giveName, wantName, giveCount, wantCount, channelId) {
  giveCount = Math.max(1, giveCount || 1);
  wantCount = Math.max(1, wantCount || 1);
  const give = itemByName(gid, giveName);
  const want = itemByName(gid, wantName);
  if (!give) return { error: `找不到物品「${giveName}」。填背包裡的物品名稱（可用 /背包 查看）。` };
  if (!want) return { error: `找不到物品「${wantName}」。` };
  const have = invCount(gid, fromUser.id, give.id);
  if (have < giveCount) return { error: `你的 ${give.emoji || ''}${give.name} 不夠（有 ${have}，要給 ${giveCount}）。` };
  const tid = db.prepare(
    `INSERT INTO trades (guild_id,from_id,from_name,to_id,to_name,give_item_id,give_count,want_item_id,want_count,channel_id,expire_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(gid, fromUser.id, fromUser.username, to.id, to.username, give.id, giveCount, want.id, wantCount, channelId, Date.now() + TRADE_TTL).lastInsertRowid;
  const embed = new EmbedBuilder().setColor(brandColor()).setTitle('🔄 交易提案')
    .setDescription(`<@${fromUser.id}> 想用 **${label(give, giveCount)}**\n交換 <@${to.id}> 的 **${label(want, wantCount)}**`)
    .setFooter({ text: `僅 ${to.username} 可接受｜1 小時內有效｜交易 #${tid}` });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`trade:accept:${tid}`).setLabel('接受交易').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`trade:decline:${tid}`).setLabel('拒絕/取消').setStyle(ButtonStyle.Secondary)
  );
  return { payload: { content: `<@${to.id}>`, embeds: [embed], components: [row] }, tid };
}

function init(client) {
  client.on('interactionCreate', async (i) => {
    try {
      // ===== 交易精靈：全程用選單，不用打字 =====
      const invItems = (gid, uid) => db.prepare(
        `SELECT it.id, it.name, it.emoji, v.count FROM gather_inventory v JOIN gather_items it ON it.id = v.item_id
          WHERE v.guild_id=? AND v.user_id=? AND v.count>0 ORDER BY it.kind, it.price DESC`).all(gid, uid);
      const itemById = (id) => db.prepare('SELECT * FROM gather_items WHERE id=?').get(id);
      // 把整個背包分成多個下拉（每個上限 25），一次列出全部、不用先選類別；同類物品排在一起好找
      const invMenuRows = (gid, uid, base, placeholder) => {
        const rows = invItems(gid, uid);
        if (!rows.length) return null;
        const menus = [];
        for (let p = 0; p < rows.length && menus.length < 5; p += 25) {
          const slice = rows.slice(p, p + 25);
          menus.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder().setCustomId(`${base}:${p / 25}`)
              .setPlaceholder(rows.length > 25 ? `${placeholder}（第 ${p + 1}-${p + slice.length} 種）` : placeholder)
              .addOptions(slice.map(r => ({ label: `${r.emoji || ''}${r.name}`.slice(0, 100), description: `持有 ${r.count}`.slice(0, 100), value: String(r.id) })))));
        }
        return menus;
      };
      const qtyMenu = (customId, max, placeholder) => {
        const cap = Math.max(1, max);
        const n = Math.min(cap, 24);   // 留一格給「全部」，避免超過 Discord 選單 25 上限
        const opts = Array.from({ length: n }, (_, k) => ({ label: `${k + 1} 個`, value: String(k + 1) }));
        if (cap > 1) opts.push({ label: `📦 全部（${cap} 個）`, value: 'all' });
        return new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).addOptions(opts);
      };
      const uOf = (id) => `<@${id}>`;

      // 面板「交易」按鈕 → 選對象
      if (i.isButton() && i.customId === 'adv:trade') {
        const menu = new UserSelectMenuBuilder().setCustomId('tradeuser').setPlaceholder('選擇要交易的對象').setMinValues(1).setMaxValues(1);
        return i.reply({ content: '🔄 要跟誰交易？選一個人：', components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral });
      }
      // 選好對象 → 選「你要給出的物品」（從自己背包）
      if (i.isUserSelectMenu() && i.customId === 'tradeuser') {
        const targetId = i.values[0];
        if (targetId === i.user.id) return i.update({ content: '不能跟自己交易。', components: [] }).catch(() => {});
        const menus = invMenuRows(i.guildId, i.user.id, `tg:${targetId}`, '選你要給出的物品');
        if (!menus) return i.update({ content: '你的背包是空的，沒東西可以拿去交易。', components: [] }).catch(() => {});
        return i.update({ content: `🔄 跟 ${uOf(targetId)} 交易：選**你要給出**的物品（下拉可能有好幾個，往下找）`, components: menus }).catch(() => {});
      }
      // 選好給的物品 → 選給出數量
      if (i.isStringSelectMenu() && i.customId.startsWith('tg:')) {
        const targetId = i.customId.split(':')[1];
        const giveId = parseInt(i.values[0], 10);
        const have = (db.prepare('SELECT count FROM gather_inventory WHERE guild_id=? AND user_id=? AND item_id=?').get(i.guildId, i.user.id, giveId) || {}).count || 0;
        const it = itemById(giveId);
        const menu = qtyMenu(`tgq:${targetId}:${giveId}`, have, '選要給出幾個');
        return i.update({ content: `你要給出 ${it ? (it.emoji || '') + it.name : '物品'}，選數量（你有 ${have} 個）：`, components: [new ActionRowBuilder().addComponents(menu)] }).catch(() => {});
      }
      // 選好給出數量 → 選「你想換到的物品」（從對方背包）
      if (i.isStringSelectMenu() && i.customId.startsWith('tgq:')) {
        const [, targetId, giveId] = i.customId.split(':');
        const giveQty = i.values[0] === 'all' ? invCount(i.guildId, i.user.id, parseInt(giveId, 10)) : parseInt(i.values[0], 10);
        if (!(giveQty > 0)) return i.update({ content: '你已經沒有這個物品了，請重來。', components: [] }).catch(() => {});
        const menus = invMenuRows(i.guildId, targetId, `tw:${targetId}:${giveId}:${giveQty}`, '選你想換到的物品');
        if (!menus) return i.update({ content: '對方背包是空的，沒有東西可以換。', components: [] }).catch(() => {});
        return i.update({ content: `再選**你想從 ${uOf(targetId)} 換到**的物品（下拉可能有好幾個，往下找）：`, components: menus }).catch(() => {});
      }
      // 選好想換的物品 → 選換到數量
      if (i.isStringSelectMenu() && i.customId.startsWith('tw:')) {
        const [, targetId, giveId, giveQty] = i.customId.split(':');
        const wantId = parseInt(i.values[0], 10);
        const have = (db.prepare('SELECT count FROM gather_inventory WHERE guild_id=? AND user_id=? AND item_id=?').get(i.guildId, targetId, wantId) || {}).count || 0;
        const it = itemById(wantId);
        const menu = qtyMenu(`twq:${targetId}:${giveId}:${giveQty}:${wantId}`, have, '選要換到幾個');
        return i.update({ content: `你想換到 ${it ? (it.emoji || '') + it.name : '物品'}，選數量（對方有 ${have} 個）：`, components: [new ActionRowBuilder().addComponents(menu)] }).catch(() => {});
      }
      // 選好換到數量 → 建立公開提案
      if (i.isStringSelectMenu() && i.customId.startsWith('twq:')) {
        const [, targetId, giveId, giveQty, wantId] = i.customId.split(':');
        const wantQty = i.values[0] === 'all' ? invCount(i.guildId, targetId, parseInt(wantId, 10)) : parseInt(i.values[0], 10);
        if (!(wantQty > 0)) return i.update({ content: '對方已經沒有這個物品了，請重來。', components: [] }).catch(() => {});
        const to = await client.users.fetch(targetId).catch(() => null);
        if (!to || to.bot || to.id === i.user.id) return i.update({ content: '交易對象無效。', components: [] }).catch(() => {});
        const giveIt = itemById(parseInt(giveId, 10)), wantIt = itemById(parseInt(wantId, 10));
        if (!giveIt || !wantIt) return i.update({ content: '物品已不存在，請重來。', components: [] }).catch(() => {});
        const res = createProposal(i.guildId, i.user, to, giveIt.name, wantIt.name, parseInt(giveQty, 10), wantQty, i.channelId);
        if (res.error) return i.update({ content: res.error, components: [] }).catch(() => {});
        const sent = await i.channel.send(res.payload).catch(() => null);
        if (sent) db.prepare('UPDATE trades SET message_id=? WHERE id=?').run(sent.id, res.tid);
        return i.update({ content: '✅ 交易提案已送出，等對方接受！', components: [] }).catch(() => {});
      }

      // ---- 按鈕：接受 / 拒絕 ----
      if (i.isButton() && i.customId.startsWith('trade:')) {
        const [, act, idStr] = i.customId.split(':');
        const t = db.prepare('SELECT * FROM trades WHERE id=?').get(parseInt(idStr, 10));
        if (!t) return i.reply({ content: '這筆交易已不存在。', flags: MessageFlags.Ephemeral });
        if (t.status !== 'pending') return i.reply({ content: '這筆交易已經處理過了。', flags: MessageFlags.Ephemeral });
        // 只有被交易的對象能按（提案人可按拒絕當作取消）
        if (act === 'accept' && i.user.id !== t.to_id) return i.reply({ content: '只有交易對象可以接受這筆交易。', flags: MessageFlags.Ephemeral });
        if (act === 'decline' && i.user.id !== t.to_id && i.user.id !== t.from_id) return i.reply({ content: '只有交易雙方可以取消/拒絕。', flags: MessageFlags.Ephemeral });

        const give = db.prepare('SELECT * FROM gather_items WHERE id=?').get(t.give_item_id);
        const want = db.prepare('SELECT * FROM gather_items WHERE id=?').get(t.want_item_id);

        if (act === 'decline') {
          const isSelf = i.user.id === t.from_id;
          db.prepare('UPDATE trades SET status=? WHERE id=?').run(isSelf ? 'cancelled' : 'declined', t.id);
          const embed = new EmbedBuilder().setColor(0x99aab5).setTitle(isSelf ? '🚫 交易已取消' : '❌ 交易被拒絕')
            .setDescription(`<@${t.from_id}> 的 ${give ? label(give, t.give_count) : '物品'} ⇄ ${want ? label(want, t.want_count) : '物品'}（給 <@${t.to_id}>）`);
          await i.update({ embeds: [embed], components: [] }).catch(() => {});
          return;
        }

        // 接受：逾期或任一方物品不足就失敗
        if (t.expire_at && t.expire_at < Date.now()) {
          db.prepare('UPDATE trades SET status=? WHERE id=?').run('failed', t.id);
          return i.update({ embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('⌛ 交易已逾期')], components: [] }).catch(() => {});
        }
        if (!give || !want) {
          db.prepare('UPDATE trades SET status=? WHERE id=?').run('failed', t.id);
          return i.update({ content: '交易物品已不存在。', embeds: [], components: [] }).catch(() => {});
        }
        const fromHas = invCount(t.guild_id, t.from_id, t.give_item_id);
        const toHas = invCount(t.guild_id, t.to_id, t.want_item_id);
        if (fromHas < t.give_count || toHas < t.want_count) {
          db.prepare('UPDATE trades SET status=? WHERE id=?').run('failed', t.id);
          const who = fromHas < t.give_count ? `<@${t.from_id}>` : `<@${t.to_id}>`;
          const embed = new EmbedBuilder().setColor(0xed4245).setTitle('❌ 交易失敗')
            .setDescription(`${who} 的物品不足，交易取消。`);
          return i.update({ embeds: [embed], components: [] }).catch(() => {});
        }

        // 換手（原子交易）
        const tx = db.transaction(() => {
          takeFromBag(t.guild_id, t.from_id, t.give_item_id, t.give_count);
          takeFromBag(t.guild_id, t.to_id, t.want_item_id, t.want_count);
          addToBag(t.guild_id, t.to_id, t.give_item_id, t.give_count);
          addToBag(t.guild_id, t.from_id, t.want_item_id, t.want_count);
          db.prepare('UPDATE trades SET status=? WHERE id=?').run('done', t.id);
        });
        tx();
        // 公告成交內容
        const embed = new EmbedBuilder().setColor(0x57f287).setTitle('✅ 交易成交！')
          .setDescription(`<@${t.from_id}> 用 **${label(give, t.give_count)}**\n交換 <@${t.to_id}> 的 **${label(want, t.want_count)}**\n\n雙方背包已更新。`)
          .setFooter({ text: `交易 #${t.id}` });
        await i.update({ content: `🔄 <@${t.from_id}> ⇄ <@${t.to_id}> 交易完成`, embeds: [embed], components: [] }).catch(() => {});
        return;
      }

      // ---- /交易 打字搜尋（autocomplete）：給的物品→自己背包、換的物品→對方背包 ----
      if (i.isAutocomplete() && i.commandName === '交易') {
        const foc = i.options.getFocused(true);
        const q = String(foc.value || '').toLowerCase();
        let ownerId = i.user.id;
        if (foc.name === '換的物品') { const t = i.options.getUser('對象'); if (t) ownerId = t.id; }
        const rows = invItems(i.guildId, ownerId)
          .filter(r => !q || r.name.toLowerCase().includes(q)).slice(0, 25)
          .map(r => ({ name: `${r.emoji || ''}${r.name}（有 ${r.count}）`.slice(0, 100), value: r.name }));
        return i.respond(rows).catch(() => {});
      }

      // ---- /交易 ----
      if (!i.isChatInputCommand() || i.commandName !== '交易') return;
      const gid = i.guildId;
      if (!gid) return i.reply({ content: '這個指令只能在伺服器裡使用。', flags: MessageFlags.Ephemeral });
      const uid = i.user.id;

      const to = i.options.getUser('對象');
      if (to.bot) return i.reply({ content: '不能跟機器人交易。', flags: MessageFlags.Ephemeral });
      if (to.id === uid) return i.reply({ content: '不能跟自己交易。', flags: MessageFlags.Ephemeral });

      const res = createProposal(gid, i.user, to,
        (i.options.getString('給的物品') || '').trim(), (i.options.getString('換的物品') || '').trim(),
        i.options.getInteger('給的數量'), i.options.getInteger('換的數量'), i.channelId);
      if (res.error) return i.reply({ content: res.error, flags: MessageFlags.Ephemeral });
      const sent = await i.reply({ ...res.payload, fetchReply: true });
      if (sent) db.prepare('UPDATE trades SET message_id=? WHERE id=?').run(sent.id, res.tid);
    } catch (e) {
      logError(i.guildId || '', '交易指令失敗：', e.message);
      if (i.isChatInputCommand() && !i.replied && !i.deferred) i.reply({ content: '交易失敗，請稍後再試。', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  });

  console.log('  ↳ 物易物模組已載入（以物換物／公開提案與成交公告）');
}

module.exports = { init };
