// 角色小卡：背景圖 + 圓形角色圖 + 角色名 + 副標（作者／標籤）
// 沒有角色圖時不畫圓框，文字自動置中排版。
const path = require('path');
const fs = require('fs');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');

// 字型堆疊：中日韓 → 彩色 emoji → 各種特殊符號 → Unifont 兜底。
// Discord 暱稱常有 ✧ ❄ ⌐ ꕥ 這類冷門符號，只靠 CJK+Emoji 會變成豆腐方塊，
// 所以再疊 Noto Symbols/Symbols2、DejaVu 與 Unifont（幾乎涵蓋整個 BMP）。
for (const [p, name] of [
  ['/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc', 'CardBold'],
  ['/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', 'CardRegular'],
  ['/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf', 'CardEmoji'],
  ['/usr/share/fonts/truetype/noto/NotoSansSymbols-Regular.ttf', 'CardSym'],
  ['/usr/share/fonts/truetype/noto/NotoSansSymbols2-Regular.ttf', 'CardSym2'],
  ['/usr/share/fonts/truetype/noto/NotoSansMath-Regular.ttf', 'CardMath'],
  ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 'CardDejaVu'],
  ['/usr/share/fonts/opentype/unifont/unifont.otf', 'CardUni']
]) {
  try { if (fs.existsSync(p)) GlobalFonts.registerFromPath(p, name); } catch { /* 用系統預設 */ }
}
// 字型後援清單（接在主字型後面），符號才不會變成方框
const FALLBACK = 'CardEmoji, CardSym, CardSym2, CardMath, CardDejaVu, CardUni, sans-serif';
const FONT_BOLD = `CardBold, ${FALLBACK}`;
const FONT_REG = `CardRegular, ${FALLBACK}`;

const W = 1000, H = 420;
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

