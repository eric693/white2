// 經營系統：牧場養動物（每日產蛋/擠奶）＋ 偷偷樂（偷別人未收成的產物）
// 產物直接寫進 gather_items（kind='farm'）→ 玩家用現成的 /背包 看、/賣出 賣給 NPC。
// 動物用金幣在 /畜牧商店 購買，最多養 max_slots 隻（預設 6）。
const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { db, guildConfig, logError } = require('../../db');
const { bump: bumpAch } = require('../../util/achievements');
const { brandColor } = require('../../util/brand');
// 產物賣價會受財經新聞影響（新聞關閉時等於基準價）
const { livePrice, priceTag } = require('../../util/market');
const { wallet, addCoins, addToBag, menuResult, safeMenu } = require('./gather');
const { facilitySlots, facilityBonus, applySpeed } = require('./facility');
const { logSteal, stealChannel } = require('../../util/steal');
const { buffPct } = require('../../util/buffs');
const cron = require('node-cron');

const rcfg = (gid) => guildConfig('ranch_config', gid);
const gcfg = (gid) => guildConfig('gather_config', gid);
const csv = (s) => String(s || '').split(/[\n,]/).map(x => x.trim()).filter(Boolean);
const money = (c, n) => `${c.currency_emoji || '🪙'} ${Number(n).toLocaleString('en-US')} ${c.currency_name || '星幣'}`;
// 台北時區的今天。一律走 util/time，全站同一個時區來源。
const { localToday } = require('../../util/time');
const today = () => localToday();
const dayDiff = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);

// ---- 預設動物（一開就有東西可養，管理員可到後台改）----
// [名稱, emoji, 售價, 產物名, 產物emoji, 產物單價, 每日產量, 說明, 看門機率%, 看門懲罰]
// 產物名留空＝不產蛋奶（看門動物）；售價/產物價已配合經濟調小（÷5）
const SEED_ANIMALS = [
  ['雞', '🐔', 60, '雞蛋', '🥚', 6, 2, '最平價的入門家禽'],
  ['鴨', '🦆', 90, '鴨蛋', '🥚', 8, 2, '穩定的產蛋家禽'],
  ['鵝', '🪿', 140, '鵝蛋', '🥚', 13, 1, '大顆鵝蛋，單價較高'],
  ['綿羊', '🐑', 200, '羊毛', '🧶', 17, 1, '溫和的羊毛來源'],
  ['山羊', '🐐', 200, '羊奶', '🥛', 15, 1, '產羊奶的好幫手'],
  ['乳牛', '🐄', 320, '牛奶', '🥛', 20, 2, '產值最高的家畜之一'],
  ['看門狗', '🐕', 200, '', '', 0, 0, '不產蛋奶，但被偷時 40% 機率咬小偷，小偷掉星幣賠給你', 40, 30],
  ['看門貓', '🐈', 150, '', '', 0, 0, '不產蛋奶，但被偷時 30% 機率抓小偷，小偷掉星幣賠給你', 30, 20],
  ['鵪鶉', '🐣', 40, '鵪鶉蛋', '🥚', 5, 3, '最便宜的入門鳥，產量高但單價低'],
  ['火雞', '🦃', 120, '火雞羽毛', '🪶', 11, 1, '產羽毛的家禽'],
  ['蜜蜂', '🐝', 160, '蜂蜜罐', '🍯', 18, 2, '勤勞的採蜜昆蟲'],
  ['水牛', '🐃', 400, '水牛奶', '🥛', 24, 2, '產值最高的家畜'],
  ['看門鵝', '🪿', 100, '', '', 0, 0, '便宜的保鑣：被偷時 25% 機率反擊', 25, 15]
];

// 預設孵化對應：[蛋名稱, 孵出的動物, 孵化分鐘]。蛋可以是動物生的、也可以是採集撿到的。
// [蛋名稱, 孵出的動物, 孵化分鐘, 失敗率%]
const SEED_HATCH = [
  ['雞蛋', '雞', 240, 0],
  ['鴨蛋', '鴨', 300, 0],
  ['鵝蛋', '鵝', 360, 0],
  ['野鳥蛋', '雞', 180, 20]   // 狩獵撿到的野生蛋，較快但有失敗率
];

// 建立/補齊預設動物與其產物（逐隻檢查，之後新增品種也會自動補到既有伺服器）
function seedRanch(gid) {
  rcfg(gid);
  try {
    const findItem = db.prepare("SELECT id FROM gather_items WHERE guild_id=? AND kind='farm' AND name=?");
    const insItem = db.prepare("INSERT INTO gather_items (guild_id,kind,name,emoji,rarity,weight,price,description,enabled) VALUES (?,?,?,?,?,?,?,?,1)");
    const findAnimal = db.prepare('SELECT id FROM ranch_animals WHERE guild_id=? AND name=?');
    const insAnimal = db.prepare('INSERT INTO ranch_animals (guild_id,name,emoji,price,product_item_id,produce_per_day,sort,description,guard_pct,guard_penalty) VALUES (?,?,?,?,?,?,?,?,?,?)');
    const tx = db.transaction(() => {
      SEED_ANIMALS.forEach((a, idx) => {
        const [name, emoji, price, pName, pEmoji, pPrice, perDay, desc, guardPct = 0, guardPenalty = 0] = a;
        if (findAnimal.get(gid, name)) return;
        let itemId = 0;
        if (pName) {   // 有產物才建 farm 物品；看門動物不產蛋奶
          let item = findItem.get(gid, pName);
          if (!item) { const r = insItem.run(gid, 'farm', pName, pEmoji, 'N', 0, pPrice, `牧場產物：${name}的${pName}`); item = { id: r.lastInsertRowid }; }
          itemId = item.id;
        }
        insAnimal.run(gid, name, emoji, price, itemId, perDay, idx, desc, guardPct, guardPenalty);
      });
      db.prepare('UPDATE ranch_config SET seeded=1 WHERE guild_id=?').run(gid);
    });
    tx();
  } catch (e) { logError(gid, '牧場預設內容建立失敗：', e.message); }

  // 預設孵化對應（動物與其蛋建立後才連得起來）
  try {
    const findItem = db.prepare('SELECT id FROM gather_items WHERE guild_id=? AND name=? ORDER BY id LIMIT 1');
    const findAnimal = db.prepare('SELECT id FROM ranch_animals WHERE guild_id=? AND name=?');
    const hasHatch = db.prepare('SELECT 1 FROM ranch_hatch_defs WHERE guild_id=? AND egg_item_id=? AND animal_id=?');
    const insHatch = db.prepare('INSERT INTO ranch_hatch_defs (guild_id,egg_item_id,animal_id,hatch_minutes,fail_pct,sort) VALUES (?,?,?,?,?,?)');
    SEED_HATCH.forEach(([eggName, animalName, mins, fail = 0], idx) => {
      const egg = findItem.get(gid, eggName);
      const an = findAnimal.get(gid, animalName);
      if (egg && an && !hasHatch.get(gid, egg.id, an.id)) insHatch.run(gid, egg.id, an.id, mins, fail, idx);
    });
  } catch (e) { logError(gid, '孵化預設建立失敗：', e.message); }
}

// 找玩家的第一個空牧場格（沒有回 -1）
function freeRanchSlot(gid, uid, maxSlots) {
  const used = db.prepare('SELECT slot FROM ranch_slots WHERE guild_id=? AND user_id=?').all(gid, uid).map(r => r.slot);
  for (let s = 0; s < maxSlots; s++) if (!used.includes(s)) return s;
  return -1;
}
// 玩家用製作解鎖的額外牧場/孵化格；總格數＝設定初始格 + 解鎖數
const ranchUnlocks = (gid, uid) => db.prepare('SELECT ranch, hatch FROM ranch_unlocks WHERE guild_id=? AND user_id=?').get(gid, uid) || { ranch: 0, hatch: 0 };
// 總格數＝後台初始格 + /製作 開出來的格 + /設施商店 買到的等級格
const effRanchSlots = (gid, uid, c) => Math.max(0, c.max_slots) + ranchUnlocks(gid, uid).ranch + facilitySlots(gid, uid, 'ranch');
const effHatchSlots = (gid, uid, c) => Math.max(0, c.hatch_slots) + ranchUnlocks(gid, uid).hatch + facilitySlots(gid, uid, 'hatch');
// 可孵化的蛋清單（含蛋/動物名稱、孵化時間）
const hatchList = (gid) => db.prepare(
  `SELECT h.*, it.name AS egg_name, it.emoji AS egg_emoji, a.name AS animal_name, a.emoji AS animal_emoji
     FROM ranch_hatch_defs h
     JOIN gather_items it ON it.id = h.egg_item_id
     JOIN ranch_animals a ON a.id = h.animal_id
    WHERE h.guild_id=? AND h.enabled=1 AND a.enabled=1 ORDER BY h.sort, h.id`).all(gid);

