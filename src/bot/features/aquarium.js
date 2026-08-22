// 魚缸：只養 SSR 觀賞魚。魚缸格子要自己買（設施商店，價格同農地）或製作（松木＋碎石），起始 0 格。
// 魚的來源：① 水族商店花星幣買　② 釣魚釣到的 SSR 魚（鯨魚/皇帶魚/美人魚）存進缸養。
// 跟牧場的差別：
//   1. 產出直接是星幣（不用進背包再 /賣出），但量刻意壓低，靠時間慢慢回本。
//   2. 每條魚要定期花星幣買飼料；沒餵會餓，餓太久就死掉（魚沒了，錢也拿不回來）。
//   3. 未領取的星幣可以被 /偷魚，運氣好連整條魚都會被撈走。
const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { db, guildConfig, logError } = require('../../db');
const { bump: bumpAch } = require('../../util/achievements');
const { brandColor } = require('../../util/brand');
const { wallet, addCoins, safeMenu } = require('./gather');
const { facilitySlots, facilityBonus } = require('./facility');
const { logSteal, stealChannel } = require('../../util/steal');
const { buffPct } = require('../../util/buffs');

const acfg = (gid) => guildConfig('aquarium_config', gid);
const gcfg = (gid) => guildConfig('gather_config', gid);
// 有效魚缸格數＝設定底數 + 製作解鎖 + 設施商店買的（跟農地/牧場同一套邏輯）
const aqUnlocks = (gid, uid) => (db.prepare('SELECT aquarium FROM aquarium_unlocks WHERE guild_id=? AND user_id=?').get(gid, uid) || {}).aquarium || 0;
const effSlots = (gid, uid) => Math.max(0, acfg(gid).max_slots) + aqUnlocks(gid, uid) + facilitySlots(gid, uid, 'aquarium');
const csv = (s) => String(s || '').split(/[\n,]/).map(x => x.trim()).filter(Boolean);
const money = (c, n) => `${c.currency_emoji || '🪙'} ${Number(n).toLocaleString('en-US')} ${c.currency_name || '星幣'}`;
const { localToday } = require('../../util/time');
const today = () => localToday();
const H = 3600000;

// 預設 SSR 魚：[名稱, emoji, 售價, 每日產星幣, 每次飼料費, 說明]
// 平衡原則：淨收益 ≈ 售價 ÷ 50，也就是天天記得餵、都沒被偷，大約 50 天回本。
// 魚很貴（最低 3000、最高 20000），產出刻意壓低，不會取代採集與牧場。
const SEED_FISH = [
  ['錦鯉', '🎏', 3000, 100, 40, 'SSR 入門觀賞魚，穩定但不驚人'],
  ['神仙魚', '🐠', 4000, 130, 50, '飄逸的熱帶魚，產值中上'],
  ['河豚', '🐡', 4500, 145, 55, '圓滾滾的高級魚'],
  ['章魚', '🐙', 5000, 160, 60, '聰明又難養的軟體動物'],
  ['水母', '🪼', 6000, 190, 70, '要細心照顧的夢幻生物'],
  ['海龜', '🐢', 8000, 250, 90, '長壽穩健，產值高'],
  ['龍魚', '🐉', 12000, 360, 120, '傳說中的招財魚，飼料也貴'],
  ['鯊魚', '🦈', 20000, 580, 180, '魚缸的頂點，胃口驚人']
];

function seedAquarium(gid) {
  acfg(gid);
  try {
    const has = db.prepare('SELECT id FROM aquarium_fish WHERE guild_id=? AND name=?');
    const ins = db.prepare('INSERT INTO aquarium_fish (guild_id,name,emoji,price,coin_per_day,feed_cost,sort,description) VALUES (?,?,?,?,?,?,?,?)');
    db.transaction(() => {
      SEED_FISH.forEach(([name, emoji, price, perDay, feed, desc], idx) => {
        if (has.get(gid, name)) return;
        ins.run(gid, name, emoji, price, perDay, feed, idx, desc);
      });
      db.prepare('UPDATE aquarium_config SET seeded=1 WHERE guild_id=?').run(gid);
    })();
  } catch (e) { logError(gid, '魚缸預設內容建立失敗：', e.message); }
}

const fishById = (gid, id) => db.prepare('SELECT * FROM aquarium_fish WHERE guild_id=? AND id=?').get(gid, id);
const slotsOf = (gid, uid) => db.prepare('SELECT * FROM aquarium_slots WHERE guild_id=? AND user_id=? ORDER BY slot').all(gid, uid);

function freeSlot(gid, uid, max) {
  const used = slotsOf(gid, uid).map(r => r.slot);
  for (let s = 0; s < max; s++) if (!used.includes(s)) return s;
  return -1;
}

// 結算：只有「有飼料的那段時間」才產星幣；餓著的時間不算。
// 餓超過 starve_hours 就死掉（該格清空，未領取的星幣一起沒了 —— 這就是不餵的代價）。
// 回傳 { slots, died: [魚] }
function accrue(gid, uid) {
  const c = acfg(gid);
  const now = Date.now();
  const rows = slotsOf(gid, uid);
  const upd = db.prepare('UPDATE aquarium_slots SET pending=?, last_produce_ms=? WHERE guild_id=? AND user_id=? AND slot=?');
  const del = db.prepare('DELETE FROM aquarium_slots WHERE guild_id=? AND user_id=? AND slot=?');
  const alive = []; const died = [];
  for (const s of rows) {
    const f = fishById(gid, s.fish_id);
    if (!f) { del.run(gid, uid, s.slot); continue; }
    const fed = s.fed_until_ms || 0;
    if (now - fed > Math.max(1, c.starve_hours) * H) { del.run(gid, uid, s.slot); died.push(f); continue; }
    const from = s.last_produce_ms || now;
    const to = Math.min(now, fed);
    if (to > from) {
      const cap = Math.max(1, f.coin_per_day) * Math.max(1, c.max_accrue_days);
      const earned = Math.floor((to - from) * Math.max(0, f.coin_per_day) / 86400000);
      const pending = Math.min(cap, s.pending + earned);
      // 產滿上限就停產（跟牧場一樣，逼玩家回來領），時間指標推到已結算的位置
      s.pending = pending;
    }
    // 餓肚子的時間不能事後補領：指標直接推到現在
    s.last_produce_ms = now > fed ? now : Math.max(from, to);
    upd.run(s.pending, s.last_produce_ms, gid, uid, s.slot);
    alive.push(s);
  }
  return { slots: alive, died };
}

