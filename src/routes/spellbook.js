// 咒語簿後台 API：功能開關、開通名單（誰能用）、使用概況。
//
// 這頁只管「誰可以用」與用量統計 —— 玩家寫在咒語簿裡的內容是私人的，
// 後台看得到則數，看不到內容（要幫忙除錯就請玩家自己截圖）。
const express = require('express');
const { db, audit } = require('../db');
const { requireAuth, guardModule } = require('../auth');
const sb = require('../spellbook');
const { PUBLIC_URL } = require('../util/url');

const router = express.Router();
router.use(requireAuth(), guardModule('spellbook'));

router.get('/spellbook', (req, res) => {
  const c = sb.config(req.guildId);
  res.json({ ...c, role_ids: String(c.role_ids || '').split(',').filter(Boolean) });
});

router.put('/spellbook', async (req, res) => {
  const out = sb.saveConfig(req.guildId, req.body || {});
  audit(req.user.name, `更新咒語簿設定（${out.enabled ? '啟用' : '停用'}）`, 'spellbook', '', req.guildId);
  // 「在 Discord 顯示指令」勾／取消要立刻生效：重新註冊那台伺服器的指令清單。
  // 只有扮演秘書的那個行程管得到（/咒語簿 是秘書的指令）。
  try {
    const { botRole } = require('../bot/roles');
    if (botRole() === 'secretary' || botRole() === 'both') await require('../bot').refreshGuildCommands(req.guildId);
  } catch (e) { console.error('重整指令清單失敗：', e.message); }
  res.json({ ok: true });
});

// 開通名單（附每個人的用量）
router.get('/spellbook/access', (req, res) => {
  res.json(sb.usageStats(req.guildId).map(r => ({ ...r, link: `${PUBLIC_URL}/spell/${token(req.guildId, r.user_id)}` })));
});

router.post('/spellbook/access', (req, res) => {
  const b = req.body || {};
  const uid = String(b.user_id || '').trim();
  if (!/^\d{5,25}$/.test(uid)) return res.status(400).json({ error: '請填正確的 Discord 使用者 ID（或用搜尋挑人）' });
  const row = sb.grant(req.guildId, uid, {
    username: b.username, note: b.note, days: Math.max(0, parseInt(b.days, 10) || 0), by: req.user.name
  });
  audit(req.user.name, `咒語簿開通 ${b.username || uid}${row.expires_at ? '（限期）' : ''}`, 'spellbook', '', req.guildId);
  res.json({ ...row, link: `${PUBLIC_URL}/spell/${token(req.guildId, uid)}` });
});

router.delete('/spellbook/access/:userId', (req, res) => {
  sb.revoke(req.guildId, req.params.userId);
  audit(req.user.name, `咒語簿取消開通 ${req.params.userId}`, 'spellbook', '', req.guildId);
  res.json({ ok: true });
});

// 清空某個人的咒語簿（他自己要求重來、或內容出問題時用）
router.delete('/spellbook/data/:userId', (req, res) => {
  const uid = req.params.userId;
  db.prepare('DELETE FROM spell_entries WHERE guild_id=? AND user_id=?').run(req.guildId, uid);
  db.prepare('DELETE FROM spell_folders WHERE guild_id=? AND user_id=?').run(req.guildId, uid);
  audit(req.user.name, `清空 ${uid} 的咒語簿內容`, 'spellbook', '', req.guildId);
  res.json({ ok: true });
});

const token = (gid, uid) => require('./spell').spellToken(gid, uid);

module.exports = router;
