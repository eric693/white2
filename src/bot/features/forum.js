// 論壇整理：抓取論壇貼文 → 存進資料庫（後台可查）→ 在指定頻道維護一則自動更新的目錄
const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, MessageFlags} = require('discord.js');
const cron = require('node-cron');
const { db, guildConfig, activeGuildIds, logError } = require('../../db');
const { brandColor } = require('../../util/brand');

const cfg = (gid) => guildConfig('forum_config', gid);
const csv = (s) => String(s || '').split(/[\n,]/).map(x => x.trim()).filter(Boolean);
const iso = (d) => d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '';

let clientRef = null;
let dirty = false;          // 有變動待更新目錄
let syncing = false;

// 這個伺服器裡要整理的論壇頻道
function forumChannels(guild) {
  const only = csv(cfg(guild.id).forum_ids);
  return guild.channels.cache.filter(c =>
    (c.type === ChannelType.GuildForum || c.type === ChannelType.GuildMedia) &&
    (!only.length || only.includes(c.id)));
}

function upsertPost(thread, forum) {
  const tagNames = (thread.appliedTags || [])
    .map(id => (forum.availableTags || []).find(t => t.id === id))
    .filter(Boolean).map(t => t.name);

  db.prepare(
    `INSERT INTO forum_posts (guild_id, thread_id, forum_id, forum_name, title, author_id, author_name,
       message_count, tags, archived, pinned, created_at, last_active, url, synced_at)
     VALUES (@guild_id,@thread_id,@forum_id,@forum_name,@title,@author_id,@author_name,
       @message_count,@tags,@archived,@pinned,@created_at,@last_active,@url,datetime('now','localtime'))
     ON CONFLICT(thread_id) DO UPDATE SET
       forum_name=excluded.forum_name, title=excluded.title,
       author_name=CASE WHEN excluded.author_name != '' THEN excluded.author_name ELSE forum_posts.author_name END,
       message_count=excluded.message_count, tags=excluded.tags, archived=excluded.archived,
       pinned=excluded.pinned, last_active=excluded.last_active, synced_at=datetime('now','localtime')`
  ).run({
    guild_id: forum.guildId,
    thread_id: thread.id,
    forum_id: forum.id,
    forum_name: forum.name,
    title: thread.name || '',
    author_id: thread.ownerId || '',
    author_name: '',                       // 之後用 fetch 補上顯示名稱
    // 舊討論串（2022/7 前）的 messageCount 上限為 50，這裡取兩者較大值
    message_count: Math.max(thread.messageCount || 0, thread.totalMessageSent || 0),
    tags: tagNames.join(','),
    archived: thread.archived ? 1 : 0,
    pinned: thread.flags && thread.flags.has('Pinned') ? 1 : 0,
    created_at: iso(thread.createdAt),
    last_active: iso(thread.lastMessage ? thread.lastMessage.createdAt : thread.archiveTimestamp || thread.createdAt),
    url: `https://discord.com/channels/${forum.guildId}/${thread.id}`
  });
}

// 補上發文者顯示名稱（只補還沒有名稱的，避免大量 API 呼叫）
async function fillAuthorNames(guild) {
  const rows = db.prepare("SELECT DISTINCT author_id FROM forum_posts WHERE guild_id = ? AND author_name = '' AND author_id != '' LIMIT 50").all(guild.id);
  for (const r of rows) {
    const member = guild.members.cache.get(r.author_id)
      || await guild.members.fetch(r.author_id).catch(() => null);
    const name = member ? (member.nickname || member.user.username) : null;
    if (name) db.prepare('UPDATE forum_posts SET author_name = ? WHERE guild_id = ? AND author_id = ?').run(name, guild.id, r.author_id);
  }
}

/** 完整同步：抓所有論壇的進行中與已封存貼文 */
async function syncForums(client, onlyGuildId) {
  if (syncing) return { skipped: true };
  syncing = true;
  try {
    let totalForums = 0, totalPosts = 0;
    for (const gid of (onlyGuildId ? [onlyGuildId] : activeGuildIds())) {
      const r = await syncGuildForums(client, gid);
      totalForums += r.forums; totalPosts += r.posts;
    }
    dirty = true;
    return { forums: totalForums, posts: totalPosts };
  } finally { syncing = false; }
}

