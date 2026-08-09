// 冒險面板：一則訊息＋整齊的按鈕格，玩家直接點就執行對應動作（不用打指令）。
// 按鈕由各功能模組（gather/ranch/crops/special）用 customId 'adv:*' 接手處理。
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, PermissionsBitField } = require('discord.js');
const { brandColor } = require('../../util/brand');
const { guildConfig } = require('../../db');

function buildPanel() {
  const embed = new EmbedBuilder().setColor(brandColor()).setTitle('🌿 冒險生活 · 一鍵面板')
    .setDescription('點下方按鈕直接玩，不用打指令！結果只有你自己看得到。\n\n' +
      '⬜ **灰色**＝採集與查看（釣魚、挖礦、背包、牧場、農地…）\n' +
      '🟦 **藍色**＝賣錢／抽籤／交易\n' +
      '🟩 **綠色**＝四家商店，全部集中在同一排（買道具、動物、種子、設施等級）\n\n' +
      '想看**全部狀況**（動物數、作物數、工具耐久…）就點 **📊查看狀態**。完整說明打 `/幫助`。')
    .setFooter({ text: '需要選項目的（種植/飼養/兌換/製作）請用 /，其餘一鍵搞定' });
  const mk = (id, label, emoji, style = ButtonStyle.Secondary) =>
    new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(style);
  const rows = [
    // 灰＝採集動作
    new ActionRowBuilder().addComponents(mk('adv:fish', '釣魚', '🎣'), mk('adv:mine', '挖礦', '⛏️'), mk('adv:wood', '伐木', '🪓'), mk('adv:forage', '採集', '🧺'), mk('adv:hunt', '狩獵', '🏹')),
    // 藍＝經濟動作（賣錢、抽獎、交易）
    new ActionRowBuilder().addComponents(mk('adv:sellpick', '賣出', '💰', ButtonStyle.Primary), mk('adv:draw', '每日抽籤', '🎲', ButtonStyle.Primary), mk('adv:trade', '交易', '🔄', ButtonStyle.Primary), mk('adv:bag', '背包', '🎒'), mk('adv:status', '查看狀態', '📊')),
    // 🟢 綠＝四家商店集中一排，一眼就知道「要花錢的都在這」
    new ActionRowBuilder().addComponents(
      mk('adv:store', '一般商店', '🏪', ButtonStyle.Success),
      mk('adv:ranchshop', '畜牧商店', '🛒', ButtonStyle.Success),
      mk('adv:cropshop', '種子商店', '🌱', ButtonStyle.Success),
      mk('adv:facility', '設施商店', '🏗️', ButtonStyle.Success),
      mk('adv:aqshop', '水族商店', '🐠', ButtonStyle.Success)),
    // 灰＝牧場區日常
    new ActionRowBuilder().addComponents(mk('adv:ranch', '牧場', '🐔'), mk('adv:harvest', '收成', '🥛'), mk('adv:incubator', '孵化室', '🥚'), mk('adv:recipe', '製作', '🔨'), mk('adv:map', '地圖', '🗺️')),
    // 灰＝農地區日常
    new ActionRowBuilder().addComponents(mk('adv:farm', '農地', '🌾'), mk('adv:greenhouse', '溫室', '🏡'), mk('adv:reap', '採收', '🌻'), mk('adv:quest', '任務', '📜', ButtonStyle.Primary), mk('adv:aquarium', '魚缸', '🐠'))
  ];
  return { embeds: [embed], components: rows };
}

// 股市面板（第二則訊息）：主面板 5 排已滿，股市另發一則。按鈕由 stock 模組的 stk:* 接手。
// 🧾 稅務按鈕也放這排（主面板沒位子了），由 tax 模組的 adv:tax 接手。
function buildStockPanel(gid) {
  const c = gid ? guildConfig('market_config', gid) : {};
  const fee = c.fee_pct ?? 2;
  const embed = new EmbedBuilder().setColor(0x2ecc71).setTitle('📈 星幣股市 · 面板')
    .setDescription('用星幣買賣股票賺價差——價格每小時跳動，還會被 📰財經新聞影響，高風險高報酬。\n' +
      `全部**用點的**：看行情、看持股、買股、賣股都不用打指令（買賣各收 ${fee}% 交易稅、有交易冷卻）。\n` +
      '⚠️ 股價可能跌到**負數**，這時賣出會**倒扣星幣**，出場前先看清楚現價。\n' +
      '🧾 想知道自己會被課多少稅、什麼時候結算，點 **稅務** 查。');
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('stk:market').setLabel('股市行情').setEmoji('📈').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('stk:buymenu').setLabel('買股').setEmoji('📥').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('stk:sellmenu').setLabel('賣股').setEmoji('📤').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('stk:mine').setLabel('我的持股').setEmoji('📊').setStyle(ButtonStyle.Secondary));
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('stk:news').setLabel('財經新聞').setEmoji('📰').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('stk:quotes').setLabel('目前行情').setEmoji('📊').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('adv:tax').setLabel('稅務').setEmoji('🧾').setStyle(ButtonStyle.Secondary));
  return { embeds: [embed], components: [row1, row2] };
}

async function publishPanel(channel) {
  const sent = await channel.send(buildPanel());
  await sent.pin().catch(() => {});   // 釘選，方便玩家隨時從釘選找到
  const stk = await channel.send(buildStockPanel(channel.guild && channel.guild.id)).catch(() => null);
  if (stk) await stk.pin().catch(() => {});
  return sent;
}

function init(client) {
  client._postAdventurePanel = (chId) => {
    const ch = client.channels.cache.get(chId);
    return ch ? publishPanel(ch) : Promise.reject(new Error('找不到頻道'));
  };
  client.on('interactionCreate', async (i) => {
    if (!i.isChatInputCommand() || i.commandName !== '冒險面板') return;
    const admin = i.member && (i.member.permissions.has(PermissionsBitField.Flags.ManageGuild) || i.member.permissions.has(PermissionsBitField.Flags.Administrator));
    if (!admin) return i.reply({ content: '只有管理員能發布面板。', flags: MessageFlags.Ephemeral });
    const sent = await publishPanel(i.channel).catch(() => null);
    if (!sent) return i.reply({ content: '發布失敗，請確認機器人在這個頻道有「發送訊息」權限。', flags: MessageFlags.Ephemeral });
    return i.reply({
      content: '✅ 已在這個頻道發布冒險面板，並自動釘選。\n\n**想讓它永遠停在最下面不被洗版**：把這個頻道設成只有機器人能發言（@everyone 關掉「傳送訊息」但保留可看到、可用應用程式指令）。玩家點按鈕不需要發言權限，結果又只有自己看得到，面板就會一直停在底部。',
      flags: MessageFlags.Ephemeral
    });
  });
  console.log('  ↳ 冒險面板已載入（/冒險面板 發布可點按鈕，自動釘選）');
}

module.exports = { init, buildPanel };
