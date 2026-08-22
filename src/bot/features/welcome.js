// 成員加入與退出系統（規格 6.1～6.10）
const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { db, guildConfig, logError } = require('../../db');
const { buildButtonRows } = require('../../util/components');
const { makeWelcomeCard } = require('../../util/welcomecard');
const { absUrl } = require('../../util/url');

const cfg = (gid) => guildConfig('welcome_config', gid);

function fill(tpl, member) {
  const user = member.user || member;
  // {nickname}＝伺服器暱稱（沒設就退回顯示名稱／帳號名）。
  // 退出通知只寫帳號名的話，管理員常常認不出那是誰 —— 大家在群裡叫的是暱稱。
  const nick = member.nickname || member.displayName || user.globalName || user.username;
  const both = nick && nick !== user.username ? `${nick}（${user.username}）` : user.username;
  return String(tpl || '')
    .replace(/{user}/g, `<@${user.id}>`)
    .replace(/{nickname}/g, nick)
    .replace(/{name}/g, both)          // 暱稱（帳號名）：一眼認得出是誰
    .replace(/{username}/g, user.username)
    .replace(/{id}/g, user.id)
    .replace(/{server}/g, member.guild ? member.guild.name : '')
    .replace(/{count}/g, member.guild ? String(member.guild.memberCount) : '');
}

// 給身分組失敗時 Discord 回的訊息很難懂，翻成看得懂的話寫進錯誤紀錄。
// 特別是伺服器開了「需要兩步驟驗證才能執行管理員動作」時，給身分組會回
// 「Missing Access」，跟權限不足長得一模一樣，很容易查錯方向。
function roleErrHint(e) {
  const code = e && (e.code || e.status);
  if (code === 60003) return '機器人擁有者的帳號要開啟兩步驟驗證（2FA），因為伺服器開了「需要兩步驟驗證才能執行管理員動作」';
  if (code === 50001) return 'Missing Access：多半是伺服器開了「需要兩步驟驗證才能執行管理員動作」，但機器人擁有者帳號沒開 2FA';
  if (code === 50013) return 'Missing Permissions：機器人缺少「管理身分組」權限，或自己的身分組位置比要給的身分組低';
  return e.message;
}

// 貼圖（sticker）：Discord 一則訊息最多 3 張，而且不能跟 Embed 放在同一則
function stickerIds(raw) {
  let ids = [];
  try { ids = JSON.parse(raw || '[]'); } catch {}
  return (Array.isArray(ids) ? ids : []).map(String).filter(Boolean).slice(0, 3);
}

const fmt = (d) => d ? new Date(d).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }) : '—';

// 產生歡迎卡圖附件
async function buildCard(c, member) {
  const buf = await makeWelcomeCard({
    avatarUrl: member.user.displayAvatarURL({ extension: 'png', size: 256 }),
    bgUrl: c.card_bg,
    title: fill(c.card_title, member),
    subtitle: fill(c.card_sub, member),
    overlay: parseFloat(c.card_overlay)
  });
  return new AttachmentBuilder(buf, { name: 'welcome.png' });
}

async function fetchChannel(client, id) {
  if (!id) return null;
  return client.channels.cache.get(id) || await client.channels.fetch(id).catch(() => null);
}

// 6.9 這位玩家過去加入過幾次
function pastJoins(gid, userId) {
  return db.prepare("SELECT COUNT(*) AS n FROM member_events WHERE guild_id = ? AND user_id = ? AND event = 'join'").get(gid, userId).n;
}
// 本次加入時間（供離開時計算停留天數）
function lastJoinAt(gid, userId) {
  const row = db.prepare("SELECT created_at FROM member_events WHERE guild_id = ? AND user_id = ? AND event = 'join' ORDER BY id DESC LIMIT 1").get(gid, userId);
  return row ? row.created_at : '';
}