// 買一條魚。/養魚 與水族商店選單共用。
function buyFish(gid, uid, uname, fishId) {
  const c = acfg(gid), gc = gcfg(gid);
  const f = db.prepare('SELECT * FROM aquarium_fish WHERE guild_id=? AND enabled=1 AND id=?').get(gid, fishId);
  if (!f) return { error: '這條魚已經不在水族商店裡了。' };
  const max = effSlots(gid, uid);
  if (max <= 0) return { error: '你還沒有魚缸！去 `/設施商店` 買一個（很貴），或用 `/製作` 蓋魚缸（松木＋碎石，跟開闢農地一樣）。' };
  const free = freeSlot(gid, uid, max);
  if (free < 0) return { error: `你的魚缸已經滿了（${max} 格）。可以先 \`/賣魚\` 空出一格，或去 \`/設施商店\`／\`/製作\` 擴充。` };
  const w = wallet(gid, uid, uname);
  const total = f.price + f.feed_cost;   // 買魚時附第一份飼料，直接開始產出
  if (w.coins < total) {
    return { error: `${gc.currency_name}不夠：${f.emoji || '🐟'}${f.name} 要 ${f.price.toLocaleString('en-US')}（含第一份飼料 ${f.feed_cost} → 共 ${total.toLocaleString('en-US')}），你只有 ${w.coins.toLocaleString('en-US')}。` };
  }
  const now = Date.now();
  const fedUntil = now + Math.max(1, c.feed_hours) * H;
  db.transaction(() => {
    db.prepare('UPDATE econ_wallets SET coins = coins - ? WHERE guild_id=? AND user_id=?').run(total, gid, uid);
    db.prepare('INSERT INTO aquarium_slots (guild_id,user_id,slot,fish_id,pending,last_produce_ms,fed_until_ms) VALUES (?,?,?,?,0,?,?)')
      .run(gid, uid, free, f.id, now, fedUntil);
  })();
  const used = slotsOf(gid, uid).length;
  return { embed: new EmbedBuilder().setColor(brandColor()).setTitle('🐠 入缸成功')
    .setDescription(`${f.emoji || '🐟'} **${f.name}**（SSR）住進魚缸第 ${free + 1} 格！\n` +
      `每天產 ${money(gc, f.coin_per_day)}，餵一次飼料 ${money(gc, f.feed_cost)}（撐 ${c.feed_hours} 小時）。\n` +
      `已附第一份飼料，吃到 <t:${Math.floor(fedUntil / 1000)}:R>。\n\n` +
      `⚠️ 餓超過 **${c.starve_hours} 小時**就會死掉，記得 \`/餵魚\`。\n` +
      `💰 累積的星幣用 \`/撈金\` 領走，沒領的會被別人 \`/偷魚\`。`)
    .setFooter({ text: `魚缸 ${used}/${max} 格｜餘額 ${(w.coins - total).toLocaleString('en-US')} ${gc.currency_name}` }) };
}

// 一次養多條魚（水族商店多選）。有幾格買幾條、錢不夠就買到不能買為止。
function buyFishMulti(gid, uid, uname, ids) {
  const c = acfg(gid), gc = gcfg(gid);
  const max = effSlots(gid, uid);
  if (max <= 0) return { error: '你還沒有魚缸！去 `/設施商店` 買一個，或用 `/製作` 蓋魚缸。' };
  const now = Date.now();
  const fedUntil = now + Math.max(1, c.feed_hours) * H;
  const bought = []; const skipped = [];
  db.transaction(() => {
    for (const id of ids) {
      const f = db.prepare('SELECT * FROM aquarium_fish WHERE guild_id=? AND enabled=1 AND id=?').get(gid, id);
      if (!f) continue;
      const free = freeSlot(gid, uid, max);
      if (free < 0) { skipped.push(`${f.emoji || '🐟'}${f.name}（沒空格）`); continue; }
      const total = f.price + f.feed_cost;
      const w = wallet(gid, uid, uname);
      if (w.coins < total) { skipped.push(`${f.emoji || '🐟'}${f.name}（錢不夠）`); continue; }
      db.prepare('UPDATE econ_wallets SET coins = coins - ? WHERE guild_id=? AND user_id=?').run(total, gid, uid);
      db.prepare('INSERT INTO aquarium_slots (guild_id,user_id,slot,fish_id,pending,last_produce_ms,fed_until_ms) VALUES (?,?,?,?,0,?,?)')
        .run(gid, uid, free, f.id, now, fedUntil);
      bought.push(f);
    }
  })();
  if (!bought.length) return { error: '沒買到魚：' + (skipped.join('、') || '狀態有變，再試一次') };
  const spent = bought.reduce((a, f) => a + f.price + f.feed_cost, 0);
  const w = wallet(gid, uid, uname);
  const used = slotsOf(gid, uid).length;
  return { embed: new EmbedBuilder().setColor(brandColor()).setTitle(`🐠 養了 ${bought.length} 條魚`)
    .setDescription(bought.map(f => `${f.emoji || '🐟'} ${f.name}　每天產 ${money(gc, f.coin_per_day)}`).join('\n') +
      `\n\n都已附第一份飼料，吃到 <t:${Math.floor(fedUntil / 1000)}:R>。記得定期 \`/餵魚\`、\`/撈金\`。` +
      (skipped.length ? `\n\n⚠️ 沒買到：${skipped.join('、')}` : ''))
    .setFooter({ text: `花了 ${spent.toLocaleString('en-US')}｜魚缸 ${used}/${max} 格｜餘額 ${w.coins.toLocaleString('en-US')} ${gc.currency_name}` }) };
}

