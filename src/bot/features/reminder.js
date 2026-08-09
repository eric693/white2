const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const cron = require('node-cron');
const { db, getSetting } = require('../../db');
// reminder_logs / reminders 均已含 guild_id（隨提醒本身），排程遍歷全部提醒各自 guild
const { buildButtonRows } = require('../../util/components');
const { absUrl } = require('../../util/url');
const { parts } = require('../../util/time');
const { postToChannel } = require('../../util/post');

const csv = (s) => String(s || '').split(',').map(x => x.trim()).filter(Boolean);

function log(guildId, reminderId, status, error = '') {
  db.prepare('INSERT INTO reminder_logs (guild_id, reminder_id, status, error) VALUES (?, ?, ?, ?)').run(guildId || '', reminderId, status, error);
}

async function notifyAdmin(client, text) {
  const chId = getSetting('admin_channel');
  if (!chId) return;
  const ch = client.channels.cache.get(chId) || await client.channels.fetch(chId).catch(() => null);
  if (ch) ch.send(text).catch(() => {});
}

async function fire(client, r) {
  const ch = client.channels.cache.get(r.channel_id) || await client.channels.fetch(r.channel_id).catch(() => null);
  if (!ch) { log(r.guild_id, r.id, 'fail', '找不到頻道'); notifyAdmin(client, `提醒「${r.title || r.id}」發送失敗：找不到頻道 ${r.channel_id}`); return; }

  const users = csv(r.mention_ids), roles = csv(r.mention_role_ids);
  let mentionText = '';
  if (r.do_mention) {
    const parts2 = [];
    if (r.mention_everyone) parts2.push('@everyone');
    parts2.push(...users.map(id => `<@${id}>`), ...roles.map(id => `<@&${id}>`));
    mentionText = parts2.join(' ');
  }

  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle((r.title || '提醒'));
  if (r.message) embed.setDescription(r.message);
  if (r.image_url) embed.setImage(absUrl(r.image_url));
  if (r.link_url) embed.addFields({ name: '連結', value: r.link_url });

  // 多個連結按鈕（圖標＋文字；相容舊的單一按鈕欄位）
  const components = buildButtonRows(r.buttons, { label: r.btn_label, url: r.btn_url });

  try {
    await postToChannel(ch, {
      content: mentionText || undefined,
      embeds: [embed],
      components,
      allowedMentions: { parse: r.do_mention ? ['everyone', 'users', 'roles'] : [] }
    }, { title: r.title || '提醒' });
    log(r.guild_id, r.id, 'ok');
  } catch (e) {
    log(r.guild_id, r.id, 'fail', e.message);
    notifyAdmin(client, `提醒「${r.title || r.id}」發送失敗：${e.message}`);
  }
}

function shouldFire(r, p) {
  const hhmm = `${p.hh}:${p.mm}`;
  if (r.freq === 'once') {
    const nowMin = `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}T${p.hh}:${p.mm}`;
    return r.run_at && r.run_at.slice(0, 16) === nowMin;
  }
  if (r.at_time !== hhmm) return false;
  if (r.freq === 'daily') return true;
  if (r.freq === 'weekly') return r.at_dow === p.dow;
  if (r.freq === 'monthly') return r.at_dom === p.d;
  return false;
}

function init(client) {
  cron.schedule('* * * * *', async () => {
    const p = parts();
    const nowKey = `${p.y}-${p.mo}-${p.d}T${p.hh}:${p.mm}`;
    const rems = db.prepare('SELECT * FROM reminders WHERE enabled=1').all();
    for (const r of rems) {
      if (r.last_run === nowKey) continue;
      if (!shouldFire(r, p)) continue;
      await fire(client, r);
      db.prepare('UPDATE reminders SET last_run=? WHERE id=?').run(nowKey, r.id);
      if (r.freq === 'once') db.prepare('UPDATE reminders SET enabled=0 WHERE id=?').run(r.id);
    }
  }, { timezone: 'Asia/Taipei' });
  console.log('  ↳ 提醒模組已載入（多對象/圖片/按鈕/失敗通知）');
}

module.exports = { init };
