// 客服單系統：面板按鈕開單 → 建立專屬頻道（僅開單者與客服可見）→ 關單/刪除，全程留紀錄
const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  ChannelType, PermissionFlagsBits, MessageFlags} = require('discord.js');
const { db, guildConfig, logError } = require('../../db');
const { brandColor } = require('../../util/brand');
const { absUrl } = require('../../util/url');
const { buildButtonRows } = require('../../util/components');

const cfg = (gid) => guildConfig('ticket_config', gid);
const getPanel = (id) => db.prepare('SELECT * FROM ticket_panels WHERE id = ?').get(id);
const csv = (s) => String(s || '').split(/[\n,]/).map(x => x.trim()).filter(Boolean);

// 組出某個面板的訊息內容（開單按鈕 + 超連結按鈕）
// 多圖排版：Discord 要多個 embed「共用同一個 url」才會併成圖庫。
// 但 embed 帶了 url 標題就會變成藍色超連結，所以主 embed 不掛 url，
// 改成讓圖片專用的附屬 embed 彼此共用 —— 跟公告用的是同一套作法。
const GALLERY_URL = 'https://white.crownai.ink/';
function attachImages(main, rawJson, single) {
  let imgs = [];
  try { imgs = JSON.parse(rawJson || '[]'); } catch {}
  if (!Array.isArray(imgs)) imgs = [];
  imgs = imgs.map(u => absUrl(u)).filter(Boolean);
  // 舊資料只有單張欄位，沒設定多圖時就沿用它
  if (!imgs.length && single) imgs = [absUrl(single)];
  const extra = [];
  if (imgs.length === 1) {
    main.setImage(imgs[0]);
  } else if (imgs.length > 1) {
    // 前 4 張排成格狀，之後依序堆疊；一則訊息最多 10 個 embed
    for (const url of imgs.slice(0, 9)) {
      extra.push(new EmbedBuilder().setURL(GALLERY_URL).setImage(url));
    }
  }
  return extra;
}

function panelPayload(panel) {
  const embed = new EmbedBuilder().setColor(brandColor())
    .setTitle(panel.title || '客服中心')
    .setDescription(panel.description || '需要協助嗎？點下方按鈕開啟客服單。');
  const panelExtra = attachImages(embed, panel.images, panel.image_url);

  const openBtn = new ButtonBuilder().setCustomId(`ticket:open:${panel.id}`)
    .setLabel(panel.button_label || '開啟客服單').setStyle(ButtonStyle.Primary);
  // 圖示是管理員自訂的，有填才加（空值會被 Discord 拒絕）
  if (panel.button_emoji && panel.button_emoji.trim()) {
    try { openBtn.setEmoji(panel.button_emoji.trim()); } catch {}
  }
  const rows = [new ActionRowBuilder().addComponents(openBtn)];
  // 超連結按鈕（例如 FAQ、規範）
  rows.push(...buildButtonRows(panel.links));
  return { embeds: [embed, ...panelExtra], components: rows.slice(0, 5) };
}

// 發布指定面板
async function postPanel(client, channelId, panelId) {
  const ch = client.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
  if (!ch) throw new Error('找不到頻道');
  const panel = panelId ? getPanel(panelId) : db.prepare('SELECT * FROM ticket_panels WHERE guild_id=? ORDER BY id LIMIT 1').get(ch.guild.id);
  if (!panel) throw new Error('尚未建立任何客服面板');
  await ch.send(panelPayload(panel));
}

