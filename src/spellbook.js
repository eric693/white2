// 咒語簿：玩家自己的「常用台詞剪貼庫」。
//
// 用途（起源）：角色扮演／台詞很長的伺服器，常常要重複貼同一段話。
// 手機上做法就是「開咒語簿 → 點一下複製 → 切回 Discord 貼上」——
// iOS 沒辦法讓網頁在 Discord 的打字框裡跳出來（那要做系統鍵盤擴充），
// 所以這裡做成同站的 PWA（/spell/:token），加到主畫面後切換一下就好。
//
// 權限：**不是人人都有**。要嘛後台把人加進開通名單，要嘛他身上有白名單身分組，
// 兩者皆無就打不開（連結被轉傳也沒用，因為要本人 Discord 登入）。
const crypto = require('crypto');
const { db, guildConfig, ensureColumns } = require('./db');
const { nowUnix } = require('./util/time');

const int = (v, d = 0, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};
const csv = (s) => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
const now = () => nowUnix();

// 舊資料庫補欄位（show_command 是後來才加的）
ensureColumns('spell_config', { show_command: 'INTEGER NOT NULL DEFAULT 0' });

// ---- 設定 ----
function config(gid) { return guildConfig('spell_config', gid) || {}; }

/** 這台伺服器要不要把 /咒語簿 指令註冊上去。
 *  預設「不要」——功能開了也只有拿到連結的人知道有這回事，別人的指令列不會多出一個。 */
function commandVisible(gid) {
  const c = config(gid);
  return !!(c.enabled && c.show_command);
}

function saveConfig(gid, b = {}) {
  config(gid);   // 確保有那一列
  db.prepare(`UPDATE spell_config SET enabled=@enabled, role_ids=@role_ids, max_folders=@max_folders,
      max_entries=@max_entries, max_len=@max_len, share_enabled=@share_enabled, notice=@notice,
      show_command=@show_command
    WHERE guild_id=@guild_id`).run({
    enabled: b.enabled ? 1 : 0,
    role_ids: Array.isArray(b.role_ids) ? b.role_ids.join(',') : String(b.role_ids || ''),
    max_folders: int(b.max_folders, 30, 1, 500),
    max_entries: int(b.max_entries, 200, 1, 2000),
    max_len: int(b.max_len, 4000, 100, 20000),
    share_enabled: b.share_enabled ? 1 : 0,
    show_command: b.show_command ? 1 : 0,
    notice: String(b.notice || '').slice(0, 500),
    guild_id: gid
  });
  return config(gid);
}

// ---- 開通名單 ----
function listAccess(gid) {
  return db.prepare('SELECT * FROM spell_access WHERE guild_id=? ORDER BY created_at DESC').all(gid)
    .map(r => ({ ...r, expired: !!(r.expires_at && r.expires_at < now()) }));
}
function grant(gid, uid, { username = '', note = '', days = 0, by = '' } = {}) {
  const expires = days > 0 ? now() + days * 86400 : 0;
  db.prepare(`INSERT INTO spell_access (guild_id, user_id, username, note, granted_by, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET
      username=excluded.username, note=excluded.note, granted_by=excluded.granted_by, expires_at=excluded.expires_at`)
    .run(gid, uid, String(username || '').slice(0, 60), String(note || '').slice(0, 200), by, expires);
  return db.prepare('SELECT * FROM spell_access WHERE guild_id=? AND user_id=?').get(gid, uid);
}
function revoke(gid, uid) {
  db.prepare('DELETE FROM spell_access WHERE guild_id=? AND user_id=?').run(gid, uid);
}

// 名單有沒有這個人（過期的不算）
function inList(gid, uid) {
  const r = db.prepare('SELECT expires_at FROM spell_access WHERE guild_id=? AND user_id=?').get(gid, uid);
  if (!r) return false;
  return !r.expires_at || r.expires_at >= now();
}

/** 這個人現在能不能用咒語簿。roleIds＝他在這台伺服器的身分組（拿得到就傳，拿不到就傳空）。
 *  回傳 { ok, reason }：reason 是要顯示給玩家看的白話原因。 */
