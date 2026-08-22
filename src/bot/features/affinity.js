// 角色好感度／約會。
//
// 角色不另外建檔 —— 直接沿用轉盤的 wheel_roles（你們已經有數百位角色，含頭像、台詞、作者）。
// 玩家用名字搜尋邀請（自動完成），送禮消耗農產／魚／料理／寶石，好感度升級解鎖稱號。
//
// 這是整條經濟鏈的終點：以前農產品唯一的用途是「賣掉換錢」，現在有了送禮才真的有意義。
const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { db, guildConfig, logError } = require('../../db');
const { bump: bumpAch } = require('../../util/achievements');
const { brandColor } = require('../../util/brand');
const { absUrl } = require('../../util/url');
const { localToday } = require('../../util/time');
const { buffPct } = require('../../util/buffs');
const { seedHome, homeOf, levelDef, NAV } = require('./home');
const { markSeen } = require('./dex');
const { QUALITY } = require('./kitchen');

const hcfg = (gid) => guildConfig('home_config', gid);
const gcfg = (gid) => guildConfig('gather_config', gid);

// 好感度階級（管理員可在後台改名稱與門檻）
const SEED_LEVELS = [
  [1, '點頭之交', 100, ''],
  [2, '有點熟', 300, ''],
  [3, '朋友', 700, ''],
  [4, '好朋友', 1400, ''],
  [5, '知己', 2500, ''],
  [6, '曖昧', 4200, ''],
  [7, '心動', 6500, ''],
  [8, '戀人', 10000, ''],
  [9, '深愛', 15000, ''],
  [10, '此生唯一', 25000, '']
];

function seedAffinity(gid) {
  try {
    if (db.prepare('SELECT 1 FROM affinity_levels WHERE guild_id=? LIMIT 1').get(gid)) return;
    const ins = db.prepare('INSERT INTO affinity_levels (guild_id,level,name,need,reward) VALUES (?,?,?,?,?)');
    db.transaction(() => { for (const [lv, name, need, reward] of SEED_LEVELS) ins.run(gid, lv, name, need, reward); })();
  } catch (e) { logError(gid, '好感度階級建立失敗：', e.message); }
}


// 工藝禮物的預設喜好：木雕與花束是「專門做來送人的東西」，所以每位角色都特別喜歡。
// 走逐筆補齊（新角色加進轉盤後也會自動有），管理員之後想單獨調某個角色照樣蓋得過去。
const CRAFT_GIFTS = [
  ['木雕小鹿', 200], ['櫻花木梳', 220], ['檜木香盒', 240],
  ['四季花束', 260], ['星光花冠', 300], ['神木護符', 300]
];
function seedGiftPrefs(gid) {
  try {
    const roles = db.prepare('SELECT id FROM wheel_roles WHERE guild_id=? AND enabled=1').all(gid);
    if (!roles.length) return;
    const has = db.prepare('SELECT 1 FROM affinity_prefs WHERE guild_id=? AND role_id=? AND item=?');
    const ins = db.prepare('INSERT INTO affinity_prefs (guild_id,role_id,item,weight) VALUES (?,?,?,?)');
    db.transaction(() => {
      for (const r of roles) {
        for (const [item, weight] of CRAFT_GIFTS) {
          if (has.get(gid, r.id, item)) continue;
          ins.run(gid, r.id, item, weight);
        }
      }
    })();
  } catch (e) { logError(gid, '禮物喜好建立失敗：', e.message); }
}

const levelsOf = (gid) => db.prepare('SELECT * FROM affinity_levels WHERE guild_id=? ORDER BY level').all(gid);
const levelName = (gid, lv) => (db.prepare('SELECT name FROM affinity_levels WHERE guild_id=? AND level=?').get(gid, lv) || {}).name || '陌生人';
const roleOf = (gid, rid) => db.prepare('SELECT * FROM wheel_roles WHERE guild_id=? AND id=? AND enabled=1').get(gid, rid);
const affOf = (gid, uid, rid) => db.prepare('SELECT * FROM affinity WHERE guild_id=? AND user_id=? AND role_id=?').get(gid, uid, rid)
  || { points: 0, level: 0, visits: 0, gift_day: '', gift_count: 0 };

/** 依點數重算階級，回傳有沒有升級 */
function recalcLevel(gid, uid, rid) {
  const a = affOf(gid, uid, rid);
  const lvs = levelsOf(gid);
  let lv = 0;
  for (const l of lvs) if (a.points >= l.need) lv = l.level;
  if (lv !== a.level) {
    db.prepare('UPDATE affinity SET level=? WHERE guild_id=? AND user_id=? AND role_id=?').run(lv, gid, uid, rid);
    return { up: lv > a.level, level: lv };
  }
  return { up: false, level: lv };
}

/**
 * 送禮加多少好感。
 * 有設喜好就吃 affinity_prefs 的權重（300＝最愛、100＝普通、-100＝討厭），
 * 沒設的角色一律用普通權重 —— 這樣管理員可以只幫重點角色設喜好，其他角色照樣能玩。
 */
function giftWeight(gid, rid, itemName) {
  const p = db.prepare('SELECT weight FROM affinity_prefs WHERE guild_id=? AND role_id=? AND item=?').get(gid, rid, itemName);
  return p ? p.weight : 100;
}
// 喜好倍率：200＝最喜歡 ×2、150＝喜歡 ×1.5、100＝普通、50＝討厭 ×0.5
const LIKE_LABEL = (w) => w >= 200 ? '💖 最喜歡' : w >= 150 ? '💕 喜歡' : w <= 50 ? '💔 討厭' : '🤍 普通';
/** 記進送禮圖鑑：送過才知道角色喜不喜歡（第一次送之前不顯示） */
function markGiftDex(gid, uid, rid, item, weight) {
  try {
    db.prepare('INSERT OR REPLACE INTO gift_dex (guild_id,user_id,role_id,item,weight) VALUES (?,?,?,?,?)')
      .run(gid, uid, rid, item, weight);
  } catch {}
}
const knownWeight = (gid, uid, rid, item) =>
  (db.prepare('SELECT weight FROM gift_dex WHERE guild_id=? AND user_id=? AND role_id=? AND item=?').get(gid, uid, rid, item) || {}).weight;

