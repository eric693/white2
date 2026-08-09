// 功能黑名單（規格 11.3）
const express = require('express');
const { db, audit } = require('../db');
const { requireAuth, requireModule, guardModule } = require('../auth');

const bot = require('../bot');

const router = express.Router();
router.use(requireAuth(), guardModule('blacklist'));

router.get('/blacklist', (req, res) => {
  res.json(db.prepare('SELECT * FROM blacklist WHERE guild_id = ? ORDER BY created_at DESC').all(req.guildId));
});

router.post('/blacklist', async (req, res) => {
  const b = req.body || {};
  if (!b.user_id) return res.status(400).json({ error: '請填寫使用者 ID' });
  // 預設只擋抽獎：漏填範圍時把人整個封掉風險太大（舊版預設 'all' 造成過誤封）
  const feat = b.feature || 'giveaways';
  db.prepare(
    `INSERT INTO blacklist (guild_id, user_id, username, reason, feature, expires_at, active, operator)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET username=excluded.username, reason=excluded.reason,
       feature=excluded.feature, expires_at=excluded.expires_at, active=1, operator=excluded.operator`
  ).run(req.guildId, b.user_id, b.username || '', b.reason || '', feat,
    (b.expires_at || '').replace('T', ' '), req.user.name);
  audit(req.user.name, `加入黑名單 ${b.user_id}`, 'blacklist',
    `功能：${feat}｜原因：${b.reason || ''}｜到期：${b.expires_at || '永久'}`);

  // 若封鎖範圍涵蓋抽獎，把他從所有未結束的抽獎名單中移除，
  // 否則他先前報名的紀錄會繼續佔著「參加人數」（也會影響人數不足流標的判斷）。
  let purged = 0;
  if ((feat === 'all' || feat === 'giveaways') && bot.client && bot.client._purgeEntriesOf) {
    try { purged = await bot.client._purgeEntriesOf(req.guildId, b.user_id); } catch {}
  }
  res.json({ ok: true, purged });
});

// 解除限制（保留紀錄）
router.put('/blacklist/:userId/release', (req, res) => {
  db.prepare('UPDATE blacklist SET active=0 WHERE guild_id=? AND user_id=?').run(req.guildId, req.params.userId);
  audit(req.user.name, `解除黑名單 ${req.params.userId}`, 'blacklist');
  res.json({ ok: true });
});

router.delete('/blacklist/:userId', (req, res) => {
  db.prepare('DELETE FROM blacklist WHERE guild_id=? AND user_id=?').run(req.guildId, req.params.userId);
  audit(req.user.name, `移除黑名單 ${req.params.userId}`, 'blacklist');
  res.json({ ok: true });
});

module.exports = router;
