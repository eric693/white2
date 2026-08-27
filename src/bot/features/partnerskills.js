// 同居角色的能力系統。
//
// 設計重點（跟舊版的差別）：
//   舊版是「搬進來隨機給一個 % 加成」，玩家沒得選、也看不懂那個加成在幹嘛。
//   新版是三層：
//     ① 能力池（partner_skills）—— 後台可增刪改，每個能力可設各好感階段的數值
//     ② 角色 × 能力（role_skills）—— 後台勾選「這位角色可以用哪些能力」，可複選
//     ③ 玩家啟用（home_partners.skill_id）—— 同居後從候選中選 1 個，同時只有 1 個生效
//   新增角色時只要在後台勾選，不用再動任何程式。
//
// 能力分兩種執行方式：
//   ・被動（passive）＝ 一個 buff_type 的 %，走 util/buffs.js 既有的加成管線
//   ・每日（daily）  ＝ 每天早上結算一次，實際去收成／種植／給錢
const cron = require('node-cron');
const { EmbedBuilder } = require('discord.js');
const { db, guildConfig, logError, activeGuildIds } = require('../../db');
const { brandColor } = require('../../util/brand');

const gcfg = (gid) => guildConfig('gather_config', gid);
const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);   // 台北時區的今天

// ---- 18 種能力的定義 ----
// code 是程式認得的鍵；後台只能挑這裡有的 code（新增能力要同時加這裡的實作）。
// unit：count＝數量、coins＝金額、pct＝百分比。後台填的 val_min/val_max 就是這個單位。
const ABILITIES = {
  // 生產類
  farm_harvest:       { kind: 'produce',   name: '🌾 農地收成',     unit: 'none',  desc: '每天自動收成已成熟的農地產物' },
  aqua_collect:       { kind: 'produce',   name: '🐠 魚缸收成',     unit: 'none',  desc: '每天自動把魚缸累積的星幣領進錢包' },
  greenhouse_harvest: { kind: 'produce',   name: '🏡 溫室收成',     unit: 'none',  desc: '每天自動收成已成熟的溫室產物' },
  hatch_collect:      { kind: 'produce',   name: '🥚 孵化室收成',   unit: 'none',  desc: '每天自動領走孵好的動物，牧場滿了就直接賣掉換星幣' },
  thief_guard:        { kind: 'produce',   name: '🛡️ 擊退小偷',     unit: 'coins', desc: '協助擊退小偷，成功時額外拿到星幣' },
  // 冒險類
  mine_helper:        { kind: 'adventure', name: '⛏️ 挖礦助手',     unit: 'count', kindKey: 'mine',   desc: '每天額外帶回隨機礦物' },
  wood_helper:        { kind: 'adventure', name: '🪓 伐木助手',     unit: 'count', kindKey: 'wood',   desc: '每天額外帶回隨機木材' },
  fish_helper:        { kind: 'adventure', name: '🎣 釣魚助手',     unit: 'count', kindKey: 'fish',   desc: '每天額外帶回隨機魚類' },
  forage_helper:      { kind: 'adventure', name: '🧺 採集助手',     unit: 'count', kindKey: 'forage', desc: '每天額外帶回隨機採集物' },
  hunt_helper:        { kind: 'adventure', name: '🏹 狩獵助手',     unit: 'count', kindKey: 'hunt',   desc: '每天額外帶回隨機狩獵產物' },
  // 自動照顧類
  farm_plant:         { kind: 'care',      name: '🌱 農地種植',     unit: 'none',  desc: '用你背包裡現有的農地種子自動種滿空格（沒種子就不做）' },
  aqua_feed:          { kind: 'care',      name: '🍤 魚缸餵食',     unit: 'none',  desc: '每天自動幫你餵魚' },
  greenhouse_plant:   { kind: 'care',      name: '🪴 溫室種植',     unit: 'none',  desc: '用你背包裡現有的溫室種子自動種滿空格（沒種子就不做）' },
  hatch_put:          { kind: 'care',      name: '🥚 孵化室放蛋',   unit: 'none',  desc: '背包有可孵化的蛋時自動放進孵化室（沒蛋就不做）' },
  // 經濟類
  daily_coins:        { kind: 'economy',   name: '💰 每日賺錢',     unit: 'coins', desc: '每天自動帶回一筆隨機星幣' },
  sell_bonus:         { kind: 'economy',   name: '🏷️ 產品價格加成', unit: 'pct',   passive: 'sell_pct',           desc: '賣東西時售價提高' },
  stock_fee_cut:      { kind: 'economy',   name: '📉 股市手續費減免', unit: 'pct', passive: 'stock_fee_cut_pct', desc: '股票買賣的手續費降低' },
  stock_bonus:        { kind: 'economy',   name: '📈 股市價格加成', unit: 'pct',   passive: 'stock_pct',          desc: '賣股時多拿一點' }
};