/** 送一份背包物品 */
function giftItem(gid, uid, uname, rid, itemId) {
  const role = roleOf(gid, rid);
  if (!role) return { error: '找不到這位角色。' };
  const c = hcfg(gid);
  const today = localToday();
  const a = affOf(gid, uid, rid);
  const used = a.gift_day === today ? a.gift_count : 0;
  if (used >= c.gift_daily_limit) return { error: `你今天送給 **${role.name}** 的禮物已經夠多了（每日 ${c.gift_daily_limit} 次）。明天再來。` };

  const inv = db.prepare(
    `SELECT v.count, it.name, it.emoji, it.price, it.gift_aff FROM gather_inventory v JOIN gather_items it ON it.id=v.item_id
      WHERE v.guild_id=? AND v.user_id=? AND v.item_id=? AND v.count>0`).get(gid, uid, itemId);
  if (!inv) return { error: '你沒有這個物品。' };

  const weight = giftWeight(gid, rid, inv.name);
  // 禮物有「基礎好感」就照規格算：基礎值 × 喜好倍率（💖×2／💕×1.5／🤍×1／💔×0.5）。
  // 沒設基礎好感的舊物品才退回「售價開根號」那套。
  const base = inv.gift_aff > 0 ? inv.gift_aff : Math.max(1, Math.round(Math.sqrt(inv.price) * 3));
  // gift_pct＝送禮專屬加成；affinity_pct＝所有好感來源的通用加成（寵物／家具／成就都可能給）
  const affBonus = buffPct(gid, uid, 'gift_pct') + buffPct(gid, uid, 'affinity_pct');
  const gain = Math.round(base * weight / 100 * (1 + affBonus / 100));

  db.transaction(() => {
    db.prepare('UPDATE gather_inventory SET count = count - 1 WHERE guild_id=? AND user_id=? AND item_id=?').run(gid, uid, itemId);
    db.prepare(`INSERT INTO affinity (guild_id,user_id,role_id,points,level,gift_day,gift_count) VALUES (?,?,?,?,0,?,1)
      ON CONFLICT(guild_id,user_id,role_id) DO UPDATE SET
        points = MAX(0, points + ?), gift_day = ?, gift_count = CASE WHEN gift_day = ? THEN gift_count + 1 ELSE 1 END`)
      .run(gid, uid, rid, Math.max(0, gain), today, gain, today, today);
  })();
  bumpAch(gid, uid, 'gift_count', 1);
  markGiftDex(gid, uid, rid, inv.name, weight);   // 送過才會記進送禮圖鑑
  const lv = recalcLevel(gid, uid, rid);
  markSeen(gid, uid, 'role', role.name);
  return { role, item: inv, gain, weight, ...lv };
}

/** 送一份料理（料理的好感吃品質倍率，這是烹飪最主要的價值） */
function giftDish(gid, uid, uname, rid, recipeId, quality) {
  const role = roleOf(gid, rid);
  if (!role) return { error: '找不到這位角色。' };
  const c = hcfg(gid);
  const today = localToday();
  const a = affOf(gid, uid, rid);
  const used = a.gift_day === today ? a.gift_count : 0;
  if (used >= c.gift_daily_limit) return { error: `你今天送給 **${role.name}** 的禮物已經夠多了（每日 ${c.gift_daily_limit} 次）。` };

  const row = db.prepare('SELECT count FROM cook_inventory WHERE guild_id=? AND user_id=? AND recipe_id=? AND quality=?').get(gid, uid, recipeId, quality);
  if (!row || row.count <= 0) return { error: '你沒有這份料理。' };
  const r = db.prepare('SELECT * FROM cook_recipes WHERE guild_id=? AND id=?').get(gid, recipeId);
  const weight = giftWeight(gid, rid, r.name);
  const gain = Math.round(r.affinity_base * QUALITY[quality].aff * weight / 100
    * (1 + (buffPct(gid, uid, 'gift_pct') + buffPct(gid, uid, 'affinity_pct')) / 100));

  db.transaction(() => {
    db.prepare('UPDATE cook_inventory SET count = count - 1 WHERE guild_id=? AND user_id=? AND recipe_id=? AND quality=?').run(gid, uid, recipeId, quality);
    db.prepare(`INSERT INTO affinity (guild_id,user_id,role_id,points,level,gift_day,gift_count) VALUES (?,?,?,?,0,?,1)
      ON CONFLICT(guild_id,user_id,role_id) DO UPDATE SET
        points = MAX(0, points + ?), gift_day = ?, gift_count = CASE WHEN gift_day = ? THEN gift_count + 1 ELSE 1 END`)
      .run(gid, uid, rid, Math.max(0, gain), today, gain, today, today);
  })();
  const lv = recalcLevel(gid, uid, rid);
  markSeen(gid, uid, 'role', role.name);
  return { role, dish: r, quality, gain, weight, ...lv };
}

/** 邀請角色來家裡（需要房屋 Lv.6，成功率受家園加成影響） */
function inviteRole(gid, uid, uname, rid) {
  const role = roleOf(gid, rid);
  if (!role) return { error: '找不到這位角色。' };
  const c = hcfg(gid);
  if (!c.visit_enabled) return { error: '目前沒有開放邀請角色來訪。' };
  const home = homeOf(gid, uid, uname);
  const def = levelDef(gid, home.level);
  if (!def || !def.visit_ok) return { error: `你的家還太簡陋，角色不好意思來。需要家園 **Lv.6 花園別墅**（你現在 Lv.${home.level}）。` };
  const a = affOf(gid, uid, rid);
  const today = localToday();
  if (a.last_visit === today) return { error: `**${role.name}** 今天已經來過你家了。` };

  // 成功率：好感度階級越高越願意來，再加上家園的 visit_pct 加成
  const chance = Math.min(95, 25 + a.level * 7 + buffPct(gid, uid, 'affinity_pct'));
  const ok = Math.random() * 100 < chance;
  db.prepare(`INSERT INTO affinity (guild_id,user_id,role_id,points,level,visits,last_visit) VALUES (?,?,?,0,0,?,?)
    ON CONFLICT(guild_id,user_id,role_id) DO UPDATE SET visits = visits + ?, last_visit = ?`)
    .run(gid, uid, rid, ok ? 1 : 0, today, ok ? 1 : 0, today);
  if (!ok) return { role, refused: true, chance };

  // 來訪本身也給好感（比送禮少，但穩定）
  const gain = Math.round((20 + a.level * 5) * (1 + buffPct(gid, uid, 'affinity_pct') / 100));
  db.prepare('UPDATE affinity SET points = points + ? WHERE guild_id=? AND user_id=? AND role_id=?').run(gain, gid, uid, rid);
  const lv = recalcLevel(gid, uid, rid);
  markSeen(gid, uid, 'role', role.name);
  return { role, gain, chance, ...lv };
}


