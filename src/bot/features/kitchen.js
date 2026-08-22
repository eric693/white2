// 廚房與料理：房屋 Lv.4 取得資格，但廚房仍要自己出材料蓋，蓋完再練 10 級。
//
// 料理有 5 種品質（普通／精良／稀有／史詩／傳說），品質同時影響售價、Buff 強度、送禮好感。
// 品質在「下鍋當下」就擲好並存進 cook_queue，領取時才揭曉 —— 避免玩家看到結果才決定要不要領。
const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { db, guildConfig, logError } = require('../../db');
const { bump: bumpAch } = require('../../util/achievements');
const { brandColor } = require('../../util/brand');
const { wallet, addCoins } = require('./gather');
const { BUFF_TYPES, buffPct, grantBuff, applyBuff } = require('../../util/buffs');
const { seedHome, homeOf, levelDef, bagCount, parseMats, takeItems, NAV } = require('./home');

const gcfg = (gid) => guildConfig('gather_config', gid);
const money = (c, n) => `${c.currency_emoji || '🪙'} ${Number(n).toLocaleString('en-US')} ${c.currency_name || '星幣'}`;

// 品質：名稱、emoji、售價倍率、好感倍率、基礎出現權重
const QUALITY = [
  { name: '普通', emoji: '⚪', price: 1.0, aff: 1.0, weight: 550 },
  { name: '精良', emoji: '🟢', price: 1.4, aff: 1.3, weight: 250 },
  { name: '稀有', emoji: '🔵', price: 2.0, aff: 1.6, weight: 120 },
  { name: '史詩', emoji: '🟣', price: 3.0, aff: 2.0, weight: 60 },
  { name: '傳說', emoji: '🟠', price: 5.0, aff: 3.0, weight: 20 }
];
const qLabel = (q) => `${QUALITY[q].emoji}${QUALITY[q].name}`;

// 廚房 10 級：[級, 名稱, emoji, 金幣, 材料, 完美加成%, 說明]
// 「完美加成」會把權重往高品質推，等級越高越容易做出好料理。
const SEED_KITCHEN = [
  [1, '簡易廚房', '🍳', 10000, [['松木', 100], ['碎石', 80], ['鐵礦', 30]], 0, '一口鍋、一個爐，夠用了'],
  [2, '家庭廚房', '🥘', 25000, [['橡木', 120], ['鐵礦', 50]], 2, '終於有像樣的流理台'],
  [3, '完整廚房', '🍲', 55000, [['竹子', 150], ['鐵礦', 80], ['黏土', 60]], 4, '該有的都有了'],
  [4, '精緻廚房', '🍱', 100000, [['楓木', 180], ['銀礦', 40]], 6, '開始講究擺盤'],
  [5, '專業廚房', '👨‍🍳', 180000, [['櫻花木', 200], ['銀礦', 80], ['黑曜石', 40]], 9, '可以接單的程度'],
  [6, '高級料理室', '🍽️', 300000, [['檜木', 220], ['金礦', 50]], 12, '食材都用最好的'],
  [7, '主廚廚房', '🔪', 480000, [['黑檀木', 250], ['金礦', 90], ['水晶', 40]], 15, '你就是主廚'],
  [8, '星級廚房', '⭐', 750000, [['紫檀木', 280], ['水晶', 90], ['綠寶石', 40]], 19, '米其林等級'],
  [9, '皇家廚房', '👑', 1200000, [['千年神木', 300], ['綠寶石', 100], ['鑽石', 20]], 23, '專為王室服務'],
  [10, '傳說料理室', '🌟', 2000000, [['世界樹枝', 250], ['龍血木', 150], ['鑽石', 50], ['星辰礦', 30]], 28, '傳說中的廚房']
];

