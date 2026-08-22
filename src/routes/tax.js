// 稅金後台 API：三種稅的設定、累進級距、稅收報表、立即試算/課徵
const express = require('express');
const { db, audit, guildConfig } = require('../db');
const { requireAuth, guardModule } = require('../auth');

const router = express.Router();
router.use(requireAuth(), guardModule('tax'));

const int = (v, d = 0, min = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(min, n) : d; };

router.get('/tax', (req, res) => {
  const c = guildConfig('tax_config', req.guildId);
  const { DEFAULT_BRACKETS } = require('../bot/features/tax');
  let bs;
  try { bs = JSON.parse(c.income_brackets || '[]'); } catch { bs = []; }
  res.json({ ...c, brackets: Array.isArray(bs) && bs.length ? bs : DEFAULT_BRACKETS });
});

router.put('/tax', (req, res) => {
  const b = req.body || {};
  guildConfig('tax_config', req.guildId);
  // 級距：前端送 JSON 字串或陣列都收
  let bs = b.brackets;
  if (typeof bs === 'string') { try { bs = JSON.parse(bs); } catch { bs = null; } }
  const brackets = Array.isArray(bs)
    ? bs.map(x => ({ over: int(x.over, 0, 0), pct: Math.max(0, Math.min(100, parseFloat(x.pct) || 0)) }))
      .filter(x => x.pct > 0).sort((a, c) => a.over - c.over)
    : [];

  // 只覆蓋這次真的有送上來的欄位：舊分頁沒有新欄位時，不要把既有設定（例如免稅名單）洗掉
  const cur = guildConfig('tax_config', req.guildId);
  const keep = (v, k, f) => (v === undefined || v === null ? cur[k] : f(v));
  const bool = (v, k) => (v === undefined || v === null ? cur[k] : (v ? 1 : 0));

  db.prepare(
    `UPDATE tax_config SET enabled=@enabled, period=@period, dow=@dow, dom=@dom, run_time=@run_time,
       channel=@channel, dm_bill=@dm_bill, min_total=@min_total,
       income_enabled=@income_enabled, income_free=@income_free, income_brackets=@income_brackets,
       income_max_pct=@income_max_pct, income_flat=@income_flat, income_base=@income_base,
       land_enabled=@land_enabled, land_field=@land_field, land_greenhouse=@land_greenhouse, land_free=@land_free,
       breed_enabled=@breed_enabled, breed_animal=@breed_animal, breed_fish=@breed_fish, breed_free=@breed_free,
       partner_enabled=@partner_enabled, partner_base=@partner_base, partner_per_lv=@partner_per_lv,
       land_tier_pct=@land_tier_pct,
       stock_enabled=@stock_enabled, stock_pct=@stock_pct, stock_free=@stock_free,
       spend_enabled=@spend_enabled, spend_pct=@spend_pct, spend_free=@spend_free,
       liquidate_enabled=@liquidate_enabled, liquidate_order=@liquidate_order, no_debt=@no_debt,
       relief_enabled=@relief_enabled, relief_below=@relief_below, relief_mode=@relief_mode,
       relief_amount=@relief_amount, relief_floor=@relief_floor, relief_max=@relief_max,
       relief_from_tax=@relief_from_tax,
       exempt_users=@exempt_users, exempt_roles=@exempt_roles
     WHERE guild_id=@guild_id`
  ).run({
    enabled: bool(b.enabled, 'enabled'),
    period: ['day', 'week', 'month'].includes(b.period) ? b.period : cur.period || 'week',
    dow: keep(b.dow, 'dow', v => Math.max(0, Math.min(6, int(v, 1, 0)))),
    dom: keep(b.dom, 'dom', v => Math.max(1, Math.min(28, int(v, 1, 1)))),
    run_time: /^\d{2}:\d{2}$/.test(b.run_time || '') ? b.run_time : (cur.run_time || '09:00'),
    channel: keep(b.channel, 'channel', v => String(v || '')),
    dm_bill: bool(b.dm_bill, 'dm_bill'),
    min_total: keep(b.min_total, 'min_total', v => int(v, 1, 0)),
    income_enabled: bool(b.income_enabled, 'income_enabled'),
    income_free: keep(b.income_free, 'income_free', v => int(v, 100000, 0)),
    // brackets 只在有送 brackets 陣列時才覆寫
    income_brackets: Array.isArray(bs) ? JSON.stringify(brackets) : (cur.income_brackets || ''),
    income_max_pct: keep(b.income_max_pct, 'income_max_pct', v => Math.max(0, Math.min(100, int(v, 50, 0)))),
    income_flat: bool(b.income_flat, 'income_flat'),
    income_base: ['balance', 'earned', 'max'].includes(b.income_base) ? b.income_base : (cur.income_base || 'balance'),
    land_enabled: bool(b.land_enabled, 'land_enabled'),
    land_field: keep(b.land_field, 'land_field', v => int(v, 50, 0)),
    land_greenhouse: keep(b.land_greenhouse, 'land_greenhouse', v => int(v, 120, 0)),
    land_free: keep(b.land_free, 'land_free', v => int(v, 2, 0)),
    breed_enabled: bool(b.breed_enabled, 'breed_enabled'),
    breed_animal: keep(b.breed_animal, 'breed_animal', v => int(v, 80, 0)),
    breed_fish: keep(b.breed_fish, 'breed_fish', v => int(v, 200, 0)),
    breed_free: keep(b.breed_free, 'breed_free', v => int(v, 1, 0)),
    // 伴侶稅：同居角色每位的基本額 ＋ 好感度每階加課
    partner_enabled: bool(b.partner_enabled, 'partner_enabled'),
    partner_base: keep(b.partner_base, 'partner_base', v => int(v, 5000, 0)),
    partner_per_lv: keep(b.partner_per_lv, 'partner_per_lv', v => int(v, 1500, 0)),
    // 土地稅依設施等級加成（每階 +N%）
    land_tier_pct: keep(b.land_tier_pct, 'land_tier_pct', v => int(v, 20, 0)),
    // 證券稅：按持股市值課
    stock_enabled: bool(b.stock_enabled, 'stock_enabled'),
    stock_pct: keep(b.stock_pct, 'stock_pct', v => Math.max(0, Math.min(100, Math.round(parseFloat(v) * 100) / 100 || 0))),
    stock_free: keep(b.stock_free, 'stock_free', v => int(v, 0, 0)),
    // 消費稅
    spend_enabled: bool(b.spend_enabled, 'spend_enabled'),
    spend_pct: keep(b.spend_pct, 'spend_pct', v => Math.max(0, Math.min(100, Math.round(parseFloat(v) * 100) / 100 || 0))),
    spend_free: keep(b.spend_free, 'spend_free', v => int(v, 0, 0)),
    // 強制清算
    liquidate_enabled: bool(b.liquidate_enabled, 'liquidate_enabled'),
    no_debt: bool(b.no_debt, 'no_debt'),
    liquidate_order: keep(b.liquidate_order, 'liquidate_order', v => String(v).split(/[\s,;、]+/)
      .map(x => x.trim()).filter(x => ['bag', 'stock', 'fish', 'animal'].includes(x)).join(',') || 'stock'),
    // 普發
    relief_enabled: bool(b.relief_enabled, 'relief_enabled'),
    relief_below: keep(b.relief_below, 'relief_below', v => int(v, 0, -1e12)),
    relief_mode: ['floor', 'fixed'].includes(b.relief_mode) ? b.relief_mode : (cur.relief_mode || 'floor'),
    relief_amount: keep(b.relief_amount, 'relief_amount', v => int(v, 10000, 0)),
    relief_floor: keep(b.relief_floor, 'relief_floor', v => int(v, 0, -1e12)),
    relief_max: keep(b.relief_max, 'relief_max', v => int(v, 0, 0)),
    relief_from_tax: bool(b.relief_from_tax, 'relief_from_tax'),
    // 免稅名單：逗號／空白／換行都能分隔
    exempt_users: keep(b.exempt_users, 'exempt_users', v => String(v).split(/[\s,;、]+/).map(x => x.trim()).filter(Boolean).join(',')),
    exempt_roles: keep(b.exempt_roles, 'exempt_roles', v => String(v).split(/[\s,;、]+/).map(x => x.trim()).filter(Boolean).join(',')),
    guild_id: req.guildId
  });
  audit(req.user.name, '更新稅金設定', 'gather', '', req.guildId);
  res.json({ ok: true });
});

