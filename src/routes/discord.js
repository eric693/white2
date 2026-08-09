const express = require('express');
const { ChannelType } = require('discord.js');
const { requireAuth } = require('../auth');
const bot = require('../bot');
const { db, audit, getSetting, setSetting, ensureGuild, resetGuildData } = require('../db');

const router = express.Router();
router.use(requireAuth());

// 機器人所在伺服器清單（供後台切換）
router.get('/guilds', (req, res) => {
  const live = bot.guildList ? bot.guildList() : [];
  const rows = db.prepare('SELECT * FROM guilds WHERE active = 1').all();
  // 以機器人即時清單為主，補上資料庫紀錄
  const map = new Map(rows.map(r => [r.guild_id, r]));
  let list = live.length ? live.map(g => ({ ...g, ...(map.get(g.id) || {}) })) : rows.map(r => ({
    id: r.guild_id, name: r.name, icon: r.icon, members: 0
  }));
  // 帳號綁定：非總管理員只看得到自己被允許的伺服器
  const allowed = req.allowedGuilds || [];
  if (req.user.role !== 'admin') list = list.filter(g => allowed.includes(g.id));
  res.json({ guilds: list, current: req.guildId });
});

// ---- 伺服器白名單管理（只給朋友使用）----
router.get('/guild-admin', (req, res) => {
  const live = new Map((bot.guildList ? bot.guildList() : []).map(g => [g.id, g]));
  const rows = db.prepare('SELECT * FROM guilds ORDER BY approved DESC, joined_at DESC').all();
  res.json({
    guilds: rows.map(r => ({ ...r, online: live.has(r.guild_id), members: (live.get(r.guild_id) || {}).members || 0 })),
    open_mode: getSetting('allow_any_guild', '0') === '1',
    invite: `https://discord.com/oauth2/authorize?client_id=${process.env.DISCORD_CLIENT_ID}&scope=bot%20applications.commands&permissions=1099783466050`
  });
});

// 核准／撤銷某伺服器
router.put('/guild-admin/:gid', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '僅總管理員可管理伺服器授權' });
  const approved = req.body && req.body.approved ? 1 : 0;
  const note = (req.body && req.body.note) || '';
  const exists = db.prepare('SELECT 1 FROM guilds WHERE guild_id=?').get(req.params.gid);
  if (exists) db.prepare('UPDATE guilds SET approved=?, note=? WHERE guild_id=?').run(approved, note, req.params.gid);
  else db.prepare('INSERT INTO guilds (guild_id, name, approved, note, active) VALUES (?, ?, ?, ?, 0)')
    .run(req.params.gid, req.body.name || '（預先授權）', approved, note);
  if (approved) ensureGuild(req.params.gid, req.body.name || '', '');
  audit(req.user.name, `${approved ? '核准' : '撤銷'}伺服器授權 ${req.params.gid}`, 'guilds');
  res.json({ ok: true });
});

// 用「伺服器邀請連結」預先授權（免自己找伺服器 ID，朋友直接把邀請連結私訊給你即可）
router.post('/guild-admin-by-invite', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '僅總管理員可管理伺服器授權' });
  const raw = String((req.body && req.body.invite) || '').trim();
  // 支援 discord.gg/xxx、discord.com/invite/xxx，或直接貼邀請碼
  const m = raw.match(/(?:discord\.gg|discord(?:app)?\.com\/invite)\/([A-Za-z0-9-]+)/i) || raw.match(/^([A-Za-z0-9-]+)$/);
  if (!m) return res.status(400).json({ error: '看不懂，請貼類似 discord.gg/abcd 的伺服器邀請連結' });
  try {
    const r = await fetch(`https://discord.com/api/v10/invites/${encodeURIComponent(m[1])}?with_counts=true`,
      { headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` } });
    if (!r.ok) return res.status(400).json({ error: `邀請連結無效或已過期（${r.status}）` });
    const g = (await r.json()).guild;
    if (!g || !g.id) return res.status(400).json({ error: '這個連結解析不到伺服器' });
    const note = (req.body && req.body.note) || '';
    const exists = db.prepare('SELECT 1 FROM guilds WHERE guild_id=?').get(g.id);
    if (exists) db.prepare('UPDATE guilds SET approved=1, name=?, note=? WHERE guild_id=?').run(g.name || '', note, g.id);
    else db.prepare('INSERT INTO guilds (guild_id, name, approved, note, active) VALUES (?, ?, 1, ?, 0)').run(g.id, g.name || '', note);
    ensureGuild(g.id, g.name || '', g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png` : '');
    audit(req.user.name, `用邀請連結核准伺服器 ${g.name}（${g.id}）`, 'guilds');
    res.json({ ok: true, guild_id: g.id, name: g.name });
  } catch (e) {
    res.status(500).json({ error: '解析失敗：' + e.message });
  }
});

// 重置某伺服器：清空該台所有資料、設定回預設（回到全新狀態）
router.post('/guild-admin/:gid/reset', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '僅總管理員可重置伺服器資料' });
  const g = db.prepare('SELECT name FROM guilds WHERE guild_id=?').get(req.params.gid);
  if (!g) return res.status(404).json({ error: '找不到伺服器' });
  const r = resetGuildData(req.params.gid);
  audit(req.user.name, `重置伺服器資料 ${g.name}（${req.params.gid}）`, 'guilds', `清除 ${r.cleared} 筆`);
  res.json({ ok: true, cleared: r.cleared });
});