const KIND_LABEL = { produce: '生產類', adventure: '冒險類', care: '自動照顧類', economy: '經濟類', buff: '一般加成' };

// ---- 開箱即有的預設能力池（後台可整批匯入後再自行調整）----
// tiers 是「好感階段 → 數值」：lv 是好感度階級門檻，由低到高；玩家好感度達到哪一階就用哪一階的數值。
const DEFAULT_SKILLS = [
  { code: 'farm_harvest',       tiers: [] },
  { code: 'aqua_collect',       tiers: [] },
  { code: 'greenhouse_harvest', tiers: [] },
  { code: 'hatch_collect',      tiers: [] },
  { code: 'thief_guard',        val_min: 100, val_max: 5000, tiers: [{ lv: 8, min: 200, max: 8000 }, { lv: 10, min: 500, max: 12000 }] },
  { code: 'mine_helper',        val_min: 5, val_max: 5, tiers: [{ lv: 8, min: 7, max: 7 }, { lv: 10, min: 10, max: 10 }] },
  { code: 'wood_helper',        val_min: 5, val_max: 5, tiers: [{ lv: 8, min: 7, max: 7 }, { lv: 10, min: 10, max: 10 }] },
  { code: 'fish_helper',        val_min: 5, val_max: 5, tiers: [{ lv: 8, min: 7, max: 7 }, { lv: 10, min: 10, max: 10 }] },
  { code: 'forage_helper',      val_min: 5, val_max: 5, tiers: [{ lv: 8, min: 7, max: 7 }, { lv: 10, min: 10, max: 10 }] },
  { code: 'hunt_helper',        val_min: 5, val_max: 5, tiers: [{ lv: 8, min: 7, max: 7 }, { lv: 10, min: 10, max: 10 }] },
  { code: 'farm_plant',         tiers: [] },
  { code: 'aqua_feed',          tiers: [] },
  { code: 'greenhouse_plant',   tiers: [] },
  { code: 'hatch_put',          tiers: [] },
  { code: 'daily_coins',        val_min: 0, val_max: 1000, tiers: [{ lv: 8, min: 0, max: 2000 }, { lv: 10, min: 0, max: 5000 }] },
  { code: 'sell_bonus',         val_min: 5, val_max: 5, tiers: [{ lv: 8, min: 7, max: 7 }, { lv: 10, min: 10, max: 10 }] },
  { code: 'stock_fee_cut',      val_min: 1, val_max: 1, tiers: [{ lv: 8, min: 2, max: 2 }, { lv: 10, min: 3, max: 3 }] },
  { code: 'stock_bonus',        val_min: 5, val_max: 5, tiers: [{ lv: 8, min: 7, max: 7 }, { lv: 10, min: 10, max: 10 }] }
];

/** 把預設能力池寫進某個伺服器（已經有同 code 的就跳過，不會覆蓋管理員改過的設定） */
function seedSkills(gid) {
  const ins = db.prepare(
    `INSERT INTO partner_skills (guild_id,name,code,kind,buff_type,val_min,val_max,tiers,description,weight,sort,enabled)
     VALUES (?,?,?,?,?,?,?,?,?,10,?,1)`);
  db.transaction(() => {
    DEFAULT_SKILLS.forEach((d, idx) => {
      const a = ABILITIES[d.code];
      if (!a) return;
      if (db.prepare('SELECT 1 FROM partner_skills WHERE guild_id=? AND code=?').get(gid, d.code)) return;
      ins.run(gid, a.name, d.code, a.kind, a.passive || '', d.val_min || 0, d.val_max || 0,
        JSON.stringify(d.tiers || []), a.desc, idx);
    });
  })();
}

/** 這個能力在某個好感度階級下的實際數值：{ min, max } */
function valueFor(skill, level) {
  let min = skill.val_min || 0, max = skill.val_max || 0;
  let tiers = [];
  try { tiers = JSON.parse(skill.tiers || '[]'); } catch { tiers = []; }
  for (const t of (Array.isArray(tiers) ? tiers : []).slice().sort((a, b) => (a.lv || 0) - (b.lv || 0))) {
    if ((level || 0) >= (t.lv || 0)) { min = t.min ?? min; max = t.max ?? max; }
  }
  if (max < min) max = min;
  return { min, max };
}