function access(gid, uid, roleIds = []) {
  const c = config(gid);
  if (!c.enabled) return { ok: false, reason: 'off' };
  if (inList(gid, uid)) return { ok: true };
  const allow = csv(c.role_ids);
  if (allow.length && (roleIds || []).some(r => allow.includes(String(r)))) return { ok: true };
  return { ok: false, reason: 'nope' };
}

/** 網頁那邊拿不到身分組，向機器人要一次（拿不到就只看開通名單）。 */
async function accessAsync(gid, uid) {
  const c = config(gid);
  if (!c.enabled) return { ok: false, reason: 'off' };
  if (inList(gid, uid)) return { ok: true };
  if (!csv(c.role_ids).length) return { ok: false, reason: 'nope' };
  let roleIds = [];
  try {
    const client = require('./bot').client;
    const guild = client && client.guilds ? client.guilds.cache.get(gid) : null;
    const member = guild ? (guild.members.cache.get(uid) || await guild.members.fetch(uid).catch(() => null)) : null;
    if (member) roleIds = [...member.roles.cache.keys()];
  } catch { roleIds = []; }
  return access(gid, uid, roleIds);
}

const DENY_TEXT = {
  off: '這台伺服器還沒開放咒語簿。',
  nope: '咒語簿要由管理員開通才能使用，請找管理員在後台把你加進開通名單。'
};

// ---- 資料夾 ----
function folders(gid, uid) {
  return db.prepare(`SELECT f.*, (SELECT COUNT(*) FROM spell_entries e WHERE e.folder_id=f.id) AS count
    FROM spell_folders f WHERE f.guild_id=? AND f.user_id=?
    ORDER BY f.pinned DESC, f.sort, f.id`).all(gid, uid);
}
function addFolder(gid, uid, { name, emoji }) {
  const c = config(gid);
  const n = db.prepare('SELECT COUNT(*) n FROM spell_folders WHERE guild_id=? AND user_id=?').get(gid, uid).n;
  if (n >= c.max_folders) return { error: `資料夾最多 ${c.max_folders} 個，先刪掉一些再新增。` };
  const nm = String(name || '').trim().slice(0, 40);
  if (!nm) return { error: '請填資料夾名稱。' };
  const r = db.prepare('INSERT INTO spell_folders (guild_id, user_id, name, emoji, sort) VALUES (?,?,?,?,?)')
    .run(gid, uid, nm, String(emoji || '📁').slice(0, 8), n);
  return { id: r.lastInsertRowid };
}
function editFolder(gid, uid, id, { name, emoji }) {
  const f = db.prepare('SELECT * FROM spell_folders WHERE id=? AND guild_id=? AND user_id=?').get(id, gid, uid);
  if (!f) return { error: '找不到這個資料夾。' };
  db.prepare("UPDATE spell_folders SET name=?, emoji=?, updated_at=datetime('now','localtime') WHERE id=?")
    .run(String(name || f.name).trim().slice(0, 40) || f.name, String(emoji || f.emoji).slice(0, 8), id);
  return { ok: true };
}
function delFolder(gid, uid, id) {
  const f = db.prepare('SELECT id FROM spell_folders WHERE id=? AND guild_id=? AND user_id=?').get(id, gid, uid);
  if (!f) return { error: '找不到這個資料夾。' };
  db.prepare('DELETE FROM spell_entries WHERE folder_id=? AND guild_id=? AND user_id=?').run(id, gid, uid);
  db.prepare('DELETE FROM spell_folders WHERE id=?').run(id);
  return { ok: true };
}
// 置頂／取消置頂（App 裡向右滑就是呼叫這個）
function pinFolder(gid, uid, id, on) {
  const f = db.prepare('SELECT id FROM spell_folders WHERE id=? AND guild_id=? AND user_id=?').get(id, gid, uid);
  if (!f) return { error: '找不到這個資料夾。' };
  db.prepare('UPDATE spell_folders SET pinned=? WHERE id=?').run(on ? 1 : 0, id);
  return { ok: true, pinned: on ? 1 : 0 };
}

