// 貼文轉盤後台 API：抽選紀錄查詢、補抽、刪除紀錄
// （轉盤本身沒有設定要調 —— 都在 /貼文轉盤 指令的選項裡，所以這頁只有紀錄）
const express = require('express');
const { db, audit } = require('../db');
const { requireAuth, guardModule } = require('../auth');
const bot = require('../bot');

const router = express.Router();
router.use(requireAuth(), guardModule('postwheel'));

const parseWinners = (r) => { try { return JSON.parse(r.winners || '[]'); } catch { return []; } };

router.get('/postwheel-draws', (req, res) => {
  const rows = db.prepare('SELECT * FROM postwheel_draws WHERE guild_id=? ORDER BY id DESC LIMIT 300').all(req.guildId);
  res.json(rows.map(r => ({ ...r, winners: parseWinners(r) })));
});

// 補抽：重新讀那則貼文的留言者，預設排除先前已中獎的人
router.post('/postwheel-draws/:id/reroll', async (req, res) => {
  const rec = db.prepare('SELECT id FROM postwheel_draws WHERE id=? AND guild_id=?').get(req.params.id, req.guildId);
  if (!rec) return res.status(404).json({ error: '找不到這筆紀錄' });
  const client = bot.client;
  if (!client || !client._rerollPostWheel) return res.status(503).json({ error: '機器人尚未上線' });
  try {
    const out = await client._rerollPostWheel(parseInt(req.params.id, 10), {
      count: parseInt((req.body || {}).count, 10) || 1,
      excludePrevious: String((req.body || {}).exclude_previous ?? '1') !== '0',
      operatorName: req.user.name
    });
    audit(req.user.name, `貼文轉盤補抽 #${req.params.id}`, 'postwheel', '', req.guildId);
    res.json({ ok: true, ...out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/postwheel-draws/:id', (req, res) => {
  db.prepare('DELETE FROM postwheel_draws WHERE id=? AND guild_id=?').run(req.params.id, req.guildId);
  audit(req.user.name, `刪除貼文轉盤紀錄 #${req.params.id}`, 'postwheel', '', req.guildId);
  res.json({ ok: true });
});

module.exports = router;
