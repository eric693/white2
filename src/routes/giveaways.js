const express = require('express');
const { db, audit } = require('../db');
const { requireAuth, requireModule, guardModule } = require('../auth');
const { nowUnix } = require('../util/time');
const bot = require('../bot');

const router = express.Router();
router.use(requireAuth(), guardModule('giveaways'));

const csv = (s) => String(s || '').split(',').map(x => x.trim()).filter(Boolean);

// 確認網址上的抽獎 id 真的屬於目前這台伺服器（避免切換伺服器後對別台的抽獎動作）
const owns = (req, res) => {
  const g = db.prepare('SELECT id FROM giveaways WHERE id=? AND guild_id=?').get(req.params.id, req.guildId);
  if (!g) { res.status(404).json({ error: '找不到抽獎' }); return false; }
  return true;
};

router.get('/giveaways', (req, res) => {
  const list = db.prepare('SELECT * FROM giveaways WHERE guild_id = ? ORDER BY id DESC').all(req.guildId);
  for (const g of list) {
    g.entries = db.prepare('SELECT COUNT(*) c FROM giveaway_entries WHERE giveaway_id=?').get(g.id).c;
    try { g.winner_list = JSON.parse(g.winner_ids); } catch { g.winner_list = []; }
    g.guaranteed_list = csv(g.guaranteed_ids);
  }
  res.json(list);
});

// 抽獎明細：參加者、得獎者、操作紀錄
router.get('/giveaways/:id/detail', (req, res) => {
  const ga = db.prepare('SELECT * FROM giveaways WHERE id=? AND guild_id=?').get(req.params.id, req.guildId);
  if (!ga) return res.status(404).json({ error: '找不到抽獎' });
  const entries = db.prepare('SELECT * FROM giveaway_entries WHERE giveaway_id=?').all(ga.id);
  const wins = db.prepare('SELECT * FROM win_records WHERE giveaway_id=? ORDER BY won_at DESC').all(ga.id);
  let winner_list = []; try { winner_list = JSON.parse(ga.winner_ids); } catch {}
  res.json({ ga, entries, wins, winner_list, guaranteed_list: csv(ga.guaranteed_ids) });
});

// 全站中獎紀錄 + 目前 12 小時鎖定名單
router.get('/win-records', (req, res) => {
  const recent = db.prepare('SELECT * FROM win_records WHERE guild_id=? AND revoked=0 ORDER BY won_at DESC LIMIT 200').all(req.guildId);
  // 鎖定名單以 hours 參數計算（預設 12 小時），讓後台可以用不同時數檢視
  const hours = Math.max(1, Math.min(720, parseInt(req.query.hours) || 12));
  const locked = db.prepare('SELECT DISTINCT user_id, username FROM win_records WHERE guild_id=? AND revoked=0 AND won_at > ?')
    .all(req.guildId, nowUnix() - hours * 3600);
  res.json({ recent, locked, hours });
});