const rollValue = (v) => v.max > v.min ? v.min + Math.floor(Math.random() * (v.max - v.min + 1)) : v.min;

/** 能力的說明文字（面板／後台共用） */
function skillText(skill, level) {
  const a = ABILITIES[skill.code];
  const v = valueFor(skill, level);
  const unit = a ? a.unit : 'none';
  if (unit === 'pct') return `${skill.name}　${v.min > 0 ? '+' : ''}${v.min}%`;
  if (unit === 'coins') return `${skill.name}　${v.min.toLocaleString('en-US')}～${v.max.toLocaleString('en-US')} 星幣`;
  if (unit === 'count') return `${skill.name}　每日 ×${v.min}${v.max > v.min ? `～${v.max}` : ''}`;
  return skill.name;
}

/** 某位角色可用的能力清單（後台勾選的；沒勾就是全部啟用中的能力都能選） */
function skillsForRole(gid, roleId) {
  // code 是空的都是舊制留下來的資料（隨機 % 加成），沒有對應的行為實作 —— 不給玩家選
  const picked = db.prepare(
    `SELECT s.* FROM role_skills rs JOIN partner_skills s ON s.id = rs.skill_id
      WHERE rs.guild_id=? AND rs.role_id=? AND s.enabled=1 AND s.code <> '' ORDER BY s.sort, s.id`).all(gid, roleId);
  if (picked.length) return picked;
  return db.prepare("SELECT * FROM partner_skills WHERE guild_id=? AND enabled=1 AND code <> '' ORDER BY sort, id").all(gid);
}

/**
 * 這位角色「後台指定」的能力。同居能力是由管理員在後台決定的，不給玩家挑：
 * 後台有勾就用勾的第一個（依 sort），沒勾就退回能力池的第一個，讓角色至少有能力可用。
 */
function designatedSkill(gid, roleId) {
  // 後台有替這位角色勾到「有實作」的能力 → 用排序最前面的那一個
  const picked = db.prepare(
    `SELECT s.* FROM role_skills rs JOIN partner_skills s ON s.id = rs.skill_id
      WHERE rs.guild_id=? AND rs.role_id=? AND s.enabled=1 AND s.code <> '' ORDER BY s.sort, s.id`).all(gid, roleId);
  if (picked.length) return picked[0];
  // 沒設定（或只勾到沒實作的舊能力）→ 依 role_id 固定挑一個，讓每位角色至少各有特色，
  // 而不是全部都拿到同一個能力；管理員在後台勾了就會蓋掉這個預設。
  const pool = db.prepare(
    "SELECT * FROM partner_skills WHERE guild_id=? AND enabled=1 AND code <> '' ORDER BY sort, id").all(gid);
  if (!pool.length) return null;
  return pool[Math.abs(Number(roleId) || 0) % pool.length];
}

const skillById = (gid, id) => db.prepare('SELECT * FROM partner_skills WHERE guild_id=? AND id=?').get(gid, id);

/** 玩家目前啟用中的某個能力（含好感度階級），沒有就回 null */
function activeSkill(gid, uid, code) {
  return db.prepare(
    `SELECT s.*, a.level FROM home_partners p
       JOIN partner_skills s ON s.id = p.skill_id AND s.enabled=1
       LEFT JOIN affinity a ON a.guild_id=p.guild_id AND a.user_id=p.user_id AND a.role_id=p.role_id
      WHERE p.guild_id=? AND p.user_id=? AND s.code=? LIMIT 1`).get(gid, uid, code) || null;
}

/** 被動能力的 %：給 util/buffs.js 與 stock.js 用 */
function passivePct(gid, uid, code) {
  const s = activeSkill(gid, uid, code);
  return s ? valueFor(s, s.level || 0).min : 0;
}

// ---------- 每日結算 ----------

/** 隨機給某個種類的素材 ×n（挖礦／伐木／釣魚／採集／狩獵助手共用） */
function giveRandomItems(gid, uid, itemKind, n) {
  const { addToBag } = require('./gather');
  const pool = db.prepare('SELECT id, name, emoji FROM gather_items WHERE guild_id=? AND kind=? AND enabled=1').all(gid, itemKind);
  if (!pool.length || n <= 0) return [];
  const got = new Map();
  for (let k = 0; k < n; k++) {
    const it = pool[Math.floor(Math.random() * pool.length)];
    got.set(it.id, (got.get(it.id) || 0) + 1);
  }
  const lines = [];
  db.transaction(() => {
    for (const [id, c] of got) {
      addToBag(gid, uid, id, c);
      const it = pool.find(x => x.id === id);
      lines.push(`${it.emoji || ''}${it.name} ×${c}`);
    }
  })();
  return lines;
}

