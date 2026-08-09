// 回覆一則「只有本人看得到」的訊息，並在數秒後自動刪除，保持頻道乾淨。
const { MessageFlags } = require('discord.js');

// content 可以是字串，或完整 payload 物件（含 embeds/components 等）
async function tempReply(i, content, seconds = 8) {
  const payload = typeof content === 'string' ? { content } : { ...content };
  payload.flags = (payload.flags || 0) | MessageFlags.Ephemeral;
  try {
    if (i.replied || i.deferred) await i.followUp(payload);
    else await i.reply(payload);
  } catch { return; }
  setTimeout(() => { i.deleteReply().catch(() => {}); }, Math.max(1, seconds) * 1000);
}

// 針對「面板按鈕」的 i.update（更新原訊息）不適用刪除；這裡提供一個回覆並自動刪的版本
async function tempUpdate(i, payload, seconds = 10) {
  return tempReply(i, payload, seconds);
}

module.exports = { tempReply, tempUpdate };
