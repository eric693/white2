// 經營系統（牧場）後台 API：設定、可購買動物與其產物
const express = require('express');
const { db, audit, guildConfig } = require('../db');
const { requireAuth, requireModule, guardModule } = require('../auth');

const router = express.Router();
// 沿用冒險系統的模組權限（牧場屬於同一套冒險經濟）
router.use(requireAuth(), guardModule('gather'));

const int = (v, d = 0, min = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(min, n) : d; };
const pct = (v, d) => Math.min(100, Math.max(0, int(v, d)));

// ---- 設定 ----
router.get('/ranch', (req, res) => {
  res.json(guildConfig('ranch_config', req.guildId));
});

router.put('/ranch', (req, res) => {
  const b = req.body || {};
  guildConfig('ranch_config', req.guildId);
  db.prepare(
    `UPDATE ranch_config SET enabled=@enabled, max_slots=@max_slots, max_accrue_days=@max_accrue_days,
       steal_enabled=@steal_enabled, steal_daily_limit=@steal_daily_limit,
       steal_success_pct=@steal_success_pct, steal_take_pct=@steal_take_pct, hatch_slots=@hatch_slots,
       steal_channel=@steal_channel, steal_animal_pct=@steal_animal_pct, steal_mode=@steal_mode, steal_guard=@steal_guard
     WHERE guild_id=@guild_id`
  ).run({
    enabled: b.enabled ? 1 : 0,
    max_slots: int(b.max_slots, 0, 0),
    max_accrue_days: int(b.max_accrue_days, 7, 1),
    steal_enabled: b.steal_enabled ? 1 : 0,
    steal_daily_limit: int(b.steal_daily_limit, 3, 0),
    steal_success_pct: pct(b.steal_success_pct, 50),
    steal_take_pct: pct(b.steal_take_pct, 50),
    hatch_slots: int(b.hatch_slots, 0, 0),
    steal_channel: b.steal_channel || '',
    steal_animal_pct: pct(b.steal_animal_pct, 0),
    steal_mode: b.steal_mode === 'pct' ? 'pct' : 'one',
    steal_guard: b.steal_guard ? 1 : 0,
    guild_id: req.guildId
  });
  audit(req.user.name, '更新牧場設定');
  res.json({ ok: true });
});

// ---- 動物（含其產物）----
router.get('/ranch-animals', (req, res) => {
  const rows = db.prepare(
    `SELECT a.*, it.name AS product_name, it.emoji AS product_emoji, it.price AS product_price
       FROM ranch_animals a LEFT JOIN gather_items it ON it.id = a.product_item_id
      WHERE a.guild_id = ? ORDER BY a.sort, a.id`
  ).all(req.guildId);
  res.json(rows);
});

// 建立/取得該動物的產物（farm 類物品）；回傳 item id
function upsertProduct(gid, itemId, name, emoji, price) {
  if (itemId) {
    const ex = db.prepare('SELECT id FROM gather_items WHERE id=? AND guild_id=?').get(itemId, gid);
    if (ex) {
      db.prepare('UPDATE gather_items SET name=?, emoji=?, price=? WHERE id=?').run(name, emoji, price, itemId);
      return itemId;
    }
  }
  const r = db.prepare(
    "INSERT INTO gather_items (guild_id,kind,name,emoji,rarity,weight,price,description,enabled) VALUES (?, 'farm', ?,?, 'N', 0, ?, ?, 1)"
  ).run(gid, name, emoji, price, `牧場產物：${name}`);
  return r.lastInsertRowid;
}

const pct100 = (v, d) => Math.min(100, Math.max(0, int(v, d, 0)));

