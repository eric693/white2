// 素材兌換所：每天開出幾個「素材換素材」的兌換選項。
//
// 為什麼要有這個：採集玩久了，水牛奶、木材、農作物會囤到四位數，賣回系統的價格
// 又低到沒有意義 —— 素材等於死在背包裡。這裡給它們一個出口：用大量低價素材換
// 少量高階素材。花的是素材不是星幣（交出去的直接由系統回收、不進任何人口袋），
// 所以不會多印錢，只會減少囤積。
//
// 清單每天換一批（照 weight 抽），每天都有理由回來看一眼 —— 這是刻意的：
// 固定清單一週後就沒人看了，輪替的清單會讓人養成每天點開的習慣。
const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, MessageFlags } = require('discord.js');
const cron = require('node-cron');
const { db, guildConfig, activeGuildIds, logError } = require('../../db');
const { brandColor } = require('../../util/brand');
const { localToday } = require('../../util/time');
const { runJob } = require('../../util/jobs');
const { addToBag } = require('./gather');
const { allowed } = require('../paywall');

const ecfg = (gid) => guildConfig('exchange_config', gid);
const itemById = (id) => db.prepare('SELECT id, name, emoji FROM gather_items WHERE id=?').get(id);
const label = (it, n) => `${it ? (it.emoji || '') + it.name : '（已刪除的素材）'} ×${n}`;

// 兌換項目補上兩邊素材的名稱／圖示（找不到素材的項目一律當作不存在 —— 素材被刪掉
// 還留在清單上的話，玩家會選到一個永遠換不成的東西）
function decorate(row) {
  if (!row) return null;
  const cost = itemById(row.cost_item_id), give = itemById(row.give_item_id);
  if (!cost || !give) return null;
  return { ...row, cost, give, title: row.name || `${label(cost, row.cost_count)} → ${label(give, row.give_count)}` };
}

// ---- 預設兌換項目 ----
// 池子是空的時候兌換所等於沒東西，管理員要一項一項手建才看得到效果 —— 很多人
// 因此以為功能壞了。這裡用「這台伺服器自己的物品」灌一批預設：拿最便宜的幾種
// 素材去換貴一級的東西，交出的總價值至少是換到的 SEED_MIN_RATIO 倍。
// 只在池子完全空的時候灌一次，管理員刪光了也不會被硬塞回來。
//
// ⚠️ 配對有兩條硬規則，違反就整組跳過，不會為了「湊滿 8 組」而放水：
//   ① 數量必須落在 10～500 之間（少於 10 換起來沒感覺，多於 500 玩家湊不出來）
//   ② 湊成整數之後的**實際倍率**仍要 ≥ SEED_MIN_RATIO
// 少了②的話，數量被上限卡住時倍率會被悄悄壓下去 —— 例如「稻草 ×10 → 金塊 ×1」，
// 那不是回收管道，那是印鈔機。
const SEED_RATIO = 3;            // 想要的倍率（交出的總價值 ÷ 換到的總價值）
const SEED_MIN_RATIO = 2;        // 湊整數之後的底線，低於這個就不生這一組
const SEED_MIN_COUNT = 10, SEED_MAX_COUNT = 500;
const NICE = [10, 20, 25, 30, 40, 50, 60, 75, 100, 120, 150, 200, 250, 300, 400, 500];
const niceUp = (n) => NICE.find(x => x >= n) || 0;   // 湊成好記的整數；超過 500 回 0＝配不出來

