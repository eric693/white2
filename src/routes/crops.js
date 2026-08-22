// 種植系統後台 API：設定、種子（含成熟產物）
const express = require('express');
const { db, audit, guildConfig } = require('../db');
const { requireAuth, requireModule, guardModule } = require('../auth');

const router = express.Router();
router.use(requireAuth(), guardModule('crops'));

const int = (v, d = 0, min = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(min, n) : d; };
const plotOf = (v) => v === 'greenhouse' ? 'greenhouse' : 'field';

router.get('/crops', (req, res) => res.json(guildConfig('crop_config', req.guildId)));

router.put('/crops', (req, res) => {
  const b = req.body || {};
  guildConfig('crop_config', req.guildId);
  db.prepare(
    `UPDATE crop_config SET enabled=@enabled, field_slots=@field_slots, greenhouse_slots=@greenhouse_slots WHERE guild_id=@guild_id`
  ).run({
    enabled: b.enabled ? 1 : 0,
    field_slots: int(b.field_slots, 6, 1),
    greenhouse_slots: int(b.greenhouse_slots, 3, 1),
    guild_id: req.guildId
  });
  audit(req.user.name, '更新種植設定');
  res.json({ ok: true });
});

router.get('/crop-seeds', (req, res) => {
  res.json(db.prepare(
    `SELECT s.*, it.name AS product_name, it.emoji AS product_emoji, it.price AS product_price
       FROM crop_seeds s LEFT JOIN gather_items it ON it.id = s.product_item_id
      WHERE s.guild_id=? ORDER BY s.plot_type, s.sort, s.id`
  ).all(req.guildId));
});

function upsertProduct(gid, itemId, name, emoji, price) {
  if (itemId) {
    const ex = db.prepare('SELECT id FROM gather_items WHERE id=? AND guild_id=?').get(itemId, gid);
    if (ex) { db.prepare('UPDATE gather_items SET name=?, emoji=?, price=? WHERE id=?').run(name, emoji, price, itemId); return itemId; }
  }
  return db.prepare("INSERT INTO gather_items (guild_id,kind,name,emoji,rarity,weight,price,description,enabled) VALUES (?, 'farm', ?,?, 'N', 0, ?, ?, 1)")
    .run(gid, name, emoji, price, `種植產物：${name}`).lastInsertRowid;
}

router.post('/crop-seeds', (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: '請填寫種子名稱' });
  if (!b.product_name) return res.status(400).json({ error: '請填寫成熟後的產物名稱' });
  const itemId = upsertProduct(req.guildId, 0, b.product_name, b.product_emoji || '', int(b.product_price, 10, 0));
  const r = db.prepare(
    `INSERT INTO crop_seeds (guild_id,name,emoji,plot_type,seed_price,grow_minutes,product_item_id,yield_count,sort,description,enabled)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(req.guildId, b.name, b.emoji || '', plotOf(b.plot_type), int(b.seed_price, 20, 0), int(b.grow_minutes, 180, 1),
    itemId, int(b.yield_count, 1, 1), int(b.sort, 0), b.description || '', b.enabled ? 1 : 0);
  audit(req.user.name, `新增種子：${b.name}`);
  res.json({ id: r.lastInsertRowid });
});

router.put('/crop-seeds/:id', (req, res) => {
  const b = req.body || {};
  const cur = db.prepare('SELECT * FROM crop_seeds WHERE id=? AND guild_id=?').get(req.params.id, req.guildId);
  if (!cur) return res.status(404).json({ error: '找不到種子' });
  const itemId = upsertProduct(req.guildId, cur.product_item_id, b.product_name || '產物', b.product_emoji || '', int(b.product_price, 10, 0));
  db.prepare(
    `UPDATE crop_seeds SET name=?, emoji=?, plot_type=?, seed_price=?, grow_minutes=?, product_item_id=?,
       yield_count=?, sort=?, description=?, enabled=? WHERE id=? AND guild_id=?`
  ).run(b.name || cur.name, b.emoji || '', plotOf(b.plot_type), int(b.seed_price, cur.seed_price, 0),
    int(b.grow_minutes, 180, 1), itemId, int(b.yield_count, 1, 1), int(b.sort, 0), b.description || '',
    b.enabled ? 1 : 0, req.params.id, req.guildId);
  audit(req.user.name, `修改種子 #${req.params.id}`);
  res.json({ ok: true });
});

router.delete('/crop-seeds/:id', (req, res) => {
  db.prepare('DELETE FROM crop_plots WHERE guild_id=? AND seed_id=?').run(req.guildId, req.params.id);
  db.prepare('DELETE FROM crop_seeds WHERE id=? AND guild_id=?').run(req.params.id, req.guildId);
  audit(req.user.name, `刪除種子 #${req.params.id}`);
  res.json({ ok: true });
});

module.exports = router;
