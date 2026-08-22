// 家園狀態卡：把整個家園畫成一張圖，玩家按一個按鈕就看到。
//
// 為什麼要畫圖：Discord 的 Embed 一則只能放 1 張大圖 + 1 張縮圖，也沒有卡片分區、
// 進度條、並排佈局。要做出「一區一區」的漂亮版面，只能自己把它畫成 PNG。
// 沿用 rolecard.js 那套字型堆疊，暱稱裡的冷門符號才不會變豆腐方塊。
const path = require('path');
const fs = require('fs');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');

for (const [p, name] of [
  ['/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc', 'HomeBold'],
  ['/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', 'HomeReg'],
  ['/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf', 'HomeEmoji'],
  ['/usr/share/fonts/truetype/noto/NotoSansSymbols-Regular.ttf', 'HomeSym'],
  ['/usr/share/fonts/truetype/noto/NotoSansSymbols2-Regular.ttf', 'HomeSym2'],
  ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 'HomeDejaVu'],
  ['/usr/share/fonts/opentype/unifont/unifont.otf', 'HomeUni']
]) { try { if (fs.existsSync(p)) GlobalFonts.registerFromPath(p, name); } catch {} }
const FB = 'HomeEmoji, HomeSym, HomeSym2, HomeDejaVu, HomeUni, sans-serif';
const BOLD = (n) => `bold ${n}px HomeBold, ${FB}`;
const REG = (n) => `${n}px HomeReg, ${FB}`;

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
const W = 1000, H = 720;
const C = {
  bg1: '#fff5fa', bg2: '#f4efff', card: '#ffffff', line: '#f0d9e8',
  ink: '#3b3340', muted: '#9b8fa3', pink: '#e879b9', pinkL: '#fdf2f8',
  ok: '#38a169', no: '#e53e3e', gold: '#d69e2e'
};

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

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
// 卡片區塊：白底、圓角、淡粉邊框 —— 就是「一區一區」的視覺來源
function panel(ctx, x, y, w, h, title) {
  ctx.save();
  ctx.shadowColor = 'rgba(190,140,180,.14)'; ctx.shadowBlur = 12; ctx.shadowOffsetY = 3;
  ctx.fillStyle = C.card; roundRect(ctx, x, y, w, h, 16); ctx.fill();
  ctx.restore();
  ctx.strokeStyle = C.line; ctx.lineWidth = 1.5; roundRect(ctx, x, y, w, h, 16); ctx.stroke();
  if (title) {
    ctx.fillStyle = C.ink; ctx.font = BOLD(19); ctx.textAlign = 'left';
    ctx.fillText(title, x + 18, y + 32);
  }
}
function bar(ctx, x, y, w, pct, color = C.pink, h = 9) {
  ctx.fillStyle = '#f2e8f2'; roundRect(ctx, x, y, w, h, h / 2); ctx.fill();
  const fw = Math.max(0, Math.min(1, pct)) * w;
  if (fw > 0) { ctx.fillStyle = color; roundRect(ctx, x, y, fw, h, h / 2); ctx.fill(); }
}
// 超長就截斷加省略號，避免撞出卡片外
function clip(ctx, text, max) {
  let s = String(text ?? '');
  if (ctx.measureText(s).width <= max) return s;
  while (s.length > 1 && ctx.measureText(s + '…').width > max) s = s.slice(0, -1);
  return s + '…';
}
const num = (n) => Number(n || 0).toLocaleString('en-US');

/**
 * opts: { name, level, levelName, levelEmoji, coins, currency,
 *         pets:[{emoji,name,intimacy,skill,pct}], petCap,
 *         furniture:{placed,cap}, kitchen:{level,name}|null,
 *         needs:[{item,have,need}], nextLevel:{level,name,coins}|null,
 *         buffs:[{label,pct}], titles:[{emoji,name,buff}], dex:[{label,have,total}],
 *         affinity:[{name,level,levelName,points,image}], checkin:{streak,week:[bool×7]},
 *         houseImage }
 */
