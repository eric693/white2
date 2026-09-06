// 下拉選單分頁：Discord 一個 StringSelect 最多 25 個選項、一則訊息最多 5 行。
//
// 超過 25 項如果直接 slice(0, 25)，排在後面的東西（食譜、家具、稱號、股票…）
// 會整個從選單上消失，玩家只會覺得「我明明解鎖了卻選不到」，而且完全查不出原因。
// 這裡統一把超出的部分往下一行放，並在提示文字標出這一頁涵蓋的範圍。
//
// customId 規則：第 0 頁用原本的 id（既有的 `customId === id` 判斷不用改），
// 之後每一頁是 `${id}:${頁碼}` —— 處理端請改成 `customId === id || customId.startsWith(id + ':')`。
const { ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');


// ---- 選單 emoji 的安全過濾 ----
//
// Discord 會把「含有它不認得的新 emoji」的整份元件退回（COMPONENT_INVALID_EMOJI），
// 一個選項壞掉就等於整個選單送不出去 —— 玩家看到的是「應用程式沒有回應」，
// 完全看不出是哪一顆 emoji 害的（2026-09-06：一支股票的 emoji 太新，整個伺服器買不了股）。
//
// Discord 目前吃到 Emoji 15.0（🪼水母、🪿鵝、🫨都可以），之後才加進 Unicode 的
// （Emoji 16／17：🪉🪏🪾🫆🫜🫟🫩…）它還不認得。所以只放行 Emoji 15.0 以前的碼位，
// 太新的就把圖示拿掉、選項本身照樣留著（少一顆圖，總比整個面板打不開好）。
// 1FA70–1FAFF 這一區是近年才陸續補進來的，逐段列出 15.0 為止已存在的：
const EMOJI15_RANGES = [
  [0x1FA70, 0x1FA7C], [0x1FA80, 0x1FA88], [0x1FA90, 0x1FABD], [0x1FABF, 0x1FAC5],
  [0x1FACE, 0x1FADB], [0x1FAE0, 0x1FAE8], [0x1FAF0, 0x1FAF8]
];
function emojiTooNew(str) {
  for (const ch of String(str)) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x1FA70 && cp <= 0x1FAFF && !EMOJI15_RANGES.some(([a, b]) => cp >= a && cp <= b)) return true;
    if (cp > 0x1FAFF && cp < 0x20000) return true;   // 更後面的都是 Discord 還沒支援的新區段
  }
  return false;
}
/**
 * 把後台填的 emoji 轉成選單可用的值。
 * 自訂表情 <:name:id> → 物件；unicode → 原字串；空的或太新的 → undefined（不顯示圖示）。
 */
function safeEmoji(e) {
  if (!e) return undefined;
  const raw = String(e).trim();
  if (!raw) return undefined;
  const m = /^<(a)?:([^:]+):(\d+)>$/.exec(raw);
  if (m) return { id: m[3], name: m[2], animated: !!m[1] };
  return emojiTooNew(raw) ? undefined : raw;
}

/**
 * @param {string} id        select 的 customId（第 0 頁就用它本身）
 * @param {object[]} options 全部選項（已是 Discord 的 option 物件）
 * @param {string} placeholder 提示文字；超過一頁時會自動補上「（1-25）」這種範圍
 * @param {{maxRows?:number, minValues?:number, maxValues?:number}} opt
 * @returns {ActionRowBuilder[]} 可直接放進 components 的列
 */
function selectRows(id, options, placeholder, opt = {}) {
  const { maxRows = 5, minValues = 1, maxValues = 1 } = opt;
  const rows = [];
  for (let n = 0; n < options.length && rows.length < maxRows; n += 25) {
    const part = options.slice(n, n + 25).map(o => (o && o.emoji ? { ...o, emoji: safeEmoji(o.emoji) } : o));
    const ph = options.length > 25 ? `${placeholder}（${n + 1}-${n + part.length}）` : placeholder;
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(rows.length === 0 ? id : `${id}:${rows.length}`)
        .setPlaceholder(ph.slice(0, 150))
        .setMinValues(Math.min(minValues, part.length))
        .setMaxValues(Math.min(maxValues, part.length))
        .addOptions(part)));
  }
  return rows;
}

/** 這個 customId 是不是屬於某個分頁選單（含第 0 頁） */
const isSelect = (customId, id) => customId === id || customId.startsWith(id + ':');

module.exports = { selectRows, isSelect, safeEmoji };