router.post('/ranch-animals', (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: '請填寫動物名稱' });
  const isGuard = int(b.guard_pct, 0) > 0;
  // 看門動物不產蛋奶，可不填產物
  if (!isGuard && !b.product_name) return res.status(400).json({ error: '請填寫產物名稱（例如 蛋、牛奶）；若是看門動物請把「看門機率」設 >0' });
  const itemId = (!isGuard && b.product_name) ? upsertProduct(req.guildId, 0, b.product_name, b.product_emoji || '', int(b.product_price, 10, 0)) : 0;
  const r = db.prepare(
    `INSERT INTO ranch_animals (guild_id,name,emoji,price,product_item_id,produce_per_day,produce_interval_minutes,sort,description,enabled,guard_pct,guard_penalty)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(req.guildId, b.name, b.emoji || '', int(b.price, 500, 0), itemId,
    int(b.produce_per_day, 1, 0), int(b.produce_interval_minutes, 0), int(b.sort, 0), b.description || '', b.enabled ? 1 : 0,
    pct100(b.guard_pct, 0), int(b.guard_penalty, 0));
  audit(req.user.name, `新增牧場動物：${b.name}`);
  res.json({ id: r.lastInsertRowid });
});

router.put('/ranch-animals/:id', (req, res) => {
  const b = req.body || {};
  const cur = db.prepare('SELECT * FROM ranch_animals WHERE id=? AND guild_id=?').get(req.params.id, req.guildId);
  if (!cur) return res.status(404).json({ error: '找不到動物' });
  const isGuard = int(b.guard_pct, 0) > 0;
  const itemId = (!isGuard && b.product_name)
    ? upsertProduct(req.guildId, cur.product_item_id, b.product_name, b.product_emoji || '', int(b.product_price, 10, 0))
    : (isGuard ? 0 : cur.product_item_id);
  db.prepare(
    `UPDATE ranch_animals SET name=?, emoji=?, price=?, product_item_id=?, produce_per_day=?, produce_interval_minutes=?,
       sort=?, description=?, enabled=?, guard_pct=?, guard_penalty=? WHERE id=? AND guild_id=?`
  ).run(b.name || cur.name, b.emoji || '', int(b.price, cur.price, 0), itemId,
    int(b.produce_per_day, 1, 0), int(b.produce_interval_minutes, 0), int(b.sort, 0), b.description || '', b.enabled ? 1 : 0,
    pct100(b.guard_pct, 0), int(b.guard_penalty, 0), req.params.id, req.guildId);
  audit(req.user.name, `修改牧場動物 #${req.params.id}`);
  res.json({ ok: true });
});

router.delete('/ranch-animals/:id', (req, res) => {
  // 刪動物時一併清掉玩家養的該動物（產物物品保留，避免背包裡的存貨消失）
  db.prepare('DELETE FROM ranch_slots WHERE guild_id=? AND animal_id=?').run(req.guildId, req.params.id);
  db.prepare('DELETE FROM ranch_animals WHERE id=? AND guild_id=?').run(req.params.id, req.guildId);
  audit(req.user.name, `刪除牧場動物 #${req.params.id}`);
  res.json({ ok: true });
});

// ---- 孵化設定（蛋 → 動物）----
router.get('/ranch-hatch', (req, res) => {
  const rows = db.prepare(
    `SELECT h.*, it.name AS egg_name, it.emoji AS egg_emoji, a.name AS animal_name, a.emoji AS animal_emoji
       FROM ranch_hatch_defs h
       LEFT JOIN gather_items it ON it.id = h.egg_item_id
       LEFT JOIN ranch_animals a ON a.id = h.animal_id
      WHERE h.guild_id = ? ORDER BY h.sort, h.id`
  ).all(req.guildId);
  res.json(rows);
});

// 供孵化設定下拉選單用：所有可當「蛋」的物品（gather_items），以及動物清單
router.get('/ranch-hatch-options', (req, res) => {
  res.json({
    items: db.prepare('SELECT id, name, emoji, kind FROM gather_items WHERE guild_id=? AND enabled=1 ORDER BY kind, name').all(req.guildId),
    animals: db.prepare('SELECT id, name, emoji FROM ranch_animals WHERE guild_id=? ORDER BY sort, id').all(req.guildId)
  });
});

router.post('/ranch-hatch', (req, res) => {
  const b = req.body || {};
  const egg = int(b.egg_item_id, 0), animal = int(b.animal_id, 0);
  if (!egg || !animal) return res.status(400).json({ error: '請選擇蛋與孵出的動物' });
  const r = db.prepare(
    'INSERT INTO ranch_hatch_defs (guild_id,egg_item_id,animal_id,hatch_minutes,fail_pct,sort,enabled) VALUES (?,?,?,?,?,?,?)'
  ).run(req.guildId, egg, animal, int(b.hatch_minutes, 240, 1), pct100(b.fail_pct, 0), int(b.sort, 0), b.enabled ? 1 : 0);
  audit(req.user.name, '新增孵化設定');
  res.json({ id: r.lastInsertRowid });
});