function seedOffers(gid) {
  if (db.prepare('SELECT 1 FROM exchange_offers WHERE guild_id=? LIMIT 1').get(gid)) return;
  // 禮物與種子不列入：那是別的系統的產能，拿來當兌換材料會繞過它們自己的上限
  const all = db.prepare(
    `SELECT id, name, emoji, price, kind FROM gather_items
      WHERE guild_id=? AND enabled=1 AND price > 0 AND kind NOT IN ('gift','seed')
      ORDER BY price, id`).all(gid);
  // 同名物品只留一個：後台自己新增時很容易撞名，清單上出現兩行一樣的字會讓玩家以為壞了
  const items = [];
  const seenName = new Set();
  for (const it of all) { if (!seenName.has(it.name)) { seenName.add(it.name); items.push(it); } }
  if (items.length < 4) return;             // 東西太少，配不出有意義的兌換

  const half = Math.max(1, Math.floor(items.length / 2));
  const cheap = items.slice(0, half), rich = items.slice(half);
  const rows = [], usedGive = new Set();

  for (const c of cheap) {
    if (rows.length >= 8) break;
    // 換到的東西要明顯比材料貴（至少 10 倍），否則玩家看不出換它的理由
    const fits = [];
    for (const g of rich) {
      if (g.id === c.id || g.price < c.price * 10) continue;
      const count = niceUp(Math.ceil(g.price * SEED_RATIO / c.price));
      if (!count || count < SEED_MIN_COUNT || count > SEED_MAX_COUNT) continue;
      if (c.price * count < g.price * SEED_MIN_RATIO) continue;   // 湊整之後仍要夠貴
      fits.push({ give: g, count });
    }
    if (!fits.length) continue;
    // 獎品盡量不重複：清單上八組全都換同一個東西，等於只有一組
    const fresh = fits.filter(f => !usedGive.has(f.give.id));
    const pool = fresh.length ? fresh : fits;
    const pickOne = pool[Math.floor(pool.length / 2)];            // 取中間價位，不要一路挑最貴的
    usedGive.add(pickOne.give.id);
    rows.push({ cost: c, give: pickOne.give, count: pickOne.count });
  }
  if (!rows.length) return;
  const ins = db.prepare(
    `INSERT INTO exchange_offers (guild_id,emoji,cost_item_id,cost_count,give_item_id,give_count,weight,daily_limit,description,sort,enabled)
     VALUES (?,'♻️',?,?,?,1,100,3,?,?,1)`);
  db.transaction(() => {
    rows.forEach((r, n) => ins.run(gid, r.cost.id, r.count, r.give.id,
      `囤太多的${r.cost.name}換一個${r.give.name}`, n));
  })();
}

// ---- 今天的清單 ----
// 用「抽出來就寫進 exchange_daily」而不是每次即時抽：同一天不管誰打開、打開幾次，
// 看到的都要是同一組，否則玩家會一直重開指令直到抽到自己想要的。
function pickToday(gid, day) {
  const c = ecfg(gid);
  const slots = Math.max(1, Math.min(25, c.daily_slots || 3));
  const pool = db.prepare('SELECT * FROM exchange_offers WHERE guild_id=? AND enabled=1').all(gid)
    .filter(r => decorate(r));
  const picked = [];
  const bag = [...pool];
  while (picked.length < slots && bag.length) {
    const total = bag.reduce((s, r) => s + Math.max(1, r.weight || 1), 0);
    let roll = Math.random() * total;
    let idx = bag.length - 1;
    for (let n = 0; n < bag.length; n++) {
      roll -= Math.max(1, bag[n].weight || 1);
      if (roll <= 0) { idx = n; break; }
    }
    picked.push(bag.splice(idx, 1)[0]);
  }
  return picked;
}

// 取得（必要時產生）今天的清單。lazy 產生而不是只靠排程：機器人半夜重啟、
// 伺服器是今天才加進來的、管理員剛剛才開啟功能 —— 這些情況排程都補不到。
function todayOffers(gid) {
  const day = localToday();
  let rows = db.prepare(
    `SELECT o.*, d.slot FROM exchange_daily d JOIN exchange_offers o ON o.id = d.offer_id
      WHERE d.guild_id=? AND d.day=? ORDER BY d.slot`).all(gid, day);
  if (!rows.length) {
    const tx = db.transaction(() => {
      // 併發時可能有人先寫進去了，寫入前再確認一次
      if (db.prepare('SELECT 1 FROM exchange_daily WHERE guild_id=? AND day=? LIMIT 1').get(gid, day)) return;
      const ins = db.prepare('INSERT OR IGNORE INTO exchange_daily (guild_id,day,offer_id,slot) VALUES (?,?,?,?)');
      pickToday(gid, day).forEach((o, n) => ins.run(gid, day, o.id, n));
      // 只留最近 7 天，不讓這張表無限長大
      db.prepare("DELETE FROM exchange_daily WHERE guild_id=? AND day < date(?, '-7 day')").run(gid, day);
      db.prepare("DELETE FROM exchange_uses WHERE guild_id=? AND day < date(?, '-7 day')").run(gid, day);
    });
    tx();
    rows = db.prepare(
      `SELECT o.*, d.slot FROM exchange_daily d JOIN exchange_offers o ON o.id = d.offer_id
        WHERE d.guild_id=? AND d.day=? ORDER BY d.slot`).all(gid, day);
  }
  // 清單抽出來之後才被停用／素材被刪掉的，今天就不顯示（不重抽，明天自然換一批）
  return rows.map(decorate).filter(o => o && o.enabled);
}

