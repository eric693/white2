// 冒險面板：改成「分類入口 → 私人分頁面板」。
//
// 為什麼不做成直接在釘選訊息上切換分頁：那則訊息是公開共用的，
// 任何人按一下就會改掉所有人看到的內容。所以釘選訊息只留分類入口，
// 點下去會開一份「只有你看得到」的分頁面板，在那上面切換才安全。
//
// 實際動作仍由各模組的 adv:* / stk:* 接手，這裡只負責版面。
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, PermissionsBitField } = require('discord.js');
const { brandColor } = require('../../util/brand');
const { guildConfig } = require('../../db');

const mk = (id, label, emoji, style = ButtonStyle.Secondary) =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(style);

// ---- 分頁定義：一個地方改，入口與內頁同步 ----
const TABS = {
  gather: {
    label: '冒險', emoji: '🎣', color: 0x3498db,
    title: '🎣 出門冒險',
    desc: '出門找素材。每個動作各有冷卻，工具會耗損，記得 `/修理`。\n撿到的東西會自動記進 **📖 圖鑑**，賣掉也不會消失。',
    rows: [
      [['adv:fish', '釣魚', '🎣'], ['adv:mine', '挖礦', '⛏️'], ['adv:wood', '伐木', '🪓'], ['adv:forage', '採集', '🧺'], ['adv:hunt', '狩獵', '🏹']],
      [['adv:bag', '背包', '🎒'], ['adv:status', '查看狀態', '📊'], ['adv:map', '地圖', '🗺️'], ['adv:quest', '任務', '📜', ButtonStyle.Primary]]
    ]
  },
  // 製作獨立成一個分類：家具、工具、農地、牧場、魚缸、孵化室、溫室都是從這裡做出來的，
  // 以前藏在「冒險」分頁最後一顆按鈕，玩家根本找不到。
  craft: {
    label: '製作', emoji: '🔨', color: 0xe67e22,
    title: '🔨 製作與鍛造',
    desc: '把撿來的材料變成東西：**工具、家具**，還有**農地／溫室／牧場／孵化室／魚缸**的格子。\n'
      + '先看 📋 配方確認材料，再按下面的按鈕做。工具壞了用 `/修理` 比重買便宜。',
    rows: [
      [['adv:recipe', '配方一覽', '📋', ButtonStyle.Primary], ['adv:craftmake', '製作', '🔨', ButtonStyle.Success], ['adv:forge', '鍛造工具', '⚒️', ButtonStyle.Success]],
      [['adv:furniture', '做家具', '🛋️'], ['adv:repair', '修理工具', '🔧'], ['adv:bag', '看背包材料', '🎒']]
    ]
  },
  produce: {
    label: '生產', emoji: '🌾', color: 0x2ecc71,
    title: '🌾 牧場與農地',
    desc: '養動物、種作物、養魚。產物是家園升級與烹飪的原料 —— 別急著全部賣掉。\n沒收成的東西會被別人 `/偷`，記得早點收。',
    rows: [
      [['adv:ranch', '牧場', '🐔'], ['adv:harvest', '收成', '🥛'], ['adv:incubator', '孵化室', '🥚'], ['adv:aquarium', '魚缸', '🐠']],
      [['adv:farm', '農地', '🌾'], ['adv:greenhouse', '溫室', '🏡'], ['adv:reap', '採收', '🌻']]
    ]
  },
  home: {
    label: '我的家', emoji: '🏡', color: 0xe91e63,
    title: '🏡 我的家',
    desc: '把採集、生產的成果變成長期資產。\n房屋 12 階 → 蓋廚房做料理 → 擺家具、養寵物 → 送禮攻略角色 → 收集圖鑑、做任務解成就。\n**所有加成都在這條線上**，用 ⭐ 家園加成 隨時查目前有多少。',
    rows: [
      [['adv:home', '我的家', '🏠', ButtonStyle.Primary], ['adv:kitchen', '廚房', '🍳'], ['adv:furniture', '家具', '🛋️'], ['adv:pets', '寵物', '🐾'], ['adv:love', '約會', '💕']],
      [['adv:checkin', '簽到', '📅', ButtonStyle.Success], ['adv:dex', '圖鑑', '📖'], ['adv:titles', '成就', '🏅'], ['adv:buffs', '家園加成', '⭐'], ['adv:homeweb', '完整網頁版', '🖼️', ButtonStyle.Primary]]
    ]
  },
  shop: {
    label: '商店', emoji: '🏪', color: 0xf1c40f,
    title: '🏪 商店街',
    desc: '要花錢的都在這裡。買工具與體力、動物、種子、魚、家具、寵物，還有設施等級（擴充格數）。',
    rows: [
      [['adv:store', '一般商店', '🏪', ButtonStyle.Success], ['adv:ranchshop', '畜牧商店', '🛒', ButtonStyle.Success], ['adv:cropshop', '種子商店', '🌱', ButtonStyle.Success]],
      [['adv:facility', '設施商店', '🏗️', ButtonStyle.Success], ['adv:aqshop', '水族商店', '🐠', ButtonStyle.Success]],
      // 家具與寵物本來只能從「我的家」進去，玩家找不到 —— 直接放進商店街
      [['adv:furniture', '家具商店', '🛋️', ButtonStyle.Success], ['adv:pets', '寵物商店', '🐾', ButtonStyle.Success]]
    ]
  },
  money: {
    label: '金錢', emoji: '💰', color: 0x9b59b6,
    title: '💰 賺錢與理財',
    desc: '賣東西、玩股票、繳稅、借錢。\n⚠️ 股價可能跌到**負數**，賣出會倒扣星幣，出場前先看清楚現價。',
    rows: [
      [['adv:sellpick', '賣出', '💰', ButtonStyle.Primary], ['adv:draw', '每日抽籤', '🎲', ButtonStyle.Primary], ['adv:trade', '交易', '🔄', ButtonStyle.Primary]],
      [['stk:market', '股市行情', '📈', ButtonStyle.Primary], ['stk:buymenu', '買股', '📥', ButtonStyle.Success], ['stk:sellmenu', '賣股', '📤', ButtonStyle.Danger], ['stk:mine', '我的持股', '📊'], ['stk:news', '財經新聞', '📰']],
      [['adv:tax', '稅務', '🧾'], ['adv:charity', '基金會', '❤️'], ['adv:loan', '物資貸款', '🏦']]
    ]
  }
};

