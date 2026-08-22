// 財經新聞快報 ＋ 星幣股市 後台 API
const express = require('express');
const { db, audit, guildConfig } = require('../db');
const { requireAuth, guardModule, parsePermissions } = require('../auth');
const { bust, activeModifiers, normMultPct } = require('../util/market');

const router = express.Router();
// 兩把鑰匙：
//   stock ＝ 股市（掛牌、參數、成交紀錄）
//   news  ＝ 財經新聞（掌管全服物價與股價，權責最大，所以獨立出來）
// 只給其中一把的管理員，另一半的 API 直接看不到、也改不了。
router.use(requireAuth());
const anyMarket = (req, res, next) => {
  const perms = req.user.role === 'admin' ? ['stock', 'news'] : parsePermissions(req.user.permissions);
  return (perms.includes('stock') || perms.includes('news')) ? next() : next('router');
};

const int = (v, d = 0, min = -1e12) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(min, n) : d; };
// 手續費要能填小數（例如 1.5%），只保留到小數點後兩位
const pct = (v, d = 0, min = 0, max = 100) => {
  const n = Math.round(parseFloat(v) * 100) / 100;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};
const cfg = (gid) => guildConfig('market_config', gid);

// ---------- 設定 ----------
router.get('/market', anyMarket, (req, res) => {
  const c = cfg(req.guildId);
  const burnedWeek = db.prepare(
    "SELECT COALESCE(SUM(fee),0) f FROM stock_trades WHERE guild_id=? AND ts > ?"
  ).get(req.guildId, Date.now() - 7 * 86400000).f;
  const traders = db.prepare('SELECT COUNT(DISTINCT user_id) n FROM stock_trades WHERE guild_id=?').get(req.guildId).n;
  const mktCap = db.prepare(
    'SELECT COALESCE(SUM(h.shares * s.price),0) v FROM stock_holdings h JOIN stock_symbols s ON s.id=h.symbol_id WHERE h.guild_id=?'
  ).get(req.guildId).v;
  res.json({ ...c, stats: { burnedWeek, traders, mktCap, activeMods: activeModifiers(req.guildId).length } });
});

router.put('/market', anyMarket, (req, res) => {
  const b = req.body || {};
  cfg(req.guildId);
  // 只給 news 的人不能動股市參數，只給 stock 的人不能動新聞開關與物價護欄 ——
  // 沒送到的欄位一律保留原值，避免對方的設定被另一頁的表單覆蓋掉。
  const perms = req.user.role === 'admin' ? ['stock', 'news'] : parsePermissions(req.user.permissions);
  const cur = cfg(req.guildId);
  const canNews = perms.includes('news'), canStock = perms.includes('stock');
  const pick = (allowed, key, val) => (allowed && key in b) ? val : cur[key];
  db.prepare(
    `UPDATE market_config SET enabled=@enabled, stock_enabled=@stock_enabled, channels=@channels, news_channel=@news_channel,
       tick_minutes=@tick_minutes, fee_pct=@fee_pct, limit_pct=@limit_pct, min_trade=@min_trade, max_trade=@max_trade,
       max_shares=@max_shares, trade_cooldown_s=@trade_cooldown_s, daily_trade_limit=@daily_trade_limit,
       mult_floor_pct=@mult_floor_pct, mult_ceil_pct=@mult_ceil_pct WHERE guild_id=@guild_id`
  ).run({
    enabled: pick(canNews, 'enabled', b.enabled ? 1 : 0),
    news_channel: pick(canNews, 'news_channel', String(b.news_channel || '')),
    mult_floor_pct: pick(canNews, 'mult_floor_pct', int(b.mult_floor_pct, 40, 1)),
    mult_ceil_pct: pick(canNews, 'mult_ceil_pct', int(b.mult_ceil_pct, 250, 100)),
    stock_enabled: pick(canStock, 'stock_enabled', b.stock_enabled ? 1 : 0),
    channels: pick(canStock, 'channels', String(b.channels || '')),
    tick_minutes: pick(canStock, 'tick_minutes', int(b.tick_minutes, 60, 1)),
    fee_pct: pick(canStock, 'fee_pct', pct(b.fee_pct, 2, 0, 50)),
    limit_pct: pick(canStock, 'limit_pct', int(b.limit_pct, 20, 1)),
    min_trade: pick(canStock, 'min_trade', int(b.min_trade, 1, 1)),
    max_trade: pick(canStock, 'max_trade', int(b.max_trade, 100, 0)),
    max_shares: pick(canStock, 'max_shares', int(b.max_shares, 500, 0)),
    trade_cooldown_s: pick(canStock, 'trade_cooldown_s', int(b.trade_cooldown_s, 30, 0)),
    daily_trade_limit: pick(canStock, 'daily_trade_limit', int(b.daily_trade_limit, 0, 0)),
    guild_id: req.guildId
  });
  bust(req.guildId);
  audit(req.user.name, canNews && !canStock ? '更新財經新聞設定' : `更新股市設定（物價新聞 ${b.enabled ? '開' : '關'}／股市 ${b.stock_enabled ? '開' : '關'}）`);
  res.json({ ok: true });
});

