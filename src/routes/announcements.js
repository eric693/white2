// 公告系統 API（規格 7.1～7.12）
const express = require('express');
const { db, audit } = require('../db');
const { requireAuth, requireModule, guardModule } = require('../auth');
const bot = require('../bot');

const router = express.Router();
router.use(requireAuth(), guardModule('announcements'));

const csvField = (v) => Array.isArray(v) ? v.join(',') : String(v || '');

router.get('/announcements', (req, res) => {
  res.json(db.prepare('SELECT * FROM announcements WHERE guild_id = ? ORDER BY id DESC').all(req.guildId));
});

// 7.10 發送紀錄
router.get('/announcement-logs', (req, res) => {
  res.json(db.prepare('SELECT * FROM announcement_logs WHERE guild_id = ? ORDER BY id DESC LIMIT 200').all(req.guildId));
});

function annFields(b) {
  return {
    note: b.note || '',
    title: b.title || '', content: b.content || '', image_url: b.image_url || '',
    link_url: b.link_url || '', video_url: b.video_url || '',
    btn_label: b.btn_label || '', btn_url: b.btn_url || '', buttons: b.buttons || '[]',
    images: b.images || '[]',
    stickers: b.stickers || '[]',
    // { 頻道id: '身分組id,身分組id' }；只收合法 JSON 物件，避免壞字串讓發送整個炸掉
    channel_mentions: (() => {
      const v = b.channel_mentions;
      if (typeof v === 'string') { try { return JSON.stringify(JSON.parse(v || '{}')); } catch { return '{}'; } }
      return JSON.stringify(v && typeof v === 'object' ? v : {});
    })(),
    reaction_roles: b.reaction_roles || '[]',
    use_embed: b.use_embed ? 1 : 0,
    footer: b.footer || '', thumb: b.thumb || '',
    channels: csvField(b.channels), channel_id: b.channel_id || '',
    mention_everyone: b.mention_everyone ? 1 : 0,
    mention_here: b.mention_here ? 1 : 0,
    mention_role_ids: csvField(b.mention_role_ids),
    repeat_freq: b.repeat_freq || 'none', repeat_time: b.repeat_time || '09:00',
    repeat_dow: parseInt(b.repeat_dow, 10) || 0, repeat_dom: parseInt(b.repeat_dom, 10) || 1,
    repeat_days: parseInt(b.repeat_days, 10) || 1,
    scheduled_at: b.mode === 'schedule' ? (b.scheduled_at || '') : ''
  };
}

function statusOf(b) {
  if (b.repeat_freq && b.repeat_freq !== 'none') return 'repeating';
  if (b.mode === 'schedule' && b.scheduled_at) return 'scheduled';
  return 'draft';
}

// 7.1 建立公告：mode = now | schedule（repeat_freq 不為 none 時為循環公告）
router.post('/announcements', async (req, res) => {
  const b = req.body || {};
  const f = annFields(b);
  if (!f.channels && !f.channel_id) return res.status(400).json({ error: '請至少選擇一個發送頻道' });
  if (!f.content && !f.image_url && !f.link_url && !f.video_url && !f.title
      && (!f.images || f.images === '[]') && (!f.stickers || f.stickers === '[]')) {
    return res.status(400).json({ error: '請填寫公告內容' });
  }
  const status = statusOf(b);
  const info = db.prepare(
    `INSERT INTO announcements (guild_id, note, title, content, image_url, link_url, video_url, btn_label, btn_url, buttons, images, stickers, channel_mentions, reaction_roles, use_embed, footer, thumb,
       channel_id, channels, mention_everyone, mention_here, mention_role_ids,
       repeat_freq, repeat_time, repeat_dow, repeat_dom, repeat_days, scheduled_at, status, creator)
     VALUES (@guild_id,@note,@title,@content,@image_url,@link_url,@video_url,@btn_label,@btn_url,@buttons,@images,@stickers,@channel_mentions,@reaction_roles,@use_embed,@footer,@thumb,
       @channel_id,@channels,@mention_everyone,@mention_here,@mention_role_ids,
       @repeat_freq,@repeat_time,@repeat_dow,@repeat_dom,@repeat_days,@scheduled_at,@status,@creator)`
  ).run({ ...f, status, creator: req.user.name, guild_id: req.guildId });
  const ann = db.prepare('SELECT * FROM announcements WHERE id=?').get(info.lastInsertRowid);

  // 立即發送（非排程、非循環）
  if (status === 'draft' && b.mode !== 'draft') {
    if (!bot.client._sendAnnouncement) return res.status(503).json({ error: '機器人尚未上線，公告已存為草稿' });
    try { await bot.client._sendAnnouncement(ann); }
    catch (e) { return res.status(500).json({ error: e.message }); }
  }
  audit(req.user.name, `建立公告：${f.title || f.content.slice(0, 20)}`);
  res.json({ id: ann.id });
});

