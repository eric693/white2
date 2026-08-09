const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags} = require('discord.js');
const cron = require('node-cron');
const { db, logError } = require('../../db');
const { localNowMinute, toUnix, nowUnix } = require('../../util/time');
const { tempReply } = require('../../util/ephemeral');
const { absUrl } = require('../../util/url');

const WIN_LOCK = 12 * 3600; // 預設 12 小時中獎冷卻（秒）；每場抽獎可用 win_lock_hours 覆蓋（0＝不限制）
const DUR_MIN = 1, DUR_MAX = 24 * 3600; // 持續時間限制：最低 1 秒、最高 24 小時

// 解析持續時間字串 → 秒。支援「30s / 30秒 / 5m / 5分 / 2h / 2小時 / 90（純數字＝秒）」
function parseDuration(str) {
  const m = String(str || '').trim().toLowerCase()
    .match(/^(\d+(?:\.\d+)?)\s*(s|sec|秒|m|min|分|分鐘|h|hr|時|小時)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2] || 's';
  const mult = /^(m|min|分|分鐘)$/.test(unit) ? 60 : /^(h|hr|時|小時)$/.test(unit) ? 3600 : 1;
  const sec = Math.round(n * mult);
  if (sec < DUR_MIN || sec > DUR_MAX) return null;
  return sec;
}

// 抽獎的統一截止秒（end_unix 優先，否則用 deadline 字串）
const endUnixOf = (ga) => ga.end_unix || toUnix(ga.deadline);

const getGa = (id) => db.prepare('SELECT * FROM giveaways WHERE id=?').get(id);
const csv = (s) => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
// 黑名單：沿用共用判斷（會一併看 feature 是 all 還是只針對抽獎、是否已解除、是否已到期），
// 避免「只封鎖音樂」的玩家被連帶擋掉抽獎。
const { blacklisted } = require('../perm');
const isBlacklisted = (gid, uid) => !!blacklisted(gid, uid, 'giveaways');
// 黑名單玩家「假裝參加」的狀態：giveawayId:userId。只影響他自己看到的提示文字，
// 不寫進資料庫、不影響開獎，重啟後歸零也沒有副作用。
const fakeJoined = new Set();
// 該玩家在指定時數內是否已中獎（未撤銷）。lockSec=0 → 不限制，永遠回 false
const recentlyWon = (gid, uid, lockSec = WIN_LOCK) => {
  if (!lockSec) return false;
  return !!db.prepare(
    'SELECT 1 FROM win_records WHERE guild_id=? AND user_id=? AND revoked=0 AND won_at > ?'
  ).get(gid, uid, nowUnix() - lockSec);
};
// 這場抽獎的重複中獎鎖定秒數：欄位沒值（舊資料）→ 沿用預設 12 小時；0＝不限制
const lockSecOf = (ga) => (ga.win_lock_hours == null ? 12 : ga.win_lock_hours) * 3600;
const lockLabel = (ga) => { const h = lockSecOf(ga) / 3600; return h ? `${h} 小時內中過獎不再重複` : '不限制重複中獎'; };