// ================== 同居 ==================
//
// 「邀請來家裡」＝同居：角色搬進玩家家裡，每期要繳伴侶稅（在稅金那邊結算）。
// 對象**隨機**：玩家不能挑要跟誰住，只能決定要不要請現在這位搬走、再抽一次 ——
// 可以挑的話所有人都會選同一個最紅的角色，兩百多位角色等於白做。
const partnersOf = (gid, uid) => db.prepare(
  `SELECT p.*, r.name, r.image_url, r.ad_line, r.ad_line2, r.ad_line3,
          (SELECT level FROM affinity a WHERE a.guild_id=p.guild_id AND a.user_id=p.user_id AND a.role_id=p.role_id) AS level
     FROM home_partners p JOIN wheel_roles r ON r.id=p.role_id
    WHERE p.guild_id=? AND p.user_id=? ORDER BY p.since`).all(gid, uid);

/**
 * 同居名額：跟著房屋階級長，最多 3 位。
 * Lv.6 起 1 位、Lv.10 起 2 位、Lv.13 起 3 位（門檻可在後台改 partner_lv2 / partner_lv3）。
 */
function partnerSlots(gid, uid, uname) {
  const c = hcfg(gid);
  const cap = Math.max(1, Math.min(3, c.partner_slots ?? 3));
  if (!uid) return cap;
  const lv = homeOf(gid, uid, uname).level;
  // 房屋規格：Lv.6 起 1 位、Lv.8 起 2 位、Lv.12 起 3 位（門檻在後台可調）
  let n = lv >= (c.partner_level ?? 6) ? 1 : 0;
  if (lv >= (c.partner_lv2 ?? 8)) n = 2;
  if (lv >= (c.partner_lv3 ?? 12)) n = 3;
  return Math.min(cap, n);
}

/** 可以邀請同居的候選名單（好感度達標、還沒住進來的） */
function partnerCandidates(gid, uid) {
  const need = Math.max(0, hcfg(gid).partner_level ?? 6);
  return db.prepare(
    `SELECT a.role_id, a.level, a.points, r.name FROM affinity a JOIN wheel_roles r ON r.id=a.role_id
      WHERE a.guild_id=? AND a.user_id=? AND a.level >= ? AND r.enabled=1 AND r.stroll_ok=1
        AND a.role_id NOT IN (SELECT role_id FROM home_partners WHERE guild_id=? AND user_id=?)
      ORDER BY a.points DESC LIMIT 25`).all(gid, uid, need, gid, uid);
}

/** 隨機挑一位「願意跟你同居」的角色：好感度要達標，已經同居的不再抽 */
function pickPartner(gid, uid) {
  const need = Math.max(0, hcfg(gid).partner_level ?? 6);
  const rows = db.prepare(
    `SELECT a.role_id, a.level, r.name FROM affinity a JOIN wheel_roles r ON r.id=a.role_id
      WHERE a.guild_id=? AND a.user_id=? AND a.level >= ? AND r.enabled=1 AND r.stroll_ok=1
        AND a.role_id NOT IN (SELECT role_id FROM home_partners WHERE guild_id=? AND user_id=?)`)
    .all(gid, uid, need, gid, uid);
  if (!rows.length) return null;
  // 好感度越高越容易被抽到，但不是保證 —— 保留一點「他自己也有想法」的隨機性
  const weighted = rows.map(r => ({ r, w: Math.max(1, r.level - need + 1) }));
  const total = weighted.reduce((a, x) => a + x.w, 0);
  let n = Math.random() * total;
  for (const x of weighted) { n -= x.w; if (n <= 0) return x.r; }
  return weighted[weighted.length - 1].r;
}

// 同居能力池。預設這一份是「開箱即有」，管理員可以在後台勾選要開哪些、調整 % 與權重
// （partner_skills 有資料時就完全以後台為準）。
const DEFAULT_PARTNER_SKILLS = [
  { skill: 'harvest', name: '🧺 幫忙收成', desc: '每天自動幫你把牧場產物收進背包', base: 0, weight: 8 },
  { buff_type: 'cook_perfect_pct', name: '👨‍🍳 廚藝指導', base: 4, weight: 10 },
  { buff_type: 'cook_price_pct', name: '🍱 擺盤講究', base: 5, weight: 10 },
  { buff_type: 'mine_rare_pct', name: '⛏️ 礦脈直覺', base: 4, weight: 10 },
  { buff_type: 'mine_common_pct', name: '🪨 撿石頭高手', base: 8, weight: 10 },
  { buff_type: 'fish_rare_pct', name: '🎣 看得懂潮汐', base: 4, weight: 10 },
  { buff_type: 'mat_pct', name: '📦 收集癖', base: 6, weight: 10 },
  { buff_type: 'sell_pct', name: '💰 會殺價', base: 4, weight: 10 },
  { buff_type: 'speed_pct', name: '⏱️ 手腳很快', base: 5, weight: 10 },
  { buff_type: 'luck_pct', name: '🍀 帶來好運', base: 4, weight: 10 },
  { buff_type: 'steal_resist_pct', name: '🛡️ 睡得很淺', base: 8, weight: 10 },
  { buff_type: 'affinity_pct', name: '☕ 會泡咖啡', base: 5, weight: 10 }
];

