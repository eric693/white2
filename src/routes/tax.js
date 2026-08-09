// 稅金後台 API：三種稅的設定、累進級距、稅收報表、立即試算/課徵
const express = require('express');
const { db, audit, guildConfig } = require('../db');
const { requireAuth, guardModule } = require('../auth');

const router = express.Router();
router.use(requireAuth(), guardModule('gather'));

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

  db.prepare(
    `UPDATE tax_config SET enabled=@enabled, period=@period, dow=@dow, dom=@dom, run_time=@run_time,
       channel=@channel, dm_bill=@dm_bill, min_total=@min_total,
       income_enabled=@income_enabled, income_free=@income_free, income_brackets=@income_brackets,
       income_max_pct=@income_max_pct,
       land_enabled=@land_enabled, land_field=@land_field, land_greenhouse=@land_greenhouse, land_free=@land_free,
       breed_enabled=@breed_enabled, breed_animal=@breed_animal, breed_fish=@breed_fish, breed_free=@breed_free
     WHERE guild_id=@guild_id`
  ).run({
    enabled: b.enabled ? 1 : 0,
    period: ['day', 'week', 'month'].includes(b.period) ? b.period : 'week',
    dow: Math.max(0, Math.min(6, int(b.dow, 1, 0))),
    dom: Math.max(1, Math.min(28, int(b.dom, 1, 1))),
    run_time: /^\d{2}:\d{2}$/.test(b.run_time || '') ? b.run_time : '09:00',
    channel: b.channel || '',
    dm_bill: b.dm_bill ? 1 : 0,
    min_total: int(b.min_total, 1, 0),
    income_enabled: b.income_enabled ? 1 : 0,
    income_free: int(b.income_free, 100000, 0),
    income_brackets: JSON.stringify(brackets),
    income_max_pct: Math.max(0, Math.min(100, int(b.income_max_pct, 50, 0))),
    land_enabled: b.land_enabled ? 1 : 0,
    land_field: int(b.land_field, 50, 0),
    land_greenhouse: int(b.land_greenhouse, 120, 0),
    land_free: int(b.land_free, 2, 0),
    breed_enabled: b.breed_enabled ? 1 : 0,
    breed_animal: int(b.breed_animal, 80, 0),
    breed_fish: int(b.breed_fish, 200, 0),
    breed_free: int(b.breed_free, 1, 0),
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