// 讓機器人離開某伺服器
router.delete('/guild-admin/:gid', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '僅總管理員可操作' });
  const g = bot.client.guilds.cache.get(req.params.gid);
  db.prepare('UPDATE guilds SET approved=0, active=0 WHERE guild_id=?').run(req.params.gid);
  if (g) await g.leave().catch(() => {});
  audit(req.user.name, `移除伺服器 ${req.params.gid}`, 'guilds');
  res.json({ ok: true });
});

// 開放模式切換（開啟＝任何人都能邀請；預設關閉）
router.put('/guild-open-mode', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '僅總管理員可調整' });
  setSetting('allow_any_guild', req.body && req.body.open ? '1' : '0');
  audit(req.user.name, `${req.body && req.body.open ? '開放' : '限制'}機器人邀請`, 'guilds');
  res.json({ ok: true });
});

// 目前伺服器的文字頻道清單（供下拉選單）
router.get('/discord/channels', async (req, res) => {
  const guild = bot.mainGuild(req.guildId);
  if (!guild) return res.json([]);
  const chans = guild.channels.cache
    .filter(c => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
    .map(c => ({ id: c.id, name: c.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json(chans);
});

// 語音頻道清單（音樂常駐頻道用）
router.get('/discord/voice-channels', async (req, res) => {
  const guild = bot.mainGuild(req.guildId);
  if (!guild) return res.json([]);
  const chans = guild.channels.cache
    .filter(c => c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice)
    .map(c => ({ id: c.id, name: c.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json(chans);
});

// 頻道分類清單（客服單頻道分類用）
router.get('/discord/categories', async (req, res) => {
  const guild = bot.mainGuild(req.guildId);
  if (!guild) return res.json([]);
  res.json(guild.channels.cache.filter(c => c.type === ChannelType.GuildCategory)
    .map(c => ({ id: c.id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name)));
});

// 身分組清單
router.get('/discord/roles', async (req, res) => {
  const guild = bot.mainGuild(req.guildId);
  if (!guild) return res.json([]);
  const roles = guild.roles.cache
    .filter(r => r.id !== guild.id) // 排除 @everyone
    .map(r => ({ id: r.id, name: r.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json(roles);
});

// 伺服器自訂表情清單（供後台選擇器插入 <:name:id>）
router.get('/discord/guild-emojis', (req, res) => {
  const guild = bot.mainGuild(req.guildId);
  if (!guild) return res.json([]);
  res.json(guild.emojis.cache
    .map(e => ({
      id: e.id, name: e.name, animated: !!e.animated,
      code: `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>`,
      url: `https://cdn.discordapp.com/emojis/${e.id}.${e.animated ? 'gif' : 'png'}?size=48`
    }))
    .sort((a, b) => a.name.localeCompare(b.name)));
});

// 伺服器貼圖（sticker）清單。貼圖跟自訂表情是兩回事：表情靠訊息裡的 <:name:id> 代碼，
// 貼圖則要在送出時帶 sticker_ids，所以後台是用勾選的、不是插進文字裡。
router.get('/discord/guild-stickers', async (req, res) => {
  const guild = bot.mainGuild(req.guildId);
  if (!guild) return res.json([]);
  // 貼圖不像表情會在 GUILD_CREATE 一起帶進 cache，第一次要主動抓一次
  if (!guild.stickers.cache.size) await guild.stickers.fetch().catch(() => {});
  res.json(guild.stickers.cache
    .map(s => ({
      id: s.id, name: s.name,
      url: `https://media.discordapp.net/stickers/${s.id}.png?size=160`
    }))
    .sort((a, b) => a.name.localeCompare(b.name)));
});

// 論壇頻道清單
router.get('/discord/forums', async (req, res) => {
  const guild = bot.mainGuild(req.guildId);
  if (!guild) return res.json([]);
  res.json(guild.channels.cache
    .filter(c => c.type === 15 || c.type === 16)
    .map(c => ({ id: c.id, name: c.name }))
    .sort((a, b) => a.name.localeCompare(b.name)));
});

// 成員搜尋
router.get('/discord/members', async (req, res) => {
  const guild = bot.mainGuild(req.guildId);
  if (!guild) return res.json([]);
  const q = String(req.query.q || '').toLowerCase();
  try { await guild.members.fetch(); } catch {}
  const members = guild.members.cache
    .filter(m => !q || m.user.username.toLowerCase().includes(q) || (m.nickname || '').toLowerCase().includes(q))
    .first(50)
    .map(m => ({ id: m.id, name: m.nickname || m.user.username, tag: m.user.tag }));
  res.json(members);
});

// 機器人狀態
router.get('/discord/status', (req, res) => {
  const guild = bot.mainGuild(req.guildId);
  res.json({ online: bot.isReady(), guild: guild ? guild.name : '', members: guild ? guild.memberCount : 0 });
});

module.exports = router;
