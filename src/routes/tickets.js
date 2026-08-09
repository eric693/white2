// 客服單 + 經驗值等級 API
const express = require('express');
const { db, audit, guildConfig } = require('../db');
const { requireAuth, requireModule } = require('../auth');
const bot = require('../bot');

const router = express.Router();
router.use(requireAuth());

const csvField = (v) => Array.isArray(v) ? v.join(',') : String(v || '');

// ========== 客服單 ==========
const tMod = requireModule('tickets');

router.get('/ticket-config', tMod, (req, res) => {
  res.json(guildConfig('ticket_config', req.guildId));
});

router.put('/ticket-config', tMod, (req, res) => {
  const b = req.body || {};
  db.prepare(
    `UPDATE ticket_config SET enabled=@enabled, category_id=@category_id, support_role_ids=@support_role_ids,
       log_channel=@log_channel, panel_title=@panel_title, panel_text=@panel_text,
       button_label=@button_label, welcome_text=@welcome_text, max_open=@max_open WHERE guild_id=@guild_id`
  ).run({
    enabled: b.enabled ? 1 : 0, category_id: b.category_id || '',
    support_role_ids: csvField(b.support_role_ids), log_channel: b.log_channel || '',
    panel_title: b.panel_title || '🎫 客服中心', panel_text: b.panel_text || '',
    button_label: b.button_label || '開啟客服單', welcome_text: b.welcome_text || '',
    max_open: Math.max(1, parseInt(b.max_open, 10) || 1), guild_id: req.guildId
  });
  audit(req.user.name, '更新客服單設定', 'tickets');
  res.json({ ok: true });
});

// ---- 多組客服面板 CRUD ----
router.get('/ticket-panels', tMod, (req, res) => {
  res.json(db.prepare('SELECT * FROM ticket_panels WHERE guild_id = ? ORDER BY id').all(req.guildId));
});

function panelFields(b) {
  return {
    name: b.name || '', note: b.note || '', title: b.title || '🎫 客服中心', description: b.description || '',
    image_url: b.image_url || '', button_label: b.button_label || '開啟客服單',
    button_emoji: b.button_emoji || '🎫', links: b.links || '[]',
    category_id: b.category_id || '', support_role_ids: csvField(b.support_role_ids),
    welcome_text: b.welcome_text || '', open_image: b.open_image || '', open_links: b.open_links || '[]',
    open_images: b.open_images || '[]', images: b.images || '[]',
    enabled: b.enabled ? 1 : 0
  };
}

router.post('/ticket-panels', tMod, (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: '請填寫面板名稱' });
  const info = db.prepare(
    `INSERT INTO ticket_panels (guild_id, name, note, title, description, image_url, button_label, button_emoji,
       links, category_id, support_role_ids, welcome_text, open_image, open_images, images, open_links, enabled)
     VALUES (@guild_id,@name,@note,@title,@description,@image_url,@button_label,@button_emoji,
       @links,@category_id,@support_role_ids,@welcome_text,@open_image,@open_images,@images,@open_links,@enabled)`
  ).run({ ...panelFields(b), guild_id: req.guildId });
  audit(req.user.name, `新增客服面板：${b.name}`, 'tickets');
  res.json({ id: info.lastInsertRowid });
});

router.put('/ticket-panels/:id', tMod, (req, res) => {
  db.prepare(
    `UPDATE ticket_panels SET name=@name, note=@note, title=@title, description=@description, image_url=@image_url,
       button_label=@button_label, button_emoji=@button_emoji, links=@links, category_id=@category_id,
       support_role_ids=@support_role_ids, welcome_text=@welcome_text, open_image=@open_image,
       open_images=@open_images, images=@images,
       open_links=@open_links, enabled=@enabled WHERE id=@id AND guild_id=@guild_id`
  ).run({ ...panelFields(req.body || {}), id: req.params.id, guild_id: req.guildId });
  audit(req.user.name, `修改客服面板 #${req.params.id}`, 'tickets');
  res.json({ ok: true });
});

router.delete('/ticket-panels/:id', tMod, (req, res) => {
  db.prepare('DELETE FROM ticket_panels WHERE id=? AND guild_id=?').run(req.params.id, req.guildId);
  audit(req.user.name, `刪除客服面板 #${req.params.id}`, 'tickets');
  res.json({ ok: true });
});

