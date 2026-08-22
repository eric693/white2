// 家園系統的加成統一結算器。
//
// 為什麼要有這一支：家園、家具、寵物、稱號、料理都會給加成，如果各系統各加各的，
// 玩家玩半年後會變成「種一顆番茄 → 世界首富」。所以規則是：
//   任何加成都不准自己算，一律問這裡；這裡負責加總並套上 buff_cap_pct 上限。
const { db, guildConfig } = require('../db');

// 全系統認得的加成種類。新增種類時只改這裡，家具/稱號/寵物的 buff_type 都吃這份清單。
const BUFF_TYPES = {
  sell_pct:        '商品出售價',
  fish_rare_pct:   '稀有魚機率',
  fish_price_pct:  '魚類售價',
  mine_rare_pct:   '稀有礦物機率',
  mine_common_pct: '基礎礦物機率',    // 碎石／黏土／煤炭這類做為材料的低階礦
  forage_rare_pct: '稀有採集物機率',
  hunt_rare_pct:   '稀有獵物機率',
  mat_pct:         '素材掉落機率',    // 全種類的 N／R 素材（打材料用）
  cook_perfect_pct:'完美料理機率',
  cook_price_pct:  '料理售價',
  gift_pct:        '送禮好感',
  // visit_pct（角色來訪機率）已移除：角色只會在「逛街」隨機遇到，沒有來訪機率這回事。
  // 既有資料一律換成 affinity_pct。
  stock_pct:       '股市收益',
  speed_pct:       '生產速度',
  steal_resist_pct:'全域防竊',      // 牧場＋魚缸都吃
  ranch_resist_pct:'牧場防護',      // 只擋 /偷（取代看門動物佔格子）
  aqua_resist_pct: '魚缸防護',      // 只擋 /偷魚
  guard_bite_pct:  '反擊機率',      // 被偷時反咬小偷，讓他掉星幣
  affinity_pct:    '角色好感度',    // 送禮／逛街／來訪拿到的好感點數加成（原本的「體力恢復」拿掉了：
                                    // 體力是每天固定的行動額度，能被加成就失去意義）
  luck_pct:        '幸運',          // 抽籤／轉蛋／稀有掉落的通用運氣
  quest_pct:       '任務獎勵',
  steal_pct:       '偷竊成功率',
  rest_pct:        '休息效率'       // 保留給之後的體力以外用途；目前不建議使用
};

const hcfg = (gid) => guildConfig('home_config', gid);

/**
 * 算出某位玩家目前所有加成的總和。
 * 回傳 { sell_pct: 5, gift_pct: 3, ... }，沒有的種類就不會出現在物件裡。
 * detail=true 時另外回傳每一筆的來源，給 /家園狀態 顯示用。
 */
