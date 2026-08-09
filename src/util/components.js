// 多個連結按鈕（圖標＋文字＋網址）→ Discord ActionRow
// Discord 限制：每排 5 個、最多 5 排 = 25 個按鈕
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

// 把 emoji 字串轉成 setEmoji 可接受的格式：
// 自訂表情 <:name:id> / <a:name:id> → { id, name, animated }；unicode emoji 原樣
function parseEmoji(raw) {
  const m = String(raw || '').trim().match(/^<(a?):(\w+):(\d+)>$/);
  if (m) return { animated: m[1] === 'a', name: m[2], id: m[3] };
  return raw;
}

function parseButtons(raw) {
  if (!raw) return [];
  let list = raw;
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(list)) return [];
  return list
    .filter(b => b && b.url && /^https?:\/\//.test(b.url))
    .slice(0, 25);
}

/** 把按鈕設定轉成 components 陣列（可直接放進 message payload）。 */
function buildButtonRows(raw, fallback) {
  let list = parseButtons(raw);
  // 相容舊的單一按鈕欄位
  if (!list.length && fallback && fallback.url && /^https?:\/\//.test(fallback.url)) {
    list = [{ label: fallback.label || '前往', url: fallback.url }];
  }
  if (!list.length) return [];

  const rows = [];
  for (let i = 0; i < list.length; i += 5) {
    const row = new ActionRowBuilder();
    for (const b of list.slice(i, i + 5)) {
      const btn = new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(b.url)
        .setLabel((b.label || '前往').slice(0, 80));
      if (b.emoji) { try { btn.setEmoji(parseEmoji(b.emoji)); } catch { /* 無效 emoji 就略過 */ } }
      row.addComponents(btn);
    }
    rows.push(row);
  }
  return rows;
}

module.exports = { buildButtonRows, parseButtons, parseEmoji };
