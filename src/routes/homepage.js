// 玩家的個人家園網頁。
//
// 為什麼要有網頁版：Discord 的 Embed 做不出卡片式分區、多圖並排、進度條那種版面
// （一則訊息只能有 1 張大圖 + 1 張縮圖）。所以「漂亮的那一版」走網頁，
// Discord 那邊維持按鈕操作，兩邊看的是同一份資料。
//
// 網址帶一個 HMAC 簽章的 token（綁 guild+user），任何人拿到連結都只看得到那個人的家，
// 而且改不了任何東西 —— 這是唯讀頁，不需要登入後台。
const express = require('express');
const crypto = require('crypto');
const { db, guildConfig } = require('../db');
const { absUrl } = require('../util/url');
const { userBuffs, BUFF_TYPES } = require('../util/buffs');

const router = express.Router();
const SECRET = process.env.JWT_SECRET || 'dev-insecure-secret-change-me';

/** guild+user → 不可偽造的短 token */
function homeToken(gid, uid) {
  const body = Buffer.from(`${gid}.${uid}`).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url').slice(0, 16);
  return `${body}.${sig}`;
}
function parseToken(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const want = crypto.createHmac('sha256', SECRET).update(body).digest('base64url').slice(0, 16);
  // 固定時間比對，避免用回應時間試出簽章
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  const [gid, uid] = Buffer.from(body, 'base64url').toString().split('.');
  return gid && uid ? { gid, uid } : null;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => Number(n || 0).toLocaleString('en-US');

/** 把一個玩家的家園狀態全部撈出來 */
function collect(gid, uid) {
  const g = (sql, ...a) => db.prepare(sql).get(gid, ...a);
  const all = (sql, ...a) => db.prepare(sql).all(gid, ...a);
  const gc = guildConfig('gather_config', gid);
  const home = g('SELECT * FROM home_users WHERE guild_id=? AND user_id=?', uid);
  if (!home) return null;
  const lv = g('SELECT * FROM home_levels WHERE guild_id=? AND level=?', home.level) || {};
  const nextLv = g('SELECT * FROM home_levels WHERE guild_id=? AND level=?', home.level + 1);
  const wallet = g('SELECT * FROM econ_wallets WHERE guild_id=? AND user_id=?', uid) || { coins: 0 };
  const kitchen = home.kitchen_built ? g('SELECT * FROM kitchen_levels WHERE guild_id=? AND level=?', home.kitchen_level) : null;

  // 升級進度：把材料需求跟背包數量對起來
  let needs = [];
  if (nextLv) {
    let mats = []; try { mats = JSON.parse(nextLv.materials || '[]'); } catch {}
    needs = mats.map(m => {
      const row = db.prepare(
        `SELECT v.count FROM gather_inventory v JOIN gather_items it ON it.id=v.item_id
          WHERE v.guild_id=? AND v.user_id=? AND it.name=?`).get(gid, uid, m.item);
      return { item: m.item, need: m.count, have: row ? row.count : 0 };
    });
  }

  const furniture = all(
    `SELECT f.name, f.emoji, f.category, f.buff_type, f.buff_pct, o.count, o.placed
       FROM home_furniture_owned o JOIN home_furniture f ON f.id=o.furniture_id
      WHERE o.guild_id=? AND o.user_id=? AND o.count>0 ORDER BY f.sort`, uid);
  const pets = all(
    `SELECT p.name, p.emoji, p.rarity, p.skill_name, p.buff_type, p.buff_pct, o.nickname, o.level, o.intimacy, o.personality
       FROM pet_owned o JOIN pet_defs p ON p.id=o.pet_id WHERE o.guild_id=? AND o.user_id=? ORDER BY o.id`, uid);
  const titles = all(
    `SELECT t.*, o.slot FROM title_owned o JOIN title_defs t ON t.id=o.title_id
      WHERE o.guild_id=? AND o.user_id=? AND t.enabled=1 ORDER BY o.slot DESC, t.sort`, uid);
  const affinity = all(
    `SELECT a.points, a.level, a.visits, r.name, r.image_url, r.intro
       FROM affinity a JOIN wheel_roles r ON r.id=a.role_id
      WHERE a.guild_id=? AND a.user_id=? AND a.points>0 ORDER BY a.points DESC LIMIT 6`, uid);
  const dishes = all(
    `SELECT c.quality, c.count, r.name, r.emoji FROM cook_inventory c JOIN cook_recipes r ON r.id=c.recipe_id
      WHERE c.guild_id=? AND c.user_id=? AND c.count>0 ORDER BY c.quality DESC, r.sort LIMIT 12`, uid);
  const levels = all('SELECT * FROM home_levels WHERE guild_id=? ORDER BY level');
  const affLevels = all('SELECT * FROM affinity_levels WHERE guild_id=? ORDER BY level');

  // 圖鑑完成度
  const DEX = [
    ['fish', '🐟 魚類', "SELECT COUNT(*) n FROM gather_items WHERE guild_id=? AND enabled=1 AND kind='fish'"],
    ['crop', '🌾 農作', null], ['greenhouse', '🌸 溫室', null],
    ['mine', '⛏️ 礦石', "SELECT COUNT(*) n FROM gather_items WHERE guild_id=? AND enabled=1 AND kind='mine'"],
    ['forage', '🍄 採集', "SELECT COUNT(*) n FROM gather_items WHERE guild_id=? AND enabled=1 AND kind='forage'"],
    ['hunt', '🏹 狩獵', "SELECT COUNT(*) n FROM gather_items WHERE guild_id=? AND enabled=1 AND kind='hunt'"],
    ['cook', '🍳 料理', 'SELECT COUNT(*) n FROM cook_recipes WHERE guild_id=? AND enabled=1'],
    ['pet', '🐾 寵物', 'SELECT COUNT(*) n FROM pet_defs WHERE guild_id=? AND enabled=1'],
    ['furniture', '🛋️ 家具', 'SELECT COUNT(*) n FROM home_furniture WHERE guild_id=? AND enabled=1'],
    ['role', '💝 角色', 'SELECT COUNT(*) n FROM wheel_roles WHERE guild_id=? AND enabled=1']
  ];
  const dex = DEX.map(([key, label, sql]) => {
    let total = 0;
    if (sql) total = (db.prepare(sql).get(gid) || {}).n || 0;
    else total = (db.prepare('SELECT COUNT(*) n FROM crop_seeds WHERE guild_id=? AND enabled=1 AND plot_type=?')
      .get(gid, key === 'crop' ? 'field' : 'greenhouse') || {}).n || 0;
    const have = db.prepare('SELECT COUNT(*) n FROM dex_seen WHERE guild_id=? AND user_id=? AND cat=?').get(gid, uid, key).n;
    return { key, label, have, total, pct: total ? Math.round(have / total * 100) : 0 };
  });

  return {
    gc, home, lv, nextLv, needs, wallet, kitchen, furniture, pets, titles, affinity, dishes, levels, affLevels, dex,
    buffs: userBuffs(gid, uid, true),
    titleSlots: guildConfig('home_config', gid).title_slots ?? 3
  };
}

const QUALITY = ['普通', '精良', '稀有', '史詩', '傳說'];
const QCOLOR = ['#9aa0a6', '#38a169', '#3182ce', '#805ad5', '#dd6b20'];
const RARITY = { N: '#9aa0a6', R: '#38a169', SR: '#3182ce', SSR: '#805ad5', UR: '#dd6b20' };

function render(d, name) {
  const bar = (pct, color = '#e879b9') =>
    `<div class="bar"><span style="width:${Math.min(100, pct)}%;background:${color}"></span></div>`;
  const canUpgrade = d.nextLv && d.needs.every(n => n.have >= n.need) && d.wallet.coins >= d.nextLv.coins;

  const buffList = Object.entries(d.buffs.buffs).filter(([, v]) => v > 0)
    .map(([t, v]) => `<span class="chip">${esc(BUFF_TYPES[t] || t)} <b>+${v}%</b></span>`).join('') || '<span class="muted">目前沒有任何加成</span>';

  return `<!doctype html><html lang="zh-Hant"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(name)} 的家</title>
<style>
:root{--pink:#e879b9;--pink-l:#fdf2f8;--line:#f0d9e8;--ink:#3b3340;--muted:#9b8fa3;--card:#fff}
*{box-sizing:border-box}
body{margin:0;font-family:"Noto Sans TC","PingFang TC","Microsoft JhengHei",system-ui,sans-serif;
  background:linear-gradient(160deg,#fff5fa,#f6f0ff);color:var(--ink);padding:16px}
.wrap{max-width:1080px;margin:0 auto;display:flex;flex-direction:column;gap:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:18px;
  box-shadow:0 4px 20px rgba(190,140,180,.08)}
h2{margin:0 0 14px;font-size:17px;display:flex;align-items:center;gap:8px}
h3{margin:0 0 10px;font-size:14px;color:var(--muted);font-weight:600}
.grid{display:grid;gap:16px}
.g3{grid-template-columns:repeat(auto-fit,minmax(280px,1fr))}
.g2{grid-template-columns:repeat(auto-fit,minmax(340px,1fr))}
.hero{display:flex;gap:20px;align-items:center;flex-wrap:wrap}
.lvbox{font-size:34px;font-weight:800;line-height:1.1}
.lvname{font-size:20px;color:var(--muted);font-weight:600}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-top:14px}
.stat{background:var(--pink-l);border-radius:12px;padding:10px 12px}
.stat b{display:block;font-size:18px;margin-top:2px}
.stat span{font-size:12px;color:var(--muted)}
.bar{height:9px;background:#f2e8f2;border-radius:99px;overflow:hidden;margin:6px 0}
.bar span{display:block;height:100%;border-radius:99px}
.row{display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px dashed var(--line);font-size:14px}
.row:last-child{border:0}
.ok{color:#38a169;font-weight:700}.no{color:#e53e3e;font-weight:700}
.chip{display:inline-block;background:var(--pink-l);border:1px solid var(--line);border-radius:99px;
  padding:4px 11px;font-size:12px;margin:0 6px 6px 0}
.tile{background:var(--pink-l);border-radius:12px;padding:10px;text-align:center;font-size:13px}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:9px}
.muted{color:var(--muted);font-size:13px}
table{width:100%;border-collapse:collapse;font-size:13px}
td,th{padding:6px 8px;text-align:left;border-bottom:1px solid var(--line)}
th{color:var(--muted);font-weight:600;font-size:12px}
tr.now{background:#fdf2f8;font-weight:700}
.pet{display:flex;gap:10px;align-items:center;background:var(--pink-l);border-radius:12px;padding:10px;margin-bottom:8px}
.pet .em{font-size:28px}
.rolecard{display:flex;gap:12px;align-items:center;margin-bottom:10px}
.rolecard img{width:56px;height:56px;border-radius:12px;object-fit:cover}
.rolecard .ph{width:56px;height:56px;border-radius:12px;background:var(--pink-l);display:grid;place-items:center;font-size:22px}
.foot{text-align:center;color:var(--muted);font-size:12px;padding:8px 0 20px}
.badge{border-radius:10px;padding:8px 10px;background:var(--pink-l);font-size:12px;margin-bottom:6px}
.badge b{display:block;font-size:13px}
</style></head><body><div class="wrap">

<div class="card">
  <div class="hero">
    <div>
      <div class="lvbox">${esc(d.lv.emoji || '🏠')} Lv.${d.home.level}</div>
      <div class="lvname">${esc(d.lv.name || '小屋')}</div>
      <div class="muted" style="margin-top:6px">${esc(name)} 的家</div>
    </div>
    <div style="flex:1;min-width:260px">
      <div class="stats">
        <div class="stat"><span>💰 ${esc(d.gc.currency_name || '星幣')}</span><b>${num(d.wallet.coins)}</b></div>
        <div class="stat"><span>🐾 寵物</span><b>${d.pets.length} / ${d.lv.pet_cap || 0}</b></div>
        <div class="stat"><span>🛋️ 家具</span><b>${d.furniture.reduce((a, f) => a + f.placed, 0)} / ${d.lv.furniture_cap || 0}</b></div>
        <div class="stat"><span>🍳 廚房</span><b>${d.kitchen ? 'Lv.' + d.home.kitchen_level : '未建造'}</b></div>
        <div class="stat"><span>🏅 成就</span><b>${d.titles.length} 個</b></div>
      </div>
    </div>
  </div>
  <h3 style="margin-top:16px">⭐ 目前加成（每種上限 ${d.buffs.cap}%）</h3>
  <div>${buffList}</div>
</div>

<div class="grid g2">
  <div class="card">
    <h2>🔨 升級進度</h2>
    ${d.nextLv ? `
      <div class="muted" style="margin-bottom:10px">Lv.${d.home.level} ${esc(d.lv.name)} → <b>Lv.${d.nextLv.level} ${esc(d.nextLv.name)}</b></div>
      <div class="row"><span>💰 ${esc(d.gc.currency_name || '星幣')}</span>
        <span class="${d.wallet.coins >= d.nextLv.coins ? 'ok' : 'no'}">${num(d.wallet.coins)} / ${num(d.nextLv.coins)}</span></div>
      ${d.needs.map(n => `<div class="row"><span>${esc(n.item)}</span>
        <span class="${n.have >= n.need ? 'ok' : 'no'}">${num(n.have)} / ${num(n.need)}</span></div>`).join('')}
      <div style="margin-top:12px;text-align:center;padding:10px;border-radius:10px;
        background:${canUpgrade ? '#e8f8ee' : '#faf0f0'};color:${canUpgrade ? '#2f855a' : '#c53030'};font-weight:700">
        ${canUpgrade ? '✅ 材料齊了！回 Discord 打 /升級家園' : '材料還不夠，去採集或挖礦補齊'}
      </div>
      <div class="muted" style="margin-top:8px">解鎖：${esc(d.nextLv.unlocks || '—')}</div>
    ` : '<div class="muted">🎉 你的家園已經蓋到最高階了。</div>'}
  </div>

  <div class="card">
    <h2>📖 圖鑑完成度</h2>
    ${d.dex.map(x => `<div style="margin-bottom:9px">
      <div class="row" style="border:0;padding:2px 0"><span>${esc(x.label)}</span>
        <span class="muted">${x.have} / ${x.total}${x.total && x.have >= x.total ? '　🏅' : ''}</span></div>
      ${bar(x.pct)}</div>`).join('')}
    <div class="muted" style="margin-top:6px">圖鑑只給能力不給物品：收集到門檻會解鎖成就</div>
  </div>
</div>

<div class="card">
  <h2>🏠 房屋 12 階</h2>
  <div style="overflow-x:auto"><table>
    <tr><th>等級</th><th>房屋名稱</th><th>解鎖內容</th><th>家具</th><th>寵物</th></tr>
    ${d.levels.map(l => `<tr class="${l.level === d.home.level ? 'now' : ''}">
      <td>Lv.${l.level}</td><td>${esc(l.emoji || '')} ${esc(l.name)}</td>
      <td class="muted">${esc(l.unlocks || '')}</td><td>${l.furniture_cap}</td><td>${l.pet_cap}</td></tr>`).join('')}
  </table></div>
</div>

<div class="grid g3">
  <div class="card">
    <h2>🍳 廚房</h2>
    ${d.kitchen ? `
      <div class="lvname">${esc(d.kitchen.emoji || '')} Lv.${d.home.kitchen_level} ${esc(d.kitchen.name)}</div>
      <div class="muted" style="margin:6px 0 12px">${esc(d.kitchen.description || '')}　完美料理 +${d.kitchen.perfect_pct}%</div>
      <h3>做好的料理</h3>
      ${d.dishes.length ? d.dishes.map(x => `<div class="row">
        <span>${esc(x.emoji || '')} ${esc(x.name)}</span>
        <span style="color:${QCOLOR[x.quality]};font-weight:700">${QUALITY[x.quality]} ×${x.count}</span></div>`).join('')
      : '<div class="muted">還沒有做好的料理</div>'}
    ` : '<div class="muted">還沒有廚房。需要家園 Lv.4 精緻平房才能取得建造資格，材料仍要自備。</div>'}
  </div>

  <div class="card">
    <h2>🐾 寵物 <span class="muted">${d.pets.length}/${d.lv.pet_cap || 0}</span></h2>
    ${d.pets.length ? d.pets.map(p => `<div class="pet">
      <div class="em">${esc(p.emoji || '🐾')}</div>
      <div style="flex:1">
        <b style="color:${RARITY[p.rarity] || '#666'}">${esc(p.nickname || p.name)}</b>
        <span class="muted"> Lv.${p.level}・${esc(p.personality || '')}</span>
        ${bar(p.intimacy, '#f56ba5')}
        <div class="muted">${esc(p.skill_name)}　${esc(BUFF_TYPES[p.buff_type] || '')} +${Math.floor(p.buff_pct * p.intimacy / 100)}%（親密 ${p.intimacy}/100）</div>
      </div></div>`).join('')
    : '<div class="muted">還沒有寵物。需要家園 Lv.3 鄉間住宅。</div>'}
  </div>

  <div class="card">
    <h2>🏅 成就 <span class="muted">裝備 ${d.titles.filter(t => t.slot >= 0).length}/${d.titleSlots}</span></h2>
    ${d.titles.length ? d.titles.map(t => `<div class="badge" style="${t.slot >= 0 ? 'border:1.5px solid var(--pink)' : 'opacity:.6'}">
      <b>${esc(t.emoji || '')} ${esc(t.name)} ${t.slot >= 0 ? '⭐' : ''}</b>
      <span class="muted">${[t.buff_type && `${BUFF_TYPES[t.buff_type]} +${t.buff_pct}%`, t.buff2_type && `${BUFF_TYPES[t.buff2_type]} +${t.buff2_pct}%`].filter(Boolean).join('、') || '無加成'}</span>
    </div>`).join('')
    : '<div class="muted">還沒有成就。收集圖鑑、蓋家園、每天簽到、做任務都會解鎖，最多同時裝備 3 個。</div>'}
  </div>
</div>

<div class="grid g2">
  <div class="card">
    <h2>💕 好感度</h2>
    ${d.affinity.length ? d.affinity.map(a => {
      const lvName = (d.affLevels.find(l => l.level === a.level) || {}).name || '陌生人';
      const next = d.affLevels.find(l => l.level === a.level + 1);
      return `<div class="rolecard">
        ${a.image_url ? `<img src="${esc(absUrl(a.image_url))}" alt="">` : '<div class="ph">💝</div>'}
        <div style="flex:1">
          <b>${esc(a.name)}</b> <span class="muted">${esc(lvName)}（Lv.${a.level}）</span>
          ${bar(next ? Math.round(a.points / next.need * 100) : 100, '#f06595')}
          <div class="muted">${num(a.points)} 點${next ? `　還差 ${num(next.need - a.points)} 升級` : '　已滿'}${a.visits ? `　來訪 ${a.visits} 次` : ''}</div>
        </div></div>`;
    }).join('') : '<div class="muted">還沒有跟任何角色互動。回 Discord 用 /送禮 開始。</div>'}
  </div>

  <div class="card">
    <h2>🛋️ 家具 <span class="muted">${d.furniture.length} 種</span></h2>
    ${d.furniture.length ? `<div class="tiles">${d.furniture.map(f => `<div class="tile" style="${f.placed ? '' : 'opacity:.45'}">
      <div style="font-size:24px">${esc(f.emoji || '🪑')}</div>
      <div>${esc(f.name)}</div>
      <div class="muted">${f.placed ? `已擺 ${f.placed}` : '收在倉庫'}</div>
    </div>`).join('')}</div>
    <div class="muted" style="margin-top:10px">淡色的是沒擺出來的 —— 收在倉庫沒有加成</div>` 
    : '<div class="muted">還沒有家具。</div>'}
  </div>
</div>

<div class="foot">這是唯讀頁面，所有操作請回 Discord ・ 資料即時同步</div>
</div></body></html>`;
}

router.get('/home/:token', (req, res) => {
  const t = parseToken(req.params.token);
  if (!t) return res.status(404).type('html').send('<h1>連結無效</h1><p>請回 Discord 重新取得你的家園連結。</p>');
  const d = collect(t.gid, t.uid);
  if (!d) return res.status(404).type('html').send('<h1>找不到這個家</h1><p>先在 Discord 打 <code>/我的家</code> 建立你的家園。</p>');
  res.type('html').send(render(d, d.home.username || '玩家'));
});

module.exports = router;
module.exports.homeToken = homeToken;
