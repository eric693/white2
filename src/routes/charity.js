// 慈善基金會後台 API：抵稅比例、撥入普發、帳目與捐款明細
const express = require('express');
const { db, audit, guildConfig } = require('../db');
const { requireAuth, guardModule } = require('../auth');

const router = express.Router();
router.use(requireAuth(), guardModule('gather'));

const int = (v, d = 0, min = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(min, n) : d; };

router.get('/charity', (req, res) => {
  const c = guildConfig('charity_config', req.guildId);
  const top = db.prepare(
    `SELECT user_id, username, SUM(amount) amount, COUNT(*) times FROM charity_donations
      WHERE guild_id=? GROUP BY user_id ORDER BY amount DESC LIMIT 20`).all(req.guildId);
  const recent = db.prepare('SELECT * FROM charity_donations WHERE guild_id=? ORDER BY id DESC LIMIT 50').all(req.guildId);
  const payouts = db.prepare('SELECT * FROM charity_payouts WHERE guild_id=? ORDER BY id DESC LIMIT 20').all(req.guildId);
  res.json({ ...c, top, recent, payouts });
});

router.put('/charity', (req, res) => {
  const b = req.body || {};
  const cur = guildConfig('charity_config', req.guildId);
  const keep = (v, k, f) => (v === undefined || v === null ? cur[k] : f(v));
  const bool = (v, k) => (v === undefined || v === null ? cur[k] : (v ? 1 : 0));
  db.prepare(
    `UPDATE charity_config SET enabled=@enabled, name=@name, min_donate=@min_donate, deduct_pct=@deduct_pct,
       deduct_max=@deduct_max, deduct_max_pct=@deduct_max_pct, to_relief=@to_relief, channel=@channel
     WHERE guild_id=@guild_id`
  ).run({
    enabled: bool(b.enabled, 'enabled'),
    name: keep(b.name, 'name', v => String(v || '').slice(0, 40) || '慈善基金會'),
    min_donate: keep(b.min_donate, 'min_donate', v => int(v, 1000, 0)),
    deduct_pct: keep(b.deduct_pct, 'deduct_pct', v => Math.max(0, Math.min(100, Math.round(parseFloat(v) * 100) / 100 || 0))),
    deduct_max: keep(b.deduct_max, 'deduct_max', v => int(v, 0, 0)),
    deduct_max_pct: keep(b.deduct_max_pct, 'deduct_max_pct', v => Math.max(0, Math.min(100, int(v, 100, 0)))),
    to_relief: bool(b.to_relief, 'to_relief'),
    channel: keep(b.channel, 'channel', v => String(v || '')),
    guild_id: req.guildId
  });
  audit(req.user.name, '更新慈善基金會設定', 'gather', '', req.guildId);
  res.json({ ok: true });
});

// 手動調整基金會餘額（活動加碼／修正誤差）。正數＝注資，負數＝抽走。
router.post('/charity-adjust', (req, res) => {
  const delta = parseInt((req.body || {}).delta, 10) || 0;
  if (!delta) return res.status(400).json({ error: '請填要增減的金額' });
  const c = guildConfig('charity_config', req.guildId);
  const next = Math.max(0, (c.pool || 0) + delta);
  db.prepare('UPDATE charity_config SET pool=?, total_in = total_in + ? WHERE guild_id=?')
    .run(next, delta > 0 ? delta : 0, req.guildId);
  audit(req.user.name, `調整基金會餘額 ${delta > 0 ? '+' : ''}${delta}`, 'gather', '', req.guildId);
  res.json({ ok: true, pool: next });
});

module.exports = router;
