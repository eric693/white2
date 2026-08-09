// 關鍵字通知與警告系統（規格 5.1～5.18）
// 監聽訊息 → 命中規則 → 通知管理員（頻道/私訊）→ 視設定給警告 → 當日達門檻自動禁言
const { EmbedBuilder, MessageFlags} = require('discord.js');
const cron = require('node-cron');
const { db, guildConfig, logError } = require('../../db');
const { matchAny } = require('./keywords');

const csv = (s) => String(s || '').split(/[\n,]/).map(x => x.trim()).filter(Boolean);
const cfg = (gid) => guildConfig('warn_config', gid);

// Discord 禁言上限 28 天
const MAX_MUTE_MIN = 28 * 24 * 60;

// ---- 5.15 / 5.16 冷卻：以觸發紀錄判斷，重啟後仍有效 ----
function onCooldown(gid, ruleId, userId, seconds) {
  if (!seconds) return false;
  const row = db.prepare(
    `SELECT 1 FROM alert_logs WHERE guild_id = ? AND rule_id = ? AND user_id = ?
       AND created_at > datetime('now','localtime', ?) LIMIT 1`
  ).get(gid, ruleId, userId, `-${parseInt(seconds, 10)} seconds`);
  return !!row;
}

// 當日有效警告次數（5.11 隔天自動歸零）
function todayCount(gid, userId) {
  return db.prepare(
    `SELECT COUNT(*) AS n FROM warnings
      WHERE guild_id = ? AND user_id = ? AND active = 1 AND date(created_at) = date('now','localtime')`
  ).get(gid, userId).n;
}
// 歷史累計（5.10 不因改名/退出而消失）
function totalCount(gid, userId) {
  return db.prepare('SELECT COUNT(*) AS n FROM warnings WHERE guild_id = ? AND user_id = ? AND active = 1').get(gid, userId).n;
}

async function fetchChannel(client, id) {
  if (!id) return null;
  return client.channels.cache.get(id) || await client.channels.fetch(id).catch(() => null);
}

// ---- 5.5 通知內容 ----
function alertEmbed(rule, msg, matched, warnInfo) {
  const embed = new EmbedBuilder()
    .setColor(rule.warn ? 0xed4245 : 0xfaa61a)
    .setTitle(rule.warn ? '關鍵字警告觸發' : '關鍵字通知')
    .addFields(
      { name: '玩家', value: `${msg.author.tag}（<@${msg.author.id}>）`, inline: true },
      { name: 'Discord ID', value: `\`${msg.author.id}\``, inline: true },
      { name: '觸發時間', value: new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }), inline: false },
      { name: '觸發頻道', value: `<#${msg.channel.id}>`, inline: true },
      { name: '觸發關鍵字', value: `\`${matched}\``, inline: true },
      { name: '完整訊息', value: (msg.content || '').slice(0, 1000) || '（無文字內容）' }
    )
    .setFooter({ text: `規則：${rule.name || '未命名'}｜前往訊息：${msg.url}` });
  if (warnInfo) {
    embed.addFields({ name: '警告狀態', value: `本次已給予警告，當日累計 ${warnInfo.today} 次／歷史累計 ${warnInfo.total} 次` });
  }
  return embed;
}

async function notifyAdmins(client, rule, msg, matched, warnInfo) {
  const embed = alertEmbed(rule, msg, matched, warnInfo);
  const userIds = csv(rule.notify_user_ids);
  const roleIds = csv(rule.notify_role_ids);

  // 5.4 發送到管理頻道
  const ch = await fetchChannel(client, rule.notify_channel);
  if (ch) {
    const tags = [...userIds.map(id => `<@${id}>`), ...roleIds.map(id => `<@&${id}>`)].join(' ');
    await ch.send({
      content: tags || undefined,
      embeds: [embed],
      allowedMentions: { users: userIds, roles: roleIds }
    }).catch(e => logError(msg.guild && msg.guild.id, '通知管理頻道失敗：', e.message));
  }

  // 5.6 私訊通知指定管理員
  if (rule.notify_dm) {
    for (const id of userIds) {
      const user = await client.users.fetch(id).catch(() => null);
      if (user) await user.send({ embeds: [embed] }).catch(() => {});
    }
  }
}