const animalById = (gid, id) => db.prepare('SELECT * FROM ranch_animals WHERE guild_id=? AND id=?').get(gid, id);
const productOf = (id) => db.prepare('SELECT * FROM gather_items WHERE id=?').get(id);

// 每產 1 單位需要幾毫秒（interval>0 用設定值；否則由每日產量平均分配到 24 小時）
function intervalMs(a) {
  const mins = a.produce_interval_minutes > 0 ? a.produce_interval_minutes : Math.max(1, Math.round(1440 / Math.max(1, a.produce_per_day)));
  return mins * 60000;
}
// 結算：每單位獨立計時，成熟一單位就 +1（成熟一瓶就能收一瓶，不用等整批）；上限 max_accrue_days 天的量
function accrue(gid, uid) {
  const c = rcfg(gid);
  const now = Date.now();
  const fb = facilityBonus(gid, uid, 'ranch');
  const speed = fb.speed;                                  // 牧場等級 → 產出時間縮短 %
  const yieldPct = fb.yield || 0;                          // 牧場等級 → 每次產出的量變多
  const slots = db.prepare('SELECT * FROM ranch_slots WHERE guild_id=? AND user_id=?').all(gid, uid);
  const upd = db.prepare('UPDATE ranch_slots SET pending=?, last_produce_ms=? WHERE guild_id=? AND user_id=? AND slot=?');
  for (const s of slots) {
    const a = animalById(gid, s.animal_id);
    if (!a || a.guard_pct > 0) continue;                 // 看門動物不生產
    if (!s.last_produce_ms) { upd.run(s.pending, now, gid, uid, s.slot); s.last_produce_ms = now; continue; }
    const iv = applySpeed(intervalMs(a), speed);
    const units = Math.floor((now - s.last_produce_ms) / iv);
    if (units <= 0) continue;
    // 產量加成：每一單位產出乘上倍率（無條件捨去，但至少 1）
    const gained = Math.max(units, Math.floor(units * (1 + yieldPct / 100)));
    const cap = Math.max(1, Math.floor(a.produce_per_day * (1 + yieldPct / 100))) * Math.max(1, c.max_accrue_days);
    const pending = Math.min(cap, s.pending + gained);
    const added = pending - s.pending;
    // 未滿：時間往前推 added 個間隔（餘數保留）；已滿：計時暫停到現在，收成後才重新開始
    const nextMs = pending >= cap ? now : s.last_produce_ms + units * iv;
    upd.run(pending, nextMs, gid, uid, s.slot);
    s.pending = pending; s.last_produce_ms = nextMs;
  }
  return slots;
}
// 某格下一單位成熟的 unix 毫秒（已滿或看門回 0）
function nextReadyMs(gid, s) {
  const a = animalById(gid, s.animal_id);
  if (!a || a.guard_pct > 0) return 0;
  const c = rcfg(gid);
  const cap = Math.max(1, a.produce_per_day) * Math.max(1, c.max_accrue_days);
  if (s.pending >= cap) return 0;
  return (s.last_produce_ms || Date.now()) + applySpeed(intervalMs(a), facilityBonus(gid, s.user_id, 'ranch').speed);
}

const stealCount = (gid, uid) =>
  (db.prepare('SELECT count FROM ranch_steal WHERE guild_id=? AND user_id=? AND day=?').get(gid, uid, today()) || {}).count || 0;
function bumpSteal(gid, uid) {
  db.prepare(
    `INSERT INTO ranch_steal (guild_id,user_id,day,count) VALUES (?,?,?,1)
     ON CONFLICT(guild_id,user_id,day) DO UPDATE SET count = count + 1`
  ).run(gid, uid, today());
}

// 買一隻動物進牧場。/飼養 指令與畜牧商店的下拉選單共用。
function buyAnimal(gid, uid, uname, animalId) {
  const c = rcfg(gid), gc = gcfg(gid);
  const animal = db.prepare('SELECT * FROM ranch_animals WHERE guild_id=? AND enabled=1 AND id=?').get(gid, animalId);
  if (!animal) return { error: '這隻動物已經不在商店裡了。' };
  // 看門動物停售：防護改由寵物提供，牧場格子留給生產（已經養著的不受影響，照樣看門）
  if (animal.guard_pct > 0) {
    return { error: `看門動物已經搬進家裡變成**寵物**了，不再佔用牧場格子。\n去 \`/寵物\` 領養守衛寵物（🪿看門鵝 牧場防護 +8%、🐕牧羊犬 +15%、🐅虎斑貓 魚缸防護 +15%、🦡獴 反擊 +25%、🐺雪狼 全域防竊 +18%）。` };
  }
  const maxSlots = effRanchSlots(gid, uid, c);
  if (maxSlots <= 0) return { error: '你還沒有牧場！可以用 `/設施商店` 直接買一座，或用 `/製作` 做「牧場」開一格。' };
  const free = freeRanchSlot(gid, uid, maxSlots);
  if (free < 0) return { error: `你的牧場已經滿了（${maxSlots} 格）。可以先 \`/放生\` 一隻，或去 \`/設施商店\` 升級擴充。` };
  const w = wallet(gid, uid, uname);
  if (w.coins < animal.price) {
    return { error: `${gc.currency_name}不夠：需要 ${animal.price.toLocaleString('en-US')}，你只有 ${w.coins.toLocaleString('en-US')}。` };
  }
  const tx = db.transaction(() => {
    db.prepare('UPDATE econ_wallets SET coins = coins - ? WHERE guild_id=? AND user_id=?').run(animal.price, gid, uid);
    db.prepare('INSERT INTO ranch_slots (guild_id,user_id,slot,animal_id,pending,last_produce_ms) VALUES (?,?,?,?,0,?)')
      .run(gid, uid, free, animal.id, Date.now());
  });
  tx();
  const p = productOf(animal.product_item_id);
  const iv = applySpeed(intervalMs(animal), facilityBonus(gid, uid, 'ranch').speed) / 3600000;
  const desc = animal.guard_pct > 0
    ? `${animal.emoji || '🐾'} **${animal.name}** 住進了牧場第 ${free + 1} 格！\n🛡️ 牠會看門：有人來偷時 ${animal.guard_pct}% 機率反擊，讓小偷掉星幣賠給你。`
    : `${animal.emoji || '🐾'} **${animal.name}** 住進了牧場第 ${free + 1} 格！\n每隔約 ${iv < 1 ? Math.round(iv * 60) + ' 分' : iv.toFixed(1) + ' 小時'}產 1 個 ${p ? (p.emoji || '') + p.name : '產物'}，成熟就能 \`/收成\`（一個一個收，不用等整批），別被人 \`/偷\` 走囉。`;
  const used = db.prepare('SELECT COUNT(*) n FROM ranch_slots WHERE guild_id=? AND user_id=?').get(gid, uid).n;
  const left = Math.max(0, maxSlots - used);
  return { embed: new EmbedBuilder().setColor(brandColor()).setTitle('🐣 飼養成功')
    .setDescription(`${desc}\n\n牧場：**${used}/${maxSlots} 格**已使用${left ? `（還可養 ${left} 隻）` : '（已滿，`/放生` 或去 `/設施商店` 升級）'}`)
    .setFooter({ text: `餘額 ${(w.coins - animal.price).toLocaleString('en-US')} ${gc.currency_name}` }) };
}

// 一次養多隻同款動物（畜牧商店：選動物→選數量）。有幾格養幾隻、錢不夠養到不能養為止。
function buyAnimalMulti(gid, uid, uname, animalId, qty) {
  const gc = gcfg(gid);
  const a = animalById(gid, animalId);
  const bought = []; let stopMsg = null;
  for (let k = 0; k < Math.max(1, qty); k++) {
    const r = buyAnimal(gid, uid, uname, animalId);
    if (r.error) { stopMsg = r.error; break; }
    bought.push(r);
  }
  if (!bought.length) return { error: stopMsg || '買不到動物。' };
  const used = db.prepare('SELECT COUNT(*) n FROM ranch_slots WHERE guild_id=? AND user_id=?').get(gid, uid).n;
  const bal = wallet(gid, uid, uname).coins;
  return { embed: new EmbedBuilder().setColor(brandColor()).setTitle(`🐣 養了 ${bought.length} 隻 ${a ? (a.emoji || '') + a.name : '動物'}`)
    .setDescription(`成功養進 ${bought.length} 隻！` + (stopMsg ? `\n\n⚠️ 後面停下來了：${stopMsg}` : '') +
      `\n\n成熟就能 \`/收成\`，記得別被 \`/偷\`。`)
    .setFooter({ text: `牧場 ${used} 格已使用｜餘額 ${bal.toLocaleString('en-US')} ${gc.currency_name}` }) };
}

