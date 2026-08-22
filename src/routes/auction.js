// 基金會拍賣會後台 API（沿用 charity 權限：拍賣是基金會的活動）
const express = require('express');
const { db, audit, guildConfig } = require('../db');
const { requireAuth, guardModule } = require('../auth');

const router = express.Router();
router.use(requireAuth(), guardModule('charity'));

const int = (v, d = 0, min = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(min, n) : d; };
const str = (v, d = '') => (v === undefined || v === null) ? d : String(v);
const mats = (v) => {
  let a = v;
  if (typeof v === 'string') { try { a = JSON.parse(v); } catch { a = []; } }
  if (!Array.isArray(a)) a = [];
  return JSON.stringify(a.filter(x => x && x.item).map(x => ({ item: String(x.item), count: Math.max(1, int(x.count, 1, 1)) })));
};
const KINDS = ['furniture', 'pet', 'title', 'item'];

// ---------- 設定 ----------
router.get('/auction-config', (req, res) => res.json(guildConfig('auction_config', req.guildId)));

router.put('/auction-config', (req, res) => {
  const b = req.body || {};
  guildConfig('auction_config', req.guildId);
  db.prepare(
    `UPDATE auction_config SET enabled=@enabled, channel=@channel, fee_pct=@fee_pct, min_inc_pct=@min_inc_pct,
       min_inc=@min_inc, antisnipe_min=@antisnipe_min, extend_min=@extend_min, max_bid_pct=@max_bid_pct, to_pool=@to_pool
     WHERE guild_id=@guild_id`
  ).run({
    enabled: b.enabled ? 1 : 0,
    channel: str(b.channel),
    fee_pct: Math.max(0, Math.min(50, Math.round(parseFloat(b.fee_pct) * 100) / 100 || 0)),
    min_inc_pct: int(b.min_inc_pct, 5, 0),
    min_inc: int(b.min_inc, 100, 0),
    antisnipe_min: int(b.antisnipe_min, 3, 0),
    extend_min: int(b.extend_min, 3, 0),
    max_bid_pct: Math.max(0, Math.min(100, int(b.max_bid_pct, 0, 0))),
    to_pool: b.to_pool ? 1 : 0,
    guild_id: req.guildId
  });
  audit(req.user.name, '更新拍賣會設定', 'gather', '', req.guildId);
  res.json({ ok: true });
});

// ---------- 可以拿來拍賣的標的 ----------
router.get('/auction-targets', (req, res) => {
  const gid = req.guildId;
  res.json({
    furniture: db.prepare('SELECT id, name, emoji, price FROM home_furniture WHERE guild_id=? ORDER BY sort, id').all(gid),
    pet: db.prepare('SELECT id, name, emoji, price, rarity FROM pet_defs WHERE guild_id=? ORDER BY sort, id').all(gid),
    title: db.prepare('SELECT id, name, emoji FROM title_defs WHERE guild_id=? ORDER BY sort, id').all(gid),
    item: db.prepare('SELECT id, name, emoji, price FROM gather_items WHERE guild_id=? AND enabled=1 ORDER BY kind, price').all(gid),
    items_by_name: db.prepare('SELECT name, emoji FROM gather_items WHERE guild_id=? AND enabled=1 ORDER BY kind, price').all(gid)
  });
});

// ---------- 場次 ----------
router.get('/auctions', (req, res) => {
  const rows = db.prepare('SELECT * FROM auctions WHERE guild_id=? ORDER BY id DESC LIMIT 100').all(req.guildId);
  const bidStmt = db.prepare('SELECT username, amount, active, created_at FROM auction_bids WHERE auction_id=? ORDER BY amount DESC LIMIT 5');
  res.json(rows.map(r => ({ ...r, top_bids: bidStmt.all(r.id) })));
});

