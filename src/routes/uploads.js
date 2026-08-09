// 圖片 / 檔案上傳與媒體庫
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { db, audit } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// 允許的類型：圖片、影片、音訊、常見文件
const ALLOWED = /^(image\/|video\/|audio\/|application\/(pdf|zip|x-zip-compressed|msword|vnd\.|octet-stream)|text\/)/;

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().slice(0, 10);
    const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    cb(null, stamp + ext);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },   // 25MB（Discord 附件上限）
  fileFilter: (req, file, cb) => {
    if (!ALLOWED.test(file.mimetype)) return cb(new Error('不支援的檔案類型'));
    cb(null, true);
  }
});

function kindOf(mime) {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

// 單檔上傳
router.post('/upload', requireAuth(), (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message === 'File too large' ? '檔案超過 25MB 上限' : err.message });
    if (!req.file) return res.status(400).json({ error: '沒有收到檔案' });
    const f = req.file;
    // multer 的 originalname 是 latin1，中文檔名要轉回 UTF-8
    try { f.originalname = Buffer.from(f.originalname, 'latin1').toString('utf8'); } catch {}
    const url = '/uploads/' + f.filename;
    const info = db.prepare(
      `INSERT INTO uploads (filename, original, url, mime, size, kind, uploader, guild_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(f.filename, f.originalname, url, f.mimetype, f.size, kindOf(f.mimetype), req.user.name, req.guildId);
    audit(req.user.name, `上傳檔案：${f.originalname}`, 'uploads', `${url}（${Math.round(f.size / 1024)}KB）`);
    res.json({ id: info.lastInsertRowid, url, kind: kindOf(f.mimetype), original: f.originalname, size: f.size });
  });
});

// 媒體庫列表（只列出目前這台伺服器的）
router.get('/uploads', requireAuth(), (req, res) => {
  const kind = String(req.query.kind || '').trim();
  const stmt = db.prepare(
    `SELECT * FROM uploads WHERE guild_id = @g ${kind ? 'AND kind = @kind' : ''} ORDER BY id DESC LIMIT 300`
  );
  res.json(stmt.all({ g: req.guildId, kind }));
});

router.delete('/uploads/:id', requireAuth(), (req, res) => {
  const row = db.prepare('SELECT * FROM uploads WHERE id = ? AND guild_id = ?').get(req.params.id, req.guildId);
  if (!row) return res.status(404).json({ error: '找不到檔案' });
  try { fs.unlinkSync(path.join(UPLOAD_DIR, row.filename)); } catch {}
  db.prepare('DELETE FROM uploads WHERE id = ? AND guild_id = ?').run(req.params.id, req.guildId);
  audit(req.user.name, `刪除檔案：${row.original}`, 'uploads', row.url);
  res.json({ ok: true });
});

// ---- 自訂圖示 → Application Emoji（用於連結按鈕的圖標）----
const bot = require('../bot');

// 上傳一張圖，轉成 Discord 自訂表情，回傳按鈕可用的 markup
router.post('/emoji-upload', requireAuth(), (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: '沒有收到圖片' });
    if (!/^image\//.test(req.file.mimetype)) return res.status(400).json({ error: '請上傳圖片檔' });
    if (req.file.size > 256 * 1024) return res.status(400).json({ error: '圖示需小於 256KB（Discord 表情上限）' });
    if (!bot.uploadAppEmoji) return res.status(503).json({ error: '機器人尚未上線' });
    try {
      const fs2 = require('fs');
      const buf = fs2.readFileSync(req.file.path);
      const base = (req.file.originalname || 'icon').replace(/\.[^.]+$/, '');
      const e = await bot.uploadAppEmoji(buf, base);
      fs2.unlinkSync(req.file.path); // 圖示已存進 Discord，本機暫存可刪
      db.prepare('INSERT INTO custom_emojis (guild_id, emoji_id, name, url, markup, uploader) VALUES (?,?,?,?,?,?)')
        .run(req.guildId, e.id, e.name, e.url, e.markup, req.user.name);
      audit(req.user.name, `上傳自訂圖示：${e.name}`, 'emoji');
      res.json({ markup: e.markup, url: e.url, name: e.name });
    } catch (e) {
      res.status(500).json({ error: '建立自訂表情失敗：' + e.message + '（可能已達 2000 個上限，或圖片格式不符）' });
    }
  });
});

// 已上傳的自訂圖示清單（供重複使用；只列出目前這台伺服器上傳的）
router.get('/custom-emojis', requireAuth(), (req, res) => {
  res.json(db.prepare('SELECT * FROM custom_emojis WHERE guild_id = ? ORDER BY id DESC LIMIT 200').all(req.guildId));
});

module.exports = router;
module.exports.UPLOAD_DIR = UPLOAD_DIR;
