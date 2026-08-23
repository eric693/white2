// 下拉選單分頁：Discord 一個 StringSelect 最多 25 個選項、一則訊息最多 5 行。
//
// 超過 25 項如果直接 slice(0, 25)，排在後面的東西（食譜、家具、稱號、股票…）
// 會整個從選單上消失，玩家只會覺得「我明明解鎖了卻選不到」，而且完全查不出原因。
// 這裡統一把超出的部分往下一行放，並在提示文字標出這一頁涵蓋的範圍。
//
// customId 規則：第 0 頁用原本的 id（既有的 `customId === id` 判斷不用改），
// 之後每一頁是 `${id}:${頁碼}` —— 處理端請改成 `customId === id || customId.startsWith(id + ':')`。
const { ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');

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
    const part = options.slice(n, n + 25);
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

module.exports = { selectRows, isSelect };
