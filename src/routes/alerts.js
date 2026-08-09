// 關鍵字通知與警告系統 API（規格 5.1～5.18）
const express = require('express');
const { db, audit, guildConfig } = require('../db');
const { requireAuth, requireModule } = require('../auth');
const bot = require('../bot');

const router = express.Router();
router.use(requireAuth());

// ========== 通知/警告規則（5.1～5.8、5.15）==========
const aMod = requireModule('alerts');

router.get('/alert-rules', aMod, (req, res) => {
  res.json(db.prepare('SELECT * FROM alert_rules WHERE guild_id = ? ORDER BY id DESC').all(req.guildId));
});

router.get('/alert-rules/:id/logs', aMod, (req, res) => {
  res.json(db.prepare('SELECT * FROM alert_logs WHERE guild_id = ? AND rule_id = ? ORDER BY id DESC LIMIT 200').all(req.guildId, req.params.id));
});

// 全部觸發紀錄（5.9 後台查詢）
router.get('/alert-logs', aMod, (req, res) => {
  const kw = String(req.query.q || '').trim();
  const sql = kw
    ? `SELECT * FROM alert_logs WHERE guild_id = @g AND (user_id LIKE @k OR username LIKE @k OR matched LIKE @k) ORDER BY id DESC LIMIT 300`
    : 'SELECT * FROM alert_logs WHERE guild_id = @g ORDER BY id DESC LIMIT 300';
  res.json(kw ? db.prepare(sql).all({ g: req.guildId, k: `%${kw}%` }) : db.prepare(sql).all({ g: req.guildId }));
});

const csvField = (v) => Array.isArray(v) ? v.join(',') : String(v || '');

function ruleFields(b) {
  return {
    name: b.name || '', keyword: b.keyword || '', match_type: b.match_type || 'contains',
    channels: csvField(b.channels), notify_channel: b.notify_channel || '',
    notify_user_ids: csvField(b.notify_user_ids), notify_role_ids: csvField(b.notify_role_ids),
    notify_dm: b.notify_dm ? 1 : 0, warn: b.warn ? 1 : 0, warn_reason: b.warn_reason || '',
    notify_member: b.notify_member ? 1 : 0, cooldown: parseInt(b.cooldown, 10) || 0,
    enabled: b.enabled ? 1 : 0
  };
}

router.post('/alert-rules', aMod, (req, res) => {
  const b = req.body || {};
  if (!b.keyword) return res.status(400).json({ error: '請填寫關鍵字' });
  const info = db.prepare(
    `INSERT INTO alert_rules (guild_id, name, keyword, match_type, channels, notify_channel, notify_user_ids,
       notify_role_ids, notify_dm, warn, warn_reason, notify_member, cooldown, enabled)
     VALUES (@guild_id,@name,@keyword,@match_type,@channels,@notify_channel,@notify_user_ids,
       @notify_role_ids,@notify_dm,@warn,@warn_reason,@notify_member,@cooldown,@enabled)`
  ).run({ ...ruleFields(b), guild_id: req.guildId });
  audit(req.user.name, `新增通知規則：${b.name || b.keyword}`);
  res.json({ id: info.lastInsertRowid });
});

router.put('/alert-rules/:id', aMod, (req, res) => {
  db.prepare(
    `UPDATE alert_rules SET name=@name, keyword=@keyword, match_type=@match_type, channels=@channels,
       notify_channel=@notify_channel, notify_user_ids=@notify_user_ids, notify_role_ids=@notify_role_ids,
       notify_dm=@notify_dm, warn=@warn, warn_reason=@warn_reason, notify_member=@notify_member,
       cooldown=@cooldown, enabled=@enabled WHERE id=@id AND guild_id=@guild_id`
  ).run({ ...ruleFields(req.body || {}), id: req.params.id, guild_id: req.guildId });
  audit(req.user.name, `修改通知規則 #${req.params.id}`);
  res.json({ ok: true });
});

router.delete('/alert-rules/:id', aMod, (req, res) => {
  db.prepare('DELETE FROM alert_rules WHERE id = ? AND guild_id = ?').run(req.params.id, req.guildId);
  audit(req.user.name, `刪除通知規則 #${req.params.id}`);
  res.json({ ok: true });
});

// ========== 警告與禁言（5.10～5.14）==========
const wMod = requireModule('warnings');

// 全域設定（門檻、禁言時間、通知頻道）
router.get('/warn-config', wMod, (req, res) => {
  res.json(guildConfig('warn_config', req.guildId));
});
router.put('/warn-config', wMod, (req, res) => {
  const b = req.body || {};
  db.prepare(
    `UPDATE warn_config SET threshold=?, mute_minutes=?, notify_channel=?, dm_member=?,
       escalate=?, punish1_minutes=?, punish2_minutes=?, punish3_action=?, punish3_minutes=? WHERE guild_id = ?`
  ).run(
    parseInt(b.threshold, 10) || 3,
    parseInt(b.mute_minutes, 10) || 60,
    b.notify_channel || '',
    b.dm_member ? 1 : 0,
    b.escalate ? 1 : 0,
    Math.max(0, parseInt(b.punish1_minutes, 10) || 0),
    Math.max(0, parseInt(b.punish2_minutes, 10) || 0),
    ['kick', 'mute', 'none'].includes(b.punish3_action) ? b.punish3_action : 'kick',
    Math.max(1, parseInt(b.punish3_minutes, 10) || 1440),
    req.guildId
  );
  audit(req.user.name, '更新警告與禁言設定');
  res.json({ ok: true });
});