/** 目前啟用的能力池：後台有設就以後台為準，沒設就用預設 */
function partnerSkillPool(gid) {
  const rows = db.prepare('SELECT * FROM partner_skills WHERE guild_id=? AND enabled=1 ORDER BY sort, id').all(gid);
  if (rows.length) {
    return rows.map(r => ({ skill: r.skill || '', buff_type: r.buff_type || '', name: r.name, base: r.base_pct, weight: Math.max(1, r.weight) }));
  }
  return DEFAULT_PARTNER_SKILLS.map(x => ({ ...x, weight: x.weight || 10 }));
}

/** 隨機決定同居角色的能力：好感度階級越高，加成越強（每階 +10%）。pick 有指定就用指定的。 */
function rollPartnerSkill(level, gid, forceId = 0) {
  const pool = partnerSkillPool(gid);
  let pick;
  if (forceId) {
    const row = db.prepare('SELECT * FROM partner_skills WHERE id=? AND guild_id=?').get(forceId, gid);
    if (row) pick = { skill: row.skill || '', buff_type: row.buff_type || '', name: row.name, base: row.base_pct };
  }
  if (!pick) {
    const total = pool.reduce((a, x) => a + x.weight, 0);
    let n = Math.random() * total;
    for (const x of pool) { n -= x.weight; if (n <= 0) { pick = x; break; } }
    pick = pick || pool[pool.length - 1];
  }
  if (pick.skill) return { skill: pick.skill, buff_type: '', buff_pct: 0, name: pick.name, desc: pick.desc };
  const pct = Math.max(1, Math.round(pick.base * (1 + Math.max(0, level) * 0.1)));
  return { skill: '', buff_type: pick.buff_type, buff_pct: pct, name: pick.name };
}
const partnerSkillText = (p) => {
  if (p.skill === 'harvest') return '🧺 幫忙收成（每天自動收牧場產物）';
  if (p.buff_type && p.buff_pct) {
    const { BUFF_TYPES } = require('../../util/buffs');
    return `${BUFF_TYPES[p.buff_type] || p.buff_type} ＋${p.buff_pct}%`;
  }
  return '—';
};

/** 請一位角色搬進來。roleId 有給就是玩家自己挑的；沒給就隨機抽一位。 */
function moveIn(gid, uid, uname, roleId = 0) {
  const c = hcfg(gid);
  if (!c.partner_enabled) return { error: '目前沒有開放同居。' };
  const home = homeOf(gid, uid, uname);
  const def = levelDef(gid, home.level);
  if (!def || !def.visit_ok) return { error: `你的家還太簡陋，沒有人願意搬進來。需要家園 **Lv.6 花園別墅**（你現在 Lv.${home.level}）。` };

  const cur = partnersOf(gid, uid);
  const slots = partnerSlots(gid, uid, uname);
  if (cur.length >= slots) {
    return { error: `你家已經住滿了（${cur.length}/${slots} 位）。名額跟著房屋階級長 —— 把家蓋更大就能多住一位，或先請現在的搬走。` };
  }
  const need = Math.max(0, c.partner_level ?? 6);
  // 指定對象：要確認好感度真的達標，不能靠改 customId 硬塞
  let pick = null;
  if (roleId) {
    pick = partnerCandidates(gid, uid).find(x => x.role_id === roleId) || null;
    if (!pick) return { error: `這位角色還不願意跟你同居（需要好感度 **${levelName(gid, need)}（Lv.${need}）** 以上，而且不能是已經住進來的）。` };
  } else {
    pick = pickPartner(gid, uid);
  }
  if (!pick) {
    return { error: `目前沒有角色願意搬進來。\n同居需要好感度 **${levelName(gid, need)}（Lv.${need}）**以上 —— 先去 \`/送禮\`、🛍️ 逛街把關係養起來。` };
  }
  // 搬進來的角色會帶一個「隨機能力」：好感度越高給得越強。
  // 有些會幫忙收成（harvest），有些是廚藝／礦石之類的加成 —— 這樣同居才有功能性，不只是繳稅。
  const skillRoll = rollPartnerSkill(pick.level, gid);
  db.prepare('INSERT OR IGNORE INTO home_partners (guild_id,user_id,role_id,buff_type,buff_pct,skill) VALUES (?,?,?,?,?,?)')
    .run(gid, uid, pick.role_id, skillRoll.buff_type, skillRoll.buff_pct, skillRoll.skill);
  const role = roleOf(gid, pick.role_id);
  return { moved: true, role, level: pick.level, slots, used: cur.length + 1, skill: skillRoll };
}

/** 請同居對象搬走（好感度不會歸零，但要等冷卻才能再抽） */
function moveOut(gid, uid, roleId) {
  const p = db.prepare('SELECT * FROM home_partners WHERE guild_id=? AND user_id=? AND role_id=?').get(gid, uid, roleId);
  if (!p) return { error: '這位角色沒有住在你家。' };
  const role = roleOf(gid, roleId);
  db.prepare('DELETE FROM home_partners WHERE guild_id=? AND user_id=? AND role_id=?').run(gid, uid, roleId);
  return { role, paid: p.paid_total };
}