// 賣掉一隻動物：回收購買價的一半星幣（比放生好，不再白白丟掉），待收成的產物一起進背包。
// /放生 指令與牧場的「賣掉」下拉選單共用。
const SELL_PCT = 0.5;
function sellAnimal(gid, uid, uname, slot) {
  const gc = gcfg(gid);
  const row = db.prepare('SELECT * FROM ranch_slots WHERE guild_id=? AND user_id=? AND slot=?').get(gid, uid, slot);
  if (!row) return { error: `第 ${slot + 1} 格沒有動物。用 \`/牧場\` 看看你有哪些。` };
  const a = animalById(gid, row.animal_id);
  const refund = a ? Math.max(1, Math.floor((a.price || 0) * SELL_PCT)) : 1;
  const pending = row.pending || 0;
  db.transaction(() => {
    if (pending > 0 && a && a.product_item_id) addToBag(gid, uid, a.product_item_id, pending);
    db.prepare('DELETE FROM ranch_slots WHERE guild_id=? AND user_id=? AND slot=?').run(gid, uid, slot);
    addCoins(gid, uid, uname, refund);
  })();
  const p = (a && pending > 0) ? productOf(a.product_item_id) : null;
  const bal = wallet(gid, uid, uname).coins;
  return { content: `💰 已賣掉 ${a ? (a.emoji || '') + a.name : '動物'}（第 ${slot + 1} 格），回收 **${refund}** ${gc.currency_name || '星幣'}` +
    (pending > 0 ? `，待收成的 ${p ? (p.emoji || '') : ''}${pending} 個產物已放進背包` : '') +
    `。\n目前餘額 ${bal.toLocaleString('en-US')} ${gc.currency_name || '星幣'}。` };
}

// 把一顆蛋放進孵化室。/孵化 指令與孵化室的下拉選單共用。
/** 放蛋。qty 可以一次放多顆（有幾格放幾顆，蛋不夠就放到沒蛋為止）。 */
function hatchEgg(gid, uid, uname, eggItemId, qty = 1) {
  const c = rcfg(gid);
  const def = hatchList(gid).find(d => d.egg_item_id === eggItemId);
  if (!def) return { error: '這顆蛋現在不能孵化。' };
  const inv = db.prepare('SELECT count FROM gather_inventory WHERE guild_id=? AND user_id=? AND item_id=?').get(gid, uid, def.egg_item_id);
  if (!inv || inv.count < 1) return { error: `你的背包裡沒有 ${def.egg_emoji || '🥚'}${def.egg_name}。` };
  const hMax = effHatchSlots(gid, uid, c);
  if (hMax <= 0) return { error: '你還沒有孵化室！去 `/設施商店` 買一個（小孵化箱 350 星幣），或用 `/製作` 的「蓋孵化室（+1 格）」。' };
  const usedSlots = db.prepare('SELECT slot FROM ranch_incubator WHERE guild_id=? AND user_id=?').all(gid, uid).map(r => r.slot);
  const freeSlots = [];
  for (let sl = 0; sl < hMax; sl++) if (!usedSlots.includes(sl)) freeSlots.push(sl);
  if (!freeSlots.length) return { error: `孵化室滿了（${hMax} 格）。等現有的蛋孵化完領走，或去 \`/設施商店\` 升級孵化室。` };

  const n = Math.max(1, Math.min(qty, inv.count, freeSlots.length));
  const readyAt = Date.now() + applySpeed(Math.max(1, def.hatch_minutes) * 60000, facilityBonus(gid, uid, 'hatch').speed);
  const put = [];
  db.transaction(() => {
    db.prepare('UPDATE gather_inventory SET count = count - ? WHERE guild_id=? AND user_id=? AND item_id=?').run(n, gid, uid, def.egg_item_id);
    const ins = db.prepare('INSERT INTO ranch_incubator (guild_id,user_id,slot,egg_item_id,animal_id,ready_at) VALUES (?,?,?,?,?,?)');
    for (let k = 0; k < n; k++) { ins.run(gid, uid, freeSlots[k], def.egg_item_id, def.animal_id, readyAt); put.push(freeSlots[k] + 1); }
  })();
  const used = db.prepare('SELECT COUNT(*) n FROM ranch_incubator WHERE guild_id=? AND user_id=?').get(gid, uid).n;
  const short = n < qty ? `\n（你想放 ${qty} 顆，但${inv.count < qty ? '蛋只夠 ' + inv.count + ' 顆' : '只剩 ' + freeSlots.length + ' 格'}）` : '';
  return { embed: new EmbedBuilder().setColor(brandColor()).setTitle('🥚 開始孵化')
    .setDescription(`${def.egg_emoji || '🥚'}**${def.egg_name}** ×**${n}** 放進孵化室（第 ${put.join('、')} 格），將孵出 ${def.animal_emoji || '🐾'}**${def.animal_name}**。${short}\n` +
      `預計完成：<t:${Math.floor(readyAt / 1000)}:R>（<t:${Math.floor(readyAt / 1000)}:t>）\n\n` +
      `孵化室：**${used}/${hMax} 格**已使用\n時間到用 \`/孵化室\` 領取，會直接住進牧場空格。`) };
}


// ---- 同居角色幫忙收成 ----
// 有「幫忙收成」能力的同居角色，每天早上會自動把成熟的牧場產物收進背包。
// 收成本來就是純手動的例行公事，這是同居真正有感的功能性（也讓伴侶稅繳得比較甘願）。
function partnerHarvest(gid) {
  const helpers = db.prepare(
    `SELECT p.user_id, r.name FROM home_partners p JOIN wheel_roles r ON r.id=p.role_id
      WHERE p.guild_id=? AND p.skill='harvest'`).all(gid);
  const out = [];
  for (const h of helpers) {
    try {
      accrue(gid, h.user_id);
      const slots = db.prepare('SELECT * FROM ranch_slots WHERE guild_id=? AND user_id=? AND pending > 0').all(gid, h.user_id);
      if (!slots.length) continue;
      const gained = new Map();
      db.transaction(() => {
        for (const s of slots) {
          const a = animalById(gid, s.animal_id);
          if (!a || !a.product_item_id) continue;
          addToBag(gid, h.user_id, a.product_item_id, s.pending);
          gained.set(a.product_item_id, (gained.get(a.product_item_id) || 0) + s.pending);
          db.prepare('UPDATE ranch_slots SET pending=0 WHERE guild_id=? AND user_id=? AND slot=?').run(gid, h.user_id, s.slot);
        }
      })();
      if (gained.size) out.push({ user_id: h.user_id, role: h.name, items: [...gained.entries()] });
    } catch (e) { logError(gid, '同居協助收成失敗：', e.message); }
  }
  return out;
}

