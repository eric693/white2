// 角色推薦轉盤 API（規格 8.1～8.16）
const express = require('express');
const { db, audit } = require('../db');
const { requireAuth, requireModule, guardModule } = require('../auth');
const bot = require('../bot');

const router = express.Router();
router.use(requireAuth(), guardModule('wheels'));

const csvField = (v) => Array.isArray(v) ? v.join(',') : String(v || '');

// 轉盤列表（含角色）
// 確認網址上的轉盤 id 屬於目前這台伺服器
const ownsWheel = (req, res) => {
  const w = db.prepare('SELECT id FROM role_wheels WHERE id=? AND guild_id=?').get(req.params.id, req.guildId);
  if (!w) { res.status(404).json({ error: '找不到轉盤' }); return false; }
  return true;
};

router.get('/wheels', (req, res) => {
  const wheels = db.prepare('SELECT * FROM role_wheels WHERE guild_id = ? ORDER BY id').all(req.guildId);
  for (const w of wheels) {
    w.roles = db.prepare('SELECT * FROM wheel_roles WHERE wheel_id=? ORDER BY sort, id').all(w.id);
  }
  res.json(wheels);
});

function wheelFields(b) {
  return {
    name: b.name || '', description: b.description || '', image_url: b.image_url || '',
    tags: csvField(b.tags), enabled: b.enabled ? 1 : 0, listed: b.listed ? 1 : 0,
    daily_limit: parseInt(b.daily_limit, 10) || 0,
    no_repeat: b.no_repeat ? 1 : 0, exclude_chatted: b.exclude_chatted ? 1 : 0,
    card_enabled: b.card_enabled ? 1 : 0, card_bg: b.card_bg || '',
    card_sign: b.card_sign ? 1 : 0, card_date: b.card_date ? 1 : 0,
    start_at: b.start_at || '', end_at: b.end_at || '',
    // 逛街／偶遇時角色會說的話：填幾句就隨機講哪一句（都留空＝不講話，只顯示介紹）
    ad_line: String(b.ad_line || '').slice(0, 200),
    ad_line2: String(b.ad_line2 || '').slice(0, 200),
    ad_line3: String(b.ad_line3 || '').slice(0, 200)
  };
}

// 8.1 建立轉盤（數量不設上限）
router.post('/wheels', (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: '請填寫轉盤名稱' });
  const info = db.prepare(
    `INSERT INTO role_wheels (guild_id, name, description, image_url, tags, enabled, listed, daily_limit,
       no_repeat, exclude_chatted, card_enabled, card_bg, card_sign, card_date, start_at, end_at)
     VALUES (@guild_id,@name,@description,@image_url,@tags,@enabled,@listed,@daily_limit,
       @no_repeat,@exclude_chatted,@card_enabled,@card_bg,@card_sign,@card_date,@start_at,@end_at)`
  ).run({ ...wheelFields(b), guild_id: req.guildId });
  audit(req.user.name, `新增轉盤：${b.name}`);
  res.json({ id: info.lastInsertRowid });
});

router.put('/wheels/:id', (req, res) => {
  db.prepare(
    `UPDATE role_wheels SET name=@name, description=@description, image_url=@image_url, tags=@tags,
       enabled=@enabled, listed=@listed, daily_limit=@daily_limit, no_repeat=@no_repeat,
       exclude_chatted=@exclude_chatted, card_enabled=@card_enabled, card_bg=@card_bg, card_sign=@card_sign, card_date=@card_date,
       start_at=@start_at, end_at=@end_at, ad_line=@ad_line, ad_line2=@ad_line2, ad_line3=@ad_line3
     WHERE id=@id AND guild_id=@guild_id`
  ).run({ ...wheelFields(req.body || {}), id: req.params.id, guild_id: req.guildId });
  audit(req.user.name, `修改轉盤 #${req.params.id}`);
  res.json({ ok: true });
});

// 8.16 上架 / 下架（資料完整保留）
router.put('/wheels/:id/listed', (req, res) => {
  const listed = req.body && req.body.listed ? 1 : 0;
  db.prepare('UPDATE role_wheels SET listed=? WHERE id=? AND guild_id=?').run(listed, req.params.id, req.guildId);
  audit(req.user.name, `${listed ? '上架' : '下架'}轉盤 #${req.params.id}`);
  res.json({ ok: true });
});

router.delete('/wheels/:id', (req, res) => {
  db.prepare('DELETE FROM wheel_roles WHERE wheel_id=? AND guild_id=?').run(req.params.id, req.guildId);
  db.prepare('DELETE FROM role_wheels WHERE id=? AND guild_id=?').run(req.params.id, req.guildId);
  db.prepare('DELETE FROM wheel_draws WHERE wheel_id=? AND guild_id=?').run(req.params.id, req.guildId);
  db.prepare('DELETE FROM wheel_chats WHERE wheel_id=? AND guild_id=?').run(req.params.id, req.guildId);
  db.prepare('DELETE FROM wheel_rounds WHERE wheel_id=? AND guild_id=?').run(req.params.id, req.guildId);
  audit(req.user.name, `刪除轉盤 #${req.params.id}`);
  res.json({ ok: true });
});

