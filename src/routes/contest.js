// 大賽後台 API（週賽／月賽）。權限沿用 gather：跟每日任務同一個管理員在管。
const express = require('express');
const { db, audit } = require('../db');
const { requireAuth, guardModule } = require('../auth');
const { METRICS } = require('../util/achievements');

const router = express.Router();
router.use(requireAuth(), guardModule('gather'));

const int = (v, d = 0, min = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(min, n) : d; };
const str = (v, d = '') => (v === undefined || v === null) ? d : String(v);

router.get('/contest-meta', (req, res) => {
  res.json({
    metrics: Object.entries(METRICS).map(([key, m]) => ({ key, label: m.name, unit: m.unit || '' })),
    titles: db.prepare('SELECT id, name, emoji FROM title_defs WHERE guild_id=? ORDER BY sort, id').all(req.guildId)
  });
});

router.get('/contests', (req, res) => {
  const rows = db.prepare('SELECT * FROM contests WHERE guild_id=? ORDER BY id DESC LIMIT 50').all(req.guildId);
  const top = db.prepare('SELECT username, score FROM contest_scores WHERE contest_id=? AND score>0 ORDER BY score DESC LIMIT 5');
  res.json(rows.map(r => ({ ...r, top: top.all(r.id) })));
});

function fields(b) {
  const start = b.start_at ? Date.parse(b.start_at) : Date.now();
  const days = Math.max(0.04, parseFloat(b.duration_days) || 7);
  const s = Number.isFinite(start) ? start : Date.now();
  return {
    name: str(b.name), emoji: str(b.emoji) || '🏆', description: str(b.description),
    metric: METRICS[b.metric] ? b.metric : 'total_earned',
    start_ts: s, end_ts: s + Math.round(days * 86400000),
    reward1: int(b.reward1, 0, 0), reward2: int(b.reward2, 0, 0), reward3: int(b.reward3, 0, 0),
    title_id: int(b.title_id, 0, 0), min_score: int(b.min_score, 1, 0),
    channel: str(b.channel), repeat_days: int(b.repeat_days, 0, 0)
  };
}

router.post('/contests', (req, res) => {
  const f = fields(req.body || {});
  if (!f.name) return res.status(400).json({ error: '請填大賽名稱' });
  const keys = Object.keys(f);
  const r = db.prepare(
    `INSERT INTO contests (guild_id, created_by, status, ${keys.join(',')})
     VALUES (?, ?, 'scheduled', ${keys.map(() => '?').join(',')})`
  ).run(req.guildId, req.user.name, ...keys.map(k => f[k]));
  audit(req.user.name, `新增大賽：${f.name}`, 'gather', '', req.guildId);
  res.json({ id: r.lastInsertRowid });
});

router.put('/contests/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM contests WHERE id=? AND guild_id=?').get(req.params.id, req.guildId);
  if (!cur) return res.status(404).json({ error: '找不到這場大賽' });
  if (cur.status === 'ended') return res.status(400).json({ error: '已結束的大賽不能再改' });
  const f = fields(req.body || {});
  // 開賽後不准改比賽項目與起跑時間：baseline 已經記錄，改了等於整份分數作廢
  if (cur.status === 'live') { f.metric = cur.metric; f.start_ts = cur.start_ts; }
  const keys = Object.keys(f);
  db.prepare(`UPDATE contests SET ${keys.map(k => `${k}=?`).join(',')} WHERE id=? AND guild_id=?`)
    .run(...keys.map(k => f[k]), cur.id, req.guildId);
  audit(req.user.name, `修改大賽 #${cur.id}`, 'gather', '', req.guildId);
  res.json({ ok: true, locked: cur.status === 'live' });
});

router.delete('/contests/:id', (req, res) => {
  const a = db.prepare('SELECT * FROM contests WHERE id=? AND guild_id=?').get(req.params.id, req.guildId);
  if (!a) return res.status(404).json({ error: '找不到這場大賽' });
  db.transaction(() => {
    db.prepare('DELETE FROM contest_scores WHERE contest_id=?').run(a.id);
    db.prepare("UPDATE contests SET status='cancelled' WHERE id=?").run(a.id);
  })();
  audit(req.user.name, `取消大賽 #${a.id}`, 'gather', '', req.guildId);
  res.json({ ok: true });
});

// 立刻結算（提早開獎，發完獎金與冠軍成就）
router.post('/contests/:id/settle', (req, res) => {
  const gid = req.guildId;
  const c = db.prepare('SELECT * FROM contests WHERE id=? AND guild_id=?').get(req.params.id, gid);
  if (!c || c.status !== 'live') return res.status(400).json({ error: '只有進行中的大賽可以立刻結算' });
  db.prepare('UPDATE contests SET end_ts=? WHERE id=?').run(Date.now(), c.id);
  audit(req.user.name, `提早結算大賽 #${c.id}`, 'gather', '', gid);
  res.json({ ok: true, note: '一分鐘內會自動結算並公告' });
});

// 目前排行（後台看得到完整名單）
router.get('/contests/:id/scores', (req, res) => {
  res.json(db.prepare(
    'SELECT user_id, username, score, baseline, updated_at FROM contest_scores WHERE contest_id=? AND guild_id=? ORDER BY score DESC LIMIT 100'
  ).all(req.params.id, req.guildId));
});

module.exports = router;