// 把「釣到的魚」存進魚缸（消耗背包物品，開始像商店魚一樣產星幣）。
function depositFish(gid, uid, uname, itemIds) {
  const c = acfg(gid), gc = gcfg(gid);
  const max = effSlots(gid, uid);
  if (max <= 0) return { error: '你還沒有魚缸！去 `/設施商店` 買一個，或用 `/製作` 蓋魚缸。' };
  const now = Date.now();
  const fedUntil = now + Math.max(1, c.feed_hours) * H;
  const done = []; const skipped = [];
  db.transaction(() => {
    for (const itemId of itemIds) {
      const af = db.prepare('SELECT * FROM aquarium_fish WHERE guild_id=? AND catch_item_id=? AND enabled=1').get(gid, itemId);
      if (!af) continue;
      const inv = db.prepare('SELECT count FROM gather_inventory WHERE guild_id=? AND user_id=? AND item_id=?').get(gid, uid, itemId);
      if (!inv || inv.count < 1) { skipped.push(`${af.emoji || '🐟'}${af.name}（背包沒有）`); continue; }
      const free = freeSlot(gid, uid, max);
      if (free < 0) { skipped.push(`${af.emoji || '🐟'}${af.name}（沒空格）`); continue; }
      db.prepare('UPDATE gather_inventory SET count = count - 1 WHERE guild_id=? AND user_id=? AND item_id=?').run(gid, uid, itemId);
      db.prepare('INSERT INTO aquarium_slots (guild_id,user_id,slot,fish_id,pending,last_produce_ms,fed_until_ms) VALUES (?,?,?,?,0,?,?)')
        .run(gid, uid, free, af.id, now, fedUntil);
      done.push(af);
    }
  })();
  if (!done.length) return { error: '沒有魚存進去：' + (skipped.join('、') || '背包裡沒有可存的釣獲魚') };
  const used = slotsOf(gid, uid).length;
  return { embed: new EmbedBuilder().setColor(brandColor()).setTitle(`🎣 存了 ${done.length} 條釣獲魚`)
    .setDescription(done.map(f => `${f.emoji || '🐟'} ${f.name}　每天產 ${money(gc, f.coin_per_day)}／飼料 ${f.feed_cost}`).join('\n') +
      `\n\n都已附第一份飼料，吃到 <t:${Math.floor(fedUntil / 1000)}:R>。記得 \`/餵魚\`、\`/撈金\`。` +
      (skipped.length ? `\n\n⚠️ 沒存到：${skipped.join('、')}` : ''))
    .setFooter({ text: `魚缸 ${used}/${max} 格` }) };
}

// 賣掉一條魚：回收購買價一半，未領取的星幣一起入帳。
const SELL_PCT = 0.5;
function sellFish(gid, uid, uname, slot) {
  const gc = gcfg(gid);
  accrue(gid, uid);
  const row = db.prepare('SELECT * FROM aquarium_slots WHERE guild_id=? AND user_id=? AND slot=?').get(gid, uid, slot);
  if (!row) return { error: `魚缸第 ${slot + 1} 格沒有魚。用 \`/魚缸\` 看看。` };
  const f = fishById(gid, row.fish_id);
  const refund = f ? Math.max(1, Math.floor((f.price || 0) * SELL_PCT)) : 1;
  const gain = refund + (row.pending || 0);
  db.transaction(() => {
    db.prepare('DELETE FROM aquarium_slots WHERE guild_id=? AND user_id=? AND slot=?').run(gid, uid, slot);
    addCoins(gid, uid, uname, gain);
  })();
  return { embed: new EmbedBuilder().setColor(brandColor()).setTitle('💰 已賣魚')
    .setDescription(`${f ? (f.emoji || '🐟') + f.name : '魚'}（第 ${slot + 1} 格）賣掉，回收 ${money(gc, refund)}` +
      (row.pending > 0 ? `，加上缸裡未領的 ${money(gc, row.pending)}` : '') + `。`)
    .setFooter({ text: `餘額 ${wallet(gid, uid, uname).coins.toLocaleString('en-US')} ${gc.currency_name}` }) };
}

// 一次賣多條魚（魚缸下拉多選）。每條回收售價一半＋缸裡未領星幣。
function sellFishMulti(gid, uid, uname, slots) {
  const gc = gcfg(gid);
  accrue(gid, uid);
  let gain = 0; const sold = [];
  db.transaction(() => {
    for (const slot of slots) {
      const row = db.prepare('SELECT * FROM aquarium_slots WHERE guild_id=? AND user_id=? AND slot=?').get(gid, uid, slot);
      if (!row) continue;
      const f = fishById(gid, row.fish_id);
      const g = (f ? Math.max(1, Math.floor((f.price || 0) * SELL_PCT)) : 1) + (row.pending || 0);
      db.prepare('DELETE FROM aquarium_slots WHERE guild_id=? AND user_id=? AND slot=?').run(gid, uid, slot);
      addCoins(gid, uid, uname, g);
      gain += g; sold.push(`${f ? (f.emoji || '🐟') + f.name : '魚'}（第 ${slot + 1} 格）　+${money(gc, g)}`);
    }
  })();
  if (!sold.length) return { error: '這些魚已經不在缸裡了。' };
  return { embed: new EmbedBuilder().setColor(brandColor()).setTitle(`💰 賣了 ${sold.length} 條魚`)
    .setDescription(sold.join('\n') + `\n\n共回收 ${money(gc, gain)}。`)
    .setFooter({ text: `餘額 ${wallet(gid, uid, uname).coins.toLocaleString('en-US')} ${gc.currency_name}` }) };
}