// 稅收報表：每一期的總額 + 人數
router.get('/tax-periods', (req, res) => {
  res.json(db.prepare(
    `SELECT period, COUNT(*) people, SUM(paid) paid, SUM(total) total,
            SUM(income_tax) income, SUM(land_tax) land, SUM(breed_tax) breed
     FROM tax_records WHERE guild_id=? GROUP BY period ORDER BY period DESC LIMIT 30`
  ).all(req.guildId));
});

// 單一期間的個人稅單
router.get('/tax-records', (req, res) => {
  const period = req.query.period || '';
  const rows = period
    ? db.prepare('SELECT * FROM tax_records WHERE guild_id=? AND period=? ORDER BY paid DESC LIMIT 300').all(req.guildId, period)
    : db.prepare('SELECT * FROM tax_records WHERE guild_id=? ORDER BY id DESC LIMIT 300').all(req.guildId);
  res.json(rows);
});

// 立即試算（dry=1，不扣款）或立即課徵一期
router.post('/tax-run', async (req, res) => {
  const dryRun = String((req.body || {}).dry || '') === '1';
  const client = require('../bot').client;
  if (!client || !client._runTax) return res.status(503).json({ error: '機器人尚未上線' });
  try {
    const r = await client._runTax(req.guildId, { force: true, dryRun });
    if (!dryRun) audit(req.user.name, '手動執行稅金結算', 'gather', '', req.guildId);
    res.json({
      ok: true, dryRun, period: r.period, sum: r.sum, people: r.bills.length,
      top: r.bills.sort((a, b) => b.total - a.total).slice(0, 20).map(b => ({
        user_id: b.userId, username: b.wallet.username, balance: b.balance,
        income: b.income, land: b.land, breed: b.breed, total: b.total
      }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
