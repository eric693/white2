// 特殊兌換商店後台 API：設定、商品、兌換紀錄
const express = require('express');
const { db, audit, guildConfig } = require('../db');
const { requireAuth, requireModule, guardModule } = require('../auth');
const bot = require('../bot');

const router = express.Router();
// 沿用冒險系統的模組權限
router.use(requireAuth(), guardModule('special'));

const int = (v, d = 0, min = null) => { let n = parseInt(v, 10); if (!Number.isFinite(n)) n = d; return min === null ? n : Math.max(min, n); };
const csvField = (v) => Array.isArray(v) ? v.join(',') : String(v || '');

// ---- 設定 ----
router.get('/special', (req, res) => res.json(guildConfig('special_config', req.guildId)));

router.put('/special', (req, res) => {
  const b = req.body || {};
  guildConfig('special_config', req.guildId);
  db.prepare(
    `UPDATE special_config SET enabled=@enabled, admin_roles=@admin_roles, admin_users=@admin_users, log_channel=@log_channel, channel_scoped=@channel_scoped, notify_mode=@notify_mode,
       per_item_limit=@per_item_limit, price_escalate=@price_escalate, escalate_mult=@escalate_mult, limit_reset=@limit_reset
     WHERE guild_id=@guild_id`
  ).run({
    enabled: b.enabled ? 1 : 0,
    admin_roles: csvField(b.admin_roles),
    admin_users: csvField(b.admin_users),
    log_channel: b.log_channel || '',
    channel_scoped: b.channel_scoped ? 1 : 0,
    notify_mode: ['shop', 'log', 'dm'].includes(b.notify_mode) ? b.notify_mode
      : (guildConfig('special_config', req.guildId).notify_mode || 'shop'),
    per_item_limit: Math.max(0, parseInt(b.per_item_limit, 10) || 0),
    price_escalate: b.price_escalate ? 1 : 0,
    escalate_mult: Math.max(1, Math.min(100, parseFloat(b.escalate_mult) || 2)),
    limit_reset: ['month', 'biweek', 'week', 'none'].includes(b.limit_reset) ? b.limit_reset
      : (guildConfig('special_config', req.guildId).limit_reset || 'month'),
    guild_id: req.guildId
  });
  audit(req.user.name, '更新特殊商店設定');
  res.json({ ok: true });
});

// ---- 商品 ----
router.get('/special-items', (req, res) => {
  res.json(db.prepare('SELECT * FROM special_items WHERE guild_id=? ORDER BY sort, id').all(req.guildId));
});

function itemFields(b) {
  return {
    name: b.name || '', emoji: b.emoji || '', price: int(b.price, 1000, 0),
    channel_id: b.channel_id || '', role_id: b.role_id || '', image_url: b.image_url || '',
    description: b.description || '', stock: b.stock === '' || b.stock == null ? -1 : int(b.stock, -1),
    sort: int(b.sort, 0), enabled: b.enabled ? 1 : 0, shop_id: int(b.shop_id, 0),
    per_user_limit: int(b.per_user_limit, 0, 0),
    // >0＝兌換後直接把這個素材發進背包（神秘商店賣素材用），不必管理員手動處理
    grant_item_id: int(b.grant_item_id, 0, 0), grant_count: int(b.grant_count, 1, 1)
  };
}

router.post('/special-items', (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: '請填寫獎勵名稱' });
  const r = db.prepare(
    `INSERT INTO special_items (guild_id,name,emoji,price,channel_id,role_id,image_url,description,stock,sort,enabled,shop_id,per_user_limit,grant_item_id,grant_count)
     VALUES (@guild_id,@name,@emoji,@price,@channel_id,@role_id,@image_url,@description,@stock,@sort,@enabled,@shop_id,@per_user_limit,@grant_item_id,@grant_count)`
  ).run({ ...itemFields(b), guild_id: req.guildId });
  audit(req.user.name, `新增特殊商品：${b.name}`);
  res.json({ id: r.lastInsertRowid });
});