// 發布指定面板到頻道
router.post('/ticket-panel', tMod, async (req, res) => {
  const chId = req.body && req.body.channel_id;
  const panelId = req.body && req.body.panel_id;
  if (!chId) return res.status(400).json({ error: '請選擇頻道' });
  if (!bot.client._postTicketPanel) return res.status(503).json({ error: '機器人尚未上線' });
  try { await bot.client._postTicketPanel(chId, panelId); audit(req.user.name, '發布客服面板', 'tickets'); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/tickets', tMod, (req, res) => {
  res.json(db.prepare('SELECT * FROM tickets WHERE guild_id = ? ORDER BY id DESC LIMIT 300').all(req.guildId));
});

// ========== 經驗值等級 ==========
const lMod = requireModule('levels');

router.get('/xp-config', lMod, (req, res) => {
  res.json({
    config: guildConfig('xp_config', req.guildId),
    level_roles: db.prepare('SELECT * FROM level_roles WHERE guild_id = ? ORDER BY level').all(req.guildId)
  });
});

router.put('/xp-config', lMod, (req, res) => {
  const b = req.body || {};
  db.prepare(
    `UPDATE xp_config SET enabled=@enabled, min_xp=@min_xp, max_xp=@max_xp, cooldown=@cooldown,
       ignore_channels=@ignore_channels, levelup_channel=@levelup_channel,
       levelup_message=@levelup_message, remove_prev=@remove_prev, card_bg=@card_bg WHERE guild_id=@guild_id`
  ).run({
    enabled: b.enabled ? 1 : 0,
    min_xp: Math.max(1, parseInt(b.min_xp, 10) || 15),
    max_xp: Math.max(1, parseInt(b.max_xp, 10) || 25),
    cooldown: Math.max(0, parseInt(b.cooldown, 10) || 60),
    ignore_channels: csvField(b.ignore_channels),
    levelup_channel: b.levelup_channel || '',
    levelup_message: b.levelup_message || '',
    remove_prev: b.remove_prev ? 1 : 0, card_bg: b.card_bg || '', guild_id: req.guildId
  });
  audit(req.user.name, '更新經驗值設定', 'levels');
  res.json({ ok: true });
});

// 等級身分組 CRUD
router.post('/level-roles', lMod, (req, res) => {
  const b = req.body || {};
  const level = parseInt(b.level, 10);
  if (!level || !b.role_id) return res.status(400).json({ error: '請填等級與身分組' });
  db.prepare('INSERT INTO level_roles (guild_id, level, role_id) VALUES (?, ?, ?) ON CONFLICT(guild_id, level) DO UPDATE SET role_id=excluded.role_id')
    .run(req.guildId, level, b.role_id);
  audit(req.user.name, `設定等級 ${level} 身分組`, 'levels');
  res.json({ ok: true });
});
router.delete('/level-roles/:level', lMod, (req, res) => {
  db.prepare('DELETE FROM level_roles WHERE guild_id = ? AND level = ?').run(req.guildId, req.params.level);
  audit(req.user.name, `刪除等級 ${req.params.level} 身分組`, 'levels');
  res.json({ ok: true });
});

// 排行榜與玩家調整
router.get('/xp-leaderboard', lMod, (req, res) => {
  res.json(db.prepare('SELECT * FROM user_xp WHERE guild_id = ? ORDER BY xp DESC LIMIT 200').all(req.guildId));
});
router.put('/xp/:userId', lMod, (req, res) => {
  const xp = Math.max(0, parseInt(req.body && req.body.xp, 10) || 0);
  const { levelOf } = require('../bot/features/xp');
  db.prepare('UPDATE user_xp SET xp = ?, level = ? WHERE guild_id = ? AND user_id = ?')
    .run(xp, levelOf(xp).level, req.guildId, req.params.userId);
  audit(req.user.name, `調整 ${req.params.userId} 經驗值為 ${xp}`, 'levels');
  res.json({ ok: true });
});
router.delete('/xp/:userId', lMod, (req, res) => {
  db.prepare('DELETE FROM user_xp WHERE guild_id = ? AND user_id = ?').run(req.guildId, req.params.userId);
  audit(req.user.name, `重置 ${req.params.userId} 經驗值`, 'levels');
  res.json({ ok: true });
});

module.exports = router;
