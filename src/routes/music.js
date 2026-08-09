// 音樂系統 API（規格 9.15～9.21）
const express = require('express');
const { db, audit, guildConfig } = require('../db');
const { requireAuth, requireModule, guardModule } = require('../auth');
const bot = require('../bot');

const router = express.Router();
router.use(requireAuth(), guardModule('music'));

const csvField = (v) => Array.isArray(v) ? v.join(',') : String(v || '');

router.get('/music-config', (req, res) => {
  res.json(guildConfig('music_config', req.guildId));
});

router.put('/music-config', (req, res) => {
  const b = req.body || {};
  db.prepare(
    `UPDATE music_config SET voice_channel=@voice_channel, stay_24_7=@stay_24_7,
       default_volume=@default_volume, max_volume=@max_volume, allow_duplicate=@allow_duplicate,
       vote_skip=@vote_skip, log_channel=@log_channel, dj_role_ids=@dj_role_ids,
       request_role_ids=@request_role_ids, admin_role_ids=@admin_role_ids WHERE guild_id=@guild_id`
  ).run({
    voice_channel: b.voice_channel || '', stay_24_7: b.stay_24_7 ? 1 : 0,
    default_volume: Math.min(200, Math.max(0, parseInt(b.default_volume, 10) || 50)),
    max_volume: Math.min(200, Math.max(1, parseInt(b.max_volume, 10) || 100)),
    allow_duplicate: b.allow_duplicate ? 1 : 0, vote_skip: b.vote_skip ? 1 : 0,
    log_channel: b.log_channel || '',
    dj_role_ids: csvField(b.dj_role_ids), request_role_ids: csvField(b.request_role_ids),
    admin_role_ids: csvField(b.admin_role_ids), guild_id: req.guildId
  });
  audit(req.user.name, '更新音樂系統設定');
  if (bot.client._musicResident) bot.client._musicResident().catch(() => {});
  res.json({ ok: true });
});

// 9.17 在指定頻道建立唯一的控制面板
router.post('/music-panel', async (req, res) => {
  const chId = req.body && req.body.channel_id;
  if (!chId) return res.status(400).json({ error: '請選擇頻道' });
  if (!bot.client._postMusicPanel) return res.status(503).json({ error: '機器人尚未上線' });
  try {
    await bot.client._postMusicPanel(chId);
    audit(req.user.name, '發布音樂控制面板');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 9.20 音樂使用紀錄
router.get('/music-logs', (req, res) => {
  const kw = String(req.query.q || '').trim();
  const stmt = db.prepare(
    `SELECT * FROM music_logs WHERE guild_id = @g ${kw ? 'AND (username LIKE @k OR title LIKE @k)' : ''}
      ORDER BY id DESC LIMIT 300`
  );
  res.json(kw ? stmt.all({ g: req.guildId, k: `%${kw}%` }) : stmt.all({ g: req.guildId }));
});

module.exports = router;
