// 大賽（週賽／月賽）：一段時間內比「某個指標成長最多」的人。
//
// 為什麼比成長量而不是總量：比總量的話每次都是同一批老玩家躺著贏，新人永遠沒機會。
// 開賽當下先把每個人的指標值記成 baseline，分數＝現在 − baseline，大家都是從 0 開始跑。
//
// 指標直接沿用 util/achievements.js 的 METRICS，所以「誰賺最多錢」「誰挖最多礦」
// 「誰做最多料理」「誰被偷最多」都是同一套，後台選一個下拉就開得起來。
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { db, guildConfig, logError } = require('../../db');
const { brandColor } = require('../../util/brand');
const { METRICS, metricValue, metricName } = require('../../util/achievements');
const { addCoins } = require('./gather');

const gcfg = (gid) => guildConfig('gather_config', gid);
const money = (gid, n) => {
  const c = gcfg(gid);
  return `${c.currency_emoji || '🪙'} ${Number(n || 0).toLocaleString('en-US')} ${c.currency_name || '星幣'}`;
};

const liveContests = (gid) => db.prepare(
  "SELECT * FROM contests WHERE guild_id=? AND status='live' ORDER BY end_ts").all(gid);

/**
 * 重算一場大賽所有人的分數。
 * 只看「已經有錢包紀錄的人」——沒玩過的人不會被硬塞進排行榜。
 * 第一次看到某個人就把他當下的指標值記成 baseline（中途才開始玩的人也是從 0 起跑）。
 */
function refresh(gid, c) {
  if (!METRICS[c.metric]) return;
  const players = db.prepare('SELECT user_id, username FROM econ_wallets WHERE guild_id=?').all(gid);
  const get = db.prepare('SELECT baseline FROM contest_scores WHERE contest_id=? AND user_id=?');
  const ins = db.prepare('INSERT INTO contest_scores (contest_id,guild_id,user_id,username,baseline,score) VALUES (?,?,?,?,?,0)');
  const upd = db.prepare("UPDATE contest_scores SET score=?, username=?, updated_at=datetime('now','localtime') WHERE contest_id=? AND user_id=?");
  db.transaction(() => {
    for (const p of players) {
      const now = metricValue(gid, p.user_id, c.metric);
      const row = get.get(c.id, p.user_id);
      if (!row) { ins.run(c.id, gid, p.user_id, p.username || '', now); continue; }
      upd.run(Math.max(0, now - row.baseline), p.username || '', c.id, p.user_id);
    }
  })();
}

const ranking = (contestId, minScore = 1, limit = 10) => db.prepare(
  `SELECT * FROM contest_scores WHERE contest_id=? AND score >= ? ORDER BY score DESC, updated_at LIMIT ?`
).all(contestId, Math.max(1, minScore), limit);

const MEDAL = ['🥇', '🥈', '🥉'];