async function makeHomeCard(o) {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // 背景漸層
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, C.bg1); g.addColorStop(1, C.bg2);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

  // ---- 頂部：房屋大字 + 五個數據格 ----
  panel(ctx, 20, 20, W - 40, 152);
  const houseImg = await resolveImage(o.houseImage);
  let tx = 40;
  if (houseImg) {
    ctx.save(); roundRect(ctx, 38, 38, 116, 116, 14); ctx.clip();
    ctx.drawImage(houseImg, 38, 38, 116, 116); ctx.restore();
    ctx.strokeStyle = C.line; roundRect(ctx, 38, 38, 116, 116, 14); ctx.stroke();
    tx = 172;
  }
  ctx.textAlign = 'left';
  ctx.fillStyle = C.ink; ctx.font = BOLD(38);
  ctx.fillText(`${o.levelEmoji || '🏠'} Lv.${o.level}`, tx, 78);
  ctx.fillStyle = C.pink; ctx.font = BOLD(24);
  ctx.fillText(clip(ctx, o.levelName || '小屋', 240), tx, 110);
  ctx.fillStyle = C.muted; ctx.font = REG(16);
  ctx.fillText(clip(ctx, `${o.name} 的家`, 240), tx, 136);

  const cells = [
    ['💰 ' + (o.currency || '星幣'), num(o.coins)],
    ['🐾 寵物', `${o.pets.length} / ${o.petCap}`],
    ['🛋️ 家具', `${o.furniture.placed} / ${o.furniture.cap}`],
    ['🍳 廚房', o.kitchen ? `Lv.${o.kitchen.level}` : '未建造'],
    ['🏅 成就', `${o.titles.length} 個`]
  ];
  const cw = 142, cx0 = W - 40 - cells.length * cw - (cells.length - 1) * 8;
  cells.forEach(([label, val], idx) => {
    const x = cx0 + idx * (cw + 8);
    ctx.fillStyle = C.pinkL; roundRect(ctx, x, 44, cw, 66, 11); ctx.fill();
    ctx.fillStyle = C.muted; ctx.font = REG(13); ctx.fillText(clip(ctx, label, cw - 20), x + 11, 66);
    ctx.fillStyle = C.ink; ctx.font = BOLD(20); ctx.fillText(clip(ctx, val, cw - 20), x + 11, 94);
  });

  // 簽到七格
  if (o.checkin) {
    ctx.fillStyle = C.muted; ctx.font = REG(13);
    ctx.fillText(`📅 連續簽到 ${o.checkin.streak} 天`, 40, 160);
    const DOW = ['一', '二', '三', '四', '五', '六', '日'];
    o.checkin.week.forEach((on, idx) => {
      const x = 200 + idx * 30;
      ctx.fillStyle = on ? C.pink : '#eee6ee';
      roundRect(ctx, x, 148, 24, 16, 5); ctx.fill();
      ctx.fillStyle = on ? '#fff' : C.muted; ctx.font = BOLD(11); ctx.textAlign = 'center';
      ctx.fillText(DOW[idx], x + 12, 160); ctx.textAlign = 'left';
    });
  }

  // ---- 左：升級進度 ----
  panel(ctx, 20, 188, 470, 218, '🔨 升級進度');
  if (o.nextLevel) {
    ctx.fillStyle = C.muted; ctx.font = REG(14);
    ctx.fillText(clip(ctx, `Lv.${o.level} → Lv.${o.nextLevel.level} ${o.nextLevel.name}`, 430), 38, 242);
    let y = 254;
    const rows = [{ item: `💰 ${o.currency || '星幣'}`, have: o.coins, need: o.nextLevel.coins }, ...o.needs].slice(0, 6);
    for (const r of rows) {
      const ok = r.have >= r.need;
      ctx.fillStyle = C.ink; ctx.font = REG(14);
      ctx.fillText(clip(ctx, r.item, 200), 38, y + 12);
      ctx.fillStyle = ok ? C.ok : C.no; ctx.font = BOLD(14); ctx.textAlign = 'right';
      ctx.fillText(`${num(r.have)} / ${num(r.need)}`, 470, y + 12);
      ctx.textAlign = 'left';
      bar(ctx, 38, y + 19, 432, r.need ? r.have / r.need : 1, ok ? C.ok : C.pink, 6);
      y += 34;
    }
  } else {
    ctx.fillStyle = C.muted; ctx.font = REG(15);
    ctx.fillText('🎉 家園已蓋到最高階', 38, 250);
  }

  // ---- 右：圖鑑完成度 ----
  panel(ctx, 506, 188, 474, 218, '📖 圖鑑完成度');
  {
    let y = 224;
    for (const d of (o.dex || []).slice(0, 5)) {
      ctx.fillStyle = C.ink; ctx.font = REG(14);
      ctx.fillText(clip(ctx, d.label, 200), 524, y + 12);
      ctx.fillStyle = C.muted; ctx.font = REG(13); ctx.textAlign = 'right';
      ctx.fillText(`${d.have} / ${d.total}`, 962, y + 12);
      ctx.textAlign = 'left';
      bar(ctx, 524, y + 19, 438, d.total ? d.have / d.total : 0, C.pink, 6);
      y += 34;
    }
  }

  // ---- 左下：寵物 ----
  panel(ctx, 20, 422, 470, 276, `🐾 寵物　${o.pets.length}/${o.petCap}`);
  if (o.pets.length) {
    let y = 470;
    for (const p of o.pets.slice(0, 4)) {
      ctx.fillStyle = C.pinkL; roundRect(ctx, 36, y, 438, 54, 11); ctx.fill();
      ctx.font = REG(26); ctx.fillText(p.emoji || '🐾', 48, y + 36);
      ctx.fillStyle = C.ink; ctx.font = BOLD(15);
      ctx.fillText(clip(ctx, p.name, 200), 88, y + 22);
      ctx.fillStyle = C.muted; ctx.font = REG(12);
      ctx.fillText(clip(ctx, `${p.skill}　+${p.pct}%`, 250), 88, y + 44);
      bar(ctx, 300, y + 34, 160, p.intimacy / 100, '#f56ba5', 7);
      ctx.fillStyle = C.muted; ctx.font = REG(11); ctx.textAlign = 'right';
      ctx.fillText(`親密 ${p.intimacy}`, 460, y + 24); ctx.textAlign = 'left';
      y += 62;
    }
  } else {
    ctx.fillStyle = C.muted; ctx.font = REG(14);
    ctx.fillText('還沒有寵物　需要家園 Lv.3 鄉間住宅', 38, 476);
  }

  // ---- 右下：成就 + 加成 ----
  panel(ctx, 506, 422, 474, 276, '🏅 裝備中的成就');
  {
    let y = 466;
    const eq = (o.titles || []).filter(t => t.equipped).slice(0, 3);
    if (eq.length) {
      for (const t of eq) {
        ctx.fillStyle = C.pinkL; roundRect(ctx, 522, y, 442, 42, 10); ctx.fill();
        ctx.strokeStyle = C.pink; ctx.lineWidth = 1.5; roundRect(ctx, 522, y, 442, 42, 10); ctx.stroke();
        ctx.fillStyle = C.ink; ctx.font = BOLD(14);
        ctx.fillText(clip(ctx, `${t.emoji || '🏅'} ${t.name}`, 200), 534, y + 18);
        ctx.fillStyle = C.pink; ctx.font = REG(12);
        ctx.fillText(clip(ctx, t.buff || '無加成', 420), 534, y + 34);
        y += 50;
      }
    } else {
      ctx.fillStyle = C.muted; ctx.font = REG(14);
      ctx.fillText('還沒有裝備成就（同時最多 3 個）', 524, y + 14);
      y += 40;
    }
    ctx.fillStyle = C.ink; ctx.font = BOLD(15);
    ctx.fillText('⭐ 目前總加成', 524, y + 22);
    y += 34;
    let bx = 524;
    for (const b of (o.buffs || []).slice(0, 8)) {
      ctx.font = REG(12);
      const label = `${b.label} +${b.pct}%`;
      const w = ctx.measureText(label).width + 20;
      if (bx + w > 962) { bx = 524; y += 28; }
      if (y > 676) break;
      ctx.fillStyle = C.pinkL; roundRect(ctx, bx, y, w, 22, 11); ctx.fill();
      ctx.fillStyle = C.ink; ctx.fillText(label, bx + 10, y + 15);
      bx += w + 6;
    }
    if (!(o.buffs || []).length) {
      ctx.fillStyle = C.muted; ctx.font = REG(13);
      ctx.fillText('目前沒有任何加成', 524, y + 14);
    }
  }

  return canvas.toBuffer('image/png');
}

module.exports = { makeHomeCard };
