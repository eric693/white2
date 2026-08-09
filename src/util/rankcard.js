// 等級卡圖：背景 + 圓形頭像(含在線點) + 排名/等級 + 使用者名稱 + XP 進度條（MEE6 風格）
const path = require('path');
const fs = require('fs');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');

const FONTS = [
  ['/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc', 'CardBold'],
  ['/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', 'CardRegular'],
  ['/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf', 'CardEmoji']
];
for (const [p, name] of FONTS) {
  try { if (fs.existsSync(p)) GlobalFonts.registerFromPath(p, name); } catch { /* 沒字型就用預設 */ }
}

const W = 900, H = 260;
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');

async function resolveImage(src) {
  if (!src) return null;
  try {
    if (src.startsWith('/uploads/')) {
      const p = path.join(UPLOAD_DIR, path.basename(src));
      return fs.existsSync(p) ? await loadImage(p) : null;
    }
    if (/^https?:\/\//.test(src)) {
      const res = await fetch(src);
      if (!res.ok) return null;
      return await loadImage(Buffer.from(await res.arrayBuffer()));
    }
  } catch { return null; }
  return null;
}

function drawCover(ctx, img, x, y, w, h) {
  const r = Math.max(w / img.width, h / img.height);
  const dw = img.width * r, dh = img.height * r;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// 316 → "316"，3620 → "3.62K"，1200000 → "1.2M"
function fmtXp(n) {
  n = Number(n) || 0;
  if (n < 1000) return String(n);
  if (n < 1000000) return (n / 1000).toFixed(n < 10000 ? 2 : 1).replace(/\.?0+$/, '') + 'K';
  return (n / 1000000).toFixed(2).replace(/\.?0+$/, '') + 'M';
}

/**
 * 產生等級卡。
 * opts: { username, avatarUrl, level, rank, xpInto, xpNeed, totalXp, bgUrl, barColor, status }
 * 回傳 PNG Buffer
 */
async function makeRankCard(opts = {}) {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // ---- 背景 ----
  ctx.fillStyle = '#2b2d31';
  ctx.fillRect(0, 0, W, H);
  const bg = await resolveImage(opts.bgUrl);
  if (bg) drawCover(ctx, bg, 0, 0, W, H);
  // 讓文字看得清楚的遮罩
  ctx.fillStyle = bg ? 'rgba(20,20,25,0.55)' : 'rgba(0,0,0,0.15)';
  ctx.fillRect(0, 0, W, H);

  // ---- 圓形頭像 ----
  const R = 82, CX = 140, CY = H / 2;
  const avatar = await resolveImage(opts.avatarUrl);
  if (avatar) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(CX, CY, R, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    drawCover(ctx, avatar, CX - R, CY - R, R * 2, R * 2);
    ctx.restore();
  } else {
    ctx.beginPath(); ctx.arc(CX, CY, R, 0, Math.PI * 2);
    ctx.fillStyle = '#5865f2'; ctx.fill();
  }
  // 頭像白框
  ctx.beginPath(); ctx.arc(CX, CY, R, 0, Math.PI * 2);
  ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.stroke();
  // 在線狀態點（右下）
  const STATUS = { online: '#23a55a', idle: '#f0b232', dnd: '#f23f43', offline: '#80848e' };
  const dot = STATUS[opts.status] || STATUS.online;
  const dx = CX + R * 0.72, dy = CY + R * 0.72;
  ctx.beginPath(); ctx.arc(dx, dy, 18, 0, Math.PI * 2);
  ctx.fillStyle = '#2b2d31'; ctx.fill();
  ctx.beginPath(); ctx.arc(dx, dy, 12, 0, Math.PI * 2);
  ctx.fillStyle = dot; ctx.fill();

  const LEFT = 250;            // 右側資訊區左緣
  const RIGHT = W - 40;        // 右緣
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 6;

  // ---- 右上：排名 #? 等級 ? ----
  const level = Number(opts.level) || 0;
  const rank = Number(opts.rank) || 0;
  const barColor = opts.barColor || '#f57390';
  ctx.textAlign = 'right';
  let x = RIGHT;
  // 等級數字（大、彩色）
  ctx.font = '54px CardBold, sans-serif';
  ctx.fillStyle = barColor;
  ctx.fillText(String(level), x, 78);
  x -= ctx.measureText(String(level)).width + 10;
  ctx.font = '26px CardRegular, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.fillText('等級', x, 74);
  x -= ctx.measureText('等級').width + 26;
  // 排名數字（大、白）
  ctx.font = '48px CardBold, sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.fillText('#' + rank, x, 76);
  x -= ctx.measureText('#' + rank).width + 10;
  ctx.font = '26px CardRegular, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.fillText('排名', x, 74);

  // ---- 使用者名稱（左）+ XP 文字（右）----
  const into = Number(opts.xpInto) || 0, need = Math.max(1, Number(opts.xpNeed) || 1);
  // 先量 XP 文字寬度，算出名字的可用寬度（兩者同一行，避免重疊）
  ctx.font = '30px CardRegular, sans-serif';
  const xpText = `${fmtXp(into)} / ${fmtXp(need)} XP`;
  const maxNameW = RIGHT - LEFT - ctx.measureText(xpText).width - 24;

  // 名字：先自動縮小字級塞下完整名字（最小 22px），真的太長才截斷加 …
  let name = String(opts.username || '玩家');
  let nameSize = 42;
  ctx.font = `${nameSize}px CardBold, CardEmoji, sans-serif`;
  while (ctx.measureText(name).width > maxNameW && nameSize > 22) {
    nameSize -= 2;
    ctx.font = `${nameSize}px CardBold, CardEmoji, sans-serif`;
  }
  if (ctx.measureText(name).width > maxNameW) {
    while (name.length > 1 && ctx.measureText(name + '…').width > maxNameW) name = name.slice(0, -1);
    name += '…';
  }
  ctx.textAlign = 'left';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(name, LEFT, 158);

  ctx.textAlign = 'right';
  ctx.font = '30px CardRegular, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.fillText(xpText, RIGHT, 156);

  // ---- XP 進度條 ----
  ctx.shadowBlur = 0;
  const barX = LEFT, barY = 182, barW = RIGHT - LEFT, barH = 30;
  roundRect(ctx, barX, barY, barW, barH, barH / 2);
  ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fill();
  const ratio = Math.max(0, Math.min(1, into / need));
  if (ratio > 0) {
    const fillW = Math.max(barH, barW * ratio);   // 至少一個圓頭寬
    ctx.save();
    roundRect(ctx, barX, barY, barW, barH, barH / 2);
    ctx.clip();
    roundRect(ctx, barX, barY, fillW, barH, barH / 2);
    ctx.fillStyle = barColor; ctx.fill();
    ctx.restore();
  }

  return canvas.toBuffer('image/png');
}

module.exports = { makeRankCard };
