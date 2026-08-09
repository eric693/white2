// 角色推薦轉盤（規格 8.1～8.16）
const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, MessageFlags} = require('discord.js');
const { db, logError } = require('../../db');
const { absUrl } = require('../../util/url');
const { brandColor } = require('../../util/brand');
const { guard } = require('../perm');
const { AttachmentBuilder } = require('discord.js');
const { makeRoleCard } = require('../../util/rolecard');
const { parseEmoji } = require('../../util/components');

const csv = (s) => String(s || '').split(/[\n,]/).map(x => x.trim()).filter(Boolean);
// start_at / end_at 是後台 datetime-local 存的台北牆上時間，比較時也要用台北時間
const { localNowMinute, localToday } = require('../../util/time');
const nowStr = () => localNowMinute();

// 8.12 是否在活動期間內
function inPeriod(row) {
  const n = nowStr();
  if (row.start_at && row.start_at > n) return false;
  if (row.end_at && row.end_at < n) return false;
  return true;
}

// 玩家在此轉盤的目前輪次
function getRound(userId, wheelId) {
  const r = db.prepare('SELECT round FROM wheel_rounds WHERE user_id=? AND wheel_id=?').get(userId, wheelId);
  return r ? r.round : 1;
}
function bumpRound(userId, wheelId, gid) {
  const cur = getRound(userId, wheelId);
  db.prepare(
    `INSERT INTO wheel_rounds (guild_id, user_id, wheel_id, round) VALUES (?,?,?,?)
     ON CONFLICT(user_id, wheel_id) DO UPDATE SET round = excluded.round`
  ).run(gid || '', userId, wheelId, cur + 1);
  return cur + 1;
}

// 可抽取的轉盤（上架 + 啟用 + 活動期間內）
function listedWheels(gid) {
  return db.prepare('SELECT * FROM role_wheels WHERE guild_id=? AND enabled=1 AND listed=1 ORDER BY id').all(gid).filter(inPeriod);
}

// 8.10 / 8.15 取出這位玩家本輪還沒抽過（也還沒聊過）的角色
function availableRoles(wheel, userId) {
  const all = db.prepare('SELECT * FROM wheel_roles WHERE wheel_id=? AND enabled=1 ORDER BY sort, id')
    .all(wheel.id).filter(inPeriod);
  if (!all.length) return { pool: [], all: [] };

  const round = getRound(userId, wheel.id);
  let pool = all;
  if (wheel.no_repeat) {
    const drawn = db.prepare('SELECT role_id FROM wheel_draws WHERE user_id=? AND wheel_id=? AND round=?')
      .all(userId, wheel.id, round).map(r => r.role_id);
    pool = pool.filter(r => !drawn.includes(r.id));
  }
  if (wheel.exclude_chatted) {
    const chatted = db.prepare('SELECT role_id FROM wheel_chats WHERE user_id=? AND wheel_id=?')
      .all(userId, wheel.id).map(r => r.role_id);
    pool = pool.filter(r => !chatted.includes(r.id));
  }
  return { pool, all, round };
}

// 8.11 依權重隨機
function weightedPick(roles) {
  const total = roles.reduce((s, r) => s + Math.max(1, r.weight || 1), 0);
  let n = Math.random() * total;
  for (const r of roles) {
    n -= Math.max(1, r.weight || 1);
    if (n <= 0) return r;
  }
  return roles[roles.length - 1];
}

// 8.9 今日已抽次數
function todayDraws(userId, wheelId) {
  return db.prepare(
    `SELECT COUNT(*) AS n FROM wheel_draws
      WHERE user_id=? AND wheel_id=? AND date(created_at)=date('now','localtime')`
  ).get(userId, wheelId).n;
}