const bagCountOf = (gid, uid, itemId) =>
  (db.prepare('SELECT count FROM gather_inventory WHERE guild_id=? AND user_id=? AND item_id=?').get(gid, uid, itemId) || {}).count || 0;
const usedOf = (gid, uid, day, offerId) =>
  (db.prepare('SELECT count FROM exchange_uses WHERE guild_id=? AND user_id=? AND day=? AND offer_id=?').get(gid, uid, day, offerId) || {}).count || 0;
const usedTotal = (gid, uid, day) =>
  (db.prepare('SELECT SUM(count) n FROM exchange_uses WHERE guild_id=? AND user_id=? AND day=?').get(gid, uid, day) || {}).n || 0;

// 這位玩家現在還能換這一項幾次（材料、單項上限、每日總上限三者取小）
function capOf(gid, uid, offer, day = localToday()) {
  const c = ecfg(gid);
  const byBag = Math.floor(bagCountOf(gid, uid, offer.cost_item_id) / Math.max(1, offer.cost_count));
  const byOffer = offer.daily_limit > 0 ? Math.max(0, offer.daily_limit - usedOf(gid, uid, day, offer.id)) : Infinity;
  const byDay = c.daily_per_user > 0 ? Math.max(0, c.daily_per_user - usedTotal(gid, uid, day)) : Infinity;
  return { cap: Math.max(0, Math.min(byBag, byOffer, byDay)), byBag, byOffer, byDay };
}

