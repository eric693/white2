// 表情身分組：訊息（通常是公告）加上表情符號，玩家按表情自動取得對應身分組、取消表情移除
const { db, logError } = require('../../db');

// '<:name:123>' / '<a:name:123>' → '123'；unicode emoji 原樣
function emojiKey(raw) {
  const m = String(raw || '').trim().match(/^<a?:\w+:(\d+)>$/);
  return m ? m[1] : String(raw || '').trim();
}

// reaction 事件的 emoji → 對照 key（自訂表情用 id，unicode 用字元）
function reactionKey(reaction) {
  return reaction.emoji.id || reaction.emoji.name;
}

/** 對已發送的訊息掛上表情身分組（公告發送後呼叫）。maps: [{emoji, role_id}] */
async function attach(message, maps) {
  for (const m of maps) {
    if (!m.emoji || !m.role_id) continue;
    const key = emojiKey(m.emoji);
    try {
      await message.react(/^\d+$/.test(key) ? key : m.emoji);
      db.prepare(
        `INSERT INTO reaction_role_maps (guild_id, message_id, channel_id, emoji, role_id) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(message_id, emoji) DO UPDATE SET role_id = excluded.role_id`
      ).run(message.guildId || '', message.id, message.channelId, key, m.role_id);
    } catch (e) { logError(message.guildId, `表情身分組掛載失敗（${m.emoji}）：`, e.message); }
  }
}

function lookup(reaction) {
  return db.prepare('SELECT * FROM reaction_role_maps WHERE message_id = ? AND emoji = ?')
    .get(reaction.message.id, reactionKey(reaction));
}

function init(client) {
  client.on('messageReactionAdd', async (reaction, user) => {
    if (user.bot) return;
    try {
      if (reaction.partial) await reaction.fetch();
      const map = lookup(reaction);
      if (!map) return;
      const guild = reaction.message.guild;
      if (!guild) return;
      const member = await guild.members.fetch(user.id).catch(() => null);
      if (member) await member.roles.add(map.role_id).catch(e =>
        logError(guild.id, '表情給身分組失敗（請確認機器人身分組在目標身分組之上）：', e.message));
    } catch (e) { logError(reaction.message && reaction.message.guildId, '表情身分組處理失敗：', e.message); }
  });

  client.on('messageReactionRemove', async (reaction, user) => {
    if (user.bot) return;
    try {
      if (reaction.partial) await reaction.fetch();
      const map = lookup(reaction);
      if (!map) return;
      const guild = reaction.message.guild;
      if (!guild) return;
      const member = await guild.members.fetch(user.id).catch(() => null);
      if (member) await member.roles.remove(map.role_id).catch(() => {});
    } catch (e) { logError(reaction.message && reaction.message.guildId, '表情身分組移除失敗：', e.message); }
  });

  console.log('  ↳ 表情身分組模組已載入（按表情取得/移除身分組）');
}

module.exports = { init, attach, emojiKey };