// 角色的連結清單（新版 links 陣列；相容舊的單一 chat_link）
function roleLinks(role) {
  let list = [];
  try { list = JSON.parse(role.links || '[]'); } catch { list = []; }
  if (!Array.isArray(list)) list = [];
  list = list.filter(l => l && l.url && /^https?:\/\//.test(l.url));
  if (!list.length && role.chat_link) list = [{ label: '聊天室', url: role.chat_link }];
  return list;
}

// 抽到的角色卡片（8.5）
// drawer＝抽到這張卡的人（可空，例如後台預覽時）
async function roleEmbed(role, wheel, faved, drawer) {
  const embed = new EmbedBuilder().setColor(0xeb459e)
    .setFooter({ text: `轉盤：${wheel.name}` });
  // 角色名用 Discord H1 大標題，比 Embed 標題更醒目
  const head = `# ${role.name}`;
  embed.setDescription(role.intro ? `${head}\n\n${role.intro}` : head);
  const fields = [];
  if (role.author) fields.push({ name: '作者', value: role.author, inline: true });
  if (role.tags) fields.push({ name: '標籤', value: csv(role.tags).join('、'), inline: false });
  if (fields.length) embed.addFields(fields);
  if (role.image_url) embed.setImage(absUrl(role.image_url));

  // 角色的多個連結（每個一顆按鈕，點了才給網址以便統計點擊）
  const links = roleLinks(role);
  const rows = [];
  for (let i = 0; i < links.length; i += 5) {
    const r = new ActionRowBuilder();
    links.slice(i, i + 5).forEach((l, n) => {
      const btn = new ButtonBuilder().setCustomId(`wchat:${role.id}:${i + n}`)
        .setLabel((l.label || '前往').slice(0, 80)).setStyle(ButtonStyle.Success);
      if (l.emoji) { try { btn.setEmoji(parseEmoji(l.emoji)); } catch {} }
      r.addComponents(btn);
    });
    rows.push(r);
  }
  const actions = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`wfav:${role.id}`)
      .setLabel(faved ? '取消收藏' : '收藏角色').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`wheel:${wheel.id}`)
      .setLabel('再抽一次').setStyle(ButtonStyle.Primary)
  );
  const payload = { embeds: [embed], components: [...rows.slice(0, 4), actions] };

  // 小卡模式：整張做成圖片（沒放角色圖時不會有圓框）
  if (wheel.card_enabled) {
    try {
      // 卡片只顯示作者，不顯示標籤（標籤僅供玩家在面板篩選用）
      const parts = [];
      if (role.author) parts.push(role.author);
      const buf = await makeRoleCard({
        imageUrl: role.image_url,
        bgUrl: wheel.card_bg,
        name: role.name,
        subtitle: parts.join('　·　'),
        tagline: role.intro,
        // 名字與日期各自獨立開關，兩個都關就完全不畫左下角
        drawnBy: wheel.card_sign ? (drawer || '') : '',
        date: wheel.card_date ? localToday() : ''
      });
      payload.files = [new AttachmentBuilder(buf, { name: 'role.png' })];
      // 卡圖已含角色名/作者/標籤/台詞，Embed 只留轉盤標示避免重複
      payload.embeds = [new EmbedBuilder().setColor(0xeb459e)
        .setImage('attachment://role.png')
        .setFooter({ text: `轉盤：${wheel.name}` })];
    } catch (e) { logError(wheel.guild_id, '角色小卡產生失敗：', e.message); }
  }
  return payload;
}

// 8.1 / 8.4 發布轉盤面板到頻道
async function postWheel(client, wheelId, channelId) {
  const wheel = db.prepare('SELECT * FROM role_wheels WHERE id=?').get(wheelId);
  if (!wheel) throw new Error('找不到轉盤');
  const ch = client.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
  if (!ch) throw new Error('找不到頻道');
  const count = db.prepare('SELECT COUNT(*) AS n FROM wheel_roles WHERE wheel_id=? AND enabled=1').get(wheelId).n;

  const embed = new EmbedBuilder().setColor(0xeb459e).setTitle(wheel.name)
    .setDescription(wheel.description || '點下方按鈕，隨機推薦一位角色給你！')
    .setFooter({ text: `目前收錄 ${count} 位角色` + (wheel.tags ? `｜${csv(wheel.tags).join('、')}` : '') });
  if (wheel.image_url) embed.setImage(absUrl(wheel.image_url));

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`wheel:${wheel.id}`).setLabel('抽一位角色').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('wfavlist').setLabel('我的收藏').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`whist:${wheel.id}`).setLabel('抽取紀錄').setStyle(ButtonStyle.Secondary)
  );
  const components = [row];

  // 這個轉盤內角色實際用到的標籤 → 玩家可「依標籤抽取」
  const usedTags = [...new Set(
    db.prepare('SELECT tags FROM wheel_roles WHERE wheel_id=? AND enabled=1').all(wheelId)
      .flatMap(r => csv(r.tags))
  )];
  if (usedTags.length) {
    const opts = usedTags.slice(0, 24);
    components.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(`wtag:${wheel.id}`)
        .setPlaceholder('想抽特定類型？可選多個標籤（不選＝全部）')
        .setMinValues(1).setMaxValues(opts.length + 1)
        .addOptions([
          { label: '不限標籤（全部角色）', value: '__all__', description: '取消標籤篩選' },
          ...opts.map(t => ({ label: t, value: t }))
        ])
    ));
  }
  await ch.send({ embeds: [embed], components });
}