// ---- 兌換 ----
// 扣素材、發素材、記次數、寫紀錄全部在同一個交易裡（db.transaction 已經是
// BEGIN IMMEDIATE）—— 玩家連點兩下、或排程剛好在中間醒來時，不能出現
// 「素材扣了東西沒拿到」或「上限被繞過去」。
function doExchange(gid, uid, uname, offerId, times = 1) {
  const c = ecfg(gid);
  if (!c.enabled) return { error: '素材兌換所目前沒有營業。' };
  const day = localToday();
  const today = todayOffers(gid);
  const offer = today.find(o => o.id === offerId);
  if (!offer) return { error: '這個兌換項目不在今天的清單裡了（清單每天午夜換一批）。' };
  times = Math.max(1, Math.min(99, Math.floor(times) || 1));

  let out = null;
  const tx = db.transaction(() => {
    // 上限與庫存都在鎖裡重算一次：外面算好的數字到這裡可能已經過期
    const { cap, byBag, byOffer, byDay } = capOf(gid, uid, offer, day);
    if (cap < times) {
      if (byBag < times) {
        out = { error: `素材不夠：${label(offer.cost, offer.cost_count * times)} 才換得到，你只有 ${bagCountOf(gid, uid, offer.cost_item_id)} 個。` };
      } else if (byOffer < times) {
        out = { error: `這一項你今天只剩 ${byOffer} 次可以換（每日上限 ${offer.daily_limit} 次）。` };
      } else {
        out = { error: `你今天的兌換次數只剩 ${byDay} 次（每日上限 ${c.daily_per_user} 次），明天午夜重置。` };
      }
      return;
    }
    const costTotal = offer.cost_count * times, giveTotal = offer.give_count * times;
    // 扣素材帶 count>=? 條件：真的被別的動作先扣走時，這裡會扣不到而不是扣成負數
    const info = db.prepare('UPDATE gather_inventory SET count = count - ? WHERE guild_id=? AND user_id=? AND item_id=? AND count >= ?')
      .run(costTotal, gid, uid, offer.cost_item_id, costTotal);
    if (!info.changes) { out = { error: '素材不夠（剛剛被其他動作用掉了），請重新確認背包數量。' }; return; }
    addToBag(gid, uid, offer.give_item_id, giveTotal);
    db.prepare(`INSERT INTO exchange_uses (guild_id,user_id,day,offer_id,count) VALUES (?,?,?,?,?)
                ON CONFLICT(guild_id,user_id,day,offer_id) DO UPDATE SET count = count + ?`)
      .run(gid, uid, day, offer.id, times, times);
    db.prepare(`INSERT INTO exchange_logs (guild_id,user_id,username,offer_id,offer_name,cost_name,cost_count,give_name,give_count,times)
                VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(gid, uid, uname || '', offer.id, offer.title, offer.cost.name, costTotal, offer.give.name, giveTotal, times);
    // 紀錄只留最近 1000 筆（後台是用來調比例的，不需要永久保存）
    db.prepare(`DELETE FROM exchange_logs WHERE guild_id=? AND id <= (
                  SELECT id FROM exchange_logs WHERE guild_id=? ORDER BY id DESC LIMIT 1 OFFSET 1000)`).run(gid, gid);
    out = { ok: true, costTotal, giveTotal };
  });
  tx();
  if (out.error) return out;

  const left = capOf(gid, uid, offer, day);
  return { embed: new EmbedBuilder().setColor(brandColor()).setTitle('♻️ 兌換完成')
    .setDescription(`交出 ${label(offer.cost, out.costTotal)}\n換到 ${label(offer.give, out.giveTotal)}`)
    .setFooter({ text: `背包剩 ${offer.cost.name} ${bagCountOf(gid, uid, offer.cost_item_id)} 個`
      + (left.cap > 0 ? `｜這一項今天還能換 ${left.cap === Infinity ? '不限' : left.cap} 次` : '｜這一項今天換完了') }) };
}

// ---- 清單面板（私人訊息，不會有「舊面板失效」的問題）----
function listView(gid, uid) {
  const c = ecfg(gid);
  if (!c.enabled) return { error: '素材兌換所目前沒有營業。' };
  const day = localToday();
  const offers = todayOffers(gid);
  const embed = new EmbedBuilder().setColor(brandColor()).setTitle('♻️ 素材兌換所')
    .setFooter({ text: `清單每天午夜（台灣時間）換一批`
      + (c.daily_per_user > 0 ? `｜你今天還能換 ${Math.max(0, c.daily_per_user - usedTotal(gid, uid, day))}／${c.daily_per_user} 次` : '') });
  if (!offers.length) {
    embed.setDescription('今天沒有開出任何兌換項目 —— 管理員還沒設定，或設定的素材已經被刪掉了。');
    return { embed, components: [] };
  }
  embed.setDescription('用囤著沒用的素材換你缺的那個。**交出去的素材由系統回收**，不會進其他玩家手上。\n\n'
    + offers.map(o => {
      const { cap } = capOf(gid, uid, o, day);
      const have = bagCountOf(gid, uid, o.cost_item_id);
      return `${o.emoji || '🔁'} **${o.title}**\n`
        + `　你有 ${o.cost.emoji || ''}${o.cost.name} ${have} 個`
        + (cap > 0 ? `　👉 可換 **${cap}** 次` : '　👉 換不了')
        + (o.daily_limit > 0 ? `　（每日上限 ${o.daily_limit} 次，已換 ${usedOf(gid, uid, day, o.id)}）` : '')
        + (o.description ? `\n　${o.description}` : '');
    }).join('\n\n'));
  const menu = new StringSelectMenuBuilder().setCustomId('exch:pick').setPlaceholder('選一個要兌換的項目')
    .addOptions(offers.slice(0, 25).map(o => ({
      label: o.title.slice(0, 100), value: String(o.id), emoji: o.emoji || undefined,
      description: `可換 ${capOf(gid, uid, o, day).cap} 次`.slice(0, 100)
    })));
  return { embed, components: [new ActionRowBuilder().addComponents(menu)] };
}

// 次數選單：最多列 25 個選項，換得起幾次就列幾次
function qtyView(gid, uid, offer) {
  const { cap } = capOf(gid, uid, offer);
  if (cap <= 0) return { error: `${offer.title}：你現在換不了（素材不夠或今天的次數用完了）。` };
  const opts = [];
  for (let n = 1; n <= Math.min(cap, 24); n++) opts.push(n);
  if (cap > 24 && !opts.includes(cap)) opts.push(cap);
  return {
    content: `**${offer.title}**\n要換幾次？（1 次＝交出 ${label(offer.cost, offer.cost_count)}，拿到 ${label(offer.give, offer.give_count)}）`,
    components: [new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(`exqty:${offer.id}`).setPlaceholder('選次數')
        .addOptions(opts.map(n => ({
          label: `${n} 次`, value: String(n),
          description: `交出 ${offer.cost.name} ×${offer.cost_count * n} → ${offer.give.name} ×${offer.give_count * n}`.slice(0, 100)
        }))))]
  };
}

// ---- 每日換清單 ＋ 公告 ----
function rollDaily(client, gid) {
  const c = ecfg(gid);
  if (!c.enabled || !allowed(gid, 'gather')) return;
  const offers = todayOffers(gid);        // 還沒抽就在這裡抽出來
  if (!c.announce_channel || !offers.length) return;
  const ch = client.channels.cache.get(c.announce_channel);
  if (!ch || !ch.send) return;
  return ch.send({ embeds: [new EmbedBuilder().setColor(brandColor()).setTitle('♻️ 今天的素材兌換所')
    .setDescription(offers.map(o => `${o.emoji || '🔁'} **${o.title}**`).join('\n'))
    .setFooter({ text: '用 /兌換所 兌換｜清單每天午夜換一批' })] }).catch(() => {});
}

function init(client) {
  for (const [gid] of client.guilds.cache) {
    try { seedOffers(gid); } catch (e) { logError(gid, '素材兌換所預設項目建立失敗：', e.message); }
  }
  // 00:02 換清單（00:00 有一批其他排程，錯開避免一起搶 DB）
  cron.schedule('2 0 * * *', async () => {
    for (const gid of activeGuildIds()) {
      try { await runJob('素材兌換所每日換清單', () => rollDaily(client, gid)); }
      catch (e) { logError(gid, '素材兌換所每日換清單失敗：', e.message); }
    }
  }, { timezone: 'Asia/Taipei' });

  client.on('interactionCreate', async (i) => {
    try {
      const gid = i.guildId;
      if (!gid) return;

      // 冒險面板的「素材兌換所」按鈕
      if (i.isButton() && i.customId === 'adv:exchange') {
        const out = listView(gid, i.user.id);
        return i.reply(out.error ? { content: out.error, flags: MessageFlags.Ephemeral }
          : { embeds: [out.embed], components: out.components, flags: MessageFlags.Ephemeral }).catch(() => {});
      }

      // 選項目 → 只能換 1 次就直接換掉，不必再多點一次選單
      if (i.isStringSelectMenu() && i.customId === 'exch:pick') {
        const offer = todayOffers(gid).find(o => o.id === parseInt(i.values[0], 10));
        if (!offer) return i.reply({ content: '這個項目已經不在今天的清單裡了。', flags: MessageFlags.Ephemeral });
        const { cap } = capOf(gid, i.user.id, offer);
        if (cap === 1) {
          const res = doExchange(gid, i.user.id, i.user.username, offer.id, 1);
          return i.reply(res.error ? { content: res.error, flags: MessageFlags.Ephemeral }
            : { embeds: [res.embed], flags: MessageFlags.Ephemeral }).catch(() => {});
        }
        const view = qtyView(gid, i.user.id, offer);
        return i.reply(view.error ? { content: view.error, flags: MessageFlags.Ephemeral }
          : { ...view, flags: MessageFlags.Ephemeral }).catch(() => {});
      }

      // 選次數 → 成交
      if (i.isStringSelectMenu() && i.customId.startsWith('exqty:')) {
        const offerId = parseInt(i.customId.split(':')[1], 10);
        const times = parseInt(i.values[0], 10) || 1;
        const res = doExchange(gid, i.user.id, i.user.username, offerId, times);
        return i.update(res.error ? { content: res.error, embeds: [], components: [] }
          : { content: '', embeds: [res.embed], components: [] }).catch(() => {});
      }

      if (i.isChatInputCommand() && i.commandName === '兌換所') {
        const out = listView(gid, i.user.id);
        return i.reply(out.error ? { content: out.error, flags: MessageFlags.Ephemeral }
          : { embeds: [out.embed], components: out.components, flags: MessageFlags.Ephemeral });
      }
    } catch (e) {
      logError(i.guildId, '素材兌換所失敗：', e.message);
      const msg = { content: '執行失敗，管理員可到後台的系統錯誤紀錄查看原因。', flags: MessageFlags.Ephemeral };
      if (i.replied || i.deferred) i.followUp(msg).catch(() => {});
      else i.reply(msg).catch(() => {});
    }
  });
}

module.exports = { init, todayOffers, doExchange, capOf, seedOffers };
