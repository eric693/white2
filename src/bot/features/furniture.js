// 家具系統：6 大類 60 種。只有「擺出來」的家具才有加成，收在倉庫沒有效果。
// 加成刻意都很小（1~3%），而且經過 util/buffs.js 封頂，避免家具變成課金式的強度來源。
const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, MessageFlags } = require('discord.js');
const { db, guildConfig, logError } = require('../../db');
const { brandColor } = require('../../util/brand');
const { wallet, addCoins } = require('./gather');
const { BUFF_TYPES } = require('../../util/buffs');
const { seedHome, homeOf, levelDef, bagCount, parseMats, takeItems, NAV } = require('./home');

const gcfg = (gid) => guildConfig('gather_config', gid);
const money = (c, n) => `${c.currency_emoji || '🪙'} ${Number(n).toLocaleString('en-US')} ${c.currency_name || '星幣'}`;

const CATS = {
  living:     '🛋️ 客廳',
  bedroom:    '🛏️ 臥室',
  kitchen:    '🍽️ 餐廳／廚房',
  garden:     '🌳 庭院',
  collection: '🏆 收藏',
  special:    '✨ 角色限定'
};

// [類別, 名稱, emoji, 售價, 需要房屋階, 材料, 加成類型, 加成%, 說明]
const SEED = [
  // 客廳
  ['living', '布沙發', '🛋️', 1200, 1, [['松木', 10], ['羊毛', 5]], '', 0, '坐下來就不想起來'],
  ['living', '木茶几', '🪵', 900, 1, [['橡木', 8]], '', 0, '放茶杯剛剛好'],
  ['living', '地毯', '🧶', 1500, 2, [['羊毛', 15]], '', 0, '踩起來很舒服'],
  ['living', '書櫃', '📚', 2600, 2, [['橡木', 20], ['鐵礦', 4]], '', 0, '看起來很有學問'],
  ['living', '落地燈', '💡', 2000, 2, [['鐵礦', 8], ['碎石', 10]], '', 0, '夜裡的一盞光'],
  ['living', '壁爐', '🔥', 6500, 4, [['碎石', 40], ['煤炭', 25]], 'energy_pct', 2, '冬天的靈魂'],
  ['living', '唱片機', '📻', 9000, 5, [['楓木', 25], ['銀礦', 8]], '', 0, '轉起來就有氣氛'],
  ['living', '展示櫃', '🗄️', 14000, 7, [['檜木', 35], ['銀礦', 15]], 'sell_pct', 1, '把收藏擺出來給人看'],
  ['living', '平面電視', '📺', 18000, 7, [['鐵礦', 30], ['水晶', 6]], '', 0, '追劇必備'],
  ['living', '平台鋼琴', '🎹', 60000, 9, [['紫檀木', 60], ['黑曜石', 20]], 'gift_pct', 2, '會彈琴的人特別討喜'],
  // 臥室
  ['bedroom', '單人床', '🛏️', 1000, 1, [['松木', 12]], '', 0, '睡得著就好'],
  ['bedroom', '床頭櫃', '🗃️', 800, 1, [['松木', 6]], '', 0, '放手機和水杯'],
  ['bedroom', '窗簾', '🪟', 1400, 2, [['羊毛', 10]], '', 0, '擋光也擋視線'],
  ['bedroom', '衣櫃', '🚪', 3200, 3, [['橡木', 25]], '', 0, '衣服總是塞不下'],
  ['bedroom', '雙人床', '🛌', 5500, 3, [['楓木', 20], ['羊毛', 15]], 'energy_pct', 2, '兩個人也睡得下'],
  ['bedroom', '全身鏡', '🪞', 4200, 4, [['鐵礦', 10], ['碎石', 15]], '', 0, '出門前照一下'],
  ['bedroom', '梳妝台', '💄', 7000, 5, [['櫻花木', 22], ['銀礦', 6]], '', 0, '瓶瓶罐罐的歸宿'],
  ['bedroom', '香氛台', '🕯️', 8500, 5, [['薰衣草', 30], ['蜂蜜', 10]], 'energy_pct', 2, '整個房間都是味道'],
  ['bedroom', '豪華大床', '👑', 32000, 8, [['黑檀木', 45], ['羊毛', 40]], 'energy_pct', 3, '體力恢復更快'],
  ['bedroom', '床尾長椅', '🪑', 5000, 6, [['櫻花木', 15], ['羊毛', 8]], '', 0, '放衣服的地方'],
  // 餐廳／廚房
  ['kitchen', '餐桌', '🍽️', 2200, 1, [['橡木', 18]], '', 0, '一家人吃飯的地方'],
  ['kitchen', '餐椅', '🪑', 700, 1, [['松木', 6]], '', 0, '一張一張慢慢湊'],
  ['kitchen', '冰箱', '🧊', 9500, 4, [['鐵礦', 25], ['碎石', 20]], '', 0, '食材放得久一點'],
  ['kitchen', '烤箱', '🔥', 11000, 4, [['鐵礦', 30], ['煤炭', 20]], 'cook_perfect_pct', 1, '烤出來的東西就是不一樣'],
  ['kitchen', '料理台', '🔪', 7500, 4, [['楓木', 20], ['鐵礦', 12]], 'cook_perfect_pct', 1, '切菜終於有地方'],
  ['kitchen', '咖啡機', '☕', 6800, 5, [['鐵礦', 15], ['銀礦', 4]], '', 0, '早上的續命裝置'],
  ['kitchen', '酒櫃', '🍷', 16000, 6, [['檜木', 30], ['水晶', 5]], 'gift_pct', 1, '送禮前先喝一杯'],
  ['kitchen', '茶具櫃', '🍵', 12000, 6, [['櫻花木', 28], ['黏土', 20]], 'gift_pct', 1, '泡茶待客'],
  ['kitchen', '甜點櫃', '🍰', 15000, 7, [['檜木', 25], ['水晶', 6]], 'cook_price_pct', 1, '甜點賣得比較好'],
  ['kitchen', '專業料理台', '👨‍🍳', 48000, 9, [['紫檀木', 50], ['綠寶石', 12]], 'cook_perfect_pct', 2, '完美料理機率提升'],
  // 庭院
  ['garden', '長椅', '🪑', 1800, 6, [['松木', 15], ['碎石', 10]], '', 0, '坐著看院子'],
  ['garden', '花架', '🌸', 2400, 6, [['竹子', 20]], '', 0, '花有地方擺了'],
  ['garden', '路燈', '🏮', 3000, 6, [['鐵礦', 12], ['碎石', 15]], '', 0, '晚上回家看得到路'],
  ['garden', '鞦韆', '🎠', 5200, 6, [['橡木', 25], ['鐵礦', 8]], '', 0, '幼稚但快樂'],
  ['garden', '烤肉架', '🍖', 6000, 6, [['鐵礦', 20], ['煤炭', 15]], 'cook_price_pct', 1, '院子裡的煙火氣'],
  ['garden', '戶外桌椅組', '⛱️', 8000, 7, [['檜木', 25], ['竹子', 20]], '', 0, '在外面吃早餐'],
  ['garden', '噴泉', '⛲', 22000, 7, [['碎石', 60], ['水晶', 8]], '', 0, '水聲很療癒'],
  ['garden', '池塘', '🪷', 26000, 8, [['黏土', 50], ['碎石', 40]], 'fish_price_pct', 1, '養幾條魚在裡面'],
  ['garden', '涼亭', '⛩️', 38000, 8, [['檜木', 55], ['黑檀木', 20]], 'gift_pct', 1, '約會的好地方'],
  ['garden', '溫泉池', '♨️', 75000, 10, [['千年神木', 40], ['硫磺', 60], ['碎石', 80]], 'energy_pct', 3, '泡完全身舒暢'],
  // 收藏
  ['collection', '照片牆', '🖼️', 3500, 5, [['松木', 20]], '', 0, '把回憶掛起來'],
  ['collection', '獎盃櫃', '🏆', 12000, 7, [['橡木', 30], ['金礦', 5]], '', 0, '放你的稱號證明'],
  ['collection', '魚類展示缸', '🐠', 20000, 7, [['碎石', 40], ['水晶', 10]], 'fish_price_pct', 1, '稀有魚看起來更值錢'],
  ['collection', '礦石展示櫃', '💎', 22000, 7, [['鐵礦', 35], ['水晶', 12]], 'mine_rare_pct', 1, '挖到好東西的機率高一點'],
  ['collection', '藝術展示架', '🎨', 18000, 8, [['檜木', 30], ['銀礦', 12]], '', 0, '假裝自己很懂藝術'],
  ['collection', '勳章牆', '🎖️', 25000, 8, [['黑檀木', 25], ['金礦', 10]], '', 0, '一格一格慢慢填滿'],
  ['collection', '古董櫃', '🏺', 30000, 9, [['紫檀木', 35], ['黏土', 40]], 'sell_pct', 1, '越舊越值錢'],
  ['collection', '角色紀念櫃', '💝', 45000, 9, [['櫻花木', 40], ['綠寶石', 10]], 'gift_pct', 2, '放角色送你的東西'],
  ['collection', '寶石展示台', '💠', 68000, 10, [['千年神木', 35], ['鑽石', 5]], 'sell_pct', 2, '閃到睜不開眼'],
  ['collection', '特殊收藏台', '🌟', 120000, 11, [['世界樹枝', 30], ['星辰礦', 10]], 'sell_pct', 2, '只有真正的收藏家才擺得起'],
  // 角色限定
  ['special', '棋桌', '♟️', 14000, 8, [['黑檀木', 20], ['碎石', 30]], 'gift_pct', 1, '陪角色下一盤'],
  ['special', '調酒台', '🍸', 26000, 8, [['檜木', 30], ['水晶', 10]], 'gift_pct', 2, '深夜的談心角落'],
  ['special', '撞球桌', '🎱', 32000, 9, [['紫檀木', 35], ['羊毛', 25]], '', 0, '氣氛一下就熱了'],
  ['special', '辦公桌', '🖥️', 20000, 8, [['黑檀木', 25], ['鐵礦', 20]], 'stock_pct', 1, '看盤專用'],
  ['special', '黑膠唱片機', '💿', 36000, 9, [['紫檀木', 25], ['銀礦', 20]], 'gift_pct', 2, '放一首他喜歡的歌'],
  ['special', '望遠鏡', '🔭', 42000, 10, [['千年神木', 25], ['水晶', 20]], '', 0, '一起看星星'],
  ['special', '壁爐搖椅', '🪑', 30000, 9, [['紫檀木', 30], ['羊毛', 20]], 'energy_pct', 2, '一起發呆一整晚'],
  ['special', '雙人鞦韆', '💑', 55000, 10, [['千年神木', 30], ['金礦', 15]], 'gift_pct', 2, '兩個人剛剛好'],
  ['special', '星光水晶燈', '🔮', 150000, 11, [['世界樹枝', 25], ['鑽石', 8], ['星辰礦', 15]], 'visit_pct', 2, '角色來訪機率提升'],
  ['special', '角色專屬房', '🚪', 400000, 12, [['月光木', 40], ['龍血木', 30], ['隕石', 5]], 'visit_pct', 3, '他真的有自己的房間了'],

  // ---- 用新的基礎素材做的家具 ----
  // 新素材（砂礫、樹皮、羽毛、貝殼…）如果只能賣掉就沒意義，這幾件是它們的主要出海口：
  // 便宜、階級門檻低，新手蓋完房子就做得起。
  ['living', '藤編椅', '🪑', 1400, 2, [['藤蔓', 20], ['樹皮', 12]], 'energy_pct', 1, '夏天坐起來不黏背'],
  ['living', '貝殼風鈴', '🐚', 1100, 2, [['貝殼', 25], ['藤蔓', 8]], 'luck_pct', 1, '風一吹就叮叮噹噹'],
  ['bedroom', '羽毛枕被', '🪶', 2400, 3, [['羽毛', 40], ['獸皮', 10]], 'energy_pct', 2, '一躺下去就不想起來'],
  ['bedroom', '獸皮地墊', '🟫', 2800, 3, [['獸皮', 25], ['骨頭', 10]], 'energy_pct', 1, '踩上去暖暖的'],
  ['garden', '苔蘚盆景', '🍃', 1600, 3, [['苔蘚', 30], ['砂礫', 20]], 'speed_pct', 1, '看著它就靜下來了'],
  ['garden', '石灰岩花台', '🧱', 2200, 3, [['石灰岩', 30], ['野花', 20]], 'gift_pct', 1, '花開得比別人久'],
  ['kitchen', '陶土罐組', '🏺', 2600, 4, [['黏土', 25], ['石英', 15]], 'cook_price_pct', 1, '醃漬保存的老智慧'],
  ['collection', '珊瑚標本', '🪸', 5200, 5, [['珊瑚枝', 20], ['河蜆', 25], ['海帶', 30]], 'fish_price_pct', 1, '從海裡帶回來的一小塊'],
  ['collection', '鹿角掛飾', '🦌', 6000, 5, [['鹿角', 15], ['樹皮', 25]], 'hunt_rare_pct', 1, '獵人家裡的門面'],
  ['special', '松脂香氛燭', '🕯️', 4800, 5, [['松脂', 25], ['蘆葦', 20], ['堅果', 15]], 'gift_pct', 1, '整個房間都是森林的味道']
];

