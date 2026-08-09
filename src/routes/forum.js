// 論壇整理 API：設定、同步、目錄發布、後台查詢
const express = require('express');
const { db, audit, guildConfig } = require('../db');
const { requireAuth, requireModule, guardModule } = require('../auth');
const bot = require('../bot');

const router = express.Router();
router.use(requireAuth(), guardModule('forum'));

const csvField = (v) => Array.isArray(v) ? v.join(',') : String(v || '');

router.get('/forum-config', (req, res) => {
  res.json(guildConfig('forum_config', req.guildId));
});

router.put('/forum-config', (req, res) => {
  const b = req.body || {};
  db.prepare(
    `UPDATE forum_config SET forum_ids=@forum_ids, group_by=@group_by, sort_by=@sort_by,
       per_page=@per_page, show_archived=@show_archived, auto_update=@auto_update, title=@title WHERE guild_id=@guild_id`
  ).run({
    forum_ids: csvField(b.forum_ids),
    group_by: ['author', 'tag', 'none'].includes(b.group_by) ? b.group_by : 'author',
    sort_by: ['messages', 'recent', 'created'].includes(b.sort_by) ? b.sort_by : 'messages',
    per_page: Math.min(30, Math.max(5, parseInt(b.per_page, 10) || 15)),
    show_archived: b.show_archived ? 1 : 0,
    auto_update: b.auto_update ? 1 : 0,
    title: b.title || '📋 論壇整理', guild_id: req.guildId
  });
  audit(req.user.name, '更新論壇整理設定', 'forum');
  if (bot.client._refreshForumIndex) bot.client._refreshForumIndex(req.guildId).catch(() => {});
  res.json({ ok: true });
});

// 手動完整同步
router.post('/forum-sync', async (req, res) => {
  if (!bot.client._syncForums) return res.status(503).json({ error: '機器人尚未上線' });
  try {
    const r = await bot.client._syncForums(req.guildId);
    if (bot.client._refreshForumIndex) await bot.client._refreshForumIndex(req.guildId).catch(() => {});
    audit(req.user.name, `同步論壇貼文（${r.posts || 0} 篇）`, 'forum');
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 發布 / 重建目錄訊息
router.post('/forum-index', async (req, res) => {
  const chId = req.body && req.body.channel_id;
  if (!chId) return res.status(400).json({ error: '請選擇頻道' });
  if (!bot.client._postForumIndex) return res.status(503).json({ error: '機器人尚未上線' });
  try {
    await bot.client._postForumIndex(chId);
    audit(req.user.name, '發布論壇目錄', 'forum');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 後台查詢：貼文清單（可搜尋、排序、篩選）
router.get('/forum-posts', (req, res) => {
  const q = String(req.query.q || '').trim();
  const forum = String(req.query.forum || '').trim();
  const author = String(req.query.author || '').trim();
  const sort = { messages: 'message_count DESC', recent: 'last_active DESC', created: 'created_at DESC', title: 'title ASC' }[req.query.sort] || 'message_count DESC';

  const where = ['guild_id = @g'];
  const params = { g: req.guildId };
  if (q) { where.push('(title LIKE @q OR author_name LIKE @q OR tags LIKE @q)'); params.q = `%${q}%`; }
  if (forum) { where.push('forum_id = @forum'); params.forum = forum; }
  if (author) { where.push('author_id = @author'); params.author = author; }

  const sql = `SELECT * FROM forum_posts WHERE ${where.join(' AND ')} ORDER BY ${sort} LIMIT 500`;
  res.json(db.prepare(sql).all(params));
});

// 後台查詢：依玩家彙總（玩家名稱 + 留言數 + 篇數）
router.get('/forum-authors', (req, res) => {
  res.json(db.prepare(
    `SELECT author_id, MAX(author_name) AS author_name, COUNT(*) AS posts,
            SUM(message_count) AS messages, MAX(last_active) AS last_active
       FROM forum_posts WHERE guild_id = ? GROUP BY author_id
      ORDER BY messages DESC, posts DESC LIMIT 300`
  ).all(req.guildId));
});

// 目前伺服器的論壇頻道清單
router.get('/forum-channels', (req, res) => {
  const guild = bot.mainGuild(req.guildId);
  if (!guild) return res.json([]);
  res.json(guild.channels.cache
    .filter(c => c.type === 15 || c.type === 16)
    .map(c => ({ id: c.id, name: c.name }))
    .sort((a, b) => a.name.localeCompare(b.name)));
});

module.exports = router;
