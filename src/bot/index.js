const { Client, GatewayIntentBits, Partials } = require('discord.js');
const path = require('path');
const fs = require('fs');
const { getSetting, ensureGuild, db } = require('../db');
const { commands } = require('./commands');
const { absUrl } = require('../util/url');

// 頭像存的是 /uploads/xxx 相對路徑；setAvatar 需要「本機檔路徑」或「完整網址」。
// 本機檔優先（不必連外），找不到才退回公開網址。
const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');
function resolveAvatar(v) {
  if (!v) return v;
  if (v.startsWith('/uploads/')) {
    const p = path.join(UPLOADS_DIR, path.basename(v));
    return fs.existsSync(p) ? p : absUrl(v);
  }
  return v;
}

// 指令即時註冊到某台伺服器：伺服器指令會「立刻」生效（全域指令要等最多 1 小時）。
async function registerGuildCommands(guildId, guildName) {
  try {
    await client.application.commands.set(commands, guildId);
    console.log(`  ↳ 已即時註冊 ${commands.length} 個指令到 ${guildName || guildId}`);
  } catch (e) { console.error(`註冊指令到 ${guildName || guildId} 失敗：`, e.message); }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

// 14 個功能模組各自監聽同一批事件，預設上限 10 會誤報記憶體洩漏警告
client.setMaxListeners(50);

let ready = false;

// 要載入的功能模組（每個匯出 init(client)）
const FEATURES = [
  'keywords', 'alerts', 'forum', 'reactionroles', 'welcome', 'birthday', 'announcements',
  'poll', 'giveaway', 'wheel', 'reminder', 'music', 'tickets', 'xp', 'gather', 'facility', 'ranch', 'aquarium', 'special', 'trades', 'crops', 'stock', 'tax', 'charity', 'loans', 'help', 'panel'
];

client.once('clientReady', async () => {
  ready = true;
  console.log(`✅ Discord 機器人已上線：${client.user.tag}`);
  // 多伺服器：把目前所在的每個伺服器登錄並初始化設定
  for (const [, g] of client.guilds.cache) {
    try { ensureGuild(g.id, g.name, g.iconURL() || ''); } catch (e) { console.error('登錄伺服器失敗：', e.message); }
  }
  console.log(`  ↳ 服務中的伺服器：${client.guilds.cache.size} 個`);
  for (const f of FEATURES) {
    try { require(`./features/${f}`).init(client); }
    catch (e) { console.error(`載入功能 ${f} 失敗：`, e.message); }
  }
  // 指令即時註冊：清掉全域那份（避免與伺服器指令重複顯示），改對每台所在伺服器直接註冊 → 立即生效
  try { await client.application.commands.set([]); } catch (e) { console.error('清除全域指令失敗：', e.message); }
  for (const [, g] of client.guilds.cache) await registerGuildCommands(g.id, g.name);
  applyAppearance().catch(() => {});
});

// 被邀請進新伺服器 → 檢查白名單，未核准就自動退出（只給朋友使用）
client.on('guildCreate', async (g) => {
  try {
    const row = db.prepare('SELECT approved FROM guilds WHERE guild_id = ?').get(g.id);
    const openMode = getSetting('allow_any_guild', '0') === '1';   // 後台可切換為開放加入

    if (!row && !openMode) {
      // 全新且未預先核准 → 記錄待審核，只通知「你自己的」管理頻道，不在對方伺服器留言。
      // （在別人伺服器「發訊息後立刻離開」會被 Discord 反濫發系統判定成廣告/濫發，導致機器人被標記）
      db.prepare(`INSERT INTO guilds (guild_id, name, icon, active, approved, owner_id)
                  VALUES (?, ?, ?, 0, 0, ?)
                  ON CONFLICT(guild_id) DO UPDATE SET name=excluded.name, icon=excluded.icon`)
        .run(g.id, g.name, g.iconURL() || '', g.ownerId || '');
      await notifyPendingGuild(g);
      await g.leave().catch(() => {});
      console.log(`⛔ 未授權的伺服器已自動退出（未留言）：${g.name}（${g.id}）— 可到後台核准後重新邀請`);
      return;
    }
    if (row && !row.approved && !openMode) {
      await notifyPendingGuild(g);
      await g.leave().catch(() => {});
      console.log(`⛔ 尚未核准的伺服器已自動退出（未留言）：${g.name}（${g.id}）`);
      return;
    }
    ensureGuild(g.id, g.name, g.iconURL() || '');
    db.prepare('UPDATE guilds SET owner_id = ?, approved = 1 WHERE guild_id = ?').run(g.ownerId || '', g.id);
    console.log(`➕ 加入新伺服器：${g.name}（${g.id}）`);
    await registerGuildCommands(g.id, g.name);   // 立即註冊指令，進伺服器馬上可用
  } catch (e) { console.error('初始化新伺服器失敗：', e.message); }
});

// 在「邀請機器人的那個伺服器」裡找一個機器人能發言的文字頻道
function firstSendableChannel(g) {
  const me = g.members.me;
  if (!me) return null;
  const can = (c) => c && c.isTextBased && c.isTextBased() && c.permissionsFor(me)?.has('SendMessages') && c.permissionsFor(me)?.has('ViewChannel');
  if (can(g.systemChannel)) return g.systemChannel;
  return g.channels.cache.filter(can).sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0)).first() || null;
}

