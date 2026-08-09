// 行情倍率層：物品的「現在賣價」＝ 基準價 × 所有生效中的新聞倍率。
//
// 設計原則（改動前務必先讀）：
//   1. 只作用在「賣價」。工具、種子、動物、設施等「買價」一律維持基準價。
//      買賣同物同時浮動會產生無風險套利；目前系統天然安全，因為買的和賣的
//      不是同一個物品（買種子賣作物、買動物賣蛋），中間隔著時間成本。
//   2. 倍率不追溯庫存價值，只在賣出當下計算 → 不會變成囤貨儲值遊戲。
//   3. market_config.enabled = 0 時，livePrice 一律回傳基準價（預設就是關的）。
const { db, guildConfig } = require('../db');

const cfg = (gid) => guildConfig('market_config', gid);

// 同一次互動內會查很多次價，做 3 秒快取避免 N 次查詢
const CACHE_MS = 3000;
const cache = new Map();   // gid -> { at, mods, cropIds, ranchIds, cfg }

function snapshot(gid) {
  const hit = cache.get(gid);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit;
  const now = Date.now();
  const c = cfg(gid);
  const mods = c.enabled
    ? db.prepare('SELECT * FROM market_modifiers WHERE guild_id=? AND start_ts<=? AND end_ts>? ').all(gid, now, now)
    : [];
  const snap = {
    at: now, cfg: c, mods,
    cropIds: new Set(db.prepare('SELECT product_item_id id FROM crop_seeds WHERE guild_id=?').all(gid).map(r => r.id)),
    ranchIds: new Set(db.prepare('SELECT product_item_id id FROM ranch_animals WHERE guild_id=?').all(gid).map(r => r.id))
  };
  cache.set(gid, snap);
  return snap;
}

// 某個物品目前的倍率（1 ＝ 沒有任何新聞影響）
function multOf(gid, item) {
  if (!item) return 1;
  const s = snapshot(gid);
  if (!s.mods.length) return 1;
  let mult = 1;
  for (const m of s.mods) {
    let hit = false;
    if (m.scope === 'all') hit = true;
    else if (m.scope === 'item') hit = String(m.scope_key) === String(item.id);
    else if (m.scope === 'kind') hit = m.scope_key === item.kind;
    else if (m.scope === 'crop') hit = s.cropIds.has(item.id);
    else if (m.scope === 'ranch') hit = s.ranchIds.has(item.id);
    // 舊資料可能存過 0／負的 mult_pct（表單語意誤解造成），這裡先夾成合理倍率
    if (hit) mult *= normMultPct(m.mult_pct) / 100;
  }
  const lo = (s.cfg.mult_floor_pct || 40) / 100;
  const hi = (s.cfg.mult_ceil_pct || 250) / 100;
  return Math.max(lo, Math.min(hi, mult));
}

// 物品的現在賣價（整數，至少 1）
function livePrice(gid, item) {
  const base = Number(item?.price || 0);
  const mult = multOf(gid, item);
  if (mult === 1) return base;
  return Math.max(1, Math.round(base * mult));
}

// 把使用者／舊資料填的數字正規化成「倍率 %」（130 ＝ ×1.3）。
// 舊版後台的欄位語意是倍率，但管理員普遍當成「漲跌 %」在填，所以 0 或負數
// 一律當作漲跌 % 換算回來（-10 → 90 → ×0.9），不要直接夾成極端值。
function normMultPct(v) {
  let n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 100;
  if (n <= 0) n = 100 + n;
  return Math.max(10, Math.min(500, n));
}

// 給玩家看的標記，例如「📈 ×1.4」；沒有影響時回傳空字串
function priceTag(gid, item) {
  const mult = multOf(gid, item);
  if (mult === 1) return '';
  return mult > 1 ? `📈 ×${mult.toFixed(2).replace(/0$/, '')}` : `📉 ×${mult.toFixed(2).replace(/0$/, '')}`;
}

// 目前生效中的倍率清單（/行情 與後台用）
function activeModifiers(gid) {
  const now = Date.now();
  if (!cfg(gid).enabled) return [];
  return db.prepare(
    'SELECT * FROM market_modifiers WHERE guild_id=? AND start_ts<=? AND end_ts>? ORDER BY end_ts'
  ).all(gid, now, now);
}

// 資料變動後強制重算（後台發布新聞時呼叫）
const bust = (gid) => cache.delete(gid);

const SCOPE_LABEL = {
  all: '🌐 全部物品', item: '📦 單一物品', kind: '⛏️ 某類採集',
  crop: '🌾 菜價（種植產物）', ranch: '🥚 副產品（牧場產物）'
};

module.exports = { livePrice, multOf, priceTag, activeModifiers, bust, normMultPct, SCOPE_LABEL, marketCfg: cfg };