function buildEmbed(ga) {
  const entries = db.prepare('SELECT COUNT(*) c FROM giveaway_entries WHERE giveaway_id=?').get(ga.id).c;
  const startU = toUnix(ga.start_at), endU = endUnixOf(ga);
  let winners = []; try { winners = JSON.parse(ga.winner_ids); } catch {}

  // MEE6 風格：獎品名當大標題，資訊分欄，禮物縮圖，底部說明
  const embed = new EmbedBuilder()
    .setColor(ga.cancelled ? 0xed4245 : ga.ended ? 0x99aab5 : 0xf1c40f)
    .setAuthor({ name: '🎉 抽獎系統' })
    .setTitle(ga.prize)
    .setThumbnail(ga.thumb ? absUrl(ga.thumb) : 'https://twemoji.maxcdn.com/v/latest/72x72/1f381.png'); // 禮物盒圖示

  if (ga.description) embed.setDescription(ga.description);

  // 分欄資訊（建立者、獎品數量、參加人數、結束時間）
  const fields = [];
  if (ga.creator) fields.push({ name: '建立者', value: ga.creator, inline: true });
  fields.push({ name: '獎品數量', value: `${ga.winners} 位`, inline: true });
  fields.push({ name: '參加人數', value: `${entries} 人`, inline: true });
  // 「不限制」是常態，不必特別公告；只有真的有鎖定時才顯示，避免版面多一行
  if (lockSecOf(ga)) fields.push({ name: '重複中獎', value: `${lockSecOf(ga) / 3600} 小時內中過獎不再抽到`, inline: true });

  if (ga.cancelled) {
    fields.push({ name: '抽獎狀態', value: '已取消（本次抽獎作廢，不開獎）', inline: false });
  } else if (ga.ended) {
    fields.push({ name: '抽獎狀態', value: '已結束', inline: false });
    fields.push({ name: '得獎者', value: winners.length ? winners.map(id => `<@${id}>`).join('　') : '（無有效參加者）', inline: false });
  } else if (!ga.started && startU) {
    fields.push({ name: '開始時間', value: `<t:${startU}:F>`, inline: false });
  } else if (endU) {
    fields.push({ name: '抽獎結束時間', value: `<t:${endU}:F>`, inline: false });
  }
  embed.addFields(fields);

  if (!ga.ended && ga.started) embed.setFooter({ text: '點擊下方按鈕來參加抽獎 🎉' });
  return embed;
}

function buildRow(ga) {
  let label = '參加抽獎', style = ButtonStyle.Success, disabled = false;
  if (ga.cancelled) { label = '抽獎已取消'; style = ButtonStyle.Secondary; disabled = true; }
  else if (ga.ended) { label = '抽獎已結束'; style = ButtonStyle.Secondary; disabled = true; }
  else if (!ga.started) { label = '尚未開始'; style = ButtonStyle.Secondary; disabled = true; }
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`giveaway:${ga.id}`).setLabel(label).setEmoji('🎉').setStyle(style).setDisabled(disabled)
  );
}

async function channelOf(client, ga) {
  return client.channels.cache.get(ga.channel_id) || await client.channels.fetch(ga.channel_id).catch(() => null);
}

async function postGiveaway(client, ga) {
  const ch = await channelOf(client, ga);
  if (!ch) throw new Error('找不到頻道');
  // 發抽獎時 @ 通知指定身分組
  const roles = csv(ga.mention_roles);
  const content = roles.length ? roles.map(r => `<@&${r}>`).join(' ') : undefined;
  const msg = await ch.send({ content, embeds: [buildEmbed(ga)], components: [buildRow(ga)], allowedMentions: { roles } });
  db.prepare('UPDATE giveaways SET message_id=? WHERE id=?').run(msg.id, ga.id);
  return msg.id;
}

async function refresh(client, ga) {
  if (!ga.message_id) return;
  const ch = await channelOf(client, ga);
  if (!ch) return;
  const msg = await ch.messages.fetch(ga.message_id).catch(() => null);
  if (msg) await msg.edit({ embeds: [buildEmbed(ga)], components: [buildRow(ga)] }).catch(() => {});
}

// 抽出得獎者：保證中獎優先（不受黑名單/12H 限制由呼叫端保證），其餘隨機且排除黑名單、12H 內中獎者、已中者
function drawWinners(ga, { count, exclude = [] } = {}) {
  const guaranteed = csv(ga.guaranteed_ids);
  const excludeSet = new Set([...exclude, ...guaranteed]);
  const need = (count != null ? count : ga.winners) - guaranteed.length;
  let pool = db.prepare('SELECT user_id FROM giveaway_entries WHERE giveaway_id=?').all(ga.id)
    .map(r => r.user_id)
    .filter(uid => !excludeSet.has(uid) && !isBlacklisted(ga.guild_id, uid) && !recentlyWon(ga.guild_id, uid, lockSecOf(ga))); // 抽前排除，非事後
  for (let k = pool.length - 1; k > 0; k--) {
    const j = Math.floor(Math.random() * (k + 1));
    [pool[k], pool[j]] = [pool[j], pool[k]];
  }
  const picked = pool.slice(0, Math.max(0, need));
  return [...guaranteed, ...picked];
}