// 玩家警告總覽（依 Discord ID 匯總）
router.get('/warnings', wMod, (req, res) => {
  const kw = String(req.query.q || '').trim();
  const where = kw ? 'WHERE guild_id = @g AND (user_id LIKE @k OR username LIKE @k)' : 'WHERE guild_id = @g';
  const stmt = db.prepare(
    `SELECT user_id,
            MAX(username) AS username,
            SUM(active) AS total,
            SUM(CASE WHEN active = 1 AND date(created_at) = date('now','localtime') THEN 1 ELSE 0 END) AS today,
            MAX(created_at) AS last_at
       FROM warnings ${where}
      GROUP BY user_id
      ORDER BY last_at DESC LIMIT 200`
  );
  res.json(kw ? stmt.all({ g: req.guildId, k: `%${kw}%` }) : stmt.all({ g: req.guildId }));
});

// 單一玩家的完整警告紀錄
router.get('/warnings/:userId', wMod, (req, res) => {
  res.json({
    warnings: db.prepare('SELECT * FROM warnings WHERE guild_id = ? AND user_id = ? ORDER BY id DESC').all(req.guildId, req.params.userId),
    mutes: db.prepare('SELECT * FROM mutes WHERE guild_id = ? AND user_id = ? ORDER BY id DESC').all(req.guildId, req.params.userId),
    logs: db.prepare('SELECT * FROM alert_logs WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT 100').all(req.guildId, req.params.userId)
  });
});

// 手動新增警告
router.post('/warnings', wMod, (req, res) => {
  const b = req.body || {};
  if (!b.user_id) return res.status(400).json({ error: '請填寫 Discord ID' });
  db.prepare(
    `INSERT INTO warnings (guild_id, user_id, username, reason, source, operator) VALUES (?, ?, ?, ?, 'manual', ?)`
  ).run(req.guildId, b.user_id, b.username || '', b.reason || '管理員手動新增', req.user.name);
  audit(req.user.name, `手動警告 ${b.user_id}：${b.reason || ''}`);
  res.json({ ok: true });
});

// 撤銷單筆警告（不計入累計，紀錄保留）
router.put('/warnings/:id/revoke', wMod, (req, res) => {
  db.prepare('UPDATE warnings SET active = 0 WHERE id = ? AND guild_id = ?').run(req.params.id, req.guildId);
  audit(req.user.name, `撤銷警告 #${req.params.id}`);
  res.json({ ok: true });
});

// 永久刪除單筆警告
router.delete('/warnings/:id', wMod, (req, res) => {
  db.prepare('DELETE FROM warnings WHERE id = ? AND guild_id = ?').run(req.params.id, req.guildId);
  audit(req.user.name, `刪除警告 #${req.params.id}`);
  res.json({ ok: true });
});

// 清空某玩家的有效警告（歸零，紀錄保留）
router.put('/warnings/user/:userId/clear', wMod, (req, res) => {
  const scope = req.query.scope === 'today'
    ? `AND date(created_at) = date('now','localtime')` : '';
  db.prepare(`UPDATE warnings SET active = 0 WHERE guild_id = ? AND user_id = ? ${scope}`).run(req.guildId, req.params.userId);
  audit(req.user.name, `清除 ${req.params.userId} 的${scope ? '當日' : '全部'}警告`);
  res.json({ ok: true });
});

// 禁言紀錄
router.get('/mutes', wMod, (req, res) => {
  res.json(db.prepare('SELECT * FROM mutes WHERE guild_id = ? ORDER BY id DESC LIMIT 200').all(req.guildId));
});

// 手動禁言
router.post('/mutes', wMod, (req, res) => {
  const b = req.body || {};
  if (!b.user_id) return res.status(400).json({ error: '請填寫 Discord ID' });
  if (!bot.client._muteMember) return res.status(503).json({ error: '機器人尚未上線' });
  bot.client._muteMember(req.guildId, b.user_id, b.minutes, b.reason, req.user.name)
    .then(id => { audit(req.user.name, `手動禁言 ${b.user_id}（${b.minutes} 分鐘）`); res.json({ id }); })
    .catch(e => res.status(400).json({ error: e.message }));
});

// 5.13 手動提前解除禁言
router.put('/mutes/:id/release', wMod, (req, res) => {
  if (!bot.client._releaseMute) return res.status(503).json({ error: '機器人尚未上線' });
  bot.client._releaseMute(req.params.id, req.user.name)
    .then(() => { audit(req.user.name, `解除禁言 #${req.params.id}`); res.json({ ok: true }); })
    .catch(e => res.status(400).json({ error: e.message }));
});

module.exports = router;
