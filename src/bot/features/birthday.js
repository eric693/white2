// 生日驗證（6.2）與生日慶生系統（10.1～10.8）
const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags} = require('discord.js');
const cron = require('node-cron');
const { db, guildConfig, activeGuildIds, logError } = require('../../db');
const { parts } = require('../../util/time');

const verifyCfg = (gid) => guildConfig('verify_config', gid);
const bdayCfg = (gid) => guildConfig('birthday_config', gid);

function calcAge(y, m, d) {
  const today = new Date();
  let age = today.getFullYear() - y;
  const md = (today.getMonth() + 1) * 100 + today.getDate();
  if (md < m * 100 + d) age--;
  return age;
}

const fillBtn = (label = '填寫生日') => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('bday_verify').setLabel(label).setStyle(ButtonStyle.Primary));

// 6.2 發布驗證面板
async function postVerifyPanel(client, channelId, gid) {
  const c = verifyCfg(gid);
  const ch = client.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
  if (!ch) throw new Error('找不到頻道');
  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('年齡驗證').setDescription(c.prompt_text);
  await ch.send({ embeds: [embed], components: [fillBtn('填寫生日並驗證')] });
}

// 10.3 發布生日填寫面板（給已在群內的成員）
async function postBirthdayPanel(client, channelId, gid) {
  const c = bdayCfg(gid);
  const ch = client.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
  if (!ch) throw new Error('找不到頻道');
  const embed = new EmbedBuilder().setColor(0xeb459e).setTitle('生日資料登記')
    .setDescription(c.remind_text || '點下方按鈕填寫你的生日，生日當天會收到專屬祝福！');
  await ch.send({ embeds: [embed], components: [fillBtn('填寫 / 修改生日')] });
}