function recordWins(ga, winners) {
  const now = nowUnix();
  const stmt = db.prepare('INSERT INTO win_records (guild_id, giveaway_id, user_id, username, prize, won_at) VALUES (?,?,?,?,?,?)');
  for (const uid of winners) {
    const e = db.prepare('SELECT username FROM giveaway_entries WHERE giveaway_id=? AND user_id=?').get(ga.id, uid);
    stmt.run(ga.guild_id || '', ga.id, uid, e ? e.username : '', ga.prize, now);
  }
}

async function endGiveaway(client, id, { announce = true } = {}) {
  const ga = getGa(id);
  if (!ga || ga.ended) return [];
  // 人數不足流標：參加人數 < 獎品數量 → 不開獎、作廢
  if (ga.void_if_insufficient) {
    const entries = db.prepare('SELECT COUNT(*) c FROM giveaway_entries WHERE giveaway_id=?').get(id).c;
    if (entries < ga.winners) {
      db.prepare("UPDATE giveaways SET ended=1, cancelled=1, winner_ids='[]' WHERE id=?").run(id);
      await refresh(client, getGa(id));
      if (announce) {
        const ch = await channelOf(client, ga);
        if (ch) ch.send(`⚠️ 抽獎【${ga.prize}】參加人數（${entries}）未達獎品數量（${ga.winners}），本次**流標**，不開出獎項。`).catch(() => {});
      }
      return [];
    }
  }
  const winners = drawWinners(ga);
  db.prepare('UPDATE giveaways SET ended=1, winner_ids=? WHERE id=?').run(JSON.stringify(winners), id);
  recordWins(ga, winners);
  await refresh(client, getGa(id));
  if (announce) {
    const ch = await channelOf(client, ga);
    if (ch && winners.length) {
      ch.send(`恭喜 ${winners.map(w => `<@${w}>`).join(' ')} 抽中【${ga.prize}】！`).catch(() => {});
    } else if (ch) {
      // 抽不出人時要講清楚原因，否則管理員只會看到「什麼都沒發生」
      const entries = db.prepare('SELECT COUNT(*) c FROM giveaway_entries WHERE giveaway_id=?').get(id).c;
      const reason = entries === 0 ? '沒有人參加' : `所有參加者都不符合資格（${lockLabel(ga)}／黑名單）`;
      ch.send(`⚠️ 抽獎【${ga.prize}】開獎完成，但沒有抽出得獎者：${reason}。`).catch(() => {});
    }
  }
  return winners;
}

// 重抽：清掉本場中獎紀錄後重新開獎
async function reroll(client, id) {
  db.prepare('DELETE FROM win_records WHERE giveaway_id=?').run(id);
  db.prepare('UPDATE giveaways SET ended=0, winner_ids=\'[]\' WHERE id=?').run(id);
  return endGiveaway(client, id);
}

// 補抽：在現有得獎者之外再抽 count 位
async function supplement(client, id, count) {
  const ga = getGa(id);
  if (!ga) return [];
  let current = []; try { current = JSON.parse(ga.winner_ids); } catch {}
  const extra = drawWinners(ga, { count: current.length + count, exclude: current }).filter(u => !current.includes(u));
  const all = [...current, ...extra];
  db.prepare('UPDATE giveaways SET winner_ids=?, ended=1 WHERE id=?').run(JSON.stringify(all), id);
  recordWins(ga, extra);
  await refresh(client, getGa(id));
  const chSup = await channelOf(client, ga);
  if (chSup) {
    if (extra.length) chSup.send(`補抽結果：恭喜 ${extra.map(w => `<@${w}>`).join(' ')} 抽中【${ga.prize}】！`).catch(() => {});
    else chSup.send(`⚠️ 抽獎【${ga.prize}】補抽沒有抽出人選：剩下的參加者都不符合資格（${lockLabel(ga)}／黑名單）。`).catch(() => {});
  }
  return extra;
}