function init(client) {
  // 每天早上 8:30 讓「會幫忙收成」的同居角色代收一次
  cron.schedule('30 8 * * *', () => {
    for (const [gid] of client.guilds.cache) {
      try {
        for (const r of partnerHarvest(gid)) {
          client.users.fetch(r.user_id).then(u => u.send(
            `🧺 **${r.role}** 幫你把牧場的產物收好了：\n`
            + r.items.map(([id, n]) => { const p = productOf(id); return `　${p ? (p.emoji || '') + p.name : '產物'} ×${n}`; }).join('\n')
            + '\n\n已經放進你的背包了。'
          )).catch(() => {});
        }
      } catch (e) { logError(gid, '同居協助收成排程失敗：', e.message); }
    }
  }, { timezone: 'Asia/Taipei' });

  for (const [gid] of client.guilds.cache) {
    try { seedRanch(gid); } catch (e) { logError(gid, '牧場初始化失敗：', e.message); }
  }

  const CMDS = ['牧場', '畜牧商店', '飼養', '收成', '放生', '偷', '孵化', '孵化室'];
  const RANCH_BTN = { 'adv:ranch': '牧場', 'adv:harvest': '收成', 'adv:incubator': '孵化室', 'adv:ranchshop': '畜牧商店' };

  client.on('interactionCreate', async (i) => {
    // 孵化室的放蛋選單：選好蛋之後再選要放幾顆（以前一次只能放一顆，格子多的人要點很多次）
    if (i.isStringSelectMenu() && i.customId === 'hatchput') {
      const gid = i.guildId, uid = i.user.id, c = rcfg(gid);
      const eggId = parseInt(i.values[0], 10);
      const def = hatchList(gid).find(d => d.egg_item_id === eggId);
      if (!def) return i.update({ content: '這顆蛋現在不能孵化。', components: [], embeds: [] }).catch(() => {});
      const have = (db.prepare('SELECT count FROM gather_inventory WHERE guild_id=? AND user_id=? AND item_id=?').get(gid, uid, eggId) || {}).count || 0;
      const hMax = effHatchSlots(gid, uid, c);
      const usedN = db.prepare('SELECT COUNT(*) n FROM ranch_incubator WHERE guild_id=? AND user_id=?').get(gid, uid).n;
      const freeN = Math.max(0, hMax - usedN);
      const cap = Math.min(have, freeN);
      if (cap <= 0) {
        return i.update({
          content: freeN <= 0 ? `孵化室滿了（${hMax} 格），等孵好的領走再放。` : `你的背包裡沒有 ${def.egg_emoji || '🥚'}${def.egg_name}。`,
          components: [], embeds: []
        }).catch(() => {});
      }
      // 一顆、幾顆、全部放滿都給選項
      const amounts = [...new Set([1, 3, 5, 10, cap].filter(n => n >= 1 && n <= cap))].sort((a, b) => a - b);
      const menu = new StringSelectMenuBuilder().setCustomId(`hatchqty:${eggId}`).setPlaceholder('要放幾顆？')
        .addOptions(amounts.slice(0, 25).map(n => ({
          label: n === cap ? `放滿（${n} 顆）` : `放 ${n} 顆`,
          description: `${def.hatch_minutes} 分／顆${def.fail_pct ? `　失敗率 ${def.fail_pct}%` : ''}`.slice(0, 100),
          value: String(n)
        })));
      return i.update({
        content: `${def.egg_emoji || '🥚'}**${def.egg_name}** → ${def.animal_emoji || '🐾'}**${def.animal_name}**\n`
          + `背包有 **${have}** 顆，孵化室還有 **${freeN}** 格。`,
        embeds: [], components: [new ActionRowBuilder().addComponents(menu)]
      }).catch(() => {});
    }
    if (i.isStringSelectMenu() && i.customId.startsWith('hatchqty:')) {
      const eggId = parseInt(i.customId.split(':')[1], 10);
      const qty = parseInt(i.values[0], 10);
      return safeMenu(i, '放蛋孵化', () => hatchEgg(i.guildId, i.user.id, i.user.username, eggId, qty));
    }
    // 畜牧商店：選一種動物 → 選要養幾隻（可養多隻同款）
    if (i.isStringSelectMenu() && i.customId === 'ranchbuyone') {
      const gid = i.guildId, uid = i.user.id, gc = gcfg(gid), c = rcfg(gid);
      const id = parseInt(i.values[0], 10);
      const a = animalById(gid, id);
      if (!a) return i.update({ content: '這隻動物已經不在商店了。', components: [], embeds: [] }).catch(() => {});
      const max = effRanchSlots(gid, uid, c);
      const usedN = db.prepare('SELECT COUNT(*) n FROM ranch_slots WHERE guild_id=? AND user_id=?').get(gid, uid).n;
      const freeN = Math.max(0, max - usedN);
      if (freeN <= 0) return i.update({ content: '牧場滿了，先 `/放生`（賣掉）或去 `/設施商店`／`/製作` 擴充。', components: [], embeds: [] }).catch(() => {});
      const afford = Math.floor(wallet(gid, uid, i.user.username).coins / Math.max(1, a.price));
      const maxBuy = Math.min(freeN, Math.max(0, afford));
      if (maxBuy <= 0) return i.update({ content: `${gc.currency_name}不夠買一隻 ${a.emoji || ''}${a.name}（要 ${a.price.toLocaleString('en-US')}）。`, components: [], embeds: [] }).catch(() => {});
      const amts = [...new Set([1, 2, 3, 5, 10].filter(x => x < maxBuy).concat([maxBuy]))].sort((x, y) => x - y);
      const opts = amts.slice(0, 25).map(x => ({ label: x === maxBuy ? `養 ${x} 隻（最多）` : `養 ${x} 隻`, description: `花 ${(a.price * x).toLocaleString('en-US')} ${gc.currency_name}`.slice(0, 100), value: String(x) }));
      const menu = new StringSelectMenuBuilder().setCustomId('ranchbuyqty:' + id).setPlaceholder('要養幾隻？').setMinValues(1).setMaxValues(1).addOptions(opts);
      return i.update({ content: `${a.emoji || '🐾'}${a.name}：要養幾隻？（空格 ${freeN}，每隻 ${a.price.toLocaleString('en-US')} ${gc.currency_name}）`, components: [new ActionRowBuilder().addComponents(menu)], embeds: [] }).catch(() => {});
    }
    if (i.isStringSelectMenu() && i.customId.startsWith('ranchbuyqty:')) {
      const id = parseInt(i.customId.split(':')[1], 10);
      const qty = Math.max(1, parseInt(i.values[0], 10) || 1);
      return safeMenu(i, '購買動物', () => buyAnimalMulti(i.guildId, i.user.id, i.user.username, id, qty));
    }
    // 牧場的「賣掉動物」選單（值＝格子索引）
    if (i.isStringSelectMenu() && i.customId === 'ranchsell') {
      return safeMenu(i, '賣出動物', () => sellAnimal(i.guildId, i.user.id, i.user.username, parseInt(i.values[0], 10)));
    }
    // 孵化室「直接賣掉孵好的動物」（牧場滿了免挪；值＝孵化室格子）
    // 一鍵賣出：孵化室卡了幾十隻的時候，一格一格勾太痛苦
    if (i.isButton() && i.customId === 'hatchsellall') {
      try {
        const gid = i.guildId, uid = i.user.id, uname = i.user.username, gc = gcfg(gid);
        const now = Date.now();
        const ready = db.prepare('SELECT * FROM ranch_incubator WHERE guild_id=? AND user_id=? AND ready_at<=?').all(gid, uid, now);
        if (!ready.length) return i.reply({ content: '孵化室裡沒有已經孵好的動物。', flags: MessageFlags.Ephemeral }).catch(() => {});
        let gained = 0; const tally = new Map();
        db.transaction(() => {
          for (const r of ready) {
            const a = animalById(gid, r.animal_id);
            const refund = a ? Math.max(1, Math.floor((a.price || 0) * SELL_PCT)) : 1;
            db.prepare('DELETE FROM ranch_incubator WHERE guild_id=? AND user_id=? AND slot=?').run(gid, uid, r.slot);
            addCoins(gid, uid, uname, refund);
            gained += refund;
            const key = a ? `${a.emoji || ''}${a.name}` : '動物';
            tally.set(key, (tally.get(key) || 0) + 1);
          }
        })();
        const bal = wallet(gid, uid, uname).coins;
        const embed = new EmbedBuilder().setColor(brandColor()).setTitle(`💰 一次賣掉 ${ready.length} 隻`)
          .setDescription([...tally.entries()].map(([k, n]) => `${k} ×${n}`).join('\n'))
          .setFooter({ text: `共得 ${gained.toLocaleString('en-US')}｜餘額 ${bal.toLocaleString('en-US')} ${gc.currency_name}` });
        return i.update({ content: '', embeds: [embed], components: [] }).catch(() => {});
      } catch (e) {
        logError(i.guildId, '一鍵賣出失敗：', e.message);
        return i.reply({ content: '執行失敗，管理員可到後台的系統錯誤紀錄查看原因。', flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
    if (i.isStringSelectMenu() && i.customId === 'hatchsell') {
      try {
      const gid = i.guildId, uid = i.user.id, uname = i.user.username, gc = gcfg(gid);
      let gained = 0; const sold = [];
      db.transaction(() => {
        for (const s of i.values.map(Number)) {
          const r = db.prepare('SELECT * FROM ranch_incubator WHERE guild_id=? AND user_id=? AND slot=?').get(gid, uid, s);
          if (!r || r.ready_at > Date.now()) continue;   // 只賣「已孵化」的
          const a = animalById(gid, r.animal_id);
          const refund = a ? Math.max(1, Math.floor((a.price || 0) * SELL_PCT)) : 1;
          db.prepare('DELETE FROM ranch_incubator WHERE guild_id=? AND user_id=? AND slot=?').run(gid, uid, s);
          addCoins(gid, uid, uname, refund);
          gained += refund; sold.push(`${a ? (a.emoji || '') + a.name : '動物'}　+${refund}`);
        }
      })();
      if (!sold.length) return i.update({ content: '這些動物已經不在孵化室了。', components: [], embeds: [] }).catch(() => {});
      const now = wallet(gid, uid, uname).coins;
      const embed = new EmbedBuilder().setColor(brandColor()).setTitle('💰 賣掉孵好的動物')
        .setDescription(sold.join('\n'))
        .setFooter({ text: `共得 ${gained.toLocaleString('en-US')}｜餘額 ${now.toLocaleString('en-US')} ${gc.currency_name}` });
      return i.update({ content: '', embeds: [embed], components: [] }).catch(() => {});
      } catch (e) {
        logError(i.guildId, '賣掉孵好的動物失敗：', e.message);
        return i.reply({ content: '執行失敗，管理員可到後台的系統錯誤紀錄查看原因。', flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
    const isBtn = i.isButton();
    const cmdName = isBtn ? RANCH_BTN[i.customId] : (i.isChatInputCommand() ? i.commandName : null);
    if (!cmdName || !CMDS.includes(cmdName)) return;
    const gid = i.guildId;
    if (!gid) return i.reply({ content: '這個指令只能在伺服器裡使用。', flags: MessageFlags.Ephemeral });
    seedRanch(gid);
    const c = rcfg(gid);
    const gc = gcfg(gid);
    if (!c.enabled) return i.reply({ content: '牧場經營系統目前停用中。', flags: MessageFlags.Ephemeral });

    // 沿用冒險區的頻道限制設定
    const allowed = csv(gc.channels);
    if (allowed.length && !allowed.includes(i.channelId)) {
      return i.reply({ content: `這個指令只能在 ${allowed.map(id => `<#${id}>`).join('、')} 使用。`, flags: MessageFlags.Ephemeral });
    }

    const uid = i.user.id;
    const uname = i.user.username;
    const name = cmdName;
    // 牧場相關結果都設為只有本人看得到，維持頻道乾淨
    const reply = (payload) => i.reply({ ...payload, flags: MessageFlags.Ephemeral });

    try {
      // ---- 畜牧商店 ----
      if (name === '畜牧商店') {
        const animals = db.prepare('SELECT * FROM ranch_animals WHERE guild_id=? AND enabled=1 ORDER BY sort, price').all(gid);
        if (!animals.length) return await reply({ content: '畜牧商店目前還沒有任何動物。' });
        const w = wallet(gid, uid, uname);
        const line = (a) => {
          if (a.guard_pct > 0) {
            return `${a.emoji || '🐾'} **${a.name}**　${money(gc, a.price)}\n　　🛡️ 看門：被偷時 ${a.guard_pct}% 機率反擊，小偷最多掉 ${a.guard_penalty} 星幣${a.description ? `　${a.description}` : ''}`;
          }
          const p = productOf(a.product_item_id);
          const iv = applySpeed(intervalMs(a), facilityBonus(gid, uid, 'ranch').speed) / 60000;
          const cap = Math.max(1, a.produce_per_day) * Math.max(1, c.max_accrue_days);
          return `${a.emoji || '🐾'} **${a.name}**　${money(gc, a.price)}\n　　每 ${iv < 60 ? Math.round(iv) + ' 分' : (iv / 60).toFixed(1) + ' 小時'}產 1 × ${p ? (p.emoji || '') + p.name : '產物'}（每個賣 ${p ? livePrice(gid, p) : '?'}${p ? priceTag(gid, p) : ''}）\n　　📦 最多囤 **${cap}** 個，**滿了就停止生產**，記得去 \`/收成\` 才會繼續${a.description ? `　${a.description}` : ''}`;
        };
        const produce = animals.filter(a => a.guard_pct <= 0);
        const guardsList = animals.filter(a => a.guard_pct > 0);
        const embeds = [new EmbedBuilder().setColor(brandColor()).setTitle('🛒 畜牧商店')
          .setDescription(`點下方選單直接買一隻養進牧場（也可以打 \`/飼養 動物名稱\`）。\n你的餘額：**${w.coins.toLocaleString('en-US')} ${gc.currency_name}**　牧場格：**${effRanchSlots(gid, uid, c)}**（用 \`/設施商店\` 擴充）`)];
        if (produce.length) embeds.push(new EmbedBuilder().setColor(0xf1c40f)
          .setTitle('🥚 生產動物').setDescription(produce.map(line).join('\n').slice(0, 4000)));
        // 看門動物已改由寵物提供（不佔牧場格子），商店只留說明、不再販售
        embeds.push(new EmbedBuilder().setColor(0x5865f2)
          .setTitle('🛡️ 防竊改看寵物了')
          .setDescription('看門動物已經**搬進家裡變成寵物**，不再佔用牧場格子 —— 牧場的每一格都能拿去生產。\n\n'
            + '去 `/寵物` 領養守衛寵物，能力分得很細：\n'
            + '　🪿 看門鵝　牧場防護 +8%\n'
            + '　🐕 牧羊犬　牧場防護 +15%\n'
            + '　🐅 虎斑貓　魚缸防護 +15%\n'
            + '　🪶 蒼鷺　　魚缸防護 +22%\n'
            + '　🦡 獴　　　反擊 +25%（小偷會掉星幣賠你）\n'
            + '　🐺 雪狼　　全域防竊 +18%（牧場魚缸一起顧）\n\n'
            + '防護是**扣小偷的成功率**，跟 `/設施商店` 的牧場等級可以疊加；寵物要餵、親密度越高效果越足。'));
        const opts = produce.map(a => ({
          label: a.name.slice(0, 100),
          description: `${a.price.toLocaleString('en-US')} ${gc.currency_name}｜${a.guard_pct > 0 ? `看門 ${a.guard_pct}%` : `每天 ${a.produce_per_day} 產`}`.slice(0, 100),
          value: String(a.id), emoji: a.emoji || '🐾'
        }));
        const rows = [new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder().setCustomId('ranchbuyone').setPlaceholder('選一種動物（下一步選要幾隻）').setMinValues(1).setMaxValues(1).addOptions(opts.slice(0, 25)))];
        return await reply({ embeds: embeds.slice(0, 10), components: rows });
      }

      // 看門動物已停售（改由寵物提供防護），避免玩家又拿生產格子去養鵝
      // ---- 飼養（購買動物）----
      if (name === '飼養') {
        const what = (i.options.getString('動物') || '').trim();
        const animal = db.prepare('SELECT * FROM ranch_animals WHERE guild_id=? AND enabled=1 AND name=?').get(gid, what);
        if (!animal) return await reply({ content: `找不到動物「${what}」，用 \`/畜牧商店\` 看看有哪些。` });
        const r = buyAnimal(gid, uid, uname, animal.id);
        if (r.error) return await reply({ content: r.error });
        return await reply({ embeds: [r.embed] });
      }

      // ---- 牧場一覽 ----
      if (name === '牧場') {
        const target = (!isBtn && i.options.getUser('玩家')) || i.user;
        accrue(gid, target.id);
        const slots = db.prepare('SELECT * FROM ranch_slots WHERE guild_id=? AND user_id=? ORDER BY slot').all(gid, target.id);
        const lines = [];
        let pendingValue = 0;
        const shownMax = Math.max(effRanchSlots(gid, target.id, c), slots.length ? Math.max(...slots.map(x => x.slot)) + 1 : 0);
        for (let s = 0; s < shownMax; s++) {
          const row = slots.find(x => x.slot === s);
          if (!row) { lines.push(`\`${s + 1}\`｜— 空格 —`); continue; }
          const a = animalById(gid, row.animal_id);
          const p = a ? productOf(a.product_item_id) : null;
          if (p) pendingValue += row.pending * livePrice(gid, p);
          if (a && a.guard_pct > 0) { lines.push(`\`${s + 1}\`｜${(a.emoji || '🐾') + a.name}　🛡️ 看門中`); continue; }
          // 每單位獨立計時：顯示已成熟數量 + 下一單位倒數
          const nr = nextReadyMs(gid, row);
          const cd = nr ? `　下一顆 <t:${Math.floor(nr / 1000)}:R>` : (row.pending > 0 ? '　已滿' : '');
          lines.push(`\`${s + 1}\`｜${a ? (a.emoji || '🐾') + a.name : '未知動物'}　待收成 ${p ? (p.emoji || '') : ''}${row.pending}${cd}`);
        }
        const embed = new EmbedBuilder().setColor(brandColor())
          .setTitle(`🏡 ${target.username} 的牧場`)
          .setDescription(lines.join('\n') + '\n\n每隻各自計時，成熟一個就能 `/收成` 一個，不用等整批。\n💰 想清欄位換星幣：用下面的選單「賣掉動物」（回收購買價一半，待收成產物一起進背包）。')
          .setFooter({ text: `待收成總值約 ${pendingValue.toLocaleString('en-US')} ${gc.currency_name}｜/收成 收取、/畜牧商店 買動物` });
        // 只在看自己的牧場、且有動物時，給「賣掉」下拉（點一下就賣，不用打格子號碼）
        const own = isBtn || target.id === uid;
        const sellOpts = own ? slots.map(s => {
          const a = animalById(gid, s.animal_id);
          const refund = a ? Math.max(1, Math.floor((a.price || 0) * SELL_PCT)) : 1;
          return { label: `第 ${s.slot + 1} 格：${a ? a.name : '動物'}`.slice(0, 100), description: `賣掉回收 ${refund} ${gc.currency_name}`.slice(0, 100), value: String(s.slot), emoji: (a && a.emoji) || '🐾' };
        }) : [];
        const rows = sellOpts.length ? [new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder().setCustomId('ranchsell').setPlaceholder('💰 賣掉動物（回收一半星幣）').addOptions(sellOpts.slice(0, 25)))] : [];
        return await reply({ embeds: [embed], components: rows });
      }

      // ---- 收成 ----
      if (name === '收成') {
        accrue(gid, uid);
        const slots = db.prepare('SELECT * FROM ranch_slots WHERE guild_id=? AND user_id=? AND pending > 0').all(gid, uid);
        if (!slots.length) return await reply({ content: '目前沒有可收成的產物，動物們還在努力生產中～' });
        const gained = new Map(); // item_id -> count
        const tx = db.transaction(() => {
          for (const s of slots) {
            const a = animalById(gid, s.animal_id);
            if (!a) continue;
            addToBag(gid, uid, a.product_item_id, s.pending);
            gained.set(a.product_item_id, (gained.get(a.product_item_id) || 0) + s.pending);
            db.prepare('UPDATE ranch_slots SET pending=0 WHERE guild_id=? AND user_id=? AND slot=?').run(gid, uid, s.slot);
          }
        });
        tx();
        bumpAch(gid, uid, 'harvest_count', 1);
        let value = 0;
        const lines = [...gained.entries()].map(([itemId, n]) => {
          const p = productOf(itemId); if (p) value += n * livePrice(gid, p);
          return `${p ? (p.emoji || '') + p.name : '產物'} ×${n}`;
        });
        const embed = new EmbedBuilder().setColor(brandColor()).setTitle('🧺 收成成功')
          .setDescription(lines.join('\n') + `\n\n已放進背包，用 \`/賣出\` 換 ${gc.currency_name}。`)
          .setFooter({ text: `全部賣出約 ${value.toLocaleString('en-US')} ${gc.currency_name}` });
        return await reply({ embeds: [embed] });
      }

      // ---- 放生（改為「賣掉」：回收一半星幣，不再白白丟掉）----
      if (name === '放生') {
        const slot = (i.options.getInteger('格子') || 0) - 1;
        return await reply(sellAnimal(gid, uid, uname, slot));
      }

      // ---- 偷偷樂 ----
      if (name === '偷') {
        if (!c.steal_enabled) return await reply({ content: '目前沒有開放偷偷樂。' });
        const to = i.options.getUser('對象');
        if (to.bot) return await reply({ content: '不能偷機器人。' });
        if (to.id === uid) return await reply({ content: '不能偷自己的牧場。' });

        const usedToday = stealCount(gid, uid);
        if (usedToday >= c.steal_daily_limit) {
          return await reply({ content: `你今天的偷取次數已用完（每日上限 ${c.steal_daily_limit} 次），明天再來吧！` });
        }

        accrue(gid, to.id);
        const victimSlots = db.prepare('SELECT * FROM ranch_slots WHERE guild_id=? AND user_id=?').all(gid, to.id);
        if (!victimSlots.length) return await reply({ content: `${to.username} 還沒有牧場，沒東西可偷。` });
        // 產物被收光時不再直接撲空 —— 還是要擲一次成功率與動物搶奪，
        // 否則只要對方勤收成，就永遠不可能被牽走動物。
        const totalPending = victimSlots.reduce((a, s) => a + s.pending, 0);

        bumpSteal(gid, uid);
        // 被偷者的牧場等級提供防竊：直接扣小偷的成功率與搶動物機率（最低壓到 0）
        // 防護來源有三層：牧場等級（設施商店）＋ 守衛寵物（牧場防護／全域防竊）。
        // 守衛寵物是為了讓玩家不必再拿生產格子去養看門鵝 —— 寵物住家裡，不佔牧場。
        const petResist = buffPct(gid, to.id, 'ranch_resist_pct') + buffPct(gid, to.id, 'steal_resist_pct');
        const resist = facilityBonus(gid, to.id, 'ranch').resist + petResist;
        const successPct = Math.max(0, c.steal_success_pct - resist);
        const animalPct = Math.max(0, c.steal_animal_pct - resist);
        const success = Math.random() * 100 < successPct;
        if (!success) {
          bumpAch(gid, to.id, 'defend_success', 1);     // 被偷者成功守住（守衛寵物／牧場等級的功勞）
          logSteal({ guildId: gid, kind: 'ranch', thiefId: uid, thiefName: uname,
            victimId: to.id, victimName: to.username, result: 'miss', channelId: i.channelId });
          return await reply({ content: `你正要下手，卻被 ${to.username} 的守衛發現，只好空手逃走！${resist ? `（對方防護讓成功率 -${resist}%${petResist ? `，其中寵物擋了 ${petResist}%` : ''}）` : ''}（今日 ${usedToday + 1}/${c.steal_daily_limit}）` });
        }

        // 看門動物反擊：被偷者若養了看門狗/貓，有機率讓小偷掉星幣（賠給被偷者）。
        // 先擲看門，再決定偷什麼 —— 被逮到的那次就不該讓他還牽走動物。
        let guardNote = '', guardPenalty = 0, guardAnimal = null;
        const guards = victimSlots.map(s => animalById(gid, s.animal_id)).filter(a => a && a.guard_pct > 0);
        // 寵物的反擊機率也算進來，跟牧場看門動物取高的那一個（不累加）
        const petBite = buffPct(gid, to.id, 'guard_bite_pct');
        const bestAnimal = guards.length ? guards.reduce((m, a) => (a.guard_pct > m.guard_pct ? a : m), guards[0]) : null;
        const useAnimal = bestAnimal && bestAnimal.guard_pct >= petBite;
        const best = useAnimal ? bestAnimal
          : petBite > 0 ? { name: '守衛寵物', emoji: '🐾', guard_pct: petBite, guard_penalty: Math.max(20, petBite * 2) }
            : null;
        if (best) {
          if (Math.random() * 100 < best.guard_pct) {
            const before = wallet(gid, uid, uname).coins;
            // 罰款照抽全額、不再被小偷的餘額上限卡住——沒錢也照罰，會欠成負數（防止玩家故意花光錢來偷）
            const pen = Math.floor(Math.random() * Math.max(1, best.guard_penalty)) + 1;
            const gtx = db.transaction(() => {
              db.prepare('UPDATE econ_wallets SET coins = coins - ? WHERE guild_id=? AND user_id=?').run(pen, gid, uid);
              addCoins(gid, to.id, to.username, pen);
            });
            gtx();
            guardPenalty = pen; guardAnimal = best;
            const debt = before - pen < 0 ? `（你現在欠 ${money(gc, pen - before)}，快去賺回來！）` : '';
            guardNote = `\n\n🐕 但被 ${to.username} 的 ${best.emoji || ''}${best.name} 逮到，你掉了 ${money(gc, pen)}（賠給對方）！${debt}`;
          }
        }

        // 先算動物搶奪的資格（看門動物不會被搶、被看門逮到就沒機會、小偷要有空格）
        let animalNote = '', animalStolen = false;
        // 看門動物能不能被牽走由設定決定。開著時連保鑣都搶得走，
        // 但「這次咬到人」的看門動物本身仍安全 —— 上面 guardPenalty>0 就不會走到搶動物這步。
        const stealable = victimSlots.filter(s => {
          const a = animalById(gid, s.animal_id);
          return a && (c.steal_guard ? true : a.guard_pct <= 0);
        });
        const maxSlots = effRanchSlots(gid, uid, c);
        const freeSlot = freeRanchSlot(gid, uid, maxSlots);
        const animalHit = guardPenalty <= 0 && animalPct > 0 && Math.random() * 100 < animalPct;
        const takeAnimal = animalHit && stealable.length > 0 && freeSlot >= 0;
        if (animalHit && stealable.length && freeSlot < 0) {
          // 小偷沒地方擺。以前這裡會安靜地什麼都不做，看起來就像「動物根本偷不到」。
          animalNote = maxSlots <= 0
            ? '\n\n🐄 你本來可以順手牽走一隻動物，但你還沒有牧場（用 `/設施商店` 買一座），只好放牠回去。'
            : `\n\n🐄 你本來可以順手牽走一隻動物，但你的牧場已經滿了（${maxSlots} 格），只好放牠回去。`;
        }

        if (takeAnimal) {
          const victimSlot = stealable[Math.floor(Math.random() * stealable.length)];
          const a = animalById(gid, victimSlot.animal_id);
          const atx = db.transaction(() => {
            db.prepare('DELETE FROM ranch_slots WHERE guild_id=? AND user_id=? AND slot=?').run(gid, to.id, victimSlot.slot);
            db.prepare('INSERT INTO ranch_slots (guild_id,user_id,slot,animal_id,pending,last_produce_ms) VALUES (?,?,?,?,0,?)')
              .run(gid, uid, freeSlot, a.id, Date.now());
          });
          atx();
          animalNote = a.guard_pct > 0
            ? `\n\n🐕💨 你連 ${to.username} 的看門${a.emoji || ''}**${a.name}** 都一起拐走了，牠現在替你看門（第 ${freeSlot + 1} 格）！`
            : `\n\n🐄💨 你牽走了一隻 ${a.emoji || ''}**${a.name}**，已進你的牧場第 ${freeSlot + 1} 格！`;
          animalStolen = true;
        }

        // 偷產物。steal_mode='one'＝一次只拿 1 個（而且搶到動物就不再拿產物），
        // 'pct'＝舊制，從每一格各拿 steal_take_pct%。前者讓被偷的人不會一次被清空。
        const oneMode = (c.steal_mode || 'one') === 'one';
        const stolen = new Map(); // item_id -> count
        if (!(oneMode && animalStolen)) {
          const withPending = victimSlots.filter(s => s.pending > 0 && animalById(gid, s.animal_id));
          const tx = db.transaction(() => {
            if (oneMode) {
              if (!withPending.length) return;
              // 隨機挑一格，只拿 1 個
              const s2 = withPending[Math.floor(Math.random() * withPending.length)];
              const a = animalById(gid, s2.animal_id);
              db.prepare('UPDATE ranch_slots SET pending = pending - 1 WHERE guild_id=? AND user_id=? AND slot=?')
                .run(gid, to.id, s2.slot);
              addToBag(gid, uid, a.product_item_id, 1);
              stolen.set(a.product_item_id, 1);
              return;
            }
            for (const s2 of withPending) {
              let take = Math.max(1, Math.floor(s2.pending * c.steal_take_pct / 100));
              take = Math.min(take, s2.pending);
              const a = animalById(gid, s2.animal_id);
              db.prepare('UPDATE ranch_slots SET pending = pending - ? WHERE guild_id=? AND user_id=? AND slot=?')
                .run(take, gid, to.id, s2.slot);
              addToBag(gid, uid, a.product_item_id, take);
              stolen.set(a.product_item_id, (stolen.get(a.product_item_id) || 0) + take);
            }
          });
          tx();
        }

        // 產物與動物都沒得手：真正的撲空（看門狗有咬到的話還是要講）
        if (!stolen.size && !animalStolen) {
          logSteal({ guildId: gid, kind: 'ranch', thiefId: uid, thiefName: uname,
            victimId: to.id, victimName: to.username,
            result: guardPenalty > 0 ? 'caught' : 'miss', penalty: guardPenalty, channelId: i.channelId });
          return await reply({
            content: totalPending > 0
              ? `你摸進了 ${to.username} 的牧場，但什麼都沒帶走！（今日 ${usedToday + 1}/${c.steal_daily_limit}）${guardNote}`
              : `你摸進了 ${to.username} 的牧場，產物都被收成光了，動物也沒牽成，撲空！（今日 ${usedToday + 1}/${c.steal_daily_limit}）${guardNote}`
          });
        }

        let value = 0;
        const lines = [...stolen.entries()].map(([itemId, n]) => {
          const p = productOf(itemId); if (p) value += n * livePrice(gid, p);
          return `${p ? (p.emoji || '') + p.name : '產物'} ×${n}`;
        });
        const loot = lines.length ? `你從 ${to.username} 的牧場偷走了：\n${lines.join('\n')}\n\n已放進你的背包，用 \`/賣出\` 換 ${gc.currency_name}。`
          : `${to.username} 的產物都被收光了，但你不是空手而歸——`;
        const embed = new EmbedBuilder().setColor(0xed4245).setTitle('🕵️ 偷取成功！')
          .setDescription(`${loot}${guardNote}${animalNote}`)
          .setFooter({ text: `約值 ${value.toLocaleString('en-US')} ${gc.currency_name}｜今日 ${usedToday + 1}/${c.steal_daily_limit}` });

        bumpAch(gid, uid, 'steal_success', 1);
        bumpAch(gid, to.id, 'robbed_count', 1);      // 受害者也記一筆（大賽「誰被偷最多」用得到）
        // 後台查得到真兇（前台公告仍匿名）
        logSteal({ guildId: gid, kind: 'ranch', thiefId: uid, thiefName: uname,
          victimId: to.id, victimName: to.username,
          result: guardPenalty > 0 ? 'caught' : 'success',
          loot: [...lines, animalStolen ? '（整隻動物被牽走）' : ''].filter(Boolean).join('、'),
          coins: value, penalty: guardPenalty, channelId: i.channelId });

        // 私訊通知被偷的人（對方關私訊會失敗，改在公告裡 @ 他，見下方 dmOk）
        const thief = i.member?.displayName || uname;
        let dmOk = false;
        if (stolen.size || animalStolen) {
          const guardDm = guardPenalty > 0 ? `\n\n🐕 你的 ${guardAnimal.emoji || ''}${guardAnimal.name} 咬了小偷，追回 ${money(gc, guardPenalty)}！` : '';
          const animalDm = animalStolen ? `\n\n😱 你的一隻動物被整隻牽走了！` : '';
          const lootDm = lines.length ? `從你的牧場偷走了：\n${lines.join('\n')}` : '摸進了你的牧場——';
          const dm = new EmbedBuilder().setColor(0xed4245).setTitle('🚨 你的牧場被偷了！')
            .setDescription(`**${thief}** ${lootDm}${guardDm}${animalDm}\n\n下次記得早點用 \`/收成\` 收，或去 \`/偷\` 討回來！`)
            .setFooter({ text: `發生在 ${i.guild.name}` });
          dmOk = await to.send({ embeds: [dm] }).then(() => true).catch(() => false);
        }
        // 公開公告：優先發到後台設定的固定公告頻道（ranch_config.steal_channel）。
        // 沒設定才退回小偷所在頻道 —— 舊行為會讓公告散落在各個冒險區頻道，
        // 被偷的人常常整天都不知道自己被偷了。
        if (stolen.size || animalStolen) {
          const ch = await stealChannel(i, gid);
          if (ch) {
            // 公告不寫小偷是誰：留白讓大家互相猜、互相指控，比直接點名有趣得多。
            // （被偷的人仍會收到私訊，私訊裡才有小偷名字）
            const pub = new EmbedBuilder().setColor(0xed4245).setTitle('🕵️ 牧場偷竊事件')
              .setDescription((lines.length
                ? `<@${to.id}> 的東西被**不知名人士**偷走了：\n${lines.join('\n')}`
                : `<@${to.id}> 的牧場被**不知名人士**摸進去了`) +
                (animalStolen ? `\n🐄💨 連**整隻動物**都被牽走了！` : '') +
                (guardPenalty > 0 ? `\n🐕 不過那傢伙被 ${guardAnimal.emoji || ''}${guardAnimal.name} 逮到，掉了 ${money(gc, guardPenalty)} 賠給 <@${to.id}>！` : ''))
              .setFooter({ text: '到底是誰做的？想討回來就去 /偷 反擊！' });
            // Embed 內的 <@id> 只顯示名字不會發通知，所以私訊送不出去時（對方關閉私訊）
            // 改用 content 真的 tag 他一下，否則他完全不會知道自己被偷。
            ch.send(dmOk
              ? { embeds: [pub] }
              : { content: `<@${to.id}>`, embeds: [pub], allowedMentions: { users: [to.id] } }).catch(() => {});
          }
        }
        return await reply({ embeds: [embed] });
      }

      // ---- 孵化：把背包裡的蛋放進孵化室 ----
      if (name === '孵化') {
        const defs = hatchList(gid);
        if (!defs.length) return await reply({ content: '目前沒有可孵化的蛋，管理員可到後台的孵化設定新增。' });
        const what = (i.options.getString('蛋') || '').trim();
        const def = defs.find(d => d.egg_name === what);
        if (!def) {
          const menu = defs.map(d => `${d.egg_emoji || '🥚'} ${d.egg_name} → ${d.animal_emoji || '🐾'}${d.animal_name}（${d.hatch_minutes} 分）`).join('\n');
          return await reply({ content: `找不到可孵化的「${what}」。目前可孵化：\n${menu}\n\n提示：直接點 \`/孵化室\` 的下拉選單放蛋更快。` });
        }
        const out = hatchEgg(gid, uid, uname, def.egg_item_id, i.options.getInteger('數量') || 1);
        if (out.error) return await reply({ content: out.error });
        return await reply({ embeds: [out.embed] });
      }

      // ---- 孵化室：查看＋領取孵好的動物 ----
      if (name === '孵化室') {
        const rows = db.prepare('SELECT * FROM ranch_incubator WHERE guild_id=? AND user_id=? ORDER BY slot').all(gid, uid);
        const now = Date.now();
        const hatched = []; const blocked = []; const failed = [];
        // 先領取已孵化完成的（牧場有空格才放得進去）
        for (const r of rows) {
          if (r.ready_at > now) continue;
          const a = animalById(gid, r.animal_id);
          if (!a) { db.prepare('DELETE FROM ranch_incubator WHERE guild_id=? AND user_id=? AND slot=?').run(gid, uid, r.slot); continue; }
          // 孵化失敗機率：失敗那顆蛋就沒了
          const def = db.prepare('SELECT fail_pct FROM ranch_hatch_defs WHERE guild_id=? AND egg_item_id=? AND animal_id=?').get(gid, r.egg_item_id, r.animal_id);
          if (def && def.fail_pct > 0 && Math.random() * 100 < def.fail_pct) {
            db.prepare('DELETE FROM ranch_incubator WHERE guild_id=? AND user_id=? AND slot=?').run(gid, uid, r.slot);
            failed.push(a);
            continue;
          }
          const slot = freeRanchSlot(gid, uid, effRanchSlots(gid, uid, c));
          if (slot < 0) { blocked.push({ a, slot: r.slot }); continue; }
          const tx = db.transaction(() => {
            db.prepare('INSERT INTO ranch_slots (guild_id,user_id,slot,animal_id,pending,last_produce_ms) VALUES (?,?,?,?,0,?)')
              .run(gid, uid, slot, a.id, Date.now());
            db.prepare('DELETE FROM ranch_incubator WHERE guild_id=? AND user_id=? AND slot=?').run(gid, uid, r.slot);
          });
          tx();
          hatched.push({ a, slot });
        }

        const remain = db.prepare('SELECT * FROM ranch_incubator WHERE guild_id=? AND user_id=? ORDER BY slot').all(gid, uid);
        const lines = [];
        const hMaxV = Math.max(effHatchSlots(gid, uid, c), remain.length ? Math.max(...remain.map(x => x.slot)) + 1 : 0);
        if (hMaxV <= 0) return await reply({ content: '你還沒有孵化室！用 `/製作` 做「孵化室」開一格才能孵蛋。' });
        for (let s = 0; s < hMaxV; s++) {
          const r = remain.find(x => x.slot === s);
          if (!r) { lines.push(`\`${s + 1}\`｜— 空 —`); continue; }
          const a = animalById(gid, r.animal_id);
          const nm = a ? (a.emoji || '🐾') + a.name : '動物';
          lines.push(r.ready_at > now
            ? `\`${s + 1}\`｜🥚→${nm}　<t:${Math.floor(r.ready_at / 1000)}:R>`
            : `\`${s + 1}\`｜✅ ${nm} 已孵化（牧場滿了，先 \`/放生\` 再回來領）`);
        }
        const defs = hatchList(gid);
        const embed = new EmbedBuilder().setColor(brandColor()).setTitle(`🐣 ${uname} 的孵化室`)
          .setDescription(lines.join('\n').slice(0, 4000));
        if (hatched.length) {
          embed.addFields({ name: '本次孵出', value: hatched.map(h => `${h.a.emoji || '🐾'}${h.a.name} → 牧場第 ${h.slot + 1} 格`).join('\n') });
        }
        if (failed.length) {
          embed.addFields({ name: '💔 孵化失敗（蛋沒了）', value: failed.map(a => `${a.emoji || '🐾'}${a.name}`).join('、') });
        }
        if (blocked.length) {
          embed.addFields({ name: `⚠️ 牧場已滿，${blocked.length} 隻孵好的動物先留在孵化室`,
            value: (blocked.map(b => `${b.a.emoji || '🐾'}${b.a.name}`).join('、').slice(0, 800)
              + (blocked.length > 25 ? `\n（下面的選單一次最多賣 25 隻，賣完再開一次 \`/孵化室\`）` : '')
              + '\n👇 可以直接用下面的選單「賣掉」換星幣（不用先挪牧場），或去空出牧場格子再回來領。') });
        }
        // 放蛋選單：只列「你背包裡真的有的蛋」，點一下就放進去，不用打指令
        const owned = defs.filter(d =>
          (db.prepare('SELECT count FROM gather_inventory WHERE guild_id=? AND user_id=? AND item_id=?').get(gid, uid, d.egg_item_id) || {}).count > 0);
        const hMaxNow = effHatchSlots(gid, uid, c);
        if (hMaxNow <= 0) {
          embed.setDescription('你還沒有孵化室，沒辦法放蛋。\n去 `/設施商店` 買一個（小孵化箱 350 星幣），或用 `/製作` 的「蓋孵化室（+1 格）」。');
        }
        embed.setFooter({ text: defs.length
          ? `可孵化：${defs.map(d => `${d.egg_name}→${d.animal_name}`).join('、')}`
          : '目前沒有設定任何可孵化的蛋' });
        // 滿了就直接講清楚（以前選單照樣顯示，點下去才說滿了，看起來就像「沒有數量可選」）
        const usedNow = remain.length;
        const freeNow = Math.max(0, hMaxNow - usedNow);
        if (hMaxNow > 0 && freeNow <= 0) {
          embed.addFields({
            name: '⚠️ 孵化室已滿',
            value: `${usedNow}/${hMaxNow} 格都佔著，放不進新的蛋。\n`
              + '先把孵好的領走（牧場要有空格），或用上面的選單直接賣掉，也可以去 `/設施商店` 升級孵化室。'
          });
        }
        const rows2 = (owned.length && hMaxNow > 0 && freeNow > 0) ? [new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder().setCustomId('hatchput').setPlaceholder(`選要孵的蛋（下一步選數量，還有 ${freeNow} 格）`)
            .addOptions(owned.slice(0, 25).map(d => {
              const have = (db.prepare('SELECT count FROM gather_inventory WHERE guild_id=? AND user_id=? AND item_id=?')
                .get(gid, uid, d.egg_item_id) || {}).count || 0;
              return {
                label: `${d.egg_name} → ${d.animal_name}`.slice(0, 100),
                description: `背包 ${have} 顆｜${d.hatch_minutes} 分／顆${d.fail_pct ? `　失敗率 ${d.fail_pct}%` : ''}`.slice(0, 100),
                value: String(d.egg_item_id), emoji: d.egg_emoji || '🥚'
              };
            }))) ] : [];
        if (!owned.length && hMaxNow > 0) {
          embed.addFields({ name: '🥚 放蛋', value: '你背包裡目前沒有可孵化的蛋。養雞鴨鵝鵪鶉會生蛋，狩獵也可能撿到野鳥蛋。' });
        }
        // 牧場滿了孵好的動物：直接在孵化室賣掉（免挪牧場），回收購買價一半
        // Discord 的下拉最多 25 個選項，maxValues 也不能超過 ——
        // 蛋放超過 25 顆的人（真的有）以前會直接讓整個 /孵化室 壞掉（Invalid number value）
        const sellOpts = blocked.slice(0, 25);
        // 一鍵賣出（孵好的全賣）：卡了幾十隻時一格一格勾太痛苦
        const allReady = remain.filter(r => r.ready_at <= now);
        const sellAllRow = allReady.length > 1 ? [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('hatchsellall')
            .setLabel(`💰 一鍵賣掉全部孵好的（${allReady.length} 隻）`).setStyle(ButtonStyle.Danger))] : [];
        const sellRow = sellOpts.length ? [new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder().setCustomId('hatchsell').setPlaceholder('💰 直接賣掉孵好的動物（牧場滿了免挪）')
            .setMinValues(1).setMaxValues(sellOpts.length)
            .addOptions(sellOpts.map(b => ({
              label: `賣掉 ${b.a.name}`.slice(0, 100),
              description: `回收 ${Math.max(1, Math.floor((b.a.price || 0) * SELL_PCT))} ${gc.currency_name}`.slice(0, 100),
              value: String(b.slot), emoji: b.a.emoji || '🐾'
            })))) ] : [];
        return await reply({ embeds: [embed], components: [...sellAllRow, ...sellRow, ...rows2].slice(0, 5) });
      }
    } catch (e) {
      logError(gid, '牧場指令失敗：', `${name}（${e.message}）`);
      const msg = { content: '執行失敗，管理員可到後台的系統錯誤紀錄查看原因。', flags: MessageFlags.Ephemeral };
      if (i.replied || i.deferred) await i.followUp(msg).catch(() => {});
      else await i.reply(msg).catch(() => {});
    }
  });

  console.log('  ↳ 牧場經營模組已載入（養動物/每日產出/收成/偷偷樂/孵化室）');
}

module.exports = { init, seedRanch, hatchEgg, partnerHarvest };
