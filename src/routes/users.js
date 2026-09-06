const express = require('express');
const bcrypt = require('bcryptjs');
const { db, audit } = require('../db');
const { requireAuth, requireModule, allowedGuildsFor } = require('../auth');

const router = express.Router();
router.use(requireAuth());

// 修改自己的密碼（任何登入者皆可）
router.put('/me/password', (req, res) => {
  const { old_password, new_password } = req.body || {};
  if (!new_password || new_password.length < 6) return res.status(400).json({ error: '新密碼至少 6 碼' });
  if (!bcrypt.compareSync(old_password || '', req.user.password_hash))
    return res.status(400).json({ error: '原密碼錯誤' });
  db.prepare('UPDATE admin_users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(new_password, 10), req.user.id);
  audit(req.user.name, '修改自己的密碼');
  res.json({ ok: true });
});

// ---- 以下為帳號管理（需 users 模組）----
router.use(requireModule('users'));

router.get('/users', (req, res) => {
  res.json(db.prepare('SELECT id, username, name, role, permissions, guild_ids, active, created_at FROM admin_users ORDER BY id').all());
});


// 作者專用的隱藏鑰匙：只有總管理員能授出去。
// blacklist  — 不想讓客戶發現有這個功能
// appearance — 機器人的暱稱與頭像是自己的招牌，不開放客戶改
// 前端已經藏起這些勾，這裡再擋一層——直接打 API 也繞不過。
const OWNER_ONLY = ['blacklist', 'appearance'];
function sanitizePerms(actor, raw, keepFrom) {
  const list = (Array.isArray(raw) ? raw.join(',') : (raw || '')).split(',').map(s => s.trim()).filter(Boolean);
  if (actor.role === 'admin') return list.join(',');
  const had = String((keepFrom && keepFrom.permissions) || '').split(',');
  const out = list.filter(k => !OWNER_ONLY.includes(k));
  for (const k of OWNER_ONLY) if (had.includes(k)) out.push(k);   // 不刪掉對方原本就有的
  return out.join(',');
}

// 非總管理員在帳號頁只看得到「自己綁定的伺服器」，所以他送出的勾選清單
// 一定不含他看不到的那幾台。直接照單全收的話，別人綁好的伺服器會被清掉，
// 該帳號就掉回主伺服器 fallback ——等於把作者自己的伺服器暴露給客戶。
function sanitizeGuilds(actor, raw, keepFrom) {
  const list = (Array.isArray(raw) ? raw : String(raw || '').split(',')).map(s => String(s).trim()).filter(Boolean);
  if (actor.role === 'admin') return list.join(',');
  const visible = new Set(allowedGuildsFor(actor));
  const kept = String((keepFrom && keepFrom.guild_ids) || '').split(',').map(s => s.trim())
    .filter(g => g && !visible.has(g));            // 他看不到的，原樣保留
  return [...new Set([...kept, ...list.filter(g => visible.has(g))])].join(',');
}

router.post('/users', (req, res) => {
  const b = req.body || {};
  if (!b.username || !b.password) return res.status(400).json({ error: '請填帳號與密碼' });
  if (b.password.length < 6) return res.status(400).json({ error: '密碼至少 6 碼' });
  if (db.prepare('SELECT 1 FROM admin_users WHERE username=?').get(b.username))
    return res.status(400).json({ error: '帳號已存在' });
  const guildIds = sanitizeGuilds(req.user, b.guild_ids);
  const info = db.prepare(
    `INSERT INTO admin_users (username, password_hash, name, role, permissions, guild_ids, active) VALUES (?, ?, ?, ?, ?, ?, 1)`
  ).run(b.username, bcrypt.hashSync(b.password, 10), b.name || b.username, b.role === 'admin' ? 'admin' : 'staff',
    sanitizePerms(req.user, b.permissions), guildIds);
  audit(req.user.name, `新增後台帳號：${b.username}`);
  res.json({ id: info.lastInsertRowid });
});

router.put('/users/:id', (req, res) => {
  const b = req.body || {};
  const id = parseInt(req.params.id);
  const target = db.prepare('SELECT * FROM admin_users WHERE id=?').get(id);
  if (!target) return res.status(404).json({ error: '找不到帳號' });
  const perms = sanitizePerms(req.user, b.permissions, target);
  const guildIds = sanitizeGuilds(req.user, b.guild_ids, target);
  db.prepare('UPDATE admin_users SET name=?, role=?, permissions=?, guild_ids=?, active=? WHERE id=?')
    .run(b.name || target.name, b.role === 'admin' ? 'admin' : 'staff', perms, guildIds, b.active ? 1 : 0, id);
  if (b.password) {
    if (b.password.length < 6) return res.status(400).json({ error: '密碼至少 6 碼' });
    db.prepare('UPDATE admin_users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(b.password, 10), id);
  }
  audit(req.user.name, `修改後台帳號 #${id}`);
  res.json({ ok: true });
});

router.delete('/users/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: '不能刪除自己' });
  db.prepare('DELETE FROM admin_users WHERE id=?').run(id);
  audit(req.user.name, `刪除後台帳號 #${id}`);
  res.json({ ok: true });
});

module.exports = router;
