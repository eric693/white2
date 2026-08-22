// 家園系統核心：房屋 15 階，是廚房／家具／寵物／好感度的共同前提。
//
// 設計主軸：升級不能只靠錢。每一階都吃「當階對應的木材＋礦石」，
// 所以伐木與挖礦（原本只是賣錢）突然變成長期主線。
// 所有加成一律經過 util/buffs.js 結算，這裡不自己算。
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { db, guildConfig, logError } = require('../../db');
const { brandColor } = require('../../util/brand');
const { wallet, addCoins } = require('./gather');
const { userBuffs, BUFF_TYPES } = require('../../util/buffs');
const { localToday, localWeekStart } = require('../../util/time');
const { PUBLIC_URL } = require('../../util/url');
const { homeToken } = require('../../routes/homepage');
const { AttachmentBuilder } = require('discord.js');
const { makeHomeCard } = require('../../util/homecard');

const hcfg = (gid) => guildConfig('home_config', gid);
const gcfg = (gid) => guildConfig('gather_config', gid);
const money = (c, n) => `${c.currency_emoji || '🪙'} ${Number(n).toLocaleString('en-US')} ${c.currency_name || '星幣'}`;

// ---- 15 階房屋。材料全部用你們現有的木材／礦石，玩家湊得到才有意義。----
// [階, 名稱, emoji, 解鎖內容, 金幣, 材料, 家具上限, 寵物上限, 可蓋廚房, 角色可來訪, 家園加成%]
const SEED_LEVELS = [
  // [階, 名稱, emoji, 解鎖說明, 金幣, 材料, 家具上限, 寵物上限, 可蓋廚房, 可同居, 家園加成%]
  // 家具是「每階再 +N」累加上去的，滿級剛好 100 件；寵物在 Lv.3/7/13 各 +1（上限 3），
  // 同居在 Lv.6/8/12 各 +1（上限 3，實際名額看 home_config 的門檻）。
  [1, '破舊小屋', '🛖', '家具擺放開啟（+5）', 0, [], 5, 0, 0, 0, 0],
  [2, '溫馨木屋', '🏠', '家具上限 +3', 3000, [['松木', 80], ['碎石', 60]], 8, 0, 0, 0, 1],
  [3, '鄉間住宅', '🏡', '寵物入住 +1、家具上限 +4', 8000, [['橡木', 120], ['黏土', 80], ['煤炭', 50]], 12, 1, 0, 0, 2],
  [4, '精緻平房', '🏠', '廚房功能開啟、家具上限 +4', 20000, [['竹子', 150], ['鐵礦', 60], ['碎石', 100]], 16, 1, 1, 0, 3],
  [5, '雙層住宅', '🏘️', '家具上限 +4', 45000, [['楓木', 200], ['鐵礦', 120], ['黑曜石', 50]], 20, 1, 1, 0, 4],
  [6, '花園別墅', '🌳', '角色同居 +1、家具上限 +5', 90000, [['櫻花木', 250], ['銀礦', 100], ['硫磺', 80]], 25, 1, 1, 1, 5],
  [7, '高級公寓', '🏢', '寵物入住 +1、家具上限 +5', 170000, [['檜木', 300], ['銀礦', 150], ['金礦', 40]], 30, 2, 1, 1, 6],
  [8, '獨棟豪宅', '🏰', '角色同居 +1、家具上限 +5', 320000, [['黑檀木', 350], ['金礦', 100], ['水晶', 60]], 35, 2, 1, 1, 8],
  [9, '湖畔豪邸', '🌊', '家具上限 +5', 550000, [['紫檀木', 400], ['水晶', 120], ['綠寶石', 80]], 40, 2, 1, 1, 10],
  [10, '私人莊園', '🏛️', '家具上限 +5', 900000, [['千年神木', 450], ['綠寶石', 150], ['鑽石', 30]], 45, 2, 1, 1, 12],
  [11, '星光城堡', '🏰', '家具上限 +5', 1500000, [['世界樹枝', 300], ['龍血木', 200], ['鑽石', 60], ['星辰礦', 40]], 50, 2, 1, 1, 15],
  [12, '星耀領地', '🌌', '角色同居 +1、家具上限 +10', 2500000, [['月光木', 250], ['龍血木', 300], ['隕石', 30], ['星辰礦', 80], ['鑽石', 100]], 60, 2, 1, 1, 20],
  [13, '雲上行館', '☁️', '寵物入住 +1、家具上限 +10', 5000000,
    [['月光木', 400], ['世界樹枝', 250], ['隕石', 60], ['鳳凰羽', 5], ['星辰礦', 150]], 70, 3, 1, 1, 24],
  [14, '天空之城', '🌠', '家具上限 +15', 12000000,
    [['月光木', 600], ['龍血木', 500], ['隕石', 120], ['獨角獸', 3], ['鑽石', 250]], 85, 3, 1, 1, 28],
  [15, '永恆星域', '✨', '家具上限 +15、房屋最高加成解鎖', 30000000,
    [['月光木', 900], ['世界樹枝', 600], ['龍血木', 600], ['隕石', 250], ['幼龍', 5], ['星辰礦', 400]], 100, 3, 1, 1, 35]
];

