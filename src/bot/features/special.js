// 特殊兌換商店（可分多間店，每間可發布面板到自己的頻道）
// 兌換不做內部代幣交易，而是把「兌換通知」貼到指定頻道並 @ 管理員，由人工處理。
const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, MessageFlags } = require('discord.js');
const { db, guildConfig, logError } = require('../../db');
const { brandColor } = require('../../util/brand');
const { absUrl } = require('../../util/url');
const { wallet } = require('./gather');
const { localToday, localWeekStart, parts } = require('../../util/time');

const scfg = (gid) => guildConfig('special_config', gid);
const gcfg = (gid) => guildConfig('gather_config', gid);
const csv = (s) => String(s || '').split(/[\n,]/).map(x => x.trim()).filter(Boolean);
const money = (c, n) => `${c.currency_emoji || '🪙'} ${Number(n).toLocaleString('en-US')} ${c.currency_name || '星幣'}`;

const shopsOf = (gid) => db.prepare('SELECT * FROM special_shops WHERE guild_id=? AND enabled=1 ORDER BY sort, id').all(gid);

// 神秘商店：可以指定只有某些帳號／身分組看得到、買得到。
// 兩層都空＝公開商店（原本的行為完全不變）。
const csvIds = (v) => String(v || '').split(/[\s,;、]+/).map(x => x.trim()).filter(Boolean);
function shopAllowed(shop, member, userId) {
  if (!shop) return true;
  const users = csvIds(shop.allow_users), roles = csvIds(shop.allow_roles);
  if (!users.length && !roles.length) return true;
  if (users.includes(String(userId))) return true;
  if (roles.length && member && member.roles && member.roles.cache) {
    return roles.some(r => member.roles.cache.has(r));
  }
  return false;
}
const visibleShops = (gid, member, userId) =>
  shopsOf(gid).filter(s => shopAllowed(s, member, userId) && (!s.hidden || shopAllowed(s, member, userId)));
const itemsOfShop = (gid, shopId) => db.prepare('SELECT * FROM special_items WHERE guild_id=? AND enabled=1 AND shop_id=? ORDER BY sort, price').all(gid, shopId);

// 要私訊誰：後台指定的管理員 user_id ＋ 通知身分組裡的成員（去重）
async function adminIds(client, gid, roleIds, adminUsers) {
  const ids = new Set(csv(adminUsers));
  const roles = csv(roleIds);
  if (roles.length) {
    const guild = client.guilds.cache.get(gid);
    if (guild) {
      // 身分組成員可能不在快取裡，抓一次（Discord 會快取起來，之後不用再抓）
      if (guild.members.cache.size < guild.memberCount) await guild.members.fetch().catch(() => {});
      for (const r of roles) {
        const role = guild.roles.cache.get(r);
        if (role) for (const m of role.members.values()) if (!m.user.bot) ids.add(m.id);
      }
    }
  }
  return [...ids];
}

// 欠稅（餘額負數）或有未還清的貸款的人不能兌換：先把債還完才能花錢
const debtError = (gid, uid, uname) => {
  const w = wallet(gid, uid, uname);
  const gc = gcfg(gid);
  if (w.coins < 0) {
    return `🚫 你目前**欠稅**（餘額 ${w.coins.toLocaleString('en-US')} ${gc.currency_name || '星幣'}），` +
      `要先把${gc.currency_name || '星幣'}賺回正數才能兌換。`;
  }
  // 有未還清的貸款也不能兌換：避免借錢掃貨後擺爛違約
  try {
    const open = require('./loans').openLoans(gid, uid);
    if (open && open.length) {
      return `🚫 你有 **${open.length} 筆未還清的貸款**，先用 \`/還款\` 全部還清才能使用神秘商店。`;
    }
  } catch { /* loans 模組未載入就略過 */ }
  return null;
};

// ---- 每人兌換上限 & 累進價格 ----
// 兩個都以「期」為單位，預設每月 1 號歸零（也可改每週一或永不重置）。
const QTY_MAX = 25;

