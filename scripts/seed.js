// 建立初始管理員帳號：npm run seed
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { db } = require('../src/db');

const username = process.env.ADMIN_USERNAME || 'admin';
const password = process.env.ADMIN_PASSWORD || 'change-me-please';

const existing = db.prepare('SELECT id FROM admin_users WHERE username = ?').get(username);
const hash = bcrypt.hashSync(password, 10);

if (existing) {
  db.prepare('UPDATE admin_users SET password_hash = ?, active = 1 WHERE id = ?').run(hash, existing.id);
  console.log(`✅ 已更新管理員「${username}」的密碼。`);
} else {
  db.prepare(
    "INSERT INTO admin_users (username, password_hash, name, role) VALUES (?, ?, '總管理員', 'admin')"
  ).run(username, hash);
  console.log(`✅ 已建立管理員帳號「${username}」。`);
}
console.log('   登入後請立刻到「帳號權限」修改密碼。');
process.exit(0);
