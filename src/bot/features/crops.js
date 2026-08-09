// 種植系統：農地種作物、溫室種花卉。買種子→種下→等成熟→採收（產物進背包可 /賣出）。
const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, MessageFlags } = require('discord.js');
const { db, guildConfig, logError } = require('../../db');
const { brandColor } = require('../../util/brand');
// 產物賣價會受財經新聞影響（新聞關閉時等於基準價）
const { livePrice, priceTag } = require('../../util/market');
const { wallet, addToBag, menuResult, safeMenu } = require('./gather');
const { facilitySlots, facilityBonus, applySpeed } = require('./facility');

const ccfg = (gid) => guildConfig('crop_config', gid);
const gcfg = (gid) => guildConfig('gather_config', gid);
const csv = (s) => String(s || '').split(/[\n,]/).map(x => x.trim()).filter(Boolean);
const money = (c, n) => `${c.currency_emoji || '🪙'} ${Number(n).toLocaleString('en-US')} ${c.currency_name || '星幣'}`;
const PLOT = { field: '農地', greenhouse: '溫室' };
// 玩家用製作解鎖的額外格數
const unlockedOf = (gid, uid) => db.prepare('SELECT field, greenhouse FROM crop_unlocks WHERE guild_id=? AND user_id=?').get(gid, uid) || { field: 0, greenhouse: 0 };
// 總格數＝設定的初始格 + 該玩家製作解鎖的格
// 總格數＝後台初始格 + /製作 開出來的格 + /設施商店 買到的等級格
const slotsOf = (c, type, u, gid, uid) => (type === 'greenhouse' ? c.greenhouse_slots : c.field_slots)
  + (u ? (type === 'greenhouse' ? u.greenhouse : u.field) : 0)
  + (gid && uid ? facilitySlots(gid, uid, type) : 0);

// 預設種子（價格已配合經濟調小）：[種子名, emoji, 類型, 種子價, 成熟分鐘, 產物名, 產物emoji, 產物價, 收成量, 說明]
const SEED_CROPS = [
  ['番茄種子', '🍅', 'field', 15, 120, '番茄', '🍅', 8, 3, '約 2 小時成熟，收成 3 顆'],
  ['紅蘿蔔種子', '🥕', 'field', 12, 90, '紅蘿蔔', '🥕', 6, 3, '約 1.5 小時'],
  ['小麥種子', '🌾', 'field', 10, 150, '小麥', '🌾', 5, 4, '約 2.5 小時，收成 4 束'],
  ['玉米種子', '🌽', 'field', 20, 180, '玉米', '🌽', 12, 2, '約 3 小時'],
  ['玫瑰種子', '🌹', 'greenhouse', 40, 240, '玫瑰', '🌹', 30, 2, '溫室花卉，約 4 小時'],
  ['鬱金香種子', '🌷', 'greenhouse', 35, 210, '鬱金香', '🌷', 26, 2, '約 3.5 小時'],
  ['向日葵種子', '🌻', 'greenhouse', 30, 300, '向日葵', '🌻', 24, 3, '約 5 小時，收成 3 朵'],
  ['馬鈴薯種子', '🥔', 'field', 12, 100, '馬鈴薯', '🥔', 7, 3, '好種又穩定'],
  ['辣椒種子', '🌶️', 'field', 18, 120, '辣椒', '🌶️', 9, 3, '兩小時就能收'],
  ['草莓種子', '🍓', 'field', 30, 180, '草莓', '🍓', 14, 3, '甜度高、售價好'],
  ['藍莓種子', '🫐', 'field', 28, 210, '藍莓', '🫐', 13, 3, '耐放的高價漿果'],
  ['南瓜種子', '🎃', 'field', 25, 240, '南瓜', '🎃', 16, 2, '長得慢但單價高'],
  ['西瓜種子', '🍉', 'field', 35, 300, '西瓜', '🍉', 22, 2, '五小時的大作物'],
  ['仙人掌種子', '🌵', 'greenhouse', 25, 150, '仙人掌', '🌵', 18, 2, '溫室裡最好照顧的'],
  ['薰衣草種子', '💐', 'greenhouse', 32, 200, '薰衣草', '💐', 22, 3, '一次收三束'],
  ['百合種子', '🪷', 'greenhouse', 38, 240, '百合', '🪷', 28, 2, '經典高價花'],
  ['繡球花種子', '🌺', 'greenhouse', 45, 300, '繡球花', '🌺', 34, 2, '五小時的中高階花'],
  ['蘭花種子', '🌸', 'greenhouse', 55, 360, '蘭花', '🌸', 42, 2, '六小時，單價很高'],
  ['櫻花種子', '🌷', 'greenhouse', 60, 420, '櫻花', '🌷', 48, 2, '七小時的高級花'],
  ['月光花種子', '🌙', 'greenhouse', 80, 480, '月光花', '🌙', 70, 2, '八小時，溫室的頂級花卉']
];