function seedFurniture(gid) {
  try {
    const has = db.prepare('SELECT 1 FROM home_furniture WHERE guild_id=? AND name=?');
    const ins = db.prepare(`INSERT INTO home_furniture
      (guild_id,category,name,emoji,price,materials,min_level,buff_type,buff_pct,description,sort)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    db.transaction(() => {
      SEED.forEach(([cat, name, emoji, price, lv, mats, bt, bp, desc], idx) => {
        if (has.get(gid, name)) return;
        ins.run(gid, cat, name, emoji, price,
          JSON.stringify(mats.map(([item, count]) => ({ item, count }))), lv, bt, bp, desc, idx);
      });
    })();
  } catch (e) { logError(gid, '家具預設建立失敗：', e.message); }
}

const defsOf = (gid, cat) => db.prepare(
  'SELECT * FROM home_furniture WHERE guild_id=? AND enabled=1' + (cat ? ' AND category=?' : '') + ' ORDER BY sort, id')
  .all(...(cat ? [gid, cat] : [gid]));
const ownedOf = (gid, uid) => db.prepare(
  `SELECT o.*, f.name, f.emoji, f.category, f.buff_type, f.buff_pct
     FROM home_furniture_owned o JOIN home_furniture f ON f.id=o.furniture_id
    WHERE o.guild_id=? AND o.user_id=? AND o.count>0 ORDER BY f.sort`).all(gid, uid);
const placedCount = (gid, uid) =>
  db.prepare('SELECT COALESCE(SUM(placed),0) n FROM home_furniture_owned WHERE guild_id=? AND user_id=?').get(gid, uid).n;

/** 買一件家具：檢查房屋階級、金幣、材料 */
function buyFurniture(gid, uid, uname, fid) {
  const f = db.prepare('SELECT * FROM home_furniture WHERE guild_id=? AND id=? AND enabled=1').get(gid, fid);
  if (!f) return { error: '找不到這件家具。' };
  const home = homeOf(gid, uid, uname);
  if (home.level < f.min_level) {
    const need = levelDef(gid, f.min_level);
    return { error: `這件家具要家園 **Lv.${f.min_level}${need ? ' ' + need.name : ''}** 才買得到（你現在 Lv.${home.level}）。` };
  }
  const gc = gcfg(gid);
  const coins = wallet(gid, uid, uname).coins;
  const mats = parseMats(f.materials);
  const missing = [];
  if (coins < f.price) missing.push(`${money(gc, f.price)}（你有 ${coins.toLocaleString('en-US')}）`);
  for (const m of mats) {
    const have = bagCount(gid, uid, m.item);
    if (have < m.count) missing.push(`${m.item} ×${m.count}（你有 ${have}）`);
  }
  if (missing.length) return { error: `材料不夠，還差：\n🔴 ${missing.join('\n🔴 ')}` };
  try {
    db.transaction(() => {
      addCoins(gid, uid, uname, -f.price);
      takeItems(gid, uid, mats);
      db.prepare(`INSERT INTO home_furniture_owned (guild_id,user_id,furniture_id,count,placed)
        VALUES (?,?,?,1,0) ON CONFLICT(guild_id,user_id,furniture_id) DO UPDATE SET count = count + 1`)
        .run(gid, uid, f.id);
    })();
  } catch (e) { return { error: `購買失敗：${e.message}` }; }
  // 圖鑑：買到就記一筆，之後賣掉也不會消失
  try {
    db.prepare('INSERT OR IGNORE INTO dex_seen (guild_id,user_id,cat,key) VALUES (?,?,?,?)').run(gid, uid, 'furniture', f.name);
  } catch {}
  return { bought: f };
}

/** 擺放／收起。只有擺出來的才有加成，而且受房屋階級的家具上限限制。 */
function togglePlace(gid, uid, uname, fid, place) {
  const row = db.prepare('SELECT * FROM home_furniture_owned WHERE guild_id=? AND user_id=? AND furniture_id=?').get(gid, uid, fid);
  if (!row || row.count <= 0) return { error: '你沒有這件家具。' };
  if (!place) {
    if (row.placed <= 0) return { error: '這件家具本來就沒有擺出來。' };
    db.prepare('UPDATE home_furniture_owned SET placed = placed - 1 WHERE guild_id=? AND user_id=? AND furniture_id=?').run(gid, uid, fid);
    return { ok: '已收起來（加成同時失效）。' };
  }
  if (row.placed >= row.count) return { error: '你擁有的這件家具都已經擺出來了。' };
  const home = homeOf(gid, uid, uname);
  const def = levelDef(gid, home.level);
  const cap = def ? def.furniture_cap : 5;
  if (placedCount(gid, uid) >= cap) {
    return { error: `你的家擺不下了（上限 ${cap} 件）。先收起一件，或去 \`/升級家園\` 換更大的房子。` };
  }
  db.prepare('UPDATE home_furniture_owned SET placed = placed + 1 WHERE guild_id=? AND user_id=? AND furniture_id=?').run(gid, uid, fid);
  return { ok: '已擺出來，加成生效！' };
}

