// 釣魚 / 挖礦掛機系統
// 一個指令 + 冷卻 → 隨機掉落（N/R/SR/SSR）→ 賣出換貨幣 → 買更好的竿子/鎬子提升稀有率。
// 設計重點：互動極輕（打一個指令就好），靠冷卻讓人固定回來，順便把經濟系統帶起來。
const { EmbedBuilder, MessageFlags, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { db, guildConfig, logError } = require('../../db');
const { brandColor } = require('../../util/brand');
// 行情倍率：財經新聞會改變「賣價」（買價不受影響）。新聞系統關閉時 livePrice 就等於基準價。
const { livePrice, priceTag } = require('../../util/market');
const { userBuffs } = require('../../util/buffs');
const { bump: bumpAch } = require('../../util/achievements');

const cfg = (gid) => guildConfig('gather_config', gid);
const csv = (s) => String(s || '').split(/[\n,]/).map(x => x.trim()).filter(Boolean);

// farm＝牧場產物（蛋/奶/毛等），沒有對應的採集指令與道具，只是為了讓產物
// 出現在 /背包 並能用 /賣出 賣掉，所以放進同一套物品/背包系統。
const KIND_NAME = { fish: '釣魚', mine: '挖礦', wood: '伐木', forage: '採集', hunt: '狩獵', farm: '牧場產物' };
const KIND_EMOJI = { fish: '🎣', mine: '⛏️', wood: '🪓', forage: '🧺', hunt: '🏹', farm: '🥚' };
const KIND_TOOL = { fish: '魚竿', mine: '鎬子', wood: '斧頭', forage: '籃子', hunt: '弓' };
const GATHER_CMD = { 釣魚: 'fish', 挖礦: 'mine', 伐木: 'wood', 採集: 'forage', 狩獵: 'hunt' };
const RARITY = ['N', 'R', 'SR', 'SSR'];
const RARITY_LABEL = { N: '普通', R: '稀有', SR: '史詩', SSR: '傳說' };
const RARITY_COLOR = { N: 0x99aab5, R: 0x3498db, SR: 0x9b59b6, SSR: 0xf1c40f };
// 道具的幸運值只加成 R 以上，避免高階道具反而抽到一堆 N
const LUCK_SCALE = { N: 0, R: 0.5, SR: 1, SSR: 1.5 };

// 台北時區的今天（每日次數上限用）。一律走 util/time，全站同一個時區來源。
const { localToday, localWeekStart, endOfLocalDayMs } = require('../../util/time');
const today = () => localToday();
// 經濟調小倍率：預設售價/獎勵/花費一律 ÷5（2026-07-26 重度變慢；現有資料已用腳本同步）
const PRICE_DIV = 5;

// ---- 錢包 ----
function wallet(gid, userId, username) {
  let w = db.prepare('SELECT * FROM econ_wallets WHERE guild_id=? AND user_id=?').get(gid, userId);
  if (!w) {
    db.prepare('INSERT INTO econ_wallets (guild_id, user_id, username, coins) VALUES (?,?,?,?)')
      .run(gid, userId, username || '', cfg(gid).start_coins || 0);
    w = db.prepare('SELECT * FROM econ_wallets WHERE guild_id=? AND user_id=?').get(gid, userId);
  } else if (username && w.username !== username) {
    db.prepare('UPDATE econ_wallets SET username=? WHERE guild_id=? AND user_id=?').run(username, gid, userId);
  }
  return w;
}
function addCoins(gid, userId, username, delta) {
  wallet(gid, userId, username);
  db.prepare(
    `UPDATE econ_wallets SET coins = coins + ?, total_earned = total_earned + ?,
       updated_at = datetime('now','localtime') WHERE guild_id=? AND user_id=?`
  ).run(delta, Math.max(0, delta), gid, userId);
  return wallet(gid, userId, username).coins;
}
const money = (c, n) => `${c.currency_emoji || '🪙'} ${n.toLocaleString('en-US')} ${c.currency_name || '星幣'}`;

// ---- 預設內容：新伺服器第一次用就有東西可玩，不必先去後台建資料 ----
// 權重配平：同種類加總 1000，基礎機率約 N 70% / R 22% / SR 6.5% / SSR 1.5%
const SEED_ITEMS = [
  // 釣魚
  ['fish', '小魚', '🐟', 'N', 250, 8], ['fish', '吳郭魚', '🐠', 'N', 200, 10],
  ['fish', '海草', '🌿', 'N', 150, 3], ['fish', '破靴子', '🥾', 'N', 100, 1],
  ['fish', '章魚', '🐙', 'R', 90, 45], ['fish', '河豚', '🐡', 'R', 70, 55],
  ['fish', '螃蟹', '🦀', 'R', 60, 60], ['fish', '龍蝦', '🦞', 'SR', 40, 220],
  ['fish', '鯊魚', '🦈', 'SR', 25, 320], ['fish', '鯨魚', '🐋', 'SSR', 11, 1200],
  ['fish', '美人魚', '🧜', 'SSR', 4, 2500],
  // 挖礦
  ['mine', '碎石', '🪨', 'N', 250, 5], ['mine', '煤炭', '🖤', 'N', 250, 9],
  ['mine', '黏土', '🧱', 'N', 200, 6], ['mine', '鐵礦', '⛓️', 'R', 130, 48],
  ['mine', '銀礦', '🪙', 'R', 90, 65], ['mine', '金礦', '🥇', 'SR', 40, 240],
  ['mine', '綠寶石', '💚', 'SR', 25, 300], ['mine', '鑽石', '💎', 'SSR', 11, 1300],
  ['mine', '隕石', '☄️', 'SSR', 4, 2800],
  // 伐木
  ['wood', '樹枝', '🌿', 'N', 250, 4], ['wood', '松木', '🪵', 'N', 250, 9],
  ['wood', '橡木', '🌳', 'N', 200, 12], ['wood', '楓木', '🍁', 'R', 130, 50],
  ['wood', '檜木', '🌲', 'R', 90, 70], ['wood', '黑檀木', '🪵', 'SR', 40, 250],
  ['wood', '千年神木', '🌳', 'SR', 25, 330], ['wood', '世界樹枝', '🌟', 'SSR', 11, 1400],
  ['wood', '月光木', '🌙', 'SSR', 4, 2600],
  // 採集
  ['forage', '野草', '🌱', 'N', 250, 3], ['forage', '蘑菇', '🍄', 'N', 250, 10],
  ['forage', '莓果', '🫐', 'N', 200, 14], ['forage', '蜂蜜', '🍯', 'R', 130, 52],
  ['forage', '藥草', '🌾', 'R', 90, 68], ['forage', '松露', '🍄', 'SR', 40, 260],
  ['forage', '曼陀羅', '🌺', 'SR', 25, 310], ['forage', '四葉幸運草', '🍀', 'SSR', 11, 1250],
  ['forage', '星辰花', '✨', 'SSR', 4, 2700],
  // 狩獵
  ['hunt', '野兔', '🐰', 'N', 250, 12], ['hunt', '山雞', '🐓', 'N', 250, 10],
  ['hunt', '松鼠', '🐿️', 'N', 200, 7], ['hunt', '野豬', '🐗', 'R', 130, 55],
  ['hunt', '鹿', '🦌', 'R', 90, 72], ['hunt', '棕熊', '🐻', 'SR', 40, 270],
  ['hunt', '白狼', '🐺', 'SR', 25, 340], ['hunt', '幼龍', '🐉', 'SSR', 11, 1500],
  ['hunt', '獨角獸', '🦄', 'SSR', 4, 3000],
  ['hunt', '野鳥蛋', '🥚', 'R', 70, 40],   // 可用 /孵化 孵成雞（撿蛋入門用）
  // 2026-07-27 擴充：每類再各加 4 種（價格是 ÷PRICE_DIV 前的原價）
  ['fish', '水母', '🪼', 'N', 120, 20], ['fish', '鰻魚', '🐍', 'R', 80, 50],
  ['fish', '旗魚', '🗡️', 'SR', 30, 280], ['fish', '皇帶魚', '🐉', 'SSR', 6, 1800],
  ['mine', '硫磺', '🟡', 'N', 180, 35], ['mine', '黑曜石', '⬛', 'R', 100, 50],
  ['mine', '水晶', '🔮', 'SR', 30, 260], ['mine', '星辰礦', '🌟', 'SSR', 7, 1500],
  ['wood', '竹子', '🎋', 'N', 200, 20], ['wood', '櫻花木', '🌸', 'R', 90, 55],
  ['wood', '紫檀木', '🟣', 'SR', 28, 290], ['wood', '龍血木', '🩸', 'SSR', 6, 1650],
  ['forage', '蕨葉', '🌿', 'N', 200, 15], ['forage', '山葵', '🥬', 'R', 90, 60],
  ['forage', '靈芝', '🍄', 'SR', 30, 300], ['forage', '龍膽花', '💜', 'SSR', 6, 1700],
  ['hunt', '野鴨', '🦆', 'N', 200, 25], ['hunt', '山羌', '🦌', 'R', 90, 65],
  ['hunt', '黑豹', '🐆', 'SR', 28, 310], ['hunt', '鳳凰羽', '🪶', 'SSR', 5, 1900]
];
const SEED_TOOLS = [
  ['fish', '木製釣竿', '🎣', 1, 0, 0, 0, '最基本的釣竿，人人都有'],
  ['fish', '碳纖釣竿', '🎣', 2, 800, 25, 10, '稀有度加成 25%、冷卻縮短 10%'],
  ['fish', '傳說釣竿', '🌟', 3, 4000, 60, 25, '稀有度加成 60%、冷卻縮短 25%'],
  ['mine', '木鎬', '⛏️', 1, 0, 0, 0, '最基本的鎬子，人人都有'],
  ['mine', '鐵鎬', '⛏️', 2, 800, 25, 10, '稀有度加成 25%、冷卻縮短 10%'],
  ['mine', '鑽石鎬', '💠', 3, 4000, 60, 25, '稀有度加成 60%、冷卻縮短 25%'],
  ['wood', '石斧', '🪓', 1, 0, 0, 0, '最基本的斧頭，人人都有'],
  ['wood', '鋼斧', '🪓', 2, 800, 25, 10, '稀有度加成 25%、冷卻縮短 10%'],
  ['wood', '秘銀斧', '⚡', 3, 4000, 60, 25, '稀有度加成 60%、冷卻縮短 25%'],
  ['forage', '草籃', '🧺', 1, 0, 0, 0, '最基本的籃子，人人都有'],
  ['forage', '藤編籃', '🧺', 2, 800, 25, 10, '稀有度加成 25%、冷卻縮短 10%'],
  ['forage', '精靈之籃', '🌸', 3, 4000, 60, 25, '稀有度加成 60%、冷卻縮短 25%'],
  ['hunt', '木弓', '🏹', 1, 0, 0, 0, '最基本的弓，人人都有'],
  ['hunt', '複合弓', '🏹', 2, 800, 25, 10, '稀有度加成 25%、冷卻縮短 10%'],
  ['hunt', '獵神之弓', '🔱', 3, 4000, 60, 25, '稀有度加成 60%、冷卻縮短 25%']
];

// 預設地圖：[名稱, emoji, 每日次數, 幸運%, 預設, 排序, 說明]
const SEED_MAPS = [
  ['新手草原', '🌾', 10, 0, 1, 0, '最安全的採集地，每天可採 10 次'],
  ['幽暗森林', '🌲', 6, 25, 0, 1, '次數較少，但稀有率 +25%'],
  ['遠古秘境', '🏔️', 3, 60, 0, 2, '每天只能 3 次，稀有率大幅 +60%']
];
function seedMaps(gid) {
  try {
    if (db.prepare('SELECT 1 FROM gather_maps WHERE guild_id=? LIMIT 1').get(gid)) return;
    const ins = db.prepare('INSERT INTO gather_maps (guild_id,name,emoji,daily_limit,luck_bonus,is_default,sort,description) VALUES (?,?,?,?,?,?,?,?)');
    const tx = db.transaction(() => { for (const m of SEED_MAPS) ins.run(gid, ...m); });
    tx();
  } catch (e) { logError(gid, '地圖預設建立失敗：', e.message); }
}
// 預設抽籤獎池：[名稱, emoji, 類型, 星幣, 幸運%, 權重, 排序]
// 後台（釣魚挖礦頁 → 每日抽籤獎池）可改；這裡只在該伺服器完全沒獎項時灌一次。
const SEED_PRIZES = [
  ['銅獎', '🥉', 'coin', 10, 0, 34, 0],
  ['銀獎', '🥈', 'coin', 25, 0, 26, 1],
  ['金獎', '🥇', 'coin', 60, 0, 14, 2],
  ['幸運符', '🍀', 'luck', 0, 20, 14, 3],
  ['幸運星', '🌟', 'luck', 0, 40, 8, 4],
  ['頭獎', '🎰', 'jackpot', 120, 60, 4, 5]
];
function seedPrizes(gid) {
  try {
    if (db.prepare('SELECT 1 FROM lottery_prizes WHERE guild_id=? LIMIT 1').get(gid)) return;
    const ins = db.prepare('INSERT INTO lottery_prizes (guild_id,name,emoji,type,amount,pct,weight,sort) VALUES (?,?,?,?,?,?,?,?)');
    const tx = db.transaction(() => { for (const p of SEED_PRIZES) ins.run(gid, ...p); });
    tx();
  } catch (e) { logError(gid, '抽籤獎池預設建立失敗：', e.message); }
}
// 目前有效的獎池（全被停用或刪光時，退回預設獎池，避免 /抽籤 直接壞掉）
function prizePool(gid) {
  const rows = db.prepare('SELECT * FROM lottery_prizes WHERE guild_id=? AND enabled=1 AND weight>0 ORDER BY sort, id').all(gid);
  if (rows.length) return rows;
  return SEED_PRIZES.map(([name, emoji, type, amount, pct, weight]) => ({ name, emoji, type, amount, pct, weight }));
}
// 玩家目前的地圖（沒選過就用預設地圖；完全沒地圖回 null，代表沿用舊的 config 每日上限）
function activeMap(gid, userId) {
  const picked = db.prepare('SELECT map_id FROM gather_user_map WHERE guild_id=? AND user_id=?').get(gid, userId);
  if (picked) {
    const m = db.prepare('SELECT * FROM gather_maps WHERE id=? AND guild_id=? AND enabled=1').get(picked.map_id, gid);
    if (m) return m;
  }
  return db.prepare('SELECT * FROM gather_maps WHERE guild_id=? AND enabled=1 ORDER BY is_default DESC, sort, id LIMIT 1').get(gid) || null;
}
// 今天（台北）已採集的總次數（跨所有種類），供地圖的每日總次數上限用
function totalGathersToday(gid, userId) {
  return db.prepare("SELECT COALESCE(SUM(day_count),0) n FROM gather_cooldowns WHERE guild_id=? AND user_id=? AND day=?").get(gid, userId, today()).n;
}


// ---- 後來補的基礎素材 ----
// 每種採集本來只有 3～5 種 N 級素材，蓋房子／做家具的材料壓力都集中在碎石、松木那幾樣。
// 這一批走「逐項補齊」而不是 seedGuild 的「這個 kind 有東西就整批跳過」，
// 所以既有伺服器也會拿到（新增素材時直接往這裡加一行就好）。
// [kind, 名稱, emoji, 稀有度, 權重, 售價(未除 PRICE_DIV)]
const SEED_MATERIALS = [
  ['mine', '砂礫', '⏳', 'N', 230, 4], ['mine', '石灰岩', '🧱', 'N', 200, 6],
  ['mine', '石英', '⚪', 'N', 190, 9], ['mine', '錫礦', '🥫', 'N', 170, 13],
  ['wood', '木屑', '🍂', 'N', 240, 3], ['wood', '樹皮', '🟤', 'N', 220, 5],
  ['wood', '松脂', '🟠', 'N', 190, 9], ['wood', '藤蔓', '🌿', 'N', 180, 11],
  ['forage', '苔蘚', '🍃', 'N', 230, 4], ['forage', '蘆葦', '🌾', 'N', 210, 6],
  ['forage', '野花', '🌼', 'N', 195, 8], ['forage', '堅果', '🌰', 'N', 175, 12],
  ['hunt', '羽毛', '🪶', 'N', 230, 4], ['hunt', '骨頭', '🦴', 'N', 205, 7],
  ['hunt', '獸皮', '🟫', 'N', 180, 13], ['hunt', '鹿角', '🦌', 'N', 160, 16],
  ['fish', '海帶', '🌊', 'N', 215, 3], ['fish', '貝殼', '🐚', 'N', 200, 5],
  ['fish', '河蜆', '🦪', 'N', 185, 8], ['fish', '珊瑚枝', '🪸', 'N', 165, 14]
];

function seedMaterials(gid) {
  try {
    const has = db.prepare('SELECT 1 FROM gather_items WHERE guild_id=? AND kind=? AND name=?');
    const ins = db.prepare('INSERT INTO gather_items (guild_id,kind,name,emoji,rarity,weight,price) VALUES (?,?,?,?,?,?,?)');
    db.transaction(() => {
      for (const [kind, name, emoji, rar, weight, price] of SEED_MATERIALS) {
        if (has.get(gid, kind, name)) continue;
        ins.run(gid, kind, name, emoji, rar, weight, Math.max(1, Math.round(price / PRICE_DIV)));
      }
    })();
  } catch (e) { logError(gid, '基礎素材補齊失敗：', e.message); }
}


// ---- 大師級工具（T4）與禮物工藝品 ----
// 動機：中高階木材（楓木／櫻花木／檜木／黑檀木…）以前只有蓋房子跟少數家具會用，
// 中期玩家囤一堆只能賣掉。這裡開兩條出海口：
//   ① T4 工具：稀有度加成 100%、冷卻縮短 40%，材料吃高階木＋高階礦
//   ② 禮物工藝品：木雕與花束，專門拿去送角色（好感度給得比一般物品高很多）
// [kind, 名稱, emoji, tier, 售價(未除 PRICE_DIV), luck, cooldown_cut, 說明]
const SEED_TOOLS_T4 = [
  ['fish', '深海王者竿', '🔱', 4, 60000, 100, 40, '稀有度加成 100%、冷卻縮短 40%'],
  ['mine', '星辰礦鎬', '🌠', 4, 60000, 100, 40, '稀有度加成 100%、冷卻縮短 40%'],
  ['wood', '神木伐斧', '🌳', 4, 60000, 100, 40, '稀有度加成 100%、冷卻縮短 40%'],
  ['forage', '月光提籃', '🌙', 4, 60000, 100, 40, '稀有度加成 100%、冷卻縮短 40%'],
  ['hunt', '龍骨獵弓', '🐉', 4, 60000, 100, 40, '稀有度加成 100%、冷卻縮短 40%']
];
// T4 的鍛造材料：每一把都吃大量高階木材（這才是重點），再配該類的 SSR 素材
const T4_MATS = {
  fish:   [['檜木', 40], ['黑檀木', 20], ['水晶', 10], ['鯨魚', 2]],
  mine:   [['楓木', 40], ['紫檀木', 20], ['鑽石', 5], ['星辰礦', 5]],
  wood:   [['千年神木', 25], ['櫻花木', 40], ['金礦', 15], ['世界樹枝', 3]],
  forage: [['櫻花木', 40], ['檜木', 25], ['靈芝', 10], ['四葉幸運草', 2]],
  hunt:   [['黑檀木', 35], ['楓木', 30], ['銀礦', 20], ['幼龍', 2]]
};
// 禮物工藝品：[名稱, emoji, 售價(未除 PRICE_DIV), 材料, 說明]
const SEED_GIFTS = [
  ['木雕小鹿', '🦌', 900, [['楓木', 15], ['樹皮', 10]], '手工木雕，角色收到都會愣一下'],
  ['櫻花木梳', '🌸', 1400, [['櫻花木', 12], ['松脂', 6]], '梳齒磨得很細，帶著淡淡花香'],
  ['檜木香盒', '🪵', 2000, [['檜木', 15], ['松脂', 10], ['蜂蜜', 5]], '打開就是一整座山的味道'],
  ['四季花束', '💐', 2600, [['玫瑰', 5], ['百合', 4], ['鬱金香', 4], ['藤蔓', 6]], '沒有人收到花束會不開心'],
  ['星光花冠', '👑', 6000, [['月光花', 3], ['星辰花', 2], ['櫻花', 6], ['銀礦', 10]], '戴上去的人會發光（真的）'],
  ['神木護符', '🧿', 12000, [['世界樹枝', 3], ['千年神木', 10], ['水晶', 8]], '據說能擋一次災厄']
];

function seedToolsT4AndGifts(gid) {
  try {
    const itemId = (name) => (db.prepare('SELECT id FROM gather_items WHERE guild_id=? AND name=?').get(gid, name) || {}).id;
    const toMats = (list) => list.map(([item, count]) => ({ item_id: itemId(item), count })).filter(m => m.item_id);

    db.transaction(() => {
      // ① T4 工具（逐把補齊，既有伺服器也拿得到）
      const hasTool = db.prepare('SELECT id FROM gather_tools WHERE guild_id=? AND kind=? AND name=?');
      const insTool = db.prepare('INSERT INTO gather_tools (guild_id,kind,name,emoji,tier,price,luck,cooldown_cut,description) VALUES (?,?,?,?,?,?,?,?,?)');
      const insRec = db.prepare(
        `INSERT INTO gather_recipes (guild_id,kind,name,emoji,result_type,result_id,result_count,materials,cost,success_rate,fail_keep,description,enabled)
         VALUES (?, 'craft', ?, ?, ?, ?, 1, ?, ?, ?, 0, ?, 1)`);
      for (const [kind, name, emoji, tier, price, luck, cut, desc] of SEED_TOOLS_T4) {
        let row = hasTool.get(gid, kind, name);
        if (!row) {
          const r = insTool.run(gid, kind, name, emoji, tier, Math.max(1, Math.round(price / PRICE_DIV)), luck, cut, desc);
          row = { id: r.lastInsertRowid };
        }
        const hasRec = db.prepare("SELECT 1 FROM gather_recipes WHERE guild_id=? AND result_type='tool' AND result_id=?").get(gid, row.id);
        const mats = toMats(T4_MATS[kind] || []);
        if (!hasRec && mats.length >= 3) {
          insRec.run(gid, name, emoji, 'tool', row.id, JSON.stringify(mats), 5000, 60,
            `大師級工具：材料吃重（大量高階木材），有 40% 失敗率，但一把抵三把`);
        }
      }

      // ② 禮物工藝品：先建物品（kind='craft'，不會出現在採集掉落池），再建製作配方
      const hasItem = db.prepare('SELECT id FROM gather_items WHERE guild_id=? AND name=?');
      const insItem = db.prepare("INSERT INTO gather_items (guild_id,kind,name,emoji,rarity,weight,price) VALUES (?,'craft',?,?,'SR',0,?)");
      for (const [name, emoji, price, matList, desc] of SEED_GIFTS) {
        let it = hasItem.get(gid, name);
        if (!it) {
          const r = insItem.run(gid, name, emoji, Math.max(1, Math.round(price / PRICE_DIV)));
          it = { id: r.lastInsertRowid };
        }
        const hasRec = db.prepare("SELECT 1 FROM gather_recipes WHERE guild_id=? AND result_type='item' AND result_id=?").get(gid, it.id);
        const mats = toMats(matList);
        if (!hasRec && mats.length) {
          insRec.run(gid, name, emoji, 'item', it.id, JSON.stringify(mats), 0, 100, `${desc}（拿去 \`/送禮\` 給角色，好感度加得特別多）`);
        }
      }
    })();
  } catch (e) { logError(gid, '大師工具／禮物工藝品建立失敗：', e.message); }
}

function seedGuild(gid) {
  cfg(gid);
  seedMaps(gid);
  seedPrizes(gid);
  // 逐「種類」補資料，而不是一個 seeded 旗標擋掉全部 —— 這樣之後新增採集種類時，
  // 已經在跑的伺服器也會自動拿到新內容，不用手動灌或重置。
  const tx = db.transaction(() => {
    const itStmt = db.prepare('INSERT INTO gather_items (guild_id,kind,name,emoji,rarity,weight,price) VALUES (?,?,?,?,?,?,?)');
    const tlStmt = db.prepare('INSERT INTO gather_tools (guild_id,kind,name,emoji,tier,price,luck,cooldown_cut,description) VALUES (?,?,?,?,?,?,?,?,?)');
    for (const kind of Object.keys(KIND_NAME)) {
      const hasItems = db.prepare('SELECT 1 FROM gather_items WHERE guild_id=? AND kind=? LIMIT 1').get(gid, kind);
      // 經濟調小：預設售價一律 ÷PRICE_DIV（現有伺服器已用一次性腳本同步下修）
      if (!hasItems) for (const r of SEED_ITEMS.filter(x => x[0] === kind)) {
        const rr = [...r]; rr[5] = Math.max(1, Math.round(rr[5] / PRICE_DIV)); itStmt.run(gid, ...rr);
      }
      const hasTools = db.prepare('SELECT 1 FROM gather_tools WHERE guild_id=? AND kind=? LIMIT 1').get(gid, kind);
      if (!hasTools) for (const r of SEED_TOOLS.filter(x => x[0] === kind)) {
        const rr = [...r]; if (rr[4] > 0) rr[4] = Math.max(1, Math.round(rr[4] / PRICE_DIV)); tlStmt.run(gid, ...rr);
      }
    }
    // 初階(tier1)工具：一開始每人自動免費一把（壞前不用錢），用壞後 /修理 要 50 星幣。
    // 只在仍是預設值（管理員沒改過）時套用，避免每次開機覆蓋自訂設定。
    db.prepare("UPDATE gather_tools SET price=100, durability=40, repair_cost=100 WHERE guild_id=? AND tier=1 AND price=0 AND repair_cost=0").run(gid);
    db.prepare('UPDATE gather_config SET seeded=1 WHERE guild_id=?').run(gid);
  });
  try { tx(); } catch (e) { logError(gid, '釣魚挖礦預設內容建立失敗：', e.message); }
  seedMaterials(gid);
  seedRecipesAndQuests(gid);
  seedToolsT4AndGifts(gid);   // 要在 seedToolRecipes 之前：T4 用專屬的高階木材配方，不要被通用配方蓋過去
  seedToolRecipes(gid);   // 每把 T2/T3 工具都自動有鍛造配方
}

// 預設配方與任務：讓管理員一開後台就有範例可以照著改，不必從零想
function seedRecipesAndQuests(gid) {
  try {
    const byName = (kind, name) => db.prepare('SELECT id FROM gather_items WHERE guild_id=? AND kind=? AND name=?').get(gid, kind, name);
    const toolByName = (kind, name) => db.prepare('SELECT id FROM gather_tools WHERE guild_id=? AND kind=? AND name=?').get(gid, kind, name);

    if (!db.prepare('SELECT 1 FROM gather_recipes WHERE guild_id=? LIMIT 1').get(gid)) {
      const iron = byName('mine', '鐵礦'), oak = byName('wood', '橡木'), coal = byName('mine', '煤炭');
      const gold = byName('mine', '金礦'), ebony = byName('wood', '黑檀木');
      const ins = db.prepare(
        `INSERT INTO gather_recipes (guild_id,kind,name,emoji,result_type,result_id,result_count,materials,cost,success_rate,fail_keep,description)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
      if (iron && oak && coal && toolByName('mine', '鐵鎬')) {
        ins.run(gid, 'forge', '鐵鎬', '⛏️', 'tool', toolByName('mine', '鐵鎬').id, 1,
          JSON.stringify([{ item_id: iron.id, count: 5 }, { item_id: oak.id, count: 3 }, { item_id: coal.id, count: 2 }]),
          40, 80, 0, '自己打一把鐵鎬，比商店便宜但有失敗率');
      }
      if (gold && ebony && toolByName('wood', '秘銀斧')) {
        ins.run(gid, 'forge', '秘銀斧', '⚡', 'tool', toolByName('wood', '秘銀斧').id, 1,
          JSON.stringify([{ item_id: gold.id, count: 4 }, { item_id: ebony.id, count: 4 }]),
          160, 60, 0, '高風險高報酬，失敗會損失材料');
      }
      // 用製作開農地/溫室的格子
      const pine = byName('wood', '松木'), stone = byName('mine', '碎石'), silver = byName('mine', '銀礦');
      if (pine && stone) {
        ins.run(gid, 'craft', '開闢農地（+1 格）', '🌾', 'plot_field', 0, 1,
          JSON.stringify([{ item_id: pine.id, count: 8 }, { item_id: stone.id, count: 6 }]),
          0, 100, 0, '農地 +1 格（沒有階級與加成，想要加成請去 /設施商店）');
      }
      if (oak && silver && stone) {
        ins.run(gid, 'craft', '搭建溫室（+1 格）', '🏡', 'plot_greenhouse', 0, 1,
          JSON.stringify([{ item_id: oak.id, count: 10 }, { item_id: silver.id, count: 4 }, { item_id: stone.id, count: 12 }]),
          0, 100, 0, '溫室 +1 格（沒有階級與加成，想要加成請去 /設施商店）');
      }
      // 用製作開牧場/孵化室的格子
      const oak2 = byName('wood', '橡木'), iron2 = byName('mine', '鐵礦'), branch = byName('wood', '樹枝');
      if (oak2 && stone) {
        ins.run(gid, 'craft', '蓋牧場（+1 格）', '🐔', 'plot_ranch', 0, 1,
          JSON.stringify([{ item_id: oak2.id, count: 6 }, { item_id: stone.id, count: 4 }]),
          0, 100, 0, '牧場 +1 格（沒有階級與加成，想要加成請去 /設施商店）');
      }
      if (branch && iron2) {
        ins.run(gid, 'craft', '蓋孵化室（+1 格）', '🥚', 'plot_hatch', 0, 1,
          JSON.stringify([{ item_id: branch.id, count: 8 }, { item_id: iron2.id, count: 3 }]),
          0, 100, 0, '孵化室 +1 格（沒有階級與加成，想要加成請去 /設施商店）');
      }
    }

    if (!db.prepare('SELECT 1 FROM quests WHERE guild_id=? LIMIT 1').get(gid)) {
      const q = db.prepare(
        `INSERT INTO quests (guild_id,name,description,period,goal_type,goal_kind,goal_rarity,goal_count,reward_coins)
         VALUES (?,?,?,?,?,?,?,?,?)`);
      q.run(gid, '每日勤勞', '今天完成 10 次任意採集活動', 'daily', 'gather', '', '', 10, 60);
      q.run(gid, '釣魚新手', '今天釣魚 5 次', 'daily', 'gather', 'fish', '', 5, 30);
      q.run(gid, '尋寶獵人', '本週抽到 3 個 SR 以上的物品', 'weekly', 'rarity', '', 'SR', 3, 200);
      q.run(gid, '工匠之路', '本週製作 5 次', 'weekly', 'craft', '', '', 5, 160);
    }
  } catch (e) { logError(gid, '預設配方/任務建立失敗：', e.message); }
}

// 幫「每一把 T2/T3 工具」自動建一個鍛造配方（沒有的才補），讓所有工具都能製作。
// 逐把檢查、冪等：既有工具/新加的工具、既有伺服器都會自動補上。
// 合併同一材料的多筆數量（item_id 相同就把 count 加總），避免配方裡同一材料出現兩次
function mergeMats(mats) {
  const map = new Map();
  for (const m of (mats || [])) {
    if (!m || !m.item_id) continue;
    map.set(m.item_id, (map.get(m.item_id) || 0) + (m.count || 0));
  }
  return [...map].map(([item_id, count]) => ({ item_id, count }));
}

function seedToolRecipes(gid) {
  try {
    const tools = db.prepare('SELECT * FROM gather_tools WHERE guild_id=? AND enabled=1 AND tier>=2').all(gid);
    if (!tools.length) return;
    const byName = (kind, name) => db.prepare('SELECT id FROM gather_items WHERE guild_id=? AND kind=? AND name=?').get(gid, kind, name);
    const byRarity = (kind, rarity) => db.prepare("SELECT id FROM gather_items WHERE guild_id=? AND kind=? AND rarity=? AND enabled=1 ORDER BY price LIMIT 1").get(gid, kind, rarity);
    const pine = byName('wood', '松木'), stone = byName('mine', '碎石'), iron = byName('mine', '鐵礦'), silver = byName('mine', '銀礦'), gold = byName('mine', '金礦');
    const ins = db.prepare(
      `INSERT INTO gather_recipes (guild_id,kind,name,emoji,result_type,result_id,result_count,materials,cost,success_rate,fail_keep,description,enabled)
       VALUES (?, 'craft', ?, ?, 'tool', ?, 1, ?, ?, ?, 0, ?, 1)`);
    for (const t of tools) {
      const has = db.prepare("SELECT 1 FROM gather_recipes WHERE guild_id=? AND result_type='tool' AND result_id=?").get(gid, t.id);
      if (has) continue;   // 已有產出這把工具的配方（含手動/預設的）就不重複
      const kR = byRarity(t.kind, 'R'), kSR = byRarity(t.kind, 'SR');
      let mats;
      if (t.tier >= 3) {
        mats = [iron && { item_id: iron.id, count: 5 }, silver && { item_id: silver.id, count: 3 }, gold && { item_id: gold.id, count: 2 }, kSR && { item_id: kSR.id, count: 3 }].filter(Boolean);
      } else {
        mats = [pine && { item_id: pine.id, count: 5 }, stone && { item_id: stone.id, count: 5 }, kR && { item_id: kR.id, count: 3 }].filter(Boolean);
      }
      mats = mergeMats(mats);   // 合併重複材料（例：礦類工具的 SR 材料就是金礦，避免金礦列兩次）
      if (mats.length < 2) continue;   // 材料湊不齊就先略過
      const cost = Math.max(0, Math.round((t.price || 0) * 0.3));
      ins.run(gid, t.name, t.emoji || '🔨', t.id, JSON.stringify(mats), cost, t.tier >= 3 ? 70 : 90,
        `用材料鍛造 ${t.name}（比商店省，但${t.tier >= 3 ? '有失敗率' : '偶爾失敗'}）`);
    }
  } catch (e) { logError(gid, '工具鍛造配方建立失敗：', e.message); }
}

const BARE_HANDS = { name: '徒手', emoji: '✋', tier: 0, luck: 0, cooldown_cut: 0, durability: 0 };
// ---- 玩家目前使用的道具：擁有且沒壞的最高階 → 免費起始工具 → 徒手（全壞時的保底）----
function currentTool(gid, userId, kind) {
  // 擁有且「沒壞」的最高階（durability<=0 表示不會壞；durability>0 需 uses_left>0）
  const owned = db.prepare(
    `SELECT t.*, u.uses_left FROM gather_tools t JOIN gather_user_tools u ON u.tool_id = t.id
      WHERE t.guild_id=? AND t.kind=? AND u.guild_id=? AND u.user_id=? AND t.enabled=1
        AND (t.durability<=0 OR u.uses_left>0)
      ORDER BY t.tier DESC LIMIT 1`
  ).get(gid, kind, gid, userId);
  if (owned) return owned;
  // 沒有可用的擁有工具 → 免費基礎工具（tier1）
  const base = db.prepare('SELECT * FROM gather_tools WHERE guild_id=? AND kind=? AND enabled=1 ORDER BY tier ASC LIMIT 1').get(gid, kind);
  if (!base) return BARE_HANDS;
  if (base.durability <= 0) return base;   // 免費工具設定為不會壞
  // 免費工具有耐久：查玩家的耐久紀錄
  const rec = db.prepare('SELECT uses_left FROM gather_user_tools WHERE guild_id=? AND user_id=? AND tool_id=?').get(gid, userId, base.id);
  if (!rec) return { ...base, uses_left: base.durability };   // 還沒用過＝滿耐久
  if (rec.uses_left > 0) return { ...base, uses_left: rec.uses_left };
  // 免費工具也壞了：若玩家餘額是負數（欠債），系統免費補一把最基本的，
  // 避免「負債→沒工具→不能採集→賺不到錢還債」的死結。正常玩家（餘額≥0）維持原樣，壞了要自己修。
  const bal = (db.prepare('SELECT coins FROM econ_wallets WHERE guild_id=? AND user_id=?').get(gid, userId) || {}).coins ?? 0;
  if (bal < 0) return { ...base, uses_left: base.durability };
  return BARE_HANDS;   // 餘額正常又不修 → 徒手（被 require_tool 擋）
}
// 免費工具（售價 0）修理免費；其餘＝售價一半（可在後台自訂 repair_cost）
const repairCostOf = (t) => (t.repair_cost > 0 ? t.repair_cost : Math.ceil((t.price || 0) / 2));

// ---- 幸運加成（每日抽籤的幸運符）：回傳目前有效的額外幸運 %，過期自動視為 0 ----
function activeLuck(gid, userId) {
  const row = db.prepare('SELECT pct, expire_at FROM luck_buffs WHERE guild_id=? AND user_id=?').get(gid, userId);
  return row && row.expire_at > Date.now() ? row.pct : 0;
}
// 台北時區「今天結束」的 unix 毫秒（幸運符當日有效）
function endOfTodayMs() {
  return endOfLocalDayMs();
}

// ---- 抽掉落：先照權重挑，道具的幸運值只放大 R 以上的權重 ----
//
// 稱號／寵物／家具的加成也在這裡生效（以前這些 buff 只是存著、對掉落完全沒作用）：
//   稀有加成（fish_rare_pct/mine_rare_pct/…）放大 SR 以上的權重 ——「更容易挖到鑽石」
//   mine_common_pct 放大礦物的 N 級（碎石、黏土、煤炭）——「更容易挖到碎石」
//   mat_pct 放大所有 N／R 素材 ——「打材料的人專用」
// 都是改權重、不是保證，所以不會出現「掛上稱號就必中」。
const RARE_BUFF = { fish: 'fish_rare_pct', mine: 'mine_rare_pct', forage: 'forage_rare_pct', hunt: 'hunt_rare_pct' };

function rollItem(gid, kind, luck, uid) {
  const items = db.prepare('SELECT * FROM gather_items WHERE guild_id=? AND kind=? AND enabled=1').all(gid, kind);
  if (!items.length) return null;
  const b = uid ? userBuffs(gid, uid) : {};
  const rarePct = b[RARE_BUFF[kind]] || 0;                 // 只吃這個種類自己的稀有加成
  const commonPct = kind === 'mine' ? (b.mine_common_pct || 0) : 0;
  const matPct = b.mat_pct || 0;
  const weighted = items.map(it => {
    const rar = it.rarity;
    let mul = 1 + (luck / 100) * (LUCK_SCALE[rar] ?? 0);
    if (rarePct && (rar === 'SR' || rar === 'SSR' || rar === 'UR')) mul *= 1 + rarePct / 100;
    if (commonPct && rar === 'N') mul *= 1 + commonPct / 100;
    if (matPct && (rar === 'N' || rar === 'R')) mul *= 1 + matPct / 100;
    return { it, w: Math.max(0, it.weight) * mul };
  });
  const total = weighted.reduce((a, x) => a + x.w, 0);
  if (total <= 0) return items[Math.floor(Math.random() * items.length)];
  let r = Math.random() * total;
  for (const x of weighted) { r -= x.w; if (r <= 0) return x.it; }
  return weighted[weighted.length - 1].it;
}

// ---- 每日採集點數（門票制）----
// 一天一池，不同地圖每次扣的點數不同：草原 1 點、森林 2 點、秘境 3 點。
// gather_config.daily_points = 0 時不啟用，沿用舊的「地圖每日次數」。
const pointsUsedToday = (gid, uid) =>
  (db.prepare('SELECT used FROM gather_points WHERE guild_id=? AND user_id=? AND day=?').get(gid, uid, today()) || {}).used || 0;
// 買來的體力（特殊商店賣的那個）。當天有效，跟每日點數同一池。
const pointsBonusToday = (gid, uid) =>
  (db.prepare('SELECT bonus FROM gather_points WHERE guild_id=? AND user_id=? AND day=?').get(gid, uid, today()) || {}).bonus || 0;
function bumpPoints(gid, uid, n) {
  db.prepare(
    `INSERT INTO gather_points (guild_id,user_id,day,used) VALUES (?,?,?,?)
     ON CONFLICT(guild_id,user_id,day) DO UPDATE SET used = used + ?`
  ).run(gid, uid, today(), n, n);
}
/** 加購體力：只加當天的額度。countAsBought=false 時不算進每日購買上限（例如活動補償） */
function addPointsBonus(gid, uid, n, countAsBought = true) {
  db.prepare(
    `INSERT INTO gather_points (guild_id,user_id,day,used,bonus,bought) VALUES (?,?,?,0,?,?)
     ON CONFLICT(guild_id,user_id,day) DO UPDATE SET bonus = bonus + ?, bought = bought + ?`
  ).run(gid, uid, today(), n, countAsBought ? n : 0, n, countAsBought ? n : 0);
}
/** 今天已經買了幾點體力（擋每日上限用） */
const staminaBoughtToday = (gid, uid) =>
  (db.prepare('SELECT bought FROM gather_points WHERE guild_id=? AND user_id=? AND day=?').get(gid, uid, today()) || {}).bought || 0;

/**
 * 今日體力（＝每日採集點數池）。
 * 採集、挖礦、逛街…全部共用這一池，這是刻意的：體力就是每天唯一的行動額度，
 * 而且**不吃任何加成** —— 家具寵物再多也不會讓你今天多逛幾條街，只能花錢買。
 */
function staminaState(gid, uid) {
  const c = cfg(gid);
  const base = Math.max(0, c.daily_points || 0);
  // 個別調整：管理員可以針對單一玩家永久 +N 點（例如他在別的活動達標）
  const extra = (db.prepare('SELECT stamina_bonus FROM player_limits WHERE guild_id=? AND user_id=?').get(gid, uid) || {}).stamina_bonus || 0;
  const bonus = pointsBonusToday(gid, uid);   // 今天買來的，明天就沒了
  const used = pointsUsedToday(gid, uid);
  const max = Math.max(0, base + extra + bonus);
  return { base, extra, bonus, used, max, left: Math.max(0, max - used) };
}
const mapCost = (map) => Math.max(1, (map && map.cost) || 1);

// ---- 冷卻 / 每日次數 ----
function checkCooldown(gid, userId, kind, seconds, dailyLimit) {
  const now = Date.now();
  const row = db.prepare('SELECT * FROM gather_cooldowns WHERE guild_id=? AND user_id=? AND kind=?').get(gid, userId, kind);
  const day = today();
  if (row && row.next_at > now) return { ok: false, wait: Math.ceil((row.next_at - now) / 1000) };
  const usedToday = row && row.day === day ? row.day_count : 0;
  if (dailyLimit > 0 && usedToday >= dailyLimit) return { ok: false, daily: true, limit: dailyLimit };
  return { ok: true, usedToday, day };
}
function markUsed(gid, userId, kind, seconds, day, usedToday) {
  db.prepare(
    `INSERT INTO gather_cooldowns (guild_id,user_id,kind,next_at,day,day_count) VALUES (?,?,?,?,?,?)
     ON CONFLICT(guild_id,user_id,kind) DO UPDATE SET next_at=excluded.next_at, day=excluded.day, day_count=excluded.day_count`
  ).run(gid, userId, kind, Date.now() + seconds * 1000, day, usedToday + 1);
}
const fmtWait = (s) => s >= 60 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${s} 秒`;

// ---- 背包 ----
function addToBag(gid, userId, itemId, n = 1) {
  db.prepare(
    `INSERT INTO gather_inventory (guild_id,user_id,item_id,count,total_caught) VALUES (?,?,?,?,?)
     ON CONFLICT(guild_id,user_id,item_id) DO UPDATE SET count = count + ?, total_caught = total_caught + ?`
  ).run(gid, userId, itemId, n, n, n, n);
  // 圖鑑：所有物品都會流經這裡（釣魚、挖礦、收成、偷竊、製作…），
  // 所以只要在這一點記一筆，圖鑑就會自動填滿，而且賣掉也不會消失。
  try {
    const it = db.prepare('SELECT kind, name FROM gather_items WHERE id=?').get(itemId);
    if (it) {
      // farm 類要再分農地／溫室，圖鑑才對得上；分不出來就歸農作
      let cat = it.kind;
      if (it.kind === 'farm') {
        const s = db.prepare('SELECT plot_type FROM crop_seeds WHERE guild_id=? AND product_item_id=?').get(gid, itemId);
        cat = s && s.plot_type === 'greenhouse' ? 'greenhouse' : 'crop';
      }
      db.prepare('INSERT OR IGNORE INTO dex_seen (guild_id,user_id,cat,key) VALUES (?,?,?,?)').run(gid, userId, cat, it.name);
    }
  } catch { /* 圖鑑記錄失敗不該影響到手的東西 */ }
}


// ---- 任務進度 ----
// 每日／每週要能自動重置，用「期間代碼」當 key：同一支任務在不同期間就是不同筆進度。
function periodKey(period) {
  if (period === 'once') return 'once';
  if (period === 'weekly') return 'W' + localWeekStart();   // 台北時間的本週一
  return localToday();
}

// 玩家做了某件事 → 推進所有符合條件的任務進度
//
// 成就統計也掛在這裡：這是全系統唯一「玩家做了什麼」都會經過的地方，
// 在每個功能各自埋計數器很容易漏，集中在這一支才不會有人漏記。
function bumpQuests(gid, userId, ev) {
  if (ev.type === 'gather' && ev.kind) bumpAch(gid, userId, 'gather_' + ev.kind, ev.amount || 1);
  else if (ev.type === 'craft') bumpAch(gid, userId, 'craft_count', ev.amount || 1);
  else if (ev.type === 'sell') bumpAch(gid, userId, 'sell_coins', ev.amount || 0);
  const list = db.prepare('SELECT * FROM quests WHERE guild_id=? AND enabled=1').all(gid);
  const done = [];
  for (const q of list) {
    if (q.goal_type !== ev.type) continue;
    if (q.goal_kind && q.goal_kind !== ev.kind) continue;
    if (q.goal_item && q.goal_item !== ev.itemId) continue;
    if (q.goal_rarity && q.goal_rarity !== ev.rarity) continue;
    const pk = periodKey(q.period);
    const row = db.prepare('SELECT * FROM quest_progress WHERE guild_id=? AND user_id=? AND quest_id=? AND period_key=?')
      .get(gid, userId, q.id, pk);
    if (row && row.progress >= q.goal_count) continue;      // 已達成就不再累加
    const next = (row ? row.progress : 0) + (ev.amount || 1);
    db.prepare(
      `INSERT INTO quest_progress (guild_id,user_id,quest_id,period_key,progress) VALUES (?,?,?,?,?)
       ON CONFLICT(guild_id,user_id,quest_id,period_key) DO UPDATE SET progress=?, updated_at=datetime('now','localtime')`
    ).run(gid, userId, q.id, pk, next, next);
    if (next >= q.goal_count) done.push(q);
  }
  if (done.length) bumpAch(gid, userId, 'quest_done', done.length);
  return done;
}

// ---- 配方：檢查材料是否足夠 ----
function readMaterials(recipe) {
  let mats = [];
  try { mats = JSON.parse(recipe.materials || '[]'); } catch {}
  return (Array.isArray(mats) ? mats : []).filter(m => m && m.item_id && m.count > 0);
}


// ---- 指令權限與顯示範圍 ----
// 三條規則的預設值：採集結果公開讓大家看得到戰績；其餘只給本人；富豪榜僅管理員。
const GATHER_CMDS = ['釣魚', '挖礦', '伐木', '採集', '狩獵'];
// 購買一件道具／一階設施。/購買 指令與商店的下拉選單共用同一套規則。
function buyThing(gid, uid, uname, kind, id) {
  const c = cfg(gid);
  if (kind === 'stamina') {
    const n = Math.max(1, Math.min(5, id));
    const price = Math.max(1, c.stamina_price || 10000);
    const dailyMax = Math.max(0, c.stamina_daily_max ?? 5);
    const bought = staminaBoughtToday(gid, uid);
    if (bought + n > dailyMax) {
      return { error: `體力每天最多買 **${dailyMax}** 點，你今天已經買了 ${bought} 點${dailyMax - bought > 0 ? `，最多還能買 ${dailyMax - bought} 點` : ''}。` };
    }
    const total = price * n;
    const w = wallet(gid, uid, uname);
    if (w.coins < total) return { error: `${c.currency_name}不夠：需要 ${total.toLocaleString('en-US')}，你只有 ${w.coins.toLocaleString('en-US')}。` };
    db.transaction(() => {
      addCoins(gid, uid, uname, -total);
      addPointsBonus(gid, uid, n);
    })();
    const st = staminaState(gid, uid);
    return { embed: new EmbedBuilder().setColor(0x9b59b6).setTitle('⚡ 體力補充完成')
      .setDescription(`花了 **${total.toLocaleString('en-US')} ${c.currency_name}** 買到 **${n}** 點體力。\n`
        + `今日體力：**${st.left} / ${st.max}** 點（買來的只有今天有效）\n`
        + `今天已買 ${bought + n}/${dailyMax} 點。`)
      .setFooter({ text: `餘額 ${(w.coins - total).toLocaleString('en-US')} ${c.currency_name}` }) };
  }
  if (kind === 'fac') {
    const fac = require('./facility');
    const r = fac.buy(gid, uid, uname, id);
    if (r.error) return { error: r.error };
    const t = fac.TYPES[r.def.type];
    return { embed: new EmbedBuilder().setColor(brandColor()).setTitle('🏗️ 擴建完成！')
      .setDescription(`${r.def.emoji || t.emoji} **${r.def.name}**（${r.def.tier} 階）蓋好了！\n` +
        `${t.emoji} ${t.name}現在共 **${r.def.slots} 格**${r.prevTier ? `（原本 ${r.prevTier} 階）` : ''}。` +
        `${r.def.speed_pct ? `\n⏩ ${r.def.type === 'hatch' ? '孵化' : r.def.type === 'ranch' ? '產出' : '成熟'}時間 **-${r.def.speed_pct}%**` : ''}` +
        `${r.def.resist_pct ? `\n🛡️ 別人來偷你的成功率 **-${r.def.resist_pct}%**` : ''}\n${t.hint}`)
      .setFooter({ text: `餘額 ${r.coins.toLocaleString('en-US')} ${c.currency_name}` }) };
  }
  const tool = db.prepare('SELECT * FROM gather_tools WHERE guild_id=? AND enabled=1 AND id=?').get(gid, id);
  if (!tool) return { error: '這個道具已經不存在了。' };
  if (db.prepare('SELECT 1 FROM gather_user_tools WHERE guild_id=? AND user_id=? AND tool_id=?').get(gid, uid, tool.id)) {
    return { error: `你已經有 **${tool.name}** 了。` };
  }
  const w = wallet(gid, uid, uname);
  if (w.coins < tool.price) {
    return { error: `${c.currency_name}不夠：需要 ${tool.price.toLocaleString('en-US')}，你只有 ${w.coins.toLocaleString('en-US')}。` };
  }
  const tx = db.transaction(() => {
    db.prepare('UPDATE econ_wallets SET coins = coins - ? WHERE guild_id=? AND user_id=?').run(tool.price, gid, uid);
    db.prepare('INSERT OR IGNORE INTO gather_user_tools (guild_id,user_id,tool_id,uses_left) VALUES (?,?,?,?)').run(gid, uid, tool.id, tool.durability || 0);
  });
  tx();
  return { embed: new EmbedBuilder().setColor(brandColor()).setTitle('購買成功')
    .setDescription(`${tool.emoji || ''} **${tool.name}** 已入手！\n幸運 +${tool.luck}%　冷卻 -${tool.cooldown_cut}%` +
      (tool.durability > 0 ? `　耐久 ${tool.durability}` : '') + `\n\n下次${KIND_NAME[tool.kind]}就會自動使用它。`)
    .setFooter({ text: `餘額 ${(w.coins - tool.price).toLocaleString('en-US')} ${c.currency_name}` }) };
}

// 執行一次（或多次）配方。/製作 /鍛造 指令與 /配方 的下拉選單共用同一套流程。
function craftRecipe(gid, uid, uname, recipeId, times = 1) {
  const c = cfg(gid);
  const r = db.prepare('SELECT * FROM gather_recipes WHERE guild_id=? AND enabled=1 AND id=?').get(gid, recipeId);
  if (!r) return { error: '這個配方已經不存在了。' };
  const label = r.kind === 'forge' ? '鍛造' : '製作';
  times = Math.min(10, Math.max(1, times));
  const mats = readMaterials(r);
  if (!mats.length) return { error: '這個配方還沒設定材料，請管理員補上。' };

  // 先確認材料與貨幣都夠做 times 次，不夠就整批不做（避免做到一半材料用光）
  const lack = [];
  for (const m of mats) {
    const have = db.prepare('SELECT count FROM gather_inventory WHERE guild_id=? AND user_id=? AND item_id=?').get(gid, uid, m.item_id);
    const it = db.prepare('SELECT name, emoji FROM gather_items WHERE id=?').get(m.item_id);
    const need = m.count * times;
    if (!have || have.count < need) lack.push(`🔴${it ? (it.emoji || '') + it.name : '#' + m.item_id} ${have ? have.count : 0}/${need}`);
  }
  const w0 = wallet(gid, uid, uname);
  const totalCost = (r.cost || 0) * times;
  if (lack.length) return { error: `材料不足：${lack.join('、')}` };
  if (w0.coins < totalCost) return { error: `${c.currency_name}不足：需要 ${totalCost}，你只有 ${w0.coins}。` };

  let ok = 0, fail = 0;
  const tx = db.transaction(() => {
    for (let n = 0; n < times; n++) {
      const success = Math.random() * 100 < (r.success_rate ?? 100);
      // 失敗且設定不保留材料 → 材料照樣扣掉（這是刻意的風險設計）
      if (success || !r.fail_keep) {
        for (const m of mats) {
          db.prepare('UPDATE gather_inventory SET count = count - ? WHERE guild_id=? AND user_id=? AND item_id=?')
            .run(m.count, gid, uid, m.item_id);
        }
      }
      if (totalCost) db.prepare('UPDATE econ_wallets SET coins = coins - ? WHERE guild_id=? AND user_id=?').run(r.cost || 0, gid, uid);
      if (!success) { fail++; continue; }
      ok++;
      if (r.result_type === 'tool') {
        const dur = (db.prepare('SELECT durability FROM gather_tools WHERE id=?').get(r.result_id) || {}).durability || 0;
        db.prepare('INSERT OR IGNORE INTO gather_user_tools (guild_id,user_id,tool_id,uses_left) VALUES (?,?,?,?)').run(gid, uid, r.result_id, dur);
      } else if (r.result_type === 'plot_field' || r.result_type === 'plot_greenhouse') {
        const col = r.result_type === 'plot_field' ? 'field' : 'greenhouse';
        db.prepare(`INSERT INTO crop_unlocks (guild_id,user_id,${col}) VALUES (?,?,?)
                    ON CONFLICT(guild_id,user_id) DO UPDATE SET ${col}=${col}+?`).run(gid, uid, r.result_count || 1, r.result_count || 1);
      } else if (r.result_type === 'plot_ranch' || r.result_type === 'plot_hatch') {
        const col = r.result_type === 'plot_ranch' ? 'ranch' : 'hatch';
        db.prepare(`INSERT INTO ranch_unlocks (guild_id,user_id,${col}) VALUES (?,?,?)
                    ON CONFLICT(guild_id,user_id) DO UPDATE SET ${col}=${col}+?`).run(gid, uid, r.result_count || 1, r.result_count || 1);
      } else if (r.result_type === 'plot_aquarium') {
        db.prepare(`INSERT INTO aquarium_unlocks (guild_id,user_id,aquarium) VALUES (?,?,?)
                    ON CONFLICT(guild_id,user_id) DO UPDATE SET aquarium=aquarium+?`).run(gid, uid, r.result_count || 1, r.result_count || 1);
      } else {
        addToBag(gid, uid, r.result_id, r.result_count || 1);
      }
    }
  });
  tx();
  if (ok) bumpQuests(gid, uid, { type: 'craft', amount: ok });

  const PLOT_RES = { plot_field: { name: '農地', emoji: '🌾' }, plot_greenhouse: { name: '溫室', emoji: '🏡' }, plot_ranch: { name: '牧場格', emoji: '🐔' }, plot_hatch: { name: '孵化格', emoji: '🥚' }, plot_aquarium: { name: '魚缸格', emoji: '🐠' } };
  const res = r.result_type === 'tool'
    ? db.prepare('SELECT name, emoji FROM gather_tools WHERE id=?').get(r.result_id)
    : (PLOT_RES[r.result_type] || db.prepare('SELECT name, emoji FROM gather_items WHERE id=?').get(r.result_id));
  const PLOT_HINT = { plot_field: '🌾 農地', plot_greenhouse: '🏡 溫室', plot_ranch: '🐔 牧場', plot_hatch: '🥚 孵化室', plot_aquarium: '🐠 魚缸' };
  const PLOT_USE = { plot_field: '/種植', plot_greenhouse: '/種植', plot_ranch: '/飼養', plot_hatch: '/孵化', plot_aquarium: '/水族商店' };
  return { embed: new EmbedBuilder().setColor(ok ? brandColor() : 0xed4245)
    .setTitle(`${r.emoji || (r.kind === 'forge' ? '🔨' : '🛠️')} ${label}${ok ? '成功' : '失敗'}`)
    .setDescription(
      `**${r.name}** ×${times}\n成功 ${ok} 次` + (fail ? `，失敗 ${fail} 次` : '') +
      (ok && res ? `\n獲得 ${res.emoji || ''} **${res.name}** ×${(r.result_count || 1) * ok}` : '') +
      (ok && PLOT_HINT[r.result_type] ? `\n${PLOT_HINT[r.result_type]} +${(r.result_count || 1) * ok} 格，去 \`${PLOT_USE[r.result_type]}\` 使用` : '') +
      (fail && !r.fail_keep ? '\n⚠️ 失敗的材料已消耗' : '') +
      (totalCost ? `\n花費 ${money(c, totalCost)}` : '')) };
}

// 修理一件壞掉／磨損的工具。/修理 指令與狀態頁的下拉選單共用。
function repairTool(gid, uid, uname, toolId) {
  const c = cfg(gid);
  const tool = db.prepare(
    `SELECT t.*, u.uses_left FROM gather_tools t JOIN gather_user_tools u ON u.tool_id=t.id
      WHERE t.guild_id=? AND t.id=? AND u.guild_id=? AND u.user_id=?`).get(gid, toolId, gid, uid);
  if (!tool) return { error: '你沒有這件道具。' };
  if (tool.durability <= 0) return { error: `${tool.emoji || ''}${tool.name} 不會壞，不用修理。` };
  if ((tool.uses_left || 0) >= tool.durability) return { error: `${tool.emoji || ''}${tool.name} 耐久是滿的（${tool.uses_left}/${tool.durability}），不用修。` };
  const cost = repairCostOf(tool);
  const w = wallet(gid, uid, uname);
  if (w.coins < cost) return { error: `${c.currency_name}不夠：修理要 ${cost}，你只有 ${w.coins.toLocaleString('en-US')}。` };
  const tx = db.transaction(() => {
    if (cost) db.prepare('UPDATE econ_wallets SET coins = coins - ? WHERE guild_id=? AND user_id=?').run(cost, gid, uid);
    db.prepare('UPDATE gather_user_tools SET uses_left=? WHERE guild_id=? AND user_id=? AND tool_id=?').run(tool.durability, gid, uid, tool.id);
  });
  tx();
  return { embed: new EmbedBuilder().setColor(brandColor()).setTitle('🔧 修理完成')
    .setDescription(`${tool.emoji || ''}**${tool.name}** 耐久補滿 **${tool.durability}/${tool.durability}**，可以繼續用了。`)
    .setFooter({ text: `花了 ${cost} ${c.currency_name}　餘額 ${(w.coins - cost).toLocaleString('en-US')}` }) };
}

// 下拉選單的統一回覆方式。
// Discord 的選單會記住上次選到的項目，直接 reply 的話同一個項目點第二次不會送出事件
//（玩家的體感就是「不能連續點」）。所以先 update 把選單原封不動重送一次來清掉選取狀態，
// 再用 followUp 回報這次的結果。
// 選單處理的保護罩：算結果時若丟例外，至少回一則訊息並記錄，
// 不會讓玩家卡在 Discord 的「應用程式沒有回應」。fn 可以是同步或非同步。
async function safeMenu(i, label, fn) {
  try {
    return await menuResult(i, await fn());
  } catch (e) {
    logError(i.guildId, `${label}失敗：`, e.message);
    const msg = { content: '執行失敗，管理員可到後台的系統錯誤紀錄查看原因。', flags: MessageFlags.Ephemeral };
    if (i.replied || i.deferred) return i.followUp(msg).catch(() => {});
    return i.reply(msg).catch(() => {});
  }
}

async function menuResult(i, out) {
  const rows = (i.message?.components || []).map(r => ActionRowBuilder.from(r));
  await i.update({ components: rows }).catch(() => {});
  const payload = out.error ? { content: out.error } : { embeds: [out.embed] };
  return i.followUp({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {});
}

// 商店分類顏色：一類一色，捲動時一眼分得出區塊
const KIND_COLOR = { fish: 0x3498db, mine: 0x95a5a6, wood: 0x8b5a2b, forage: 0x2ecc71, hunt: 0xe67e22 };
const FAC_COLOR = { field: 0xf1c40f, greenhouse: 0x1abc9c, ranch: 0xe91e63, hatch: 0x9b59b6 };

const CMD_LIST = [...GATHER_CMDS, '製作', '鍛造', '配方', '錢包', '背包', '賣出', '商店', '購買', '圖鑑', '任務', '轉帳', '富豪榜', '抽籤', '地圖', '修理', '狀態'];
const CMD_DEFAULT = (cmd) => ({
  enabled: 1,
  roles: '',
  // 一律私密（只有本人看得到），公用頻道才不會被採集結果洗版；
  // 只有偷竊、SSR 報喜、交易 這些才會公開（像大聲公）
  private: 1,
  admin_only: cmd === '富豪榜' ? 1 : 0
});

function seedCmdPerms(gid) {
  const ins = db.prepare('INSERT OR IGNORE INTO gather_cmd_perms (guild_id,cmd,enabled,roles,private,admin_only) VALUES (?,?,?,?,?,?)');
  for (const cmd of CMD_LIST) {
    const d = CMD_DEFAULT(cmd);
    ins.run(gid, cmd, d.enabled, d.roles, d.private, d.admin_only);
  }
}
function cmdPerm(gid, cmd) {
  return db.prepare('SELECT * FROM gather_cmd_perms WHERE guild_id=? AND cmd=?').get(gid, cmd) || CMD_DEFAULT(cmd);
}
// 管理員判定：伺服器管理權限即可，不必另外設身分組
const isAdmin = (member) => !!member && (member.permissions.has('Administrator') || member.permissions.has('ManageGuild'));

// 「挑數量賣」用的物品選單：背包空了回 null
// 把整個背包分成多個下拉（每個上限 25）一次列出全部，同類物品排在一起好找（不用先選類別）
function sellItemRows(gid, uid) {
  const rows = db.prepare(
    `SELECT v.count, it.* FROM gather_inventory v JOIN gather_items it ON it.id=v.item_id
      WHERE v.guild_id=? AND v.user_id=? AND v.count>0 ORDER BY it.kind, it.price DESC`).all(gid, uid);
  if (!rows.length) return null;
  const menus = [];
  for (let p = 0; p < rows.length && menus.length < 5; p += 25) {
    const slice = rows.slice(p, p + 25);
    menus.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(`sellone:${p / 25}`)
        .setPlaceholder(rows.length > 25 ? `選要賣的物品（第 ${p + 1}-${p + slice.length} 種）` : '選一種要賣的物品')
        .setMinValues(1).setMaxValues(1)
        .addOptions(slice.map(r => ({
          label: `${r.emoji || ''}${r.name}`.slice(0, 100),
          description: `持有 ${r.count}　單價 ${livePrice(gid, r)}`.slice(0, 100), value: String(r.id)
        })))));
  }
  return menus;
}

function init(client) {
  // 開機時先把每台伺服器的預設物品/道具建起來，管理員一進後台就看得到東西可以調，
  // 不用等到有人第一次打指令才生成。
  for (const [gid] of client.guilds.cache) {
    try { seedGuild(gid); seedCmdPerms(gid); } catch (e) { logError(gid, '釣魚挖礦初始化失敗：', e.message); }
  }

  client.on('interactionCreate', async (i) => {
    // 地圖切換選單（不是斜線指令，要在 isChatInputCommand 之前處理）
    // 修理下拉選單（狀態頁）
    if (i.isStringSelectMenu() && i.customId === 'repairpick') {
      return safeMenu(i, '修理', () => repairTool(i.guildId, i.user.id, i.user.username, parseInt(i.values[0], 10)));
    }
    // 配方下拉選單：點一下就做 1 次
    if (i.isStringSelectMenu() && i.customId === 'craftpick') {
      return safeMenu(i, '製作', () => craftRecipe(i.guildId, i.user.id, i.user.username, parseInt(i.values[0], 10), 1));
    }
    // 商店下拉選單購買（道具／設施共用）
    if (i.isStringSelectMenu() && i.customId === 'shopbuy') {
      return safeMenu(i, '商店購買', () => {
        const [kind, rawId] = String(i.values[0]).split(':');
        return buyThing(i.guildId, i.user.id, i.user.username, kind, parseInt(rawId, 10));
      });
    }
    if (i.isStringSelectMenu() && i.customId === 'gathermap:pick') {
      const mapId = parseInt(i.values[0], 10);
      const m = db.prepare('SELECT * FROM gather_maps WHERE id=? AND guild_id=? AND enabled=1').get(mapId, i.guildId);
      if (!m) return i.update({ content: '這張地圖已不存在。', embeds: [], components: [] }).catch(() => {});
      db.prepare('INSERT INTO gather_user_map (guild_id,user_id,map_id) VALUES (?,?,?) ON CONFLICT(guild_id,user_id) DO UPDATE SET map_id=excluded.map_id')
        .run(i.guildId, i.user.id, mapId);
      const embed = new EmbedBuilder().setColor(brandColor()).setTitle('🗺️ 已切換地圖')
        .setDescription(`你現在在 ${m.emoji || ''}**${m.name}**\n` +
          (cfg(i.guildId).daily_points > 0
            ? `門票 ${mapCost(m)} 點／次　稀有率 +${m.luck_bonus}%\n今日剩 ${Math.max(0, cfg(i.guildId).daily_points - pointsUsedToday(i.guildId, i.user.id))}/${cfg(i.guildId).daily_points} 點`
            : `每日採集 ${m.daily_limit} 次　稀有率 +${m.luck_bonus}%`) + `\n${m.description || ''}`);
      // 保留選單（重新送一次才能再切換，Discord 不會對「選同一項」送事件）
      const maps2 = db.prepare('SELECT * FROM gather_maps WHERE guild_id=? AND enabled=1 ORDER BY sort, id').all(i.guildId);
      const c2 = cfg(i.guildId);
      const menu2 = new StringSelectMenuBuilder().setCustomId('gathermap:pick').setPlaceholder('切換到其他地圖')
        .addOptions(maps2.slice(0, 25).map(x => ({
          label: x.name.slice(0, 100),
          description: (c2.daily_points > 0 ? `門票 ${mapCost(x)} 點　幸運 +${x.luck_bonus}%` : `每日 ${x.daily_limit} 次　幸運 +${x.luck_bonus}%`).slice(0, 100),
          value: String(x.id)
        })));
      return i.update({ embeds: [embed], components: [new ActionRowBuilder().addComponents(menu2)] }).catch(() => {});
    }
    // 面板「賣出」按鈕 → 跳出可多選的賣出清單（不勾的留著）
    if (i.isButton() && i.customId === 'adv:sellpick') {
      const rows = db.prepare(
        `SELECT v.count, it.* FROM gather_inventory v JOIN gather_items it ON it.id = v.item_id
          WHERE v.guild_id=? AND v.user_id=? AND v.count > 0 ORDER BY it.price DESC`
      ).all(i.guildId, i.user.id);
      if (!rows.length) return i.reply({ content: '背包是空的，沒東西可以賣。', flags: MessageFlags.Ephemeral });
      const menu = new StringSelectMenuBuilder().setCustomId('sellpick')
        .setPlaceholder('勾選要賣的（可多選，不勾的留著）').setMinValues(1).setMaxValues(Math.min(rows.length + 1, 25))
        .addOptions([
          { label: '🔴 全部賣光', value: '__all__', description: '一次賣掉背包所有東西' },
          { label: '🔢 挑數量賣（選一種）', value: '__qty__', description: '選一種物品，再選要賣幾個（可留一些）' },
          ...rows.slice(0, 23).map(r => ({
            label: `${r.emoji || ''}${r.name}`.slice(0, 100),
            description: `持有 ${r.count}　單價 ${livePrice(i.guildId, r)}　共 ${(r.count * livePrice(i.guildId, r)).toLocaleString('en-US')}`.slice(0, 100),
            value: String(r.id)
          }))
        ]);
      return i.reply({ content: '要賣哪些？勾選後送出（整種賣掉）；想留一些就選「🔢 挑數量賣」：', components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral });
    }
    // 「挑數量賣」：選物品（多個下拉一次列全部）→ 再選數量
    if (i.isStringSelectMenu() && i.customId === 'sellpick' && i.values.includes('__qty__')) {
      const menus = sellItemRows(i.guildId, i.user.id);
      if (!menus) return i.update({ content: '背包是空的，沒東西可以賣。', components: [], embeds: [] }).catch(() => {});
      return i.update({ content: '要賣哪一種？（下拉可能有好幾個，往下找）', components: menus, embeds: [] }).catch(() => {});
    }
    // 選好物品 → 列出數量選項（全部／一半／固定階梯，只顯示 ≤ 持有量的）
    if (i.isStringSelectMenu() && i.customId.startsWith('sellone:')) {
      const id = Number(i.values[0]);
      const r = db.prepare('SELECT v.count, it.* FROM gather_inventory v JOIN gather_items it ON it.id=v.item_id WHERE v.guild_id=? AND v.user_id=? AND it.id=? AND v.count>0').get(i.guildId, i.user.id, id);
      if (!r) return i.update({ content: '這個已經沒有了。', components: [], embeds: [] }).catch(() => {});
      const N = r.count, half = Math.max(1, Math.floor(N / 2));
      const amts = [...new Set([1, 5, 10, 25, 50, 100].filter(x => x < N).concat(half < N ? [half] : []).concat([N]))].sort((a, b) => a - b);
      const opts = amts.slice(0, 25).map(a => ({
        label: a === N ? `全部（${N} 個）` : a === half ? `一半（${half} 個）` : `賣 ${a} 個`,
        description: `+${(a * livePrice(i.guildId, r)).toLocaleString('en-US')} 星幣，剩 ${N - a}`.slice(0, 100), value: String(a)
      }));
      const menu = new StringSelectMenuBuilder().setCustomId('sellqty:' + id).setPlaceholder('要賣幾個？').setMinValues(1).setMaxValues(1).addOptions(opts);
      return i.update({ content: `${r.emoji || ''}${r.name}：要賣幾個？（持有 ${N}，單價 ${livePrice(i.guildId, r)} ${priceTag(i.guildId, r)}）`, components: [new ActionRowBuilder().addComponents(menu)], embeds: [] }).catch(() => {});
    }
    // 選好數量 → 賣掉指定數量
    if (i.isStringSelectMenu() && i.customId.startsWith('sellqty:')) {
      const gid = i.guildId, uid = i.user.id, uname = i.user.username, cc = cfg(gid);
      const id = Number(i.customId.split(':')[1]);
      const qty = Number(i.values[0]);
      const r = db.prepare('SELECT v.count, it.* FROM gather_inventory v JOIN gather_items it ON it.id=v.item_id WHERE v.guild_id=? AND v.user_id=? AND it.id=? AND v.count>0').get(gid, uid, id);
      if (!r) return i.update({ content: '這個已經沒有了。', components: [], embeds: [] }).catch(() => {});
      const sell = Math.min(qty, r.count);
      db.prepare('UPDATE gather_inventory SET count = count - ? WHERE guild_id=? AND user_id=? AND item_id=?').run(sell, gid, uid, id);
      const gained = sell * livePrice(gid, r);
      const now = addCoins(gid, uid, uname, gained);
      bumpQuests(gid, uid, { type: 'sell', amount: gained });
      const embed = new EmbedBuilder().setColor(brandColor()).setTitle('賣出成功')
        .setDescription(`${r.emoji || ''} ${r.name} ×${sell}　+${gained.toLocaleString('en-US')}\n（還留著 ${r.count - sell} 個）`)
        .setFooter({ text: `餘額 ${now.toLocaleString('en-US')} ${cc.currency_name}` });
      // 賣完再把物品選單附回去：可以繼續挑數量賣，不用重新按「賣出」
      const again = sellItemRows(gid, uid);
      return i.update({
        content: again ? '要再挑一種賣嗎？（下拉可能有好幾個）' : '',
        embeds: [embed], components: again || []
      }).catch(() => {});
    }
    // 賣出清單送出 → 只賣勾選的
    if (i.isStringSelectMenu() && i.customId === 'sellpick') {
      const gid = i.guildId, uid = i.user.id, uname = i.user.username, cc = cfg(gid);
      let rows;
      if (i.values.includes('__all__')) {
        rows = db.prepare('SELECT v.count, it.* FROM gather_inventory v JOIN gather_items it ON it.id=v.item_id WHERE v.guild_id=? AND v.user_id=? AND v.count>0').all(gid, uid);
      } else {
        const ids = i.values.map(Number).filter(Boolean);
        rows = ids.length ? db.prepare(`SELECT v.count, it.* FROM gather_inventory v JOIN gather_items it ON it.id=v.item_id WHERE v.guild_id=? AND v.user_id=? AND v.count>0 AND it.id IN (${ids.map(() => '?').join(',')})`).all(gid, uid, ...ids) : [];
      }
      if (!rows.length) return i.update({ content: '這些東西已經沒有了。', components: [], embeds: [] }).catch(() => {});
      let gained = 0; const lines = [];
      const tx = db.transaction(() => {
        for (const r of rows) {
          db.prepare('UPDATE gather_inventory SET count = count - ? WHERE guild_id=? AND user_id=? AND item_id=?').run(r.count, gid, uid, r.id);
          const px = livePrice(gid, r);
          gained += r.count * px;
          lines.push(`${r.emoji || ''} ${r.name} ×${r.count}　+${(r.count * px).toLocaleString('en-US')}${priceTag(gid, r)}`);
        }
      });
      tx();
      const now = addCoins(gid, uid, uname, gained);
      bumpQuests(gid, uid, { type: 'sell', amount: gained });
      const embed = new EmbedBuilder().setColor(brandColor()).setTitle('賣出成功')
        .setDescription(lines.slice(0, 20).join('\n') + (lines.length > 20 ? `\n…等 ${lines.length} 種` : ''))
        .setFooter({ text: `共得 ${gained.toLocaleString('en-US')}｜餘額 ${now.toLocaleString('en-US')} ${cc.currency_name}` });
      return i.update({ content: '', embeds: [embed], components: [] }).catch(() => {});
    }
    // 冒險面板按鈕 → 對應到同名指令（只接無參數的動作）
    const GATHER_BTN = {
      'adv:fish': '釣魚', 'adv:mine': '挖礦', 'adv:wood': '伐木', 'adv:forage': '採集', 'adv:hunt': '狩獵',
      'adv:bag': '背包', 'adv:wallet': '錢包', 'adv:sellall': '賣出', 'adv:draw': '抽籤', 'adv:map': '地圖',
      'adv:rich': '富豪榜', 'adv:store': '商店', 'adv:recipe': '配方', 'adv:status': '狀態',
      'adv:quest': '任務', 'adv:questclaim': '任務'
    };
    const isBtn = i.isButton();
    let name;
    if (isBtn && GATHER_BTN[i.customId]) name = GATHER_BTN[i.customId];
    else if (i.isChatInputCommand()) name = i.commandName;
    else return;
    const ALL = ['錢包', '背包', '賣出', '商店', '購買', '圖鑑', '富豪榜', '製作', '鍛造', '配方', '任務', '轉帳', '抽籤', '地圖', '修理', '狀態'];
    if (!GATHER_CMD[name] && !ALL.includes(name)) return;

    const gid = i.guildId;
    if (!gid) return i.reply({ content: '這個指令只能在伺服器裡使用。', flags: MessageFlags.Ephemeral });
    // 這段在主 try 之外，之前若丟例外會讓玩家卡在「應用程式沒有回應」
    let c;
    try {
      seedGuild(gid);
      seedCmdPerms(gid);
      c = cfg(gid);
    } catch (e) {
      logError(gid, '釣魚挖礦初始化失敗：', `${name}（${e.message}）`);
      return i.reply({ content: '執行失敗，管理員可到後台的系統錯誤紀錄查看原因。', flags: MessageFlags.Ephemeral }).catch(() => {});
    }

    // 逐指令的開關 / 身分組 / 僅管理員
    const perm = cmdPerm(gid, name);
    if (!perm.enabled) return i.reply({ content: `\`/${name}\` 目前停用中。`, flags: MessageFlags.Ephemeral });
    if (perm.admin_only && !isAdmin(i.member)) {
      return i.reply({ content: `\`/${name}\` 只開放給管理員使用。`, flags: MessageFlags.Ephemeral });
    }
    const allowRoles = csv(perm.roles);
    if (allowRoles.length && !isAdmin(i.member) && !i.member.roles.cache.some(r => allowRoles.includes(r.id))) {
      return i.reply({ content: `你沒有使用 \`/${name}\` 的權限。`, flags: MessageFlags.Ephemeral });
    }
    // private＝結果只有本人看得到；面板按鈕一律私密，避免洗版公用面板頻道
    const priv = isBtn || !!perm.private;
    const reply = (payload) => i.reply(priv ? { ...payload, flags: MessageFlags.Ephemeral } : payload);
    if (!c.enabled) return i.reply({ content: '釣魚挖礦系統目前停用中。', flags: MessageFlags.Ephemeral });

    const allowed = csv(c.channels);
    if (allowed.length && !allowed.includes(i.channelId)) {
      return i.reply({
        content: `這個指令只能在 ${allowed.map(id => `<#${id}>`).join('、')} 使用。`,
        flags: MessageFlags.Ephemeral
      });
    }

    const uid = i.user.id;
    const uname = i.user.username;

    try {
      // ---- 釣魚 / 挖礦 ----
      if (GATHER_CMD[name]) {
        const kind = GATHER_CMD[name];
        const tool = currentTool(gid, uid, kind);
        // 禁止徒手：工具壞了／被抵押走了就不能採集，要先修理或贖回（後台 require_tool 可關）
        if (c.require_tool && !tool.id) {
          const any = db.prepare('SELECT name, emoji FROM gather_tools WHERE guild_id=? AND kind=? AND enabled=1 ORDER BY tier ASC LIMIT 1').get(gid, kind);
          if (any) {
            return i.reply({
              content: `✋ **徒手不能${KIND_NAME[kind]}**：你目前沒有可用的工具（壞掉、還沒買，或被抵押給貸款了）。\n`
                + `用 \`/修理\` 修好、\`/一般商店\` 買一支 ${any.emoji || ''}${any.name}，或 \`/還款\` 把抵押的工具贖回來。`,
              flags: MessageFlags.Ephemeral
            });
          }
        }
        const base = kind === 'fish' ? c.fish_cooldown : (kind === 'mine' ? c.mine_cooldown : (c.other_cooldown || c.fish_cooldown));
        const wait = Math.max(1, Math.round(base * (1 - (tool.cooldown_cut || 0) / 100)));

        // 地圖：每日總次數上限（跨所有種類）由地圖決定；沒有地圖時沿用舊的 config 每日上限
        const map = activeMap(gid, uid);
        const pool = c.daily_points || 0;
        const cost = mapCost(map);
        if (pool > 0) {
          // 點數制：所有地圖共用一個每日點數池，高階地圖一次扣比較多點
          // （買來的體力也算在這一池裡，所以用 staminaState 而不是只看 used）
          const st = staminaState(gid, uid);
          if (cost > st.left) {
            const left = st.left;
            return i.reply({
              content: `今日體力不足：剩 **${left}／${staminaState(gid, uid).max}** 點，${map ? `${map.emoji || ''}${map.name}` : '這裡'}每次要 **${cost}** 點。\n` +
                (left > 0 ? '可以用 `/地圖` 換去便宜一點的圖，或明天再來。' : '明天午夜（台灣時間）重置；急著用可以去 `/特殊商店` 買體力。'),
              flags: MessageFlags.Ephemeral
            });
          }
        } else if (map && map.daily_limit > 0 && totalGathersToday(gid, uid) >= map.daily_limit) {
          return i.reply({ content: `今天在 ${map.emoji || ''}${map.name} 的採集次數已用完（每日 ${map.daily_limit} 次）。可用 \`/地圖\` 換張圖，或明天再來。`, flags: MessageFlags.Ephemeral });
        }

        const cd = checkCooldown(gid, uid, kind, wait, (map || pool > 0) ? 0 : c.daily_limit);
        if (!cd.ok) {
          if (cd.daily) return i.reply({ content: `今天的${KIND_NAME[kind]}次數已用完（每日上限 ${cd.limit} 次），明天再來吧！`, flags: MessageFlags.Ephemeral });
          // <t:unix:R> 是 Discord 的動態時間戳，會自己倒數（例如「in 3 minutes」）
          const nextTs = Math.floor(Date.now() / 1000) + cd.wait;
          return i.reply({ content: `還要休息 **${fmtWait(cd.wait)}**（<t:${nextTs}:R> 可再${KIND_NAME[kind]}）。`, flags: MessageFlags.Ephemeral });
        }

        // 幸運＝道具幸運 + 抽籤幸運符 + 地圖幸運
        const buffLuck = activeLuck(gid, uid);
        const mapLuck = map ? (map.luck_bonus || 0) : 0;
        const item = rollItem(gid, kind, (tool.luck || 0) + buffLuck + mapLuck, uid);
        if (!item) return i.reply({ content: `管理員還沒設定任何${KIND_NAME[kind]}掉落物。`, flags: MessageFlags.Ephemeral });

        markUsed(gid, uid, kind, wait, cd.day, cd.usedToday);
        if (pool > 0) bumpPoints(gid, uid, cost);
        addToBag(gid, uid, item.id, 1);
        wallet(gid, uid, uname);

        // 工具耐久：有耐久的工具每次使用扣 1，歸零就壞（下次自動改用基礎工具）
        let toolNote = `\n使用中：${tool.emoji || ''} ${tool.name}`;
        if (tool.id && tool.durability > 0) {
          // 免費工具第一次使用時補一筆耐久紀錄（買/做的本來就有）
          db.prepare('INSERT OR IGNORE INTO gather_user_tools (guild_id,user_id,tool_id,uses_left) VALUES (?,?,?,?)').run(gid, uid, tool.id, tool.durability);
          const left = Math.max(0, (tool.uses_left ?? tool.durability) - 1);
          db.prepare('UPDATE gather_user_tools SET uses_left=? WHERE guild_id=? AND user_id=? AND tool_id=?').run(left, gid, uid, tool.id);
          const rcost = repairCostOf(tool);
          if (left <= 0) toolNote = `\n⚠️ **${tool.emoji || ''}${tool.name} 壞掉了！** 用 \`/修理 ${tool.name}\`（${rcost > 0 ? money(c, rcost) : '免費'}）修好，壞著會改用徒手（沒加成）。`;
          else toolNote += `　耐久 ${left}/${tool.durability}${left <= 5 ? '（快壞了⚠️）' : ''}`;
        }

        const inv = db.prepare('SELECT * FROM gather_inventory WHERE guild_id=? AND user_id=? AND item_id=?').get(gid, uid, item.id);
        const isNew = inv.total_caught === 1;
        // 任務進度：同一次採集會同時推進「次數」「稀有度」「指定物品」三類任務
        const doneQuests = [
          ...bumpQuests(gid, uid, { type: 'gather', kind, itemId: item.id, rarity: item.rarity }),
          ...bumpQuests(gid, uid, { type: 'rarity', kind, itemId: item.id, rarity: item.rarity }),
          ...bumpQuests(gid, uid, { type: 'item', kind, itemId: item.id, rarity: item.rarity })
        ];

        const embed = new EmbedBuilder()
          .setColor(RARITY_COLOR[item.rarity] || brandColor())
          .setTitle(`${KIND_EMOJI[kind] || '🎒'} ${i.member?.displayName || uname} ${KIND_NAME[kind]}成功！`)
          .setDescription(
            `${item.emoji || ''} **${item.name}**　\`${item.rarity}\` ${RARITY_LABEL[item.rarity] || ''}` +
            (isNew ? '　🆕 **圖鑑新收錄！**' : '') +
            (item.description ? `\n${item.description}` : '') +
            `\n\n可賣 ${money(c, livePrice(gid, item))} ${priceTag(gid, item)}　持有 ${inv.count} 個` +
            (map ? `\n所在地圖：${map.emoji || ''}${map.name}（幸運 +${map.luck_bonus}%　` +
              (pool > 0 ? `門票 ${cost} 點　今日剩 ${Math.max(0, pool - pointsUsedToday(gid, uid))}/${pool} 點）` : `今日 ${totalGathersToday(gid, uid)}/${map.daily_limit} 次）`) : '') +
            toolNote +
            `\n下次可用：<t:${Math.floor((Date.now() + wait * 1000) / 1000)}:R>`
          );
        if (item.image_url) embed.setThumbnail(item.image_url);
        if (doneQuests.length) {
          embed.addFields({ name: '📜 任務達成', value: doneQuests.map(q => `**${q.name}** — 用 \`/任務 領取\` 領獎`).join('\n').slice(0, 1024) });
        }
        await reply({ embeds: [embed] });

        // 高稀有度公開報喜（設定為空＝不廣播）
        const idx = RARITY.indexOf(c.announce_rare);
        if (idx >= 0 && RARITY.indexOf(item.rarity) >= idx) {
          // 報喜一律公開：如果採集結果被設成「只有自己看得到」，followUp 會跟著變私密，
          // 那就失去報喜的意義，所以直接發到頻道。
          if (priv) await i.channel.send({ content: `🎉 恭喜 <@${uid}> ${KIND_NAME[kind]}到了 **${item.rarity} ${item.name}**！` }).catch(() => {});
          else await i.followUp({ content: `🎉 恭喜 <@${uid}> ${KIND_NAME[kind]}到了 **${item.rarity} ${item.name}**！` }).catch(() => {});
        }
        return;
      }

      // ---- 錢包 ----
      if (name === '錢包') {
        const target = (!isBtn && i.options.getUser('玩家')) || i.user;
        const w = wallet(gid, target.id, target.username);
        const rank = db.prepare('SELECT COUNT(*) n FROM econ_wallets WHERE guild_id=? AND coins > ?').get(gid, w.coins).n + 1;
        const embed = new EmbedBuilder().setColor(brandColor())
          .setTitle(`${target.username} 的錢包`)
          .setDescription(`目前持有　**${money(c, w.coins)}**\n累計賺取　${money(c, w.total_earned)}\n財富排名　#${rank}`)
          .setThumbnail(target.displayAvatarURL());
        return await reply({ embeds: [embed] });
      }

      // ---- 背包 ----
      if (name === '背包') {
        const target = (!isBtn && i.options.getUser('玩家')) || i.user;
        const rows = db.prepare(
          `SELECT v.count, it.* FROM gather_inventory v JOIN gather_items it ON it.id = v.item_id
            WHERE v.guild_id=? AND v.user_id=? AND v.count > 0 ORDER BY it.kind, it.price DESC`
        ).all(gid, target.id);
        if (!rows.length) return i.reply({ content: `${target.username} 的背包是空的，先去 \`/釣魚\` 或 \`/挖礦\` 吧！`, flags: MessageFlags.Ephemeral });
        const total = rows.reduce((a, r) => a + r.count * livePrice(gid, r), 0);
        const kindsInBag = Object.keys(KIND_NAME).filter(k => rows.some(r => r.kind === k));
        const embed = new EmbedBuilder().setColor(brandColor())
          .setTitle(`${target.username} 的背包`)
          .setFooter({ text: `全部賣掉可得 ${total.toLocaleString('en-US')} ${c.currency_name}` });
        let budget = 5500, cut = false;   // 預留給標題/footer，避免超過 embed 6000 字硬上限
        for (const k of kindsInBag) {
          if (cut) break;
          const lines = rows.filter(r => r.kind === k)
            .map(r => `${r.emoji || ''} **${r.name}** \`${r.rarity}\` ×${r.count}　(${livePrice(gid, r) * r.count})${priceTag(gid, r)}`);
          // 一個類別太長就拆成多欄（欄位上限 1024 字），避免物品被截掉
          const chunks = []; let buf = '';
          for (const ln of lines) {
            if (buf && buf.length + ln.length + 1 > 1024) { chunks.push(buf); buf = ''; }
            buf += (buf ? '\n' : '') + ln;
          }
          if (buf) chunks.push(buf);
          for (let idx = 0; idx < chunks.length; idx++) {
            if (budget - chunks[idx].length < 0 || embed.data.fields?.length >= 24) { cut = true; break; }
            budget -= chunks[idx].length + 24;
            embed.addFields({ name: `${KIND_EMOJI[k]} ${KIND_NAME[k]}${chunks.length > 1 ? ` (${idx + 1})` : ''}`, value: chunks[idx] });
          }
        }
        if (cut) embed.setDescription('_物品太多，這裡顯示不完——用 `/賣出` 或 `/圖鑑` 查看其餘。_');
        return await reply({ embeds: [embed] });
      }

      // ---- 賣出 ----（面板按鈕＝賣出全部）
      if (name === '賣出') {
        const what = isBtn ? '全部' : (i.options.getString('物品') || '全部').trim();
        const qty = isBtn ? 0 : (i.options.getInteger('數量') || 0);
        let rows = db.prepare(
          `SELECT v.count, it.* FROM gather_inventory v JOIN gather_items it ON it.id = v.item_id
            WHERE v.guild_id=? AND v.user_id=? AND v.count > 0`
        ).all(gid, uid);
        if (!rows.length) return i.reply({ content: '背包是空的，沒東西可以賣。', flags: MessageFlags.Ephemeral });

        // 支援：全部 / 稀有度（N R SR SSR）/ 物品名稱
        const up = what.toUpperCase();
        if (what !== '全部') {
          if (RARITY.includes(up)) rows = rows.filter(r => r.rarity === up);
          else rows = rows.filter(r => r.name === what);
          if (!rows.length) return i.reply({ content: `背包裡沒有「${what}」。可以填物品名稱、稀有度（N/R/SR/SSR）或「全部」。`, flags: MessageFlags.Ephemeral });
        }

        let gained = 0;
        const lines = [];
        const tx = db.transaction(() => {
          for (const r of rows) {
            const n = qty > 0 ? Math.min(qty, r.count) : r.count;
            if (n <= 0) continue;
            db.prepare('UPDATE gather_inventory SET count = count - ? WHERE guild_id=? AND user_id=? AND item_id=?')
              .run(n, gid, uid, r.id);
            const px = livePrice(gid, r);
            gained += n * px;
            lines.push(`${r.emoji || ''} ${r.name} ×${n}　+${(n * px).toLocaleString('en-US')}${priceTag(gid, r)}`);
          }
        });
        tx();
        if (!gained) return i.reply({ content: '沒有賣出任何東西。', flags: MessageFlags.Ephemeral });
        const now = addCoins(gid, uid, uname, gained);
        bumpQuests(gid, uid, { type: 'sell', amount: gained });
        const embed = new EmbedBuilder().setColor(brandColor()).setTitle('賣出成功')
          .setDescription(lines.slice(0, 20).join('\n') + (lines.length > 20 ? `\n…等 ${lines.length} 種` : ''))
          .setFooter({ text: `共得 ${gained.toLocaleString('en-US')}｜餘額 ${now.toLocaleString('en-US')} ${c.currency_name}` });
        return await reply({ embeds: [embed] });
      }

      // ---- 商店 ----
      if (name === '商店') {
        const tools = db.prepare('SELECT * FROM gather_tools WHERE guild_id=? AND enabled=1 ORDER BY kind, tier').all(gid);
        if (!tools.length) return i.reply({ content: '商店還沒有任何商品。', flags: MessageFlags.Ephemeral });
        const owned = new Set(db.prepare('SELECT tool_id FROM gather_user_tools WHERE guild_id=? AND user_id=?')
          .all(gid, uid).map(r => r.tool_id));
        const w = wallet(gid, uid, uname);
        const list = (k) => tools.filter(t => t.kind === k).map(t => {
          const stats = `\n　　幸運 +${t.luck}%　冷卻 -${t.cooldown_cut}%${t.description ? `　${t.description}` : ''}`;
          // 初階工具：免費配給一把，用壞後要花錢 /修理（不能重買，改用 /修理）
          if (t.tier <= 1) return `${t.emoji || ''} **${t.name}**　🎁 免費起始（用壞後 \`/修理\` ${repairCostOf(t)}）` + stats;
          return `${t.emoji || ''} **${t.name}**　${t.price ? money(c, t.price) : '免費'}${owned.has(t.id) ? '　✅ 已擁有' : ''}` + stats;
        }).join('\n');
        // 每個分類各自一則 Embed、各自一個顏色，一眼就分得出來在看哪一區
        const w0 = w.coins.toLocaleString('en-US');
        const embeds = [new EmbedBuilder().setColor(brandColor()).setTitle('🏪 一般商店')
          .setDescription(`賣**工具**與**體力**。點最下方的選單直接購買（也可以打 \`/購買 名稱\`），道具會自動使用你擁有的最高階。\n`
            + `🏗️ 農地／溫室／牧場／孵化室／魚缸請去 \`/設施商店\`；🛋️ 家具在 \`/家具\`；🐾 寵物在 \`/寵物\`。\n`
            + `你的餘額：**${w0} ${c.currency_name}**`)];
        for (const k of Object.keys(KIND_NAME)) {
          const txt = list(k);
          if (!txt) continue;
          embeds.push(new EmbedBuilder().setColor(KIND_COLOR[k] || brandColor())
            .setTitle(`${KIND_EMOJI[k]} ${KIND_TOOL[k]}`).setDescription(txt.slice(0, 4000)));
        }
        // 設施（農地／溫室／牧場／孵化室／魚缸）只在 `/設施商店` 賣 ——
        // 以前跟工具混在同一頁，玩家分不出「一般商店」到底在賣什麼。
        // 這裡改成賣體力：每天有購買上限，避免有錢人無限刷。
        const st = staminaState(gid, uid);
        const stCfg = { price: c.stamina_price || 10000, daily: c.stamina_daily_max ?? 5 };
        const boughtToday = staminaBoughtToday(gid, uid);
        embeds.push(new EmbedBuilder().setColor(0x9b59b6).setTitle('⚡ 體力')
          .setDescription(
            `**體力補充**　${money(c, stCfg.price)} ／ 1 點\n`
            + `　　今日體力 **${st.left}/${st.max}** 點${st.bonus ? `（含買來的 ${st.bonus}）` : ''}\n`
            + `　　今天已買 **${boughtToday}/${stCfg.daily}** 點${boughtToday >= stCfg.daily ? '（已達上限）' : ''}\n`
            + `　　體力給釣魚、挖礦、伐木、採集、狩獵與逛街共用，每天午夜回滿。`));
        // 買東西的下拉選單（跟設施商店同一套操作感：點一下就買，不必打名稱）
        const opts = [];
        for (const t of tools) {
          if (owned.has(t.id) || t.tier <= 1) continue;
          opts.push({
            label: `${KIND_TOOL[t.kind]}：${t.name}`.slice(0, 100),
            description: `${t.price.toLocaleString('en-US')} ${c.currency_name}｜幸運+${t.luck}%　冷卻-${t.cooldown_cut}%`.slice(0, 100),
            value: `tool:${t.id}`, emoji: t.emoji || undefined
          });
        }
        // 體力（每天有上限）
        if (boughtToday < stCfg.daily) {
          const canBuy = Math.min(stCfg.daily - boughtToday, 5);
          for (const n of [1, 3, 5].filter(x => x <= canBuy)) {
            opts.push({
              label: `體力 ×${n}`.slice(0, 100),
              description: `${(stCfg.price * n).toLocaleString('en-US')} ${c.currency_name}｜今天還能買 ${stCfg.daily - boughtToday} 點`.slice(0, 100),
              value: `stamina:${n}`, emoji: '⚡'
            });
          }
        }
        const rows = opts.length ? [new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder().setCustomId('shopbuy').setPlaceholder('選擇要購買的東西').addOptions(opts.slice(0, 25)))] : [];
        // 其他商店的入口：以前全部混在一頁，玩家找不到家具跟寵物在哪買
        rows.push(new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('adv:facility').setLabel('🏗️ 設施商店').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('adv:furniture').setLabel('🛋️ 家具商店').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('adv:pets').setLabel('🐾 寵物商店').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('adv:shop').setLabel('🎁 特殊商店').setStyle(ButtonStyle.Secondary)));
        embeds[embeds.length - 1].setFooter({
          text: opts.length ? `餘額 ${w0} ${c.currency_name}｜用下方選單購買` : `餘額 ${w0} ${c.currency_name}｜目前沒有可買的東西了`
        });
        return await reply({ embeds: embeds.slice(0, 10), components: rows });
      }

      // ---- 購買 ----
      if (name === '購買') {
        const what = (i.options.getString('道具') || '').trim();
        const tool = db.prepare('SELECT * FROM gather_tools WHERE guild_id=? AND enabled=1 AND name=?').get(gid, what);
        // 商店裡也賣設施：道具找不到就用同名的設施等級試一次
        const fdef = tool ? null : db.prepare('SELECT * FROM facility_defs WHERE guild_id=? AND enabled=1 AND name=?').get(gid, what);
        if (!tool && !fdef) return i.reply({ content: `找不到「${what}」，用 \`/商店\` 看看有哪些。`, flags: MessageFlags.Ephemeral });
        const r = buyThing(gid, uid, uname, tool ? 'tool' : 'fac', tool ? tool.id : fdef.id);
        if (r.error) return i.reply({ content: r.error, flags: MessageFlags.Ephemeral });
        return await reply({ embeds: [r.embed] });
      }

      // ---- 修理工具 ----
      if (name === '修理') {
        const what = (i.options.getString('道具') || '').trim();
        const tool = db.prepare(
          `SELECT t.id FROM gather_tools t JOIN gather_user_tools u ON u.tool_id=t.id
            WHERE t.guild_id=? AND t.name=? AND u.guild_id=? AND u.user_id=?`).get(gid, what, gid, uid);
        if (!tool) return i.reply({ content: `你沒有道具「${what}」。可以點 \`📊查看狀態\` 用下拉選單直接修。`, flags: MessageFlags.Ephemeral });
        const out = repairTool(gid, uid, uname, tool.id);
        if (out.error) return i.reply({ content: out.error, flags: MessageFlags.Ephemeral });
        return await reply({ embeds: [out.embed] });
      }

      // ---- 圖鑑 ----
      if (name === '圖鑑') {
        const target = i.options.getUser('玩家') || i.user;
        const kind = i.options.getString('種類') || 'fish';
        const all = db.prepare('SELECT * FROM gather_items WHERE guild_id=? AND kind=? AND enabled=1 ORDER BY rarity, price').all(gid, kind);
        if (!all.length) return i.reply({ content: '這個種類還沒有任何物品。', flags: MessageFlags.Ephemeral });
        const got = new Map(db.prepare('SELECT item_id, total_caught FROM gather_inventory WHERE guild_id=? AND user_id=?')
          .all(gid, target.id).map(r => [r.item_id, r.total_caught]));
        const embed = new EmbedBuilder().setColor(brandColor())
          .setTitle(`📖 ${target.username} 的${KIND_NAME[kind]}圖鑑`)
          .setFooter({ text: `收錄 ${[...got.keys()].filter(id => all.some(a => a.id === id)).length} / ${all.length} 種` });
        for (const r of RARITY) {
          const list = all.filter(a => a.rarity === r);
          if (!list.length) continue;
          embed.addFields({
            name: `\`${r}\` ${RARITY_LABEL[r]}（${list.filter(a => got.has(a.id)).length}/${list.length}）`,
            // 沒收錄過的只顯示問號，留一點收集動機
            value: list.map(a => got.has(a.id)
              ? `${a.emoji || ''} ${a.name} ×${got.get(a.id)}` : '　❔ ???').join('\n').slice(0, 1024)
          });
        }
        return await reply({ embeds: [embed] });
      }


      // ---- 製作 / 鍛造 ----
      if (name === '製作' || name === '鍛造') {
        const rkind = name === '製作' ? 'craft' : 'forge';
        const what = (i.options.getString('配方') || '').trim();
        const times = Math.min(10, Math.max(1, i.options.getInteger('次數') || 1));
        const rec = db.prepare('SELECT * FROM gather_recipes WHERE guild_id=? AND kind=? AND enabled=1 AND name=?').get(gid, rkind, what);
        if (!rec) return i.reply({ content: `找不到${name}配方「${what}」，用 \`/配方\` 看看有哪些。`, flags: MessageFlags.Ephemeral });
        const out = craftRecipe(gid, uid, uname, rec.id, times);
        if (out.error) return i.reply({ content: out.error, flags: MessageFlags.Ephemeral });
        return await reply({ embeds: [out.embed] });
      }

      // ---- 配方一覽 ----
      if (name === '配方') {
        // 按鈕進來時直接把製作與鍛造都列出；斜線指令可指定種類
        const kinds = isBtn ? ['craft', 'forge'] : [i.options.getString('種類') || 'craft'];
        const KCOLOR = { craft: 0x5865f2, forge: 0xe67e22 };
        const KTITLE = { craft: '🛠️ 製作配方', forge: '🔨 鍛造配方' };
        const PLOT_RES = { plot_field: { name: '農地（開一格）', emoji: '🌾' }, plot_greenhouse: { name: '溫室（開一格）', emoji: '🏡' }, plot_ranch: { name: '牧場（開一格）', emoji: '🐔' }, plot_hatch: { name: '孵化室（開一格）', emoji: '🥚' }, plot_aquarium: { name: '魚缸格（開一格）', emoji: '🐠' } };
        const embeds = [];
        const opts = [];
        for (const rkind of kinds) {
          const list = db.prepare('SELECT * FROM gather_recipes WHERE guild_id=? AND kind=? AND enabled=1 ORDER BY id').all(gid, rkind);
          if (!list.length) continue;
          const embed = new EmbedBuilder().setColor(KCOLOR[rkind] || brandColor()).setTitle(KTITLE[rkind] || '配方')
            .setDescription('點下方選單直接做一次（也可以打 `/製作 配方名稱 次數`）。');
          for (const r of list.slice(0, 25)) {
            const mats = readMaterials(r);
            // 順便算材料夠不夠，玩家不用自己對背包
            let enough = mats.length > 0;
            const matTxt = mats.map(m => {
              const it = db.prepare('SELECT name, emoji FROM gather_items WHERE id=?').get(m.item_id);
              const have = (db.prepare('SELECT count FROM gather_inventory WHERE guild_id=? AND user_id=? AND item_id=?').get(gid, uid, m.item_id) || {}).count || 0;
              const lack = have < m.count;
              if (lack) enough = false;
              // 缺的材料標紅（🔴），足夠的標綠（🟢），玩家一眼看出還缺什麼
              return `${lack ? '🔴' : '🟢'}${it ? (it.emoji || '') + it.name : '#' + m.item_id} ${have}/${m.count}`;
            }).join('　');
            const res = r.result_type === 'tool'
              ? db.prepare('SELECT name, emoji FROM gather_tools WHERE id=?').get(r.result_id)
              : (PLOT_RES[r.result_type] || db.prepare('SELECT name, emoji FROM gather_items WHERE id=?').get(r.result_id));
            embed.addFields({
              name: `${enough ? '✅' : '❌'} ${r.emoji || ''} ${r.name}`,
              value: `${matTxt || '（未設材料）'}${r.cost ? ` ＋ ${money(c, r.cost)}` : ''}\n→ ${res ? (res.emoji || '') + res.name : '？'} ×${r.result_count || 1}　成功率 ${r.success_rate}%`
            });
            if (mats.length) opts.push({
              label: `${rkind === 'forge' ? '鍛造' : '製作'}：${r.name}`.slice(0, 100),
              description: `${enough ? '材料足夠' : '材料不足'}｜→ ${res ? res.name : '？'} ×${r.result_count || 1}　成功率 ${r.success_rate}%`.slice(0, 100),
              value: String(r.id), emoji: r.emoji || (rkind === 'forge' ? '🔨' : '🛠️')
            });
          }
          embeds.push(embed);
        }
        if (!embeds.length) return i.reply({ content: '目前還沒有任何配方。', flags: MessageFlags.Ephemeral });
        const rows = opts.length ? [new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder().setCustomId('craftpick').setPlaceholder('選擇要做的配方（做 1 次）').addOptions(opts.slice(0, 25)))] : [];
        return await reply({ embeds: embeds.slice(0, 10), components: rows });
      }

      // ---- 任務 ----
      if (name === '任務') {
        // 面板按鈕沒有 options：adv:questclaim＝領獎、adv:quest＝看清單
        const act = isBtn ? (i.customId === 'adv:questclaim' ? 'claim' : 'list') : (i.options.getString('動作') || 'list');
        const list = db.prepare('SELECT * FROM quests WHERE guild_id=? AND enabled=1 ORDER BY period, id').all(gid);
        if (!list.length) return i.reply({ content: '目前沒有任何任務。', flags: MessageFlags.Ephemeral });
        const PERIOD = { daily: '每日', weekly: '每週', once: '一次性' };

        if (act === 'claim') {
          let coins = 0; const got = []; const full = [];
          const roles = [];
          for (const q of list) {
            const pk = periodKey(q.period);
            const pr = db.prepare('SELECT * FROM quest_progress WHERE guild_id=? AND user_id=? AND quest_id=? AND period_key=?')
              .get(gid, uid, q.id, pk);
            if (!pr || pr.claimed || pr.progress < q.goal_count) continue;
            // 懸賞任務：全服限量名額，先搶先贏（同步執行，count→update 之間不會被插隊）
            if (q.daily_slots > 0) {
              const taken = db.prepare("SELECT COUNT(*) n FROM quest_progress WHERE guild_id=? AND quest_id=? AND period_key=? AND claimed=1").get(gid, q.id, pk).n;
              if (taken >= q.daily_slots) { full.push(q.name); continue; }
            }
            db.prepare('UPDATE quest_progress SET claimed=1 WHERE guild_id=? AND user_id=? AND quest_id=? AND period_key=?')
              .run(gid, uid, q.id, pk);
            if (q.reward_coins) coins += q.reward_coins;
            if (q.reward_item) addToBag(gid, uid, q.reward_item, q.reward_item_count || 1);
            if (q.reward_role) roles.push(q.reward_role);
            got.push(q.name);
          }
          if (!got.length) {
            const msg = full.length ? `😢 懸賞名額已被搶完：${full.join('、')}\n明天請早！` : '沒有可領取的任務獎勵。';
            return i.reply({ content: msg, flags: MessageFlags.Ephemeral });
          }
          if (coins) addCoins(gid, uid, uname, coins);
          for (const rid of roles) {
            await i.member.roles.add(rid).catch(e => logError(gid, '任務獎勵身分組發放失敗：', e.message));
          }
          const fullNote = full.length ? `\n\n😢 懸賞名額已滿沒領到：${full.join('、')}` : '';
          return await reply({ embeds: [new EmbedBuilder().setColor(brandColor()).setTitle('🎁 已領取任務獎勵')
            .setDescription(`${got.map(n => `・${n}`).join('\n')}\n\n共獲得 ${money(c, coins)}${fullNote}`)] });
        }

        // 任務面板分兩型：① 每日／每週任務（這份清單）② 大賽（比一段期間的成長量，冠軍有成就）
        const liveContest = db.prepare("SELECT name, emoji, end_ts FROM contests WHERE guild_id=? AND status='live' ORDER BY end_ts LIMIT 2").all(gid);
        const embed = new EmbedBuilder().setColor(brandColor()).setTitle(`📜 ${i.member?.displayName || uname} 的任務`)
          .setDescription('**① 每日／每週任務**：照著做就有獎金，完成後用 `/任務 動作:領取獎勵` 一次領完。\n'
            + (liveContest.length
              ? '**② 大賽進行中**：' + liveContest.map(x => `${x.emoji || '🏆'}**${x.name}**（<t:${Math.floor(x.end_ts / 1000)}:R> 結束）`).join('、')
                + '　→ 點下面的「🏆 大賽」看排行榜'
              : '**② 大賽**：目前沒有進行中的場次，開賽會在公告頻道通知。'));
        for (const q of list.slice(0, 25)) {
          const pk = periodKey(q.period);
          const pr = db.prepare('SELECT * FROM quest_progress WHERE guild_id=? AND user_id=? AND quest_id=? AND period_key=?')
            .get(gid, uid, q.id, pk);
          const cur = Math.min(pr ? pr.progress : 0, q.goal_count);
          const pct = Math.round(cur / q.goal_count * 10);
          const bar = '█'.repeat(pct).padEnd(10, '░');
          const state = pr && pr.claimed ? '✅ 已領取' : (cur >= q.goal_count ? '🎁 可領取' : '');
          // 懸賞任務：顯示今日剩餘名額（全服先搶先贏）
          let bounty = '';
          if (q.daily_slots > 0) {
            const taken = db.prepare("SELECT COUNT(*) n FROM quest_progress WHERE guild_id=? AND quest_id=? AND period_key=? AND claimed=1").get(gid, q.id, pk).n;
            const left = Math.max(0, q.daily_slots - taken);
            bounty = `🏆 懸賞　名額 ${left}/${q.daily_slots}${left ? '' : '（已額滿）'}`;
          }
          embed.addFields({
            name: `[${PERIOD[q.period]}] ${q.daily_slots > 0 ? '🏆 ' : ''}${q.name} ${state}`,
            value: (bounty ? bounty + '\n' : '') + `${q.description || ''}\n\`${bar}\` ${cur}/${q.goal_count}` +
              `　獎勵：${q.reward_coins ? money(c, q.reward_coins) : ''}`.trimEnd()
          });
        }
        const claimRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('adv:questclaim').setLabel('領取獎勵').setEmoji('🎁').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('adv:contest').setLabel('大賽排行榜').setEmoji('🏆').setStyle(ButtonStyle.Primary));
        return await reply({ embeds: [embed], components: [claimRow] });
      }

      // ---- 轉帳 ----
      if (name === '轉帳') {
        if (!c.transfer_enabled) return i.reply({ content: '目前沒有開放玩家之間轉帳。', flags: MessageFlags.Ephemeral });
        const to = i.options.getUser('對象');
        const amount = i.options.getInteger('金額');
        if (to.bot) return i.reply({ content: '不能轉給機器人。', flags: MessageFlags.Ephemeral });
        if (to.id === uid) return i.reply({ content: '不能轉給自己。', flags: MessageFlags.Ephemeral });
        if (amount < (c.transfer_min || 1)) {
          return i.reply({ content: `單筆最少要 ${c.transfer_min} ${c.currency_name}。`, flags: MessageFlags.Ephemeral });
        }
        // 每日轉出上限：擋洗錢與帳號農場把幣集中到大號
        const sentToday = db.prepare(
          "SELECT COALESCE(SUM(amount),0) s FROM econ_transfers WHERE guild_id=? AND from_id=? AND created_at > date('now','localtime')"
        ).get(gid, uid).s;
        const dailyMax = c.transfer_daily_max || 0;
        if (dailyMax > 0 && sentToday + amount > dailyMax) {
          return i.reply({ content: `超過每日轉出上限（${dailyMax}）。你今天已轉出 ${sentToday}。`, flags: MessageFlags.Ephemeral });
        }
        const fee = Math.ceil(amount * (c.transfer_fee_pct || 0) / 100);
        const total = amount + fee;
        const w = wallet(gid, uid, uname);
        if (w.coins < total) {
          return i.reply({ content: `餘額不足：轉 ${amount} ＋ 手續費 ${fee} ＝ ${total}，你只有 ${w.coins}。`, flags: MessageFlags.Ephemeral });
        }
        wallet(gid, to.id, to.username);
        const tx = db.transaction(() => {
          db.prepare('UPDATE econ_wallets SET coins = coins - ? WHERE guild_id=? AND user_id=?').run(total, gid, uid);
          db.prepare('UPDATE econ_wallets SET coins = coins + ?, total_earned = total_earned + ? WHERE guild_id=? AND user_id=?')
            .run(amount, amount, gid, to.id);
          db.prepare('INSERT INTO econ_transfers (guild_id,from_id,from_name,to_id,to_name,amount,fee) VALUES (?,?,?,?,?,?,?)')
            .run(gid, uid, uname, to.id, to.username, amount, fee);
        });
        tx();
        const embed = new EmbedBuilder().setColor(brandColor()).setTitle('💸 轉帳成功')
          .setDescription(`<@${uid}> → <@${to.id}>\n金額 ${money(c, amount)}` +
            (fee ? `\n手續費 ${money(c, fee)}` : '') +
            `\n\n你的餘額：${wallet(gid, uid, uname).coins.toLocaleString('en-US')}`);
        return await reply({ embeds: [embed] });
      }

      // ---- 富豪榜 ----
      if (name === '富豪榜') {
        const rows = db.prepare('SELECT * FROM econ_wallets WHERE guild_id=? ORDER BY coins DESC LIMIT 10').all(gid);
        if (!rows.length) return i.reply({ content: '還沒有人有存款。', flags: MessageFlags.Ephemeral });
        const medal = ['🥇', '🥈', '🥉'];
        const embed = new EmbedBuilder().setColor(brandColor()).setTitle(`💰 ${c.currency_name}富豪榜`)
          .setDescription(rows.map((r, n) =>
            `${medal[n] || `\`${n + 1}.\``} **${r.username || '未知玩家'}**　${r.coins.toLocaleString('en-US')}`).join('\n'));
        return await reply({ embeds: [embed] });
      }

      // ---- 狀態總覽（看全貌）----
      if (name === '狀態') {
        const target = (!isBtn && i.options.getUser('玩家')) || i.user;
        const tid = target.id;
        const w = wallet(gid, tid, target.username);
        const map = activeMap(gid, tid);
        const usedToday = totalGathersToday(gid, tid);
        const buff = activeLuck(gid, tid);
        // 牧場 / 孵化
        const rc = guildConfig('ranch_config', gid);
        const rU = db.prepare('SELECT ranch, hatch FROM ranch_unlocks WHERE guild_id=? AND user_id=?').get(gid, tid) || { ranch: 0, hatch: 0 };
        // 總格數要含「設施商店買到的等級」，不然買了三階牧場卻顯示 8/0 隻
        const fac = require('./facility');
        const ranchMax = Math.max(0, rc.max_slots) + rU.ranch + fac.facilitySlots(gid, tid, 'ranch');
        const hatchMax = Math.max(0, rc.hatch_slots) + rU.hatch + fac.facilitySlots(gid, tid, 'hatch');
        const animals = db.prepare('SELECT COUNT(*) n FROM ranch_slots WHERE guild_id=? AND user_id=?').get(gid, tid).n;
        const incubating = db.prepare('SELECT COUNT(*) n FROM ranch_incubator WHERE guild_id=? AND user_id=?').get(gid, tid).n;
        // 農地 / 溫室
        const cc = guildConfig('crop_config', gid);
        const cU = db.prepare('SELECT field, greenhouse FROM crop_unlocks WHERE guild_id=? AND user_id=?').get(gid, tid) || { field: 0, greenhouse: 0 };
        const fieldMax = Math.max(0, cc.field_slots) + cU.field + fac.facilitySlots(gid, tid, 'field');
        const ghMax = Math.max(0, cc.greenhouse_slots) + cU.greenhouse + fac.facilitySlots(gid, tid, 'greenhouse');
        const fieldN = db.prepare("SELECT COUNT(*) n FROM crop_plots WHERE guild_id=? AND user_id=? AND plot_type='field'").get(gid, tid).n;
        const ghN = db.prepare("SELECT COUNT(*) n FROM crop_plots WHERE guild_id=? AND user_id=? AND plot_type='greenhouse'").get(gid, tid).n;
        // 背包
        const bagRows = db.prepare('SELECT v.count, it.* FROM gather_inventory v JOIN gather_items it ON it.id=v.item_id WHERE v.guild_id=? AND v.user_id=? AND v.count>0').all(gid, tid);
        // 總值用「目前行情」計算，跟 /背包 與 /賣出 看到的一致
        const bag = {
          kinds: bagRows.length,
          total: bagRows.reduce((a, r) => a + r.count, 0),
          val: bagRows.reduce((a, r) => a + r.count * livePrice(gid, r), 0)
        };
        // 工具耐久
        const toolLines = Object.keys(KIND_TOOL).map(kind => {
          const t = currentTool(gid, tid, kind);
          const dur = t.durability > 0 ? `耐久 ${t.uses_left ?? t.durability}/${t.durability}` : '不會壞';
          return `${KIND_EMOJI[kind]} ${t.emoji || ''}${t.name}（${dur}）`;
        });
        // 魚缸
        const aqC = guildConfig('aquarium_config', gid);
        const aqU = (db.prepare('SELECT aquarium FROM aquarium_unlocks WHERE guild_id=? AND user_id=?').get(gid, tid) || {}).aquarium || 0;
        const aqMax = Math.max(0, aqC.max_slots) + aqU + fac.facilitySlots(gid, tid, 'aquarium');
        const aq = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(pending),0) p FROM aquarium_slots WHERE guild_id=? AND user_id=?').get(gid, tid);
        // 持股
        const mkC = guildConfig('market_config', gid);
        const hold = db.prepare('SELECT COALESCE(SUM(h.shares),0) sh, COALESCE(SUM(h.shares*s.price),0) val, COUNT(*) c FROM stock_holdings h JOIN stock_symbols s ON s.id=h.symbol_id WHERE h.guild_id=? AND h.user_id=? AND h.shares>0').get(gid, tid);
        const drew = db.prepare('SELECT 1 FROM lottery_draws WHERE guild_id=? AND user_id=? AND day=?').get(gid, tid, today());
        const embed = new EmbedBuilder().setColor(brandColor()).setTitle(`📊 ${target.username} 的冒險狀態`)
          .setThumbnail(target.displayAvatarURL())
          .addFields(
            { name: '💰 星幣', value: `${w.coins.toLocaleString('en-US')}　累計賺 ${w.total_earned.toLocaleString('en-US')}`, inline: false },
            { name: '🎣 今日採集', value: (c.daily_points > 0
                ? `${map ? (map.emoji || '') + map.name : '未選地圖'}　點數 ${Math.max(0, c.daily_points - pointsUsedToday(gid, tid))}/${c.daily_points}${map ? `（門票 ${mapCost(map)} 點／次）` : ''}`
                : (map ? `${map.emoji || ''}${map.name}　${usedToday}/${map.daily_limit} 次` : `已採 ${usedToday} 次`))
              + (buff ? `　🍀幸運符 +${buff}%` : ''), inline: false },
            { name: '🐔 牧場', value: `${animals}/${ranchMax} 隻　🥚 孵化中 ${incubating}/${hatchMax}`, inline: true },
            { name: '🌾 農地 / 🏡 溫室', value: `農地 ${fieldN}/${fieldMax} 株　溫室 ${ghN}/${ghMax} 株`, inline: true },
            { name: '🐠 魚缸', value: `${aq.n}/${aqMax} 條` + (aq.p > 0 ? `　缸裡未領 ${aq.p.toLocaleString('en-US')} 星幣` : ''), inline: true },
            { name: '📈 持股', value: (mkC.stock_enabled ? (hold.sh > 0 ? `${hold.c} 支 共 ${hold.sh.toLocaleString('en-US')} 股　市值約 ${hold.val.toLocaleString('en-US')}` : '目前沒有持股') : '股市未開放'), inline: true },
            { name: '🎒 背包', value: `${bag.kinds} 種 ${bag.total} 個　全賣約 ${bag.val.toLocaleString('en-US')}`, inline: false },
            { name: '🔨 工具', value: toolLines.join('\n'), inline: false },
            { name: '🎲 每日抽籤', value: drew ? '今天已抽 ✅' : '今天還沒抽，快 /抽籤！', inline: false }
          )
          .setFooter({ text: '牧場/農地/溫室/孵化室的格子：/設施商店 買等級，或 /製作 一格一格開' });
        // 有磨損的工具就給修理選單，玩家不用打 /修理 也不用記名字（只有看自己時才給）
        let repairRow = [];
        if (tid === uid) {
          const worn = db.prepare(
            `SELECT t.id, t.name, t.emoji, t.durability, t.price, t.repair_cost, u.uses_left
               FROM gather_tools t JOIN gather_user_tools u ON u.tool_id=t.id
              WHERE t.guild_id=? AND u.guild_id=? AND u.user_id=? AND t.durability>0 AND u.uses_left < t.durability`).all(gid, gid, tid);
          if (worn.length) {
            repairRow = [new ActionRowBuilder().addComponents(
              new StringSelectMenuBuilder().setCustomId('repairpick').setPlaceholder('選要修理的工具')
                .addOptions(worn.slice(0, 25).map(t => ({
                  label: `${t.name}（${t.uses_left}/${t.durability}）`.slice(0, 100),
                  description: `修理費 ${repairCostOf(t)} ${c.currency_name}${t.uses_left <= 0 ? '　⚠️ 已壞掉' : ''}`.slice(0, 100),
                  value: String(t.id), emoji: t.emoji || '🔧'
                })))) ];
          }
        }
        return await reply({ embeds: [embed], components: repairRow });
      }

      // ---- 每日抽籤 ----
      if (name === '抽籤') {
        const day = today();
        const drew = db.prepare('SELECT 1 FROM lottery_draws WHERE guild_id=? AND user_id=? AND day=?').get(gid, uid, day);
        if (drew) {
          const buff = activeLuck(gid, uid);
          return i.reply({ content: `你今天已經抽過了，明天再來！${buff ? `（幸運符生效中 +${buff}%，<t:${Math.floor(endOfTodayMs() / 1000)}:R> 到期）` : ''}`, flags: MessageFlags.Ephemeral });
        }
        // 獎項（權重）由後台設定；預設是星幣為主，偶爾抽到幸運符（當日提升稀有掉落率）
        const PRIZES = prizePool(gid);
        const total = PRIZES.reduce((a, p) => a + p.weight, 0);
        let r = Math.random() * total, prize = PRIZES[0];
        for (const p of PRIZES) { r -= p.weight; if (r <= 0) { prize = p; break; } }

        db.prepare('INSERT OR IGNORE INTO lottery_draws (guild_id,user_id,day) VALUES (?,?,?)').run(gid, uid, day);
        let desc = '';
        if (prize.type === 'coin') {
          const now = addCoins(gid, uid, uname, prize.amount);
          desc = `抽中 ${prize.emoji} **${prize.name}**：${money(c, prize.amount)}！\n餘額 ${now.toLocaleString('en-US')} ${c.currency_name}`;
        } else if (prize.type === 'luck') {
          const exp = endOfTodayMs();
          db.prepare('INSERT INTO luck_buffs (guild_id,user_id,pct,expire_at) VALUES (?,?,?,?) ON CONFLICT(guild_id,user_id) DO UPDATE SET pct=excluded.pct, expire_at=excluded.expire_at').run(gid, uid, prize.pct, exp);
          desc = `抽中 ${prize.emoji} **${prize.name}**：今天採集稀有率 **+${prize.pct}%**！\n有效至 <t:${Math.floor(exp / 1000)}:R>`;
        } else {
          const exp = endOfTodayMs();
          const now = addCoins(gid, uid, uname, prize.amount);
          db.prepare('INSERT INTO luck_buffs (guild_id,user_id,pct,expire_at) VALUES (?,?,?,?) ON CONFLICT(guild_id,user_id) DO UPDATE SET pct=excluded.pct, expire_at=excluded.expire_at').run(gid, uid, prize.pct, exp);
          desc = `🎉 抽中 ${prize.emoji} **${prize.name}**：${money(c, prize.amount)} ＋ 今天稀有率 **+${prize.pct}%**！\n餘額 ${now.toLocaleString('en-US')} ${c.currency_name}`;
        }
        const embed = new EmbedBuilder().setColor(prize.type === 'coin' ? brandColor() : 0xf1c40f)
          .setTitle('🎲 每日抽籤').setDescription(desc)
          .setFooter({ text: '每天可抽一次，幸運符當日有效、會疊加到採集幸運值' });
        return await reply({ embeds: [embed] });
      }

      // ---- 地圖：查看與切換 ----
      if (name === '地圖') {
        const maps = db.prepare('SELECT * FROM gather_maps WHERE guild_id=? AND enabled=1 ORDER BY sort, id').all(gid);
        if (!maps.length) return i.reply({ content: '目前沒有任何地圖，管理員可到後台新增。', flags: MessageFlags.Ephemeral });
        const cur = activeMap(gid, uid);
        const usedToday = totalGathersToday(gid, uid);
        const pool = c.daily_points || 0;
        const left = pool > 0 ? Math.max(0, pool - pointsUsedToday(gid, uid)) : 0;
        const cap = (m) => pool > 0 ? `門票 ${mapCost(m)} 點（今日還能採 ${Math.floor(left / mapCost(m))} 次）` : `每日 ${m.daily_limit} 次`;
        const lines = maps.map(m => `${m.id === (cur && cur.id) ? '📍' : '　'} ${m.emoji || ''}**${m.name}**　${cap(m)}　稀有率 +${m.luck_bonus}%${m.description ? `\n　　${m.description}` : ''}`);
        const embed = new EmbedBuilder().setColor(brandColor()).setTitle('🗺️ 採集地圖')
          .setDescription((pool > 0 ? `你今天還有 **${left}／${pool} 點**採集點數。不同地圖的門票不一樣，越稀有的圖一次扣越多點。\n\n` : '') + lines.join('\n'))
          .setFooter({ text: `目前在：${cur ? (cur.emoji || '') + cur.name : '無'}　今日已採 ${usedToday} 次｜下方可切換` });
        const menu = new StringSelectMenuBuilder().setCustomId('gathermap:pick').setPlaceholder('切換到其他地圖')
          .addOptions(maps.slice(0, 25).map(m => ({
            label: m.name.slice(0, 100),
            description: (pool > 0 ? `門票 ${mapCost(m)} 點　幸運 +${m.luck_bonus}%` : `每日 ${m.daily_limit} 次　幸運 +${m.luck_bonus}%`).slice(0, 100),
            value: String(m.id),
            default: !!(cur && cur.id === m.id)
          })));
        return await reply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] });
      }
    } catch (e) {
      logError(gid, '釣魚挖礦指令失敗：', `${name}（${e.message}）`);
      const msg = { content: '執行失敗，管理員可到後台的系統錯誤紀錄查看原因。', flags: MessageFlags.Ephemeral };
      if (i.replied || i.deferred) await i.followUp(msg).catch(() => {});
      else await i.reply(msg).catch(() => {});
    }
  });

  console.log('  ↳ 釣魚挖礦模組已載入（冷卻/稀有掉落/商店道具/圖鑑/經濟）');
}

module.exports = { init, wallet, addCoins, addToBag, seedGuild, seedMaterials, staminaState, staminaBoughtToday, bumpPoints, addPointsBonus, menuResult, safeMenu, RARITY, RARITY_LABEL };