// ---- 8.2 轉盤內的角色 ----
function roleFields(b) {
  return {
    name: b.name || '', image_url: b.image_url || '', intro: b.intro || '',
    chat_link: b.chat_link || '', sort: parseInt(b.sort, 10) || 0,
    author: b.author || '', links: b.links || '[]', tags: csvField(b.tags),
    weight: Math.max(1, parseInt(b.weight, 10) || 1), enabled: b.enabled ? 1 : 0,
    start_at: b.start_at || '', end_at: b.end_at || '',
    // 逛街／偶遇時角色會說的話：填幾句就隨機講哪一句（都留空＝不講話，只顯示介紹）
    ad_line: String(b.ad_line || '').slice(0, 200),
    ad_line2: String(b.ad_line2 || '').slice(0, 200),
    ad_line3: String(b.ad_line3 || '').slice(0, 200)
  };
}

router.post('/wheels/:id/roles', (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: '請填寫角色名稱' });
  if (!ownsWheel(req, res)) return;
  const info = db.prepare(
    `INSERT INTO wheel_roles (guild_id, wheel_id, name, image_url, intro, chat_link, sort, author, links,
       tags, weight, enabled, start_at, end_at, ad_line, ad_line2, ad_line3)
     VALUES (@guild_id,@wheel_id,@name,@image_url,@intro,@chat_link,@sort,@author,@links,
       @tags,@weight,@enabled,@start_at,@end_at,@ad_line,@ad_line2,@ad_line3)`
  ).run({ ...roleFields(b), wheel_id: req.params.id, guild_id: req.guildId });
  audit(req.user.name, `轉盤 #${req.params.id} 新增角色：${b.name}`);
  res.json({ id: info.lastInsertRowid });
});

router.put('/wheel-roles/:roleId', (req, res) => {
  db.prepare(
    `UPDATE wheel_roles SET name=@name, image_url=@image_url, intro=@intro, chat_link=@chat_link,
       sort=@sort, author=@author, links=@links, tags=@tags, weight=@weight, enabled=@enabled,
       start_at=@start_at, end_at=@end_at, ad_line=@ad_line, ad_line2=@ad_line2, ad_line3=@ad_line3
     WHERE id=@id AND guild_id=@guild_id`
  ).run({ ...roleFields(req.body || {}), id: req.params.roleId, guild_id: req.guildId });
  audit(req.user.name, `修改轉盤角色 #${req.params.roleId}`);
  res.json({ ok: true });
});

// 8.2 移動角色到其他轉盤
router.put('/wheel-roles/:roleId/move', (req, res) => {
  const wheelId = req.body && req.body.wheel_id;
  if (!wheelId) return res.status(400).json({ error: '請選擇目標轉盤' });
  // 目標轉盤也必須是自己這台的，否則會把角色搬去別台伺服器
  const target = db.prepare('SELECT id FROM role_wheels WHERE id=? AND guild_id=?').get(wheelId, req.guildId);
  if (!target) return res.status(404).json({ error: '找不到目標轉盤' });
  db.prepare('UPDATE wheel_roles SET wheel_id=? WHERE id=? AND guild_id=?').run(wheelId, req.params.roleId, req.guildId);
  audit(req.user.name, `移動角色 #${req.params.roleId} 至轉盤 #${wheelId}`);
  res.json({ ok: true });
});

router.delete('/wheel-roles/:roleId', (req, res) => {
  db.prepare('DELETE FROM wheel_roles WHERE id=? AND guild_id=?').run(req.params.roleId, req.guildId);
  db.prepare('DELETE FROM wheel_favorites WHERE role_id=? AND guild_id=?').run(req.params.roleId, req.guildId);
  db.prepare('DELETE FROM wheel_chats WHERE role_id=? AND guild_id=?').run(req.params.roleId, req.guildId);
  audit(req.user.name, `刪除轉盤角色 #${req.params.roleId}`);
  res.json({ ok: true });
});

// ---- 8.3 分類標籤 ----
router.get('/wheel-tags', (req, res) => {
  res.json(db.prepare('SELECT * FROM wheel_tags WHERE guild_id = ? ORDER BY id').all(req.guildId));
});
router.post('/wheel-tags', (req, res) => {
  const name = (req.body && req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: '請填寫標籤名稱' });
  try {
    const info = db.prepare('INSERT INTO wheel_tags (guild_id, name) VALUES (?, ?)').run(req.guildId, name);
    audit(req.user.name, `新增角色標籤：${name}`);
    res.json({ id: info.lastInsertRowid });
  } catch { res.status(400).json({ error: '此標籤已存在' }); }
});
router.put('/wheel-tags/:id', (req, res) => {
  const name = (req.body && req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: '請填寫標籤名稱' });
  db.prepare('UPDATE wheel_tags SET name=? WHERE id=? AND guild_id=?').run(name, req.params.id, req.guildId);
  audit(req.user.name, `修改角色標籤 #${req.params.id}`);
  res.json({ ok: true });
});
router.delete('/wheel-tags/:id', (req, res) => {
  db.prepare('DELETE FROM wheel_tags WHERE id=? AND guild_id=?').run(req.params.id, req.guildId);
  audit(req.user.name, `刪除角色標籤 #${req.params.id}`);
  res.json({ ok: true });
});

