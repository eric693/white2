// 魚缸後台 API：基本設定（格數/飼料時間/餓死時間/偷魚）＋ SSR 魚 CRUD
const express = require('express');
const { db, audit, guildConfig } = require('../db');
const { requireAuth, guardModule } = require('../auth');

const router = express.Router();
router.use(requireAuth(), guardModule('gather'));

const int = (v, d = 0, min = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(min, n) : d; };

router.get('/aquarium', (req, res) => res.json(guildConfig('aquarium_config', req.guildId)));

router.put('/aquarium', (req, res) => {
  const b = req.body || {};
  guildConfig('aquarium_config', req.guildId);
  db.prepare(
    `UPDATE aquarium_config SET enabled=@enabled, max_slots=@max_slots, feed_hours=@feed_hours,
       stock_hours=@stock_hours, starve_hours=@starve_hours, max_accrue_days=@max_accrue_days,
       steal_enabled=@steal_enabled, steal_daily_limit=@steal_daily_limit, steal_success_pct=@steal_success_pct,
       steal_take_pct=@steal_take_pct, steal_fish_pct=@steal_fish_pct, steal_max=@steal_max,
       steal_fail_penalty=@steal_fail_penalty, steal_penalty_to_victim=@steal_penalty_to_victim WHERE guild_id=@guild_id`
  ).run({
    enabled: b.enabled ? 1 : 0,
    max_slots: int(b.max_slots, 0, 0),
    feed_hours: int(b.feed_hours, 24, 1),
    stock_hours: int(b.stock_hours, 48, 1),
    starve_hours: int(b.starve_hours, 48, 1),
    max_accrue_days: int(b.max_accrue_days, 3, 1),
    steal_enabled: b.steal_enabled ? 1 : 0,
    steal_daily_limit: int(b.steal_daily_limit, 2, 0),
    steal_success_pct: int(b.steal_success_pct, 40, 0),
    steal_take_pct: int(b.steal_take_pct, 20, 0),
    steal_fish_pct: int(b.steal_fish_pct, 3, 0),
    steal_max: int(b.steal_max, 300, 0),
    steal_fail_penalty: int(b.steal_fail_penalty, 0, 0),
    steal_penalty_to_victim: b.steal_penalty_to_victim ? 1 : 0,
    guild_id: req.guildId
  });
  audit(req.user.name, '更新魚缸設定');
  res.json({ ok: true });
});

router.get('/aquarium-fish', (req, res) => {
  res.json(db.prepare('SELECT * FROM aquarium_fish WHERE guild_id=? ORDER BY sort, price').all(req.guildId));
});

router.post('/aquarium-fish', (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: '請填寫魚的名稱' });
  const r = db.prepare(
    `INSERT INTO aquarium_fish (guild_id,name,emoji,price,coin_per_day,feed_cost,sort,description,enabled)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(req.guildId, b.name, b.emoji || '', int(b.price, 3000, 0), int(b.coin_per_day, 100, 0),
    int(b.feed_cost, 40, 0), int(b.sort, 0), b.description || '', b.enabled ? 1 : 0);
  audit(req.user.name, `新增 SSR 魚：${b.name}`);
  res.json({ id: r.lastInsertRowid });
});

router.put('/aquarium-fish/:id', (req, res) => {
  const b = req.body || {};
  const cur = db.prepare('SELECT * FROM aquarium_fish WHERE id=? AND guild_id=?').get(req.params.id, req.guildId);
  if (!cur) return res.status(404).json({ error: '找不到這條魚' });
  db.prepare(
    `UPDATE aquarium_fish SET name=?, emoji=?, price=?, coin_per_day=?, feed_cost=?, sort=?, description=?, enabled=?
      WHERE id=? AND guild_id=?`
  ).run(b.name || cur.name, b.emoji || '', int(b.price, cur.price, 0), int(b.coin_per_day, cur.coin_per_day, 0),
    int(b.feed_cost, cur.feed_cost, 0), int(b.sort, 0), b.description || '', b.enabled ? 1 : 0,
    req.params.id, req.guildId);
  audit(req.user.name, `修改 SSR 魚 #${req.params.id}`);
  res.json({ ok: true });
});

router.delete('/aquarium-fish/:id', (req, res) => {
  // 玩家缸裡養著這種魚的格子一起移除（跟種子刪除同一套處理）
  db.prepare('DELETE FROM aquarium_slots WHERE guild_id=? AND fish_id=?').run(req.guildId, req.params.id);
  db.prepare('DELETE FROM aquarium_fish WHERE id=? AND guild_id=?').run(req.params.id, req.guildId);
  audit(req.user.name, `刪除 SSR 魚 #${req.params.id}`);
  res.json({ ok: true });
});

module.exports = router;
