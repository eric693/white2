const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags} = require('discord.js');
const cron = require('node-cron');
const { db } = require('../../db');
const { localNowMinute, toUnix, nowUnix } = require('../../util/time');
const { tempReply } = require('../../util/ephemeral');

const EMOJI = ['1\uFE0F\u20E3', '2\uFE0F\u20E3', '3\uFE0F\u20E3', '4\uFE0F\u20E3', '5\uFE0F\u20E3', '6\uFE0F\u20E3', '7\uFE0F\u20E3', '8\uFE0F\u20E3', '9\uFE0F\u20E3', '\uD83D\uDD1F'];

const getPoll = (id) => db.prepare('SELECT * FROM polls WHERE id = ?').get(id);
const options = (poll) => { try { return JSON.parse(poll.options); } catch { return []; } };
const csv = (s) => String(s || '').split(',').map(x => x.trim()).filter(Boolean);

function buildEmbed(poll) {
  const opts = options(poll);
  const showResults = poll.closed || !poll.hide_results; // 2.6 結束後才公開 or 即時
  const votes = db.prepare('SELECT option_index, COUNT(*) n FROM poll_votes WHERE poll_id=? GROUP BY option_index').all(poll.id);
  const counts = {}; votes.forEach(v => counts[v.option_index] = v.n);
  const totalVoters = db.prepare('SELECT COUNT(DISTINCT user_id) c FROM poll_votes WHERE poll_id=?').get(poll.id).c;
  const total = votes.reduce((a, v) => a + v.n, 0);

  const lines = opts.map((o, idx) => {
    if (!showResults) return `${EMOJI[idx]} **${o}**`;
    const n = counts[idx] || 0;
    const pct = total ? Math.round(n / total * 100) : 0;
    const bar = '█'.repeat(Math.round(pct / 10)).padEnd(10, '░');
    let line = `${EMOJI[idx]} **${o}**\n\`${bar}\` ${n} 票 (${pct}%)`;
    if (!poll.anonymous) {
      const voters = db.prepare('SELECT user_id FROM poll_votes WHERE poll_id=? AND option_index=?').all(poll.id, idx);
      if (voters.length) line += '\n' + voters.map(v => `<@${v.user_id}>`).join(' ');
    }
    return line;
  });

  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(poll.question);
  const desc = [];
  if (poll.description) desc.push(poll.description);
  if (poll.note) desc.push(`_${poll.note}_`);
  desc.push(lines.join('\n\n'));
  if (!showResults) desc.push(`\n結果將於投票結束後公開　目前 ${totalVoters} 人已投票`);
  const startU = toUnix(poll.start_at), endU = toUnix(poll.deadline);
  if (!poll.closed && !poll.started && startU) desc.push(`\n尚未開始 — <t:${startU}:R> 開始`);
  else if (!poll.closed && endU) desc.push(`\n截止：<t:${endU}:F>（倒數 <t:${endU}:R>）`);
  embed.setDescription(desc.join('\n'));

  const flags = [poll.multi ? '複選' : '單選', poll.anonymous ? '匿名' : '公開'];
  if (csv(poll.allowed_roles).length) flags.push('限定身分組');
  if (poll.allow_change && !poll.closed) flags.push('可修改');
  embed.setFooter({ text: flags.join(' · ') + (poll.closed ? ' · 已結束' : '') });
  return embed;
}

function buildRows(poll) {
  const opts = options(poll);
  const disabled = !!poll.closed || !poll.started;
  const rows = [];
  for (let i = 0; i < opts.length; i += 5) {
    const row = new ActionRowBuilder();
    for (let j = i; j < Math.min(i + 5, opts.length); j++) {
      row.addComponents(new ButtonBuilder()
        .setCustomId(`poll:${poll.id}:${j}`).setLabel(EMOJI[j]).setStyle(ButtonStyle.Secondary).setDisabled(disabled));
    }
    rows.push(row);
  }
  return rows;
}

