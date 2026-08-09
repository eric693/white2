const express = require('express');
const { db, audit } = require('../db');
const { requireAuth, requireModule } = require('../auth');

const router = express.Router();
router.use(requireAuth());

// ========== 關鍵字自動回覆 ==========
const kwMod = requireModule('keywords');

router.get('/keywords', kwMod, (req, res) => {
  res.json(db.prepare('SELECT * FROM keywords WHERE guild_id = ? ORDER BY id DESC').all(req.guildId));
});

// 觸發紀錄
router.get('/keywords/:id/logs', kwMod, (req, res) => {
  res.json(db.prepare('SELECT * FROM keyword_logs WHERE guild_id=? AND keyword_id=? ORDER BY id DESC LIMIT 100').all(req.guildId, req.params.id));
});

function kwFields(b) {
  const chans = Array.isArray(b.channels) ? b.channels.join(',') : (b.channels || '');
  return {
    keyword: b.keyword || '', match_type: b.match_type || 'contains', reply_text: b.reply_text || '',
    image_url: b.image_url || '', link_url: b.link_url || '', use_embed: b.use_embed ? 1 : 0,
    btn_label: b.btn_label || '', btn_url: b.btn_url || '', channels: chans,
    reply_channel: b.reply_channel || '', cooldown: parseInt(b.cooldown) || 0,
    buttons: b.buttons || '[]', enabled: b.enabled ? 1 : 0,
    give_roles: Array.isArray(b.give_roles) ? b.give_roles.join(',') : (b.give_roles || '')
  };
}

router.post('/keywords', kwMod, (req, res) => {
  const b = req.body || {};
  if (!b.keyword) return res.status(400).json({ error: '請填寫關鍵字' });
  const info = db.prepare(
    `INSERT INTO keywords (guild_id, keyword, match_type, reply_text, image_url, link_url, use_embed, btn_label, btn_url, channels, reply_channel, cooldown, buttons, enabled, give_roles)
     VALUES (@guild_id,@keyword,@match_type,@reply_text,@image_url,@link_url,@use_embed,@btn_label,@btn_url,@channels,@reply_channel,@cooldown,@buttons,@enabled,@give_roles)`
  ).run({ ...kwFields(b), guild_id: req.guildId });
  audit(req.user.name, `新增關鍵字：${b.keyword}`);
  res.json({ id: info.lastInsertRowid });
});

router.put('/keywords/:id', kwMod, (req, res) => {
  db.prepare(
    `UPDATE keywords SET keyword=@keyword, match_type=@match_type, reply_text=@reply_text, image_url=@image_url,
       link_url=@link_url, use_embed=@use_embed, btn_label=@btn_label, btn_url=@btn_url, channels=@channels,
       reply_channel=@reply_channel, cooldown=@cooldown, buttons=@buttons, enabled=@enabled, give_roles=@give_roles WHERE id=@id AND guild_id=@guild_id`
  ).run({ ...kwFields(req.body || {}), id: req.params.id, guild_id: req.guildId });
  audit(req.user.name, `修改關鍵字 #${req.params.id}`);
  res.json({ ok: true });
});

router.delete('/keywords/:id', kwMod, (req, res) => {
  db.prepare('DELETE FROM keywords WHERE id = ? AND guild_id = ?').run(req.params.id, req.guildId);
  db.prepare('DELETE FROM keyword_logs WHERE keyword_id = ? AND guild_id = ?').run(req.params.id, req.guildId);
  audit(req.user.name, `刪除關鍵字 #${req.params.id}`);
  res.json({ ok: true });
});

// ========== 關鍵字標記管理員 ==========
const mMod = requireModule('mentions');

router.get('/mentions', mMod, (req, res) => {
  res.json(db.prepare('SELECT * FROM keyword_mentions WHERE guild_id = ? ORDER BY id DESC').all(req.guildId));
});

router.post('/mentions', mMod, (req, res) => {
  const b = req.body || {};
  if (!b.keyword) return res.status(400).json({ error: '請填寫關鍵字' });
  const info = db.prepare(
    `INSERT INTO keyword_mentions (guild_id, keyword, match_type, mention_ids, mention_type, note, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(req.guildId, b.keyword, b.match_type || 'contains', b.mention_ids || '', b.mention_type || 'user', b.note || '', b.enabled ? 1 : 0);
  audit(req.user.name, `新增標記規則：${b.keyword}`);
  res.json({ id: info.lastInsertRowid });
});

router.put('/mentions/:id', mMod, (req, res) => {
  const b = req.body || {};
  db.prepare(
    `UPDATE keyword_mentions SET keyword=?, match_type=?, mention_ids=?, mention_type=?, note=?, enabled=? WHERE id=? AND guild_id=?`
  ).run(b.keyword, b.match_type || 'contains', b.mention_ids || '', b.mention_type || 'user', b.note || '', b.enabled ? 1 : 0, req.params.id, req.guildId);
  audit(req.user.name, `修改標記規則 #${req.params.id}`);
  res.json({ ok: true });
});

router.delete('/mentions/:id', mMod, (req, res) => {
  db.prepare('DELETE FROM keyword_mentions WHERE id = ? AND guild_id = ?').run(req.params.id, req.guildId);
  audit(req.user.name, `刪除標記規則 #${req.params.id}`);
  res.json({ ok: true });
});

module.exports = router;