// 有人邀請未授權的機器人 → 在對方伺服器留一則「請聯繫作者開通」訊息（內容可後台自訂）
async function notifyInvitingServer(g) {
  const ch = firstSendableChannel(g);
  if (!ch) return;
  const botName = (client.user && client.user.username) || '本機器人';
  const contact = getSetting('invite_contact')
    || '本機器人採邀請制，需先由作者開通後才能使用。請聯繫作者開通後再重新邀請，謝謝！';
  await ch.send(
    `👋 感謝邀請 **${botName}**！\n\n` +
    `⚠️ ${contact}\n\n` +
    `（未開通前機器人無法使用，將先自動離開；開通後重新邀請即可正常運作。）`
  ).catch(() => {});
}

// 有人邀請未授權的機器人 → 通知你的管理頻道
async function notifyPendingGuild(g) {
  const chId = getSetting('admin_channel');
  if (!chId) return;
  const ch = client.channels.cache.get(chId) || await client.channels.fetch(chId).catch(() => null);
  if (!ch) return;
  await ch.send(
    `🔔 **有人把機器人邀請到未授權的伺服器**\n` +
    `伺服器：**${g.name}**（\`${g.id}\`）\n` +
    `擁有者：<@${g.ownerId}>\n` +
    `成員數：${g.memberCount}\n\n` +
    `機器人已自動退出。若要允許，請到後台「伺服器管理」核准後再請對方重新邀請。`
  ).catch(() => {});
}
// 被移出伺服器 → 標記為停用（保留資料）
client.on('guildDelete', (g) => {
  try { db.prepare('UPDATE guilds SET active = 0 WHERE guild_id = ?').run(g.id); console.log(`➖ 已離開伺服器：${g.name}`); }
  catch {}
});

// 14.1 機器人名稱、頭像、狀態與活動
async function applyAppearance() {
  if (!client.user) return;
  const name = getSetting('bot_name');
  if (name && client.user.username !== name) {
    try { await client.user.setUsername(name); } catch { console.warn('設定機器人名稱失敗（Discord 每小時限 2 次）'); }
  }
  const avatar = getSetting('bot_avatar');
  if (avatar) { try { await client.user.setAvatar(resolveAvatar(avatar)); } catch (e) { console.warn('設定頭像失敗（Discord 有頻率限制，稍後會自動重試）：', e.message); } }

  const status = getSetting('bot_status', 'online');       // online | idle | dnd | invisible
  const text = getSetting('bot_activity_text');
  const typeName = getSetting('bot_activity_type', 'Playing');
  const TYPES = { Playing: 0, Streaming: 1, Listening: 2, Watching: 3, Competing: 5 };
  try {
    client.user.setPresence({
      status,
      activities: text ? [{ name: text, type: TYPES[typeName] ?? 0 }] : []
    });
  } catch (e) { console.warn('設定機器人狀態失敗：', e.message); }
}