// 分級處分：當日第 n 次警告該做什麼
// escalate=1：第1次禁言 punish1、第2次禁言 punish2、第3次起依 punish3_action（kick/mute/none）
// escalate=0：沿用舊制（累計達 threshold 次禁言 mute_minutes）
function punishFor(n, c) {
  if (!c.escalate) {
    return n >= (parseInt(c.threshold, 10) || 3)
      ? { type: 'mute', minutes: parseInt(c.mute_minutes, 10) || 60 } : null;
  }
  if (n === 1) return c.punish1_minutes > 0 ? { type: 'mute', minutes: c.punish1_minutes } : null;
  if (n === 2) return c.punish2_minutes > 0 ? { type: 'mute', minutes: c.punish2_minutes } : null;
  if (c.punish3_action === 'kick') return { type: 'kick' };
  if (c.punish3_action === 'mute') return { type: 'mute', minutes: c.punish3_minutes || 1440 };
  return null;
}

// 給玩家看的處分規則說明（顯示在警告通知底部）
function punishRuleText(c) {
  if (!c.escalate) return `當日累計達 ${c.threshold} 次將自動禁言（隔日歸零）`;
  const parts = [];
  if (c.punish1_minutes > 0) parts.push(`第 1 次禁言 ${c.punish1_minutes} 分`);
  if (c.punish2_minutes > 0) parts.push(`第 2 次禁言 ${c.punish2_minutes} 分`);
  parts.push(`第 3 次${c.punish3_action === 'kick' ? '踢出伺服器' : c.punish3_action === 'mute' ? `禁言 ${c.punish3_minutes} 分` : '通知管理員'}`);
  return '警告處分：' + parts.join('、') + '（隔日歸零）';
}

// ---- 5.11 / 5.12 自動禁言 ----
async function applyMute(client, member, username, count, minutesOverride) {
  const gid = member.guild.id;
  const c = cfg(gid);
  const minutes = Math.min(Math.max(parseInt(minutesOverride ?? c.mute_minutes, 10) || 60, 1), MAX_MUTE_MIN);
  const reason = `當日第 ${count} 次警告，自動禁言`;

  try { await member.timeout(minutes * 60 * 1000, reason); }
  catch (e) { logError(gid, '自動禁言失敗（請確認機器人有「管理成員逾時」權限且身分組高於對象）：', e.message); return null; }

  const info = db.prepare(
    `INSERT INTO mutes (guild_id, user_id, username, reason, minutes, warn_count, start_at, end_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now','localtime'), datetime('now','localtime', ?))`
  ).run(gid, member.id, username, reason, minutes, count, `+${minutes} minutes`);
  const mute = db.prepare('SELECT * FROM mutes WHERE id = ?').get(info.lastInsertRowid);

  const embed = new EmbedBuilder().setColor(0xed4245).setTitle('自動禁言')
    .addFields(
      { name: '玩家', value: `${username}（<@${member.id}>）`, inline: true },
      { name: 'Discord ID', value: `\`${member.id}\``, inline: true },
      { name: '禁言原因', value: reason },
      { name: '當日累計警告', value: `${count} 次`, inline: true },
      { name: '禁言時間', value: `${minutes} 分鐘`, inline: true },
      { name: '開始時間', value: mute.start_at, inline: true },
      { name: '預計解除時間', value: mute.end_at, inline: true }
    );

  const ch = await fetchChannel(client, c.notify_channel);
  if (ch) await ch.send({ embeds: [embed] }).catch(() => {});
  if (c.dm_member) await member.send({ embeds: [embed] }).catch(() => {});
  return mute;
}