function seedHome(gid) {
  hcfg(gid);
  try {
    // 逐階補齊（不是「有資料就整批跳過」）：之後加新階級時，既有伺服器也會自動拿到，
    // 而且管理員改過的階級不會被蓋掉。
    const has = db.prepare('SELECT 1 FROM home_levels WHERE guild_id=? AND level=?');
    const ins = db.prepare(`INSERT INTO home_levels
      (guild_id,level,name,emoji,unlocks,coins,materials,furniture_cap,pet_cap,kitchen_ok,visit_ok,home_buff_pct)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    db.transaction(() => {
      for (const [lv, name, emoji, unlocks, coins, mats, fcap, pcap, kok, vok, buff] of SEED_LEVELS) {
        if (has.get(gid, lv)) continue;
        ins.run(gid, lv, name, emoji, unlocks, coins,
          JSON.stringify(mats.map(([item, count]) => ({ item, count }))), fcap, pcap, kok, vok, buff);
      }
    })();
  } catch (e) { logError(gid, '家園預設階級建立失敗：', e.message); }
}

// 玩家的家（第一次用就自動蓋一間破舊小屋）
function homeOf(gid, uid, uname = '') {
  let row = db.prepare('SELECT * FROM home_users WHERE guild_id=? AND user_id=?').get(gid, uid);
  if (!row) {
    db.prepare('INSERT OR IGNORE INTO home_users (guild_id,user_id,username,level) VALUES (?,?,?,1)').run(gid, uid, uname);
    row = db.prepare('SELECT * FROM home_users WHERE guild_id=? AND user_id=?').get(gid, uid);
  } else if (uname && row.username !== uname) {
    db.prepare('UPDATE home_users SET username=? WHERE guild_id=? AND user_id=?').run(uname, gid, uid);
  }
  return row;
}
// 房屋階級。寵物上限刻意壓在 3 隻 —— 養一堆寵物等於加成疊到爆，而且餵食變成負擔。
const PET_CAP_MAX = 3;
const levelDef = (gid, lv) => {
  const row = db.prepare('SELECT * FROM home_levels WHERE guild_id=? AND level=?').get(gid, lv);
  if (row) row.pet_cap = Math.min(PET_CAP_MAX, row.pet_cap);
  return row;
};
const maxLevel = (gid) => (db.prepare('SELECT MAX(level) m FROM home_levels WHERE guild_id=?').get(gid) || {}).m || 1;

// 背包裡某個物品的數量（用名稱找，家園材料設定寫的是名稱比較好讀）
function bagCount(gid, uid, itemName) {
  const row = db.prepare(
    `SELECT v.count FROM gather_inventory v JOIN gather_items it ON it.id = v.item_id
      WHERE v.guild_id=? AND v.user_id=? AND it.name=?`).get(gid, uid, itemName);
  return row ? row.count : 0;
}
function takeItems(gid, uid, mats) {
  for (const m of mats) {
    const it = db.prepare('SELECT id FROM gather_items WHERE guild_id=? AND name=?').get(gid, m.item);
    if (!it) throw new Error(`找不到材料「${m.item}」`);
    db.prepare('UPDATE gather_inventory SET count = count - ? WHERE guild_id=? AND user_id=? AND item_id=?')
      .run(m.count, gid, uid, it.id);
  }
}
const parseMats = (s) => { try { return JSON.parse(s || '[]'); } catch { return []; } };

/** 檢查能不能升級，回傳缺什麼（缺的用 🔴、夠的用 🟢，跟 /配方 同一套視覺語言） */
function upgradeCheck(gid, uid, uname) {
  const home = homeOf(gid, uid, uname);
  const top = maxLevel(gid);
  if (home.level >= top) return { maxed: true, home };
  const next = levelDef(gid, home.level + 1);
  if (!next) return { maxed: true, home };
  const mats = parseMats(next.materials);
  const coins = wallet(gid, uid, uname).coins;
  const lines = [];
  let ok = coins >= next.coins;
  const gc = gcfg(gid);
  lines.push(`${coins >= next.coins ? '🟢' : '🔴'} ${money(gc, next.coins)}（你有 ${coins.toLocaleString('en-US')}）`);
  for (const m of mats) {
    const have = bagCount(gid, uid, m.item);
    if (have < m.count) ok = false;
    lines.push(`${have >= m.count ? '🟢' : '🔴'} ${m.item} ×${m.count}（你有 ${have}）`);
  }
  return { maxed: false, home, next, mats, ok, lines };
}

function doUpgrade(gid, uid, uname) {
  const chk = upgradeCheck(gid, uid, uname);
  if (chk.maxed) return { error: '你的家園已經是最高階了，沒有下一階可以升。' };
  if (!chk.ok) return { error: null, chk };
  try {
    db.transaction(() => {
      addCoins(gid, uid, uname, -chk.next.coins);
      takeItems(gid, uid, chk.mats);
      db.prepare('UPDATE home_users SET level=? WHERE guild_id=? AND user_id=?').run(chk.next.level, gid, uid);
    })();
  } catch (e) { return { error: `升級失敗：${e.message}` }; }
  return { upgraded: chk.next };
}


/**
 * 「缺的材料直接用金幣買」的價格。
 * 刻意設計成天價（預設材料市價的 50 倍）：這是給身家幾千萬、東西買不完的人用的星幣出海口，
 * 不是給一般玩家跳過採集的捷徑 —— 自己去挖永遠比較划算。
 */
function buyMatsQuote(gid, uid, uname) {
  const c = hcfg(gid);
  if (!c.buy_mats_enabled) return null;
  const chk = upgradeCheck(gid, uid, uname);
  if (chk.maxed) return null;
  const mult = Math.max(100, c.buy_mats_mult || 5000) / 100;
  let cost = 0;
  const short = [];
  for (const m of chk.mats) {
    const have = bagCount(gid, uid, m.item);
    const lack = Math.max(0, m.count - have);
    if (!lack) continue;
    const it = db.prepare('SELECT price FROM gather_items WHERE guild_id=? AND name=?').get(gid, m.item);
    const unit = Math.max(1, (it ? it.price : 100));
    cost += Math.ceil(unit * mult) * lack;
    short.push({ item: m.item, lack, unit });
  }
  return { chk, cost, short, mult };
}

/** 直接用金幣補齊缺的材料並升級（一次扣掉升級金幣＋材料折現） */
function upgradeWithCoins(gid, uid, uname) {
  const q = buyMatsQuote(gid, uid, uname);
  if (!q) return { error: '目前沒有開放用金幣代替材料。' };
  if (q.chk.maxed) return { error: '你的家園已經是最高階了。' };
  if (!q.short.length) return { error: '你的材料已經夠了，直接按「升級家園」就好，不用多花錢。' };
  const total = q.cost + q.chk.next.coins;
  const coins = wallet(gid, uid, uname).coins;
  if (coins < total) return { error: `這條路很貴：材料折現 ${money(gcfg(gid), q.cost)} ＋ 升級費 ${money(gcfg(gid), q.chk.next.coins)}，總共 ${money(gcfg(gid), total)}，你還差 ${money(gcfg(gid), total - coins)}。` };
  try {
    db.transaction(() => {
      addCoins(gid, uid, uname, -total);
      // 有的材料就照收，缺的部分是花錢買掉的
      const partial = q.chk.mats
        .map(m => ({ item: m.item, count: Math.min(m.count, bagCount(gid, uid, m.item)) }))
        .filter(m => m.count > 0);
      if (partial.length) takeItems(gid, uid, partial);
      db.prepare('UPDATE home_users SET level=? WHERE guild_id=? AND user_id=?').run(q.chk.next.level, gid, uid);
    })();
  } catch (e) { return { error: `升級失敗：${e.message}` }; }
  return { upgraded: q.chk.next, spent: total, bought: q.short };
}

// ---- /我的家 主面板：按鈕分頁，切換時直接改同一則訊息，不用重打指令 ----
const NAV = (active) => new ActionRowBuilder().addComponents(
  ...[['home', '🏠 房屋'], ['kitchen', '🍳 廚房'], ['furn', '🛋️ 家具'], ['pet', '🐾 寵物'], ['love', '💕 約會']]
    .map(([k, label]) => new ButtonBuilder().setCustomId(`homenav:${k}`).setLabel(label)
      .setStyle(k === active ? ButtonStyle.Primary : ButtonStyle.Secondary)));

function homePanel(gid, uid, uname, displayName) {
  const home = homeOf(gid, uid, uname);
  const def = levelDef(gid, home.level) || { name: '小屋', emoji: '🏠', unlocks: '', furniture_cap: 5, pet_cap: 0 };
  const gc = gcfg(gid);
  const w = wallet(gid, uid, uname);
  const pets = db.prepare('SELECT COUNT(*) n FROM pet_owned WHERE guild_id=? AND user_id=?').get(gid, uid).n;
  const furn = db.prepare('SELECT COALESCE(SUM(placed),0) n FROM home_furniture_owned WHERE guild_id=? AND user_id=?').get(gid, uid).n;
  const { buffs, cap } = userBuffs(gid, uid, true);
  const buffLine = Object.entries(buffs).filter(([, v]) => v > 0)
    .map(([t, v]) => `${BUFF_TYPES[t]} +${v}%${v >= cap ? '（已封頂）' : ''}`).join('　');

  const embed = new EmbedBuilder().setColor(brandColor())
    .setTitle(`${def.emoji || '🏠'} ${displayName || uname} 的家｜Lv.${home.level} ${def.name}`)
    .setDescription(def.unlocks ? `*${def.unlocks}*` : ' ')
    .addFields(
      { name: '💰 資產', value: money(gc, w.coins), inline: true },
      { name: '🐾 寵物', value: `${pets} / ${def.pet_cap}`, inline: true },
      { name: '🛋️ 家具', value: `${furn} / ${def.furniture_cap}`, inline: true }
    );
  if (buffLine) embed.addFields({ name: '⭐ 目前加成', value: buffLine });

  const chk = upgradeCheck(gid, uid, uname);
  if (chk.maxed) embed.addFields({ name: '🎉 已達最高階', value: '你的家園已經蓋到頂了。' });
  else embed.addFields({ name: `🔨 升級到 Lv.${chk.next.level} ${chk.next.name}`, value: chk.lines.join('\n') });
  embed.setFooter({ text: chk.maxed ? '家園系統' : (chk.ok ? '材料齊了！按下方「升級家園」' : '缺 🔴 的材料，去採集或挖礦補齊') });

  const btns = new ActionRowBuilder();
  if (!chk.maxed) btns.addComponents(
    new ButtonBuilder().setCustomId('homeup').setLabel(`升級家園（Lv.${chk.next.level}）`)
      .setStyle(ButtonStyle.Success).setDisabled(!chk.ok));
  // 「用金幣硬升」：材料不夠但錢多到沒地方花的人專用，價格是天價
  const quote = chk.maxed ? null : buyMatsQuote(gid, uid, uname);
  if (quote && quote.short.length) btns.addComponents(
    new ButtonBuilder().setCustomId('homebuy')
      .setLabel(`💸 用金幣硬升（${(quote.cost + chk.next.coins).toLocaleString('en-US')}）`)
      .setStyle(ButtonStyle.Secondary));
  btns.addComponents(
    new ButtonBuilder().setCustomId('homecard').setLabel('🖼️ 家園狀態卡').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('homenav:checkin').setLabel('📅 簽到').setStyle(ButtonStyle.Secondary));
  return { embeds: [embed], components: [NAV('home'), btns] };
}

// ---- 每日簽到（在自己的小屋簽到領金幣）----
// 連續天數會加碼，斷一天就從頭；房屋階級越高簽到領越多，讓蓋房子有日常回報。
const DOW = ['週一', '週二', '週三', '週四', '週五', '週六', '週日'];
const dayIndex = (day) => { const d = new Date(day + 'T00:00:00+08:00').getDay(); return (d + 6) % 7; };

function checkinState(gid, uid) {
  let row = db.prepare('SELECT * FROM home_checkin WHERE guild_id=? AND user_id=?').get(gid, uid);
  if (!row) {
    db.prepare('INSERT OR IGNORE INTO home_checkin (guild_id,user_id) VALUES (?,?)').run(gid, uid);
    row = db.prepare('SELECT * FROM home_checkin WHERE guild_id=? AND user_id=?').get(gid, uid);
  }
  // 跨週就把本週的簽到格清空
  const wk = localWeekStart();
  if (row.week_start !== wk) {
    db.prepare('UPDATE home_checkin SET week_start=?, week_mask=0 WHERE guild_id=? AND user_id=?').run(wk, gid, uid);
    row.week_start = wk; row.week_mask = 0;
  }
  return row;
}

function doCheckin(gid, uid, uname) {
  const c = hcfg(gid);
  if (!c.checkin_enabled) return { error: '目前沒有開放簽到。' };
  const today = localToday();
  const row = checkinState(gid, uid);
  if (row.last_day === today) return { error: '你今天已經簽到過了，明天再來。' };

  // 連續判定：昨天有簽才算連續
  const yesterday = localToday(new Date(Date.now() - 86400000));
  const streak = row.last_day === yesterday ? row.streak + 1 : 1;

  const home = homeOf(gid, uid, uname);
  const streakBonus = Math.min(streak, c.checkin_max || 7) * (c.checkin_streak || 0);
  const homeBonus = Math.floor((c.checkin_base || 0) * home.level * (c.checkin_home_pct || 0) / 100);
  let coins = (c.checkin_base || 0) + streakBonus + homeBonus;

  // 本週七天全簽 → 額外獎勵
  const bit = 1 << dayIndex(today);
  const mask = row.week_mask | bit;
  const full = mask === 0b1111111;
  if (full) coins += (c.checkin_week || 0);

  db.transaction(() => {
    addCoins(gid, uid, uname, coins);
    db.prepare(`UPDATE home_checkin SET last_day=?, streak=?, best=MAX(best,?), total=total+1, week_mask=?
                WHERE guild_id=? AND user_id=?`).run(today, streak, streak, mask, gid, uid);
  })();
  return { coins, streak, base: c.checkin_base || 0, streakBonus, homeBonus, full, weekBonus: full ? (c.checkin_week || 0) : 0, mask, home };
}

/** 簽到面板：畫出本週七格，跟你們要的「週一~週日打勾」一樣 */
function checkinPanel(gid, uid, uname) {
  const c = hcfg(gid);
  const row = checkinState(gid, uid);
  const gc = gcfg(gid);
  const today = localToday();
  const done = row.last_day === today;
  const todayIdx = dayIndex(today);
  const week = DOW.map((d, idx) => {
    const signed = (row.week_mask >> idx) & 1;
    return `${d}\n${signed ? '✅' : idx === todayIdx ? '📍' : '⬜'}`;
  }).join('　');

  const home = homeOf(gid, uid, uname);
  const nextStreak = row.last_day === localToday(new Date(Date.now() - 86400000)) ? row.streak + 1 : 1;
  const preview = (c.checkin_base || 0)
    + Math.min(nextStreak, c.checkin_max || 7) * (c.checkin_streak || 0)
    + Math.floor((c.checkin_base || 0) * home.level * (c.checkin_home_pct || 0) / 100);

  const embed = new EmbedBuilder().setColor(brandColor()).setTitle('📅 小屋簽到')
    .setDescription(`每天回小屋簽到領 ${gc.currency_name || '星幣'}。**連續簽到加碼，斷一天就從頭**；房子蓋越大，簽到領越多。\n\n${week}`)
    .addFields(
      { name: '目前連續', value: `${row.streak} 天（最佳 ${row.best} 天）`, inline: true },
      { name: '累計簽到', value: `${row.total} 次`, inline: true },
      { name: done ? '今天已簽到' : '今天可領', value: done ? '明天再來' : money(gc, preview), inline: true })
    .setFooter({ text: `一週七天全簽再送 ${(c.checkin_week || 0).toLocaleString('en-US')}｜房屋每階 +${c.checkin_home_pct}%` });

  return {
    embeds: [embed],
    components: [NAV('home'), new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('homecheck').setLabel(done ? '今天已簽到' : '📅 簽到領獎')
        .setStyle(done ? ButtonStyle.Secondary : ButtonStyle.Success).setDisabled(done))]
  };
}

/** 個人家園網頁連結。Discord 的 Embed 做不出卡片式分區與多圖並排，
 *  漂亮的完整版走網頁；連結帶簽章，別人拿到也只看得到你的家而且改不了。 */
function webPanel(gid, uid, uname) {
  homeOf(gid, uid, uname);   // 確保有家才給連結
  const url = `${PUBLIC_URL}/home/${homeToken(gid, uid)}`;
  const embed = new EmbedBuilder().setColor(brandColor()).setTitle('🖼️ 你的家園．完整網頁版')
    .setDescription('點下面的按鈕打開你的專屬頁面 —— 房屋、升級進度、廚房、家具、寵物、成就、好感度、圖鑑全部一頁看完。\n\n這是**唯讀**頁面，所有操作還是回 Discord 這邊點按鈕。資料即時同步，重新整理就是最新的。')
    .setFooter({ text: '這條連結是你專屬的，別人拿到也只會看到你的家，而且改不了任何東西' });
  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel('🖼️ 打開我的家園頁面').setStyle(ButtonStyle.Link).setURL(url))]
  };
}

/** 家園狀態卡（合成圖）。Embed 排不出「一區一區」的版面，所以整張畫成 PNG。 */
async function homeCardPayload(gid, uid, uname, dname) {
  const home = homeOf(gid, uid, uname);
  const def = levelDef(gid, home.level) || {};
  const next = levelDef(gid, home.level + 1);
  const gc = gcfg(gid);
  const w = wallet(gid, uid, uname);
  const { buffs, cap } = userBuffs(gid, uid, true);

  const pets = db.prepare(
    `SELECT p.name, p.emoji, p.skill_name, p.buff_type, p.buff_pct, o.nickname, o.intimacy
       FROM pet_owned o JOIN pet_defs p ON p.id=o.pet_id WHERE o.guild_id=? AND o.user_id=? ORDER BY o.id`).all(gid, uid);
  const titles = db.prepare(
    `SELECT t.name, t.emoji, t.buff_type, t.buff_pct, t.buff2_type, t.buff2_pct, o.slot
       FROM title_owned o JOIN title_defs t ON t.id=o.title_id
      WHERE o.guild_id=? AND o.user_id=? AND t.enabled=1 ORDER BY o.slot DESC`).all(gid, uid);
  const placed = db.prepare('SELECT COALESCE(SUM(placed),0) n FROM home_furniture_owned WHERE guild_id=? AND user_id=?').get(gid, uid).n;
  const kitchen = home.kitchen_built
    ? db.prepare('SELECT level, name FROM kitchen_levels WHERE guild_id=? AND level=?').get(gid, home.kitchen_level) : null;

  const needs = (next ? parseMats(next.materials) : []).map(m => ({ item: m.item, have: bagCount(gid, uid, m.item), need: m.count }));

  // 圖鑑：只帶前 5 類，卡片放得下的量
  const DEXC = [['fish', '🐟 魚類', "kind='fish'"], ['mine', '⛏️ 礦石', "kind='mine'"],
    ['forage', '🍄 採集', "kind='forage'"], ['hunt', '🏹 狩獵', "kind='hunt'"]];
  const dex = DEXC.map(([key, label, where]) => ({
    label,
    have: db.prepare('SELECT COUNT(*) n FROM dex_seen WHERE guild_id=? AND user_id=? AND cat=?').get(gid, uid, key).n,
    total: db.prepare(`SELECT COUNT(*) n FROM gather_items WHERE guild_id=? AND enabled=1 AND ${where}`).get(gid).n
  }));
  dex.push({
    label: '🍳 料理',
    have: db.prepare("SELECT COUNT(*) n FROM dex_seen WHERE guild_id=? AND user_id=? AND cat='cook'").get(gid, uid).n,
    total: db.prepare('SELECT COUNT(*) n FROM cook_recipes WHERE guild_id=? AND enabled=1').get(gid).n
  });

  const ck = checkinState(gid, uid);
  const buf = await makeHomeCard({
    name: dname || uname,
    level: home.level, levelName: def.name || '小屋', levelEmoji: def.emoji || '🏠',
    coins: w.coins, currency: gc.currency_name || '星幣',
    pets: pets.map(p => ({
      emoji: p.emoji, name: p.nickname || p.name, intimacy: p.intimacy,
      skill: p.skill_name, pct: Math.floor(p.buff_pct * p.intimacy / 100)
    })),
    petCap: def.pet_cap || 0,
    furniture: { placed, cap: def.furniture_cap || 0 },
    kitchen,
    nextLevel: next ? { level: next.level, name: next.name, coins: next.coins } : null,
    needs,
    buffs: Object.entries(buffs).filter(([, v]) => v > 0).map(([t, v]) => ({ label: BUFF_TYPES[t] || t, pct: v })),
    titles: titles.map(t => ({
      emoji: t.emoji, name: t.name, equipped: t.slot >= 0,
      buff: [t.buff_type && `${BUFF_TYPES[t.buff_type]} +${t.buff_pct}%`,
        t.buff2_type && `${BUFF_TYPES[t.buff2_type]} +${t.buff2_pct}%`].filter(Boolean).join('、')
    })),
    dex,
    checkin: { streak: ck.streak, week: Array.from({ length: 7 }, (_, idx) => Boolean((ck.week_mask >> idx) & 1)) }
  });

  return {
    files: [new AttachmentBuilder(buf, { name: 'home.png' })],
    components: [NAV('home'), new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel('🖼️ 完整網頁版').setStyle(ButtonStyle.Link).setURL(`${PUBLIC_URL}/home/${homeToken(gid, uid)}`))]
  };
}

/** 加成明細（/家園加成 與面板按鈕共用） */
function buffsPanel(gid, uid) {
  const { buffs, parts, cap } = userBuffs(gid, uid, true);
  const embed = new EmbedBuilder().setColor(brandColor()).setTitle('⭐ 你目前的家園加成')
    .setFooter({ text: `每一種加成各自封頂 ${cap}%，收集再多也不會無限疊加` });
  if (!parts.length) embed.setDescription('你目前沒有任何加成。\n蓋家園、擺家具、養寵物、裝備成就都會給加成。');
  else {
    embed.setDescription(Object.entries(buffs).map(([t, v]) => `**${BUFF_TYPES[t]}　+${v}%**${v >= cap ? '（已封頂）' : ''}`).join('\n'));
    embed.addFields({ name: '來源明細', value: parts.map(p => `・${p.source} → ${BUFF_TYPES[p.type]} +${p.pct}%`).join('\n').slice(0, 1024) });
  }
  return { embeds: [embed] };
}

// 尚未實作的分頁：先給明確的「還沒開放」而不是壞掉的按鈕
const stubPanel = (active, title, text) => ({
  embeds: [new EmbedBuilder().setColor(brandColor()).setTitle(title).setDescription(text)],
  components: [NAV(active)]
});

function init(client) {
  for (const [gid] of client.guilds.cache) {
    try { seedHome(gid); } catch (e) { logError(gid, '家園初始化失敗：', e.message); }
  }

  client.on('interactionCreate', async (i) => {
    try {
      const gid = i.guildId;
      if (!gid) return;
      const uid = i.user.id, uname = i.user.username;
      const dname = i.member?.displayName || uname;

      // 冒險面板「🏡 我的家」分類的按鈕。面板只負責版面，實際內容由各模組出。
      if (i.isButton() && i.customId.startsWith('adv:')) {
        const key = i.customId.slice(4);
        const HANDLERS = {
          home:      () => homePanel(gid, uid, uname, dname),
          kitchen:   () => require('./kitchen').kitchenPanel(gid, uid, uname),
          furniture: () => require('./furniture').furniturePanel(gid, uid, uname),
          pets:      () => require('./pets').petPanel(gid, uid, uname),
          love:      () => require('./affinity').lovePanel(gid, uid, uname),
          dex:       () => require('./dex').dexPanel(gid, uid, uname),
          titles:    () => { const p = require('./dex').titlePanel(gid, uid, uname); return { embeds: p.embeds, components: p.components }; },
          buffs:     () => buffsPanel(gid, uid),
          checkin:   () => checkinPanel(gid, uid, uname),
          homeweb:   () => webPanel(gid, uid, uname)
        };
        if (!HANDLERS[key]) return;
        seedHome(gid);
        let panel;
        try { panel = HANDLERS[key](); }
        catch (e) { logError(gid, `家園面板 ${key} 失敗：`, e.message); panel = { content: '這個頁面暫時打不開，管理員可到後台的錯誤紀錄查看。', embeds: [], components: [] }; }
        return i.reply({ ...panel, flags: MessageFlags.Ephemeral }).catch(() => {});
      }

      if (i.isButton() && i.customId === 'homecard') {
        seedHome(gid);
        // 畫圖要一點時間，先 defer 才不會超過 Discord 的 3 秒回應限制
        await i.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
        try {
          return await i.editReply(await homeCardPayload(gid, uid, uname, dname));
        } catch (e) {
          logError(gid, '家園狀態卡產生失敗：', e.message);
          return await i.editReply({ content: '狀態卡產生失敗，管理員可到後台的錯誤紀錄查看原因。' }).catch(() => {});
        }
      }

      if (i.isButton() && i.customId === 'homecheck') {
        seedHome(gid);
        const out = doCheckin(gid, uid, uname);
        if (out.error) return i.reply({ content: out.error, flags: MessageFlags.Ephemeral }).catch(() => {});
        const gc = gcfg(gid);
        await i.update(checkinPanel(gid, uid, uname)).catch(() => {});
        return i.followUp({
          content: `📅 簽到成功！領到 **${money(gc, out.coins)}**\n`
            + `　基礎 ${out.base.toLocaleString('en-US')}`
            + `　連續 ${out.streak} 天 +${out.streakBonus.toLocaleString('en-US')}`
            + `　房屋 Lv.${out.home.level} +${out.homeBonus.toLocaleString('en-US')}`
            + (out.full ? `\n🎉 本週七天全勤！額外 +${out.weekBonus.toLocaleString('en-US')}` : ''),
          flags: MessageFlags.Ephemeral
        }).catch(() => {});
      }

      // 用金幣硬升（材料折現，天價）——先問一次，避免手滑噴掉幾千萬
      if (i.isButton() && i.customId === 'homebuy') {
        seedHome(gid);
        const q = buyMatsQuote(gid, uid, uname);
        if (!q || !q.short.length) return i.reply({ content: '你的材料已經夠了，直接按「升級家園」就好。', flags: MessageFlags.Ephemeral }).catch(() => {});
        const gc2 = gcfg(gid);
        return i.reply({
          content: `💸 **用金幣硬升 Lv.${q.chk.next.level}**\n`
            + q.short.map(x => `　${x.item} ×${x.lack}　${money(gc2, Math.ceil(x.unit * q.mult) * x.lack)}`).join('\n')
            + `\n　升級費　${money(gc2, q.chk.next.coins)}`
            + `\n**合計 ${money(gc2, q.cost + q.chk.next.coins)}**`
            + `\n\n⚠️ 材料是照市價的 **${q.mult} 倍**收費 —— 自己去挖永遠比較划算，這是給錢多到沒地方花的人用的。`,
          flags: MessageFlags.Ephemeral,
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('homebuyok').setLabel('確定，錢不是問題').setStyle(ButtonStyle.Danger))]
        }).catch(() => {});
      }
      if (i.isButton() && i.customId === 'homebuyok') {
        const out = upgradeWithCoins(gid, uid, uname);
        if (out.error) return i.update({ content: out.error, components: [] }).catch(() => {});
        return i.update({
          content: `🎉 花了 **${money(gcfg(gid), out.spent)}**，你的家園直接升級成 **Lv.${out.upgraded.level} ${out.upgraded.emoji || ''}${out.upgraded.name}**\n解鎖：${out.upgraded.unlocks || '—'}`,
          components: []
        }).catch(() => {});
      }

      if (i.isButton() && (i.customId.startsWith('homenav:') || i.customId === 'homeup')) {
        seedHome(gid);
        if (i.customId === 'homeup') {
          const out = doUpgrade(gid, uid, uname);
          if (out.error) return i.reply({ content: out.error, flags: MessageFlags.Ephemeral }).catch(() => {});
          if (out.upgraded) {
            await i.update(homePanel(gid, uid, uname, dname)).catch(() => {});
            return i.followUp({
              content: `🎉 恭喜！你的家園升級成 **Lv.${out.upgraded.level} ${out.upgraded.emoji || ''}${out.upgraded.name}**\n解鎖：${out.upgraded.unlocks || '—'}`,
              flags: MessageFlags.Ephemeral
            }).catch(() => {});
          }
          return i.update(homePanel(gid, uid, uname, dname)).catch(() => {});
        }
        // 各分頁的內容住在自己的模組裡。這裡用延遲 require 是刻意的 ——
        // furniture/kitchen/pets 都反過來 require 這支拿 homeOf/NAV，寫在檔頭會變成循環相依。
        const tab = i.customId.split(':')[1];
        const P = {
          home: () => homePanel(gid, uid, uname, dname),
          kitchen: () => require('./kitchen').kitchenPanel(gid, uid, uname),
          furn: () => require('./furniture').furniturePanel(gid, uid, uname),
          pet: () => require('./pets').petPanel(gid, uid, uname),
          love: () => require('./affinity').lovePanel(gid, uid, uname),
          checkin: () => checkinPanel(gid, uid, uname)
        };
        let panel;
        try { panel = (P[tab] || P.home)(); }
        catch (e) { logError(gid, `家園分頁 ${tab} 失敗：`, e.message); panel = stubPanel(tab, '⚠️ 這個分頁暫時打不開', '管理員可到後台的系統錯誤紀錄查看原因。'); }
        return i.update(panel).catch(() => {});
      }

      if (!i.isChatInputCommand()) return;
      if (!['我的家', '升級家園', '家園加成', '簽到', '家園網頁', '家園卡'].includes(i.commandName)) return;
      seedHome(gid);
      const c = hcfg(gid);
      if (!c.enabled) return i.reply({ content: '家園系統目前停用中。', flags: MessageFlags.Ephemeral });
      const reply = (p) => i.reply({ ...p, flags: MessageFlags.Ephemeral });

      if (i.commandName === '我的家') return await reply(homePanel(gid, uid, uname, dname));

      if (i.commandName === '升級家園') {
        const out = doUpgrade(gid, uid, uname);
        if (out.error) return await reply({ content: out.error });
        if (out.upgraded) return await reply({
          content: `🎉 你的家園升級成 **Lv.${out.upgraded.level} ${out.upgraded.emoji || ''}${out.upgraded.name}**！\n解鎖：${out.upgraded.unlocks || '—'}`
        });
        return await reply({
          content: `材料還不夠，還差 🔴 的部分：\n${out.chk.lines.join('\n')}`
        });
      }

      if (i.commandName === '家園加成') return await reply(buffsPanel(gid, uid));

      if (i.commandName === '簽到') return await reply(checkinPanel(gid, uid, uname));

      if (i.commandName === '家園網頁') return await reply(webPanel(gid, uid, uname));

      if (i.commandName === '家園卡') {
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        return await i.editReply(await homeCardPayload(gid, uid, uname, dname));
      }
    } catch (e) {
      logError(i.guildId, '家園指令失敗：', e.message);
      const msg = { content: '執行失敗，管理員可到後台的系統錯誤紀錄查看原因。', flags: MessageFlags.Ephemeral };
      if (i.replied || i.deferred) await i.followUp(msg).catch(() => {}); else await i.reply(msg).catch(() => {});
    }
  });
  console.log('  ↳ 家園模組已載入（12 階房屋／加成結算／面板）');
}

module.exports = { init, seedHome, homeCardPayload, doCheckin, checkinPanel, checkinState, homeOf, levelDef, maxLevel, bagCount, parseMats, takeItems, NAV };