function init(client) {
  // ---- 6.1 歡迎訊息 + 6.6 入群通知 ----
  client.on('guildMemberAdd', async (member) => {
    const gid = member.guild.id;
    const c = cfg(gid);
    const joinCount = pastJoins(gid, member.id) + 1;

    db.prepare(
      `INSERT INTO member_events (guild_id, user_id, username, event, account_at, joined_at, join_count)
       VALUES (?, ?, ?, 'join', ?, ?, ?)`
    ).run(gid, member.id, member.user.username, fmt(member.user.createdAt),
      fmt(member.joinedAt || new Date()), joinCount);

    // 新成員自動給予身分組。要成功需要三個條件：機器人有「管理身分組」權限、
    // 機器人自己的身分組位置高於要給的身分組，而且伺服器若開了「需要兩步驟驗證才能
    // 執行管理員動作」，機器人擁有者的帳號也必須開 2FA，否則 Discord 一律拒絕。
    const autoRoles = String(c.join_roles || '').split(',').map(s => s.trim()).filter(Boolean);
    if (autoRoles.length) {
      for (const rid of autoRoles) {
        const role = member.guild.roles.cache.get(rid);
        if (!role) { logError(gid, '自動給予身分組失敗：', `找不到身分組 ${rid}`); continue; }
        try { await member.roles.add(role, '入群自動給予'); }
        catch (e) { logError(gid, '自動給予身分組失敗：', `${role.name}（${roleErrHint(e)}）`); }
      }
    }

    // 6.1 / 6.4 / 6.5 歡迎訊息
    if (c.join_enabled && c.join_channel) {
      const ch = await fetchChannel(client, c.join_channel);
      if (ch) {
        try {
          const payload = { content: `<@${member.id}>` };
          if (c.join_use_embed) {
            const embed = new EmbedBuilder().setColor(0x3ba55d).setDescription(fill(c.join_message, member));
            if (c.join_title) embed.setTitle(fill(c.join_title, member));
            // 縮圖留空就不顯示（不再自動套玩家頭像）
            if (c.join_thumb) embed.setThumbnail(c.join_thumb);
            if (c.join_image) embed.setImage(absUrl(c.join_image));
            payload.embeds = [embed];
          } else {
            payload.content += '\n' + fill(c.join_message, member);
            if (c.join_image) payload.content += '\n' + absUrl(c.join_image);
          }
          // 6.4 多個連結按鈕
          const rows = buildButtonRows(c.join_buttons, { label: c.join_btn_label, url: c.join_btn_url });
          if (rows.length) payload.components = rows;

          // 歡迎卡圖（頭像 + 文字 + 成員編號）
          if (c.card_enabled) {
            const card = await buildCard(c, member).catch(e => {
              logError(member.guild.id, '歡迎卡圖產生失敗：', e.message); return null;
            });
            if (card) payload.files = [card];
          }
          const stickers = stickerIds(c.join_stickers);
          if (stickers.length && !c.join_use_embed) payload.stickers = stickers;
          await ch.send(payload);
          // Embed 模式不能夾帶貼圖，改成緊接著補一則
          if (stickers.length && c.join_use_embed) {
            await ch.send({ stickers, allowedMentions: { parse: [] } })
              .catch(e => logError(member.guild.id, '入群貼圖失敗：', e.message));
          }
        } catch (e) { logError(member.guild.id, '歡迎訊息失敗：', e.message); }
      }
    }

    // 6.6 入群通知管理員
    if (c.admin_join && c.admin_channel) {
      const ch = await fetchChannel(client, c.admin_channel);
      if (ch) {
        const embed = new EmbedBuilder().setColor(0x3ba55d).setTitle('新成員加入')
          .addFields(
            { name: '玩家', value: `${member.user.tag}（<@${member.id}>）`, inline: true },
            { name: 'Discord ID', value: `\`${member.id}\``, inline: true },
            { name: '加入時間', value: fmt(member.joinedAt || new Date()) },
            { name: '帳號建立日期', value: fmt(member.user.createdAt), inline: true },
            { name: '加入次數', value: joinCount > 1 ? `第 ${joinCount} 次（曾加入過）` : '第 1 次', inline: true }
          )
          .setThumbnail(member.user.displayAvatarURL());
        await ch.send({ embeds: [embed] }).catch(() => {});
      }
    }
  });

  // ---- 6.7 離群通知 + 6.8 離群紀錄 ----
  client.on('guildMemberRemove', async (member) => {
    const gid = member.guild.id;
    const c = cfg(gid);
    const joinedAt = lastJoinAt(gid, member.id) || (member.joinedAt ? fmt(member.joinedAt) : '');
    const stayDays = member.joinedAt
      ? Math.max(0, Math.floor((Date.now() - member.joinedAt.getTime()) / 86400000)) : 0;
    const roles = member.roles && member.roles.cache
      ? member.roles.cache.filter(r => r.id !== member.guild.id).map(r => r.name).join('、') : '';
    const joinCount = pastJoins(gid, member.id);

    db.prepare(
      `INSERT INTO member_events (guild_id, user_id, username, event, roles, account_at, joined_at, stay_days, join_count)
       VALUES (?, ?, ?, 'leave', ?, ?, ?, ?, ?)`
    ).run(gid, member.id, member.user.username, roles, fmt(member.user.createdAt), joinedAt, stayDays, joinCount);

    if (c.leave_enabled && c.leave_channel) {
      const ch = await fetchChannel(client, c.leave_channel);
      if (ch) {
        try {
          const payload = {};
          if (c.leave_use_embed) {
            payload.embeds = [new EmbedBuilder().setColor(0x99aab5).setDescription(fill(c.leave_message, member))];
          } else {
            payload.content = fill(c.leave_message, member) || undefined;
          }
          // 離群卡圖（背景 + 頭像 + 文字）
          if (c.leave_card_enabled) {
            const card = await makeWelcomeCard({
              avatarUrl: member.user.displayAvatarURL({ extension: 'png', size: 256 }),
              bgUrl: c.leave_card_bg,
              title: fill(c.leave_card_title, member),
              subtitle: fill(c.leave_card_sub, member),
              overlay: parseFloat(c.card_overlay)
            }).catch(e => { logError(member.guild.id, '離群卡圖失敗：', e.message); return null; });
            if (card) payload.files = [new AttachmentBuilder(card, { name: 'leave.png' })];
          }
          const stickers = stickerIds(c.leave_stickers);
          if (stickers.length && !c.leave_use_embed) payload.stickers = stickers;
          await ch.send(payload);
          if (stickers.length && c.leave_use_embed) {
            await ch.send({ stickers, allowedMentions: { parse: [] } })
              .catch(e => logError(member.guild.id, '離群貼圖失敗：', e.message));
          }
        } catch (e) { logError(member.guild.id, '離群訊息失敗：', e.message); }
      }
    }

    if (c.admin_leave && c.admin_channel) {
      const ch = await fetchChannel(client, c.admin_channel);
      if (ch) {
        const embed = new EmbedBuilder().setColor(0xed4245).setTitle('成員離開')
          .addFields(
            { name: '玩家', value: `${member.user.tag}（\`${member.id}\`）` },
            { name: '加入日期', value: joinedAt || '—', inline: true },
            { name: '離開日期', value: fmt(new Date()), inline: true },
            { name: '停留天數', value: `${stayDays} 天`, inline: true },
            { name: '累計加入次數', value: `${joinCount} 次`, inline: true },
            { name: '離開前身分組', value: roles || '（無）' }
          );
        await ch.send({ embeds: [embed] }).catch(() => {});
      }
    }
  });

  console.log('  ↳ 加入/退出模組已載入（歡迎/入群通知/離群明細/歷史紀錄）');
}

module.exports = { init };
