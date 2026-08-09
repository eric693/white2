// 功能權限判斷（規格 12.1～12.5、11.3 黑名單）
const { MessageFlags } = require('discord.js');
const { db } = require('../db');

const csv = (s) => String(s || '').split(/[\n,]/).map(x => x.trim()).filter(Boolean);

// 可設定權限的功能
const FEATURES = [
  { key: 'music',       label: '音樂' },
  { key: 'giveaways',   label: '抽獎' },
  { key: 'polls',       label: '投票' },
  { key: 'wheels',      label: '角色轉盤' },
  { key: 'birthday',    label: '生日慶生' },
  { key: 'reminders',   label: '提醒' },
  { key: 'announcements', label: '公告' },
  { key: 'keywords',    label: '關鍵字自動回覆' }
];

function getPerm(gid, feature) {
  return db.prepare('SELECT * FROM feature_perms WHERE guild_id = ? AND feature = ?').get(gid, feature)
    || { feature, role_ids: '', channel_ids: '', except_user_ids: '', except_role_ids: '', enabled: 1 };
}

// 11.3 黑名單（可指定功能與到期時間）
function blacklisted(gid, userId, feature) {
  const row = db.prepare(
    `SELECT * FROM blacklist WHERE guild_id = ? AND user_id = ? AND active = 1
       AND (feature = 'all' OR feature = ?)
       AND (expires_at = '' OR expires_at > datetime('now','localtime'))`
  ).get(gid, userId, feature);
  return row || null;
}

/**
 * 判斷成員是否可使用某功能。
 * 回傳 { ok: true } 或 { ok: false, reason: '原因' }
 */
function check(feature, member, channelId, gid) {
  if (!member) return { ok: true };
  gid = gid || (member.guild && member.guild.id);
  const p = getPerm(gid, feature);

  // 12.5 例外名單：完全不受限制（但黑名單仍然擋）
  const bl = blacklisted(gid, member.id, feature);
  // 黑名單的理由與解除時間是後台內部資訊，不回給玩家看（管理員在後台仍看得到完整內容）
  if (bl) return { ok: false, reason: '你目前無法使用此功能。' };

  const isExcept = csv(p.except_user_ids).includes(member.id)
    || member.roles.cache.some(r => csv(p.except_role_ids).includes(r.id));
  if (isExcept) return { ok: true };

  if (!p.enabled) return { ok: false, reason: '此功能目前已停用。' };

  // 12.1 / 12.3 身分組限制
  const roles = csv(p.role_ids);
  if (roles.length && !member.roles.cache.some(r => roles.includes(r.id))) {
    return { ok: false, reason: '你的身分組沒有使用此功能的權限。' };
  }
  // 12.4 頻道限制
  const chans = csv(p.channel_ids);
  if (chans.length && channelId && !chans.includes(channelId)) {
    return { ok: false, reason: `此功能僅能在指定頻道使用（${chans.map(c => `<#${c}>`).join('、')}）。` };
  }
  return { ok: true };
}

// 互動用的簡便包裝：不通過就直接回覆並回傳 false
async function guard(feature, interaction) {
  const r = check(feature, interaction.member, interaction.channelId, interaction.guildId);
  if (r.ok) return true;
 await interaction.reply({ content:''+ r.reason, flags: MessageFlags.Ephemeral }).catch(() => {});
  return false;
}

module.exports = { FEATURES, getPerm, check, guard, blacklisted };
