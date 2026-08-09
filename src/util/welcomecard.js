// 入群歡迎卡圖：背景圖 + 圓形頭像 + 歡迎文字 + 成員編號
const path = require('path');
const fs = require('fs');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');

// 註冊中文字型（伺服器內建的 Noto Sans CJK）
const FONTS = [
  ['/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc', 'CardBold'],
  ['/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', 'CardRegular'],
  ['/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf', 'CardEmoji']
];
for (const [p, name] of FONTS) {
  try { if (fs.existsSync(p)) GlobalFonts.registerFromPath(p, name); } catch { /* 沒有字型就用預設 */ }
}

const W = 1000, H = 400;
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');

// 把 /uploads/xxx 或完整網址都轉成 loadImage 能吃的來源
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

// 置中裁切繪製（cover）
function drawCover(ctx, img, x, y, w, h) {
  const r = Math.max(w / img.width, h / img.height);
  const dw = img.width * r, dh = img.height * r;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

/**
 * 產生歡迎卡圖。
 * opts: { avatarUrl, bgUrl, title, subtitle, textColor, overlay }
 * 回傳 PNG Buffer
 */
async function makeWelcomeCard(opts = {}) {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // 背景
  const bg = await resolveImage(opts.bgUrl);
  if (bg) drawCover(ctx, bg, 0, 0, W, H);
  else {
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#5865f2');
    g.addColorStop(1, '#eb459e');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  // 半透明遮罩讓文字看得清楚
  const overlay = opts.overlay === undefined ? 0.35 : Number(opts.overlay);
  if (overlay > 0) {
    ctx.fillStyle = `rgba(0,0,0,${Math.min(0.9, overlay)})`;
    ctx.fillRect(0, 0, W, H);
  }

  // 圓形頭像（置中偏上）
  const avatar = await resolveImage(opts.avatarUrl);
  const R = 90, CX = W / 2, CY = 150;
  if (avatar) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(CX, CY, R, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    drawCover(ctx, avatar, CX - R, CY - R, R * 2, R * 2);
    ctx.restore();
  }
  // 頭像外框
  ctx.beginPath();
  ctx.arc(CX, CY, R, 0, Math.PI * 2);
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.stroke();

  const color = opts.textColor || '#ffffff';
  ctx.textAlign = 'center';
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 8;

  // 主標題（自動縮字以免超出畫面）
  const title = String(opts.title || '');
  let size = 46;
  ctx.font = `${size}px CardBold, CardEmoji, sans-serif`;
  while (ctx.measureText(title).width > W - 80 && size > 20) {
    size -= 2;
    ctx.font = `${size}px CardBold, CardEmoji, sans-serif`;
  }
  ctx.fillStyle = color;
  ctx.fillText(title, CX, 300);

  // 副標題（Member #123）
  if (opts.subtitle) {
    ctx.font = '30px CardRegular, CardEmoji, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText(String(opts.subtitle), CX, 348);
  }

  return canvas.toBuffer('image/png');
}

module.exports = { makeWelcomeCard };
