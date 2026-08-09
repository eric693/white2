const express = require('express');
const bcrypt = require('bcryptjs');
const { db, audit } = require('../db');
const { requireAuth, requireModule } = require('../auth');

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

router.post('/users', (req, res) => {
  const b = req.body || {};
  if (!b.username || !b.password) return res.status(400).json({ error: '請填帳號與密碼' });
  if (b.password.length < 6) return res.status(400).json({ error: '密碼至少 6 碼' });
  if (db.prepare('SELECT 1 FROM admin_users WHERE username=?').get(b.username))
    return res.status(400).json({ error: '帳號已存在' });
  const guildIds = Array.isArray(b.guild_ids) ? b.guild_ids.join(',') : (b.guild_ids || '');
  const info = db.prepare(
    `INSERT INTO admin_users (username, password_hash, name, role, permissions, guild_ids, active) VALUES (?, ?, ?, ?, ?, ?, 1)`
  ).run(b.username, bcrypt.hashSync(b.password, 10), b.name || b.username, b.role === 'admin' ? 'admin' : 'staff',
    Array.isArray(b.permissions) ? b.permissions.join(',') : (b.permissions || ''), guildIds);
  audit(req.user.name, `新增後台帳號：${b.username}`);
  res.json({ id: info.lastInsertRowid });
});

router.put('/users/:id', (req, res) => {
  const b = req.body || {};
  const id = parseInt(req.params.id);
  const target = db.prepare('SELECT * FROM admin_users WHERE id=?').get(id);
  if (!target) return res.status(404).json({ error: '找不到帳號' });
  const perms = Array.isArray(b.permissions) ? b.permissions.join(',') : (b.permissions || '');
  const guildIds = Array.isArray(b.guild_ids) ? b.guild_ids.join(',') : (b.guild_ids || '');
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
