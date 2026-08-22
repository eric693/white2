// 慈善基金會後台 API：抵稅比例、撥入普發、帳目與捐款明細
const express = require('express');
const { db, audit, guildConfig } = require('../db');
const { requireAuth, guardModule } = require('../auth');

const router = express.Router();
router.use(requireAuth(), guardModule('charity'));

const int = (v, d = 0, min = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(min, n) : d; };

router.get('/charity', (req, res) => {
  const c = guildConfig('charity_config', req.guildId);
  const top = db.prepare(
    `SELECT user_id, username, SUM(amount) amount, COUNT(*) times FROM charity_donations
      WHERE guild_id=? GROUP BY user_id ORDER BY amount DESC LIMIT 20`).all(req.guildId);
  const recent = db.prepare('SELECT * FROM charity_donations WHERE guild_id=? ORDER BY id DESC LIMIT 50').all(req.guildId);
  const payouts = db.prepare('SELECT * FROM charity_payouts WHERE guild_id=? ORDER BY id DESC LIMIT 20').all(req.guildId);
  res.json({ ...c, top, recent, payouts });
});

router.put('/charity', (req, res) => {
  const b = req.body || {};
  const cur = guildConfig('charity_config', req.guildId);
  const keep = (v, k, f) => (v === undefined || v === null ? cur[k] : f(v));
  const bool = (v, k) => (v === undefined || v === null ? cur[k] : (v ? 1 : 0));
  db.prepare(
    `UPDATE charity_config SET enabled=@enabled, name=@name, min_donate=@min_donate, deduct_pct=@deduct_pct,
       deduct_max=@deduct_max, deduct_max_pct=@deduct_max_pct, to_relief=@to_relief, channel=@channel
     WHERE guild_id=@guild_id`
  ).run({
    enabled: bool(b.enabled, 'enabled'),
    name: keep(b.name, 'name', v => String(v || '').slice(0, 40) || '慈善基金會'),
    min_donate: keep(b.min_donate, 'min_donate', v => int(v, 1000, 0)),
    deduct_pct: keep(b.deduct_pct, 'deduct_pct', v => Math.max(0, Math.min(100, Math.round(parseFloat(v) * 100) / 100 || 0))),
    deduct_max: keep(b.deduct_max, 'deduct_max', v => int(v, 0, 0)),
    deduct_max_pct: keep(b.deduct_max_pct, 'deduct_max_pct', v => Math.max(0, Math.min(100, int(v, 100, 0)))),
    to_relief: bool(b.to_relief, 'to_relief'),
    channel: keep(b.channel, 'channel', v => String(v || '')),
    guild_id: req.guildId
  });
  audit(req.user.name, '更新慈善基金會設定', 'gather', '', req.guildId);
  res.json({ ok: true });
});

// 手動調整基金會餘額（活動加碼／修正誤差）。正數＝注資，負數＝抽走。
router.post('/charity-adjust', (req, res) => {
  const delta = parseInt((req.body || {}).delta, 10) || 0;
  if (!delta) return res.status(400).json({ error: '請填要增減的金額' });
  const c = guildConfig('charity_config', req.guildId);
  const next = Math.max(0, (c.pool || 0) + delta);
  db.prepare('UPDATE charity_config SET pool=?, total_in = total_in + ? WHERE guild_id=?')
    .run(next, delta > 0 ? delta : 0, req.guildId);
  audit(req.user.name, `調整基金會餘額 ${delta > 0 ? '+' : ''}${delta}`, 'gather', '', req.guildId);
  res.json({ ok: true, pool: next });
});


// ---------- 手動普發（例如「全服普發一萬」）----------
//
// 跟稅金那邊的自動普發不同：那個綁在結算流程、只發給餘額低於門檻的人；
// 這裡是活動用的一鍵普發，可以指定對象條件、單人金額與財源，先試算再執行。
const bot = require('../bot');