/** 收成成熟的農地／溫室 */
function harvestPlots(gid, uid, type) {
  const { addToBag } = require('./gather');
  const now = Date.now();
  const ripe = db.prepare('SELECT * FROM crop_plots WHERE guild_id=? AND user_id=? AND plot_type=? AND ready_at<=?').all(gid, uid, type, now);
  if (!ripe.length) return [];
  const gained = new Map();
  db.transaction(() => {
    for (const r of ripe) {
      const seed = db.prepare('SELECT * FROM crop_seeds WHERE guild_id=? AND id=?').get(gid, r.seed_id);
      db.prepare('DELETE FROM crop_plots WHERE guild_id=? AND user_id=? AND plot_type=? AND slot=?').run(gid, uid, r.plot_type, r.slot);
      if (!seed) continue;
      // 跟玩家自己 /採收 走同一套產量加成，不能因為是同居角色代收就少拿
      const n = require('./crops').yieldCountFor(gid, uid, seed);
      addToBag(gid, uid, seed.product_item_id, n);
      gained.set(seed.product_item_id, (gained.get(seed.product_item_id) || 0) + n);
    }
  })();
  return [...gained.entries()].map(([id, n]) => {
    const p = db.prepare('SELECT name, emoji FROM gather_items WHERE id=?').get(id);
    return `${p ? (p.emoji || '') + p.name : '產物'} ×${n}`;
  });
}

/** 用背包裡現有的種子把空格種滿（隨機挑種子，沒種子就不做） */
function autoPlant(gid, uid, uname, type) {
  const { plantableSeeds, plantSeeds } = require('./crops');
  const lines = [];
  for (let guard = 0; guard < 25; guard++) {
    const bag = plantableSeeds(gid, uid, type);
    if (!bag.length) break;
    const pick = bag[Math.floor(Math.random() * bag.length)];
    const r = plantSeeds(gid, uid, uname, pick.seed.id, pick.have);
    if (r.error) break;                                  // 沒空格了就停
    lines.push(`${pick.seed.emoji || '🌱'}${pick.seed.name}`);
  }
  return lines;
}

/** 孵化室：領走孵好的動物（牧場滿了就賣掉換星幣） */
function collectHatched(gid, uid, uname) {
  const { addCoins } = require('./gather');
  const { facilitySlots } = require('./facility');
  const rcfg = guildConfig('ranch_config', gid);
  const now = Date.now();
  const done = db.prepare('SELECT * FROM ranch_incubator WHERE guild_id=? AND user_id=? AND ready_at<=?').all(gid, uid, now);
  if (!done.length) return [];
  const unlocked = (db.prepare('SELECT ranch FROM ranch_unlocks WHERE guild_id=? AND user_id=?').get(gid, uid) || {}).ranch || 0;
  const maxSlots = Math.max(0, rcfg.max_slots || 0) + unlocked + facilitySlots(gid, uid, 'ranch');
  const used = db.prepare('SELECT slot FROM ranch_slots WHERE guild_id=? AND user_id=?').all(gid, uid).map(r => r.slot);
  const free = [];
  for (let s = 0; s < maxSlots; s++) if (!used.includes(s)) free.push(s);
  const lines = [];
  let sold = 0;
  db.transaction(() => {
    for (const d of done) {
      const a = db.prepare('SELECT * FROM ranch_animals WHERE guild_id=? AND id=?').get(gid, d.animal_id);
      db.prepare('DELETE FROM ranch_incubator WHERE guild_id=? AND user_id=? AND slot=?').run(gid, uid, d.slot);
      if (!a) continue;
      const slot = free.shift();
      if (slot === undefined) {
        // 牧場沒空位 —— 規格要求「可自動賣出」，賣價用動物售價的一半（跟手動賣一致的觀感）
        sold += Math.max(1, Math.floor(a.price / 2));
        lines.push(`${a.emoji || '🐾'}${a.name}（牧場滿了→賣掉）`);
        continue;
      }
      db.prepare('INSERT INTO ranch_slots (guild_id,user_id,slot,animal_id,last_produce_day) VALUES (?,?,?,?,?)')
        .run(gid, uid, slot, a.id, '');
      lines.push(`${a.emoji || '🐾'}${a.name}（住進第 ${slot + 1} 格）`);
    }
    if (sold > 0) addCoins(gid, uid, uname, sold);
  })();
  if (sold > 0) lines.push(`賣出所得 ${sold.toLocaleString('en-US')} 星幣`);
  return lines;
}