// ---- 分級踢除 ----
async function applyKick(client, member, username, count) {
  const c = cfg(member.guild.id);
  const reason = `當日第 ${count} 次警告，自動踢出伺服器`;
  const embed = new EmbedBuilder().setColor(0xed4245).setTitle('自動踢除')
    .addFields(
      { name: '玩家', value: `${username}（\`${member.id}\`）`, inline: true },
      { name: '原因', value: reason },
      { name: '當日累計警告', value: `${count} 次`, inline: true }
    );
  // 先私訊再踢（踢了就私訊不到了）
  if (c.dm_member) {
    await member.send({
      embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('你已被踢出伺服器')
        .setDescription(`原因：${reason}\n如有疑問請聯繫管理員。`)]
    }).catch(() => {});
  }
  try { await member.kick(reason); }
  catch (e) { logError(member.guild.id, '自動踢除失敗（請確認機器人有「踢出成員」權限且身分組高於對象）：', e.message); return false; }

  const ch = await fetchChannel(client, c.notify_channel);
  if (ch) await ch.send({ embeds: [embed] }).catch(() => {});
  return true;
}

// 依當日次數執行對應處分（警告寫入後呼叫）
async function applyPunishment(client, member, username, today) {
  if (!member) return null;
  const gid = member.guild.id;
  const c = cfg(gid);
  const p = punishFor(today, c);
  if (!p) return null;
  if (p.type === 'kick') {
    const ok = await applyKick(client, member, username, today);
    return ok ? { type: 'kick' } : null;
  }
  const already = db.prepare(
    `SELECT 1 FROM mutes WHERE guild_id = ? AND user_id = ? AND active = 1 AND end_at > datetime('now','localtime') LIMIT 1`
  ).get(gid, member.id);
  if (already) return null;
  const mute = await applyMute(client, member, username, today, p.minutes);
  return mute ? { type: 'mute', minutes: p.minutes } : null;
}

// ---- 5.9 給警告並通知玩家 ----
async function giveWarning(client, msg, rule) {
  const gid = msg.guild.id;
  const reason = rule.warn_reason || rule.name || '違反伺服器規範';
  db.prepare(
    `INSERT INTO warnings (guild_id, user_id, username, reason, rule_id, source, content, channel_id)
     VALUES (?, ?, ?, ?, ?, 'auto', ?, ?)`
  ).run(gid, msg.author.id, msg.author.username, reason, rule.id, (msg.content || '').slice(0, 500), msg.channel.id);

  const today = todayCount(gid, msg.author.id);
  const total = totalCount(gid, msg.author.id);
  const c = cfg(gid);

  if (rule.notify_member) {
    const embed = new EmbedBuilder().setColor(0xfaa61a).setTitle('你收到一則警告')
      .setDescription(`原因：**${reason}**`)
      .addFields(
        { name: '當日累計警告', value: `${today} 次`, inline: true },
        { name: '歷史累計警告', value: `${total} 次`, inline: true }
      )
      .setFooter({ text: punishRuleText(c) });
    await msg.reply({ embeds: [embed], allowedMentions: { repliedUser: true } }).catch(() => {});
  }

  // 分級處分（第 1/2 次禁言、第 3 次踢除，依後台設定）
  await applyPunishment(client, msg.member, msg.author.username, today);

  return { today, total };
}

// ---- 手動警告（DC 指令 / 後台共用；走同樣的分級處分流程）----
async function manualWarn(client, member, reason, operator) {
  const gid = member.guild.id;
  db.prepare(
    `INSERT INTO warnings (guild_id, user_id, username, reason, source, operator)
     VALUES (?, ?, ?, ?, 'manual', ?)`
  ).run(gid, member.id, member.user.username, reason, operator);
  const today = todayCount(gid, member.id);
  const total = totalCount(gid, member.id);
  const c = cfg(gid);

  // 通知玩家
  const embed = new EmbedBuilder().setColor(0xfaa61a).setTitle('你收到一則警告')
    .setDescription(`原因：**${reason}**`)
    .addFields(
      { name: '當日累計警告', value: `${today} 次`, inline: true },
      { name: '歷史累計警告', value: `${total} 次`, inline: true }
    )
    .setFooter({ text: punishRuleText(c) });
  await member.send({ embeds: [embed] }).catch(() => {});

  const punished = await applyPunishment(client, member, member.user.username, today);
  return { today, total, punished };
}

