// 14.2 統一 Embed 樣式：顏色、頁尾、縮圖由後台「外觀自訂」設定
const { EmbedBuilder } = require('discord.js');
const { getSetting } = require('../db');
const { absUrl } = require('./url');

const DEFAULT_COLOR = 0x5865f2;

function brandColor(fallback = DEFAULT_COLOR) {
  const raw = String(getSetting('embed_color', '')).trim().replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(raw)) return fallback;
  return parseInt(raw, 16);
}

/** 建立套用了全站樣式的 Embed。color 可覆寫（例如警告用紅色）。 */
function brandEmbed(color) {
  const embed = new EmbedBuilder().setColor(color ?? brandColor());
  const footer = getSetting('embed_footer');
  if (footer) embed.setFooter({ text: footer });
  // 縮圖若是本機上傳的相對路徑（/uploads/…）要轉成完整網址，否則 Discord 會拒收整個 Embed
  const thumb = getSetting('embed_thumb');
  if (thumb) { try { embed.setThumbnail(absUrl(thumb)); } catch {} }
  return embed;
}

module.exports = { brandEmbed, brandColor, DEFAULT_COLOR };