// 食譜：[名稱, emoji, 需要廚房級, 材料, 分鐘, 基礎售價, 基礎好感, buff類型, buff%, buff分鐘, 說明]
const SEED_RECIPES = [
  ['烤地瓜', '🍠', 1, [['馬鈴薯', 3]], 10, 40, 4, '', 0, 0, '最樸實的暖胃小點'],
  ['番茄湯', '🍅', 1, [['番茄', 3], ['野草', 1]], 12, 50, 5, 'energy_pct', 2, 60, '酸酸甜甜'],
  ['水煮蛋', '🥚', 1, [['雞蛋', 3]], 8, 35, 4, '', 0, 0, '簡單但不會出錯'],
  ['烤玉米', '🌽', 1, [['玉米', 2], ['煤炭', 1]], 12, 55, 5, '', 0, 0, '夜市的味道'],
  ['蔬菜沙拉', '🥗', 2, [['番茄', 2], ['紅蘿蔔', 2], ['蕨葉', 2]], 15, 80, 7, 'energy_pct', 3, 90, '健康取向'],
  ['蘑菇濃湯', '🍄', 2, [['蘑菇', 4], ['牛奶', 2]], 20, 110, 9, 'energy_pct', 3, 120, '濃郁順口'],
  ['鮮魚湯', '🐟', 2, [['吳郭魚', 2], ['野草', 2]], 18, 95, 8, 'fish_rare_pct', 2, 120, '喝完想再去釣魚'],
  ['蜂蜜鬆餅', '🥞', 3, [['小麥', 4], ['雞蛋', 2], ['蜂蜜', 2]], 25, 160, 12, '', 0, 0, '早午餐首選'],
  ['奶油蘑菇燉飯', '🍚', 3, [['小麥', 5], ['蘑菇', 3], ['牛奶', 3]], 30, 220, 15, 'cook_price_pct', 2, 120, '一碗就飽'],
  ['烤章魚串', '🐙', 3, [['章魚', 2], ['辣椒', 2]], 25, 200, 14, '', 0, 0, '配酒剛好'],
  ['草莓塔', '🍓', 4, [['草莓', 5], ['小麥', 3], ['牛奶', 2]], 35, 300, 20, 'gift_pct', 3, 180, '送禮很加分'],
  ['山葵鰻魚飯', '🍱', 4, [['鰻魚', 2], ['山葵', 2], ['小麥', 3]], 40, 380, 24, '', 0, 0, '嗆得剛剛好'],
  ['香草牛排', '🥩', 5, [['山羌', 1], ['藥草', 3], ['羊奶', 1]], 45, 520, 30, 'sell_pct', 3, 180, '經典中的經典'],
  ['蟹肉濃湯', '🦀', 5, [['螃蟹', 3], ['牛奶', 3], ['小麥', 2]], 45, 480, 28, '', 0, 0, '鮮味十足'],
  ['松露燉鹿肉', '🦌', 6, [['鹿', 1], ['松露', 2], ['藥草', 3]], 60, 900, 45, 'sell_pct', 4, 240, '奢侈的一餐'],
  ['龍蝦義大利麵', '🦞', 6, [['龍蝦', 2], ['小麥', 5], ['牛奶', 2]], 60, 1000, 48, 'cook_price_pct', 3, 240, '節慶才做'],
  ['靈芝藥膳鍋', '🍲', 7, [['靈芝', 2], ['棕熊', 1], ['藥草', 5]], 75, 1500, 60, 'energy_pct', 5, 300, '補到說不出話'],
  ['旗魚生魚片', '🍣', 7, [['旗魚', 2], ['山葵', 3]], 70, 1400, 58, 'fish_price_pct', 3, 240, '刀工見真章'],
  ['黑豹戰斧排', '🍖', 8, [['黑豹', 1], ['松露', 3], ['辣椒', 5]], 90, 2400, 80, 'sell_pct', 5, 300, '氣勢驚人'],
  ['鯊魚翅羹', '🦈', 8, [['鯊魚', 1], ['靈芝', 2], ['小麥', 5]], 90, 2600, 85, '', 0, 0, '宴客用的排場'],
  ['幼龍炙燒排', '🐲', 9, [['幼龍', 1], ['曼陀羅', 3], ['硫磺', 10]], 120, 5000, 140, 'mine_rare_pct', 4, 360, '傳說中的火候'],
  ['鳳凰羽湯', '🔥', 9, [['鳳凰羽', 1], ['靈芝', 3], ['月光花', 2]], 120, 5400, 150, 'energy_pct', 6, 360, '喝完像重生'],
  ['星辰料理', '🌌', 10, [['獨角獸', 1], ['星辰花', 2], ['月光花', 3], ['隕石', 1]], 180, 12000, 300, 'gift_pct', 6, 480, '據說吃過的人都戀愛了'],
  ['人魚之淚凍', '🧊', 10, [['美人魚', 1], ['四葉幸運草', 3], ['水晶', 5]], 180, 11000, 280, 'fish_rare_pct', 6, 480, '美得捨不得吃']
];

