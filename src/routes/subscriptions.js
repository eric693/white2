// 管理員後台：訂閱方案與各伺服器訂閱狀態。
// 兩隻機器人（秘書／管家）各自一份訂閱，同一台伺服器可以只訂其中一隻。
const express = require('express');
const { db, audit } = require('../db');
const { requireAuth, requireModule } = require('../auth');
const sub = require('../subscription');
const bot = require('../bot');

const router = express.Router();
router.use(requireAuth());

const ROLES = ['secretary', 'butler'];
const okRole = (r) => ROLES.includes(String(r));

// 可用的功能鍵（後台勾選方案內容用）
router.get('/subscriptions/features', requireModule('system'), (req, res) => {
  res.json(sub.FEATURE_KEYS);
});

// ---- 方案 ----
router.get('/subscriptions/plans', requireModule('system'), (req, res) => {
  // active_only=1 → 只列還在販售的方案（指定／續訂的下拉用）
  res.json(sub.listPlans(okRole(req.query.role) ? req.query.role : null,
    { activeOnly: String(req.query.active_only || '') === '1' }));
});

router.post('/subscriptions/plans', requireModule('system'), (req, res) => {
  const { role, code, name, price_month, price_year, features, sort, active } = req.body || {};
  if (!okRole(role) || !code) return res.status(400).json({ error: '請提供 role（secretary/butler）與 code' });
  db.prepare(`INSERT INTO plans (code, role, name, price_month, price_year, features, sort, active)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(role, code) DO UPDATE SET
                name=excluded.name, price_month=excluded.price_month, price_year=excluded.price_year,
                features=excluded.features, sort=excluded.sort, active=excluded.active`)
    .run(code, role, String(name || code), Number(price_month) || 0, Number(price_year) || 0,
         Array.isArray(features) ? features.join(',') : String(features || ''),
         Number(sort) || 0, active === false ? 0 : 1);
  audit(req.user?.name, `儲存訂閱方案 ${role}/${code}`, 'subscriptions', '', req.guildId);
  res.json(sub.getPlan(role, code));
});

router.delete('/subscriptions/plans/:role/:code', requireModule('system'), (req, res) => {
  const { role, code } = req.params;
  if (!okRole(role)) return res.status(400).json({ error: 'role 不正確' });
  if (code === 'free') return res.status(400).json({ error: '免費版是到期後的退場方案，不能刪除' });
  db.prepare('DELETE FROM plans WHERE role = ? AND code = ?').run(role, code);
  // 用到這個方案的伺服器退回免費版，避免變成查不到方案的孤兒狀態
  db.prepare("UPDATE guild_subscriptions SET plan_code='free' WHERE role = ? AND plan_code = ?").run(role, code);
  audit(req.user?.name, `刪除訂閱方案 ${role}/${code}`, 'subscriptions', '', req.guildId);
  res.json({ ok: true });
});

// ---- 各伺服器訂閱狀態 ----
router.get('/subscriptions', requireModule('system'), (req, res) => {
  const guilds = db.prepare('SELECT guild_id, name, icon, active FROM guilds ORDER BY name').all();
  res.json(guilds.map(g => ({
    ...g,
    secretary: sub.getSubscription(g.guild_id, 'secretary'),
    butler: sub.getSubscription(g.guild_id, 'butler')
  })));
});

router.get('/subscriptions/:guildId/:role', requireModule('system'), (req, res) => {
  const { guildId, role } = req.params;
  if (!okRole(role)) return res.status(400).json({ error: 'role 不正確' });
  res.json(sub.getSubscription(guildId, role));
});

// 續費／開通：cycle=month|year，units=幾期；從現有到期日往後接
router.post('/subscriptions/:guildId/:role/extend', requireModule('system'), async (req, res) => {
  const { guildId, role } = req.params;
  if (!okRole(role)) return res.status(400).json({ error: 'role 不正確' });
  const { plan_code, cycle, units, note } = req.body || {};
  // 停用的方案不能再賣給新的伺服器；已經在用的伺服器不受影響（他們付過錢了）
  if (plan_code && plan_code !== 'free' && !sub.planSellable(role, plan_code)) {
    return res.status(400).json({ error: `方案「${plan_code}」已停用或不存在，無法指定` });
  }
  const out = sub.extendSubscription(guildId, role, plan_code || 'free', cycle === 'year' ? 'year' : 'month', units, note || '');
  audit(req.user?.name, `續訂 ${role}：${plan_code}（${units || 1} 期）`, 'subscriptions', '', guildId);
  await refresh(role, guildId);
  res.json(out);
});

// 直接指定方案與到期日（expires_at 傳 0 ＝永久開通）
router.post('/subscriptions/:guildId/:role', requireModule('system'), async (req, res) => {
  const { guildId, role } = req.params;
  if (!okRole(role)) return res.status(400).json({ error: 'role 不正確' });
  const { plan_code, expires_at, note } = req.body || {};
  if (plan_code && plan_code !== 'free' && !sub.planSellable(role, plan_code)) {
    return res.status(400).json({ error: `方案「${plan_code}」已停用或不存在，無法指定` });
  }
  const out = sub.setSubscription(guildId, role, plan_code || 'free', Number(expires_at) || 0, note || '');
  audit(req.user?.name, `設定 ${role} 訂閱為 ${plan_code}`, 'subscriptions', '', guildId);
  await refresh(role, guildId);
  res.json(out);
});

// 訂閱一改，指令清單就要跟著變（付費指令會出現／消失）。
// 只有「扮演該角色的那個行程」才需要重整；另一隻不理會。
async function refresh(role, guildId) {
  try {
    const { botRole } = require('../bot/roles');
    if (botRole() === role || botRole() === 'both') await bot.refreshGuildCommands(guildId);
  } catch (e) { console.error('重整指令清單失敗：', e.message); }
}

module.exports = router;
