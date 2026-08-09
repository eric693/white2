const express = require('express');
const { db, audit } = require('../db');
const { requireAuth, requireModule, guardModule } = require('../auth');
const bot = require('../bot');

const router = express.Router();
router.use(requireAuth(), guardModule('polls'));

router.get('/polls', (req, res) => {
  const polls = db.prepare('SELECT * FROM polls WHERE guild_id = ? ORDER BY id DESC').all(req.guildId);
  for (const p of polls) {
    p.total = db.prepare('SELECT COUNT(DISTINCT user_id) c FROM poll_votes WHERE poll_id=?').get(p.id).c;
    try { p.option_list = JSON.parse(p.options); } catch { p.option_list = []; }
  }
  res.json(polls);
});

// 投票明細（票數、投票者、各選項）
router.get('/polls/:id/detail', (req, res) => {
  const p = db.prepare('SELECT * FROM polls WHERE id=? AND guild_id=?').get(req.params.id, req.guildId);
  if (!p) return res.status(404).json({ error: '找不到投票' });
  let opts = []; try { opts = JSON.parse(p.options); } catch {}
  const result = opts.map((o, idx) => {
    const voters = db.prepare('SELECT user_id FROM poll_votes WHERE poll_id=? AND option_index=?').all(p.id, idx).map(r => r.user_id);
    return { option: o, count: voters.length, voters: p.anonymous ? [] : voters };
  });
  const total = db.prepare('SELECT COUNT(DISTINCT user_id) c FROM poll_votes WHERE poll_id=?').get(p.id).c;
  res.json({ poll: p, result, total });
});

router.post('/polls', async (req, res) => {
  const b = req.body || {};
  const opts = (b.options || []).map(s => String(s).trim()).filter(Boolean);
  if (!b.question) return res.status(400).json({ error: '請填寫題目' });
  if (opts.length < 2) return res.status(400).json({ error: '至少要有 2 個選項' });
  if (opts.length > 10) return res.status(400).json({ error: '最多 10 個選項' });
  if (!b.channel_id) return res.status(400).json({ error: '請選擇頻道' });
  const roles = Array.isArray(b.allowed_roles) ? b.allowed_roles.join(',') : (b.allowed_roles || '');
  const started = b.start_at ? 0 : 1;
  const info = db.prepare(
    `INSERT INTO polls (guild_id, note, question, description, options, multi, anonymous, allowed_roles, allow_change, hide_results, channel_id, start_at, deadline, started, creator)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(req.guildId, b.note || '', b.question, b.description || '', JSON.stringify(opts), b.multi ? 1 : 0, b.anonymous ? 1 : 0,
    roles, b.allow_change ? 1 : 0, b.hide_results ? 1 : 0, b.channel_id, b.start_at || '', b.deadline || '', started, req.user.name);
  const poll = db.prepare('SELECT * FROM polls WHERE id=?').get(info.lastInsertRowid);
  if (!bot.client._postPoll) return res.status(503).json({ error: '機器人尚未上線' });
  try { await bot.client._postPoll(poll); }
  catch (e) { return res.status(500).json({ error: e.message }); }
  audit(req.user.name, `建立投票：${b.question}`);
  res.json({ id: poll.id });
});

router.post('/polls/:id/close', async (req, res) => {
  const p = db.prepare('SELECT id FROM polls WHERE id=? AND guild_id=?').get(req.params.id, req.guildId);
  if (!p) return res.status(404).json({ error: '找不到投票' });
  if (!bot.client._closePoll) return res.status(503).json({ error: '機器人尚未上線' });
  await bot.client._closePoll(req.params.id);
  audit(req.user.name, `提前結束投票 #${req.params.id}`);
  res.json({ ok: true });
});

router.delete('/polls/:id', (req, res) => {
  db.prepare('DELETE FROM polls WHERE id=? AND guild_id=?').run(req.params.id, req.guildId);
  db.prepare('DELETE FROM poll_votes WHERE poll_id=? AND guild_id=?').run(req.params.id, req.guildId);
  audit(req.user.name, `刪除投票 #${req.params.id}`);
  res.json({ ok: true });
});

module.exports = router;
