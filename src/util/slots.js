// 找空格子：格數開到上萬時，`used.includes(s)` 是 O(n²) —— 36,000 格的玩家
// 買一隻動物就要跑十幾億次比對，整隻機器人會卡住幾十秒（2026-10 事故）。
// 用 Set 查表是 O(n)，同樣的資料只要幾毫秒。

/** 第一個空格（沒有就回 -1） */
function firstFreeSlot(usedSlots, max) {
  const used = usedSlots instanceof Set ? usedSlots : new Set(usedSlots);
  for (let s = 0; s < max; s++) if (!used.has(s)) return s;
  return -1;
}

/** 前 n 個空格（n 省略＝全部空格） */
function freeSlots(usedSlots, max, n = Infinity) {
  const used = usedSlots instanceof Set ? usedSlots : new Set(usedSlots);
  const out = [];
  for (let s = 0; s < max && out.length < n; s++) if (!used.has(s)) out.push(s);
  return out;
}

module.exports = { firstFreeSlot, freeSlots };
