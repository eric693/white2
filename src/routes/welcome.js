const express = require('express');
const { db, audit, guildConfig } = require('../db');
const { requireAuth, requireModule, guardModule } = require('../auth');

const router = express.Router();
router.use(requireAuth(), guardModule('welcome'));

router.get('/welcome', (req, res) => {
  res.json(guildConfig('welcome_config', req.guildId));
});

router.put('/welcome', (req, res) => {
  const b = req.body || {};
  db.prepare(
    `UPDATE welcome_config SET
       join_enabled=@join_enabled, join_channel=@join_channel, join_message=@join_message, join_image=@join_image,
       join_title=@join_title, join_thumb=@join_thumb, join_btn_label=@join_btn_label, join_btn_url=@join_btn_url,
       join_use_embed=@join_use_embed, join_roles=@join_roles,
       leave_enabled=@leave_enabled, leave_channel=@leave_channel, leave_message=@leave_message,
       admin_channel=@admin_channel, admin_join=@admin_join, admin_leave=@admin_leave,
       join_buttons=@join_buttons, card_enabled=@card_enabled, card_bg=@card_bg,
       card_title=@card_title, card_sub=@card_sub, card_overlay=@card_overlay, leave_use_embed=@leave_use_embed, leave_card_enabled=@leave_card_enabled, leave_card_bg=@leave_card_bg, leave_card_title=@leave_card_title, leave_card_sub=@leave_card_sub, join_stickers=@join_stickers, leave_stickers=@leave_stickers WHERE guild_id=@guild_id`
  ).run({
    join_enabled: b.join_enabled ? 1 : 0, join_channel: b.join_channel || '',
    join_message: b.join_message || '', join_image: b.join_image || '',
    join_title: b.join_title || '', join_thumb: b.join_thumb || '',
    join_btn_label: b.join_btn_label || '', join_btn_url: b.join_btn_url || '',
    join_use_embed: b.join_use_embed ? 1 : 0,
    join_roles: Array.isArray(b.join_roles) ? b.join_roles.join(',') : String(b.join_roles || ''),
    leave_enabled: b.leave_enabled ? 1 : 0, leave_channel: b.leave_channel || '',
    leave_message: b.leave_message || '',
    admin_channel: b.admin_channel || '', admin_join: b.admin_join ? 1 : 0, admin_leave: b.admin_leave ? 1 : 0,
    join_buttons: b.join_buttons || '[]',
    join_stickers: b.join_stickers || '[]', leave_stickers: b.leave_stickers || '[]',
    card_enabled: b.card_enabled ? 1 : 0, card_bg: b.card_bg || '',
    card_title: b.card_title || '{username} just joined the server',
    card_sub: b.card_sub || 'Member #{count}',
    card_overlay: String(b.card_overlay ?? '0.35'),
    leave_use_embed: b.leave_use_embed ? 1 : 0,
    leave_card_enabled: b.leave_card_enabled ? 1 : 0, leave_card_bg: b.leave_card_bg || '',
    leave_card_title: b.leave_card_title || '{username} left the server',
    leave_card_sub: b.leave_card_sub || 'We now have {count} members',
    guild_id: req.guildId
  });
  audit(req.user.name, '更新加入/退出通知設定');
  res.json({ ok: true });
});

// 歡迎卡圖預覽（用目前設定產生一張範例圖）
router.get('/welcome-card-preview', async (req, res) => {
  const { makeWelcomeCard } = require('../util/welcomecard');
  const c = guildConfig('welcome_config', req.guildId);
  const bot = require('../bot');
  const guild = bot.mainGuild(req.guildId);
  const sample = {
    username: req.query.username || '新成員',
    count: guild ? String(guild.memberCount) : '1',
    server: guild ? guild.name : '伺服器'
  };
  const fill = (t) => String(t || '')
    .replace(/{username}/g, sample.username).replace(/{user}/g, '@' + sample.username)
    .replace(/{server}/g, sample.server).replace(/{count}/g, sample.count);
  try {
    const buf = await makeWelcomeCard({
      avatarUrl: req.query.avatar || 'https://cdn.discordapp.com/embed/avatars/0.png',
      bgUrl: req.query.bg !== undefined ? req.query.bg : c.card_bg,
      title: fill(req.query.title !== undefined ? req.query.title : c.card_title),
      subtitle: fill(req.query.sub !== undefined ? req.query.sub : c.card_sub),
      overlay: parseFloat(req.query.overlay !== undefined ? req.query.overlay : c.card_overlay)
    });
    res.set('Content-Type', 'image/png').set('Cache-Control', 'no-store').send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 6.8 加入/離開歷史紀錄
router.get('/member-events', (req, res) => {
  const kw = String(req.query.q || '').trim();
  const stmt = db.prepare(
    `SELECT * FROM member_events WHERE guild_id = @g ${kw ? 'AND (user_id LIKE @k OR username LIKE @k)' : ''}
      ORDER BY id DESC LIMIT 300`
  );
  res.json(kw ? stmt.all({ g: req.guildId, k: `%${kw}%` }) : stmt.all({ g: req.guildId }));
});

// 6.9 單一玩家的加入/離開歷史與次數
router.get('/member-events/:userId', (req, res) => {
  const rows = db.prepare('SELECT * FROM member_events WHERE guild_id = ? AND user_id = ? ORDER BY id DESC').all(req.guildId, req.params.userId);
  res.json({
    events: rows,
    join_count: rows.filter(r => r.event === 'join').length,
    last_join: (rows.find(r => r.event === 'join') || {}).created_at || ''
  });
});

module.exports = router;