function contestEmbed(gid, c, { final = false } = {}) {
  const rows = ranking(c.id, c.min_score, 10);
  const unit = (METRICS[c.metric] || {}).unit || '';
  const e = new EmbedBuilder().setColor(final ? 0xf1c40f : brandColor())
    .setTitle(`${c.emoji || '🏆'} ${c.name}${final ? '　結果出爐！' : ''}`)
    .setDescription([
      c.description || '',
      `**比賽項目**：${metricName(c.metric)}（比的是這段期間的**成長量**，大家都從 0 開始）`,
      c.status === 'live' ? `**結束時間**：<t:${Math.floor(c.end_ts / 1000)}:R>` : ''
    ].filter(Boolean).join('\n'));

  e.addFields({
    name: final ? '最終排名' : '目前排名',
    value: rows.length
      ? rows.map((r, i) => `${MEDAL[i] || `\`${i + 1}.\``} **${r.username || r.user_id}**　${r.score.toLocaleString('en-US')} ${unit}`).join('\n')
      : '還沒有人得分，現在開始還來得及。'
  });

  const prizes = [c.reward1, c.reward2, c.reward3].map((v, i) => v ? `${MEDAL[i]} ${money(gid, v)}` : '').filter(Boolean);
  if (prizes.length || c.title_id) {
    const t = c.title_id ? db.prepare('SELECT name, emoji FROM title_defs WHERE id=?').get(c.title_id) : null;
    e.addFields({
      name: '獎勵',
      value: [prizes.join('　'), t ? `冠軍另外拿到成就 ${t.emoji || ''}**${t.name}**` : ''].filter(Boolean).join('\n')
    });
  }
  return e;
}

function contestPanel(gid) {
  const list = liveContests(gid);
  for (const c of list) refresh(gid, c);
  const soon = db.prepare("SELECT * FROM contests WHERE guild_id=? AND status='scheduled' ORDER BY start_ts LIMIT 3").all(gid);
  const past = db.prepare("SELECT * FROM contests WHERE guild_id=? AND status='ended' ORDER BY id DESC LIMIT 3").all(gid);

  if (!list.length) {
    const e = new EmbedBuilder().setColor(brandColor()).setTitle('🏆 大賽')
      .setDescription(soon.length
        ? '目前沒有進行中的大賽，下一場：\n' + soon.map(c =>
          `${c.emoji || '🏆'} **${c.name}**　<t:${Math.floor(c.start_ts / 1000)}:R> 開始（比 ${metricName(c.metric)}）`).join('\n')
        : '目前沒有大賽。管理員可以在後台開一場（例如一週一次「誰賺最多錢」）。');
    if (past.length) e.addFields({
      name: '上幾屆冠軍',
      value: past.map(c => {
        const w = ranking(c.id, c.min_score, 1)[0];
        return `${c.emoji || '🏆'} ${c.name} — ${w ? `**${w.username}**（${w.score.toLocaleString('en-US')}）` : '從缺'}`;
      }).join('\n')
    });
    return { embeds: [e] };
  }
  return { embeds: list.slice(0, 5).map(c => contestEmbed(gid, c)) };
}

/** 我在各場大賽的名次（面板的「我的成績」） */
function myStanding(gid, uid) {
  const list = liveContests(gid);
  if (!list.length) return '目前沒有進行中的大賽。';
  return list.map(c => {
    refresh(gid, c);
    const all = db.prepare('SELECT user_id, score FROM contest_scores WHERE contest_id=? AND score>0 ORDER BY score DESC').all(c.id);
    const idx = all.findIndex(x => x.user_id === uid);
    const me = idx >= 0 ? all[idx] : null;
    const lead = all[0];
    return `${c.emoji || '🏆'} **${c.name}**（${metricName(c.metric)}）\n`
      + (me
        ? `　你目前第 **${idx + 1}** 名，${me.score.toLocaleString('en-US')}${idx > 0 ? `　距離第一還差 ${(lead.score - me.score).toLocaleString('en-US')}` : '　🥇 你就是第一！'}`
        : '　你還沒有得分，去衝一波吧。');
  }).join('\n\n');
}

// ---------- 開賽／結賽 ----------
async function announce(client, gid, channelId, payload) {
  if (!channelId) return null;
  const ch = await client.channels.fetch(channelId).catch(() => null);
  if (!ch) return null;
  return ch.send(payload).catch(() => null);
}

function payoutContest(gid, c) {
  const top = ranking(c.id, c.min_score, 3);
  const rewards = [c.reward1, c.reward2, c.reward3];
  db.transaction(() => {
    top.forEach((r, i) => {
      if (rewards[i] > 0) addCoins(gid, r.user_id, r.username, rewards[i]);
    });
    // 冠軍的專屬成就（可以在後台挑一個既有成就當獎盃）
    if (top[0] && c.title_id) {
      db.prepare('INSERT OR IGNORE INTO title_owned (guild_id,user_id,title_id,slot) VALUES (?,?,?,-1)')
        .run(gid, top[0].user_id, c.title_id);
    }
    db.prepare("UPDATE contests SET status='ended' WHERE id=?").run(c.id);
  })();
  return top;
}

/** 自動開下一屆（repeat_days > 0 時），時間往後推一個週期 */
function scheduleNext(gid, c) {
  if (!(c.repeat_days > 0)) return;
  const span = c.end_ts - c.start_ts;
  const start = c.end_ts + 1000;
  db.prepare(
    `INSERT INTO contests (guild_id,name,emoji,description,metric,start_ts,end_ts,status,
       reward1,reward2,reward3,title_id,min_score,channel,repeat_days,created_by)
     VALUES (?,?,?,?,?,?,?,'scheduled',?,?,?,?,?,?,?,?)`
  ).run(gid, c.name, c.emoji, c.description, c.metric, start, start + span,
    c.reward1, c.reward2, c.reward3, c.title_id, c.min_score, c.channel, c.repeat_days, c.created_by || '自動');
}

async function tick(client) {
  const now = Date.now();
  for (const [gid] of client.guilds.cache) {
    try {
      for (const c of db.prepare("SELECT * FROM contests WHERE guild_id=? AND status='scheduled' AND start_ts<=?").all(gid, now)) {
        db.prepare("UPDATE contests SET status='live' WHERE id=?").run(c.id);
        const live = db.prepare('SELECT * FROM contests WHERE id=?').get(c.id);
        refresh(gid, live);   // 記下所有人的起跑點
        const msg = await announce(client, gid, c.channel, {
          content: '🏆 **大賽開始！**', embeds: [contestEmbed(gid, live)],
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('adv:contest').setLabel('🏆 看排行榜').setStyle(ButtonStyle.Primary))]
        });
        if (msg) db.prepare('UPDATE contests SET message_id=? WHERE id=?').run(msg.id, c.id);
      }

      for (const c of db.prepare("SELECT * FROM contests WHERE guild_id=? AND status='live' AND end_ts<=?").all(gid, now)) {
        refresh(gid, c);
        const top = payoutContest(gid, c);
        const ended = db.prepare('SELECT * FROM contests WHERE id=?').get(c.id);
        const e = contestEmbed(gid, ended, { final: true });
        if (top[0]) e.setDescription((ended.description ? ended.description + '\n' : '')
          + `🎉 冠軍是 **${top[0].username}**！${c.title_id ? '專屬成就已經送到，記得去 `/成就` 裝備。' : ''}`);
        await announce(client, gid, c.channel, { content: '🏆 **大賽結束！**', embeds: [e] });
        scheduleNext(gid, c);
      }

      // 進行中的每分鐘更新一次分數（面板打開時也會即時重算）
      for (const c of liveContests(gid)) refresh(gid, c);
    } catch (e) { logError(gid, '大賽排程失敗：', e.message); }
  }
}

function init(client) {
  setInterval(() => tick(client).catch(() => {}), 60000);

  client.on('interactionCreate', async (i) => {
    try {
      if (!i.guildId) return;
      const gid = i.guildId;
      const eph = { flags: MessageFlags.Ephemeral };
      const isCmd = i.isChatInputCommand() && i.commandName === '大賽';
      const isBtn = i.isButton() && (i.customId === 'adv:contest' || i.customId === 'contestme');
      if (!isCmd && !isBtn) return;

      if (i.isButton() && i.customId === 'contestme') {
        return i.reply({ content: myStanding(gid, i.user.id), ...eph }).catch(() => {});
      }
      const p = contestPanel(gid);
      return i.reply({
        ...p, ...eph,
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('contestme').setLabel('📊 我的成績').setStyle(ButtonStyle.Secondary))]
      }).catch(() => {});
    } catch (e) {
      logError(i.guildId, '大賽面板失敗：', e.message);
    }
  });

  console.log('  ↳ 大賽模組已載入（週賽／月賽，比成長量，冠軍拿成就）');
}

module.exports = { init, contestPanel, contestEmbed, refresh, ranking, myStanding };