// 取消得獎資格
async function revokeWinner(client, id, userId) {
  const ga = getGa(id);
  if (!ga) return;
  let winners = []; try { winners = JSON.parse(ga.winner_ids); } catch {}
  winners = winners.filter(u => u !== userId);
  db.prepare('UPDATE giveaways SET winner_ids=? WHERE id=?').run(JSON.stringify(winners), id);
  db.prepare('UPDATE win_records SET revoked=1 WHERE giveaway_id=? AND user_id=?').run(id, userId);
  await refresh(client, getGa(id));
}

// 取消抽獎：不開獎直接作廢。停掉排程、更新訊息、停用按鈕。
async function cancelGiveaway(client, id, { announce = true } = {}) {
  const ga = getGa(id);
  if (!ga) return { ok: false, reason: '找不到這個抽獎' };
  if (ga.ended) return { ok: false, reason: '這個抽獎已經結束了，無法取消' };
  if (endTimers.has(id)) { clearTimeout(endTimers.get(id)); endTimers.delete(id); }
  db.prepare("UPDATE giveaways SET ended=1, cancelled=1, winner_ids='[]' WHERE id=?").run(id);
  await refresh(client, getGa(id));
  if (announce) {
    const ch = await channelOf(client, ga);
    if (ch) ch.send(`🚫 抽獎【${ga.prize}】已被管理員取消，本次不開獎。`).catch(() => {});
  }
  return { ok: true, prize: ga.prize };
}

// ---- 秒級開獎排程：end_unix 到點時準時開獎 ----
const endTimers = new Map();
function scheduleEnd(client, ga) {
  if (!ga || ga.ended || !ga.end_unix) return;
  const ms = ga.end_unix * 1000 - Date.now();
  if (endTimers.has(ga.id)) clearTimeout(endTimers.get(ga.id));
  endTimers.set(ga.id, setTimeout(() => {
    endTimers.delete(ga.id);
    endGiveaway(client, ga.id).catch(e => logError(ga.guild_id, '自動開獎失敗：', e.message));
  }, Math.max(0, ms)));
}