// ---- 內容 ----
function entries(gid, uid, folderId) {
  return db.prepare(`SELECT * FROM spell_entries WHERE guild_id=? AND user_id=? AND folder_id=?
    ORDER BY pinned DESC, sort, id`).all(gid, uid, folderId);
}
function addEntry(gid, uid, folderId, { title, content }) {
  const c = config(gid);
  const f = db.prepare('SELECT id FROM spell_folders WHERE id=? AND guild_id=? AND user_id=?').get(folderId, gid, uid);
  if (!f) return { error: '找不到這個資料夾。' };
  const n = db.prepare('SELECT COUNT(*) n FROM spell_entries WHERE guild_id=? AND user_id=? AND folder_id=?').get(gid, uid, folderId).n;
  if (n >= c.max_entries) return { error: `這個資料夾最多 ${c.max_entries} 則。` };
  const body = String(content || '').slice(0, c.max_len);
  if (!body.trim()) return { error: '內容不能空白。' };
  const r = db.prepare('INSERT INTO spell_entries (guild_id, user_id, folder_id, title, content, sort) VALUES (?,?,?,?,?,?)')
    .run(gid, uid, folderId, String(title || '').trim().slice(0, 60), body, n);
  return { id: r.lastInsertRowid };
}
function editEntry(gid, uid, id, { title, content }) {
  const c = config(gid);
  const e = db.prepare('SELECT * FROM spell_entries WHERE id=? AND guild_id=? AND user_id=?').get(id, gid, uid);
  if (!e) return { error: '找不到這則內容。' };
  const body = content == null ? e.content : String(content).slice(0, c.max_len);
  if (!body.trim()) return { error: '內容不能空白。' };
  db.prepare("UPDATE spell_entries SET title=?, content=?, updated_at=datetime('now','localtime') WHERE id=?")
    .run(title == null ? e.title : String(title).trim().slice(0, 60), body, id);
  return { ok: true };
}
function delEntry(gid, uid, id) {
  const e = db.prepare('SELECT id FROM spell_entries WHERE id=? AND guild_id=? AND user_id=?').get(id, gid, uid);
  if (!e) return { error: '找不到這則內容。' };
  db.prepare('DELETE FROM spell_entries WHERE id=?').run(id);
  return { ok: true };
}
function pinEntry(gid, uid, id, on) {
  const e = db.prepare('SELECT id FROM spell_entries WHERE id=? AND guild_id=? AND user_id=?').get(id, gid, uid);
  if (!e) return { error: '找不到這則內容。' };
  db.prepare('UPDATE spell_entries SET pinned=? WHERE id=?').run(on ? 1 : 0, id);
  return { ok: true, pinned: on ? 1 : 0 };
}
function bumpCopy(gid, uid, id) {
  db.prepare('UPDATE spell_entries SET copies=copies+1 WHERE id=? AND guild_id=? AND user_id=?').run(id, gid, uid);
}

// ---- 分享：一組分享碼 ＋（可選）密碼 ----
// 有密碼時內容用 AES-256-GCM 加密後才進資料庫，金鑰由密碼 scrypt 推導 —— 沒有密碼誰也解不開。
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // 去掉容易看錯的 O/0、I/1
function makeCode(len = 8) {
  const b = crypto.randomBytes(len);
  return [...b].map(x => CODE_CHARS[x % CODE_CHARS.length]).join('');
}
function deriveKey(password, salt) {
  return crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), 32);
}
function encryptPayload(json, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(String(password), salt, 32);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(json, 'utf8'), c.final()]);
  return { payload: enc.toString('base64'), salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64') };
}
function decryptPayload(row, password) {
  try {
    const key = deriveKey(password, row.salt);
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(row.iv, 'base64'));
    d.setAuthTag(Buffer.from(row.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(row.payload, 'base64')), d.final()]).toString('utf8');
  } catch { return null; }   // 密碼錯 → GCM 驗證失敗
}