// 餵魚：一次餵所有「快沒飼料」的魚，錢不夠就從便宜的開始餵幾條算幾條。
function feedAll(gid, uid, uname) {
  const c = acfg(gid), gc = gcfg(gid);
  const { slots, died } = accrue(gid, uid);
  if (!slots.length) return { error: died.length ? `你的魚全都餓死了…（${died.map(f => (f.emoji || '') + f.name).join('、')}）快去 \`/水族商店\` 重新開始。` : '你的魚缸裡還沒有魚，先去 `/水族商店` 買一條。' };
  const now = Date.now();
  const stockCap = now + Math.max(1, c.stock_hours) * H;   // 最多先餵到這個時間，避免一次囤一年
  // 要「整份飼料塞得進上限」才餵，否則錢照收、時間卻被削掉，玩家會覺得被坑
  const feedable = slots
    .map(s => ({ s, f: fishById(gid, s.fish_id) }))
    .filter(x => x.f && Math.max(now, x.s.fed_until_ms || 0) + Math.max(1, c.feed_hours) * H <= stockCap)
    .sort((a, b) => a.f.feed_cost - b.f.feed_cost);
  if (!feedable.length) return { error: `你的魚都還很飽（最多只能先餵到 ${c.stock_hours} 小時後），等等再來。` };

  // 飼料以「魚飼料」物品優先（種植/購買取得），沒有物品才用星幣買
  const feedItem = db.prepare("SELECT id FROM gather_items WHERE guild_id=? AND name='魚飼料' AND enabled=1 ORDER BY id LIMIT 1").get(gid);
  let feedStock = feedItem ? ((db.prepare('SELECT count FROM gather_inventory WHERE guild_id=? AND user_id=? AND item_id=?').get(gid, uid, feedItem.id) || {}).count || 0) : 0;
  let coins = wallet(gid, uid, uname).coins;
  const fedList = []; let spent = 0; let usedFeed = 0; let skipped = 0;
  db.transaction(() => {
    for (const { s, f } of feedable) {
      let paid = false;
      if (feedStock > 0) { feedStock--; usedFeed++; paid = true; }          // 先用種/買來的飼料
      else if (coins >= f.feed_cost) { coins -= f.feed_cost; spent += f.feed_cost; paid = true; }  // 沒飼料就用星幣
      if (!paid) { skipped++; continue; }
      const base = Math.max(now, s.fed_until_ms || 0);
      const until = base + Math.max(1, c.feed_hours) * H;
      db.prepare('UPDATE aquarium_slots SET fed_until_ms=? WHERE guild_id=? AND user_id=? AND slot=?').run(until, gid, uid, s.slot);
      fedList.push({ f, slot: s.slot, until });
    }
    if (usedFeed > 0 && feedItem) db.prepare('UPDATE gather_inventory SET count = count - ? WHERE guild_id=? AND user_id=? AND item_id=?').run(usedFeed, gid, uid, feedItem.id);
    if (spent > 0) db.prepare('UPDATE econ_wallets SET coins = coins - ? WHERE guild_id=? AND user_id=?').run(spent, gid, uid);
  })();

  if (!fedList.length) return { error: `沒有魚飼料、星幣也不夠（最便宜一份要 ${feedable[0].f.feed_cost}）。🍤魚飼料可以「種植飼料草」收成，或用星幣餵。魚餓太久會死掉！` };
  const lines = fedList.map(x => `${x.f.emoji || '🐟'}${x.f.name}（第 ${x.slot + 1} 格）　吃到 <t:${Math.floor(x.until / 1000)}:R>`);
  const embed = new EmbedBuilder().setColor(brandColor()).setTitle('🍤 餵魚完成')
    .setDescription(lines.join('\n') +
      (skipped ? `\n\n⚠️ 有 ${skipped} 條沒飼料也沒錢餵，餓超過 ${c.starve_hours} 小時就會死掉！` : '') +
      (died.length ? `\n\n💀 這些魚在你回來之前就餓死了：${died.map(f => (f.emoji || '') + f.name).join('、')}` : ''))
    .setFooter({ text: `用了 ${usedFeed} 份飼料｜花 ${spent.toLocaleString('en-US')} 星幣｜剩飼料 ${feedStock}｜餘額 ${coins.toLocaleString('en-US')} ${gc.currency_name}` });
  return { embed };
}

// 撈金：把缸裡累積的星幣領進錢包
function collect(gid, uid, uname) {
  const gc = gcfg(gid);
  const { slots, died } = accrue(gid, uid);
  const total = slots.reduce((a, s) => a + s.pending, 0);
  if (total <= 0) {
    return { error: (died.length ? `💀 ${died.map(f => (f.emoji || '') + f.name).join('、')} 餓死了…\n` : '') + '魚缸裡還沒有可以領的星幣，魚兒們還在努力。' };
  }
  db.transaction(() => {
    db.prepare('UPDATE aquarium_slots SET pending=0 WHERE guild_id=? AND user_id=?').run(gid, uid);
    addCoins(gid, uid, uname, total);
  })();
  return { embed: new EmbedBuilder().setColor(brandColor()).setTitle('🪙 撈金成功')
    .setDescription(`從魚缸領走 **${money(gc, total)}**。` + (died.length ? `\n\n💀 不過 ${died.map(f => (f.emoji || '') + f.name).join('、')} 餓死了…` : ''))
    .setFooter({ text: `餘額 ${wallet(gid, uid, uname).coins.toLocaleString('en-US')} ${gc.currency_name}` }) };
}

const stealCount = (gid, uid) =>
  (db.prepare('SELECT count FROM aquarium_steal WHERE guild_id=? AND user_id=? AND day=?').get(gid, uid, today()) || {}).count || 0;