async function syncGuildForums(client, gid) {
  {
    const guild = client.guilds.cache.get(gid);
    if (!guild) return { forums: 0, posts: 0 };
    const forums = forumChannels(guild);
    if (!forums.size) return { forums: 0, posts: 0 };

    let count = 0;
    for (const [, forum] of forums) {
      // 進行中的貼文
      const active = await forum.threads.fetchActive().catch(() => null);
      if (active) for (const [, t] of active.threads) { upsertPost(t, forum); count++; }

      // 已封存的貼文（分頁抓，最多 10 頁 = 1000 篇，避免卡太久）
      if (cfg(gid).show_archived) {
        let before;
        for (let page = 0; page < 10; page++) {
          const arch = await forum.threads.fetchArchived({ type: 'public', limit: 100, before }).catch(() => null);
          if (!arch || !arch.threads.size) break;
          for (const [, t] of arch.threads) { upsertPost(t, forum); count++; }
          before = arch.threads.last().archivedAt || arch.threads.last().createdAt;
          if (!arch.hasMore) break;
        }
      }
    }

    await fillAuthorNames(guild);
    db.prepare("UPDATE forum_config SET synced_at = datetime('now','localtime') WHERE guild_id = ?").run(gid);
    return { forums: forums.size, posts: count };
  }
}

// ---- 目錄內容 ----
function postsForIndex(gid) {
  const c = cfg(gid);
  const order = { messages: 'message_count DESC, last_active DESC', recent: 'last_active DESC', created: 'created_at DESC' }[c.sort_by]
    || 'message_count DESC';
  const where = c.show_archived ? 'WHERE guild_id = ?' : 'WHERE guild_id = ? AND archived = 0';
  return db.prepare(`SELECT * FROM forum_posts ${where} ORDER BY ${order}`).all(gid);
}

// 依作者彙總（玩家名稱 + 留言數）
function byAuthor(gid) {
  const c = cfg(gid);
  const where = c.show_archived ? 'WHERE guild_id = ?' : 'WHERE guild_id = ? AND archived = 0';
  return db.prepare(
    `SELECT author_id, MAX(author_name) AS author_name, COUNT(*) AS posts,
            SUM(message_count) AS messages, MAX(last_active) AS last_active
       FROM forum_posts ${where}
      GROUP BY author_id
      ORDER BY messages DESC, posts DESC`
  ).all(gid);
}

function buildIndex(gid, page = 0) {
  const c = cfg(gid);
  const per = Math.max(5, c.per_page || 15);
  const embed = new EmbedBuilder().setColor(brandColor());

  let lines = [], total = 0;
  if (c.group_by === 'author') {
    const rows = byAuthor(gid);
    total = rows.length;
    lines = rows.slice(page * per, page * per + per).map((r, n) =>
      `\`${String(page * per + n + 1).padStart(2, ' ')}.\` **${r.author_name || '未知玩家'}**　留言 ${r.messages}　（${r.posts} 篇）`);
    embed.setTitle(`${c.title}｜依玩家`)
      .setFooter({ text: `共 ${total} 位玩家　第 ${page + 1}/${Math.max(1, Math.ceil(total / per))} 頁　更新於 ${c.synced_at}` });
  } else if (c.group_by === 'tag') {
    const map = new Map();
    for (const p of postsForIndex(gid)) {
      for (const t of (p.tags ? p.tags.split(',') : ['（未分類）'])) {
        if (!map.has(t)) map.set(t, []);
        map.get(t).push(p);
      }
    }
    const tags = [...map.entries()].sort((a, b) => b[1].length - a[1].length);
    total = tags.length;
    lines = tags.slice(page * per, page * per + per).map(([tag, ps]) =>
      `**${tag}**（${ps.length} 篇）\n` + ps.slice(0, 5).map(p =>
        `　• [${p.title}](${p.url})　${p.author_name || ''}　留言 ${p.message_count}`).join('\n'));
    embed.setTitle(`${c.title}｜依標籤`)
      .setFooter({ text: `共 ${total} 個標籤　第 ${page + 1}/${Math.max(1, Math.ceil(total / per))} 頁　更新於 ${c.synced_at}` });
  } else {
    const rows = postsForIndex(gid);
    total = rows.length;
    lines = rows.slice(page * per, page * per + per).map((p, n) =>
      `\`${String(page * per + n + 1).padStart(2, ' ')}.\` [${p.title}](${p.url})\n　　${p.author_name || '未知玩家'}　留言 ${p.message_count}${p.tags ? `　${p.tags.split(',').join('、')}` : ''}${p.archived ? '　已封存' : ''}`);
    embed.setTitle(`${c.title}｜全部貼文`)
      .setFooter({ text: `共 ${total} 篇　第 ${page + 1}/${Math.max(1, Math.ceil(total / per))} 頁　更新於 ${c.synced_at}` });
  }

  embed.setDescription(lines.join('\n') || '目前沒有論壇貼文。');
  const pages = Math.max(1, Math.ceil(total / per));
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`fi:${page - 1}`).setLabel('上一頁').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
    new ButtonBuilder().setCustomId(`fi:${page + 1}`).setLabel('下一頁').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1),
    new ButtonBuilder().setCustomId('fi:refresh').setLabel('立即重新整理').setStyle(ButtonStyle.Primary)
  );
  return { embeds: [embed], components: [row] };
}