function seedCrops(gid) {
  ccfg(gid);
  try {
    const findItem = db.prepare("SELECT id FROM gather_items WHERE guild_id=? AND kind='farm' AND name=?");
    const insItem = db.prepare("INSERT INTO gather_items (guild_id,kind,name,emoji,rarity,weight,price,description,enabled) VALUES (?,?,?,?,?,?,?,?,1)");
    const findSeed = db.prepare('SELECT id FROM crop_seeds WHERE guild_id=? AND name=?');
    const insSeed = db.prepare('INSERT INTO crop_seeds (guild_id,name,emoji,plot_type,seed_price,grow_minutes,product_item_id,yield_count,sort,description) VALUES (?,?,?,?,?,?,?,?,?,?)');
    const tx = db.transaction(() => {
      SEED_CROPS.forEach((s, idx) => {
        const [name, emoji, type, price, mins, pName, pEmoji, pPrice, yield_, desc] = s;
        if (findSeed.get(gid, name)) return;
        let item = findItem.get(gid, pName);
        if (!item) { const r = insItem.run(gid, 'farm', pName, pEmoji, 'N', 0, pPrice, `種植產物：${pName}`); item = { id: r.lastInsertRowid }; }
        insSeed.run(gid, name, emoji, type, price, mins, item.id, yield_, idx, desc);
      });
      db.prepare('UPDATE crop_config SET seeded=1 WHERE guild_id=?').run(gid);
    });
    tx();
  } catch (e) { logError(gid, '種植預設建立失敗：', e.message); }
}

const seedByName = (gid, name) => db.prepare('SELECT * FROM crop_seeds WHERE guild_id=? AND enabled=1 AND name=?').get(gid, name);
const seedById = (gid, id) => db.prepare('SELECT * FROM crop_seeds WHERE guild_id=? AND id=?').get(gid, id);
const productOf = (id) => db.prepare('SELECT * FROM gather_items WHERE id=?').get(id);

// 一口氣種多格：買 qty 包種子種進 qty 個空格。
// 實際種下的數量會被「空格數」和「買得起幾包」夾住，不會因為選太多就整批失敗。
function plantSeeds(gid, uid, uname, seedId, qty) {
  const c = ccfg(gid), gc = gcfg(gid);
  const seed = db.prepare('SELECT * FROM crop_seeds WHERE guild_id=? AND enabled=1 AND id=?').get(gid, seedId);
  if (!seed) return { error: '這個種子已經不在商店裡了。' };
  const max = slotsOf(c, seed.plot_type, unlockedOf(gid, uid), gid, uid);
  if (max <= 0) return { error: `你還沒有${PLOT[seed.plot_type]}！可以用 \`/設施商店\` 買一塊，或用 \`/製作\` 開一格。` };
  const used = db.prepare('SELECT slot FROM crop_plots WHERE guild_id=? AND user_id=? AND plot_type=?').all(gid, uid, seed.plot_type).map(r => r.slot);
  const free = [];
  for (let s = 0; s < max; s++) if (!used.includes(s)) free.push(s);
  if (!free.length) return { error: `你的${PLOT[seed.plot_type]}已經滿了（${max} 格）。等成熟 \`/採收\` 後再種，或去 \`/設施商店\` 升級擴充。` };
  const w = wallet(gid, uid, uname);
  const price = Math.max(1, seed.seed_price);
  const afford = Math.floor(w.coins / price);
  if (afford < 1) return { error: `${gc.currency_name}不夠：一包 ${seed.seed_price}，你只有 ${w.coins.toLocaleString('en-US')}。` };
  const n = Math.min(Math.max(1, qty), free.length, afford);
  const cost = n * seed.seed_price;
  const readyAt = Date.now() + applySpeed(Math.max(1, seed.grow_minutes) * 60000, facilityBonus(gid, uid, seed.plot_type).speed);
  const slots = free.slice(0, n);
  const tx = db.transaction(() => {
    db.prepare('UPDATE econ_wallets SET coins = coins - ? WHERE guild_id=? AND user_id=?').run(cost, gid, uid);
    const ins = db.prepare('INSERT INTO crop_plots (guild_id,user_id,plot_type,slot,seed_id,ready_at) VALUES (?,?,?,?,?,?)');
    for (const s of slots) ins.run(gid, uid, seed.plot_type, s, seed.id, readyAt);
  });
  tx();
  const p = productOf(seed.product_item_id);
  const usedNow = used.length + n;
  const left = Math.max(0, max - usedNow);
  // 選太多時說明為什麼只種了這些，免得玩家以為系統吃掉指令
  const capped = n < qty
    ? `\n\n（你選了 ${qty} 格，但${free.length < qty ? `只剩 ${free.length} 個空格` : `${gc.currency_name}只夠買 ${afford} 包`}，所以種了 ${n} 格）`
    : '';
  return { embed: new EmbedBuilder().setColor(brandColor()).setTitle('🌱 種植成功')
    .setDescription(`在${PLOT[seed.plot_type]}種下 ${seed.emoji || ''}**${seed.name}** ×**${n}**（第 ${slots.map(s => s + 1).join('、')} 格）\n` +
      `花費：${money(gc, cost)}\n成熟時間：<t:${Math.floor(readyAt / 1000)}:R>（<t:${Math.floor(readyAt / 1000)}:t>）\n` +
      `成熟後用 \`/採收\` 可收成 ${seed.yield_count * n}× ${p ? (p.emoji || '') + p.name : '產物'}。\n\n` +
      `${PLOT[seed.plot_type]}：**${usedNow}/${max} 格**已使用${left ? `（還可種 ${left} 格）` : '（已滿）'}${capped}`)
    .setFooter({ text: `餘額 ${(w.coins - cost).toLocaleString('en-US')} ${gc.currency_name}` }) };
}