// 本期起算時間（字串比對 special_redeems.created_at，格式一致都是 'YYYY-MM-DD HH:MM:SS'）
function periodStart(c) {
  const mode = c.limit_reset || 'month';
  if (mode === 'none') return '';
  if (mode === 'week') return `${localWeekStart()} 00:00:00`;
  if (mode === 'biweek') {
    // 每兩週一重置：以 2024-01-01（週一）為基準數週數，偶數週用本週一、奇數週用上週一
    const monday = localWeekStart();
    const mondayMs = new Date(monday + 'T00:00:00+08:00').getTime();
    const anchorMs = new Date('2024-01-01T00:00:00+08:00').getTime();
    const weeks = Math.floor((mondayMs - anchorMs) / (7 * 86400000));
    const start = weeks % 2 === 0 ? monday : localToday(new Date(mondayMs - 7 * 86400000));
    return `${start} 00:00:00`;
  }
  const p = parts();
  return `${p.y}-${String(p.mo).padStart(2, '0')}-01 00:00:00`;
}
// 本期起算之後的下一個重置日，講給玩家聽
function nextResetText(c) {
  const mode = c.limit_reset || 'month';
  if (mode === 'none') return '不會重置';
  if (mode === 'week') return '每週一 00:00 歸零';
  if (mode === 'biweek') return '每兩週的週一 00:00 歸零';
  return '每月 1 號 00:00 歸零';
}
// 這個人這一期已經換過幾份
function usedQty(gid, uid, itemId, since) {
  const q = since
    ? db.prepare('SELECT COALESCE(SUM(qty),0) n FROM special_redeems WHERE guild_id=? AND user_id=? AND item_id=? AND created_at >= ?').get(gid, uid, itemId, since)
    : db.prepare('SELECT COALESCE(SUM(qty),0) n FROM special_redeems WHERE guild_id=? AND user_id=? AND item_id=?').get(gid, uid, itemId);
  return q.n;
}
// 每人上限：商品自己有設就用商品的，否則用全域（0＝不限）
const limitOf = (c, item) => (item.per_user_limit > 0 ? item.per_user_limit : (c.per_item_limit || 0));

// 第 n 份的單價（n 從 0 起算）。沒開累進就一律原價。
function unitPrice(c, item, n) {
  if (!c.price_escalate) return item.price;
  const mult = Math.max(1, Number(c.escalate_mult) || 1);
  return Math.round(item.price * Math.pow(mult, n));
}
// 買 qty 份的總價（已經換過 already 份的人，從第 already+1 份開始算）
function costOf(c, item, already, qty) {
  let sum = 0;
  for (let k = 0; k < qty; k++) sum += unitPrice(c, item, already + k);
  return sum;
}

// 一次可以兌換幾份：受庫存、餘額、每人上限三方夾擊，最多 25（下拉選單上限）
function qtyCap(gid, item, uid, uname) {
  const c = scfg(gid);
  const w = wallet(gid, uid, uname);
  const already = usedQty(gid, uid, item.id, periodStart(c));
  const limit = limitOf(c, item);
  const roomByLimit = limit > 0 ? Math.max(0, limit - already) : QTY_MAX;
  const stock = item.stock < 0 ? QTY_MAX : item.stock;
  // 累進價格下每一份都比前一份貴，所以一份一份加上去看買得起幾份
  let cap = 0, spent = 0;
  const max = Math.min(QTY_MAX, stock, roomByLimit);
  while (cap < max) {
    const next = spent + unitPrice(c, item, already + cap);
    if (next > w.coins) break;
    spent = next; cap++;
  }
  return { cap, coins: w.coins, already, limit, roomByLimit };
}