// 分頁導覽列（跟「我的家」同一套視覺語言：目前所在的分頁是實心的）
const navRow = (active) => new ActionRowBuilder().addComponents(
  ...Object.entries(TABS).map(([k, t]) =>
    mk(`pan:${k}`, t.label, t.emoji, k === active ? ButtonStyle.Primary : ButtonStyle.Secondary)));

/** 某一個分頁的私人面板 */
function tabPanel(key) {
  const t = TABS[key] || TABS.gather;
  const embed = new EmbedBuilder().setColor(t.color).setTitle(t.title).setDescription(t.desc)
    .setFooter({ text: '只有你看得到這則訊息｜上排可切換分類' });
  const rows = [navRow(key), ...t.rows.map(r => new ActionRowBuilder().addComponents(...r.map(b => mk(...b))))];
  return { embeds: [embed], components: rows.slice(0, 5) };
}

/** 釘選在頻道的入口訊息（公開，所有人共用，所以不放會改內容的按鈕） */
function buildPanel() {
  const embed = new EmbedBuilder().setColor(brandColor()).setTitle('🌿 冒險生活 · 主選單')
    .setDescription(
      '選一個分類，會開一份**只有你看得到**的面板，在那裡面點按鈕就能玩，全程不用打指令。\n\n' +
      `🎣 **冒險**　釣魚、挖礦、伐木、採集、狩獵、背包、任務\n` +
      `🌾 **生產**　牧場、農地、溫室、魚缸、收成\n` +
      `🏡 **我的家**　簽到、房屋、廚房、家具、寵物、約會、圖鑑、成就\n` +
      `🏪 **商店**　五家商店，要花錢的都在這\n` +
      `💰 **金錢**　賣出、股市、稅務、貸款\n\n` +
      '完整說明打 `/幫助`。')
    .setFooter({ text: '點分類 → 開私人面板 → 在裡面隨意切換，不會洗版' });
  return { embeds: [embed], components: [navRow(null)] };
}

async function publishPanel(channel) {
  const sent = await channel.send(buildPanel());
  await sent.pin().catch(() => {});
  return sent;
}

function init(client) {
  client._postAdventurePanel = (chId) => {
    const ch = client.channels.cache.get(chId);
    return ch ? publishPanel(ch) : Promise.reject(new Error('找不到頻道'));
  };
  client.on('interactionCreate', async (i) => {
    try {
      // 分頁切換：從釘選訊息點進來是「新開一則私人訊息」，
      // 在私人訊息裡再切換就是就地更新，兩種情況要分開處理。
      if (i.isButton() && i.customId.startsWith('pan:')) {
        const key = i.customId.split(':')[1];
        const panel = tabPanel(key);
        // ephemeral 訊息才可以就地更新；公開的釘選訊息一律另開私人面板
        const isPrivate = Boolean(i.message?.flags?.has?.(MessageFlags.Ephemeral));
        return isPrivate
          ? i.update(panel).catch(() => {})
          : i.reply({ ...panel, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      if (!i.isChatInputCommand() || i.commandName !== '冒險面板') return;
      const admin = i.member && (i.member.permissions.has(PermissionsBitField.Flags.ManageGuild) || i.member.permissions.has(PermissionsBitField.Flags.Administrator));
      if (!admin) return i.reply({ content: '只有管理員能發布面板。', flags: MessageFlags.Ephemeral });
      const sent = await publishPanel(i.channel).catch(() => null);
      if (!sent) return i.reply({ content: '發布失敗，請確認機器人在這個頻道有「發送訊息」權限。', flags: MessageFlags.Ephemeral });
      return i.reply({
        content: '✅ 已發布新版主選單並自動釘選。\n\n舊的面板訊息可以直接刪掉（新版把 21 顆按鈕收成 5 個分類，而且每個人開的是自己的面板，不會互相影響）。\n\n**想讓它永遠停在最下面不被洗版**：把這個頻道設成只有機器人能發言（@everyone 關掉「傳送訊息」但保留可看到、可用應用程式指令）。',
        flags: MessageFlags.Ephemeral
      });
    } catch (e) {
      if (i.isRepliable() && !i.replied) i.reply({ content: '面板開啟失敗。', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  });
  console.log('  ↳ 冒險面板已載入（6 分類，私人分頁面板）');
}

module.exports = { init, buildPanel, tabPanel, TABS };