function init(client) {
  for (const [gid] of client.guilds.cache) {
    try { seedCrops(gid); } catch (e) { logError(gid, '種植初始化失敗：', e.message); }
  }
  const CMDS = ['種子商店', '種植', '農地', '溫室', '採收'];
  const CROP_BTN = { 'adv:farm': '農地', 'adv:greenhouse': '溫室', 'adv:reap': '採收', 'adv:cropshop': '種子商店' };

  client.on('interactionCreate', async (i) => {
    // 種子商店的購買選單
    if (i.isStringSelectMenu() && i.customId === 'seedbuy') {
      try {
        const gid = i.guildId, uid = i.user.id, uname = i.user.username;
        const sid = parseInt(i.values[0], 10);
        const seed = seedById(gid, sid);
        if (!seed) return i.update({ content: '這個種子已經不在商店裡了。', components: [], embeds: [] }).catch(() => {});
        const c = ccfg(gid), gc = gcfg(gid);
        const max = slotsOf(c, seed.plot_type, unlockedOf(gid, uid), gid, uid);
        const usedN = db.prepare('SELECT COUNT(*) n FROM crop_plots WHERE guild_id=? AND user_id=? AND plot_type=?').get(gid, uid, seed.plot_type).n;
        const freeN = Math.max(0, max - usedN);
        const w = wallet(gid, uid, uname);
        const afford = Math.floor(w.coins / Math.max(1, seed.seed_price));
        const canDo = Math.min(freeN, afford);
        if (max <= 0) return i.update({ content: `你還沒有${PLOT[seed.plot_type]}！可以用 \`/設施商店\` 買一塊，或用 \`/製作\` 開一格。`, components: [], embeds: [] }).catch(() => {});
        if (freeN <= 0) return i.update({ content: `你的${PLOT[seed.plot_type]}已經滿了（${max} 格）。等成熟 \`/採收\` 後再種。`, components: [], embeds: [] }).catch(() => {});
        if (afford <= 0) return i.update({ content: `${gc.currency_name}不夠：一包 ${seed.seed_price}，你只有 ${w.coins.toLocaleString('en-US')}。`, components: [], embeds: [] }).catch(() => {});
        // 只列「格子夠、錢也夠」的數量，選了就一定種得成
        const amts = [...new Set([1, 2, 3, 5, 10].filter(x => x < canDo).concat([canDo]))].sort((a, b) => a - b);
        const menu = new StringSelectMenuBuilder().setCustomId('seedqty:' + sid).setPlaceholder('要種幾格？')
          .addOptions(amts.slice(0, 25).map(a => ({
            label: a === canDo && canDo > 1 ? `全部空格（${a} 格）` : `種 ${a} 格`,
            description: `花 ${(a * seed.seed_price).toLocaleString('en-US')} ${gc.currency_name}，收成 ${a * seed.yield_count} 個`.slice(0, 100),
            value: String(a)
          })));
        return i.update({
          content: `${seed.emoji || '🌱'}**${seed.name}**：要種幾格？（${PLOT[seed.plot_type]}空 ${freeN} 格，餘額買得起 ${afford} 包）`,
          embeds: [], components: [new ActionRowBuilder().addComponents(menu)]
        }).catch(() => {});
      } catch (e) {
        logError(i.guildId, '種子數量選單失敗：', e.message);
        return i.reply({ content: '執行失敗，管理員可到後台的系統錯誤紀錄查看原因。', flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
    // 選好數量 → 一次種下
    if (i.isStringSelectMenu() && i.customId.startsWith('seedqty:')) {
      const sid = parseInt(i.customId.split(':')[1], 10);
      const qty = parseInt(i.values[0], 10);
      return safeMenu(i, '種下種子', () => plantSeeds(i.guildId, i.user.id, i.user.username, sid, qty));
    }
    const isBtn = i.isButton();
    const cmdName = isBtn ? CROP_BTN[i.customId] : (i.isChatInputCommand() ? i.commandName : null);
    if (!cmdName || !CMDS.includes(cmdName)) return;
    const gid = i.guildId;
    if (!gid) return i.reply({ content: '這個指令只能在伺服器裡使用。', flags: MessageFlags.Ephemeral });
    seedCrops(gid);
    const c = ccfg(gid), gc = gcfg(gid);
    if (!c.enabled) return i.reply({ content: '種植系統目前停用中。', flags: MessageFlags.Ephemeral });
    const allowed = csv(gc.channels);
    if (allowed.length && !allowed.includes(i.channelId)) {
      return i.reply({ content: `這個指令只能在 ${allowed.map(id => `<#${id}>`).join('、')} 使用。`, flags: MessageFlags.Ephemeral });
    }
    const uid = i.user.id, uname = i.user.username, name = cmdName;
    const reply = (payload) => i.reply({ ...payload, flags: MessageFlags.Ephemeral });

    try {
      // ---- 種子商店 ----
      if (name === '種子商店') {
        const seeds = db.prepare('SELECT * FROM crop_seeds WHERE guild_id=? AND enabled=1 ORDER BY plot_type, sort, id').all(gid);
        if (!seeds.length) return await reply({ content: '種子商店目前還沒有任何種子。' });
        const w = wallet(gid, uid, uname);
        const u0 = unlockedOf(gid, uid);
        const COLOR = { field: 0xf1c40f, greenhouse: 0x1abc9c };
        const embeds = [new EmbedBuilder().setColor(brandColor()).setTitle('🌱 種子商店')
          .setDescription(`點下方選單選種子 → 再選要種幾格，一次種完不用一格一格點。\n（也可以打 \`/種植 種子名稱 數量\`）\n你的餘額：**${w.coins.toLocaleString('en-US')} ${gc.currency_name}**`)];
        for (const type of ['field', 'greenhouse']) {
          const list = seeds.filter(sd => sd.plot_type === type);
          if (!list.length) continue;
          const speed = facilityBonus(gid, uid, type).speed;
          const txt = list.map(sd => {
            const p = productOf(sd.product_item_id);
            const mins = Math.round(applySpeed(sd.grow_minutes * 60000, speed) / 60000);
            return `${sd.emoji || '🌱'} **${sd.name}**　${money(gc, sd.seed_price)}　→ ${sd.yield_count}× ${p ? (p.emoji || '') + p.name : '產物'}（每個賣 ${p ? livePrice(gid, p) : '?'}${p ? priceTag(gid, p) : ''}）\n　　🕑 ${mins} 分成熟${speed ? `（設施加速 -${speed}%）` : ''}${sd.description ? `　${sd.description}` : ''}`;
          }).join('\n');
          embeds.push(new EmbedBuilder().setColor(COLOR[type])
            .setTitle(`${type === 'greenhouse' ? '🏡 溫室花卉' : '🌾 農地作物'}（你有 ${slotsOf(c, type, u0, gid, uid)} 格）`)
            .setDescription(txt.slice(0, 4000)));
        }
        const opts = seeds.map(sd => ({
          label: `${sd.plot_type === 'greenhouse' ? '溫室' : '農地'}：${sd.name}`.slice(0, 100),
          description: `${sd.seed_price.toLocaleString('en-US')} ${gc.currency_name}｜${sd.grow_minutes} 分成熟｜收成 ${sd.yield_count}`.slice(0, 100),
          value: String(sd.id), emoji: sd.emoji || '🌱'
        }));
        const rows = [new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder().setCustomId('seedbuy').setPlaceholder('選擇種子（下一步選數量）').addOptions(opts.slice(0, 25)))];
        return await reply({ embeds: embeds.slice(0, 10), components: rows });
      }

      // ---- 種植 ----
      if (name === '種植') {
        const what = (i.options.getString('種子') || '').trim();
        const seed = seedByName(gid, what);
        if (!seed) return await reply({ content: `找不到種子「${what}」，用 \`/種子商店\` 看看有哪些。` });
        const qty = i.options.getInteger('數量') || 1;
        const r = plantSeeds(gid, uid, uname, seed.id, qty);
        if (r.error) return await reply({ content: r.error });
        return await reply({ embeds: [r.embed] });
      }

      // ---- 農地 / 溫室一覽（分開檢視）----
      if (name === '農地' || name === '溫室') {
        const type = name === '溫室' ? 'greenhouse' : 'field';
        const target = (!isBtn && i.options.getUser('玩家')) || i.user;
        const now = Date.now();
        const uT = unlockedOf(gid, target.id);
        const max = slotsOf(c, type, uT, gid, target.id);
        const title = type === 'greenhouse' ? `🏡 ${target.username} 的溫室` : `🌾 ${target.username} 的農地`;
        const embed = new EmbedBuilder().setColor(brandColor()).setTitle(title);
        if (max <= 0) {
          embed.setDescription(`你還沒有${PLOT[type]}！用 \`/製作 ${type === 'greenhouse' ? '搭建溫室' : '開闢農地'}\` 開一格才能種。`);
          return await reply({ embeds: [embed] });
        }
        const plots = db.prepare('SELECT * FROM crop_plots WHERE guild_id=? AND user_id=? AND plot_type=?').all(gid, target.id, type);
        const lines = [];
        for (let s = 0; s < max; s++) {
          const row = plots.find(x => x.slot === s);
          if (!row) { lines.push(`\`${s + 1}\`｜— 空地 —`); continue; }
          const seed = seedById(gid, row.seed_id);
          const nm = seed ? (seed.emoji || '🌱') + seed.name.replace('種子', '') : '作物';
          lines.push(row.ready_at > now
            ? `\`${s + 1}\`｜${nm}　<t:${Math.floor(row.ready_at / 1000)}:R>`
            : `\`${s + 1}\`｜✅ ${nm} 可採收`);
        }
        embed.setDescription(lines.join('\n')).setFooter({ text: `${max} 格｜/種植 種子　/採收 收成　/種子商店 買種子` });
        return await reply({ embeds: [embed] });
      }

      // ---- 採收 ----
      if (name === '採收') {
        const now = Date.now();
        const ripe = db.prepare('SELECT * FROM crop_plots WHERE guild_id=? AND user_id=? AND ready_at<=?').all(gid, uid, now);
        if (!ripe.length) return await reply({ content: '目前沒有成熟的作物，再等等吧～用 `/農地` 看剩餘時間。' });
        const gained = new Map();
        const tx = db.transaction(() => {
          for (const r of ripe) {
            const seed = seedById(gid, r.seed_id);
            if (!seed) { db.prepare('DELETE FROM crop_plots WHERE guild_id=? AND user_id=? AND plot_type=? AND slot=?').run(gid, uid, r.plot_type, r.slot); continue; }
            addToBag(gid, uid, seed.product_item_id, seed.yield_count);
            gained.set(seed.product_item_id, (gained.get(seed.product_item_id) || 0) + seed.yield_count);
            db.prepare('DELETE FROM crop_plots WHERE guild_id=? AND user_id=? AND plot_type=? AND slot=?').run(gid, uid, r.plot_type, r.slot);
          }
        });
        tx();
        let value = 0;
        const lines = [...gained.entries()].map(([itemId, n]) => {
          const p = productOf(itemId); if (p) value += n * livePrice(gid, p);
          return `${p ? (p.emoji || '') + p.name : '產物'} ×${n}`;
        });
        const embed = new EmbedBuilder().setColor(brandColor()).setTitle('🧺 採收成功')
          .setDescription(lines.join('\n') + `\n\n已放進背包，用 \`/賣出\` 換 ${gc.currency_name}。`)
          .setFooter({ text: `全部賣出約 ${value.toLocaleString('en-US')} ${gc.currency_name}` });
        return await reply({ embeds: [embed] });
      }
    } catch (e) {
      logError(gid, '種植指令失敗：', `${name}（${e.message}）`);
      const msg = { content: '執行失敗，管理員可到後台的系統錯誤紀錄查看原因。', flags: MessageFlags.Ephemeral };
      if (i.replied || i.deferred) await i.followUp(msg).catch(() => {});
      else await i.reply(msg).catch(() => {});
    }
  });

  console.log('  ↳ 種植模組已載入（農地種作物／溫室種花卉／採收）');
}

module.exports = { init, seedCrops };