async function openTicket(i, subject, panelId) {
  const gid = i.guild.id;
  const c = cfg(gid);
  if (!c.enabled) return i.editReply('客服單功能目前已關閉。');
  const panel = getPanel(panelId) || db.prepare('SELECT * FROM ticket_panels WHERE guild_id=? ORDER BY id LIMIT 1').get(gid);
  if (!panel) return i.editReply('尚未設定客服面板，請聯繫管理員。');

  // 同時開單上限（該伺服器內）
  const open = db.prepare("SELECT COUNT(*) n FROM tickets WHERE guild_id=? AND user_id=? AND status='open'").get(gid, i.user.id).n;
  if (open >= (c.max_open || 1)) {
    const t = db.prepare("SELECT channel_id FROM tickets WHERE guild_id=? AND user_id=? AND status='open' ORDER BY id DESC").get(gid, i.user.id);
    return i.editReply(`你已有進行中的客服單${t ? `：<#${t.channel_id}>` : ''}，請先在原單內溝通或等候關閉。`);
  }

  const info = db.prepare('INSERT INTO tickets (guild_id, user_id, username, subject, panel_id, panel_name) VALUES (?,?,?,?,?,?)')
    .run(gid, i.user.id, i.user.username, subject || '', panel.id, panel.name);
  const ticketId = info.lastInsertRowid;

  // 客服身分組：優先用面板自己的，沒有才用全域
  const supportRoles = csv(panel.support_role_ids).length ? csv(panel.support_role_ids) : csv(c.support_role_ids);
  const categoryId = panel.category_id || c.category_id;

  // 建立專屬頻道：@everyone 不可見；開單者、客服身分組、機器人可見
  const overwrites = [
    { id: i.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: i.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
    { id: i.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory] }
  ];
  for (const rid of supportRoles) {
    overwrites.push({ id: rid, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] });
  }

  let channel;
  try {
    channel = await i.guild.channels.create({
      name: `ticket-${String(ticketId).padStart(4, '0')}-${i.user.username}`.slice(0, 90).toLowerCase(),
      type: ChannelType.GuildText,
      parent: categoryId || undefined,
      permissionOverwrites: overwrites,
      topic: `客服單 #${ticketId}｜${panel.name}｜開單者 ${i.user.tag}（${i.user.id}）${subject ? `｜主旨：${subject}` : ''}`
    });
  } catch (e) {
    db.prepare('DELETE FROM tickets WHERE id=?').run(ticketId);
    throw new Error('建立頻道失敗：' + e.message + '（請確認機器人有「管理頻道」權限，且分類設定正確）');
  }
  db.prepare('UPDATE tickets SET channel_id=? WHERE id=?').run(channel.id, ticketId);

  const welcome = String(panel.welcome_text || c.welcome_text || '').replace(/{user}/g, `<@${i.user.id}>`).replace(/{username}/g, i.user.username);
  const embed = new EmbedBuilder().setColor(brandColor()).setTitle(`客服單 #${ticketId}`)
    .setDescription(welcome + (subject ? `\n\n**主旨**：${subject}` : ''))
    .setFooter({ text: '處理完成後可按下方按鈕關閉此單' });
  const openExtra = attachImages(embed, panel.open_images, panel.open_image);
  // 關閉按鈕 + 面板設定的超連結按鈕
  const rows = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket:close:${ticketId}`).setLabel('關閉客服單').setStyle(ButtonStyle.Danger))];
  rows.push(...buildButtonRows(panel.open_links));
  const supportTags = supportRoles.map(id => `<@&${id}>`).join(' ');
  await channel.send({ content: `<@${i.user.id}> ${supportTags}`, embeds: [embed, ...openExtra], components: rows.slice(0, 5) }).catch(() => {});

  return i.editReply(`已為你開啟客服單：<#${channel.id}>`);
}

