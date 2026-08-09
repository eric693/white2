// 統一的「發到頻道」工具：一般文字/公告頻道用 send()；
// 論壇(Forum)與媒體(Media)頻道不能直接發訊息，必須開一篇貼文(thread)，
// 這裡自動判斷型別，回傳可用於後續編輯/加表情的訊息物件。
const { ChannelType } = require('discord.js');

function threadName(payload, title) {
  const raw = (title || (payload && payload.content) || '')
    .replace(/<[@#][^>]+>/g, '')     // 去掉標記代碼，避免貼文標題出現 <@123>
    .replace(/[*_`~|]/g, '')
    .trim();
  return (raw || '公告').slice(0, 90) || '公告';
}

// 發到頻道，回傳訊息物件（論壇則回傳貼文的開頭訊息）。title 用於論壇貼文標題。
async function postToChannel(ch, payload, { title } = {}) {
  if (ch.type === ChannelType.GuildForum || ch.type === ChannelType.GuildMedia) {
    const opts = { name: threadName(payload, title), message: payload };
    // 若該論壇設定「發文必須選標籤」，補上第一個可用標籤，否則會被 Discord 擋下
    try {
      if (ch.availableTags && ch.availableTags.length && ch.flags && ch.flags.has && ch.flags.has('RequireTag')) {
        opts.appliedTags = [ch.availableTags[0].id];
      }
    } catch {}
    const thread = await ch.threads.create(opts);
    const starter = await thread.fetchStarterMessage().catch(() => null);
    return starter || { id: thread.id, react: async () => {} };
  }
  return ch.send(payload);
}

const isThreadTarget = (ch) => ch && (ch.type === ChannelType.GuildForum || ch.type === ChannelType.GuildMedia);

module.exports = { postToChannel, isThreadTarget };