function init(client) {
  // 重啟後把還沒結束的秒級抽獎重新排程
  for (const g of db.prepare('SELECT * FROM giveaways WHERE ended=0 AND end_unix > 0').all()) {
    scheduleEnd(client, g);
  }

  client.on('interactionCreate', async (i) => {
    // ---- /取消抽獎：管理員取消進行中的抽獎（不開獎作廢）----
    if (i.isChatInputCommand() && i.commandName === '取消抽獎') {
      if (!i.memberPermissions || !i.memberPermissions.has('ManageGuild')) {
        return i.reply({ content: '僅管理員可取消抽獎。', flags: MessageFlags.Ephemeral });
      }
      // 未指定編號 → 取消目前頻道進行中的抽獎；只有一場就直接取消，多場則列出讓管理員指定
      const idOpt = i.options.getInteger('編號');
      let target;
      if (idOpt) {
        target = db.prepare('SELECT * FROM giveaways WHERE id=? AND guild_id=?').get(idOpt, i.guild.id);
        if (!target) return i.reply({ content: `找不到編號 ${idOpt} 的抽獎。`, flags: MessageFlags.Ephemeral });
      } else {
        const active = db.prepare('SELECT * FROM giveaways WHERE guild_id=? AND channel_id=? AND ended=0 ORDER BY id DESC')
          .all(i.guild.id, i.channelId);
        if (!active.length) return i.reply({ content: '這個頻道目前沒有進行中的抽獎可以取消。', flags: MessageFlags.Ephemeral });
        if (active.length > 1) {
          const list = active.map(g => `・編號 ${g.id}：【${g.prize}】`).join('\n');
          return i.reply({ content: `這個頻道有多場進行中的抽獎，請用 \`/取消抽獎 編號:數字\` 指定：\n${list}`, flags: MessageFlags.Ephemeral });
        }
        target = active[0];
      }
      const r = await cancelGiveaway(client, target.id);
      return tempReply(i, r.ok ? `已取消抽獎【${r.prize}】。` : r.reason, 8);
    }

    // ---- /giveaway 快速抽獎指令 ----
    if (i.isChatInputCommand() && i.commandName === '抽獎') {
      if (!i.memberPermissions || !i.memberPermissions.has('ManageGuild')) {
        return i.reply({ content: '僅管理員可建立抽獎。', flags: MessageFlags.Ephemeral });
      }
      const ch = i.options.getChannel('抽獎頻道') || i.channel;
      const durStr = i.options.getString('抽獎持續時間', true);
      const prize = i.options.getString('獎品名稱', true);
      const count = i.options.getInteger('獎品數量') || 1;
      const voidIfShort = i.options.getBoolean('人數不足流標') ? 1 : 0;
      const mentionRole = i.options.getRole('標記身分組');
      const lockOpt = i.options.getInteger('重複中獎限制');
      const lockHours = lockOpt == null ? 12 : lockOpt;

      const sec = parseDuration(durStr);
      if (sec == null) {
        return i.reply({ content: '持續時間格式不對。例如 `30s`、`5m`、`2h`（最低 1 秒、最高 24 小時）。', flags: MessageFlags.Ephemeral });
      }
      const info = db.prepare(
        `INSERT INTO giveaways (guild_id, title, prize, winners, channel_id, started, end_unix, creator, void_if_insufficient, mention_roles, win_lock_hours)
         VALUES (?, '', ?, ?, ?, 1, ?, ?, ?, ?, ?)`
      ).run(i.guild.id, prize, Math.max(1, count), ch.id, nowUnix() + sec,
        (i.member && i.member.displayName) || i.user.globalName || i.user.username, voidIfShort, mentionRole ? mentionRole.id : '', lockHours);
      const ga = getGa(info.lastInsertRowid);
      try {
        await postGiveaway(client, ga);
        scheduleEnd(client, ga);
        const label = sec >= 3600 ? `${Math.round(sec / 360) / 10} 小時` : sec >= 60 ? `${Math.round(sec / 6) / 10} 分鐘` : `${sec} 秒`;
        return tempReply(i, `抽獎已開始！獎品【${prize}】× ${count}，${label}後於 <#${ch.id}> 自動開獎。\n重複中獎限制：${lockHours ? `${lockHours} 小時內中過獎的人不會再被抽到` : '不限制（所有參加者都可能中獎）'}`, 12);
      } catch (e) {
        db.prepare('DELETE FROM giveaways WHERE id=?').run(ga.id);
        return i.reply({ content: '建立失敗：' + e.message, flags: MessageFlags.Ephemeral });
      }
    }

    if (!i.isButton() || !i.customId.startsWith('giveaway:')) return;
    const id = i.customId.split(':')[1];
    const ga = getGa(id);
    if (!ga || ga.ended) return i.reply({ content: '此抽獎已結束。', flags: MessageFlags.Ephemeral }).catch(() => {});
    if (!ga.started) return i.reply({ content: '抽獎尚未開始。', flags: MessageFlags.Ephemeral }).catch(() => {});
    const endU = endUnixOf(ga);
    if (endU && nowUnix() >= endU) return i.reply({ content: '抽獎已截止。', flags: MessageFlags.Ephemeral }).catch(() => {});
    const countOf = () => db.prepare('SELECT COUNT(*) c FROM giveaway_entries WHERE giveaway_id=?').get(id).c;

    // 黑名單玩家：畫面上一切照常（顯示已參加／取消參加、人數也照實顯示），
    // 但實際上不寫入參加名單，開獎時自然抽不到。這樣對方不會發現、也不會一直來按或來問。
    if (isBlacklisted(ga.guild_id, i.user.id)) {
      // 保險：若他是「先參加、後被列黑名單」，把殘留的參加紀錄清掉，才不會佔用參加人數
      const had = db.prepare('DELETE FROM giveaway_entries WHERE giveaway_id=? AND user_id=?').run(id, i.user.id).changes;
      if (had) await refresh(client, getGa(id));
      const key = `${id}:${i.user.id}`;
      const joined = !fakeJoined.has(key);
      if (joined) fakeJoined.add(key); else fakeJoined.delete(key);
      await tempReply(i, joined
        ? `✅ **你目前狀態：已參加**\n你已成功報名【${ga.prize}】，祝你好運！想退出就再按一次按鈕。\n目前參加人數：${countOf()} 人`
        : `❌ **你目前狀態：未參加**\n你已取消參加【${ga.prize}】，不會被抽到。想重新參加就再按一次綠色按鈕。\n目前參加人數：${countOf()} 人`, 8);
      return;
    }

    const exists = db.prepare('SELECT 1 FROM giveaway_entries WHERE giveaway_id=? AND user_id=?').get(id, i.user.id);
    if (exists) {
      // 已參加 → 再按一次＝取消參加
      db.prepare('DELETE FROM giveaway_entries WHERE giveaway_id=? AND user_id=?').run(id, i.user.id);
      await tempReply(i, `❌ **你目前狀態：未參加**\n你已取消參加【${ga.prize}】，不會被抽到。想重新參加就再按一次綠色按鈕。\n目前參加人數：${countOf()} 人`, 8);
      await refresh(client, getGa(id));
      return;
    }
    // 尚未參加 → 參加
    db.prepare('INSERT OR IGNORE INTO giveaway_entries (guild_id, giveaway_id, user_id, username) VALUES (?,?,?,?)')
      .run(ga.guild_id || '', id, i.user.id, i.user.username);
    await tempReply(i, `✅ **你目前狀態：已參加**\n你已成功報名【${ga.prize}】，祝你好運！想退出就再按一次按鈕。\n目前參加人數：${countOf()} 人`, 8);
    await refresh(client, getGa(id));
  });

  cron.schedule('* * * * *', async () => {
    const now = localNowMinute();
    // 到開始時間 → 啟用按鈕
    const toStart = db.prepare("SELECT * FROM giveaways WHERE started=0 AND ended=0 AND start_at != '' AND start_at <= ?").all(now);
    for (const g of toStart) { db.prepare('UPDATE giveaways SET started=1 WHERE id=?').run(g.id); await refresh(client, getGa(g.id)).catch(() => {}); }
    // 到截止時間 → 自動開獎
    const due = db.prepare("SELECT * FROM giveaways WHERE ended=0 AND started=1 AND deadline != '' AND deadline <= ?").all(now);
    for (const g of due) await endGiveaway(client, g.id).catch(() => {});
  });

  // 秒級抽獎的後援檢查（每 10 秒，補救 setTimeout 沒排到的情況）
  cron.schedule('*/10 * * * * *', async () => {
    const due = db.prepare('SELECT id FROM giveaways WHERE ended=0 AND end_unix > 0 AND end_unix <= ?').all(nowUnix());
    for (const g of due) await endGiveaway(client, g.id).catch(() => {});
  });

  client._postGiveaway = async (ga) => { const r = await postGiveaway(client, ga); scheduleEnd(client, ga); return r; };
  client._endGiveaway = (id) => endGiveaway(client, id);
  client._rerollGiveaway = (id) => reroll(client, id);
  client._supplementGiveaway = (id, n) => supplement(client, id, n);
  client._revokeWinner = (id, uid) => revokeWinner(client, id, uid);
  client._cancelGiveaway = (id) => cancelGiveaway(client, id);
  // 加入黑名單時呼叫：把此人從該伺服器所有「尚未結束」的抽獎參加名單移除，並更新面板人數
  client._purgeEntriesOf = async (gid, userId) => {
    const list = db.prepare('SELECT * FROM giveaways WHERE guild_id=? AND ended=0').all(gid);
    let removed = 0;
    for (const ga of list) {
      const r = db.prepare('DELETE FROM giveaway_entries WHERE giveaway_id=? AND user_id=?').run(ga.id, userId);
      if (r.changes) { removed += r.changes; await refresh(client, getGa(ga.id)).catch(() => {}); }
    }
    return removed;
  };
  console.log('  ↳ 抽獎模組已載入（保證中獎/重複中獎限制可調/補抽/撤銷/取消/倒數）');
}

module.exports = { init, postGiveaway, endGiveaway, reroll, supplement, revokeWinner, cancelGiveaway, drawWinners, recentlyWon, parseDuration };