// ---------- 股票 ----------
router.get('/stock-symbols', guardModule('stock'), (req, res) => {
  const rows = db.prepare('SELECT * FROM stock_symbols WHERE guild_id=? ORDER BY sort, id').all(req.guildId);
  for (const r of rows) {
    const h = db.prepare('SELECT close FROM stock_prices WHERE guild_id=? AND symbol_id=? ORDER BY ts DESC LIMIT 24')
      .all(req.guildId, r.id).map(x => x.close).reverse();
    r.history = h;
    r.holders = db.prepare('SELECT COUNT(*) n FROM stock_holdings WHERE guild_id=? AND symbol_id=? AND shares>0').get(req.guildId, r.id).n;
  }
  res.json(rows);
});

const symBody = (b, cur = {}) => ({
  code: String(b.code || cur.code || '').trim(),
  name: String(b.name || cur.name || '').trim(),
  emoji: String(b.emoji ?? cur.emoji ?? ''),
  // 現價與錨價都可以是 0 或負數：想讓一支股真的跌破零，錨價必須跟著設成負的，
  // 否則均值回歸每個 tick 都會把價格往正的拉回去。
  price: int(b.price, cur.price ?? 100),
  anchor: int(b.anchor, cur.anchor ?? int(b.price, 100)),
  vol_pct: int(b.vol_pct, cur.vol_pct ?? 8, 0),
  drift_pct: int(b.drift_pct, cur.drift_pct ?? 0),
  revert_pct: int(b.revert_pct, cur.revert_pct ?? 10, 0),
  floor_price: int(b.floor_price, cur.floor_price ?? 10),
  ceil_price: int(b.ceil_price, cur.ceil_price ?? 100000, 1),
  description: String(b.description ?? cur.description ?? ''),
  sort: int(b.sort, cur.sort ?? 0),
  enabled: b.enabled ? 1 : 0
});

router.post('/stock-symbols', guardModule('stock'), (req, res) => {
  const v = symBody(req.body || {});
  if (!v.code || !v.name) return res.status(400).json({ error: '請填寫代號與名稱' });
  if (db.prepare('SELECT 1 FROM stock_symbols WHERE guild_id=? AND code=?').get(req.guildId, v.code)) {
    return res.status(400).json({ error: `代號 ${v.code} 已存在` });
  }
  const r = db.prepare(
    `INSERT INTO stock_symbols (guild_id,code,name,emoji,price,anchor,vol_pct,drift_pct,revert_pct,floor_price,ceil_price,description,sort,enabled)
     VALUES (@guild_id,@code,@name,@emoji,@price,@anchor,@vol_pct,@drift_pct,@revert_pct,@floor_price,@ceil_price,@description,@sort,@enabled)`
  ).run({ ...v, guild_id: req.guildId });
  audit(req.user.name, `新增股票：${v.code} ${v.name}`);
  res.json({ id: r.lastInsertRowid });
});

router.put('/stock-symbols/:id', guardModule('stock'), (req, res) => {
  const cur = db.prepare('SELECT * FROM stock_symbols WHERE id=? AND guild_id=?').get(req.params.id, req.guildId);
  if (!cur) return res.status(404).json({ error: '找不到股票' });
  const v = symBody(req.body || {}, cur);
  db.prepare(
    `UPDATE stock_symbols SET code=@code, name=@name, emoji=@emoji, price=@price, anchor=@anchor, vol_pct=@vol_pct,
       drift_pct=@drift_pct, revert_pct=@revert_pct, floor_price=@floor_price, ceil_price=@ceil_price,
       description=@description, sort=@sort, enabled=@enabled WHERE id=@id AND guild_id=@guild_id`
  ).run({ ...v, id: req.params.id, guild_id: req.guildId });
  audit(req.user.name, `修改股票 #${req.params.id}`);
  res.json({ ok: true });
});

router.delete('/stock-symbols/:id', guardModule('stock'), (req, res) => {
  const held = db.prepare('SELECT COALESCE(SUM(shares),0) n FROM stock_holdings WHERE guild_id=? AND symbol_id=?')
    .get(req.guildId, req.params.id).n;
  if (held > 0) return res.status(400).json({ error: `還有玩家持有 ${held} 股，不能直接刪除（可以改成停用）` });
  db.transaction(() => {
    db.prepare('DELETE FROM stock_prices WHERE guild_id=? AND symbol_id=?').run(req.guildId, req.params.id);
    db.prepare('DELETE FROM stock_holdings WHERE guild_id=? AND symbol_id=?').run(req.guildId, req.params.id);
    db.prepare('DELETE FROM stock_symbols WHERE id=? AND guild_id=?').run(req.params.id, req.guildId);
  })();
  audit(req.user.name, `刪除股票 #${req.params.id}`);
  res.json({ ok: true });
});