// 在指定頻道建立（或重建）唯一的目錄訊息
async function postIndex(client, channelId) {
  const ch = client.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
  if (!ch) throw new Error('找不到頻道');
  const gid = ch.guild.id;
  const c = cfg(gid);
  if (c.index_channel && c.index_message) {
    const oldCh = client.channels.cache.get(c.index_channel) || await client.channels.fetch(c.index_channel).catch(() => null);
    if (oldCh) {
      const old = await oldCh.messages.fetch(c.index_message).catch(() => null);
      if (old) await old.delete().catch(() => {});
    }
  }
  const msg = await ch.send(buildIndex(gid, 0));
  db.prepare('UPDATE forum_config SET index_channel=?, index_message=? WHERE guild_id=?').run(channelId, msg.id, gid);
  return msg.id;
}

async function refreshIndex(onlyGid) {
  for (const gid of (onlyGid ? [onlyGid] : activeGuildIds())) await refreshIndexGuild(gid).catch(() => {});
}
async function refreshIndexGuild(gid) {
  const c = cfg(gid);
  if (!clientRef || !c.index_channel || !c.index_message) return;
  const ch = clientRef.channels.cache.get(c.index_channel) || await clientRef.channels.fetch(c.index_channel).catch(() => null);
  if (!ch) return;
  const msg = await ch.messages.fetch(c.index_message).catch(() => null);
  if (!msg) return;
  await msg.edit(buildIndex(gid, 0)).catch(() => {});
}