function partnerPanel(gid, uid, uname) {
  const c = hcfg(gid);
  const list = partnersOf(gid, uid);
  const slots = partnerSlots(gid, uid, uname);
  const tc = guildConfig('tax_config', gid);
  const need = Math.max(0, c.partner_level ?? 6);
  const home = homeOf(gid, uid, uname);
  const def = levelDef(gid, home.level);
  const taxOf = (lv) => (tc.partner_base || 0) + (tc.partner_per_lv || 0) * Math.max(0, lv || 0);

  const e = new EmbedBuilder().setColor(0xeb459e).setTitle('💞 同居')
    .setDescription(
      `請角色搬進你家一起住（目前 ${list.length}/${slots} 位）。\n`
      + `條件：家園 **Lv.6** 以上 ＋ 該角色好感度 **${levelName(gid, need)}（Lv.${need}）** 以上。\n`
      + `名額跟著房屋階級長：Lv.${c.partner_level ?? 6} 起 1 位、Lv.${c.partner_lv2 ?? 8} 起 2 位、Lv.${c.partner_lv3 ?? 12} 起 3 位。\n`
      + `搬進來的角色會**隨機帶一個能力**（廚藝、礦脈直覺、幫忙收成…），好感度越高越強。\n`
      + `⚠️ 同居要繳**伴侶稅**：每位每期 ${(tc.partner_base || 0).toLocaleString('en-US')} ＋ 好感度每階 ${(tc.partner_per_lv || 0).toLocaleString('en-US')}。`)
    .addFields({ name: '目前同居', value: list.length
      ? list.map(p => `💕 **${p.name}**　${levelName(gid, p.level)}（Lv.${p.level}）\n`
        + `　能力：${partnerSkillText(p)}\n`
        + `　每期伴侶稅 ${taxOf(p.level).toLocaleString('en-US')}`
        + (p.paid_total ? `　已繳 ${p.paid_total.toLocaleString('en-US')}` : '')).join('\n')
      : `還沒有人住進來（0/${slots}）` });

  const rows = [NAV('love')];
  const cands = partnerCandidates(gid, uid);
  const full = list.length >= slots;
  if (!full && cands.length && def && def.visit_ok) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('partnerpick').setPlaceholder('選一位請他搬進來')
        .addOptions(cands.slice(0, 25).map(x => ({
          label: x.name.slice(0, 100),
          description: `${levelName(gid, x.level)}（Lv.${x.level}）　好感 ${x.points.toLocaleString('en-US')}`.slice(0, 100),
          value: String(x.role_id)
        })))));
  }
  if (list.length) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('partnermoveout').setPlaceholder('請誰搬走？')
        .addOptions(list.slice(0, 25).map(p => ({
          label: p.name.slice(0, 100),
          description: partnerSkillText(p).slice(0, 100),
          value: String(p.role_id)
        })))));
  }
  return { embeds: [e], components: rows.slice(0, 5) };
}

// ---- 面板 ----
function lovePanel(gid, uid, uname) {
  const home = homeOf(gid, uid, uname);
  const def = levelDef(gid, home.level);
  const list = db.prepare(
    `SELECT a.*, r.name, r.author FROM affinity a JOIN wheel_roles r ON r.id=a.role_id
      WHERE a.guild_id=? AND a.user_id=? AND a.points>0 ORDER BY a.points DESC LIMIT 15`).all(gid, uid);
  const total = db.prepare('SELECT COUNT(*) n FROM wheel_roles WHERE guild_id=? AND enabled=1').get(gid).n;
  const embed = new EmbedBuilder().setColor(0xeb459e).setTitle('💕 好感度')
    .setDescription(
      `這個伺服器有 **${total}** 位角色可以攻略。用 \`/送禮\` 送東西、\`/邀請\` 請他來家裡。\n` +
      (def && def.visit_ok ? '你的家已經夠體面，角色願意來作客了。' : `角色來訪需要家園 **Lv.6 花園別墅**（你現在 Lv.${home.level}）。`))
    .setFooter({ text: '送禮好感受角色喜好影響；料理的品質越高，好感加得越多' });
  if (list.length) embed.addFields({
    name: '你的好感度',
    value: list.map(a => `**${a.name}**　${levelName(gid, a.level)}（Lv.${a.level}）　${a.points.toLocaleString('en-US')} 點${a.visits ? `　來訪 ${a.visits} 次` : ''}`).join('\n').slice(0, 1024)
  });
  else embed.addFields({ name: '你還沒有跟任何角色互動', value: '用 `/送禮 角色:名字` 開始 —— 打幾個字就會跳出候選名單。' });
  return {
    embeds: [embed],
    components: [NAV('love'), new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('strollpanel').setLabel('🛍️ 逛街（隨機遇到角色）').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('giftpanel').setLabel('🎁 送禮').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('partnerpanel').setLabel('💞 同居').setStyle(ButtonStyle.Primary))]
  };
}


// ================== 逛街：隨機遇到角色 ==================
//
// 你們有兩百多位角色，用「選單挑一位」永遠只會挑到那幾個熟面孔。
// 逛街改成消耗體力的隨機遇見：花 1 點體力出門，隨機碰到一位角色，
// 他會講自己的台詞（後台每位角色可設三句，隨機挑一句），並自動加一點好感度。
// 已經熟的角色權重會降低一點，讓沒見過的角色更容易冒出來 —— 這樣兩百多隻才真的都會出場。
// 逛街用的體力＝「每日採集點數」那一池（釣魚挖礦也在扣同一池）。
// 這是刻意共用的：體力就是每天唯一的行動額度，玩家得自己決定要拿去挖礦還是去逛街。
// 而且體力**不吃任何加成** —— 家具寵物再多也不會多給體力，只能去特殊商店花錢買。
const { staminaState, bumpPoints } = require('./gather');

/** 隨機挑一位角色：見過越多次的權重越低，讓沒遇過的優先出場 */
function pickRole(gid, uid) {
  // stroll_ok=0 的不參與逛街（轉盤裡的模擬器、活動介紹，或不想出場的作者）
  const roles = db.prepare(
    'SELECT id, name, image_url, intro, author, ad_line, ad_line2, ad_line3 FROM wheel_roles WHERE guild_id=? AND enabled=1 AND stroll_ok=1').all(gid);
  if (!roles.length) return null;
  // 完全隨機：每位角色機率一樣（本來會壓低已經很熟的角色，但你們要的是純隨機，
  // 遇到同一個人也沒關係 —— 那才像真的在街上碰到）
  return roles[Math.floor(Math.random() * roles.length)];
}

const adLine = (r) => {
  const lines = [r.ad_line, r.ad_line2, r.ad_line3].filter(x => x && x.trim());
  if (!lines.length) return '';
  return lines[Math.floor(Math.random() * lines.length)];
};