function seedKitchen(gid) {
  try {
    if (!db.prepare('SELECT 1 FROM kitchen_levels WHERE guild_id=? LIMIT 1').get(gid)) {
      const ins = db.prepare('INSERT INTO kitchen_levels (guild_id,level,name,emoji,coins,materials,perfect_pct,description) VALUES (?,?,?,?,?,?,?,?)');
      db.transaction(() => {
        for (const [lv, name, emoji, coins, mats, perfect, desc] of SEED_KITCHEN)
          ins.run(gid, lv, name, emoji, coins, JSON.stringify(mats.map(([item, count]) => ({ item, count }))), perfect, desc);
      })();
    }
    {
      const has = db.prepare('SELECT 1 FROM cook_recipes WHERE guild_id=? AND name=?');
      const ins = db.prepare(`INSERT INTO cook_recipes
        (guild_id,name,emoji,min_kitchen,materials,cook_minutes,base_price,affinity_base,buff_type,buff_pct,buff_minutes,description,sort)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      db.transaction(() => {
        SEED_RECIPES.forEach(([name, emoji, mk, mats, mins, price, aff, bt, bp, bm, desc], idx) => {
          if (has.get(gid, name)) return;
          ins.run(gid, name, emoji, mk, JSON.stringify(mats.map(([item, count]) => ({ item, count }))), mins, price, aff, bt, bp, bm, desc, idx);
        });
      })();
    }
  } catch (e) { logError(gid, '廚房預設建立失敗：', e.message); }
}

const kLevel = (gid, lv) => db.prepare('SELECT * FROM kitchen_levels WHERE guild_id=? AND level=?').get(gid, lv);
const kMax = (gid) => (db.prepare('SELECT MAX(level) m FROM kitchen_levels WHERE guild_id=?').get(gid) || {}).m || 1;
const recipesOf = (gid) => db.prepare('SELECT * FROM cook_recipes WHERE guild_id=? AND enabled=1 ORDER BY min_kitchen, sort, id').all(gid);
// 同時能煮幾道＝廚房等級（Lv.1 一次一道，Lv.10 十道）
const potSlots = (home) => Math.max(1, home.kitchen_level);

/** 擲品質。廚房等級與「完美料理機率」加成會把權重往高品質推。 */
function rollQuality(gid, uid, home) {
  const k = kLevel(gid, home.kitchen_level);
  const boost = (k ? k.perfect_pct : 0) + buffPct(gid, uid, 'cook_perfect_pct');
  // boost 每 1% 就把高品質權重放大 3%，普通品質相對縮小
  const w = QUALITY.map((q, idx) => idx === 0 ? q.weight : q.weight * (1 + boost * 0.03));
  const total = w.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let idx = 0; idx < w.length; idx++) { r -= w[idx]; if (r <= 0) return idx; }
  return 0;
}

/** 蓋廚房（房屋 Lv.4 才有資格，材料仍要自備） */
function buildKitchen(gid, uid, uname) {
  const home = homeOf(gid, uid, uname);
  if (home.kitchen_built) return { error: '你已經有廚房了。' };
  const def = levelDef(gid, home.level);
  if (!def || !def.kitchen_ok) return { error: '你的房子還不能蓋廚房，需要家園 **Lv.4 精緻平房**。先去 `/升級家園`。' };
  const k = kLevel(gid, 1);
  const gc = gcfg(gid);
  const mats = parseMats(k.materials);
  const coins = wallet(gid, uid, uname).coins;
  const missing = [];
  if (coins < k.coins) missing.push(`${money(gc, k.coins)}（你有 ${coins.toLocaleString('en-US')}）`);
  for (const m of mats) { const have = bagCount(gid, uid, m.item); if (have < m.count) missing.push(`${m.item} ×${m.count}（你有 ${have}）`); }
  if (missing.length) return { error: `蓋廚房的材料還不夠：\n🔴 ${missing.join('\n🔴 ')}` };
  db.transaction(() => {
    addCoins(gid, uid, uname, -k.coins);
    takeItems(gid, uid, mats);
    db.prepare('UPDATE home_users SET kitchen_built=1, kitchen_level=1 WHERE guild_id=? AND user_id=?').run(gid, uid);
  })();
  return { built: k };
}

/** 升級廚房 */
function upgradeKitchen(gid, uid, uname) {
  const home = homeOf(gid, uid, uname);
  if (!home.kitchen_built) return { error: '你還沒有廚房，先蓋一間。' };
  if (home.kitchen_level >= kMax(gid)) return { error: '你的廚房已經是最高級了。' };
  const k = kLevel(gid, home.kitchen_level + 1);
  const gc = gcfg(gid);
  const mats = parseMats(k.materials);
  const coins = wallet(gid, uid, uname).coins;
  const missing = [];
  if (coins < k.coins) missing.push(`${money(gc, k.coins)}（你有 ${coins.toLocaleString('en-US')}）`);
  for (const m of mats) { const have = bagCount(gid, uid, m.item); if (have < m.count) missing.push(`${m.item} ×${m.count}（你有 ${have}）`); }
  if (missing.length) return { error: `升級材料還不夠：\n🔴 ${missing.join('\n🔴 ')}` };
  db.transaction(() => {
    addCoins(gid, uid, uname, -k.coins);
    takeItems(gid, uid, mats);
    db.prepare('UPDATE home_users SET kitchen_level=? WHERE guild_id=? AND user_id=?').run(k.level, gid, uid);
  })();
  return { upgraded: k };
}

/** 下鍋 */
function startCook(gid, uid, uname, recipeId) {
  const home = homeOf(gid, uid, uname);
  if (!home.kitchen_built) return { error: '你還沒有廚房。' };
  const r = db.prepare('SELECT * FROM cook_recipes WHERE guild_id=? AND id=? AND enabled=1').get(gid, recipeId);
  if (!r) return { error: '找不到這道食譜。' };
  if (home.kitchen_level < r.min_kitchen) return { error: `這道菜需要廚房 **Lv.${r.min_kitchen}**（你現在 Lv.${home.kitchen_level}）。` };
  const busy = db.prepare('SELECT COUNT(*) n FROM cook_queue WHERE guild_id=? AND user_id=?').get(gid, uid).n;
  const slots = potSlots(home);
  if (busy >= slots) return { error: `你的爐子都在用（${busy}/${slots}）。等料理好了再下鍋，或升級廚房增加同時烹飪數。` };
  const mats = parseMats(r.materials);
  const missing = [];
  for (const m of mats) { const have = bagCount(gid, uid, m.item); if (have < m.count) missing.push(`${m.item} ×${m.count}（你有 ${have}）`); }
  if (missing.length) return { error: `材料不夠：\n🔴 ${missing.join('\n🔴 ')}` };
  const quality = rollQuality(gid, uid, home);
  const readyAt = Date.now() + r.cook_minutes * 60000;
  db.transaction(() => {
    takeItems(gid, uid, mats);
    db.prepare('INSERT INTO cook_queue (guild_id,user_id,recipe_id,slot,ready_at,quality) VALUES (?,?,?,?,?,?)')
      .run(gid, uid, r.id, busy, readyAt, quality);
  })();
  return { started: r, readyAt };
}

/** 領取煮好的料理（品質此時才揭曉） */
function collectCooked(gid, uid) {
  const now = Date.now();
  const done = db.prepare('SELECT * FROM cook_queue WHERE guild_id=? AND user_id=? AND ready_at<=?').all(gid, uid, now);
  if (!done.length) return { none: true };
  const got = [];
  db.transaction(() => {
    for (const q of done) {
      const r = db.prepare('SELECT * FROM cook_recipes WHERE guild_id=? AND id=?').get(gid, q.recipe_id);
      db.prepare('DELETE FROM cook_queue WHERE id=?').run(q.id);
      if (!r) continue;
      db.prepare(`INSERT INTO cook_inventory (guild_id,user_id,recipe_id,quality,count) VALUES (?,?,?,?,1)
        ON CONFLICT(guild_id,user_id,recipe_id,quality) DO UPDATE SET count = count + 1`).run(gid, uid, r.id, q.quality);
      db.prepare('INSERT OR IGNORE INTO dex_seen (guild_id,user_id,cat,key) VALUES (?,?,?,?)').run(gid, uid, 'cook', r.name);
      got.push({ r, q: q.quality });
      bumpAch(gid, uid, 'cook_count', 1);
      if (q.quality >= 4) bumpAch(gid, uid, 'cook_perfect', 1);   // 4＝🟠傳說，最高品質
    }
  })();
  return { got };
}

/** 吃掉一份料理 → 取得暫時 Buff */
function eatDish(gid, uid, recipeId, quality) {
  const row = db.prepare('SELECT count FROM cook_inventory WHERE guild_id=? AND user_id=? AND recipe_id=? AND quality=?').get(gid, uid, recipeId, quality);
  if (!row || row.count <= 0) return { error: '你沒有這份料理。' };
  const r = db.prepare('SELECT * FROM cook_recipes WHERE guild_id=? AND id=?').get(gid, recipeId);
  if (!r) return { error: '找不到這道料理。' };
  if (!r.buff_type || !r.buff_pct) return { error: `${r.name} 吃了很好吃，但不會給任何加成 —— 拿去賣或送人比較實在。` };
  const pct = Math.max(1, Math.round(r.buff_pct * QUALITY[quality].aff));
  db.prepare('UPDATE cook_inventory SET count = count - 1 WHERE guild_id=? AND user_id=? AND recipe_id=? AND quality=?').run(gid, uid, recipeId, quality);
  grantBuff(gid, uid, r.buff_type, pct, `${r.name}（${QUALITY[quality].name}）`, r.buff_minutes);
  return { ate: r, pct, minutes: r.buff_minutes, quality };
}

/** 賣掉料理（吃 sell_pct 與 cook_price_pct 兩種加成） */
function sellDish(gid, uid, uname, recipeId, quality) {
  const row = db.prepare('SELECT count FROM cook_inventory WHERE guild_id=? AND user_id=? AND recipe_id=? AND quality=?').get(gid, uid, recipeId, quality);
  if (!row || row.count <= 0) return { error: '你沒有這份料理。' };
  const r = db.prepare('SELECT * FROM cook_recipes WHERE guild_id=? AND id=?').get(gid, recipeId);
  const base = Math.round(r.base_price * QUALITY[quality].price);
  const price = applyBuff(base, buffPct(gid, uid, 'sell_pct') + buffPct(gid, uid, 'cook_price_pct'));
  db.transaction(() => {
    db.prepare('UPDATE cook_inventory SET count = count - 1 WHERE guild_id=? AND user_id=? AND recipe_id=? AND quality=?').run(gid, uid, recipeId, quality);
    addCoins(gid, uid, uname, price);
  })();
  return { sold: r, price, quality };
}

// ---- 廚房面板 ----
function kitchenPanel(gid, uid, uname) {
  const home = homeOf(gid, uid, uname);
  const gc = gcfg(gid);
  const rows = [NAV('kitchen')];

  if (!home.kitchen_built) {
    const def = levelDef(gid, home.level);
    const k = kLevel(gid, 1);
    const can = def && def.kitchen_ok;
    const mats = parseMats(k.materials).map(m => {
      const have = bagCount(gid, uid, m.item);
      return `${have >= m.count ? '🟢' : '🔴'} ${m.item} ×${m.count}（你有 ${have}）`;
    });
    const coins = wallet(gid, uid, uname).coins;
    const embed = new EmbedBuilder().setColor(brandColor()).setTitle('🍳 你還沒有廚房')
      .setDescription(can
        ? '你的房子已經有廚房建造資格了，但廚房要**自己出材料蓋**。'
        : '需要家園 **Lv.4 精緻平房** 才能取得廚房建造資格。先去 `/升級家園`。')
      .addFields({ name: '建造基礎廚房', value: `${coins >= k.coins ? '🟢' : '🔴'} ${money(gc, k.coins)}（你有 ${coins.toLocaleString('en-US')}）\n${mats.join('\n')}` });
    if (can) rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('kbuild').setLabel('🔨 蓋廚房').setStyle(ButtonStyle.Success)));
    return { embeds: [embed], components: rows };
  }

  const k = kLevel(gid, home.kitchen_level);
  const cooking = db.prepare('SELECT * FROM cook_queue WHERE guild_id=? AND user_id=? ORDER BY ready_at').all(gid, uid);
  const now = Date.now();
  const ready = cooking.filter(c => c.ready_at <= now).length;
  const inv = db.prepare(
    `SELECT c.recipe_id, c.quality, c.count, r.name, r.emoji FROM cook_inventory c
       JOIN cook_recipes r ON r.id=c.recipe_id
      WHERE c.guild_id=? AND c.user_id=? AND c.count>0 ORDER BY r.sort, c.quality DESC`).all(gid, uid);

  const embed = new EmbedBuilder().setColor(brandColor())
    .setTitle(`${k.emoji || '🍳'} ${k.name}｜Lv.${home.kitchen_level}`)
    .setDescription(`*${k.description}*\n同時可烹飪：**${cooking.length} / ${potSlots(home)}** 鍋${k.perfect_pct ? `　完美料理機率 +${k.perfect_pct}%` : ''}`);

  if (cooking.length) embed.addFields({
    name: '🔥 烹飪中',
    value: cooking.map(c => {
      const r = db.prepare('SELECT name, emoji FROM cook_recipes WHERE id=?').get(c.recipe_id) || { name: '？' };
      const left = Math.max(0, Math.ceil((c.ready_at - now) / 60000));
      return `${r.emoji || ''}${r.name}　${c.ready_at <= now ? '✅ 可領取' : `還要 ${left} 分`}`;
    }).join('\n').slice(0, 1024)
  });
  if (inv.length) embed.addFields({
    name: '🍽️ 你的料理',
    value: inv.map(d => `${qLabel(d.quality)}　${d.emoji || ''}${d.name} ×${d.count}`).join('\n').slice(0, 1024)
  });
  embed.setFooter({ text: '料理品質越高，售價、Buff、送禮好感都越高' });

  const btns = new ActionRowBuilder();
  if (ready) btns.addComponents(new ButtonBuilder().setCustomId('kcollect').setLabel(`✅ 領取 ${ready} 道`).setStyle(ButtonStyle.Success));
  btns.addComponents(new ButtonBuilder().setCustomId('kup').setLabel('⬆️ 升級廚房').setStyle(ButtonStyle.Secondary));
  rows.push(btns);

  const avail = recipesOf(gid).filter(r => r.min_kitchen <= home.kitchen_level).slice(0, 25);
  if (avail.length) rows.push(new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('kcook').setPlaceholder('選一道菜下鍋')
      .addOptions(avail.map(r => ({
        label: `${r.emoji || ''}${r.name}`.slice(0, 100),
        description: `${parseMats(r.materials).map(m => `${m.item}×${m.count}`).join('、')}｜${r.cook_minutes}分`.slice(0, 100),
        value: String(r.id)
      })))));
  if (inv.length) rows.push(new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('kdish').setPlaceholder('處理做好的料理（吃掉／賣掉）')
      .addOptions(inv.slice(0, 25).map(d => ({
        label: `${qLabel(d.quality)} ${d.emoji || ''}${d.name}`.slice(0, 100),
        description: `持有 ${d.count}　選了會問你要吃還是賣`.slice(0, 100),
        value: `${d.recipe_id}:${d.quality}`
      })))));
  return { embeds: [embed], components: rows };
}

function init(client) {
  for (const [gid] of client.guilds.cache) {
    try { seedHome(gid); seedKitchen(gid); } catch (e) { logError(gid, '廚房初始化失敗：', e.message); }
  }
  client.on('interactionCreate', async (i) => {
    try {
      if (!i.guildId) return;
      const gid = i.guildId, uid = i.user.id, uname = i.user.username;
      const eph = { flags: MessageFlags.Ephemeral };
      const refresh = () => i.update(kitchenPanel(gid, uid, uname)).catch(() => {});

      if (i.isButton() && i.customId === 'kbuild') {
        const out = buildKitchen(gid, uid, uname);
        if (out.error) return i.reply({ content: out.error, ...eph }).catch(() => {});
        await refresh();
        return i.followUp({ content: `🎉 廚房蓋好了！**${out.built.name}**　現在可以開始做菜了。`, ...eph }).catch(() => {});
      }
      if (i.isButton() && i.customId === 'kup') {
        const out = upgradeKitchen(gid, uid, uname);
        if (out.error) return i.reply({ content: out.error, ...eph }).catch(() => {});
        await refresh();
        return i.followUp({ content: `🎉 廚房升級成 **Lv.${out.upgraded.level} ${out.upgraded.emoji || ''}${out.upgraded.name}**！\n完美料理機率 +${out.upgraded.perfect_pct}%，同時可烹飪 ${out.upgraded.level} 鍋。`, ...eph }).catch(() => {});
      }
      if (i.isButton() && i.customId === 'kcollect') {
        const out = collectCooked(gid, uid);
        if (out.none) return i.reply({ content: '沒有煮好的料理可以領。', ...eph }).catch(() => {});
        await refresh();
        return i.followUp({
          content: `🍽️ 領取完成：\n${out.got.map(g => `${qLabel(g.q)}　${g.r.emoji || ''}**${g.r.name}**`).join('\n')}`,
          ...eph
        }).catch(() => {});
      }
      if (i.isStringSelectMenu() && i.customId === 'kcook') {
        const out = startCook(gid, uid, uname, parseInt(i.values[0], 10));
        if (out.error) return i.reply({ content: out.error, ...eph }).catch(() => {});
        await refresh();
        return i.followUp({ content: `🔥 ${out.started.emoji || ''}**${out.started.name}** 下鍋了，${out.started.cook_minutes} 分鐘後回來領。品質要領取時才知道。`, ...eph }).catch(() => {});
      }
      if (i.isStringSelectMenu() && i.customId === 'kdish') {
        const [rid, q] = i.values[0].split(':').map(Number);
        const r = db.prepare('SELECT name, emoji FROM cook_recipes WHERE id=?').get(rid) || { name: '料理' };
        return i.reply({
          content: `要怎麼處理 ${qLabel(q)} ${r.emoji || ''}**${r.name}**？`,
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`keat:${rid}:${q}`).setLabel('🍴 吃掉（拿 Buff）').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`ksell:${rid}:${q}`).setLabel('💰 賣掉').setStyle(ButtonStyle.Secondary))],
          ...eph
        }).catch(() => {});
      }
      if (i.isButton() && (i.customId.startsWith('keat:') || i.customId.startsWith('ksell:'))) {
        const [act, rid, q] = i.customId.split(':');
        if (act === 'keat') {
          const out = eatDish(gid, uid, Number(rid), Number(q));
          if (out.error) return i.update({ content: out.error, components: [] }).catch(() => {});
          return i.update({
            content: `🍴 你吃掉了 ${qLabel(out.quality)} **${out.ate.name}**\n⭐ ${BUFF_TYPES[out.ate.buff_type]} **+${out.pct}%**，持續 ${out.minutes} 分鐘。`,
            components: []
          }).catch(() => {});
        }
        const out = sellDish(gid, uid, uname, Number(rid), Number(q));
        if (out.error) return i.update({ content: out.error, components: [] }).catch(() => {});
        return i.update({ content: `💰 賣掉 ${qLabel(out.quality)} **${out.sold.name}**，入帳 ${money(gcfg(gid), out.price)}。`, components: [] }).catch(() => {});
      }
      if (i.isChatInputCommand() && ['廚房', '烹飪'].includes(i.commandName)) {
        seedKitchen(gid);
        return i.reply({ ...kitchenPanel(gid, uid, uname), ...eph }).catch(() => {});
      }
    } catch (e) {
      logError(i.guildId, '廚房指令失敗：', e.message);
      const msg = { content: '執行失敗，管理員可到後台的系統錯誤紀錄查看原因。', flags: MessageFlags.Ephemeral };
      if (i.replied || i.deferred) await i.followUp(msg).catch(() => {}); else await i.reply(msg).catch(() => {});
    }
  });
  console.log('  ↳ 廚房模組已載入（10 級廚房／24 道食譜／5 種品質）');
}

module.exports = { init, seedKitchen, kitchenPanel, QUALITY, qLabel };