// ---- 家具面板（家園面板的「🛋️ 家具」分頁會用同一份） ----
function furniturePanel(gid, uid, uname) {
  const home = homeOf(gid, uid, uname);
  const def = levelDef(gid, home.level) || { furniture_cap: 5 };
  const owned = ownedOf(gid, uid);
  const gc = gcfg(gid);
  const embed = new EmbedBuilder().setColor(brandColor()).setTitle('🛋️ 家具')
    .setDescription(`擺出來的家具才有加成，收在倉庫沒有效果。\n目前擺放：**${placedCount(gid, uid)} / ${def.furniture_cap}** 件`)
    .setFooter({ text: '用下方選單買家具；已擁有的可以擺放或收起' });
  if (owned.length) {
    embed.addFields({
      name: '你的家具',
      value: owned.map(o => `${o.emoji || ''}${o.name} ×${o.count}${o.placed ? `（已擺 ${o.placed}）` : ''}${o.buff_pct ? `　${BUFF_TYPES[o.buff_type]} +${o.buff_pct}%` : ''}`).join('\n').slice(0, 1024)
    });
  }
  const rows = [NAV('furn')];
  // 分類選單：先選類別再列該類的家具，一次最多 25 個
  rows.push(new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('furncat').setPlaceholder('選一個分類看家具')
      .addOptions(Object.entries(CATS).map(([k, v]) => ({ label: v, value: k })))));
  if (owned.length) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('furnplace').setPlaceholder('擺放／收起你的家具')
        .addOptions(owned.slice(0, 25).map(o => ({
          label: `${o.emoji || ''}${o.name}`.slice(0, 100),
          description: o.placed >= o.count ? '全部已擺出 → 點一下收起' : '點一下擺出來',
          value: `${o.furniture_id}:${o.placed >= o.count ? 'off' : 'on'}`
        })))));
  }
  return { embeds: [embed], components: rows };
}