/** 出門逛街一次 */
function stroll(gid, uid, uname) {
  const c = hcfg(gid);
  if (!c.stroll_enabled) return { error: '現在沒有開放逛街。' };
  const st = staminaState(gid, uid);
  const cost = Math.max(1, c.stroll_cost || 1);
  if (st.max <= 0) return { error: '這個伺服器沒有啟用每日體力，逛街暫時關閉（管理員可在釣魚挖礦設定「每日採集點數」）。' };
  if (cost > st.left) {
    return { error: `體力不夠了（今天剩 ${st.left}/${st.max} 點，逛一次要 ${cost} 點）。\n體力每天午夜回滿，急著用可以去 \`/特殊商店\` 買體力。` };
  }
  const role = pickRole(gid, uid);
  if (!role) return { error: '這個伺服器還沒有任何角色。' };

  const gain = Math.max(0, c.stroll_points || 3);
  const bonus = Math.floor(gain * (buffPct(gid, uid, 'gift_pct') + buffPct(gid, uid, 'affinity_pct')) / 100);
  const points = gain + bonus;
  db.transaction(() => {
    bumpPoints(gid, uid, cost);   // 扣的是共用的每日體力池
    db.prepare(`INSERT INTO affinity (guild_id,user_id,role_id,points,level) VALUES (?,?,?,?,0)
      ON CONFLICT(guild_id,user_id,role_id) DO UPDATE SET points = points + ?`).run(gid, uid, role.id, points, points);
  })();
  const lv = recalcLevel(gid, uid, role.id);
  markSeen(gid, uid, 'role', role.name);
  bumpAch(gid, uid, 'stroll_count', 1);

  const after = staminaState(gid, uid);
  return { role, points, lv, left: after.left, max: after.max, line: adLine(role) };
}

function strollEmbed(gid, uid, out) {
  const a = db.prepare('SELECT points, level FROM affinity WHERE guild_id=? AND user_id=? AND role_id=?').get(gid, uid, out.role.id) || { points: 0, level: 0 };
  // 台詞與介紹常常是同一句（匯入時就是同一份文字），重複貼兩次很醜 —— 一樣就只顯示台詞
  // 只顯示台詞就好 —— 介紹欄跟台詞常常是同一句，貼兩次很囉唆
  const line = String(out.line || out.role.intro || '').trim();
  const e = new EmbedBuilder().setColor(0xeb459e)
    .setTitle(`🛍️ 你在街上遇到了 ${out.role.name}`)
    .setDescription((line ? `💬 **「${line}」**\n\n` : '')
      + `好感度 **+${out.points}** → 目前 ${a.points.toLocaleString('en-US')} 點（${levelName(gid, a.level)}）`)
    .setFooter({ text: `體力剩 ${out.left}/${out.max}｜想加深關係就用 /送禮` });
  // 遇到角色是「看臉」的畫面，圖片用大圖（setImage）而不是右上角的小縮圖
  if (out.role.image_url) e.setImage(absUrl(out.role.image_url));
  return e;
}

/** 逛街面板：一顆按鈕連續逛，體力用完為止 */
function strollPanel(gid, uid, uname) {
  const st = staminaState(gid, uid);
  const total = db.prepare('SELECT COUNT(*) n FROM wheel_roles WHERE guild_id=? AND enabled=1 AND stroll_ok=1').get(gid).n;
  const seen = db.prepare('SELECT COUNT(*) n FROM affinity WHERE guild_id=? AND user_id=? AND points>0').get(gid, uid).n;
  const e = new EmbedBuilder().setColor(0xeb459e).setTitle('🛍️ 逛街')
    .setDescription(`出門走走，**隨機**遇到街上的角色 —— 遇到誰不能挑，這就是逛街的意義。\n`
      + `每次消耗 **${Math.max(1, hcfg(gid).stroll_cost || 1)}** 點體力，遇到就自動加好感度。\n`
      + `體力跟釣魚挖礦**共用同一池**，用完就等明天（或去 \`/特殊商店\` 買）。`)
    .addFields(
      { name: '今日體力', value: `${st.left} / ${st.max}${st.bonus ? `（含買來的 ${st.bonus}）` : ''}`, inline: true },
      { name: '你認識的角色', value: `${seen} / ${total} 位`, inline: true })
    .setFooter({ text: '體力跟釣魚挖礦共用同一池，每天午夜回滿；不受任何加成影響，不夠可以到 /特殊商店 買' });
  return {
    embeds: [e],
    components: [NAV('love'), new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('strollgo').setLabel('🛍️ 出門逛街').setStyle(ButtonStyle.Success)
        .setDisabled(st.left <= 0))]
  };
}


/** 送禮的物品選單（/送禮 與面板的 🎁 送禮按鈕共用） */
function giftMenu(gid, uid, uname, rid) {
  const role = roleOf(gid, rid);
  if (!role) return { error: '找不到這位角色。' };
  // 只列「禮物」與「料理」—— 礦石魚貨那些是材料，不是拿來送人的
  const items = db.prepare(
    `SELECT v.item_id, v.count, it.name, it.emoji, it.price, it.gift_aff FROM gather_inventory v JOIN gather_items it ON it.id=v.item_id
      WHERE v.guild_id=? AND v.user_id=? AND v.count>0 AND it.gift_aff > 0
      ORDER BY it.gift_aff LIMIT 20`).all(gid, uid);
  const dishes = db.prepare(
    `SELECT c.recipe_id, c.quality, c.count, r.name, r.emoji FROM cook_inventory c JOIN cook_recipes r ON r.id=c.recipe_id
      WHERE c.guild_id=? AND c.user_id=? AND c.count>0 ORDER BY c.quality DESC LIMIT 5`).all(gid, uid);
  if (!items.length && !dishes.length) return { error: '你的背包是空的，先去採集、種田或做點料理再來送禮。' };

  const opts = [
    ...dishes.map(d => ({
      label: `${QUALITY[d.quality].emoji}${d.emoji || ''}${d.name}`.slice(0, 100),
      description: `料理（品質越高好感越多）　持有 ${d.count}`.slice(0, 100),
      value: `dish:${d.recipe_id}:${d.quality}`
    })),
    ...items.map(it => {
      // 送過的才顯示角色的喜好，沒送過就寫「還不知道」——這是刻意的，要自己試
      const known = knownWeight(gid, uid, rid, it.name);
      const tag = known === undefined ? '？喜好未知' : LIKE_LABEL(known);
      return {
        label: `${it.emoji || ''}${it.name}`.slice(0, 100),
        description: `基礎好感 +${it.gift_aff}　${tag}　持有 ${it.count}`.slice(0, 100),
        value: `item:${it.item_id}:0`
      };
    })
  ].slice(0, 25);

  return {
    embeds: [roleCard(gid, uid, role, `要送什麼給 **${role.name}**？\n`
      + `每位角色都有 💖最喜歡 ×3、💕喜歡 ×3、💔討厭 ×2 的禮物 —— **送過才知道是哪些**。\n`
      + `倍率：💖 ×2　💕 ×1.5　🤍 ×1　💔 ×0.5`)],
    components: [new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(`giftpick:${rid}`).setPlaceholder('選一樣禮物').addOptions(opts))]
  };
}