// 共用兌換邏輯：扣星幣、扣庫存、記錄、通知管理員。回傳給玩家看的 embed。
async function doRedeem(client, gid, item, user, uname, qtyRaw = 1, member = null) {
  const c = scfg(gid), gc = gcfg(gid);
  const qty = Math.max(1, Math.min(QTY_MAX, Math.floor(Number(qtyRaw) || 1)));
  // 神秘商店的限定名單：直接打 /兌換 商品名稱 也要擋，不能只靠列表藏起來
  if (item.shop_id) {
    const sh = db.prepare('SELECT * FROM special_shops WHERE id=? AND guild_id=?').get(item.shop_id, gid);
    if (sh && !shopAllowed(sh, member, user.id)) {
      return { error: '這是限定商店的商品，你目前沒有兌換資格。' };
    }
  }
  const debt = debtError(gid, user.id, uname);
  if (debt) return { error: debt };
  if (item.stock === 0) return { error: `**${item.name}** 已經兌換完了（庫存 0）。` };
  if (item.stock > 0 && qty > item.stock) return { error: `**${item.name}** 只剩 ${item.stock} 份，沒辦法一次換 ${qty} 份。` };

  // 每人上限（每期）
  const since = periodStart(c);
  const already = usedQty(gid, user.id, item.id, since);
  const limit = limitOf(c, item);
  if (limit > 0 && already + qty > limit) {
    return {
      error: already >= limit
        ? `**${item.name}** 你這期已經換滿 ${limit} 份了（${nextResetText(c)}）。`
        : `**${item.name}** 每人這期上限 ${limit} 份，你已經換了 ${already} 份，最多還能再換 ${limit - already} 份。`
    };
  }

  const w = wallet(gid, user.id, uname);
  const total = costOf(c, item, already, qty);
  if (w.coins < total) {
    const detail = c.price_escalate
      ? `第 ${already + 1}~${already + qty} 份共 ${total.toLocaleString('en-US')}（越換越貴）`
      : `${item.price.toLocaleString('en-US')} × ${qty}`;
    return { error: `${gc.currency_name}不夠：需要 ${total.toLocaleString('en-US')}（${detail}），你只有 ${w.coins.toLocaleString('en-US')}。` };
  }

  let redeemId;
  const tx = db.transaction(() => {
    db.prepare('UPDATE econ_wallets SET coins = coins - ? WHERE guild_id=? AND user_id=?').run(total, gid, user.id);
    if (item.stock > 0) db.prepare('UPDATE special_items SET stock = stock - ? WHERE id=?').run(qty, item.id);
    // price 記「這次實際的平均單價」，總價才等於 price×qty，後台與消費稅都對得上
    redeemId = db.prepare('INSERT INTO special_redeems (guild_id,user_id,username,item_id,item_name,price,qty,paid) VALUES (?,?,?,?,?,?,?,?)')
      .run(gid, user.id, uname, item.id, item.name, Math.round(total / qty), qty, total).lastInsertRowid;
  });
  tx();

  // 直接發素材：grant_item_id 有設就把東西直接放進背包，不用等管理員手動處理。
  // 這是「神秘商店賣素材」的核心 —— 買完立刻能用，跟一般虛擬獎勵的流程分開。
  if (item.grant_item_id > 0) {
    const gi = db.prepare('SELECT * FROM gather_items WHERE id=? AND guild_id=?').get(item.grant_item_id, gid);
    if (gi) {
      const n = Math.max(1, item.grant_count || 1) * qty;
      db.prepare(`INSERT INTO gather_inventory (guild_id,user_id,item_id,count) VALUES (?,?,?,?)
        ON CONFLICT(guild_id,user_id,item_id) DO UPDATE SET count = count + ?`).run(gid, user.id, gi.id, n, n);
      db.prepare("UPDATE special_redeems SET status='done' WHERE id=?").run(redeemId);   // 自動發放＝當場結案，不進管理員待辦
      return {
        embed: new EmbedBuilder().setColor(brandColor()).setTitle('📦 兌換成功（已直接發到背包）')
          .setDescription(`你用 ${money(gc, total)} 換到 ${gi.emoji || ''}**${gi.name}** × **${n}**\n`
            + `已經直接放進你的背包，用 \`/背包\` 看得到，可以馬上拿去做東西。`)
          .setFooter({ text: `餘額 ${(w.coins - total).toLocaleString('en-US')} ${gc.currency_name}｜兌換單 #${redeemId}` })
      };
    }
  }

  // 通知目標：優先用商品所屬「商店」綁定的頻道與身分組，其次商品自訂，最後全域預設
  const shop = item.shop_id ? db.prepare('SELECT * FROM special_shops WHERE id=? AND guild_id=?').get(item.shop_id, gid) : null;
  const roleIds = (shop && shop.notify_roles) ? shop.notify_roles : c.admin_roles;
  const mode = c.notify_mode || 'shop';
  // shop＝發在商店頻道（公開）；log＝只發到管理員通知頻道；dm＝不發任何頻道，改私訊管理員
  const chId = mode === 'dm' ? '' : (mode === 'log' ? c.log_channel : (item.channel_id || (shop && shop.channel_id) || c.log_channel));

  const notify = new EmbedBuilder().setColor(brandColor()).setTitle('🎁 收到一筆兌換')
    .setDescription(`<@${user.id}> 用 ${money(gc, total)} 兌換了 **${item.emoji || ''}${item.name}** × **${qty}**` +
      (item.role_id ? `\n對應身分組：<@&${item.role_id}>` : '') +
      (item.description ? `\n\n${item.description}` : '') +
      `\n\n請管理員協助處理，完成後可到後台把這筆標記為已處理。`)
    .setFooter({ text: `兌換單 #${redeemId}｜${uname}` });
  if (item.image_url) notify.setThumbnail(absUrl(item.image_url));

  let posted = false;
  if (chId) {
    const ch = client.channels.cache.get(chId) || await client.channels.fetch(chId).catch(() => null);
    if (ch) {
      const mentions = [...csv(roleIds).map(r => `<@&${r}>`), ...csv(c.admin_users).map(u => `<@${u}>`)];
      await ch.send({ content: `🔔 ${mentions.join(' ')} 有新的兌換需要處理！`.trim(), embeds: [notify] })
        .catch(e => logError(gid, '兌換公告發送失敗：', e.message));
      posted = true;
    }
  }
  if (mode === 'dm') {
    for (const id of await adminIds(client, gid, roleIds, c.admin_users)) {
      const u = await client.users.fetch(id).catch(() => null);
      if (!u) continue;
      if (await u.send({ embeds: [notify] }).then(() => true).catch(() => false)) posted = true;
    }
  }
  const embed = new EmbedBuilder().setColor(brandColor()).setTitle('✅ 兌換成功')
    .setDescription(`你兌換了 ${item.emoji || '🎁'} **${item.name}** × **${qty}**！\n` +
      `共花費 ${money(gc, total)}\n` +
      (posted ? '已私下通知管理員為你處理，請留意私訊。' : '⚠️ 目前沒有可用的通知管道，請直接聯絡管理員。') +
      `\n\n兌換單編號：#${redeemId}`)
    .setFooter({ text: `餘額 ${(w.coins - total).toLocaleString('en-US')} ${gc.currency_name}` });
  return { embed };
}