const bumpSteal = (gid, uid) => db.prepare(
  `INSERT INTO aquarium_steal (guild_id,user_id,day,count) VALUES (?,?,?,1)
   ON CONFLICT(guild_id,user_id,day) DO UPDATE SET count = count + 1`).run(gid, uid, today());

function init(client) {
  for (const [gid] of client.guilds.cache) {
    try { seedAquarium(gid); } catch (e) { logError(gid, '魚缸初始化失敗：', e.message); }
  }

  const CMDS = ['魚缸', '水族商店', '養魚', '餵魚', '撈金', '賣魚', '偷魚'];
  const BTN = { 'adv:aquarium': '魚缸', 'adv:aqshop': '水族商店', 'adv:feed': '餵魚', 'adv:aqcollect': '撈金' };

  client.on('interactionCreate', async (i) => {
    // 選好魚 → 列出「要養幾條」的數量選單（依空格與餘額算上限）
    if (i.isStringSelectMenu() && i.customId === 'aqbuyone') {
      const gid = i.guildId, uid = i.user.id, gc = gcfg(gid);
      const id = parseInt(i.values[0], 10);
      const f = db.prepare('SELECT * FROM aquarium_fish WHERE guild_id=? AND enabled=1 AND id=?').get(gid, id);
      if (!f) return i.update({ content: '這條魚已經不在水族商店了。', components: [], embeds: [] }).catch(() => {});
      const max = effSlots(gid, uid);
      const usedSlots = slotsOf(gid, uid).length;
      const freeN = Math.max(0, max - usedSlots);
      if (freeN <= 0) return i.update({ content: '你的魚缸滿了，先 `/賣魚` 或去 `/設施商店`／`/製作` 擴充。', components: [], embeds: [] }).catch(() => {});
      const each = f.price + f.feed_cost;
      const afford = Math.floor(wallet(gid, uid, i.user.username).coins / Math.max(1, each));
      const maxBuy = Math.min(freeN, afford);
      if (maxBuy <= 0) return i.update({ content: `${gc.currency_name}不夠買一條 ${f.emoji || ''}${f.name}（要 ${each.toLocaleString('en-US')}）。`, components: [], embeds: [] }).catch(() => {});
      const amts = [...new Set([1, 2, 3, 5, 10].filter(x => x < maxBuy).concat([maxBuy]))].sort((a, b) => a - b);
      const opts = amts.slice(0, 25).map(a => ({
        label: a === maxBuy ? `養 ${a} 條（最多）` : `養 ${a} 條`,
        description: `花 ${(each * a).toLocaleString('en-US')} ${gc.currency_name}`.slice(0, 100), value: String(a)
      }));
      const menu = new StringSelectMenuBuilder().setCustomId('aqbuyqty:' + id).setPlaceholder('要養幾條？').setMinValues(1).setMaxValues(1).addOptions(opts);
      return i.update({ content: `${f.emoji || '🐟'}${f.name}：要養幾條？（空格 ${freeN}，每條 ${each.toLocaleString('en-US')} ${gc.currency_name}）`, components: [new ActionRowBuilder().addComponents(menu)], embeds: [] }).catch(() => {});
    }
    // 選好數量 → 一次養多條同款
    if (i.isStringSelectMenu() && i.customId.startsWith('aqbuyqty:')) {
      const id = parseInt(i.customId.split(':')[1], 10);
      const qty = Math.max(1, parseInt(i.values[0], 10) || 1);
      return safeMenu(i, '購買魚', () => buyFishMulti(i.guildId, i.user.id, i.user.username, Array(qty).fill(id)));
    }
    if (i.isStringSelectMenu() && i.customId === 'aqsell') {
      return safeMenu(i, '賣魚', () => sellFishMulti(i.guildId, i.user.id, i.user.username, i.values.map(v => parseInt(v, 10))));
    }
    // 存魚入缸：按鈕 → 列出背包裡「釣到的、可存的魚」→ 選單存入
    if (i.isButton() && i.customId === 'adv:aqdeposit') {
      const gid = i.guildId, uid = i.user.id;
      const rows = db.prepare(
        `SELECT af.catch_item_id AS item_id, af.name, af.emoji, af.coin_per_day, v.count
           FROM aquarium_fish af JOIN gather_inventory v ON v.item_id = af.catch_item_id
          WHERE af.guild_id=? AND af.enabled=1 AND af.catch_item_id>0 AND v.guild_id=? AND v.user_id=? AND v.count>0
          ORDER BY af.coin_per_day`).all(gid, gid, uid);
      if (!rows.length) return i.reply({ content: '你背包裡沒有可以存進魚缸的釣獲魚（釣魚釣到 🐋鯨魚／🐉皇帶魚／🧜美人魚 才能存）。', flags: MessageFlags.Ephemeral });
      const menu = new StringSelectMenuBuilder().setCustomId('aqdeposit').setPlaceholder('選要存進魚缸的魚（可多選）')
        .setMinValues(1).setMaxValues(Math.min(rows.length, 25))
        .addOptions(rows.slice(0, 25).map(r => ({
          label: `${r.emoji || ''}${r.name}（有 ${r.count}）`.slice(0, 100),
          description: `存進缸每天產 ${r.coin_per_day} 星幣`.slice(0, 100), value: String(r.item_id), emoji: r.emoji || '🐟'
        })));
      return i.reply({ content: '要存哪些釣獲魚進魚缸？（每種存 1 條，佔 1 格）', components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral });
    }
    if (i.isStringSelectMenu() && i.customId === 'aqdeposit') {
      return safeMenu(i, '存魚', () => depositFish(i.guildId, i.user.id, i.user.username, i.values.map(v => parseInt(v, 10)).filter(Boolean)));
    }
    const isBtn = i.isButton();
    const cmdName = isBtn ? BTN[i.customId] : (i.isChatInputCommand() ? i.commandName : null);
    if (!cmdName || !CMDS.includes(cmdName)) return;
    const gid = i.guildId;
    if (!gid) return i.reply({ content: '這個指令只能在伺服器裡使用。', flags: MessageFlags.Ephemeral });
    seedAquarium(gid);
    const c = acfg(gid), gc = gcfg(gid);
    if (!c.enabled) return i.reply({ content: '魚缸系統目前停用中。', flags: MessageFlags.Ephemeral });

    // 沿用冒險區的頻道限制設定
    const allowed = csv(gc.channels);
    if (allowed.length && !allowed.includes(i.channelId)) {
      return i.reply({ content: `這個指令只能在 ${allowed.map(id => `<#${id}>`).join('、')} 使用。`, flags: MessageFlags.Ephemeral });
    }

    const uid = i.user.id, uname = i.user.username, name = cmdName;
    const reply = (payload) => i.reply({ ...payload, flags: MessageFlags.Ephemeral });
    const out = (r) => reply(r.error ? { content: r.error } : { embeds: [r.embed] });

    try {
      // ---- 水族商店 ----
      if (name === '水族商店') {
        const list = db.prepare('SELECT * FROM aquarium_fish WHERE guild_id=? AND enabled=1 AND (catch_item_id=0 OR catch_item_id IS NULL) ORDER BY sort, price').all(gid);
        if (!list.length) return await reply({ content: '水族商店目前還沒有任何魚。' });
        const w = wallet(gid, uid, uname);
        const used = slotsOf(gid, uid).length;
        const line = (f) => {
          const net = f.coin_per_day - f.feed_cost * (24 / Math.max(1, c.feed_hours));
          return `${f.emoji || '🐟'} **${f.name}**　\`SSR\`　${money(gc, f.price)}\n` +
            `　　每天產 ${f.coin_per_day.toLocaleString('en-US')}／飼料 ${f.feed_cost}（撐 ${c.feed_hours} 小時）→ 淨賺約 **${Math.round(net).toLocaleString('en-US')}/天**` +
            (f.description ? `\n　　${f.description}` : '');
        };
        const embeds = [new EmbedBuilder().setColor(0x3498db).setTitle('🐠 水族商店（只賣 SSR）')
          .setDescription(`魚很貴，但養得好會**每天自己生星幣**。\n` +
            `你的餘額：**${w.coins.toLocaleString('en-US')} ${gc.currency_name}**　魚缸：**${used}/${effSlots(gid, uid)} 格**（用 \`/設施商店\` 買、\`/製作\` 蓋）\n` +
            `買魚時會**附第一份飼料**，之後每 ${c.feed_hours} 小時要 \`/餵魚\`，餓超過 ${c.starve_hours} 小時魚會死。`),
          new EmbedBuilder().setColor(0x3498db).setDescription(list.map(line).join('\n').slice(0, 4000))];
        const rows = [new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder().setCustomId('aqbuyone').setPlaceholder('選一種 SSR 魚（下一步選要幾條）')
            .setMinValues(1).setMaxValues(1)
            .addOptions(list.slice(0, 25).map(f => ({
              label: f.name.slice(0, 100),
              description: `${(f.price + f.feed_cost).toLocaleString('en-US')} ${gc.currency_name}｜每天產 ${f.coin_per_day}／飼料 ${f.feed_cost}`.slice(0, 100),
              value: String(f.id), emoji: f.emoji || '🐟'
            }))))];
        return await reply({ embeds, components: rows });
      }

      // ---- 養魚（買魚）----
      if (name === '養魚') {
        const what = (i.options.getString('魚') || '').trim();
        const f = db.prepare('SELECT * FROM aquarium_fish WHERE guild_id=? AND enabled=1 AND name=?').get(gid, what);
        if (!f) return await reply({ content: `找不到魚「${what}」，用 \`/水族商店\` 看看有哪些。` });
        return await out(buyFish(gid, uid, uname, f.id));
      }

      // ---- 魚缸一覽 ----
      if (name === '魚缸') {
        const target = (!isBtn && i.options.getUser('玩家')) || i.user;
        const { slots, died } = accrue(gid, target.id);
        const now = Date.now();
        const lines = []; let total = 0; let hungry = 0;
        const shownMax = Math.max(effSlots(gid, target.id), slots.length ? Math.max(...slots.map(x => x.slot)) + 1 : 0);
        if (shownMax <= 0) return await reply({ content: '你還沒有魚缸～ 去 `/設施商店` 買一個（很貴），或用 `/製作` 蓋魚缸（松木＋碎石，跟開闢農地一樣）。有了魚缸再去 `/水族商店` 買 SSR 魚。' });
        for (let s = 0; s < shownMax; s++) {
          const row = slots.find(x => x.slot === s);
          if (!row) { lines.push(`\`${s + 1}\`｜— 空缸 —`); continue; }
          const f = fishById(gid, row.fish_id);
          total += row.pending;
          const fed = row.fed_until_ms || 0;
          const state = fed > now
            ? `🍤 吃到 <t:${Math.floor(fed / 1000)}:R>`
            : `🥺 **餓著**（<t:${Math.floor((fed + Math.max(1, c.starve_hours) * H) / 1000)}:R> 會死）`;
          if (fed <= now) hungry++;
          lines.push(`\`${s + 1}\`｜${f ? (f.emoji || '🐟') + f.name : '魚'}　🪙 ${row.pending.toLocaleString('en-US')}　${state}`);
        }
        const embed = new EmbedBuilder().setColor(0x3498db).setTitle(`🐠 ${target.username} 的魚缸`)
          .setDescription(lines.join('\n') +
            (died.length ? `\n\n💀 **${died.map(f => (f.emoji || '') + f.name).join('、')}** 餓死了…（缸裡的星幣也一起沒了）` : '') +
            (hungry ? `\n\n⚠️ 有 ${hungry} 條魚餓著，快 \`/餵魚\`！` : '') +
            '\n\n`/餵魚` 買飼料　`/撈金` 領星幣　`/賣魚` 換現金')
          .setFooter({ text: `缸裡未領取 ${total.toLocaleString('en-US')} ${gc.currency_name}（沒領會被 /偷魚）` });
        const own = isBtn || target.id === uid;
        const sellOpts = own ? slots.map(s => {
          const f = fishById(gid, s.fish_id);
          return { label: `第 ${s.slot + 1} 格：${f ? f.name : '魚'}`.slice(0, 100),
            description: `賣掉回收 ${f ? Math.max(1, Math.floor(f.price * SELL_PCT)).toLocaleString('en-US') : 1} ${gc.currency_name}`.slice(0, 100),
            value: String(s.slot), emoji: (f && f.emoji) || '🐟' };
        }) : [];
        const rows = sellOpts.length ? [new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder().setCustomId('aqsell').setPlaceholder('💰 賣魚（可多選，回收一半＋缸裡星幣）')
            .setMinValues(1).setMaxValues(Math.min(sellOpts.length, 25)).addOptions(sellOpts.slice(0, 25)))] : [];
        // 日常兩鍵：餵魚（花星幣）與撈金（領星幣），不用再打指令
        if (own) rows.push(new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('adv:feed').setLabel('餵魚').setEmoji('🍤').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('adv:aqcollect').setLabel('撈金').setEmoji('🪙').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('adv:aqdeposit').setLabel('存釣獲魚').setEmoji('🎣').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('adv:aqshop').setLabel('水族商店').setEmoji('🐠').setStyle(ButtonStyle.Secondary)));
        return await reply({ embeds: [embed], components: rows });
      }

      if (name === '餵魚') return await out(feedAll(gid, uid, uname));
      if (name === '撈金') return await out(collect(gid, uid, uname));
      if (name === '賣魚') return await out(sellFish(gid, uid, uname, (i.options.getInteger('格子') || 0) - 1));

      // ---- 偷魚 ----
      if (name === '偷魚') {
        if (!c.steal_enabled) return await reply({ content: '目前沒有開放偷魚缸。' });
        const to = i.options.getUser('對象');
        if (to.bot) return await reply({ content: '不能偷機器人。' });
        if (to.id === uid) return await reply({ content: '不能偷自己的魚缸。' });
        const usedToday = stealCount(gid, uid);
        if (usedToday >= c.steal_daily_limit) {
          return await reply({ content: `你今天的偷魚次數已用完（每日上限 ${c.steal_daily_limit} 次），明天再來吧！` });
        }
        const { slots } = accrue(gid, to.id);
        if (!slots.length) return await reply({ content: `${to.username} 的魚缸是空的，沒東西可偷。` });

        bumpSteal(gid, uid);
        const tag = `（今日 ${usedToday + 1}/${c.steal_daily_limit}）`;
        // 防護：魚缸等級（設施商店本來就標了「被偷成功率 -25%」，但一直沒接上）
        // ＋ 守衛寵物（魚缸防護／全域防竊）。寵物住家裡，不佔魚缸格子。
        const petResist = buffPct(gid, to.id, 'aqua_resist_pct') + buffPct(gid, to.id, 'steal_resist_pct');
        const resist = facilityBonus(gid, to.id, 'aquarium').resist + petResist;
        const successPct = Math.max(0, c.steal_success_pct - resist);
        if (Math.random() * 100 >= successPct) {
          bumpAch(gid, to.id, 'defend_success', 1);   // 被偷者守住了（魚缸等級＋守衛寵物）
          // 偷失敗被抓 → 罰款（星幣可為負）。可設定賠給受害者或直接沒收。
          const fine = Math.max(0, c.steal_fail_penalty || 0);
          if (fine > 0) {
            addCoins(gid, uid, uname, -fine);
            let note = `\n\n💸 你被 ${to.username} 逮個正著，罰了 **${money(gc, fine)}**`;
            if (c.steal_penalty_to_victim) {
              addCoins(gid, to.id, to.username, fine);
              note += `，全額賠給了對方。`;
              const dm = new EmbedBuilder().setColor(0x2ecc71).setTitle('🛡️ 抓到偷魚賊！')
                .setDescription(`**${i.member?.displayName || uname}** 想偷你的魚缸但被逮到，賠了你 **${money(gc, fine)}**！`);
              to.send({ embeds: [dm] }).catch(() => {});
            } else {
              note += `（充公沒收）。`;
            }
            logSteal({ guildId: gid, kind: 'aquarium', thiefId: uid, thiefName: uname,
              victimId: to.id, victimName: to.username, result: 'caught', penalty: fine, channelId: i.channelId });
            return await reply({ content: `你把手伸進 ${to.username} 的魚缸，結果打翻了水，還被當場抓到！${resist ? `（對方防護 -${resist}%${petResist ? `，寵物擋了 ${petResist}%` : ''}）` : ''}${note}${tag}` });
          }
          logSteal({ guildId: gid, kind: 'aquarium', thiefId: uid, thiefName: uname,
            victimId: to.id, victimName: to.username, result: 'miss', channelId: i.channelId });
          return await reply({ content: `你把手伸進 ${to.username} 的魚缸，結果打翻了水，只好落跑！${resist ? `（對方防護 -${resist}%）` : ''}${tag}` });
        }

        bumpAch(gid, uid, 'steal_success', 1);
        // 先看能不能整條撈走（小偷要有「自己的空魚缸格」才放得下；沒魚缸就撈不走）
        let fishNote = '', stolenFish = null;
        const myMax = effSlots(gid, uid);
        const myFree = freeSlot(gid, uid, myMax);
        if (c.steal_fish_pct > 0 && Math.random() * 100 < c.steal_fish_pct) {
          if (myFree < 0) fishNote = `\n\n🐟 你本來可以整條撈走，但${myMax <= 0 ? '你沒有魚缸' : `你的魚缸滿了（${myMax} 格）`}，只好放牠回去（要有空的魚缸格才帶得走）。`;
          else {
            const victim = slots[Math.floor(Math.random() * slots.length)];
            const f = fishById(gid, victim.fish_id);
            db.transaction(() => {
              db.prepare('DELETE FROM aquarium_slots WHERE guild_id=? AND user_id=? AND slot=?').run(gid, to.id, victim.slot);
              // 撈來的魚沒有飼料存量，接手就要立刻餵，否則一樣會餓死
              db.prepare('INSERT INTO aquarium_slots (guild_id,user_id,slot,fish_id,pending,last_produce_ms,fed_until_ms) VALUES (?,?,?,?,0,?,?)')
                .run(gid, uid, myFree, f.id, Date.now(), Math.max(Date.now(), victim.fed_until_ms || 0));
            })();
            stolenFish = f;
            fishNote = `\n\n🐟💨 你連整條 ${f.emoji || ''}**${f.name}** 都撈走了，牠在你魚缸第 ${myFree + 1} 格（記得 \`/餵魚\`）！`;
          }
        }

        // 偷未領取的星幣（總額封頂：單次最多偷 steal_max，避免魚貴時一次被偷好幾百）
        let got = 0;
        const cap = c.steal_max > 0 ? c.steal_max : Infinity;
        const pool = slots.filter(s => s.pending > 0);
        db.transaction(() => {
          for (const s of pool) {
            if (got >= cap) break;
            const cur = db.prepare('SELECT pending FROM aquarium_slots WHERE guild_id=? AND user_id=? AND slot=?').get(gid, to.id, s.slot);
            if (!cur || cur.pending <= 0) continue;   // 剛剛整條被撈走的那格已經不在了
            let take = Math.min(cur.pending, Math.max(1, Math.floor(cur.pending * c.steal_take_pct / 100)));
            take = Math.min(take, cap - got);          // 不超過單次上限
            if (take <= 0) break;
            db.prepare('UPDATE aquarium_slots SET pending = pending - ? WHERE guild_id=? AND user_id=? AND slot=?').run(take, gid, to.id, s.slot);
            got += take;
          }
          if (got > 0) addCoins(gid, uid, uname, got);
        })();

        if (!got && !stolenFish) {
          logSteal({ guildId: gid, kind: 'aquarium', thiefId: uid, thiefName: uname,
            victimId: to.id, victimName: to.username, result: 'miss', channelId: i.channelId });
          return await reply({ content: `你摸進 ${to.username} 的魚缸，但星幣都被領走了、魚也沒撈到，撲空！${tag}` });
        }
        const embed = new EmbedBuilder().setColor(0xed4245).setTitle('🕵️ 偷魚成功！')
          .setDescription((got ? `你從 ${to.username} 的魚缸撈走了 **${money(gc, got)}**（已入你的錢包）。` : `${to.username} 的星幣都被領走了，但你不是空手而歸——`) + fishNote)
          .setFooter({ text: `今日 ${usedToday + 1}/${c.steal_daily_limit}` });

        const thief = i.member?.displayName || uname;
        logSteal({ guildId: gid, kind: 'aquarium', thiefId: uid, thiefName: uname,
          victimId: to.id, victimName: to.username, result: 'success',
          loot: stolenFish ? `整條 ${stolenFish.name}` : '', coins: got, channelId: i.channelId });
        const dm = new EmbedBuilder().setColor(0xed4245).setTitle('🚨 你的魚缸被偷了！')
          .setDescription(`**${thief}** ${got ? `從你的魚缸撈走了 ${money(gc, got)}` : '摸進了你的魚缸'}` +
            (stolenFish ? `\n😱 連整條 ${stolenFish.emoji || ''}**${stolenFish.name}** 都被撈走了！` : '') +
            `\n\n下次記得早點 \`/撈金\`，或去 \`/偷魚\` 討回來！`)
          .setFooter({ text: `發生在 ${i.guild.name}` });
        const dmOk = await to.send({ embeds: [dm] }).then(() => true).catch(() => false);

        // 跟牧場共用同一個公告頻道設定，兩套偷竊事件集中在同一個地方看
        const ch = await stealChannel(i, gid);
        if (ch) {
          const pub = new EmbedBuilder().setColor(0xed4245).setTitle('🕵️ 魚缸偷竊事件')
            .setDescription(`<@${to.id}> 的魚缸被**不知名人士**摸進去了` +
              (got ? `，撈走 ${money(gc, got)}` : '') +
              (stolenFish ? `\n🐟💨 連整條 ${stolenFish.emoji || ''}**${stolenFish.name}** 都不見了！` : ''))
            .setFooter({ text: '到底是誰做的？想討回來就去 /偷魚 反擊！' });
          ch.send(dmOk
            ? { embeds: [pub] }
            : { content: `<@${to.id}>`, embeds: [pub], allowedMentions: { users: [to.id] } }).catch(() => {});
        }
        return await reply({ embeds: [embed] });
      }
    } catch (e) {
      logError(gid, '魚缸指令失敗：', `${name}（${e.message}）`);
      const msg = { content: '執行失敗，管理員可到後台的系統錯誤紀錄查看原因。', flags: MessageFlags.Ephemeral };
      if (i.replied || i.deferred) await i.followUp(msg).catch(() => {});
      else await i.reply(msg).catch(() => {});
    }
  });

  console.log('  ↳ 魚缸模組已載入（SSR 魚／每日飼料／產星幣／偷魚）');
}

// 其餘函式一併匯出，方便日後其他模組（例如 /狀態）與測試腳本取用
module.exports = { init, seedAquarium, accrue, buyFish, sellFish, feedAll, collect };