router.post('/giveaways', async (req, res) => {
  const b = req.body || {};
  if (!b.prize) return res.status(400).json({ error: '請填寫獎品內容' });
  if (!b.channel_id) return res.status(400).json({ error: '請選擇發送頻道' });
  const winners = parseInt(b.winners) || 1;
  const guaranteed = csv(Array.isArray(b.guaranteed_ids) ? b.guaranteed_ids.join(',') : b.guaranteed_ids);
  // 1.3 指定中獎人數超過名額 → 擋下
  if (guaranteed.length > winners)
    return res.status(400).json({ error: `保證中獎人數（${guaranteed.length}）超過得獎名額（${winners}），請調整。` });
  // 黑名單絕對優先：保證中獎者不得在黑名單
  // 只算「有效且涵蓋抽獎」的黑名單：已解除(active=0)、已到期、或只封鎖其他功能的都不該擋
  const { blacklisted } = require('../bot/perm');
  const blocked = guaranteed.filter(uid => blacklisted(req.guildId, uid, 'giveaways'));
  if (blocked.length) return res.status(400).json({ error: `保證中獎名單中有黑名單玩家（${blocked.join(', ')}），請先移除。` });

  // 持續時間（如 30s / 5m / 2h）→ 秒級倒數，優先於指定結束時間
  let endUnix = 0;
  if (b.duration && String(b.duration).trim()) {
    const { parseDuration } = require('../bot/features/giveaway');
    const sec = parseDuration(b.duration);
    if (sec == null) return res.status(400).json({ error: '持續時間格式不對（例如 30s、5m、2h；最低 1 秒、最高 24 小時）' });
    endUnix = nowUnix() + sec;
  }

  // 重複中獎限制（小時）：空＝預設 12；0＝不限制
  const lockHours = b.win_lock_hours == null || b.win_lock_hours === '' ? 12 : Math.max(0, Math.min(720, parseInt(b.win_lock_hours) || 0));

  const started = b.start_at && !endUnix ? 0 : 1;
  const mentionRoles = csv(Array.isArray(b.mention_roles) ? b.mention_roles.join(',') : b.mention_roles).join(',');
  const info = db.prepare(
    `INSERT INTO giveaways (guild_id, title, description, prize, winners, guaranteed_ids, channel_id, start_at, deadline, end_unix, started, creator, thumb, void_if_insufficient, mention_roles, win_lock_hours)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(req.guildId, b.title || '', b.description || '', b.prize, winners, guaranteed.join(','), b.channel_id,
    endUnix ? '' : (b.start_at || ''), endUnix ? '' : (b.deadline || ''), endUnix, started, req.user.name, b.thumb || '', b.void_if_insufficient ? 1 : 0, mentionRoles, lockHours);
  const ga = db.prepare('SELECT * FROM giveaways WHERE id=?').get(info.lastInsertRowid);
  if (!bot.client._postGiveaway) return res.status(503).json({ error: '機器人尚未上線' });
  try { await bot.client._postGiveaway(ga); }
  catch (e) { return res.status(500).json({ error: e.message }); }
  audit(req.user.name, `建立抽獎：${b.prize}`);
  res.json({ id: ga.id });
});

// 調整這場抽獎的重複中獎限制（開獎前後都可改；改完再重抽就會套用新設定）
router.post('/giveaways/:id/win-lock', (req, res) => {
  if (!owns(req, res)) return;
  const raw = req.body && req.body.hours;
  if (raw == null || raw === '') return res.status(400).json({ error: '缺少 hours' });
  const hours = Math.max(0, Math.min(720, parseInt(raw) || 0));
  db.prepare('UPDATE giveaways SET win_lock_hours=? WHERE id=? AND guild_id=?').run(hours, req.params.id, req.guildId);
  audit(req.user.name, `調整抽獎 #${req.params.id} 重複中獎限制：${hours ? hours + ' 小時' : '不限制'}`);
  res.json({ ok: true, hours });
});

// 立即開獎
router.post('/giveaways/:id/draw', async (req, res) => {
  if (!owns(req, res)) return;
  if (!bot.client._endGiveaway) return res.status(503).json({ error: '機器人尚未上線' });
  const winners = await bot.client._endGiveaway(req.params.id);
  audit(req.user.name, `開獎 #${req.params.id}`);
  res.json({ winners });
});

// 重新抽獎
router.post('/giveaways/:id/reroll', async (req, res) => {
  if (!owns(req, res)) return;
  if (!bot.client._rerollGiveaway) return res.status(503).json({ error: '機器人尚未上線' });
  const winners = await bot.client._rerollGiveaway(req.params.id);
  audit(req.user.name, `重抽 #${req.params.id}`);
  res.json({ winners });
});

// 補抽
router.post('/giveaways/:id/supplement', async (req, res) => {
  if (!owns(req, res)) return;
  const n = parseInt(req.body && req.body.count) || 1;
  if (!bot.client._supplementGiveaway) return res.status(503).json({ error: '機器人尚未上線' });
  const extra = await bot.client._supplementGiveaway(req.params.id, n);
  audit(req.user.name, `補抽 #${req.params.id}（${extra.length} 位）`);
  res.json({ winners: extra });
});

// 取消整場抽獎（不開獎作廢）
router.post('/giveaways/:id/cancel', async (req, res) => {
  const g = db.prepare('SELECT id FROM giveaways WHERE id=? AND guild_id=?').get(req.params.id, req.guildId);
  if (!g) return res.status(404).json({ error: '找不到抽獎' });
  if (!bot.client._cancelGiveaway) return res.status(503).json({ error: '機器人尚未上線' });
  const r = await bot.client._cancelGiveaway(req.params.id);
  if (!r.ok) return res.status(400).json({ error: r.reason });
  audit(req.user.name, `取消抽獎 #${req.params.id}`);
  res.json({ ok: true });
});

// 取消得獎資格
router.post('/giveaways/:id/revoke', async (req, res) => {
  if (!owns(req, res)) return;
  const uid = req.body && req.body.user_id;
  if (!uid) return res.status(400).json({ error: '缺少 user_id' });
  if (!bot.client._revokeWinner) return res.status(503).json({ error: '機器人尚未上線' });
  await bot.client._revokeWinner(req.params.id, uid);
  audit(req.user.name, `取消得獎資格 #${req.params.id} / ${uid}`);
  res.json({ ok: true });
});

router.delete('/giveaways/:id', (req, res) => {
  // 先確認這場抽獎屬於目前這台伺服器，否則連帶刪除會清掉別台的參加者/得獎紀錄
  const g = db.prepare('SELECT id FROM giveaways WHERE id=? AND guild_id=?').get(req.params.id, req.guildId);
  if (!g) return res.status(404).json({ error: '找不到抽獎' });
  db.prepare('DELETE FROM giveaways WHERE id=? AND guild_id=?').run(req.params.id, req.guildId);
  db.prepare('DELETE FROM giveaway_entries WHERE giveaway_id=? AND guild_id=?').run(req.params.id, req.guildId);
  db.prepare('DELETE FROM win_records WHERE giveaway_id=? AND guild_id=?').run(req.params.id, req.guildId);
  audit(req.user.name, `刪除抽獎 #${req.params.id}`);
  res.json({ ok: true });
});

module.exports = router;