function shareFolder(gid, uid, folderId, { password = '', days = 30 } = {}) {
  const c = config(gid);
  if (!c.share_enabled) return { error: '這台伺服器關閉了分享功能。' };
  const f = db.prepare('SELECT * FROM spell_folders WHERE id=? AND guild_id=? AND user_id=?').get(folderId, gid, uid);
  if (!f) return { error: '找不到這個資料夾。' };
  const rows = entries(gid, uid, folderId).map(e => ({ title: e.title, content: e.content, pinned: e.pinned }));
  if (!rows.length) return { error: '這個資料夾還沒有內容，沒東西可以分享。' };
  const json = JSON.stringify({ name: f.name, emoji: f.emoji, entries: rows });
  const code = makeCode();
  const expires = days > 0 ? now() + int(days, 30, 1, 365) * 86400 : 0;
  const enc = password ? encryptPayload(json, password) : { payload: json, salt: '', iv: '', tag: '' };
  db.prepare(`INSERT INTO spell_shares (code, guild_id, user_id, folder_name, payload, salt, iv, tag, encrypted, expires_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(code, gid, uid, f.name, enc.payload, enc.salt, enc.iv, enc.tag, password ? 1 : 0, expires);
  return { code, encrypted: !!password, count: rows.length, expires_at: expires };
}

function importShare(gid, uid, code, password = '') {
  const c = config(gid);
  const row = db.prepare('SELECT * FROM spell_shares WHERE code=?').get(String(code || '').trim().toUpperCase());
  if (!row) return { error: '找不到這組分享碼（檢查有沒有打錯）。' };
  if (row.expires_at && row.expires_at < now()) return { error: '這組分享碼已經過期了，請對方重新產生。' };
  let json = row.payload;
  if (row.encrypted) {
    if (!password) return { error: '這份分享有設密碼，請輸入密碼。' };
    json = decryptPayload(row, password);
    if (json == null) return { error: '密碼不對，解不開。' };
  }
  let data;
  try { data = JSON.parse(json); } catch { return { error: '分享內容毀損，無法匯入。' }; }
  const made = addFolder(gid, uid, { name: (data.name || '分享的資料夾') + '（分享）', emoji: data.emoji || '📁' });
  if (made.error) return made;
  let n = 0;
  for (const e of (data.entries || []).slice(0, c.max_entries)) {
    const r = addEntry(gid, uid, made.id, { title: e.title, content: e.content });
    if (!r.error) n++;
  }
  db.prepare('UPDATE spell_shares SET uses=uses+1 WHERE code=?').run(row.code);
  return { ok: true, folder_id: made.id, count: n, name: data.name || '' };
}

// ---- 備份：整本匯出／匯入 ----
function exportAll(gid, uid) {
  return {
    version: 1, exported_at: new Date().toISOString(),
    folders: folders(gid, uid).map(f => ({
      name: f.name, emoji: f.emoji, pinned: f.pinned,
      entries: entries(gid, uid, f.id).map(e => ({ title: e.title, content: e.content, pinned: e.pinned }))
    }))
  };
}
function importAll(gid, uid, data) {
  if (!data || !Array.isArray(data.folders)) return { error: '這個檔案看起來不是咒語簿的備份。' };
  let fn = 0, en = 0;
  for (const f of data.folders) {
    const made = addFolder(gid, uid, { name: f.name, emoji: f.emoji });
    if (made.error) return { error: made.error, folders: fn, entries: en };
    fn++;
    if (f.pinned) pinFolder(gid, uid, made.id, 1);
    for (const e of (f.entries || [])) {
      const r = addEntry(gid, uid, made.id, { title: e.title, content: e.content });
      if (!r.error) en++;
    }
  }
  return { ok: true, folders: fn, entries: en };
}

// ---- 後台看的統計（只給數量，不看內容：那是玩家的私人東西）----
function usageStats(gid) {
  return db.prepare(`SELECT a.user_id, a.username, a.note, a.expires_at, a.granted_by, a.created_at,
      (SELECT COUNT(*) FROM spell_folders f WHERE f.guild_id=a.guild_id AND f.user_id=a.user_id) AS folders,
      (SELECT COUNT(*) FROM spell_entries e WHERE e.guild_id=a.guild_id AND e.user_id=a.user_id) AS entries,
      (SELECT COALESCE(SUM(copies),0) FROM spell_entries e WHERE e.guild_id=a.guild_id AND e.user_id=a.user_id) AS copies
    FROM spell_access a WHERE a.guild_id=? ORDER BY a.created_at DESC`).all(gid)
    .map(r => ({ ...r, expired: !!(r.expires_at && r.expires_at < now()) }));
}

module.exports = {
  config, saveConfig, commandVisible, listAccess, grant, revoke, inList, access, accessAsync, DENY_TEXT,
  folders, addFolder, editFolder, delFolder, pinFolder,
  entries, addEntry, editEntry, delEntry, pinEntry, bumpCopy,
  shareFolder, importShare, exportAll, importAll, usageStats
};
