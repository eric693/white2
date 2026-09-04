// 貼文轉盤：指定一則貼文，直接從「留言的人」裡面隨機抽。
//
// 跟一般抽獎的差別：不需要玩家額外按參加按鈕、不需要登記名單 —— 有留言就有資格。
// 一個人留幾則都只算 1 個資格（預設），不然洗留言的人中獎機率會被灌大。
const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags
} = require('discord.js');
const { logError } = require('../../db');
const { brandColor } = require('../../util/brand');

// 從訊息連結或純 ID 取出訊息 ID 與（連結才有的）頻道 ID
// 支援：https://discord.com/channels/<guild>/<channel>/<message>、以及直接貼訊息 ID
function parseTarget(input) {
  const s = String(input || '').trim();
  const link = s.match(/channels\/(\d+)\/(\d+)\/(\d+)/);
  if (link) return { guildId: link[1], channelId: link[2], messageId: link[3] };
  if (/^\d{5,}$/.test(s)) return { messageId: s };
  return null;
}

// 蒐集一則貼文的留言者。
// 三種留言型態都算：
//   ① 貼文底下開的討論串（論壇貼文、或訊息開的 thread）裡的發言
//   ② 同頻道中「回覆」這則訊息的訊息
//   ③ 該訊息本身的表情回應者（可選，預設不算）
async function collectCommenters(msg, { includeReactions = false } = {}) {
  const people = new Map();   // userId → { id, tag, count }
  const add = (user, n = 1) => {
    if (!user || user.bot) return;
    const cur = people.get(user.id) || { id: user.id, tag: user.username, count: 0 };
    cur.count += n;
    people.set(user.id, cur);
  };

  // ① 討論串
  const thread = msg.thread || (msg.channel.isThread?.() ? msg.channel : null);
  if (thread) {
    let before;
    for (let page = 0; page < 10; page++) {          // 最多 1000 則，夠用且不會打爆 API
      const batch = await thread.messages.fetch({ limit: 100, before }).catch(() => null);
      if (!batch || batch.size === 0) break;
      for (const [, m] of batch) {
        if (m.id === msg.id) continue;               // 論壇貼文的第一則是貼文本體
        add(m.author);
      }
      before = batch.last().id;
      if (batch.size < 100) break;
    }
  }

  // ② 同頻道裡回覆這則訊息的人
  if (!msg.channel.isThread?.()) {
    let before;
    for (let page = 0; page < 5; page++) {
      const batch = await msg.channel.messages.fetch({ limit: 100, before }).catch(() => null);
      if (!batch || batch.size === 0) break;
      for (const [, m] of batch) {
        if (m.reference?.messageId === msg.id) add(m.author);
      }
      before = batch.last().id;
      if (batch.size < 100) break;
      if (batch.last().createdTimestamp < msg.createdTimestamp) break;   // 已翻過貼文本身，再往前也不會有回覆
    }
  }

  // ③ 表情回應者
  if (includeReactions) {
    for (const [, r] of msg.reactions.cache) {
      const users = await r.users.fetch().catch(() => null);
      if (users) for (const [, u] of users) add(u);
    }
  }

  return [...people.values()];
}

// 抽選。allowRepeat=false 時同一人不會被抽中兩次。
// 每人的中獎權重固定為 1（不管留言幾則），這是「洗留言不加機率」的實作點。
function drawWinners(pool, count, allowRepeat) {
  const winners = [];
  const bag = [...pool];
  for (let n = 0; n < count; n++) {
    if (!bag.length) break;
    const idx = Math.floor(Math.random() * bag.length);
    winners.push(bag[idx]);
    if (!allowRepeat) bag.splice(idx, 1);
  }
  return winners;
}

async function handle(i) {
  const input = i.options.getString('貼文');
  const count = i.options.getInteger('抽出人數') || 1;
  const allowRepeat = i.options.getBoolean('允許重複中獎') || false;
  const includeReactions = i.options.getBoolean('表情也算留言') || false;
  const perMessage = i.options.getBoolean('每則留言算一次資格') || false;

  const target = parseTarget(input);
  if (!target) {
    return i.reply({
      content: '看不懂這則貼文。請貼「訊息連結」（在訊息上按「⋯」→ 複製訊息連結），或直接給訊息 ID。',
      flags: MessageFlags.Ephemeral
    });
  }

  await i.deferReply();

  // 有連結就用連結指定的頻道，只給 ID 就當作在目前頻道
  const channel = target.channelId
    ? await i.client.channels.fetch(target.channelId).catch(() => null)
    : i.channel;
  if (!channel || !channel.messages) return i.editReply('找不到那則貼文所在的頻道，或機器人看不到該頻道。');

  const msg = await channel.messages.fetch(target.messageId).catch(() => null);
  if (!msg) return i.editReply('找不到那則貼文（可能已被刪除，或機器人沒有讀取該頻道歷史訊息的權限）。');

  let people;
  try { people = await collectCommenters(msg, { includeReactions }); }
  catch (e) {
    logError(i.guildId, '貼文轉盤讀取留言失敗：', e.message);
    return i.editReply('讀取留言時發生錯誤，請確認機器人有「讀取訊息記錄」權限後再試一次。');
  }

  if (!people.length) return i.editReply('這則貼文目前沒有任何留言者可以抽（機器人的留言不列入）。');

  // 「每則留言算一次資格」是明確打開才生效的例外；預設一人一票，避免洗留言灌機率
  const pool = perMessage
    ? people.flatMap(p => Array(Math.min(p.count, 50)).fill(p))
    : people;

  const winners = drawWinners(pool, Math.min(count, 50), allowRepeat);

  const embed = new EmbedBuilder()
    .setColor(brandColor())
    .setTitle('🎯 貼文轉盤抽選結果')
    .setDescription(
      `**抽選來源**：[前往貼文](${msg.url})\n` +
      `**留言者**：${people.length} 人${perMessage ? `（共 ${people.reduce((a, p) => a + p.count, 0)} 則留言）` : ''}\n` +
      `**抽出**：${winners.length} 位${allowRepeat ? '（允許重複中獎）' : ''}\n\n` +
      winners.map((w, n) => `${n + 1}. <@${w.id}>`).join('\n')
    )
    .setFooter({ text: perMessage ? '每則留言各算一次資格' : '同一人不論留幾則都只算 1 個資格' })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('查看原貼文').setStyle(ButtonStyle.Link).setURL(msg.url));

  await i.editReply({
    content: winners.map(w => `<@${w.id}>`).join(' '),
    embeds: [embed],
    components: [row]
  });
}

function init(client) {
  client.on('interactionCreate', async (i) => {
    try {
      if (!i.isChatInputCommand?.() || i.commandName !== '貼文轉盤') return;
      await handle(i);
    } catch (e) {
      logError(i.guildId, '貼文轉盤失敗：', e.message);
      const msg = '抽選失敗，請稍後再試。';
      if (i.deferred || i.replied) i.editReply(msg).catch(() => {});
      else i.reply({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  });
  console.log('  ↳ 貼文轉盤模組已載入（從貼文留言者中隨機抽選）');
}

module.exports = { init, parseTarget, collectCommenters, drawWinners };
