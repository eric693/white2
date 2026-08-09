const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { db, logError } = require('../../db');
const { absUrl } = require('../../util/url');
const { brandColor } = require('../../util/brand');
const { buildButtonRows } = require('../../util/components');

const csv = (s) => String(s || '').split(/[\n,]/).map(x => x.trim()).filter(Boolean);

function matchAny(text, keywordField, type) {
  const t = text.toLowerCase();
  for (const k of csv(keywordField)) {
    const kk = k.toLowerCase();
    if (type === 'exact' && t === kk) return k;
    if (type === 'starts' && t.startsWith(kk)) return k;
    if (type === 'contains' && t.includes(kk)) return k;
  }
  return null;
}

// 冷卻：記憶體 Map，key = `${keywordId}:${userId}`
const cooldowns = new Map();
function onCooldown(id, userId, seconds) {
  if (!seconds) return false;
  const key = `${id}:${userId}`;
  const last = cooldowns.get(key) || 0;
  if (Date.now() - last < seconds * 1000) return true;
  cooldowns.set(key, Date.now());
  if (cooldowns.size > 50000) cooldowns.clear();
  return false;
}

function init(client) {
  client.on('messageCreate', async (msg) => {
    if (msg.author.bot || !msg.guild) return;
    const content = msg.content || '';
    if (!content) return;
    const gid = msg.guild.id;

    // ---- 關鍵字自動回覆 ----
    const kws = db.prepare('SELECT * FROM keywords WHERE guild_id = ? AND enabled = 1').all(gid);
    for (const kw of kws) {
      // 4.5 限定觸發頻道
      const chans = csv(kw.channels);
      if (chans.length && !chans.includes(msg.channel.id)) continue;
      const matched = matchAny(content, kw.keyword, kw.match_type);
      if (!matched) continue;
      // 4.6 / 4.7 冷卻，冷卻內同一玩家不重複回覆
      if (onCooldown(kw.id, msg.author.id, kw.cooldown)) break;

      try {
        const target = kw.reply_channel
          ? (client.channels.cache.get(kw.reply_channel) || await client.channels.fetch(kw.reply_channel).catch(() => null))
          : msg.channel;
        if (!target) break;

        const payload = {};
        if (kw.use_embed) {
          const embed = new EmbedBuilder().setColor(brandColor());
          if (kw.reply_text) embed.setDescription(kw.reply_text);
          if (kw.image_url) embed.setImage(absUrl(kw.image_url));
          if (kw.link_url) embed.addFields({ name: '連結', value: kw.link_url });
          payload.embeds = [embed];
        } else {
          payload.content = [kw.reply_text, kw.link_url].filter(Boolean).join('\n') || '（無內容）';
          if (kw.image_url) payload.content += '\n' + absUrl(kw.image_url);
        }
        // 4.3 多個連結按鈕（圖標＋文字）
        const rows = buildButtonRows(kw.buttons, { label: kw.btn_label, url: kw.btn_url });
        if (rows.length) payload.components = rows;
        if (kw.reply_channel) await target.send(payload);
        else await msg.reply(payload);

        // 命中後自動給發言者身分組（需要機器人有管理身分組權限，且位階夠高）
        const give = csv(kw.give_roles);
        if (give.length && msg.member) {
          for (const rid of give) {
            const role = msg.guild.roles.cache.get(rid);
            if (!role) { logError(gid, '自動給予身分組失敗：', `找不到身分組 ${rid}`); continue; }
            if (msg.member.roles.cache.has(rid)) continue;   // 已經有了就不重複給
            try { await msg.member.roles.add(role, `關鍵字「${matched}」自動給予`); }
            catch (e) { logError(gid, '自動給予身分組失敗：', `${role.name}（${e.message}）`); }
          }
        }

        // 4.9 觸發紀錄
        db.prepare('INSERT INTO keyword_logs (guild_id, keyword_id, matched, user_id, username, channel_id, message) VALUES (?,?,?,?,?,?,?)')
          .run(gid, kw.id, matched, msg.author.id, msg.author.username, msg.channel.id, content.slice(0, 300));
      } catch (e) { logError(gid, '關鍵字回覆失敗：', e.message); }
      break; // 一則訊息只觸發第一個命中的自動回覆
    }

    // ---- 關鍵字標記管理員（舊版；將由通知與警告系統取代）----
    const mentions = db.prepare('SELECT * FROM keyword_mentions WHERE guild_id = ? AND enabled = 1').all(gid);
    for (const m of mentions) {
      if (!matchAny(content, m.keyword, m.match_type)) continue;
      const ids = csv(m.mention_ids);
      if (!ids.length) continue;
      const tags = ids.map(id => m.mention_type === 'role' ? `<@&${id}>` : `<@${id}>`).join(' ');
      try {
        await msg.reply({
          content: `${tags} ${m.note || '有訊息需要協助處理。'}`,
          allowedMentions: { users: m.mention_type === 'user' ? ids : [], roles: m.mention_type === 'role' ? ids : [] }
        });
      } catch (e) { logError(gid, '標記管理員失敗：', e.message); }
      break;
    }
  });
  console.log('  ↳ 關鍵字模組已載入（多關鍵字/限定頻道/冷卻/紀錄）');
}

module.exports = { init, matchAny };