function catPanel(gid, uid, uname, cat) {
  const home = homeOf(gid, uid, uname);
  const list = defsOf(gid, cat);
  const gc = gcfg(gid);
  const embed = new EmbedBuilder().setColor(brandColor()).setTitle(`${CATS[cat] || '家具'}`)
    .setDescription(list.map(f => {
      const lock = home.level < f.min_level ? `🔒 需要家園 Lv.${f.min_level}　` : '';
      const buff = f.buff_pct ? `　⭐ ${BUFF_TYPES[f.buff_type]} +${f.buff_pct}%` : '';
      const mats = parseMats(f.materials).map(m => `${m.item}×${m.count}`).join('、');
      return `${lock}${f.emoji || ''}**${f.name}**　${money(gc, f.price)}${buff}\n　　${mats || '不需材料'}　${f.description}`;
    }).join('\n').slice(0, 4000) || '這個分類還沒有家具。')
    .setFooter({ text: '用下方選單購買（🔒 的要先升級家園）' });
  const buyable = list.filter(f => home.level >= f.min_level).slice(0, 25);
  const rows = [NAV('furn')];
  if (buyable.length) rows.push(new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('furnbuy').setPlaceholder('選一件買下來')
      .addOptions(buyable.map(f => ({
        label: `${f.emoji || ''}${f.name}`.slice(0, 100),
        description: `${f.price.toLocaleString('en-US')} ${gc.currency_name}`.slice(0, 100),
        value: String(f.id)
      })))));
  return { embeds: [embed], components: rows };
}

