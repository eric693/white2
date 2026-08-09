const express = require('express');
const { db, audit } = require('../db');
const { requireAuth, requireModule, guardModule } = require('../auth');

const router = express.Router();
router.use(requireAuth(), guardModule('reminders'));

router.get('/reminders', (req, res) => {
  res.json(db.prepare('SELECT * FROM reminders WHERE guild_id = ? ORDER BY id DESC').all(req.guildId));
});

// 提醒發送紀錄
router.get('/reminders/:id/logs', (req, res) => {
  res.json(db.prepare('SELECT * FROM reminder_logs WHERE guild_id=? AND reminder_id=? ORDER BY id DESC LIMIT 50').all(req.guildId, req.params.id));
});

function fields(b) {
  const roleIds = Array.isArray(b.mention_role_ids) ? b.mention_role_ids.join(',') : (b.mention_role_ids || '');
  return {
    title: b.title || '', message: b.message || '', channel_id: b.channel_id || '',
    mention_ids: b.mention_ids || '', mention_role_ids: roleIds,
    mention_everyone: b.mention_everyone ? 1 : 0, do_mention: b.do_mention ? 1 : 0,
    image_url: b.image_url || '', link_url: b.link_url || '', btn_label: b.btn_label || '', btn_url: b.btn_url || '', buttons: b.buttons || '[]',
    freq: b.freq || 'once', at_time: b.at_time || '09:00',
    at_dow: parseInt(b.at_dow) || 0, at_dom: parseInt(b.at_dom) || 1,
    run_at: b.run_at || '', enabled: b.enabled ? 1 : 0, note: b.note || ''
  };
}

router.post('/reminders', (req, res) => {
  const b = req.body || {};
  if (!b.channel_id) return res.status(400).json({ error: '請選擇頻道' });
  if (!b.message && !b.title) return res.status(400).json({ error: '請填寫提醒內容' });
  if (b.freq === 'once' && !b.run_at) return res.status(400).json({ error: '單次提醒請選擇時間' });
  const s = fields(b);
  const info = db.prepare(
    `INSERT INTO reminders (guild_id, title, message, channel_id, mention_ids, mention_role_ids, mention_everyone, do_mention,
       image_url, link_url, btn_label, btn_url, buttons, freq, at_time, at_dow, at_dom, run_at, enabled, creator, note)
     VALUES (@guild_id,@title,@message,@channel_id,@mention_ids,@mention_role_ids,@mention_everyone,@do_mention,
       @image_url,@link_url,@btn_label,@btn_url,@buttons,@freq,@at_time,@at_dow,@at_dom,@run_at,@enabled,@creator,@note)`
  ).run({ ...s, creator: req.user.name, guild_id: req.guildId });
  audit(req.user.name, `新增提醒：${b.title || b.message?.slice(0, 20)}`);
  res.json({ id: info.lastInsertRowid });
});

router.put('/reminders/:id', (req, res) => {
  const s = fields(req.body || {});
  db.prepare(
    `UPDATE reminders SET title=@title, message=@message, channel_id=@channel_id, mention_ids=@mention_ids,
       mention_role_ids=@mention_role_ids, mention_everyone=@mention_everyone, do_mention=@do_mention,
       image_url=@image_url, link_url=@link_url, btn_label=@btn_label, btn_url=@btn_url, buttons=@buttons, note=@note,
       freq=@freq, at_time=@at_time, at_dow=@at_dow, at_dom=@at_dom, run_at=@run_at, enabled=@enabled, last_run='' WHERE id=@id AND guild_id=@guild_id`
  ).run({ ...s, id: req.params.id, guild_id: req.guildId });
  audit(req.user.name, `修改提醒 #${req.params.id}`);
  res.json({ ok: true });
});

// 暫停 / 重新啟用
router.post('/reminders/:id/toggle', (req, res) => {
  const r = db.prepare('SELECT enabled FROM reminders WHERE id=? AND guild_id=?').get(req.params.id, req.guildId);
  if (!r) return res.status(404).json({ error: '找不到提醒' });
  db.prepare('UPDATE reminders SET enabled=? WHERE id=? AND guild_id=?').run(r.enabled ? 0 : 1, req.params.id, req.guildId);
  audit(req.user.name, `${r.enabled ? '暫停' : '啟用'}提醒 #${req.params.id}`);
  res.json({ enabled: r.enabled ? 0 : 1 });
});

router.delete('/reminders/:id', (req, res) => {
  db.prepare('DELETE FROM reminders WHERE id=? AND guild_id=?').run(req.params.id, req.guildId);
  audit(req.user.name, `刪除提醒 #${req.params.id}`);
  res.json({ ok: true });
});

module.exports = router;
