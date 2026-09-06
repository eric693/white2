// 開通申請（訪客自助送單 → 後台核准）
// 為什麼要這張表：原本只能「私訊作者」，訪客看完方案沒有下一步；
// 這裡讓他把伺服器與想要的方案先送進來，作者在後台一鍵核准即可。
const express = require('express');
const { db, audit } = require('../db');
const { requireAuth, guardModule, rateLimit } = require('../auth');

const router = express.Router();

db.exec(`CREATE TABLE IF NOT EXISTS guild_applications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id   TEXT NOT NULL DEFAULT '',
  guild_name TEXT NOT NULL DEFAULT '',
  invite     TEXT NOT NULL DEFAULT '',
  bots       TEXT NOT NULL DEFAULT '',      -- secretary,butler
  plan       TEXT NOT NULL DEFAULT '',      -- trial / standard / pro
  contact    TEXT NOT NULL DEFAULT '',      -- Discord 帳號或 Email
  note       TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'pending', -- pending / approved / rejected
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
)`);

const PLANS = ['trial', 'standard', 'pro'];
const clean = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

// ---- 公開：送出申請（不需登入）----
router.post('/apply', rateLimit({ windowMs: 60 * 60 * 1000, max: 5, prefix: 'apply:' }), (req, res) => {
  const b = req.body || {};
  const guild_id = clean(b.guild_id, 32).replace(/\D/g, '');
  const invite = clean(b.invite, 200);
  const contact = clean(b.contact, 120);
  const bots = String(b.bots || '').split(',').map(s => s.trim())
    .filter(s => s === 'secretary' || s === 'butler');
  const plan = PLANS.includes(clean(b.plan, 20)) ? clean(b.plan, 20) : 'trial';

  if (!contact) return res.status(400).json({ error: '請留下聯絡方式（Discord 帳號或 Email）' });
  if (!guild_id && !invite) return res.status(400).json({ error: '請填伺服器 ID，或貼一條伺服器邀請連結' });
  if (!bots.length) return res.status(400).json({ error: '請至少選一隻機器人' });

  db.prepare(`INSERT INTO guild_applications
    (guild_id, guild_name, invite, bots, plan, contact, note) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(guild_id, clean(b.guild_name, 120), invite, bots.join(','), plan, contact, clean(b.note, 500));
  res.json({ ok: true });
});

router.use(requireAuth(), guardModule('guilds'));

router.get('/applications', (req, res) => {
  res.json(db.prepare('SELECT * FROM guild_applications ORDER BY (status = "pending") DESC, id DESC LIMIT 200').all());
});

// 核准＝順手把伺服器加進白名單（有 ID 才做得到；只有邀請連結就留給作者手動處理）
router.put('/applications/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM guild_applications WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '找不到這筆申請' });
  const status = req.body && req.body.status === 'approved' ? 'approved' : 'rejected';
  db.prepare('UPDATE guild_applications SET status = ? WHERE id = ?').run(status, row.id);
  if (status === 'approved' && row.guild_id) {
    const exists = db.prepare('SELECT 1 FROM guilds WHERE guild_id = ?').get(row.guild_id);
    if (exists) db.prepare('UPDATE guilds SET approved = 1 WHERE guild_id = ?').run(row.guild_id);
    else db.prepare(`INSERT INTO guilds (guild_id, name, approved, active, note)
                     VALUES (?, ?, 1, 0, ?)`).run(row.guild_id, row.guild_name || '（線上申請）', '線上申請 #' + row.id);
  }
  audit(req.user.name, `${status === 'approved' ? '核准' : '婉拒'}開通申請 #${row.id}`, 'guilds');
  res.json({ ok: true });
});

router.delete('/applications/:id', (req, res) => {
  db.prepare('DELETE FROM guild_applications WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