// 8.4 發布標籤篩選面板
async function postFilter(client, channelId) {
  const ch = client.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
  if (!ch) throw new Error('找不到頻道');
  const tags = db.prepare('SELECT name FROM wheel_tags WHERE guild_id=? ORDER BY id').all(ch.guild.id).map(t => t.name);
  if (!tags.length) throw new Error('尚未建立任何標籤，請先到後台新增');

  const embed = new EmbedBuilder().setColor(brandColor()).setTitle('依標籤挑選角色轉盤')
    .setDescription('選擇你喜歡的類型（可複選），系統會列出符合的轉盤。');
  const menu = new StringSelectMenuBuilder().setCustomId('wfilter').setPlaceholder('選擇標籤（可複選）')
    .setMinValues(1).setMaxValues(Math.min(tags.length, 25))
    .addOptions(tags.slice(0, 25).map(t => ({ label: t, value: t })));
  await ch.send({ embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] });
}

function init(client) {
  client.on('interactionCreate', async (i) => {
    try {
      // ---- 8.4 標籤篩選 ----
      if (i.isStringSelectMenu() && i.customId === 'wfilter') {
        const picked = i.values;
        const wheels = listedWheels(i.guild.id).filter(w => {
          const wt = csv(w.tags);
          const roleTags = db.prepare('SELECT tags FROM wheel_roles WHERE wheel_id=? AND enabled=1').all(w.id)
            .flatMap(r => csv(r.tags));
          return picked.some(t => wt.includes(t) || roleTags.includes(t));
        });
        if (!wheels.length) {
          return i.reply({ content: `找不到符合「${picked.join('、')}」的轉盤，換個標籤試試？`, flags: MessageFlags.Ephemeral });
        }
        const row = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder().setCustomId('wpick').setPlaceholder('選擇一個轉盤開始抽取')
            .addOptions(wheels.slice(0, 25).map(w => ({
              label: w.name.slice(0, 100),
              description: (w.description || '').slice(0, 100) || undefined,
              value: String(w.id)
            })))
        );
        return i.reply({ content: `符合「${picked.join('、')}」的轉盤有 ${wheels.length} 個：`, components: [row], flags: MessageFlags.Ephemeral });
      }

      // 選定轉盤 → 直接抽
      if (i.isStringSelectMenu() && i.customId === 'wpick') {
        return doDraw(i, i.values[0]);
      }

      // 轉盤面板上的標籤選單 → 只抽符合所選標籤（可複選）的角色
      if (i.isStringSelectMenu() && i.customId.startsWith('wtag:')) {
        // 選了「不限標籤」就當作不篩選；否則抽符合任一所選標籤的角色
        const picked = i.values.includes('__all__') ? [] : i.values;
        return doDraw(i, i.customId.split(':')[1], picked);
      }

      if (!i.isButton()) return;

      // ---- 8.5 抽取 ----
      if (i.customId.startsWith('wheel:')) return doDraw(i, i.customId.split(':')[1]);

      // ---- 8.7 收藏 ----
      if (i.customId.startsWith('wfav:')) {
        const roleId = parseInt(i.customId.split(':')[1], 10);
        const exists = db.prepare('SELECT 1 FROM wheel_favorites WHERE user_id=? AND role_id=?').get(i.user.id, roleId);
        if (exists) {
          db.prepare('DELETE FROM wheel_favorites WHERE user_id=? AND role_id=?').run(i.user.id, roleId);
          db.prepare('UPDATE wheel_roles SET fav_count = MAX(0, fav_count - 1) WHERE id=?').run(roleId);
          return i.reply({ content: '已取消收藏。', flags: MessageFlags.Ephemeral });
        }
        db.prepare('INSERT INTO wheel_favorites (guild_id, user_id, role_id) VALUES (?,?,?)').run(i.guild.id, i.user.id, roleId);
        db.prepare('UPDATE wheel_roles SET fav_count = fav_count + 1 WHERE id=?').run(roleId);
        return i.reply({ content: '已加入收藏！可用面板的「我的收藏」查看。', flags: MessageFlags.Ephemeral });
      }

      // ---- 8.15 點擊聊天室連結（同時計入統計與已體驗）----
      if (i.customId.startsWith('wchat:')) {
        const [, rid, idx] = i.customId.split(':');
        const roleId = parseInt(rid, 10);
        const role = db.prepare('SELECT * FROM wheel_roles WHERE id=?').get(roleId);
        if (!role) return i.reply({ content: '找不到角色。', flags: MessageFlags.Ephemeral });
        const links = roleLinks(role);
        const link = links[parseInt(idx, 10) || 0] || links[0];
        if (!link) return i.reply({ content: '這個角色還沒有連結。', flags: MessageFlags.Ephemeral });
        db.prepare('UPDATE wheel_roles SET click_count = click_count + 1 WHERE id=?').run(roleId);
        db.prepare(
          `INSERT INTO wheel_chats (guild_id, user_id, role_id, wheel_id, round) VALUES (?,?,?,?,?)
           ON CONFLICT(user_id, role_id) DO NOTHING`
        ).run(i.guild.id, i.user.id, roleId, role.wheel_id, getRound(i.user.id, role.wheel_id));
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setLabel('開啟 ' + (link.label || '連結')).setStyle(ButtonStyle.Link).setURL(link.url));
        return i.reply({ content: `${link.emoji || ''} **${role.name}** — ${link.label || '連結'}：`, components: [row], flags: MessageFlags.Ephemeral });
      }

      // ---- 我的收藏 ----
      if (i.customId === 'wfavlist') {
        const favs = db.prepare(
          `SELECT r.*, w.name AS wheel_name FROM wheel_favorites f
             JOIN wheel_roles r ON r.id = f.role_id
             JOIN role_wheels w ON w.id = r.wheel_id
            WHERE f.user_id = ? AND w.guild_id = ? ORDER BY f.created_at DESC LIMIT 25`
        ).all(i.user.id, i.guild.id);
        if (!favs.length) return i.reply({ content: '你還沒有收藏任何角色。抽到喜歡的按「收藏角色」吧！', flags: MessageFlags.Ephemeral });
        const embed = new EmbedBuilder().setColor(0xeb459e).setTitle('我的收藏')
          .setDescription(favs.map((f, n) => {
            const ls = roleLinks(f);
            return `**${n + 1}. ${f.name}**（${f.wheel_name}）`
              + (ls.length ? '\n　　' + ls.map(l => `[${l.label || '連結'}](${l.url})`).join('　') : '');
          }).join('\n'));
        return i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      }

      // ---- 8.8 抽取紀錄 ----
      if (i.customId.startsWith('whist:')) {
        const wheelId = parseInt(i.customId.split(':')[1], 10);
        const rows = db.prepare(
          `SELECT d.created_at, r.name, w.name AS wheel_name FROM wheel_draws d
             JOIN wheel_roles r ON r.id = d.role_id
             JOIN role_wheels w ON w.id = d.wheel_id
            WHERE d.user_id=? AND d.wheel_id=? ORDER BY d.id DESC LIMIT 20`
        ).all(i.user.id, wheelId);
        if (!rows.length) return i.reply({ content: '你在這個轉盤還沒有抽取紀錄。', flags: MessageFlags.Ephemeral });
        const embed = new EmbedBuilder().setColor(brandColor()).setTitle('我的抽取紀錄')
          .setDescription(rows.map(r => `\`${r.created_at}\` ${r.name}`).join('\n'));
        return i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      }
    } catch (e) {
      logError(i.guild && i.guild.id, '轉盤互動失敗：', e.message);
      if (!i.replied && !i.deferred) i.reply({ content: '操作失敗，請稍後再試。', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  });

  // ---- 抽取流程（含 8.6 動畫；tags 有值時只抽符合「任一所選標籤」的角色）----
  async function doDraw(i, wheelId, tags = []) {
    // 相容舊呼叫（單一字串），統一成陣列；濾掉空值與「不限標籤」
    const tagList = (Array.isArray(tags) ? tags : (tags ? [tags] : [])).filter(t => t && t !== '__all__');
    const tagMatch = (r) => { const rt = csv(r.tags); return tagList.some(t => rt.includes(t)); };
    // 12.1～12.5 功能權限 / 頻道限制 / 黑名單
    if (!await guard('wheels', i)) return;
    const wheel = db.prepare('SELECT * FROM role_wheels WHERE id=?').get(wheelId);
    if (!wheel) return i.reply({ content: '找不到轉盤。', flags: MessageFlags.Ephemeral });
    if (!wheel.enabled || !wheel.listed) return i.reply({ content: '此轉盤目前已下架。', flags: MessageFlags.Ephemeral });
    if (!inPeriod(wheel)) return i.reply({ content: '此轉盤不在活動期間內。', flags: MessageFlags.Ephemeral });

    // 8.9 每日抽取限制
    if (wheel.daily_limit > 0) {
      const used = todayDraws(i.user.id, wheel.id);
      if (used >= wheel.daily_limit) {
        return i.reply({ content: `你今天在「${wheel.name}」已抽取 ${used}/${wheel.daily_limit} 次，明天再來吧！`, flags: MessageFlags.Ephemeral });
      }
    }

    let { pool, all, round } = availableRoles(wheel, i.user.id);
    if (!all.length) return i.reply({ content: '此轉盤尚未設定角色。', flags: MessageFlags.Ephemeral });

    // 玩家選了標籤（可複選）→ 池子只留符合任一所選標籤的角色
    if (tagList.length) {
      const allTagged = all.filter(tagMatch);
      if (!allTagged.length) {
        return i.reply({ content: `這個轉盤目前沒有「${tagList.join('、')}」類型的角色。`, flags: MessageFlags.Ephemeral });
      }
      pool = pool.filter(tagMatch);
      all = allTagged;
    }

    // 8.10 / 8.15 全部抽（聊）完 → 自動重置，開始新一輪
    let reset = false;
    if (!pool.length) {
      if (tagList.length) {
        // 只抽某些標籤時抽完該類型 → 僅重開該類型的池子，不動整個轉盤的輪次進度
        pool = all;
      } else {
        round = bumpRound(i.user.id, wheel.id, i.guild.id);
        if (wheel.exclude_chatted) {
          db.prepare('DELETE FROM wheel_chats WHERE user_id=? AND wheel_id=?').run(i.user.id, wheel.id);
        }
        pool = all;
      }
      reset = true;
    }

    // 8.6 抽取動畫
    await i.reply({ content: '轉盤轉動中……', flags: MessageFlags.Ephemeral });
    const frames = ['　 　', '　 　', '　 　 '];
    for (const f of frames) {
      await new Promise(r => setTimeout(r, 450));
      await i.editReply({ content: f }).catch(() => {});
    }

    const role = weightedPick(pool);
    db.prepare('INSERT INTO wheel_draws (guild_id, wheel_id, role_id, user_id, username, round) VALUES (?,?,?,?,?,?)')
      .run(i.guild.id, wheel.id, role.id, i.user.id, i.user.username, round);
    db.prepare('UPDATE wheel_roles SET draw_count = draw_count + 1 WHERE id=?').run(role.id);

    const faved = !!db.prepare('SELECT 1 FROM wheel_favorites WHERE user_id=? AND role_id=?').get(i.user.id, role.id);
    const payload = await roleEmbed(role, wheel, faved, i.member?.displayName || i.user.username);
    const tagNote = tagList.length ? `標籤「${tagList.join('、')}」` : '';
    if (reset) payload.content = `你已體驗完${tagList.length ? `「${tagList.join('、')}」類型的` : '這個轉盤的'}所有角色，開始新一輪推薦！`;
    else if (wheel.daily_limit > 0) {
      payload.content = `${tagNote ? tagNote + '　' : ''}今日已抽 ${todayDraws(i.user.id, wheel.id)}/${wheel.daily_limit} 次`;
    } else payload.content = tagNote;
    // 只有本人看得到（ephemeral）→ 頻道對其他人永遠乾淨；玩家關掉/重整 Discord 就會消失
    await i.editReply(payload).catch(() => {});
  }

  client._postWheel = (wheelId, chId) => postWheel(client, wheelId, chId);
  client._postWheelFilter = (chId) => postFilter(client, chId);
  console.log('  ↳ 角色轉盤模組已載入（標籤篩選/收藏/權重/不重複/每日限制/統計）');
}

module.exports = { init, postWheel, postFilter };
