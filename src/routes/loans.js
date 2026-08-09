// 物資貸款後台 API：抵押率／期限／利息設定，貸款清單，免除與立即處理到期
const express = require('express');
const { db, audit, guildConfig } = require('../db');
const { requireAuth, guardModule } = require('../auth');

const router = express.Router();
router.use(requireAuth(), guardModule('gather'));

const int = (v, d = 0, min = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(min, n) : d; };
const KINDS = ['tool', 'crop', 'fish'];

router.get('/loans', (req, res) => {
  const c = guildConfig('loan_config', req.guildId);
  const loans = db.prepare('SELECT * FROM loans WHERE guild_id=? ORDER BY id DESC LIMIT 200').all(req.guildId);
  const coll = db.prepare(
    `SELECT c.loan_id, c.kind, c.detail, c.value FROM loan_collaterals c
      JOIN loans l ON l.id=c.loan_id WHERE l.guild_id=? ORDER BY c.id`).all(req.guildId);
  const byLoan = {};
  for (const x of coll) (byLoan[x.loan_id] = byLoan[x.loan_id] || []).push(x);
  res.json({ ...c, loans: loans.map(l => ({ ...l, collaterals: byLoan[l.id] || [] })) });
});

router.put('/loans', (req, res) => {
  const b = req.body || {};
  const cur = guildConfig('loan_config', req.guildId);
  const keep = (v, k, f) => (v === undefined || v === null ? cur[k] : f(v));
  const bool = (v, k) => (v === undefined || v === null ? cur[k] : (v ? 1 : 0));
  db.prepare(
    `UPDATE loan_config SET enabled=@enabled, ltv_pct=@ltv_pct, max_loan=@max_loan, max_open=@max_open,
       term_days=@term_days, interest_pct=@interest_pct, debtor_only=@debtor_only,
       collateral_order=@collateral_order, channel=@channel
     WHERE guild_id=@guild_id`
  ).run({
    enabled: bool(b.enabled, 'enabled'),
    ltv_pct: keep(b.ltv_pct, 'ltv_pct', v => Math.max(1, Math.min(100, int(v, 70, 1)))),
    max_loan: keep(b.max_loan, 'max_loan', v => int(v, 0, 0)),
    max_open: keep(b.max_open, 'max_open', v => Math.max(1, int(v, 1, 1))),
    term_days: keep(b.term_days, 'term_days', v => Math.max(1, int(v, 7, 1))),
    interest_pct: keep(b.interest_pct, 'interest_pct', v => Math.max(0, Math.min(100, Math.round(parseFloat(v) * 100) / 100 || 0))),
    debtor_only: bool(b.debtor_only, 'debtor_only'),
    collateral_order: keep(b.collateral_order, 'collateral_order', v => String(v).split(/[\s,;、]+/)
      .map(x => x.trim()).filter(x => KINDS.includes(x)).join(',') || 'tool,crop,fish'),
    channel: keep(b.channel, 'channel', v => String(v || '')),
    guild_id: req.guildId
  });
  audit(req.user.name, '更新物資貸款設定', 'gather', '', req.guildId);
  res.json({ ok: true });
});

// 免除一筆貸款：債務歸零、抵押品原封不動還給玩家（客服補償用）
router.post('/loans-forgive', (req, res) => {
  const id = parseInt((req.body || {}).id, 10) || 0;
  const loan = db.prepare("SELECT * FROM loans WHERE id=? AND guild_id=? AND status='open'").get(id, req.guildId);
  if (!loan) return res.status(404).json({ error: '找不到這筆未還清的貸款' });
  const { giveBack } = require('../bot/features/loans');
  db.transaction(() => {
    db.prepare("UPDATE loans SET owed=0, status='repaid', closed_at=datetime('now','localtime') WHERE id=?").run(id);
    giveBack(req.guildId, loan.user_id, id);   // 格子被佔走的抵押品會自動折現
  })();
  audit(req.user.name, `免除貸款 #${id}`, 'gather', '', req.guildId);
  res.json({ ok: true });
});

// 立即處理到期未還的貸款（不用等 10 分鐘的排程）
router.post('/loans-sweep', async (req, res) => {
  const client = require('../bot').client;
  if (!client || !client._sweepLoans) return res.status(503).json({ error: '機器人尚未上線' });
  try {
    const out = await client._sweepLoans(req.guildId);
    audit(req.user.name, '手動處理到期貸款', 'gather', '', req.guildId);
    res.json({ ok: true, count: out.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