// 規則摘要：上限與累進價格要讓玩家一眼看到，不然會覺得被坑
function rulesLine(gid) {
  const c = scfg(gid);
  const bits = [];
  if (c.per_item_limit > 0) bits.push(`每人每項上限 ${c.per_item_limit} 份（${nextResetText(c)}）`);
  if (c.price_escalate) bits.push(`同一項越換越貴（每份 ×${Number(c.escalate_mult) || 2}）`);
  return bits.length ? bits.join('｜') : '';
}

// 商店面板（一則含商品清單 + 兌換下拉選單）
function shopPanel(gid, shop) {
  const gc = gcfg(gid);
  const items = itemsOfShop(gid, shop.id);
  const embed = new EmbedBuilder().setColor(brandColor())
    .setTitle(`${shop.emoji || '🎁'} ${shop.name}`)
    .setDescription((shop.description ? shop.description + '\n\n' : '') +
      (items.length ? items.map(it => {
        const stock = it.stock < 0 ? '' : `　庫存 ${it.stock}`;
        return `${it.emoji || '🎁'} **${it.name}**　${money(gc, it.price)}${stock}${it.description ? `\n　　${it.description}` : ''}`;
      }).join('\n') : '（尚無商品）'))
    .setFooter({ text: rulesLine(gid) || '從下方選單選一項即可兌換，系統會通知管理員處理' });
  const components = [];
  if (items.length) {
    components.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(`sredeem:${shop.id}`).setPlaceholder('選擇要兌換的獎勵…')
        .addOptions(items.slice(0, 25).map(it => ({
          label: `${it.name}`.slice(0, 100),
          description: `${money(gc, it.price)}${it.stock < 0 ? '' : `｜庫存 ${it.stock}`}`.slice(0, 100),
          value: String(it.id)
        })))
    ));
  }
  return { embeds: [embed], components };
}