// 7.7 修改公告。已發送的公告存檔後會用 sync=1 同步修改 Discord 上那則訊息
// （Discord 只在送出當下推播提及，事後編輯不會再標記一次 @everyone）
router.put('/announcements/:id', async (req, res) => {
  const ann = db.prepare('SELECT * FROM announcements WHERE id=? AND guild_id=?').get(req.params.id, req.guildId);
  if (!ann) return res.status(404).json({ error: '找不到公告' });
  const b = req.body || {};
  db.prepare(
    `UPDATE announcements SET note=@note, title=@title, content=@content, image_url=@image_url, link_url=@link_url,
       video_url=@video_url, btn_label=@btn_label, btn_url=@btn_url, buttons=@buttons, images=@images, stickers=@stickers, channel_mentions=@channel_mentions, reaction_roles=@reaction_roles, use_embed=@use_embed, footer=@footer, thumb=@thumb,
       channel_id=@channel_id, channels=@channels, mention_everyone=@mention_everyone, mention_here=@mention_here,
       mention_role_ids=@mention_role_ids, repeat_freq=@repeat_freq, repeat_time=@repeat_time,
       repeat_dow=@repeat_dow, repeat_dom=@repeat_dom, repeat_days=@repeat_days,
       scheduled_at=@scheduled_at, status=@status WHERE id=@id AND guild_id=@guild_id`
  // 已按過「停止」的公告，編輯儲存後要留在停止狀態，不能因為重算狀態就自己重新開跑；
  // 已發送的公告也要留在已發送，不能因為重算就變回草稿。
  ).run({
    ...annFields(b),
    status: (ann.status === 'stopped' || ann.status === 'sent') ? ann.status : statusOf(b),
    id: req.params.id, guild_id: req.guildId
  });
  audit(req.user.name, `修改公告 #${req.params.id}`);

  // 同步修改 Discord 上已發送的那則訊息
  if (b.sync) {
    if (!bot.client._editAnnouncement) return res.status(503).json({ error: '機器人尚未上線，修改已存檔但尚未同步' });
    const fresh = db.prepare('SELECT * FROM announcements WHERE id=?').get(req.params.id);
    try {
      const r = await bot.client._editAnnouncement(fresh);
      audit(req.user.name, `同步編輯已發送公告 #${req.params.id}`);
      return res.json({ ok: true, edited: r.edited.length, failed: r.failed });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }
  res.json({ ok: true });
});

// 立即發送草稿/排程/循環公告
router.post('/announcements/:id/send', async (req, res) => {
  const ann = db.prepare('SELECT * FROM announcements WHERE id=? AND guild_id=?').get(req.params.id, req.guildId);
  if (!ann) return res.status(404).json({ error: '找不到公告' });
  if (!bot.client._sendAnnouncement) return res.status(503).json({ error: '機器人尚未上線' });
  try {
    const r = await bot.client._sendAnnouncement(ann);
    audit(req.user.name, `發送公告 #${ann.id}`);
    res.json({ ok: true, sent: r.sent.length, failed: r.failed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 7.8 停止循環 / 取消排程
router.put('/announcements/:id/stop', (req, res) => {
  db.prepare("UPDATE announcements SET status='stopped' WHERE id=? AND guild_id=?").run(req.params.id, req.guildId);
  audit(req.user.name, `停止公告 #${req.params.id}`);
  res.json({ ok: true });
});

// 重新啟用循環公告
router.put('/announcements/:id/resume', (req, res) => {
  const ann = db.prepare('SELECT * FROM announcements WHERE id=? AND guild_id=?').get(req.params.id, req.guildId);
  if (!ann) return res.status(404).json({ error: '找不到公告' });
  const status = ann.repeat_freq !== 'none' ? 'repeating' : (ann.scheduled_at ? 'scheduled' : 'draft');
  db.prepare('UPDATE announcements SET status=? WHERE id=? AND guild_id=?').run(status, req.params.id, req.guildId);
  audit(req.user.name, `恢復公告 #${req.params.id}`);
  res.json({ ok: true });
});

router.delete('/announcements/:id', (req, res) => {
  db.prepare('DELETE FROM announcements WHERE id=? AND guild_id=?').run(req.params.id, req.guildId);
  audit(req.user.name, `刪除公告 #${req.params.id}`);
  res.json({ ok: true });
});

// ---- 7.9 公告模板 ----
router.get('/announcement-templates', (req, res) => {
  res.json(db.prepare('SELECT * FROM announcement_templates WHERE guild_id = ? ORDER BY id DESC').all(req.guildId));
});

router.post('/announcement-templates', (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: '請填寫模板名稱' });
  const info = db.prepare('INSERT INTO announcement_templates (guild_id, name, payload) VALUES (?, ?, ?)')
    .run(req.guildId, b.name, JSON.stringify(b.payload || {}));
  audit(req.user.name, `新增公告模板：${b.name}`);
  res.json({ id: info.lastInsertRowid });
});

router.delete('/announcement-templates/:id', (req, res) => {
  db.prepare('DELETE FROM announcement_templates WHERE id=? AND guild_id=?').run(req.params.id, req.guildId);
  audit(req.user.name, `刪除公告模板 #${req.params.id}`);
  res.json({ ok: true });
});

module.exports = router;