function fields(b) {
  const start = b.start_at ? Date.parse(b.start_at) : Date.now();
  const hours = Math.max(0.25, parseFloat(b.duration_h) || 24);
  return {
    kind: KINDS.includes(b.kind) ? b.kind : 'item',
    ref_id: int(b.ref_id, 0, 0),
    qty: int(b.qty, 1, 1),
    title: str(b.title), emoji: str(b.emoji), description: str(b.description), image_url: str(b.image_url),
    start_price: int(b.start_price, 0, 0),
    buyout_price: int(b.buyout_price, 0, 0),
    mats_cost: mats(b.mats_cost),
    start_ts: Number.isFinite(start) ? start : Date.now(),
    end_ts: (Number.isFinite(start) ? start : Date.now()) + Math.round(hours * 3600000)
  };
}

router.post('/auctions', (req, res) => {
  const f = fields(req.body || {});
  if (!f.ref_id) return res.status(400).json({ error: '請選擇要拍賣的標的' });
  if (f.buyout_price && f.buyout_price < f.start_price) return res.status(400).json({ error: '直接買下的價格不能低於起標價' });
  const keys = Object.keys(f);
  const r = db.prepare(
    `INSERT INTO auctions (guild_id, created_by, status, ${keys.join(',')})
     VALUES (?, ?, 'scheduled', ${keys.map(() => '?').join(',')})`
  ).run(req.guildId, req.user.name, ...keys.map(k => f[k]));
  audit(req.user.name, `新增拍賣場次 #${r.lastInsertRowid}`, 'gather', '', req.guildId);
  res.json({ id: r.lastInsertRowid });
});

router.put('/auctions/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM auctions WHERE id=? AND guild_id=?').get(req.params.id, req.guildId);
  if (!cur) return res.status(404).json({ error: '找不到這場拍賣' });
  if (cur.status === 'ended') return res.status(400).json({ error: '已結標的場次不能再改' });
  // 已經有人出價就不准改價格與標的（否則等於把玩家鎖住的錢當人質）
  const bidded = db.prepare('SELECT COUNT(*) n FROM auction_bids WHERE auction_id=?').get(cur.id).n > 0;
  const f = fields(req.body || {});
  if (bidded) {
    Object.assign(f, {
      kind: cur.kind, ref_id: cur.ref_id, qty: cur.qty,
      start_price: cur.start_price, mats_cost: cur.mats_cost, start_ts: cur.start_ts
    });
  }
  const keys = Object.keys(f);
  db.prepare(`UPDATE auctions SET ${keys.map(k => `${k}=?`).join(',')} WHERE id=? AND guild_id=?`)
    .run(...keys.map(k => f[k]), cur.id, req.guildId);
  audit(req.user.name, `修改拍賣場次 #${cur.id}${bidded ? '（已有人出價，價格與標的維持原樣）' : ''}`, 'gather', '', req.guildId);
  res.json({ ok: true, locked: bidded });
});

// 取消：把還鎖著的競標金全額退回，場次標記為 cancelled
router.delete('/auctions/:id', (req, res) => {
  const gid = req.guildId;
  const a = db.prepare('SELECT * FROM auctions WHERE id=? AND guild_id=?').get(req.params.id, gid);
  if (!a) return res.status(404).json({ error: '找不到這場拍賣' });
  if (a.status === 'ended') return res.status(400).json({ error: '已經成交的場次不能取消（標的已經交付）' });
  const active = db.prepare('SELECT * FROM auction_bids WHERE auction_id=? AND active=1').all(a.id);
  const { addCoins } = require('../bot/features/gather');
  db.transaction(() => {
    for (const bid of active) {
      addCoins(gid, bid.user_id, bid.username, bid.amount);
      db.prepare('UPDATE auction_bids SET active=0 WHERE id=?').run(bid.id);
    }
    db.prepare("UPDATE auctions SET status='cancelled' WHERE id=?").run(a.id);
  })();
  audit(req.user.name, `取消拍賣場次 #${a.id}，退回 ${active.length} 筆競標金`, 'gather', '', gid);
  res.json({ ok: true, refunded: active.length });
});

module.exports = router;