/** 名字搜尋：這就是「上百隻角色可以挑名字邀請」的實作 */
function searchRoles(gid, q) {
  const kw = String(q || '').trim();
  const rows = kw
    ? db.prepare(`SELECT id, name, author FROM wheel_roles WHERE guild_id=? AND enabled=1 AND name LIKE ? ORDER BY draw_count DESC LIMIT 25`).all(gid, `%${kw}%`)
    : db.prepare(`SELECT id, name, author FROM wheel_roles WHERE guild_id=? AND enabled=1 ORDER BY draw_count DESC LIMIT 25`).all(gid);
  return rows.map(r => ({ name: `${r.name}${r.author ? `（${r.author}）` : ''}`.slice(0, 100), value: String(r.id) }));
}

function roleCard(gid, uid, role, extra) {
  const a = affOf(gid, uid, role.id);
  const lvs = levelsOf(gid);
  const next = lvs.find(l => l.level === a.level + 1);
  const embed = new EmbedBuilder().setColor(0xeb459e).setTitle(`💕 ${role.name}`)
    .setDescription(role.intro || ' ')
    .addFields(
      { name: '好感度', value: `${levelName(gid, a.level)}（Lv.${a.level}）`, inline: true },
      { name: '累積點數', value: a.points.toLocaleString('en-US'), inline: true },
      { name: '下一階', value: next ? `還差 ${(next.need - a.points).toLocaleString('en-US')} 點` : '已滿', inline: true });
  if (role.image_url) embed.setThumbnail(absUrl(role.image_url));
  if (extra) embed.addFields({ name: '　', value: extra });
  return embed;
}