async function channelOf(client, poll) {
  return client.channels.cache.get(poll.channel_id) || await client.channels.fetch(poll.channel_id).catch(() => null);
}
async function postPoll(client, poll) {
  const ch = await channelOf(client, poll);
  if (!ch) throw new Error('找不到頻道');
  const msg = await ch.send({ embeds: [buildEmbed(poll)], components: buildRows(poll) });
  db.prepare('UPDATE polls SET message_id=? WHERE id=?').run(msg.id, poll.id);
  return msg.id;
}
async function refresh(client, poll) {
  if (!poll.message_id) return;
  const ch = await channelOf(client, poll);
  if (!ch) return;
  const msg = await ch.messages.fetch(poll.message_id).catch(() => null);
  if (msg) await msg.edit({ embeds: [buildEmbed(poll)], components: buildRows(poll) }).catch(() => {});
}
async function closePoll(client, id) {
  db.prepare('UPDATE polls SET closed=1 WHERE id=?').run(id);
  await refresh(client, getPoll(id));
}

function init(client) {
  // ---- /投票 指令：管理員直接在 DC 建立投票 ----
  client.on('interactionCreate', async (i) => {
    if (!i.isChatInputCommand() || i.commandName !== '投票' || !i.guild) return;
    if (!i.memberPermissions || !i.memberPermissions.has('ManageGuild')) {
      return i.reply({ content: '僅管理員可建立投票。', flags: MessageFlags.Ephemeral });
    }
    try {
      const question = i.options.getString('題目', true);
      const note = i.options.getString('備註') || '';
      const raw = i.options.getString('選項', true);
      const opts = raw.split(/[,，\n]/).map(s => s.trim()).filter(Boolean).slice(0, 10);
      if (opts.length < 2) return i.reply({ content: '至少要有 2 個選項（用逗號分隔）。', flags: MessageFlags.Ephemeral });

      const ch = i.options.getChannel('頻道') || i.channel;
      const multi = i.options.getBoolean('複選') || false;
      const anonymous = i.options.getBoolean('匿名') || false;
      const durStr = i.options.getString('持續時間') || '';

      let deadline = '';
      if (durStr) {
        const m = String(durStr).trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(m|min|分|分鐘|h|hr|時|小時|d|天)?$/);
        if (!m) return i.reply({ content: '持續時間格式不對，例如 `30m`、`2h`、`1d`。', flags: MessageFlags.Ephemeral });
        const n = parseFloat(m[1]);
        const unit = m[2] || 'm';
        const mins = /^(h|hr|時|小時)$/.test(unit) ? n * 60 : /^(d|天)$/.test(unit) ? n * 1440 : n;
        const end = new Date(Date.now() + mins * 60000);
        const tz = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(end);
        deadline = tz.replace(' ', 'T');
      }

      const info = db.prepare(
        `INSERT INTO polls (guild_id, question, description, note, options, multi, anonymous, allowed_roles,
           allow_change, hide_results, channel_id, start_at, deadline, started, creator)
         VALUES (?, ?, '', ?, ?, ?, ?, '', 1, 0, ?, '', ?, 1, ?)`
      ).run(i.guild.id, question, note, JSON.stringify(opts), multi ? 1 : 0, anonymous ? 1 : 0,
        ch.id, deadline, (i.member && i.member.displayName) || i.user.globalName || i.user.username);
      const poll = getPoll(info.lastInsertRowid);
      await postPoll(client, poll);
      return i.reply({ content: `投票已建立於 <#${ch.id}>${deadline ? `，將於 ${deadline.replace('T', ' ')} 截止` : ''}。`, flags: MessageFlags.Ephemeral });
    } catch (e) {
      const msg = '建立失敗：' + e.message;
      if (i.replied || i.deferred) i.editReply(msg).catch(() => {});
      else i.reply({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  });

  client.on('interactionCreate', async (i) => {
    if (!i.isButton() || !i.customId.startsWith('poll:')) return;
    const [, pid, idx] = i.customId.split(':');
    const poll = getPoll(pid);
    if (!poll || poll.closed) return i.reply({ content: '此投票已結束。', flags: MessageFlags.Ephemeral }).catch(() => {});
    if (!poll.started) return i.reply({ content: '投票尚未開始。', flags: MessageFlags.Ephemeral }).catch(() => {});
    const endU = toUnix(poll.deadline);
    if (endU && nowUnix() >= endU) return i.reply({ content: '投票已截止。', flags: MessageFlags.Ephemeral }).catch(() => {});

    // 2.4 限定身分組
    const allowed = csv(poll.allowed_roles);
    if (allowed.length) {
      const member = i.member;
      const ok = member && allowed.some(r => member.roles.cache.has(r));
      if (!ok) return i.reply({ content: '您沒有參與此投票的資格。', flags: MessageFlags.Ephemeral }).catch(() => {});
    }

    const optIdx = parseInt(idx, 10);
    const hasThis = db.prepare('SELECT 1 FROM poll_votes WHERE poll_id=? AND user_id=? AND option_index=?').get(pid, i.user.id, optIdx);
    const votedAny = db.prepare('SELECT 1 FROM poll_votes WHERE poll_id=? AND user_id=?').get(pid, i.user.id);

    // 2.5 不允許修改：已投過就不能改
    if (!poll.allow_change && votedAny) {
      return i.reply({ content: '您已投過票，此投票不開放修改。', flags: MessageFlags.Ephemeral }).catch(() => {});
    }

    const opts = options(poll);
    if (poll.multi) {
      if (hasThis) db.prepare('DELETE FROM poll_votes WHERE poll_id=? AND user_id=? AND option_index=?').run(pid, i.user.id, optIdx);
      else db.prepare('INSERT INTO poll_votes (guild_id, poll_id, user_id, option_index) VALUES (?,?,?,?)').run(i.guild.id, pid, i.user.id, optIdx);
    } else {
      db.prepare('DELETE FROM poll_votes WHERE poll_id=? AND user_id=?').run(pid, i.user.id);
      if (!hasThis) db.prepare('INSERT INTO poll_votes (guild_id, poll_id, user_id, option_index) VALUES (?,?,?,?)').run(i.guild.id, pid, i.user.id, optIdx);
    }
    // 告知玩家目前投給了哪些選項（避免匿名投票時自己也不知道投了啥）
    const myVotes = db.prepare('SELECT option_index FROM poll_votes WHERE poll_id=? AND user_id=? ORDER BY option_index').all(pid, i.user.id);
    const myPicks = myVotes.map(v => opts[v.option_index]).filter(Boolean);
    const tip = myPicks.length
      ? `你目前投給：**${myPicks.join('、')}**` + (poll.allow_change ? '（可再點按鈕修改）' : '')
      : '你已取消投票。';
    await tempReply(i, tip, 6);
    await refresh(client, getPoll(pid));
  });

  cron.schedule('* * * * *', async () => {
    const now = localNowMinute();
    const toStart = db.prepare("SELECT * FROM polls WHERE started=0 AND closed=0 AND start_at != '' AND start_at <= ?").all(now);
    for (const p of toStart) { db.prepare('UPDATE polls SET started=1 WHERE id=?').run(p.id); await refresh(client, getPoll(p.id)).catch(() => {}); }
    const due = db.prepare("SELECT * FROM polls WHERE closed=0 AND started=1 AND deadline != '' AND deadline <= ?").all(now);
    for (const p of due) await closePoll(client, p.id).catch(() => {});
  });

  client._postPoll = (poll) => postPoll(client, poll);
  client._closePoll = (id) => closePoll(client, id);
  console.log('  ↳ 投票模組已載入（身分組限制/修改開關/結果隱藏/倒數）');
}

module.exports = { init, postPoll, closePoll };
