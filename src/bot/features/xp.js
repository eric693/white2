// 聊天經驗值系統：發言得 XP → 升級 → 自動給對應身分組
const { EmbedBuilder, AttachmentBuilder, MessageFlags} = require('discord.js');
const { db, guildConfig, logError } = require('../../db');
const { brandColor } = require('../../util/brand');
const { makeRankCard } = require('../../util/rankcard');

const cfg = (gid) => guildConfig('xp_config', gid);
const csv = (s) => String(s || '').split(/[\n,]/).map(x => x.trim()).filter(Boolean);

// 升到下一級所需 XP（MEE6 同款公式）
const needFor = (lvl) => 5 * lvl * lvl + 50 * lvl + 100;

// 總 XP → 等級
function levelOf(xp) {
  let lvl = 0, rest = xp;
  while (rest >= needFor(lvl)) { rest -= needFor(lvl); lvl++; }
  return { level: lvl, into: rest, need: needFor(lvl) };
}

// 玩家目前名次（限該伺服器）
function rankOf(gid, userId) {
  const rows = db.prepare('SELECT user_id FROM user_xp WHERE guild_id = ? ORDER BY xp DESC').all(gid);
  const idx = rows.findIndex(r => r.user_id === userId);
  return idx < 0 ? rows.length + 1 : idx + 1;
}

// 升級後套用等級身分組（remove_prev 時移除其他等級身分組）
async function applyLevelRoles(gid, member, level) {
  const c = cfg(gid);
  const all = db.prepare('SELECT * FROM level_roles WHERE guild_id = ? ORDER BY level').all(gid);
  if (!all.length) return null;
  // 找出玩家目前等級應得的最高等級身分組
  const target = [...all].reverse().find(r => level >= r.level);
  if (!target) return null;
  try {
    if (!member.roles.cache.has(target.role_id)) await member.roles.add(target.role_id);
    if (c.remove_prev) {
      for (const r of all) {
        if (r.role_id !== target.role_id && member.roles.cache.has(r.role_id)) {
          await member.roles.remove(r.role_id).catch(() => {});
        }
      }
    }
    return target;
  } catch (e) {
    logError(gid, '等級身分組發放失敗（請確認機器人身分組位階）：', e.message);
    return null;
  }
}

function init(client) {
  client.on('messageCreate', async (msg) => {
    if (msg.author.bot || !msg.guild) return;
    const gid = msg.guild.id;
    const c = cfg(gid);
    if (!c.enabled) return;
    if (csv(c.ignore_channels).includes(msg.channel.id)) return;

    const now = Math.floor(Date.now() / 1000);
    const row = db.prepare('SELECT * FROM user_xp WHERE guild_id = ? AND user_id = ?').get(gid, msg.author.id);
    if (row && now - row.last_at < (c.cooldown || 60)) {
      // 冷卻中：只累計訊息數
      db.prepare('UPDATE user_xp SET msg_count = msg_count + 1, username = ? WHERE guild_id = ? AND user_id = ?')
        .run(msg.author.username, gid, msg.author.id);
      return;
    }

    const gain = Math.floor(Math.random() * (Math.max(c.max_xp, c.min_xp) - c.min_xp + 1)) + c.min_xp;
    const newXp = (row ? row.xp : 0) + gain;
    const before = row ? row.level : 0;
    const { level } = levelOf(newXp);

    db.prepare(
      `INSERT INTO user_xp (guild_id, user_id, username, xp, level, msg_count, last_at) VALUES (?,?,?,?,?,1,?)
       ON CONFLICT(guild_id, user_id) DO UPDATE SET username=excluded.username, xp=?, level=?, msg_count=msg_count+1, last_at=?`
    ).run(gid, msg.author.id, msg.author.username, newXp, level, now, newXp, level, now);

    // 升級了
    if (level > before) {
      const target = msg.member ? await applyLevelRoles(gid, msg.member, level) : null;
      const text = String(c.levelup_message || '')
        .replace(/{user}/g, `<@${msg.author.id}>`)
        .replace(/{username}/g, msg.author.username)
        .replace(/{level}/g, String(level));
      const ch = c.levelup_channel
        ? (client.channels.cache.get(c.levelup_channel) || await client.channels.fetch(c.levelup_channel).catch(() => null)) || msg.channel
        : msg.channel;
      // allowedMentions 只放升級的本人：身分組名稱照樣顯示成彩色標籤，
      // 但不會真的去通知該身分組的每一個成員（否則每有人升級就全體被 tag）。
      ch.send({
        content: text + (target ? `　已獲得 <@&${target.role_id}> 身分組！` : ''),
        allowedMentions: { users: [msg.author.id] }
      }).catch(() => {});
    }
  });

  client.on('interactionCreate', async (i) => {
    if (!i.isChatInputCommand() || !i.guild) return;
    const gid = i.guild.id;

    if (i.commandName === '等級') {
      const target = i.options.getUser('玩家') || i.user;
      const row = db.prepare('SELECT * FROM user_xp WHERE guild_id = ? AND user_id = ?').get(gid, target.id);
      if (!row) return i.reply({ content: `${target.username} 還沒有任何經驗值，快去聊天吧！`, flags: MessageFlags.Ephemeral });
      const { level, into, need } = levelOf(row.xp);
      const rank = rankOf(gid, target.id);
      await i.deferReply();
      // 產生 MEE6 風格等級卡圖
      const member = i.guild.members.cache.get(target.id) || await i.guild.members.fetch(target.id).catch(() => null);
      try {
        const buf = await makeRankCard({
          username: (member && member.displayName) || target.username,
          avatarUrl: (member || target).displayAvatarURL({ extension: 'png', size: 256 }),
          level, rank, xpInto: into, xpNeed: need, totalXp: row.xp,
          status: (member && member.presence && member.presence.status) || 'online',
          bgUrl: cfg(gid).card_bg || '',
          barColor: '#' + (brandColor() >>> 0).toString(16).padStart(6, '0').slice(-6)
        });
        return i.editReply({ files: [new AttachmentBuilder(buf, { name: 'rank.png' })] });
      } catch (e) {
        // 卡片產生失敗 → 退回文字，不讓指令整個掛掉
        logError(gid, '等級卡產生失敗：', e.message);
        const bar = '█'.repeat(Math.round(into / need * 12)).padEnd(12, '░');
        const embed = new EmbedBuilder().setColor(brandColor())
          .setTitle(`${target.username} 的等級`)
          .setDescription(`**等級 ${level}**　排名 #${rank}\n\`${bar}\` ${into}/${need} XP\n總經驗值 ${row.xp}｜累計發言 ${row.msg_count} 則`)
          .setThumbnail(target.displayAvatarURL());
        return i.editReply({ embeds: [embed] });
      }
    }

    if (i.commandName === '排行') {
      const rows = db.prepare('SELECT * FROM user_xp WHERE guild_id = ? ORDER BY xp DESC LIMIT 10').all(gid);
      if (!rows.length) return i.reply({ content: '還沒有任何經驗值紀錄。', flags: MessageFlags.Ephemeral });
      
      const embed = new EmbedBuilder().setColor(brandColor()).setTitle('聊天等級排行榜')
        .setDescription(rows.map((r, n) =>
          `\`${n + 1}.\` **${r.username || '未知玩家'}**　等級 ${r.level}　${r.xp} XP`).join('\n'));
      return i.reply({ embeds: [embed] });
    }
  });

  console.log('  ↳ 經驗值模組已載入（聊天得 XP/升級身分組/排行）');
}

module.exports = { init, levelOf };
