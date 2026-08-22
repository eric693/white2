// 成就指標層。
//
// 為什麼要獨立一支：稱號原本只能用「圖鑑收集數／身家／房屋階級」三種條件解鎖，
// 想做「挖到 500 次礦」「連續簽到 30 天」「防守成功 20 次」這種任務式成就就寫不出來。
// 這裡把「一個玩家在某件事上的數字」統一成 metric，稱號只要填 metric + need 就會自動生效，
// 後台新增一筆《碎石狂人》也不必改程式。
//
// 兩種 metric：
//   ① 衍生型（derived）—— 直接從既有資料表算，不必到處埋計數器（例：身家、房屋階級、圖鑑數）
//   ② 計數型（counter）—— 玩家每做一次就 bump 一次，存在 ach_stats（例：挖礦次數、防守成功次數）
const { db } = require('../db');

const num = (row) => (row && row.n) || 0;
const q = (sql, ...args) => num(db.prepare(sql).get(...args));

// key → { name, unit, derived?(gid,uid) }
const METRICS = {
  // ---- 計數型：由各功能 bump ----
  gather_fish:   { name: '釣魚次數', unit: '次' },
  gather_mine:   { name: '挖礦次數', unit: '次' },
  gather_forage: { name: '採集次數', unit: '次' },
  gather_hunt:   { name: '狩獵次數', unit: '次' },
  gather_wood:   { name: '伐木次數', unit: '次' },
  craft_count:   { name: '製作次數', unit: '次' },
  sell_coins:    { name: '累計賣出金額', unit: '' },
  cook_count:    { name: '完成料理', unit: '道' },
  cook_perfect:  { name: '完美料理', unit: '道' },
  harvest_count: { name: '收成次數', unit: '次' },
  steal_success: { name: '偷竊成功', unit: '次' },
  defend_success:{ name: '防守成功（把小偷擋掉）', unit: '次' },
  gift_count:    { name: '送禮次數', unit: '次' },
  feed_count:    { name: '餵食寵物', unit: '次' },
  quest_done:    { name: '完成任務', unit: '個' },

  // ---- 衍生型：現算現有的資料 ----
  coins:        { name: '目前身家', unit: '', derived: (g, u) => q('SELECT coins n FROM econ_wallets WHERE guild_id=? AND user_id=?', g, u) },
  total_earned: { name: '累計賺得', unit: '', derived: (g, u) => q('SELECT total_earned n FROM econ_wallets WHERE guild_id=? AND user_id=?', g, u) },
  home_level:   { name: '房屋階級', unit: '階', derived: (g, u) => q('SELECT level n FROM home_users WHERE guild_id=? AND user_id=?', g, u) },
  kitchen_level:{ name: '廚房等級', unit: '級', derived: (g, u) => q('SELECT kitchen_level n FROM home_users WHERE guild_id=? AND user_id=?', g, u) },
  checkin_total:{ name: '累計簽到', unit: '天', derived: (g, u) => q('SELECT total n FROM home_checkin WHERE guild_id=? AND user_id=?', g, u) },
  checkin_best: { name: '最長連續簽到', unit: '天', derived: (g, u) => q('SELECT best n FROM home_checkin WHERE guild_id=? AND user_id=?', g, u) },
  pet_count:    { name: '養過的寵物', unit: '隻', derived: (g, u) => q('SELECT COUNT(*) n FROM pet_owned WHERE guild_id=? AND user_id=?', g, u) },
  pet_intimacy: { name: '寵物最高親密度', unit: '', derived: (g, u) => q('SELECT COALESCE(MAX(intimacy),0) n FROM pet_owned WHERE guild_id=? AND user_id=?', g, u) },
  furniture_placed: { name: '擺出來的家具', unit: '件', derived: (g, u) => q('SELECT COALESCE(SUM(placed),0) n FROM home_furniture_owned WHERE guild_id=? AND user_id=?', g, u) },
  affinity_max: { name: '最高好感度', unit: '階', derived: (g, u) => q('SELECT COALESCE(MAX(level),0) n FROM affinity WHERE guild_id=? AND user_id=?', g, u) },
  affinity_roles:{ name: '互動過的角色', unit: '位', derived: (g, u) => q('SELECT COUNT(*) n FROM affinity WHERE guild_id=? AND user_id=? AND points>0', g, u) },
  aqua_fish:    { name: '魚缸裡的魚', unit: '隻', derived: (g, u) => q('SELECT COUNT(*) n FROM aquarium_slots WHERE guild_id=? AND user_id=?', g, u) },
  ranch_animals:{ name: '牧場動物', unit: '隻', derived: (g, u) => q('SELECT COUNT(*) n FROM ranch_slots WHERE guild_id=? AND user_id=?', g, u) },
  donate_coins: { name: '累計捐款', unit: '', derived: (g, u) => q('SELECT COALESCE(SUM(amount),0) n FROM charity_donations WHERE guild_id=? AND user_id=?', g, u) },
  stock_trades: { name: '股市成交', unit: '筆', derived: (g, u) => q('SELECT COUNT(*) n FROM stock_trades WHERE guild_id=? AND user_id=?', g, u) },
  stock_profit: { name: '股市已實現獲利', unit: '', derived: (g, u) => q('SELECT COALESCE(SUM(pnl),0) n FROM stock_trades WHERE guild_id=? AND user_id=?', g, u) },
  tax_paid:     { name: '累計繳稅', unit: '', derived: (g, u) => q('SELECT COALESCE(SUM(total),0) n FROM tax_records WHERE guild_id=? AND user_id=? AND paid=1', g, u) },
  dex_total:    { name: '圖鑑總收集', unit: '種', derived: (g, u) => q('SELECT COUNT(*) n FROM dex_seen WHERE guild_id=? AND user_id=?', g, u) }
};