// ---- 互動看門狗：3 秒內沒有任何模組回應就記一筆，避免玩家只看到「應用程式沒有回應」卻查不到原因 ----
client.on('interactionCreate', (i) => {
  const what = i.isChatInputCommand() ? `/${i.commandName}`
    : (i.isButton() || i.isStringSelectMenu()) ? `元件 ${i.customId}` : null;
  if (!what) return;
  setTimeout(() => {
    if (i.replied || i.deferred) return;
    const { logError } = require('../db');
    logError(i.guildId || '', '互動無回應：', `${what}（使用者 ${i.user?.username || i.user?.id}，頻道 ${i.channelId}）`);
  }, 2800);
});

// ---- 穩定性防護：任何未捕捉的錯誤都不讓機器人整個掛掉 ----
process.on('unhandledRejection', (err) => {
  console.error('未處理的 Promise 錯誤：', err && err.stack ? err.stack : err);
  try { require('../db').logError('', '未處理的 Promise 錯誤：', (err && err.stack) ? err.stack.slice(0, 1500) : String(err)); } catch {}
});
process.on('uncaughtException', (err) => {
  console.error('未捕捉的例外：', err && err.stack ? err.stack : err);
  // 不 exit，交給 pm2 監控；嚴重錯誤 pm2 會自動重啟
});

// Discord 連線狀態監控
client.on('error', (e) => console.error('Discord 連線錯誤：', e.message));
client.on('shardError', (e) => console.error('Discord shard 錯誤：', e.message));
client.on('shardDisconnect', (ev, id) => console.error(`Discord 連線中斷（shard ${id}，代碼 ${ev && ev.code}），將自動重連`));
client.on('shardReconnecting', (id) => console.log(`🔄 Discord 重新連線中（shard ${id}）…`));
client.on('shardResume', (id, n) => console.log(`✅ Discord 連線已恢復（shard ${id}，補回 ${n} 個事件）`));

function start() {
  const token = process.env.DISCORD_TOKEN;
  if (!token || token === '你的機器人Token') {
    console.warn('⚠️  尚未設定 DISCORD_TOKEN，機器人未啟動（後台網站仍可使用）。請填好 .env 後重啟。');
    return;
  }
  client.login(token).catch(err => console.error('❌ 機器人登入失敗：', err.message));
}

function isReady() { return ready; }
// 指定 guildId 時回該伺服器，否則回主伺服器（相容舊呼叫）
function mainGuild(guildId) { return client.guilds.cache.get(guildId || process.env.GUILD_ID); }
// 機器人目前所在的伺服器清單（供後台切換）
function guildList() {
  return [...client.guilds.cache.values()].map(g => ({
    id: g.id, name: g.name, icon: g.iconURL() || '', members: g.memberCount
  }));
}

// 取頻道物件（供各功能發送訊息）
async function fetchChannel(id) {
  if (!id) return null;
  try { return client.channels.cache.get(id) || await client.channels.fetch(id); }
  catch { return null; }
}

// 上傳自訂圖示為 Application Emoji，回傳可用於按鈕的 markup（<:name:id>）
async function uploadAppEmoji(buffer, rawName) {
  if (!client.application) throw new Error('機器人尚未上線');
  // emoji 名稱只能英數與底線，2~32 字
  let name = String(rawName || 'icon').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 28) || 'icon';
  name = 'w' + name + Date.now().toString(36).slice(-4); // 保證唯一
  const emoji = await client.application.emojis.create({ attachment: buffer, name });
  return { id: emoji.id, name: emoji.name, markup: `<:${emoji.name}:${emoji.id}>`, url: emoji.imageURL() };
}
async function deleteAppEmoji(emojiId) {
  if (!client.application) return;
  await client.application.emojis.delete(emojiId).catch(() => {});
}

module.exports = { client, start, isReady, mainGuild, guildList, applyAppearance, fetchChannel, uploadAppEmoji, deleteAppEmoji };