function userBuffs(gid, uid, detail = false) {
  const total = {};
  const parts = [];
  const add = (type, pct, source) => {
    if (!type || !pct || !BUFF_TYPES[type]) return;
    total[type] = (total[type] || 0) + pct;
    if (detail) parts.push({ type, pct, source });
  };

  // ① 房屋階級本身的整體加成
  const home = db.prepare('SELECT level FROM home_users WHERE guild_id=? AND user_id=?').get(gid, uid);
  if (home) {
    const lv = db.prepare('SELECT name, home_buff_pct FROM home_levels WHERE guild_id=? AND level=?').get(gid, home.level);
    if (lv && lv.home_buff_pct) add('sell_pct', lv.home_buff_pct, `家園：${lv.name}`);
  }

  // ② 家具：只有「擺出來的」才算，收在倉庫裡沒有效果
  const furn = db.prepare(
    `SELECT f.name, f.emoji, f.buff_type, f.buff_pct, o.placed
       FROM home_furniture_owned o JOIN home_furniture f ON f.id = o.furniture_id
      WHERE o.guild_id=? AND o.user_id=? AND o.placed > 0 AND f.buff_pct > 0 AND f.enabled=1`).all(gid, uid);
  for (const f of furn) add(f.buff_type, f.buff_pct * f.placed, `家具：${f.emoji || ''}${f.name}${f.placed > 1 ? ` ×${f.placed}` : ''}`);

  // ③ 寵物技能：按親密度給，親密度 0 就完全沒效果（要養才有用）
  const pets = db.prepare(
    `SELECT p.name, p.emoji, p.skill_name, p.buff_type, p.buff_pct, o.nickname, o.intimacy
       FROM pet_owned o JOIN pet_defs p ON p.id = o.pet_id
      WHERE o.guild_id=? AND o.user_id=? AND p.buff_pct > 0 AND p.enabled=1`).all(gid, uid);
  for (const p of pets) {
    const pct = Math.floor(p.buff_pct * Math.min(100, Math.max(0, p.intimacy)) / 100);
    add(p.buff_type, pct, `寵物：${p.emoji || ''}${p.nickname || p.name}「${p.skill_name}」`);
  }

  // ④ 成就（原稱號）：只算「已裝備」的（slot >= 0）。解鎖再多，同時只有 title_slots 個生效。
  // 這裡再 LIMIT 一次裝備上限，不是多餘的：裝備上限本來只在 equipTitle() 擋，
  // 萬一資料被後台或手動改壞（slot 多於上限），加成就會從這裡漏出去。
  const slots = Math.max(1, hcfg(gid).title_slots ?? 3);
  const titles = db.prepare(
    `SELECT t.name, t.emoji, t.buff_type, t.buff_pct, t.buff2_type, t.buff2_pct
       FROM title_owned o JOIN title_defs t ON t.id = o.title_id
      WHERE o.guild_id=? AND o.user_id=? AND o.slot >= 0 AND t.enabled=1
      ORDER BY o.slot LIMIT ?`).all(gid, uid, slots);
  for (const t of titles) {
    add(t.buff_type, t.buff_pct, `成就：${t.emoji || ''}${t.name}`);
    add(t.buff2_type, t.buff2_pct, `成就：${t.emoji || ''}${t.name}`);
  }

  // ⑤ 同居角色的能力：搬進來時隨機決定的加成（要繳伴侶稅，所以這是付費換來的）
  const partners = db.prepare(
    `SELECT p.buff_type, p.buff_pct, r.name FROM home_partners p JOIN wheel_roles r ON r.id = p.role_id
      WHERE p.guild_id=? AND p.user_id=? AND p.buff_pct > 0`).all(gid, uid);
  for (const p of partners) add(p.buff_type, p.buff_pct, `同居：💞${p.name}`);

  // ⑥ 料理等暫時性加成（過期的順手清掉，不必另外排程）
  const now = Date.now();
  db.prepare('DELETE FROM home_buffs WHERE guild_id=? AND user_id=? AND expire_ms <= ?').run(gid, uid, now);
  const temps = db.prepare('SELECT buff_type, buff_pct, source FROM home_buffs WHERE guild_id=? AND user_id=? AND expire_ms > ?').all(gid, uid, now);
  for (const t of temps) add(t.buff_type, t.buff_pct, `料理：${t.source}`);

  // ⑦ 封頂：每一種加成各自壓在 buff_cap_pct 以內
  const cap = Math.max(0, hcfg(gid).buff_cap_pct ?? 30);
  const capped = {};
  for (const [type, pct] of Object.entries(total)) capped[type] = Math.min(cap, pct);

  return detail ? { buffs: capped, raw: total, parts, cap } : capped;
}

/**
 * 指定素材的掉落加成％（寵物專用）。
 * 「碎石 +10%」指的是**權重**提高一成，不是保證多挖到一成 —— 一律按親密度比例給，
 * 親密度 50 就只有一半效果。
 */
function itemBoost(gid, uid, itemName) {
  if (!itemName) return 0;
  const rows = db.prepare(
    `SELECT p.buff_pct, o.intimacy FROM pet_owned o JOIN pet_defs p ON p.id = o.pet_id
      WHERE o.guild_id=? AND o.user_id=? AND p.enabled=1 AND p.target_item = ? AND p.buff_pct > 0`)
    .all(gid, uid, itemName);
  let pct = 0;
  for (const r of rows) pct += Math.floor(r.buff_pct * Math.min(100, Math.max(0, r.intimacy)) / 100);
  const cap = Math.max(0, hcfg(gid).buff_cap_pct ?? 30);
  return Math.min(cap, pct);
}

/** 單一種類的加成％，各系統呼叫這支就好 */
const buffPct = (gid, uid, type) => userBuffs(gid, uid)[type] || 0;

/** 把金額套上加成（例如售價 +5%） */
const applyBuff = (amount, pct) => Math.round(amount * (1 + (pct || 0) / 100));

/** 給予暫時性加成（吃料理時呼叫）。同來源同種類會續期而不是疊加。 */
function grantBuff(gid, uid, type, pct, source, minutes) {
  if (!type || !BUFF_TYPES[type] || !pct || !minutes) return;
  const expire = Date.now() + minutes * 60000;
  const has = db.prepare('SELECT id, expire_ms FROM home_buffs WHERE guild_id=? AND user_id=? AND buff_type=? AND source=?').get(gid, uid, type, source);
  if (has) db.prepare('UPDATE home_buffs SET buff_pct=?, expire_ms=? WHERE id=?').run(pct, Math.max(has.expire_ms, expire), has.id);
  else db.prepare('INSERT INTO home_buffs (guild_id,user_id,buff_type,buff_pct,source,expire_ms) VALUES (?,?,?,?,?,?)')
    .run(gid, uid, type, pct, source, expire);
}

module.exports = { BUFF_TYPES, userBuffs, buffPct, itemBoost, applyBuff, grantBuff };