function reliefTargets(gid, b) {
  const amount = int(b.amount, 0, 1);
  const mode = b.mode === 'below' ? 'below' : 'all';
  const below = int(b.below, 0, -1e12);
  const activeDays = int(b.active_days, 0, 0);
  const rows = db.prepare('SELECT user_id, username, coins, updated_at FROM econ_wallets WHERE guild_id=?').all(gid);
  const tax = require('../bot/features/tax');
  const guild = bot.client && bot.client.guilds ? bot.client.guilds.cache.get(gid) : null;
  const cutoff = activeDays > 0 ? Date.now() - activeDays * 86400000 : 0;

  return rows.filter(w => {
    if (mode === 'below' && !(w.coins < below)) return false;
    if (b.exclude_debt && w.coins < 0) return false;
    if (cutoff) {
      const t = Date.parse(String(w.updated_at || '').replace(' ', 'T') + '+08:00');
      if (!Number.isFinite(t) || t < cutoff) return false;   // 太久沒動的帳號不發
    }
    if (b.exclude_exempt) {
      try { if (tax.isExempt(gid, w.user_id, guild && guild.members.cache.get(w.user_id))) return false; } catch {}
    }
    return true;
  }).map(w => ({ user_id: w.user_id, username: w.username || '', before: w.coins, amount }));
}

// 試算：不動錢，只回傳會發給幾個人、總共多少、財源夠不夠
router.post('/charity-relief-preview', (req, res) => {
  const b = req.body || {};
  const list = reliefTargets(req.guildId, b);
  const total = list.reduce((a, x) => a + x.amount, 0);
  const pool = guildConfig('charity_config', req.guildId).pool || 0;
  res.json({
    people: list.length, total, pool,
    enough: b.source === 'free' ? true : total <= pool,
    sample: list.slice(0, 15)
  });
});

router.post('/charity-relief', (req, res) => {
  const b = req.body || {};
  const gid = req.guildId;
  const list = reliefTargets(gid, b);
  if (!list.length) return res.status(400).json({ error: '沒有符合條件的玩家，普發沒有執行。' });
  const total = list.reduce((a, x) => a + x.amount, 0);
  const c = guildConfig('charity_config', gid);
  const fromPool = b.source !== 'free';
  if (fromPool && total > (c.pool || 0)) {
    return res.status(400).json({ error: `基金會餘額不足：要發 ${total.toLocaleString('en-US')}，池子裡只有 ${(c.pool || 0).toLocaleString('en-US')}。可以改用「直接增發」或降低金額。` });
  }

  const period = 'manual-' + new Date().toISOString().slice(0, 10);
  db.transaction(() => {
    for (const r of list) {
      db.prepare("UPDATE econ_wallets SET coins = coins + ?, updated_at = datetime('now','localtime') WHERE guild_id=? AND user_id=?")
        .run(r.amount, gid, r.user_id);
      db.prepare('INSERT INTO tax_reliefs (guild_id,period,user_id,username,before_coins,amount) VALUES (?,?,?,?,?,?)')
        .run(gid, period, r.user_id, r.username, r.before, r.amount);
    }
    if (fromPool) {
      db.prepare('UPDATE charity_config SET pool = pool - ?, total_out = total_out + ? WHERE guild_id=?').run(total, total, gid);
    }
    db.prepare('INSERT INTO charity_payouts (guild_id,period,amount,people) VALUES (?,?,?,?)')
      .run(gid, period, total, list.length);
  })();

  audit(req.user.name, `手動普發：每人 ${list[0].amount}，${list.length} 人，共 ${total}`, 'gather', '', gid);

  // 公告（發不出去不影響普發本身）
  const chan = String(b.channel || c.channel || '');
  if (chan) {
    (async () => {
      try {
        const ch = await bot.fetchChannel(chan);
        if (!ch) return;
        const gc = guildConfig('gather_config', gid);
        const coin = (n) => `${gc.currency_emoji || '🪙'} ${Number(n).toLocaleString('en-US')} ${gc.currency_name || '星幣'}`;
        await ch.send({
          embeds: [{
            color: 0x2ecc71,
            title: `💸 ${c.name || '慈善基金會'} 普發${b.reason ? '：' + String(b.reason).slice(0, 80) : ''}`,
            description: `**每人 ${coin(list[0].amount)}**，共 **${list.length}** 位玩家領到，總計 ${coin(total)}。\n`
              + (fromPool ? '財源來自基金會（大家捐的錢又回到大家身上）。' : '本次由系統直接增發。')
              + '\n\n用 `/錢包` 看看你的餘額。'
          }]
        });
      } catch {}
    })();
  }
  res.json({ ok: true, people: list.length, total });
});

module.exports = router;