function init(client) {
  for (const [gid] of client.guilds.cache) {
    try { seedHome(gid); seedFurniture(gid); } catch (e) { logError(gid, '家具初始化失敗：', e.message); }
  }
  client.on('interactionCreate', async (i) => {
    try {
      if (!i.guildId) return;
      const gid = i.guildId, uid = i.user.id, uname = i.user.username;
      const eph = { flags: MessageFlags.Ephemeral };

      if (i.isStringSelectMenu() && i.customId === 'furncat') {
        return i.update(catPanel(gid, uid, uname, i.values[0])).catch(() => {});
      }
      if (i.isStringSelectMenu() && i.customId === 'furnbuy') {
        const out = buyFurniture(gid, uid, uname, parseInt(i.values[0], 10));
        if (out.error) return i.reply({ content: out.error, ...eph }).catch(() => {});
        await i.update(furniturePanel(gid, uid, uname)).catch(() => {});
        return i.followUp({ content: `🎉 買下了 ${out.bought.emoji || ''}**${out.bought.name}**！記得從選單把它擺出來才有加成。`, ...eph }).catch(() => {});
      }
      if (i.isStringSelectMenu() && i.customId === 'furnplace') {
        const [fid, act] = i.values[0].split(':');
        const out = togglePlace(gid, uid, uname, parseInt(fid, 10), act === 'on');
        if (out.error) return i.reply({ content: out.error, ...eph }).catch(() => {});
        await i.update(furniturePanel(gid, uid, uname)).catch(() => {});
        return i.followUp({ content: out.ok, ...eph }).catch(() => {});
      }
      if (i.isChatInputCommand() && i.commandName === '家具') {
        seedFurniture(gid);
        return i.reply({ ...furniturePanel(gid, uid, uname), ...eph }).catch(() => {});
      }
    } catch (e) {
      logError(i.guildId, '家具指令失敗：', e.message);
      const msg = { content: '執行失敗，管理員可到後台的系統錯誤紀錄查看原因。', flags: MessageFlags.Ephemeral };
      if (i.replied || i.deferred) await i.followUp(msg).catch(() => {}); else await i.reply(msg).catch(() => {});
    }
  });
  console.log('  ↳ 家具模組已載入（6 大類 60 種）');
}

module.exports = { init, seedFurniture, furniturePanel, CATS };