function saveBirthday(gid, user, y, m, d, operator = '') {
  const old = db.prepare('SELECT * FROM birthdays WHERE guild_id = ? AND user_id = ?').get(gid, user.id);
  db.prepare(
    `INSERT INTO birthdays (guild_id, user_id, username, birth_y, birth_m, birth_d)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET username=excluded.username, birth_y=excluded.birth_y,
       birth_m=excluded.birth_m, birth_d=excluded.birth_d`
  ).run(gid, user.id, user.username, y, m, d);
  db.prepare(
    `INSERT INTO birthday_history (guild_id, user_id, username, action, old_value, new_value, operator)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(gid, user.id, user.username, old ? 'update' : 'set',
    old ? `${old.birth_y}/${old.birth_m}/${old.birth_d}` : '', `${y}/${m}/${d}`, operator);
}

function init(client) {
  // 新成員加入 → 驗證提示。
  // Discord 沒辦法在頻道裡發「只有某一個人看得到」的訊息（ephemeral 只能是互動的回覆），
  // 所以預設改用私訊；私訊被關閉時才退回頻道，並在設定的秒數後自動刪掉，避免累積洗版。
  client.on('guildMemberAdd', async (member) => {
    const c = verifyCfg(member.guild.id);
    if (!c.enabled) return;
    const mode = c.join_prompt_mode || 'dm';
    if (mode === 'panel') return;          // 只靠驗證頻道的常駐面板，不主動發

    const payload = { content: c.prompt_text, components: [fillBtn('填寫生日並驗證')] };

    // 一律優先「私訊本人」＝真正只有本人看得到。Discord 無法在頻道發只有某人看得到的訊息，
    // 所以私訊失敗時不再公開 @ 對方洗版，改由驗證頻道的常駐面板讓他自己點。
    const dmOk = await member.send(payload).then(() => true).catch(() => false);
    if (dmOk) return;
    // 只有在管理員刻意選「頻道公開提示」模式時，才退回頻道公開發（並於設定秒數後自動刪）
    if (mode !== 'channel') return;
    if (!c.verify_channel) return;
    const ch = client.channels.cache.get(c.verify_channel) || await client.channels.fetch(c.verify_channel).catch(() => null);
    if (!ch) return;
    const msg = await ch.send({ content: `<@${member.id}> ${c.prompt_text}`, components: [fillBtn('填寫生日並驗證')] }).catch(() => null);
    const ttl = Number(c.prompt_delete_sec) || 0;
    if (msg && ttl > 0) setTimeout(() => msg.delete().catch(() => {}), ttl * 1000);
  });

  client.on('interactionCreate', async (i) => {
    if (i.isButton() && i.customId === 'bday_verify') {
      const modal = new ModalBuilder().setCustomId('bday_modal').setTitle('生日資料');
      const y = new TextInputBuilder().setCustomId('y').setLabel('出生年（西元，如 2000）').setStyle(TextInputStyle.Short).setMinLength(4).setMaxLength(4).setRequired(true);
      const m = new TextInputBuilder().setCustomId('m').setLabel('出生月（1-12）').setStyle(TextInputStyle.Short).setMaxLength(2).setRequired(true);
      const d = new TextInputBuilder().setCustomId('d').setLabel('出生日（1-31）').setStyle(TextInputStyle.Short).setMaxLength(2).setRequired(true);
      modal.addComponents(
        new ActionRowBuilder().addComponents(y),
        new ActionRowBuilder().addComponents(m),
        new ActionRowBuilder().addComponents(d)
      );
      return i.showModal(modal).catch(() => {});
    }

    if (i.isModalSubmit() && i.customId === 'bday_modal') {
      if (!i.guild) return;
      try {
        const gid = i.guild.id;
        const c = verifyCfg(gid);
        const y = parseInt(i.fields.getTextInputValue('y'), 10);
        const m = parseInt(i.fields.getTextInputValue('m'), 10);
        const d = parseInt(i.fields.getTextInputValue('d'), 10);
        const daysInMonth = new Date(y, m, 0).getDate();
        if (!y || !m || !d || m < 1 || m > 12 || d < 1 || d > daysInMonth || y < 1900 || y > new Date().getFullYear()) {
          return i.reply({ content: '生日格式不正確，請重新點按鈕填寫。', flags: MessageFlags.Ephemeral }).catch(() => {});
        }
        const age = calcAge(y, m, d);

        // 6.2 年齡驗證（僅在啟用驗證時擋人）
        if (c.enabled && age < c.min_age) {
          await i.reply({ content: `很抱歉，本伺服器僅開放滿 ${c.min_age} 歲者加入。`, flags: MessageFlags.Ephemeral }).catch(() => {});
          if (c.kick_underage && i.member) {
            setTimeout(() => i.member.kick(`未滿 ${c.min_age} 歲，生日驗證未通過`).catch(() => {}), 1500);
          }
          return;
        }

        saveBirthday(gid, i.user, y, m, d);
        if (c.enabled && c.pass_role && i.member) await i.member.roles.add(c.pass_role).catch(() => {});
        await i.reply({
          content: c.enabled ? `驗證通過（${age} 歲），歡迎加入！生日資料已登記。` : `生日已登記為 ${y}/${m}/${d}，生日當天見！`,
          flags: MessageFlags.Ephemeral
        });
      } catch (e) {
        logError(i.guild && i.guild.id, '生日登記失敗：', e && e.stack ? e.stack : e);
        if (!i.replied && !i.deferred) i.reply({ content: '登記時發生錯誤，請稍後再試一次。', flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      return;
    }
  });

  // 10.4 每分鐘跑一次；由各伺服器自己的 send_time 決定要不要發（多伺服器各自獨立）
  cron.schedule('* * * * *', () => {
    runBirthdayCheck(client).catch(e => console.error('慶生檢查失敗：', e.message));
  }, { timezone: 'Asia/Taipei' });

  // 10.2 每天中午檢查未填生日的成員並提醒
  cron.schedule('0 12 * * *', () => {
    remindMissing(client).catch(e => console.error('生日提醒失敗：', e.message));
  }, { timezone: 'Asia/Taipei' });

  client._postVerifyPanel = (chId, gid) => postVerifyPanel(client, chId, gid);
  client._postBirthdayPanel = (chId, gid) => postBirthdayPanel(client, chId, gid);
  client._runBirthdayCheck = () => runBirthdayCheck(client, true);
  console.log('  ↳ 生日驗證/慶生模組已載入（填寫提醒/發送去重/異動紀錄）');
}

// 10.4 / 10.6 生日祝福（遍歷所有伺服器）。force=true 時略過時間檢查（後台「立即發送」用）
async function runBirthdayCheck(client, force = false) {
  for (const gid of activeGuildIds()) await runBirthdayCheckGuild(client, gid, force).catch(() => {});
}
async function runBirthdayCheckGuild(client, gid, force = false) {
  const c = bdayCfg(gid);
  if (!c.enabled || !c.channel) return;
  // 每台伺服器用自己的發送時間；非強制時，時間沒到就跳過
  if (!force) {
    const now = parts();
    if (`${now.hh}:${now.mm}` !== (c.send_time || '09:00')) return;
  }
  const guild = client.guilds.cache.get(gid);
  const ch = client.channels.cache.get(c.channel) || await client.channels.fetch(c.channel).catch(() => null);
  if (!ch || !guild) return;

  const today = new Date();
  const tm = today.getMonth() + 1, td = today.getDate(), ty = today.getFullYear();
  const stars = db.prepare('SELECT * FROM birthdays WHERE guild_id = ? AND birth_m = ? AND birth_d = ?').all(gid, tm, td);

  // 移除昨天壽星的身分組
  if (c.birthday_role) {
    try {
      await guild.members.fetch();
      for (const [, mem] of guild.members.cache) {
        if (mem.roles.cache.has(c.birthday_role) && !stars.find(s => s.user_id === mem.id)) {
          await mem.roles.remove(c.birthday_role).catch(() => {});
        }
      }
    } catch {}
  }

  for (const s of stars) {
    // 10.6 同一年度只發一次
    const sent = db.prepare('SELECT 1 FROM birthday_sends WHERE guild_id=? AND user_id=? AND year=?').get(gid, s.user_id, ty);
    if (sent) continue;

    const msg = String(c.message || '').replace(/{user}/g, `<@${s.user_id}>`).replace(/{username}/g, s.username);
    const embed = new EmbedBuilder().setColor(0xeb459e).setDescription(msg);
    if (c.reward_text) embed.addFields({ name: '生日禮', value: c.reward_text });
    await ch.send({
      content: c.mention_star ? `<@${s.user_id}>` : undefined,
      embeds: [embed]
    }).catch(() => {});

    db.prepare('INSERT OR IGNORE INTO birthday_sends (guild_id, user_id, year) VALUES (?, ?, ?)').run(gid, s.user_id, ty);

    if (c.birthday_role) {
      const mem = guild.members.cache.get(s.user_id) || await guild.members.fetch(s.user_id).catch(() => null);
      if (mem) await mem.roles.add(c.birthday_role).catch(() => {});
    }
  }
}

// 10.2 提醒尚未填寫生日的成員（持續提醒，填完自動停止；遍歷所有伺服器）
async function remindMissing(client) {
  for (const gid of activeGuildIds()) await remindMissingGuild(client, gid).catch(() => {});
}
async function remindMissingGuild(client, gid) {
  const c = bdayCfg(gid);
  if (!c.remind_enabled) return;
  const guild = client.guilds.cache.get(gid);
  if (!guild) return;

  // 每隔 remind_days 天才提醒一次
  const days = Math.max(1, c.remind_days || 3);
  const daySeq = Math.floor(Date.now() / 86400000);
  if (daySeq % days !== 0) return;

  await guild.members.fetch().catch(() => {});
  const have = new Set(db.prepare('SELECT user_id FROM birthdays WHERE guild_id = ?').all(gid).map(r => r.user_id));
  const missing = guild.members.cache.filter(m =>
    !m.user.bot && !have.has(m.id) && (!c.remind_role || m.roles.cache.has(c.remind_role)));
  if (!missing.size) return;

  // 頻道公告（一則訊息標記所有未填的人）
  if (c.remind_mode === 'channel' || c.remind_mode === 'both') {
    const ch = c.remind_channel
      ? (client.channels.cache.get(c.remind_channel) || await client.channels.fetch(c.remind_channel).catch(() => null))
      : null;
    if (ch) {
      const mentions = missing.map(m => `<@${m.id}>`).slice(0, 50).join(' ');
      const embed = new EmbedBuilder().setColor(0xfaa61a).setTitle('還沒填寫生日資料')
        .setDescription(c.remind_text);
      await ch.send({ content: mentions, embeds: [embed], components: [fillBtn('填寫生日')] }).catch(() => {});
    }
  }
  // 私訊提醒
  if (c.remind_mode === 'dm' || c.remind_mode === 'both') {
    for (const [, m] of missing) {
      const embed = new EmbedBuilder().setColor(0xfaa61a).setTitle('生日資料提醒').setDescription(c.remind_text);
      await m.send({ embeds: [embed], components: [fillBtn('填寫生日')] }).catch(() => {});
    }
  }
  console.log(`  ↳ 已提醒 ${missing.size} 位尚未填寫生日的成員`);
}

module.exports = { init, calcAge, runBirthdayCheck, remindMissing, saveBirthday };