// ---- 5.13 手動解除禁言（後台呼叫）----
async function releaseMute(client, muteId, operator) {
  const mute = db.prepare('SELECT * FROM mutes WHERE id = ?').get(muteId);
  if (!mute) throw new Error('找不到禁言紀錄');
  const guild = client.guilds.cache.get(mute.guild_id);
  const member = guild ? await guild.members.fetch(mute.user_id).catch(() => null) : null;
  if (member) await member.timeout(null, `由 ${operator} 手動解除`).catch(() => {});
  db.prepare(
    `UPDATE mutes SET active = 0, released_at = datetime('now','localtime'), released_by = ? WHERE id = ?`
  ).run(operator || '', muteId);

  const c = cfg(mute.guild_id);
  const ch = await fetchChannel(client, c.notify_channel);
  if (ch) {
    await ch.send({
      embeds: [new EmbedBuilder().setColor(0x3ba55d).setTitle('已解除禁言')
        .setDescription(`<@${mute.user_id}>（\`${mute.user_id}\`）由 **${operator || '管理員'}** 提前解除禁言。`)]
    }).catch(() => {});
  }
  if (member && c.dm_member) {
    await member.send('你的禁言已被管理員提前解除，請留意伺服器規範。').catch(() => {});
  }
}

function init(client) {
  // ---- DC 管理指令：/警告（新增/查詢/清除）、/解除禁言 ----
  client.on('interactionCreate', async (i) => {
    if (!i.isChatInputCommand() || !i.guild) return;
    if (!['警告', '解除禁言'].includes(i.commandName)) return;
    const gid = i.guild.id;
    if (!i.memberPermissions || !i.memberPermissions.has('ModerateMembers')) {
      return i.reply({ content: '僅具「管理成員逾時」權限的管理員可使用。', flags: MessageFlags.Ephemeral });
    }
    try {
      if (i.commandName === '解除禁言') {
        const user = i.options.getUser('玩家', true);
        const member = await i.guild.members.fetch(user.id).catch(() => null);
        if (!member) return i.reply({ content: '找不到該成員。', flags: MessageFlags.Ephemeral });
        await member.timeout(null, `由 ${i.user.username} 手動解除`);
        db.prepare(
          `UPDATE mutes SET active = 0, released_at = datetime('now','localtime'), released_by = ? WHERE guild_id = ? AND user_id = ? AND active = 1`
        ).run(i.user.username, gid, user.id);
        return i.reply(`已解除 <@${user.id}> 的禁言。`);
      }

      const sub = i.options.getSubcommand();
      const user = i.options.getUser('玩家', true);

      if (sub === '新增') {
        const reason = i.options.getString('原因') || '違反伺服器規範';
        const member = await i.guild.members.fetch(user.id).catch(() => null);
        if (!member) return i.reply({ content: '找不到該成員。', flags: MessageFlags.Ephemeral });
        await i.deferReply();
        const r = await manualWarn(client, member, reason, i.user.username);
        const done = r.punished
          ? (r.punished.type === 'kick' ? '，已自動踢出伺服器' : `，已自動禁言 ${r.punished.minutes} 分鐘`)
          : '';
        return i.editReply(`已警告 <@${user.id}>（${reason}）。當日第 ${r.today} 次、歷史累計 ${r.total} 次${done}。`);
      }

      if (sub === '查詢') {
        const rows = db.prepare(
          'SELECT * FROM warnings WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT 15'
        ).all(gid, user.id);
        const today = todayCount(gid, user.id), total = totalCount(gid, user.id);
        const embed = new EmbedBuilder().setColor(0xfaa61a)
          .setTitle(`${user.username} 的警告紀錄`)
          .setDescription(rows.length
            ? rows.map(w => `\`${w.created_at}\` ${w.reason}${w.active ? '' : '（已撤銷）'}${w.source === 'manual' ? `｜${w.operator}` : ''}`).join('\n')
            : '（沒有警告紀錄）')
          .setFooter({ text: `當日 ${today} 次｜歷史累計 ${total} 次` });
        return i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      }

      if (sub === '清除') {
        db.prepare('UPDATE warnings SET active = 0 WHERE guild_id = ? AND user_id = ?').run(gid, user.id);
        return i.reply(`已清除 <@${user.id}> 的全部有效警告（紀錄保留）。`);
      }
    } catch (e) {
      const msg2 = '' + e.message;
      if (i.deferred || i.replied) i.editReply(msg2).catch(() => {});
      else i.reply({ content: msg2, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  });

  client.on('messageCreate', async (msg) => {
    if (msg.author.bot || !msg.guild) return;
    const content = msg.content || '';
    if (!content) return;
    const gid = msg.guild.id;

    const rules = db.prepare('SELECT * FROM alert_rules WHERE guild_id = ? AND enabled = 1').all(gid);
    for (const rule of rules) {
      const chans = csv(rule.channels);
      if (chans.length && !chans.includes(msg.channel.id)) continue;
      const matched = matchAny(content, rule.keyword, rule.match_type);
      if (!matched) continue;
      // 5.16 冷卻內不重複通知、不重複給警告
      if (onCooldown(gid, rule.id, msg.author.id, rule.cooldown)) continue;

      try {
        let warnInfo = null;
        if (rule.warn) warnInfo = await giveWarning(client, msg, rule);

        db.prepare(
          `INSERT INTO alert_logs (guild_id, rule_id, rule_name, matched, user_id, username, channel_id, message, warned)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(gid, rule.id, rule.name || '', matched, msg.author.id, msg.author.username,
          msg.channel.id, content.slice(0, 1000), rule.warn ? 1 : 0);

        await notifyAdmins(client, rule, msg, matched, warnInfo);
      } catch (e) {
        logError(gid, '關鍵字通知處理失敗：', e.message);
      }
    }
  });

  // 5.13 禁言時間到 → 標記為已解除（Discord 逾時本身會自動失效）
  cron.schedule('* * * * *', () => {
    try {
      db.prepare(
        `UPDATE mutes SET active = 0, released_at = datetime('now','localtime')
          WHERE active = 1 AND end_at != '' AND end_at <= datetime('now','localtime')`
      ).run();
    } catch (e) { console.error('禁言到期檢查失敗：', e.message); }
  });

  client._releaseMute = (id, operator) => releaseMute(client, id, operator);
  client._muteMember = async (gid, userId, minutes, reason, operator) => {
    const guild = client.guilds.cache.get(gid);
    if (!guild) throw new Error('找不到伺服器');
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) throw new Error('找不到該成員');
    const mins = Math.min(Math.max(parseInt(minutes, 10) || 60, 1), MAX_MUTE_MIN);
    await member.timeout(mins * 60 * 1000, reason || `由 ${operator} 手動禁言`);
    const info = db.prepare(
      `INSERT INTO mutes (guild_id, user_id, username, reason, minutes, start_at, end_at)
       VALUES (?, ?, ?, ?, ?, datetime('now','localtime'), datetime('now','localtime', ?))`
    ).run(gid, userId, member.user.username, reason || `由 ${operator} 手動禁言`, mins, `+${mins} minutes`);
    return info.lastInsertRowid;
  };

  console.log('  ↳ 關鍵字通知與警告模組已載入（通知/警告/自動禁言）');
}

module.exports = { init, todayCount, totalCount, manualWarn };