async function closeTicket(i, ticketId) {
  const c = cfg(i.guild.id);
  const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(ticketId);
  if (!t || t.status !== 'open') return i.reply({ content: '此客服單已關閉。', flags: MessageFlags.Ephemeral });

  // 開單者本人或客服/管理員可關
  const isSupport = i.member.permissions.has('ManageChannels')
    || i.member.roles.cache.some(r => csv(c.support_role_ids).includes(r.id));
  if (i.user.id !== t.user_id && !isSupport) {
    return i.reply({ content: '只有開單者或客服人員可以關閉此單。', flags: MessageFlags.Ephemeral });
  }

  db.prepare(`UPDATE tickets SET status='closed', closed_at=datetime('now','localtime'), closed_by=? WHERE id=?`)
    .run(i.user.username, ticketId);

  const ch = i.channel;
  // 鎖住開單者發言並改名
  try {
    await ch.permissionOverwrites.edit(t.user_id, { SendMessages: false });
    await ch.setName(('closed-' + ch.name).slice(0, 90));
  } catch {}

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket:del:${ticketId}`).setLabel('刪除此頻道').setStyle(ButtonStyle.Danger));
  await i.reply({
    embeds: [new EmbedBuilder().setColor(0x99aab5).setTitle('客服單已關閉')
      .setDescription(`由 ${i.user.username} 關閉。客服人員確認無誤後可刪除此頻道。`)],
    components: [row]
  }).catch(() => {});

  // 紀錄到 log 頻道
  if (c.log_channel) {
    const log = i.client.channels.cache.get(c.log_channel) || await i.client.channels.fetch(c.log_channel).catch(() => null);
    if (log) {
      await log.send({
        embeds: [new EmbedBuilder().setColor(0x99aab5).setTitle(`客服單 #${ticketId} 已關閉`)
          .addFields(
            { name: '開單者', value: `${t.username}（\`${t.user_id}\`）`, inline: true },
            { name: '關閉者', value: i.user.username, inline: true },
            { name: '開單時間', value: t.opened_at, inline: true },
            { name: '主旨', value: t.subject || '（無）' }
          )]
      }).catch(() => {});
    }
  }
}

function init(client) {
  client.on('interactionCreate', async (i) => {
    try {
      // /客服面板 指令（管理員）
      if (i.isChatInputCommand() && i.commandName === '客服面板') {
        if (!i.memberPermissions.has('ManageGuild')) {
          return i.reply({ content: '僅管理員可發布客服面板。', flags: MessageFlags.Ephemeral });
        }
        const ch = i.options.getChannel('頻道') || i.channel;
        await postPanel(client, ch.id);
        return i.reply({ content: `客服面板已發布到 <#${ch.id}>。`, flags: MessageFlags.Ephemeral });
      }

      if (i.isButton() && i.customId.startsWith('ticket:open')) {
        const panelId = i.customId.split(':')[2] || '';
        // 開單前先問主旨（可留空）
        const modal = new ModalBuilder().setCustomId(`ticket:modal:${panelId}`).setTitle('開啟客服單');
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('subject').setLabel('想詢問什麼？（可留空）')
            .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100)));
        return i.showModal(modal);
      }

      if (i.isModalSubmit() && i.customId.startsWith('ticket:modal')) {
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const panelId = parseInt(i.customId.split(':')[2], 10) || 0;
        return openTicket(i, i.fields.getTextInputValue('subject').trim(), panelId);
      }

      if (i.isButton() && i.customId.startsWith('ticket:close:')) {
        return closeTicket(i, parseInt(i.customId.split(':')[2], 10));
      }

      if (i.isButton() && i.customId.startsWith('ticket:del:')) {
        const c = cfg(i.guild.id);
        const isSupport = i.member.permissions.has('ManageChannels')
          || i.member.roles.cache.some(r => csv(c.support_role_ids).includes(r.id));
        if (!isSupport) return i.reply({ content: '僅客服人員可刪除頻道。', flags: MessageFlags.Ephemeral });
        await i.reply('頻道將在 5 秒後刪除。').catch(() => {});
        // 先把頻道抓在手上：5 秒後 i.channel 可能已經是 null（頻道被別人先刪掉、
        // 或快取失效），那時候直接 i.channel.delete() 會丟出未捕捉的例外把整個程序帶掉。
        const target = i.channel;
        setTimeout(() => {
          if (!target) return;
          target.delete('客服單處理完畢').catch(() => {});
        }, 5000);
        return;
      }
    } catch (e) {
      logError(i.guild && i.guild.id, '客服單處理失敗：', e.message);
      const msg = '' + e.message;
      if (i.deferred || i.replied) i.editReply(msg).catch(() => {});
      else if (i.isRepliable()) i.reply({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  });

  client._postTicketPanel = (chId, panelId) => postPanel(client, chId, panelId);
  client._ticketPanelPreview = (panel) => panelPayload(panel);
  console.log('  ↳ 客服單模組已載入（開單/專屬頻道/關單/紀錄）');
}

module.exports = { init, postPanel, panelPayload };