function init(client) {
  clientRef = client;

  // 新貼文
  client.on('threadCreate', async (thread) => {
    const parent = thread.parent;
    if (!parent || (parent.type !== ChannelType.GuildForum && parent.type !== ChannelType.GuildMedia)) return;
    if (!forumChannels(thread.guild).has(parent.id)) return;
    upsertPost(thread, parent);
    dirty = true;
  });

  // 貼文更名 / 封存 / 換標籤
  client.on('threadUpdate', (_, thread) => {
    const parent = thread.parent;
    if (!parent || (parent.type !== ChannelType.GuildForum && parent.type !== ChannelType.GuildMedia)) return;
    if (!forumChannels(thread.guild).has(parent.id)) return;
    upsertPost(thread, parent);
    dirty = true;
  });

  client.on('threadDelete', (thread) => {
    db.prepare('DELETE FROM forum_posts WHERE thread_id = ?').run(thread.id);
    dirty = true;
  });

  // 論壇貼文內有新留言 → 留言數 +1
  client.on('messageCreate', (msg) => {
    if (!msg.guild || !msg.channel.isThread()) return;
    const parent = msg.channel.parent;
    if (!parent || (parent.type !== ChannelType.GuildForum && parent.type !== ChannelType.GuildMedia)) return;
    const r = db.prepare('SELECT 1 FROM forum_posts WHERE thread_id = ?').get(msg.channel.id);
    if (!r) { upsertPost(msg.channel, parent); }
    else {
      db.prepare(
        `UPDATE forum_posts SET message_count = message_count + 1, last_active = ? WHERE thread_id = ?`
      ).run(iso(new Date()), msg.channel.id);
    }
    dirty = true;
  });

  // ---- /論壇整理 指令：直接在 DC 同步並發布目錄 ----
  client.on('interactionCreate', async (i) => {
    if (!i.isChatInputCommand() || i.commandName !== '論壇整理' || !i.guild) return;
    if (!i.memberPermissions || !i.memberPermissions.has('ManageGuild')) {
      return i.reply({ content: '僅管理員可使用。', flags: MessageFlags.Ephemeral });
    }
    const gid = i.guild.id;
    try {
      const sub = i.options.getSubcommand();
      if (sub === '同步') {
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const r = await syncForums(client, gid);
        await refreshIndexGuild(gid).catch(() => {});
        return i.editReply(r.forums
          ? `已同步 ${r.forums} 個論壇、${r.posts} 篇貼文。`
          : '這個伺服器沒有論壇頻道，或尚未在後台指定要整理的論壇。');
      }
      if (sub === '發布目錄') {
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const ch = i.options.getChannel('頻道') || i.channel;
        await syncForums(client, gid).catch(() => {});
        await postIndex(client, ch.id);
        return i.editReply(`論壇目錄已發布到 <#${ch.id}>。`);
      }
      if (sub === '設定') {
        const groupBy = i.options.getString('呈現方式');
        const sortBy = i.options.getString('排序');
        const sets = [], vals = [];
        if (groupBy) { sets.push('group_by=?'); vals.push(groupBy); }
        if (sortBy) { sets.push('sort_by=?'); vals.push(sortBy); }
        if (!sets.length) return i.reply({ content: '請至少指定一個要調整的項目。', flags: MessageFlags.Ephemeral });
        db.prepare(`UPDATE forum_config SET ${sets.join(', ')} WHERE guild_id=?`).run(...vals, gid);
        await refreshIndexGuild(gid).catch(() => {});
        return i.reply({ content: '已更新論壇整理設定，目錄同步刷新。', flags: MessageFlags.Ephemeral });
      }
    } catch (e) {
      const msg = '' + e.message;
      if (i.deferred || i.replied) i.editReply(msg).catch(() => {});
      else i.reply({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  });

  // 目錄翻頁 / 手動重新整理
  client.on('interactionCreate', async (i) => {
    if (!i.isButton() || !i.customId.startsWith('fi:')) return;
    const arg = i.customId.slice(3);
    const gid = i.guild.id;
    if (arg === 'refresh') {
      await i.deferUpdate().catch(() => {});
      await syncForums(i.client, gid).catch(e => logError(gid, '論壇同步失敗：', e.message));
      return i.editReply(buildIndex(gid, 0)).catch(() => {});
    }
    return i.update(buildIndex(gid, parseInt(arg, 10) || 0)).catch(() => {});
  });

  // 有變動就更新目錄（每 2 分鐘檢查一次，避免洗版）
  cron.schedule('*/2 * * * *', async () => {
    if (!dirty) return;
    dirty = false;
    for (const gid of activeGuildIds()) {
      if (!cfg(gid).auto_update) continue;
      await refreshIndexGuild(gid).catch(e => logError(gid, '論壇目錄更新失敗：', e.message));
    }
  });

  // 每 30 分鐘完整同步一次（補抓封存、修正留言數）
  cron.schedule('*/30 * * * *', async () => {
    await syncForums(client).catch(e => console.error('論壇定時同步失敗：', e.message));
    await refreshIndex().catch(() => {});
  });

  client._postForumIndex = (chId) => postIndex(client, chId);
  client._refreshForumIndex = (gid) => refreshIndex(gid);
  client._syncForums = (gid) => syncForums(client, gid);
  console.log('  ↳ 論壇整理模組已載入（貼文同步/目錄自動更新）');
}

module.exports = { init, syncForums, postIndex, buildIndex, byAuthor };