// 置中裁切（cover）
function drawCover(ctx, img, x, y, w, h) {
  const r = Math.max(w / img.width, h / img.height);
  const dw = img.width * r, dh = img.height * r;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

// 文字過長自動縮字
function fitFont(ctx, text, maxWidth, startSize, family, minSize = 20) {
  let size = startSize;
  ctx.font = `${size}px ${family}`;
  while (ctx.measureText(text).width > maxWidth && size > minSize) {
    size -= 2;
    ctx.font = `${size}px ${family}`;
  }
  return size;
}

/**
 * 產生角色小卡。
 * opts: { imageUrl, bgUrl, name, subtitle, tagline, color, overlay }
 * 沒有 imageUrl 時不畫圓形頭像框。
 */
async function makeRoleCard(opts = {}) {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  const roleImg = await resolveImage(opts.imageUrl);
  const bgImg = await resolveImage(opts.bgUrl) || roleImg;   // 沒指定背景就用角色圖當背景

  // ---- 背景 ----
  if (bgImg) {
    drawCover(ctx, bgImg, 0, 0, W, H);
    // 角色圖當背景時多壓一層暗，避免和前景圓圖打架
    const dark = opts.bgUrl ? (opts.overlay ?? 0.45) : 0.6;
    ctx.fillStyle = `rgba(0,0,0,${Math.min(0.9, dark)})`;
    ctx.fillRect(0, 0, W, H);
  } else {
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, opts.color || '#eb459e');
    g.addColorStop(1, '#5865f2');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  const hasImg = !!roleImg;
  const CX = W / 2;

  // ---- 圓形角色圖（沒有圖就整段跳過，不畫任何框）----
  if (hasImg) {
    const R = 95, CY = 140;
    ctx.save();
    ctx.beginPath();
    ctx.arc(CX, CY, R, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    drawCover(ctx, roleImg, CX - R, CY - R, R * 2, R * 2);
    ctx.restore();
    ctx.beginPath();
    ctx.arc(CX, CY, R, 0, Math.PI * 2);
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    ctx.stroke();
  }

  // ---- 文字（有圖時排在圖下方，沒圖時整體垂直置中）----
  ctx.textAlign = 'center';
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 10;

  const name = String(opts.name || '');
  const nameY = hasImg ? 292 : 160;
  const size = fitFont(ctx, name, W - 100, hasImg ? 54 : 68, FONT_BOLD, 24);
  ctx.font = `${size}px ${FONT_BOLD}`;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(name, CX, nameY);

  // 廣告台詞：固定用大引號「 “ … ” 」包住，粗體白字＋深色描邊，單行不換行（過長自動縮字）
  if (opts.tagline) {
    const family = FONT_BOLD;
    // 去掉頭尾既有的各式引號，統一由程式加上，避免重複
    const raw = String(opts.tagline)
      .replace(/\s+/g, ' ')
      .replace(/^[“”"❝❞「」『』\s]+|[“”"❝❞「」『』\s]+$/g, '')
      .trim().slice(0, 60);
    // 排版用「實際墨跡邊界」而不是字元前進寬度：
    // 引號和全形標點（。）的前進寬度含大量留白，直接用 width 排會讓左右兩邊的空隙差到 3 倍。
    const inkOf = (m) => ({
      lead: -m.actualBoundingBoxLeft,                             // 落筆點到墨跡左緣
      w: m.actualBoundingBoxRight + m.actualBoundingBoxLeft       // 墨跡實際寬度
    });
    // 整串文字若含 emoji（走 fallback 字型），measureText 的墨跡邊界會量不準，
    // 但「前進寬度」一定準。所以整串取前進寬度，只用首尾單一字元推算左右留白。
    const chars = [...raw];
    const bearing = (ch) => {
      const m = ctx.measureText(ch);
      return { lead: Math.max(0, -m.actualBoundingBoxLeft), trail: Math.max(0, m.width - m.actualBoundingBoxRight) };
    };
    // 依整體寬度自動縮字；引號固定為內文的 1.6 倍，更大更明顯
    const measure = (bs) => {
      const qs = Math.round(bs * 1.6);
      ctx.font = `${qs}px ${family}`;
      const q1 = inkOf(ctx.measureText('“'));
      const q2 = inkOf(ctx.measureText('”'));
      ctx.font = `${bs}px ${family}`;
      const adv = ctx.measureText(raw).width;
      const lead = chars.length ? bearing(chars[0]).lead : 0;
      const trail = chars.length ? bearing(chars[chars.length - 1]).trail : 0;
      const t = { lead, w: Math.max(1, adv - lead - trail) };     // 扣掉首尾留白＝實際墨跡寬度
      const gap = Math.round(bs * 0.38);                          // 引號與內文的視覺間距，隨字級縮放
      return { total: q1.w + gap + t.w + gap + q2.w, qs, gap, q1, q2, t };
    };
    const ty = nameY + (hasImg ? 78 : 104);   // 與角色名拉開上下間距
    ctx.save();
    // 注意：墨跡邊界是相對於「對齊基準點」的，必須先切成靠左對齊再量，
    // 否則在置中狀態下量到的會是相對中心點的值，排出來會整串偏掉。
    ctx.textAlign = 'left';

    let body = 34, m = measure(body);
    while (m.total > W - 80 && body > 18) { body -= 2; m = measure(body); }

    ctx.lineJoin = 'round';
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(0,0,0,0.65)';
    ctx.fillStyle = '#ffffff';
    // ink：這一段墨跡要從哪裡開始（整串置中）。每段的落筆點 = 墨跡起點 - 該段的左側留白
    let ink = CX - m.total / 2;
    const draw = (t, seg) => {
      const x = ink - seg.lead;
      ctx.strokeText(t, x, ty); ctx.fillText(t, x, ty);
      ink += seg.w;
    };
    ctx.font = `${m.qs}px ${family}`; draw('“', m.q1); ink += m.gap;
    ctx.font = `${body}px ${family}`; draw(raw, m.t);  ink += m.gap;
    ctx.font = `${m.qs}px ${family}`; draw('”', m.q2);
    ctx.restore();
    ctx.textAlign = 'center';
  }

  // ---- 作者：固定放右下角 ----
  if (opts.subtitle) {
    ctx.textAlign = 'right';
    ctx.font = `26px ${FONT_REG}`;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillText(String(opts.subtitle), W - 30, H - 26);
  }

  // ---- 抽卡者／日期：固定放左下角，永遠是同一條基準線 ----
  // 兩個各自獨立開關，但排版共用同一個左邊起點：
  // 只勾日期時，日期就自動往前補到抽卡者原本的位置，兩種情況版面一致。
  {
    const parts = [];
    if (opts.drawnBy) parts.push(String(opts.drawnBy)); // 只放名字，不加「抽卡：」前綴
    if (opts.date) parts.push(String(opts.date));
    if (parts.length) {
      ctx.textAlign = 'left';
      // 只是紀念性質的落款，字級刻意壓小、透明度調低，不搶角色名與台詞的視覺重心
      ctx.font = `17px ${FONT_REG}`;
      ctx.fillStyle = 'rgba(255,255,255,0.62)';
      ctx.fillText(parts.join('　·　'), 30, H - 26);
    }
  }

  return canvas.toBuffer('image/png');
}

module.exports = { makeRoleCard };
