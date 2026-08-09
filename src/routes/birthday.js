const express = require('express');
const { db, audit, guildConfig } = require('../db');
const { requireAuth, requireModule, guardModule } = require('../auth');
const bot = require('../bot');

const router = express.Router();
router.use(requireAuth(), guardModule('birthday'));

// ---- 驗證設定 ----
router.get('/verify-config', (req, res) => {
  res.json(guildConfig('verify_config', req.guildId));
});
router.put('/verify-config', (req, res) => {
  const b = req.body || {};
  db.prepare(
    `UPDATE verify_config SET enabled=?, min_age=?, verify_channel=?, pass_role=?, kick_underage=?, prompt_text=?, join_prompt_mode=?, prompt_delete_sec=? WHERE guild_id=?`
  ).run(b.enabled ? 1 : 0, parseInt(b.min_age) || 18, b.verify_channel || '', b.pass_role || '', b.kick_underage ? 1 : 0, b.prompt_text || '',
    ['dm', 'channel', 'panel'].includes(b.join_prompt_mode) ? b.join_prompt_mode : 'dm',
    Math.max(0, parseInt(b.prompt_delete_sec, 10) || 0), req.guildId);
  audit(req.user.name, '更新生日驗證設定');
  res.json({ ok: true });
});

// 發布驗證面板到指定頻道
router.post('/verify-panel', async (req, res) => {
  const chId = (req.body && req.body.channel_id) || guildConfig('verify_config', req.guildId).verify_channel;
  if (!chId) return res.status(400).json({ error: '尚未設定驗證頻道' });
  if (!bot.client._postVerifyPanel) return res.status(503).json({ error: '機器人尚未上線' });
  try { await bot.client._postVerifyPanel(chId, req.guildId); audit(req.user.name, '發布驗證面板'); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- 慶生設定 ----
router.get('/birthday-config', (req, res) => {
  res.json(guildConfig('birthday_config', req.guildId));
});
router.put('/birthday-config', (req, res) => {
  const b = req.body || {};
  db.prepare(
    `UPDATE birthday_config SET enabled=@enabled, channel=@channel, message=@message,
       birthday_role=@birthday_role, reward_text=@reward_text, send_time=@send_time,
       mention_star=@mention_star, remind_enabled=@remind_enabled, remind_mode=@remind_mode,
       remind_channel=@remind_channel, remind_days=@remind_days, remind_text=@remind_text,
       remind_role=@remind_role WHERE guild_id=@guild_id`
  ).run({
    enabled: b.enabled ? 1 : 0, channel: b.channel || '', message: b.message || '',
    birthday_role: b.birthday_role || '', reward_text: b.reward_text || '',
    send_time: b.send_time || '09:00', mention_star: b.mention_star ? 1 : 0,
    remind_enabled: b.remind_enabled ? 1 : 0, remind_mode: b.remind_mode || 'channel',
    remind_channel: b.remind_channel || '', remind_days: Math.max(1, parseInt(b.remind_days, 10) || 3),
    remind_text: b.remind_text || '', remind_role: b.remind_role || '', guild_id: req.guildId
  });
  audit(req.user.name, '更新慶生設定');
  res.json({ ok: true });
});

// 10.3 發布生日填寫面板
router.post('/birthday-panel', async (req, res) => {
  const chId = (req.body && req.body.channel_id)
    || guildConfig('birthday_config', req.guildId).remind_channel;
  if (!chId) return res.status(400).json({ error: '請選擇頻道' });
  if (!bot.client._postBirthdayPanel) return res.status(503).json({ error: '機器人尚未上線' });
  try { await bot.client._postBirthdayPanel(chId, req.guildId); audit(req.user.name, '發布生日填寫面板'); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// 10.7 生日資料異動紀錄與祝福發送紀錄
router.get('/birthday-logs', (req, res) => {
  res.json({
    history: db.prepare('SELECT * FROM birthday_history WHERE guild_id = ? ORDER BY id DESC LIMIT 200').all(req.guildId),
    sends: db.prepare(
      `SELECT s.*, b.username FROM birthday_sends s
         LEFT JOIN birthdays b ON b.user_id = s.user_id AND b.guild_id = s.guild_id
        WHERE s.guild_id = ? ORDER BY s.sent_at DESC LIMIT 200`
    ).all(req.guildId)
  });
});

// ---- 生日名單 ----
router.get('/birthdays', (req, res) => {
  res.json(db.prepare('SELECT * FROM birthdays WHERE guild_id = ? ORDER BY birth_m, birth_d').all(req.guildId));
});
router.post('/birthdays', (req, res) => {
  const b = req.body || {};
  if (!b.user_id || !b.birth_y || !b.birth_m || !b.birth_d) return res.status(400).json({ error: '請填完整' });
  const old = db.prepare('SELECT * FROM birthdays WHERE guild_id = ? AND user_id = ?').get(req.guildId, b.user_id);
  db.prepare(
    `INSERT INTO birthdays (guild_id, user_id, username, birth_y, birth_m, birth_d) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET username=excluded.username, birth_y=excluded.birth_y, birth_m=excluded.birth_m, birth_d=excluded.birth_d`
  ).run(req.guildId, b.user_id, b.username || '', parseInt(b.birth_y), parseInt(b.birth_m), parseInt(b.birth_d));
  db.prepare(
    `INSERT INTO birthday_history (guild_id, user_id, username, action, old_value, new_value, operator)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(req.guildId, b.user_id, b.username || '', old ? 'update' : 'set',
    old ? `${old.birth_y}/${old.birth_m}/${old.birth_d}` : '',
    `${b.birth_y}/${b.birth_m}/${b.birth_d}`, req.user.name);
  audit(req.user.name, `新增/修改生日 ${b.user_id}`);
  res.json({ ok: true });
});
router.delete('/birthdays/:userId', (req, res) => {
  const old = db.prepare('SELECT * FROM birthdays WHERE guild_id = ? AND user_id = ?').get(req.guildId, req.params.userId);
  if (old) {
    db.prepare(
      `INSERT INTO birthday_history (guild_id, user_id, username, action, old_value, operator)
       VALUES (?, ?, ?, 'delete', ?, ?)`
    ).run(req.guildId, old.user_id, old.username, `${old.birth_y}/${old.birth_m}/${old.birth_d}`, req.user.name);
  }
  db.prepare('DELETE FROM birthdays WHERE guild_id = ? AND user_id = ?').run(req.guildId, req.params.userId);
  audit(req.user.name, `刪除生日 ${req.params.userId}`);
  res.json({ ok: true });
});

module.exports = router;