async function publishShop(client, shopId) {
  const shop = db.prepare('SELECT * FROM special_shops WHERE id=?').get(shopId);
  if (!shop) throw new Error('找不到商店');
  if (!shop.channel_id) throw new Error('這間店還沒設定發布頻道');
  const ch = client.channels.cache.get(shop.channel_id) || await client.channels.fetch(shop.channel_id).catch(() => null);
  if (!ch) throw new Error('找不到發布頻道');
  const payload = shopPanel(shop.guild_id, shop);
  // 已發布過就編輯原訊息，否則發新的
  if (shop.message_id) {
    const msg = await ch.messages.fetch(shop.message_id).catch(() => null);
    if (msg) { await msg.edit(payload); return; }
  }
  const sent = await ch.send(payload);
  db.prepare('UPDATE special_shops SET message_id=? WHERE id=?').run(sent.id, shopId);
}

function init(client) {
  client._publishShop = (shopId) => publishShop(client, shopId);

  // 兌換收尾：扣款 → 回覆玩家 → 刷新面板庫存。
  // 從份數選單來的是自己的暫時訊息（可 update）；直接從商品選單來的是公開面板（只能另外私訊回覆）
  const finishRedeem = async (i, gid, item, shopId, qty) => {
    const res = await doRedeem(client, gid, item, i.user, i.user.username, qty, i.member);
    const payload = res.error
      ? { content: res.error, embeds: [], components: [] }
      : { content: '', embeds: [res.embed], components: [] };
    if (i.customId.startsWith('sqty:')) await i.update(payload).catch(() => {});
    else await i.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {});
    if (!res.error) {
      const sid = shopId || item.shop_id;
      if (sid) publishShop(client, sid).catch(() => {});
    }
  };

  client.on('interactionCreate', async (i) => {
    try {
      // ---- 面板下拉選單兌換：選商品 → 選份數 ----
      if (i.isStringSelectMenu() && i.customId.startsWith('sredeem:')) {
        const gid = i.guildId;
        const c = scfg(gid), gc = gcfg(gid);
        if (!c.enabled) return i.reply({ content: '特殊商店目前停用中。', flags: MessageFlags.Ephemeral });
        const shopId = parseInt(i.customId.split(':')[1], 10) || 0;
        const item = db.prepare('SELECT * FROM special_items WHERE guild_id=? AND enabled=1 AND id=?').get(gid, parseInt(i.values[0], 10));
        if (!item) return i.reply({ content: '這個獎勵已不存在。', flags: MessageFlags.Ephemeral });
        if (item.stock === 0) return i.reply({ content: `**${item.name}** 已經兌換完了（庫存 0）。`, flags: MessageFlags.Ephemeral });
        const debt = debtError(gid, i.user.id, i.user.username);
        if (debt) return i.reply({ content: debt, flags: MessageFlags.Ephemeral });
        const { cap, coins, already, limit, roomByLimit } = qtyCap(gid, item, i.user.id, i.user.username);
        if (limit > 0 && roomByLimit <= 0) {
          return i.reply({ content: `**${item.name}** 你這期已經換滿 ${limit} 份了（${nextResetText(c)}）。`, flags: MessageFlags.Ephemeral });
        }
        if (cap <= 0) {
          const need = unitPrice(c, item, already);
          return i.reply({ content: `${gc.currency_name}不夠：**${item.name}** 你的下一份要 ${need.toLocaleString('en-US')}，你只有 ${coins.toLocaleString('en-US')}。`, flags: MessageFlags.Ephemeral });
        }
        // 只能換一份就不用問了，直接兌換
        if (cap === 1) return await finishRedeem(i, gid, item, shopId, 1);
        const opts = [];
        for (let n = 1; n <= cap; n++) {
          const sum = costOf(c, item, already, n);
          opts.push({ label: `${n} 份`, description: `共 ${sum.toLocaleString('en-US')} ${gc.currency_name}`.slice(0, 100), value: String(n) });
        }
        const menu = new StringSelectMenuBuilder().setCustomId(`sqty:${shopId}:${item.id}`)
          .setPlaceholder('要兌換幾份？').setMinValues(1).setMaxValues(1).addOptions(opts);
        const head = `${item.emoji || '🎁'} **${item.name}**　下一份（第 ${already + 1} 份）${money(gc, unitPrice(c, item, already))}　👉 你的 ${coins.toLocaleString('en-US')} ${gc.currency_name}可換 **${cap}** 份` +
          (item.stock < 0 ? '' : `　庫存 ${item.stock}`) +
          (limit > 0 ? `\n你這期已換 **${already}/${limit}** 份（${nextResetText(c)}）` : '') +
          (c.price_escalate ? `\n📈 這間店**越換越貴**：每多換一份，下一份價格 ×${Number(c.escalate_mult) || 2}` : '');
        return i.reply({
          content: `${head}\n要兌換幾份？（最多 ${cap} 份）`,
          components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral
        });
      }
      // ---- 選好份數 → 真正兌換 ----
      if (i.isStringSelectMenu() && i.customId.startsWith('sqty:')) {
        const gid = i.guildId;
        if (!scfg(gid).enabled) return i.update({ content: '特殊商店目前停用中。', components: [], embeds: [] }).catch(() => {});
        const [, shopIdRaw, itemIdRaw] = i.customId.split(':');
        const item = db.prepare('SELECT * FROM special_items WHERE guild_id=? AND enabled=1 AND id=?').get(gid, parseInt(itemIdRaw, 10));
        if (!item) return i.update({ content: '這個獎勵已不存在。', components: [], embeds: [] }).catch(() => {});
        return await finishRedeem(i, gid, item, parseInt(shopIdRaw, 10) || 0, parseInt(i.values[0], 10));
      }

      // 面板按鈕 adv:shop → 等同 /特殊商店
      const cmdName = (i.isButton() && i.customId === 'adv:shop') ? '特殊商店'
        : (i.isChatInputCommand() ? i.commandName : null);
      if (!['特殊商店', '兌換'].includes(cmdName)) return;
      const gid = i.guildId;
      if (!gid) return i.reply({ content: '這個指令只能在伺服器裡使用。', flags: MessageFlags.Ephemeral });
      const c = scfg(gid), gc = gcfg(gid);
      if (!c.enabled) return i.reply({ content: '特殊商店目前停用中。', flags: MessageFlags.Ephemeral });
      const uid = i.user.id, uname = i.user.username;
      const reply = (payload) => i.reply({ ...payload, flags: MessageFlags.Ephemeral });

      const debtMsg = debtError(gid, uid, uname);

      // ---- 特殊商店：列出各分店與商品 ----
      if (cmdName === '特殊商店') {
        // 頻道限定：這個頻道有綁分店 → 只列那幾間；沒綁的頻道維持列全部
        // 只列這位玩家「看得到」的分店（神秘商店可以限定帳號／身分組）
        const all = visibleShops(gid, i.member, uid);
        const here = c.channel_scoped ? all.filter(s => s.channel_id && s.channel_id === i.channelId) : [];
        const shops = here.length ? here : all;
        const scoped = here.length > 0;
        const w = wallet(gid, uid, uname);
        // 這位玩家「下一份」實際要付的價（含翻倍）：讓他不用點進去就知道
        const priceNow = (it) => c.price_escalate ? unitPrice(c, it, usedQty(gid, uid, it.id, periodStart(c))) : it.price;
        // 用現在身上的錢還能換幾份（已扣掉庫存、每人上限、越換越貴的影響）
        const affordable = (it) => qtyCap(gid, it, uid, uname).cap;
        const priceStr = (it) => {
          const p = priceNow(it), n = affordable(it);
          return `${money(gc, p)}${p !== it.price ? `（原價 ${money(gc, it.price)}）` : ''}　` +
            (n > 0 ? `👉 你的錢可換 **${n}** 份` : '👉 錢不夠');
        };
        const embed = new EmbedBuilder().setColor(brandColor()).setTitle('🎁 特殊兌換商店')
          .setFooter({ text: `你的餘額：${w.coins.toLocaleString('en-US')} ${gc.currency_name}｜用 /兌換 商品名稱 兌換` });
        const blocks = [];
        for (const s of shops) {
          const its = itemsOfShop(gid, s.id);
          if (!its.length) continue;
          blocks.push(`**${s.emoji || '🏷️'} ${s.name}**\n` + its.map(it =>
            `　${it.emoji || '🎁'} ${it.name}　${priceStr(it)}${it.stock < 0 ? '' : `（庫存 ${it.stock}）`}`).join('\n'));
        }
        // 未分類（shop_id=0）的商品。限定到某間分店時不列，免得別店的東西混進來
        const loose = scoped ? [] : db.prepare('SELECT * FROM special_items WHERE guild_id=? AND enabled=1 AND (shop_id=0 OR shop_id IS NULL) ORDER BY sort, price').all(gid);
        if (loose.length) blocks.push('**🏷️ 其他**\n' + loose.map(it =>
          `　${it.emoji || '🎁'} ${it.name}　${priceStr(it)}${it.stock < 0 ? '' : `（庫存 ${it.stock}）`}`).join('\n'));
        if (!blocks.length) return await reply({ content: scoped ? '這個頻道的商店目前沒有上架任何獎勵。' : '特殊商店目前還沒有任何獎勵。' });
        if (scoped) embed.setTitle('🎁 ' + shops.map(s => `${s.emoji || '🏷️'} ${s.name}`).join('・'));
        if (debtMsg) blocks.unshift(debtMsg + '\n');
        embed.setDescription(blocks.join('\n\n'));
        // 兌換選單：跟商店面板一樣點一下就換，不用打 /兌換 名稱
        const pool = [];
        for (const sp of shops) for (const it of itemsOfShop(gid, sp.id)) pool.push({ it, shop: sp });
        if (!scoped) for (const it of loose) pool.push({ it, shop: null });
        const avail = pool.filter(x => x.it.stock !== 0);
        const rows = avail.length ? [new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder().setCustomId('sredeem:0').setPlaceholder('選擇要兌換的獎勵…')
            .addOptions(avail.slice(0, 25).map(({ it, shop }) => {
              const p = priceNow(it), n = affordable(it);
              return {
                label: `${shop ? shop.name + '：' : ''}${it.name}`.slice(0, 100),
                description: `你這份 ${p.toLocaleString('en-US')} ${gc.currency_name}${p !== it.price ? '（越換越貴）' : ''}｜可換 ${n} 份${it.stock < 0 ? '' : `　庫存 ${it.stock}`}`.slice(0, 100),
                value: String(it.id), emoji: it.emoji || '🎁'
              };
            }))) ] : [];
        return await reply({ embeds: [embed], components: rows });
      }

      // ---- 兌換 ----
      if (i.commandName === '兌換') {
        if (debtMsg) return await reply({ content: debtMsg });
        const what = (i.options.getString('商品') || '').trim();
        const item = db.prepare('SELECT * FROM special_items WHERE guild_id=? AND enabled=1 AND name=?').get(gid, what);
        if (!item) return await reply({ content: `找不到獎勵「${what}」，用 \`/特殊商店\` 看看有哪些。` });
        // 頻道限定：這個頻道有綁分店時，只能兌換該店的商品（否則等於繞過頻道限制）
        if (c.channel_scoped) {
          const here = shopsOf(gid).filter(s => s.channel_id && s.channel_id === i.channelId);
          if (here.length && !here.some(s => s.id === item.shop_id)) {
            return await reply({ content: `「${item.name}」不屬於這個頻道的商店，請到它自己的頻道兌換。` });
          }
        }
        const res = await doRedeem(client, gid, item, i.user, uname, i.options.getInteger('數量') || 1, i.member);
        if (res.error) return await reply({ content: res.error });
        // 若該商品所屬分店有發布面板，順手刷新庫存
        if (item.shop_id) publishShop(client, item.shop_id).catch(() => {});
        return await reply({ embeds: [res.embed] });
      }
    } catch (e) {
      logError(i.guildId || '', '特殊商店指令失敗：', e.message);
      const msg = { content: '執行失敗，管理員可到後台的系統錯誤紀錄查看原因。', flags: MessageFlags.Ephemeral };
      if (i.isRepliable && !i.replied && !i.deferred) await i.reply(msg).catch(() => {});
    }
  });

  console.log('  ↳ 特殊兌換商店模組已載入（多分店／面板發布／通知管理員）');
}

module.exports = { init, doRedeem, qtyCap };