// ---------- 可選的效果目標（發新聞的下拉用）----------
router.get('/market-targets', anyMarket, (req, res) => {
  const gid = req.guildId;
  res.json({
    items: db.prepare('SELECT id, name, emoji, kind, price FROM gather_items WHERE guild_id=? AND enabled=1 ORDER BY kind, price').all(gid),
    symbols: db.prepare('SELECT id, code, name, emoji, price FROM stock_symbols WHERE guild_id=? AND enabled=1 ORDER BY sort, id').all(gid),
    kinds: [
      { key: 'fish', label: '🎣 釣魚' }, { key: 'mine', label: '⛏️ 挖礦' }, { key: 'wood', label: '🪓 伐木' },
      { key: 'forage', label: '🧺 採集' }, { key: 'hunt', label: '🏹 狩獵' }, { key: 'farm', label: '🥚 農牧產物' }
    ]
  });
});

// ---------- 新聞 ----------
router.get('/market-news', guardModule('news'), (req, res) => {
  res.json(db.prepare('SELECT * FROM market_news WHERE guild_id=? ORDER BY id DESC LIMIT 100').all(req.guildId));
});

router.post('/market-news', guardModule('news'), (req, res) => {
  const b = req.body || {};
  if (!b.headline) return res.status(400).json({ error: '請填寫標題' });
  // 前端送來的是倍率 %（130 ＝ ×1.3）。normMultPct 會把 0／負數當成舊語意的
  // 「漲跌 %」換算回來（-10 → 90），並夾在 10～500。
  const effects = (Array.isArray(b.effects) ? b.effects.filter(e => e && e.scope) : [])
    .map(e => ({ ...e, mult_pct: normMultPct(e.mult_pct) }))
    .filter(e => e.mult_pct !== 100);
  const stockFx = Array.isArray(b.stock_fx) ? b.stock_fx.filter(f => f && f.symbol_id) : [];
  if (!effects.length && !stockFx.length) return res.status(400).json({ error: '至少要加一條影響（物價或股價）' });
  const r = db.prepare(
    `INSERT INTO market_news (guild_id,headline,body,image_url,duration_h,effects,stock_fx,effect_ts,created_by)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(req.guildId, String(b.headline), String(b.body || ''), String(b.image_url || ''),
    int(b.duration_h, 6, 1), JSON.stringify(effects), JSON.stringify(stockFx),
    b.effect_ts ? int(b.effect_ts, 0, 0) : 0, req.user.name);
  audit(req.user.name, `發布財經快報：${b.headline}`);
  res.json({ id: r.lastInsertRowid });
});

// 一鍵清除所有「已結束」的快報（時段已過的，不影響還在生效中的）
router.delete('/market-news-ended', guardModule('news'), (req, res) => {
  const now = Date.now();
  const r = db.prepare(
    'DELETE FROM market_news WHERE guild_id=? AND applied=1 AND (effect_ts + duration_h*3600000) < ?'
  ).run(req.guildId, now);
  audit(req.user.name, `清除已結束快報 ${r.changes} 則`);
  res.json({ ok: true, removed: r.changes });
});

// 撤銷：把還在生效的倍率提前結束（已成交的交易不動）
router.delete('/market-news/:id', guardModule('news'), (req, res) => {
  const now = Date.now();
  db.prepare('UPDATE market_modifiers SET end_ts=? WHERE guild_id=? AND news_id=? AND end_ts>?')
    .run(now, req.guildId, req.params.id, now);
  // 撤銷＝完全移除這則新聞（不論已生效/已結束）：先把它還在生效的倍率結束，再刪掉新聞本身
  db.prepare('DELETE FROM market_news WHERE id=? AND guild_id=?').run(req.params.id, req.guildId);
  bust(req.guildId);
  audit(req.user.name, `撤銷財經快報 #${req.params.id}`);
  res.json({ ok: true });
});

// ---------- 生效中的倍率 ----------
router.get('/market-modifiers', guardModule('news'), (req, res) => {
  const now = Date.now();
  res.json(db.prepare(
    `SELECT m.*, n.headline FROM market_modifiers m LEFT JOIN market_news n ON n.id=m.news_id
      WHERE m.guild_id=? AND m.end_ts>? ORDER BY m.end_ts`
  ).all(req.guildId, now));
});

router.delete('/market-modifiers/:id', guardModule('news'), (req, res) => {
  db.prepare('UPDATE market_modifiers SET end_ts=? WHERE id=? AND guild_id=?').run(Date.now(), req.params.id, req.guildId);
  bust(req.guildId);
  audit(req.user.name, `提前結束行情倍率 #${req.params.id}`);
  res.json({ ok: true });
});

// ---------- 成交紀錄 ----------
router.get('/stock-trades', guardModule('stock'), (req, res) => {
  res.json(db.prepare(
    `SELECT t.*, s.code, s.name, s.emoji FROM stock_trades t LEFT JOIN stock_symbols s ON s.id=t.symbol_id
      WHERE t.guild_id=? ORDER BY t.id DESC LIMIT 200`
  ).all(req.guildId));
});

module.exports = router;