function init(client) {
  for (const [gid] of client.guilds.cache) { try { seedGiftPrefs(gid); } catch {} }
  for (const [gid] of client.guilds.cache) {
    try { seedHome(gid); seedAffinity(gid); } catch (e) { logError(gid, '好感度初始化失敗：', e.message); }
  }
  client.on('interactionCreate', async (i) => {
    try {
      if (!i.guildId) return;
      const gid = i.guildId, uid = i.user.id, uname = i.user.username;
      const eph = { flags: MessageFlags.Ephemeral };

      // 角色名字自動完成（打字就跳候選，不用記 ID）
      if (i.isAutocomplete() && ['送禮', '邀請', '好感度'].includes(i.commandName)) {
        return i.respond(searchRoles(gid, i.options.getFocused())).catch(() => {});
      }
      if (!i.isChatInputCommand()) {
        // 逛街：面板與「出門」按鈕（隨機遇到角色，消耗體力）
        if (i.isButton() && (i.customId === 'strollpanel' || i.customId === 'adv:stroll')) {
          seedAffinity(gid);
          return i.reply({ ...strollPanel(gid, uid, uname), ...eph }).catch(() => {});
        }
        if (i.isButton() && i.customId === 'strollgo') {
          const out = stroll(gid, uid, uname);
          if (out.error) return i.reply({ content: out.error, ...eph }).catch(() => {});
          // 更新面板（體力／遇到人數），再把這次遇到誰單獨貼出來
          await i.update(strollPanel(gid, uid, uname)).catch(() => {});
          return i.followUp({
            embeds: [strollEmbed(gid, uid, out)],
            content: out.lv && out.lv.up ? `🎉 **${out.role.name}** 的好感度升到 **${levelName(gid, out.lv.level)}**！` : '',
            ...eph
          }).catch(() => {});
        }
        // 送禮按鈕：兩百多位角色沒辦法全塞進下拉，所以先列「你認識的」讓他挑，
        // 想送沒互動過的角色還是可以用 /送禮 打名字搜尋。
        if (i.isButton() && (i.customId === 'giftpanel' || i.customId === 'adv:gift')) {
          seedAffinity(gid);
          const known = db.prepare(
            `SELECT a.role_id, a.points, a.level, r.name FROM affinity a JOIN wheel_roles r ON r.id=a.role_id
              WHERE a.guild_id=? AND a.user_id=? AND r.enabled=1 ORDER BY a.points DESC LIMIT 25`).all(gid, uid);
          if (!known.length) {
            return i.reply({
              content: '你還沒有跟任何角色互動過。\n先去 🛍️ **逛街**隨機遇幾位，或用 `/送禮 角色:名字` 直接指定（打幾個字就會跳候選）。',
              ...eph
            }).catch(() => {});
          }
          return i.reply({
            content: '要送禮給誰？（只列你互動過的角色；想送別人用 `/送禮` 打名字搜尋）',
            components: [new ActionRowBuilder().addComponents(
              new StringSelectMenuBuilder().setCustomId('giftwho').setPlaceholder('選一位角色')
                .addOptions(known.map(k => ({
                  label: k.name.slice(0, 100),
                  description: `${levelName(gid, k.level)}（Lv.${k.level}）　好感 ${k.points.toLocaleString('en-US')}`.slice(0, 100),
                  value: String(k.role_id)
                }))))],
            ...eph
          }).catch(() => {});
        }
        if (i.isStringSelectMenu() && i.customId === 'giftwho') {
          const rid = parseInt(i.values[0], 10);
          const out = giftMenu(gid, uid, uname, rid);
          if (out.error) return i.update({ content: out.error, components: [], embeds: [] }).catch(() => {});
          return i.update({ ...out, embeds: out.embeds || [] }).catch(() => {});
        }

        // 同居：面板／搬進來／搬走
        if (i.isButton() && (i.customId === 'partnerpanel' || i.customId === 'adv:partner')) {
          seedAffinity(gid);
          return i.reply({ ...partnerPanel(gid, uid, uname), ...eph }).catch(() => {});
        }
        if (i.isStringSelectMenu() && i.customId === 'partnermoveout') {
          const out = moveOut(gid, uid, parseInt(i.values[0], 10));
          if (out.error) return i.reply({ content: out.error, ...eph }).catch(() => {});
          await i.update(partnerPanel(gid, uid, uname)).catch(() => {});
          return i.followUp({ content: `**${out.role.name}** 收拾東西搬走了。好感度不會消失，之後想請他回來再邀請一次就好。`, ...eph }).catch(() => {});
        }
        if ((i.isButton() && i.customId === 'partnerin') || (i.isStringSelectMenu() && i.customId === 'partnerpick')) {
          const out = moveIn(gid, uid, uname, i.isStringSelectMenu() ? parseInt(i.values[0], 10) : 0);
          if (out.error) return i.reply({ content: out.error, ...eph }).catch(() => {});
          await i.update(partnerPanel(gid, uid, uname)).catch(() => {});
          const line = adLine(out.role);
          const e = new EmbedBuilder().setColor(0xeb459e).setTitle(`💞 ${out.role.name} 搬進來了！`)
            .setDescription((line ? `💬 **「${line}」**\n\n` : '')
              + `從今天起 **${out.role.name}** 住在你家（${out.used}/${out.slots}）。\n`
              + `✨ 他的能力：**${out.skill.name}**${out.skill.buff_pct ? ` ＋${out.skill.buff_pct}%` : ''}\n`
              + `⚠️ 每期會多一筆**伴侶稅**，請確認你養得起 —— 養不起可以請他搬走。`);
          if (out.role.image_url) e.setThumbnail(absUrl(out.role.image_url));
          return i.followUp({ embeds: [e], ...eph }).catch(() => {});
        }
        if (i.isButton() && i.customId.startsWith('partnerout:')) {
          const rid = parseInt(i.customId.split(':')[1], 10);
          const out = moveOut(gid, uid, rid);
          if (out.error) return i.reply({ content: out.error, ...eph }).catch(() => {});
          await i.update(partnerPanel(gid, uid, uname)).catch(() => {});
          return i.followUp({
            content: `**${out.role.name}** 收拾東西搬走了。好感度不會消失，之後還可以再請人搬進來（一樣是隨機的）。`,
            ...eph
          }).catch(() => {});
        }
        // 送禮的物品選單
        if (i.isStringSelectMenu() && i.customId.startsWith('giftpick:')) {
          const rid = parseInt(i.customId.split(':')[1], 10);
          const [kind, a1, a2] = i.values[0].split(':');
          const out = kind === 'dish'
            ? giftDish(gid, uid, uname, rid, Number(a1), Number(a2))
            : giftItem(gid, uid, uname, rid, Number(a1));
          if (out.error) return i.update({ content: out.error, embeds: [], components: [] }).catch(() => {});
          const react = out.weight >= 200 ? '💖 眼睛都亮了（最喜歡 ×2）'
            : out.weight >= 150 ? '💕 看起來很開心（喜歡 ×1.5）'
              : out.weight <= 50 ? '💔 表情有點微妙（討厭 ×0.5）' : '🤍 收下了';
          const what = out.dish ? `${QUALITY[out.quality].emoji}${out.dish.name}` : `${out.item.emoji || ''}${out.item.name}`;
          return i.update({
            content: out.up ? `🎉 **${out.role.name}** 的好感度升到 **${levelName(gid, out.level)}**！` : '',
            embeds: [roleCard(gid, uid, out.role, `你送出 **${what}**，${out.role.name} ${react}。\n好感度 **+${out.gain}**`)],
            components: []
          }).catch(() => {});
        }
        return;
      }
      if (!['送禮', '邀請', '好感度'].includes(i.commandName)) return;
      seedAffinity(gid);

      const rid = parseInt(i.options.getString('角色'), 10);
      const role = roleOf(gid, rid);
      if (!role) return i.reply({ content: '找不到這位角色，請從自動完成的清單裡選。', ...eph }).catch(() => {});

      if (i.commandName === '好感度') return i.reply({ embeds: [roleCard(gid, uid, role)], ...eph }).catch(() => {});

      if (i.commandName === '邀請') {
        const out = inviteRole(gid, uid, uname, rid);
        if (out.error) return i.reply({ content: out.error, ...eph }).catch(() => {});
        if (out.refused) return i.reply({
          embeds: [roleCard(gid, uid, out.role, `你邀請了 **${out.role.name}**，但他今天有事來不了。\n（成功率 ${out.chance}% —— 好感度越高、家園越好，他越願意來）`)], ...eph
        }).catch(() => {});
        return i.reply({
          content: out.up ? `🎉 **${out.role.name}** 的好感度升到 **${levelName(gid, out.level)}**！` : '',
          embeds: [roleCard(gid, uid, out.role, `🏡 **${out.role.name}** 來你家作客了！\n好感度 **+${out.gain}**`)], ...eph
        }).catch(() => {});
      }

      // 送禮：列出背包物品與做好的料理讓玩家挑（跟面板的 🎁 送禮按鈕同一支）
      const menu = giftMenu(gid, uid, uname, rid);
      if (menu.error) return i.reply({ content: menu.error, ...eph }).catch(() => {});
      return i.reply({ ...menu, ...eph }).catch(() => {});
    } catch (e) {
      logError(i.guildId, '好感度指令失敗：', e.message);
      const msg = { content: '執行失敗，管理員可到後台的系統錯誤紀錄查看原因。', flags: MessageFlags.Ephemeral };
      if (i.replied || i.deferred) await i.followUp(msg).catch(() => {}); else if (i.isRepliable()) await i.reply(msg).catch(() => {});
    }
  });
  console.log('  ↳ 好感度模組已載入（接轉盤角色／名字搜尋邀請）');
}

module.exports = { init, seedAffinity, seedGiftPrefs, lovePanel, strollPanel, stroll, strollEmbed, partnerPanel, partnersOf, moveIn, moveOut, partnerSkillText, partnerSkillPool, DEFAULT_PARTNER_SKILLS, giftMenu, giftItem, searchRoles };
