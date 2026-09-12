// 素材兌換所後台 API：設定、兌換項目池、今天開出的清單、兌換紀錄
const express = require('express');
const { db, audit, guildConfig } = require('../db');
const { requireAuth, guardModule } = require('../auth');
// 「今天」一律用台北時區算。SQLite 的 date('now','localtime') 吃的是系統時區，
// 而機器跑在 UTC —— 用它的話，台灣早上 8 點前後台看到的會是「昨天」的清單。
const { localToday } = require('../util/time');

const router = express.Router();
router.use(requireAuth(), guardModule('exchange'));

const int = (v, d = 0, min = null) => { let n = parseInt(v, 10); if (!Number.isFinite(n)) n = d; return min === null ? n : Math.max(min, n); };

// ---- 設定 ----
router.get('/exchange', (req, res) => res.json(guildConfig('exchange_config', req.guildId)));

router.put('/exchange', (req, res) => {
  const b = req.body || {};
  guildConfig('exchange_config', req.guildId);
  db.prepare(
    `UPDATE exchange_config SET enabled=@enabled, daily_slots=@daily_slots,
       daily_per_user=@daily_per_user, announce_channel=@announce_channel WHERE guild_id=@guild_id`
  ).run({
    enabled: b.enabled ? 1 : 0,
    daily_slots: Math.max(1, Math.min(25, int(b.daily_slots, 3))),
    daily_per_user: int(b.daily_per_user, 0, 0),
    announce_channel: b.announce_channel || '',
    guild_id: req.guildId
  });
  audit(req.user.name, '更新素材兌換所設定');
  res.json({ ok: true });
});

// ---- 兌換項目池 ----
// 兩邊素材的名稱一起帶出來，後台列表才不用再查一次
const OFFER_SELECT = `
  SELECT o.*,
         ci.name cost_name, ci.emoji cost_emoji, ci.price cost_price,
         gi.name give_name, gi.emoji give_emoji, gi.price give_price
    FROM exchange_offers o
    LEFT JOIN gather_items ci ON ci.id = o.cost_item_id
    LEFT JOIN gather_items gi ON gi.id = o.give_item_id
   WHERE o.guild_id=?`;

router.get('/exchange-offers', (req, res) => {
  res.json(db.prepare(`${OFFER_SELECT} ORDER BY o.sort, o.id`).all(req.guildId));
});

// 可以拿來當兌換素材的物品清單（兩邊的下拉選單共用）
router.get('/exchange-items', (req, res) => {
  res.json(db.prepare(
    'SELECT id, name, emoji, kind, price FROM gather_items WHERE guild_id=? AND enabled=1 ORDER BY price, id').all(req.guildId));
});

function offerFields(b) {
  return {
    name: b.name || '', emoji: b.emoji || '',
    cost_item_id: int(b.cost_item_id, 0, 0), cost_count: int(b.cost_count, 1, 1),
    give_item_id: int(b.give_item_id, 0, 0), give_count: int(b.give_count, 1, 1),
    weight: int(b.weight, 100, 1), daily_limit: int(b.daily_limit, 0, 0),
    description: b.description || '', sort: int(b.sort, 0), enabled: b.enabled ? 1 : 0
  };
}

// 同一個素材換同一個素材＝白做工，而且會讓玩家以為自己看錯 —— 直接擋在後台
function badOffer(f) {
  if (!f.cost_item_id || !f.give_item_id) return '請選擇「要交出的素材」與「換到的素材」';
  if (f.cost_item_id === f.give_item_id) return '交出與換到不能是同一種素材';
  return null;
}

router.post('/exchange-offers', (req, res) => {
  const f = offerFields(req.body || {});
  const bad = badOffer(f);
  if (bad) return res.status(400).json({ error: bad });
  const r = db.prepare(
    `INSERT INTO exchange_offers (guild_id,name,emoji,cost_item_id,cost_count,give_item_id,give_count,weight,daily_limit,description,sort,enabled)
     VALUES (@guild_id,@name,@emoji,@cost_item_id,@cost_count,@give_item_id,@give_count,@weight,@daily_limit,@description,@sort,@enabled)`
  ).run({ ...f, guild_id: req.guildId });
  audit(req.user.name, `新增兌換項目 #${r.lastInsertRowid}`);
  res.json({ id: r.lastInsertRowid });
});

router.put('/exchange-offers/:id', (req, res) => {
  const f = offerFields(req.body || {});
  const bad = badOffer(f);
  if (bad) return res.status(400).json({ error: bad });
  db.prepare(
    `UPDATE exchange_offers SET name=@name, emoji=@emoji, cost_item_id=@cost_item_id, cost_count=@cost_count,
       give_item_id=@give_item_id, give_count=@give_count, weight=@weight, daily_limit=@daily_limit,
       description=@description, sort=@sort, enabled=@enabled WHERE id=@id AND guild_id=@guild_id`
  ).run({ ...f, id: req.params.id, guild_id: req.guildId });
  audit(req.user.name, `修改兌換項目 #${req.params.id}`);
  res.json({ ok: true });
});

router.delete('/exchange-offers/:id', (req, res) => {
  // 今天已經開出來的也一併撤掉，否則玩家會選到一個已經不存在的項目
  db.prepare('DELETE FROM exchange_daily WHERE guild_id=? AND offer_id=?').run(req.guildId, req.params.id);
  db.prepare('DELETE FROM exchange_offers WHERE id=? AND guild_id=?').run(req.params.id, req.guildId);
  audit(req.user.name, `刪除兌換項目 #${req.params.id}`);
  res.json({ ok: true });
});

// ---- 今天的清單 ----
router.get('/exchange-today', (req, res) => {
  res.json(db.prepare(
    `SELECT d.day, d.slot, o.id, o.name, o.emoji, o.cost_count, o.give_count, o.daily_limit,
            ci.name cost_name, ci.emoji cost_emoji, gi.name give_name, gi.emoji give_emoji
       FROM exchange_daily d
       JOIN exchange_offers o ON o.id = d.offer_id
       LEFT JOIN gather_items ci ON ci.id = o.cost_item_id
       LEFT JOIN gather_items gi ON gi.id = o.give_item_id
      WHERE d.guild_id=? AND d.day=? ORDER BY d.slot`).all(req.guildId, localToday()));
});

// 重抽今天的清單（改完項目想立刻看到效果時用，不必等到明天午夜）
router.post('/exchange-today/reroll', (req, res) => {
  db.prepare('DELETE FROM exchange_daily WHERE guild_id=? AND day=?').run(req.guildId, localToday());
  audit(req.user.name, '重抽今天的素材兌換清單');
  res.json({ ok: true });
});

// ---- 兌換紀錄 ----
router.get('/exchange-logs', (req, res) => {
  res.json(db.prepare('SELECT * FROM exchange_logs WHERE guild_id=? ORDER BY id DESC LIMIT 200').all(req.guildId));
});

// 哪些素材真的被換掉了（調比例時最有用的一張表）
router.get('/exchange-stats', (req, res) => {
  res.json(db.prepare(
    `SELECT cost_name, SUM(cost_count) total, COUNT(*) rows_n, MAX(created_at) last_at
       FROM exchange_logs WHERE guild_id=? GROUP BY cost_name ORDER BY total DESC LIMIT 30`).all(req.guildId));
});

module.exports = router;