/** 背包有蛋就放進孵化室 */
function autoIncubate(gid, uid) {
  const { hatchEgg } = require('./ranch');
  const eggs = db.prepare(
    `SELECT d.id, d.egg_item_id, d.egg_name, v.count FROM ranch_hatch_defs d
       JOIN gather_inventory v ON v.item_id = d.egg_item_id AND v.guild_id=d.guild_id
      WHERE d.guild_id=? AND d.enabled=1 AND v.user_id=? AND v.count > 0`).all(gid, uid);
  const lines = [];
  for (const e of eggs) {
    const r = hatchEgg(gid, uid, '', e.id, e.count);
    if (r && r.error) continue;
    lines.push(`${e.egg_name} ×${e.count}`);
  }
  return lines;
}

/** 一位同居角色跑一次它的能力，回傳這次做了什麼（沒事做就回 null） */
function runOne(gid, p, skill) {
  const uid = p.user_id, uname = p.user_name || '';
  const level = p.level || 0;
  const v = valueFor(skill, level);
  const a = ABILITIES[skill.code];
  if (!a || a.passive) return null;                      // 被動能力不用每日結算
  const { addCoins } = require('./gather');
  switch (skill.code) {
    case 'farm_harvest':       { const l = harvestPlots(gid, uid, 'field');      return l.length ? l : null; }
    case 'greenhouse_harvest': { const l = harvestPlots(gid, uid, 'greenhouse'); return l.length ? l : null; }
    case 'aqua_collect': {
      const { accrue } = require('./aquarium');
      accrue(gid, uid);
      const total = db.prepare('SELECT COALESCE(SUM(pending),0) n FROM aquarium_slots WHERE guild_id=? AND user_id=?').get(gid, uid).n;
      if (total <= 0) return null;
      db.transaction(() => {
        db.prepare('UPDATE aquarium_slots SET pending=0 WHERE guild_id=? AND user_id=?').run(gid, uid);
        addCoins(gid, uid, uname, total);
      })();
      return [`魚缸領到 ${total.toLocaleString('en-US')} 星幣`];
    }
    case 'aqua_feed': {
      const { feedAll } = require('./aquarium');
      const r = feedAll(gid, uid, uname);
      return r && !r.error ? ['幫你餵了魚'] : null;
    }
    case 'hatch_collect': { const l = collectHatched(gid, uid, uname); return l.length ? l : null; }
    case 'hatch_put':     { const l = autoIncubate(gid, uid);          return l.length ? l : null; }
    case 'farm_plant':       { const l = autoPlant(gid, uid, uname, 'field');      return l.length ? [`種下 ${l.join('、')}`] : null; }
    case 'greenhouse_plant': { const l = autoPlant(gid, uid, uname, 'greenhouse'); return l.length ? [`種下 ${l.join('、')}`] : null; }
    case 'thief_guard': {
      const n = rollValue(v);
      if (n <= 0) return null;
      addCoins(gid, uid, uname, n);
      return [`擊退小偷，拿到 ${n.toLocaleString('en-US')} 星幣`];
    }
    case 'daily_coins': {
      const n = rollValue(v);
      if (n <= 0) return null;
      addCoins(gid, uid, uname, n);
      return [`帶回 ${n.toLocaleString('en-US')} 星幣`];
    }
    case 'mine_helper': case 'wood_helper': case 'fish_helper':
    case 'forage_helper': case 'hunt_helper': {
      const l = giveRandomItems(gid, uid, a.kindKey, rollValue(v));
      return l.length ? l : null;
    }
    default: return null;
  }
}

// 「收成類」能力：東西成熟了就該收，一天只跑一次會讓作物（90~480 分就成熟）
// 卡在田裡大半天，玩家會覺得自動收成根本沒作用。這類改成每小時跑。
// 這些動作本身都有自然上限（沒成熟就收不到、沒空格就種不了、魚飽了就不餵），
// 所以重複跑是安全的，不需要用 last_run 擋。
const HOURLY_SKILLS = new Set([
  'farm_harvest', 'greenhouse_harvest', 'aqua_collect', 'hatch_collect',
  'farm_plant', 'greenhouse_plant', 'hatch_put', 'aqua_feed'
]);