// 圖鑑各分類也都能當 metric：dex_fish、dex_mine、dex_cook…
for (const cat of ['fish', 'mine', 'crop', 'greenhouse', 'forage', 'hunt', 'cook', 'pet', 'furniture', 'role']) {
  METRICS['dex_' + cat] = {
    name: `圖鑑收集（${cat}）`, unit: '種',
    derived: (g, u) => q('SELECT COUNT(*) n FROM dex_seen WHERE guild_id=? AND user_id=? AND cat=?', g, u, cat)
  };
}

/** 玩家做了某件事 → 累加計數。呼叫失敗絕不能擋住遊戲流程，所以整支包在 try 裡。 */
function bump(gid, uid, metric, n = 1) {
  if (!metric || !n) return;
  try {
    db.prepare(
      `INSERT INTO ach_stats (guild_id,user_id,metric,value) VALUES (?,?,?,?)
       ON CONFLICT(guild_id,user_id,metric) DO UPDATE SET value = value + ?, updated_at = datetime('now','localtime')`
    ).run(gid, uid, metric, n, n);
  } catch { /* 統計壞掉不該影響玩家 */ }
}

/** 某個 metric 目前的數字（衍生型現算、計數型讀表） */
function metricValue(gid, uid, metric) {
  const m = METRICS[metric];
  if (!m) return 0;
  if (m.derived) { try { return m.derived(gid, uid) || 0; } catch { return 0; } }
  try {
    return q('SELECT value n FROM ach_stats WHERE guild_id=? AND user_id=? AND metric=?', gid, uid, metric);
  } catch { return 0; }
}

const metricName = (metric) => (METRICS[metric] || {}).name || metric;

/** 進度條（顯示用）。已達成回滿條。 */
function bar(have, need, width = 10) {
  const pct = need > 0 ? Math.min(1, have / need) : 1;
  const on = Math.round(pct * width);
  return '█'.repeat(on) + '░'.repeat(width - on);
}

module.exports = { METRICS, bump, metricValue, metricName, bar };