router.put('/ranch-hatch/:id', (req, res) => {
  const b = req.body || {};
  const egg = int(b.egg_item_id, 0), animal = int(b.animal_id, 0);
  if (!egg || !animal) return res.status(400).json({ error: '請選擇蛋與孵出的動物' });
  db.prepare(
    'UPDATE ranch_hatch_defs SET egg_item_id=?, animal_id=?, hatch_minutes=?, fail_pct=?, sort=?, enabled=? WHERE id=? AND guild_id=?'
  ).run(egg, animal, int(b.hatch_minutes, 240, 1), pct100(b.fail_pct, 0), int(b.sort, 0), b.enabled ? 1 : 0, req.params.id, req.guildId);
  audit(req.user.name, `修改孵化設定 #${req.params.id}`);
  res.json({ ok: true });
});

router.delete('/ranch-hatch/:id', (req, res) => {
  db.prepare('DELETE FROM ranch_hatch_defs WHERE id=? AND guild_id=?').run(req.params.id, req.guildId);
  audit(req.user.name, `刪除孵化設定 #${req.params.id}`);
  res.json({ ok: true });
});

// ---- 偷竊公告路由（身分組 → 頻道）----
router.get('/ranch-steal-routes', (req, res) => {
  res.json(db.prepare('SELECT * FROM ranch_steal_routes WHERE guild_id=? ORDER BY sort, id').all(req.guildId));
});
router.post('/ranch-steal-routes', (req, res) => {
  const b = req.body || {};
  if (!b.role_id || !b.channel_id) return res.status(400).json({ error: '請選擇身分組與頻道' });
  const r = db.prepare('INSERT INTO ranch_steal_routes (guild_id,role_id,channel_id,sort) VALUES (?,?,?,?)')
    .run(req.guildId, b.role_id, b.channel_id, int(b.sort, 0));
  audit(req.user.name, '新增偷竊公告路由');
  res.json({ id: r.lastInsertRowid });
});
router.put('/ranch-steal-routes/:id', (req, res) => {
  const b = req.body || {};
  if (!b.role_id || !b.channel_id) return res.status(400).json({ error: '請選擇身分組與頻道' });
  db.prepare('UPDATE ranch_steal_routes SET role_id=?, channel_id=?, sort=? WHERE id=? AND guild_id=?')
    .run(b.role_id, b.channel_id, int(b.sort, 0), req.params.id, req.guildId);
  audit(req.user.name, `修改偷竊公告路由 #${req.params.id}`);
  res.json({ ok: true });
});
router.delete('/ranch-steal-routes/:id', (req, res) => {
  db.prepare('DELETE FROM ranch_steal_routes WHERE id=? AND guild_id=?').run(req.params.id, req.guildId);
  audit(req.user.name, `刪除偷竊公告路由 #${req.params.id}`);
  res.json({ ok: true });
});


// ---- 偷竊紀錄：前台公告匿名，管理員在這裡查得到真兇 ----
// 支援用小偷／被害者／關鍵字篩選，預設只列最近 300 筆。
router.get('/ranch/steal-logs', requireModule('gather'), (req, res) => {
  const kw = String(req.query.q || '').trim();
  const kind = String(req.query.kind || '').trim();     // ranch / aquarium
  const result = String(req.query.result || '').trim(); // success / miss / caught
  const where = ['guild_id = @g'];
  if (kind) where.push('kind = @kind');
  if (result) where.push('result = @result');
  if (kw) where.push('(thief_name LIKE @k OR victim_name LIKE @k OR thief_id LIKE @k OR victim_id LIKE @k OR loot LIKE @k)');
  const rows = db.prepare(
    `SELECT * FROM steal_logs WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 300`
  ).all({ g: req.guildId, k: `%${kw}%`, kind, result });
  res.json(rows);
});

// 排行：誰偷最多、誰被偷最慘（處理糾紛時最常看的兩張表）
router.get('/ranch/steal-stats', requireModule('gather'), (req, res) => {
  const days = int(req.query.days, 7, 1);
  const since = `-${days} days`;
  const q = (col, nameCol) => db.prepare(
    `SELECT ${col} AS user_id, ${nameCol} AS username, COUNT(*) AS times,
            SUM(CASE WHEN result='success' THEN 1 ELSE 0 END) AS success,
            SUM(coins) AS coins
       FROM steal_logs
      WHERE guild_id = ? AND created_at > datetime('now','localtime',?)
      GROUP BY ${col} ORDER BY times DESC LIMIT 20`).all(req.guildId, since);
  res.json({ days, thieves: q('thief_id', 'thief_name'), victims: q('victim_id', 'victim_name') });
});

module.exports = router;