/** 整個伺服器跑一次結算。mode='daily' 每日配給類；mode='hourly' 收成類。 */
function runDaily(gid, mode = 'daily') {
  const day = today();
  const rows = db.prepare(
    `SELECT p.*, r.name AS role_name, a.level, w.username AS user_name
       FROM home_partners p
       JOIN wheel_roles r ON r.id = p.role_id
       LEFT JOIN affinity a ON a.guild_id=p.guild_id AND a.user_id=p.user_id AND a.role_id=p.role_id
       LEFT JOIN econ_wallets w ON w.guild_id=p.guild_id AND w.user_id=p.user_id
      WHERE p.guild_id=? AND p.skill_id > 0`
    + (mode === 'daily' ? ' AND p.last_run <> ?' : '')   // 收成類每小時都要能跑，不受今天已結算影響
  ).all(...(mode === 'daily' ? [gid, day] : [gid]));
  const out = [];
  for (const p of rows) {
    try {
      const skill = skillById(gid, p.skill_id);
      if (!skill || !skill.enabled) continue;
      const isHourly = HOURLY_SKILLS.has(skill.code);
      if (mode === 'hourly' ? !isHourly : isHourly) continue;   // 只跑這一輪該跑的
      // 每日配給類要記 last_run 免得同一天重複領；收成類本身就自帶上限，不用擋
      if (mode === 'daily') {
        db.prepare('UPDATE home_partners SET last_run=? WHERE guild_id=? AND user_id=? AND role_id=?')
          .run(day, gid, p.user_id, p.role_id);
      }
      const lines = runOne(gid, p, skill);
      if (lines && lines.length) out.push({ user_id: p.user_id, role: p.role_name, skill: skill.name, lines });
    } catch (e) { logError(gid, `同居能力執行失敗（${p.user_id}）：`, e.message); }
  }
  return out;
}

function init(client) {
  for (const [gid] of client.guilds.cache) {
    try { seedSkills(gid); } catch (e) { logError(gid, '同居能力預設建立失敗：', e.message); }
  }
  // 每天早上 8:40 結算（牧場的「幫忙收成」是 8:30，錯開避免同時搶 DB）
  cron.schedule('40 8 * * *', async () => {
    for (const gid of activeGuildIds()) {
      try {
        const done = runDaily(gid);
        if (!done.length) continue;
        const gc = gcfg(gid);
        // 結算結果只私訊本人：以前是公開發在頻道又 tag 人，等於把每個人的
        // 同居對象與收成全部攤在大家面前，還會洗版。
        for (const d of done) {
          const u = await client.users.fetch(d.user_id).catch(() => null);
          if (!u) continue;
          await u.send({ embeds: [new EmbedBuilder().setColor(0xeb459e).setTitle('💞 同居角色幫你做了事')
            .setDescription(`**${d.role}**（${d.skill}）\n${d.lines.map(x => `・${x}`).join('\n')}`)
            .setFooter({ text: `每天早上 8:40 結算｜${gc.currency_name || '星幣'}` })] }).catch(() => {});
        }
      } catch (e) { logError(gid, '同居能力每日結算失敗：', e.message); }
    }
  }, { timezone: 'Asia/Taipei' });

  // 收成類每小時跑一次：作物 90~480 分就成熟，等到隔天早上才收等於自動收成沒作用。
  // 不發通知（一天 24 次會洗版），東西直接進背包／錢包，玩家自己看得到。
  cron.schedule('5 * * * *', () => {
    for (const gid of activeGuildIds()) {
      try { runDaily(gid, 'hourly'); }
      catch (e) { logError(gid, '同居能力每小時收成失敗：', e.message); }
    }
  }, { timezone: 'Asia/Taipei' });

  console.log('  ↳ 同居能力模組已載入（18 種能力：收成類每小時、配給類每天 8:40）');
}

/** 通知頻道：沿用採集系統設定的頻道，沒設就不發 */
function notifyChannel(client, gid) {
  const ids = String(gcfg(gid).channels || '').split(/[\n,]/).map(x => x.trim()).filter(Boolean);
  for (const id of ids) { const ch = client.channels.cache.get(id); if (ch) return ch; }
  return null;
}

module.exports = { designatedSkill,
  init, ABILITIES, KIND_LABEL, seedSkills, valueFor, skillText,
  skillsForRole, skillById, activeSkill, passivePct, runDaily, DEFAULT_SKILLS
};