router.put('/special-items/:id', (req, res) => {
  db.prepare(
    `UPDATE special_items SET name=@name, emoji=@emoji, price=@price, channel_id=@channel_id, role_id=@role_id,
       image_url=@image_url, description=@description, stock=@stock, sort=@sort, enabled=@enabled, shop_id=@shop_id,
       per_user_limit=@per_user_limit, grant_item_id=@grant_item_id, grant_count=@grant_count
     WHERE id=@id AND guild_id=@guild_id`
  ).run({ ...itemFields(req.body || {}), id: req.params.id, guild_id: req.guildId });
  audit(req.user.name, `修改特殊商品 #${req.params.id}`);
  res.json({ ok: true });
});

// ---- 多分店 ----
// 可以「直接發到背包」的素材清單（神秘商店賣素材用）
router.get('/special-grantables', (req, res) => {
  res.json(db.prepare(
    'SELECT id, name, emoji, kind, price FROM gather_items WHERE guild_id=? AND enabled=1 ORDER BY kind, price').all(req.guildId));
});

router.get('/special-shops', (req, res) => {
  res.json(db.prepare('SELECT * FROM special_shops WHERE guild_id=? ORDER BY sort, id').all(req.guildId));
});
function shopFields(b) {
  return {
    name: b.name || '', emoji: b.emoji || '', description: b.description || '',
    channel_id: b.channel_id || '', notify_roles: csvField(b.notify_roles),
    allow_users: csvField(b.allow_users), allow_roles: csvField(b.allow_roles),
    hidden: b.hidden ? 1 : 0,
    sort: int(b.sort, 0), enabled: b.enabled ? 1 : 0
  };
}
router.post('/special-shops', (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: '請填寫商店名稱' });
  const r = db.prepare(
    `INSERT INTO special_shops (guild_id,name,emoji,description,channel_id,notify_roles,allow_users,allow_roles,hidden,sort,enabled)
     VALUES (@guild_id,@name,@emoji,@description,@channel_id,@notify_roles,@allow_users,@allow_roles,@hidden,@sort,@enabled)`
  ).run({ ...shopFields(b), guild_id: req.guildId });
  audit(req.user.name, `新增特殊商店：${b.name}`);
  res.json({ id: r.lastInsertRowid });
});
router.put('/special-shops/:id', (req, res) => {
  db.prepare(
    `UPDATE special_shops SET name=@name, emoji=@emoji, description=@description, channel_id=@channel_id,
       notify_roles=@notify_roles, allow_users=@allow_users, allow_roles=@allow_roles, hidden=@hidden,
       sort=@sort, enabled=@enabled WHERE id=@id AND guild_id=@guild_id`
  ).run({ ...shopFields(req.body || {}), id: req.params.id, guild_id: req.guildId });
  audit(req.user.name, `修改特殊商店 #${req.params.id}`);
  res.json({ ok: true });
});
router.delete('/special-shops/:id', (req, res) => {
  // 刪店時把該店商品歸為未分類，不刪商品
  db.prepare('UPDATE special_items SET shop_id=0 WHERE guild_id=? AND shop_id=?').run(req.guildId, req.params.id);
  db.prepare('DELETE FROM special_shops WHERE id=? AND guild_id=?').run(req.params.id, req.guildId);
  audit(req.user.name, `刪除特殊商店 #${req.params.id}`);
  res.json({ ok: true });
});
router.post('/special-shops/:id/publish', async (req, res) => {
  if (!bot.client._publishShop) return res.status(503).json({ error: '機器人尚未上線' });
  try { await bot.client._publishShop(parseInt(req.params.id, 10)); audit(req.user.name, `發布特殊商店 #${req.params.id}`); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/special-items/:id', (req, res) => {
  db.prepare('DELETE FROM special_items WHERE id=? AND guild_id=?').run(req.params.id, req.guildId);
  audit(req.user.name, `刪除特殊商品 #${req.params.id}`);
  res.json({ ok: true });
});

// ---- 兌換紀錄 ----
router.get('/special-redeems', (req, res) => {
  res.json(db.prepare('SELECT * FROM special_redeems WHERE guild_id=? ORDER BY id DESC LIMIT 200').all(req.guildId));
});

router.put('/special-redeems/:id', (req, res) => {
  const status = (req.body && req.body.status) === 'done' ? 'done' : 'pending';
  db.prepare('UPDATE special_redeems SET status=? WHERE id=? AND guild_id=?').run(status, req.params.id, req.guildId);
  audit(req.user.name, `兌換單 #${req.params.id} 標記為 ${status}`);
  res.json({ ok: true });
});

module.exports = router;