// ---- 8.13 熱門角色統計 ----
router.get('/wheel-stats', (req, res) => {
  res.json({
    roles: db.prepare(
      `SELECT r.id, r.name, r.draw_count, r.fav_count, r.click_count, w.name AS wheel_name
         FROM wheel_roles r JOIN role_wheels w ON w.id = r.wheel_id
        WHERE w.guild_id = ? ORDER BY r.draw_count DESC, r.fav_count DESC LIMIT 100`
    ).all(req.guildId),
    totals: db.prepare(
      `SELECT (SELECT COUNT(*) FROM wheel_draws WHERE guild_id=@g) AS draws,
              (SELECT COUNT(*) FROM wheel_favorites WHERE guild_id=@g) AS favs,
              (SELECT COUNT(*) FROM wheel_chats WHERE guild_id=@g) AS chats,
              (SELECT COUNT(DISTINCT user_id) FROM wheel_draws WHERE guild_id=@g) AS users`
    ).get({ g: req.guildId })
  });
});

// 8.8 抽取紀錄（後台查詢）
router.get('/wheel-draws', (req, res) => {
  const kw = String(req.query.q || '').trim();
  const stmt = db.prepare(
    `SELECT d.*, r.name AS role_name, w.name AS wheel_name FROM wheel_draws d
       LEFT JOIN wheel_roles r ON r.id = d.role_id
       LEFT JOIN role_wheels w ON w.id = d.wheel_id
      WHERE d.guild_id = @g ${kw ? 'AND (d.user_id LIKE @k OR d.username LIKE @k)' : ''}
      ORDER BY d.id DESC LIMIT 300`
  );
  res.json(kw ? stmt.all({ g: req.guildId, k: `%${kw}%` }) : stmt.all({ g: req.guildId }));
});

// 重置某位玩家在某轉盤的抽取/體驗紀錄
router.delete('/wheel-draws/:wheelId/:userId', (req, res) => {
  const { wheelId, userId } = req.params;
  db.prepare('DELETE FROM wheel_draws WHERE wheel_id=? AND user_id=? AND guild_id=?').run(wheelId, userId, req.guildId);
  db.prepare('DELETE FROM wheel_chats WHERE wheel_id=? AND user_id=? AND guild_id=?').run(wheelId, userId, req.guildId);
  db.prepare('DELETE FROM wheel_rounds WHERE wheel_id=? AND user_id=? AND guild_id=?').run(wheelId, userId, req.guildId);
  audit(req.user.name, `重置玩家 ${userId} 在轉盤 #${wheelId} 的紀錄`);
  res.json({ ok: true });
});

// 發布轉盤面板到頻道
router.post('/wheels/:id/post', async (req, res) => {
  const chId = req.body && req.body.channel_id;
  if (!chId) return res.status(400).json({ error: '請選擇頻道' });
  if (!ownsWheel(req, res)) return;
  if (!bot.client._postWheel) return res.status(503).json({ error: '機器人尚未上線' });
  try { await bot.client._postWheel(req.params.id, chId); audit(req.user.name, `發布轉盤 #${req.params.id}`); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// 8.4 發布標籤篩選面板
router.post('/wheels/filter-panel', async (req, res) => {
  const chId = req.body && req.body.channel_id;
  if (!chId) return res.status(400).json({ error: '請選擇頻道' });
  if (!bot.client._postWheelFilter) return res.status(503).json({ error: '機器人尚未上線' });
  try { await bot.client._postWheelFilter(chId); audit(req.user.name, '發布標籤篩選面板'); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// 角色小卡預覽（用目前表單設定即時產生）
router.get('/rolecard-preview', async (req, res) => {
  const { makeRoleCard } = require('../util/rolecard');
  try {
    const buf = await makeRoleCard({
      imageUrl: req.query.img || '',
      bgUrl: req.query.bg || '',
      name: req.query.name || '角色名稱',
      subtitle: req.query.author || '',
      tagline: req.query.intro || '',
      // by＝顯示名字、d=1＝顯示日期，各自獨立（前端照開關決定要不要帶）
      drawnBy: req.query.by || '',
      date: req.query.d ? require('../util/time').localToday() : ''
    });
    res.set('Content-Type', 'image/png').set('Cache-Control', 'no-store').send(buf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
