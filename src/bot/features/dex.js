// 圖鑑與稱號。
//
// 兩條規則（照你們的要求定死）：
//   ① 圖鑑本身「只給能力，不給物品」。收集到門檻就解鎖稱號，稱號才是能力的載體。
//   ② 稱號完全資料驅動 —— title_defs 全部欄位都能在後台增刪改，程式不寫死任何一個稱號。
//      所以之後要加《幸運星》《釣魚之神》都不用改程式，後台新增一筆就好。
//
// 防爆規則：稱號可以無限收集，但同時只能裝備 home_config.title_slots 個（預設 3）。
const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, MessageFlags } = require('discord.js');
const { db, guildConfig, logError } = require('../../db');
const { brandColor } = require('../../util/brand');
const { BUFF_TYPES } = require('../../util/buffs');
const { seedHome, homeOf, NAV } = require('./home');

const hcfg = (gid) => guildConfig('home_config', gid);

// 圖鑑分類：key → [顯示名, 這一類的「全部」怎麼算]
const DEX_CATS = {
  fish:       { name: '🐟 魚類圖鑑',   total: (gid) => cnt(gid, "kind='fish'") },
  crop:       { name: '🌾 農作圖鑑',   total: (gid) => cropTotal(gid, 'field') },
  greenhouse: { name: '🌸 溫室圖鑑',   total: (gid) => cropTotal(gid, 'greenhouse') },
  mine:       { name: '⛏️ 礦石圖鑑',   total: (gid) => cnt(gid, "kind='mine'") },
  forage:     { name: '🍄 採集圖鑑',   total: (gid) => cnt(gid, "kind='forage'") },
  hunt:       { name: '🏹 狩獵圖鑑',   total: (gid) => cnt(gid, "kind='hunt'") },
  cook:       { name: '🍳 料理圖鑑',   total: (gid) => one(gid, 'SELECT COUNT(*) n FROM cook_recipes WHERE guild_id=? AND enabled=1') },
  pet:        { name: '🐾 寵物圖鑑',   total: (gid) => one(gid, 'SELECT COUNT(*) n FROM pet_defs WHERE guild_id=? AND enabled=1') },
  furniture:  { name: '🛋️ 家具圖鑑',   total: (gid) => one(gid, 'SELECT COUNT(*) n FROM home_furniture WHERE guild_id=? AND enabled=1') },
  role:       { name: '💝 角色紀念',   total: (gid) => one(gid, 'SELECT COUNT(*) n FROM wheel_roles WHERE guild_id=? AND enabled=1') }
};
const one = (gid, sql) => (db.prepare(sql).get(gid) || {}).n || 0;
const cnt = (gid, where) => one(gid, `SELECT COUNT(*) n FROM gather_items WHERE guild_id=? AND enabled=1 AND ${where}`);
const cropTotal = (gid, type) => (db.prepare(
  'SELECT COUNT(*) n FROM crop_seeds WHERE guild_id=? AND enabled=1 AND plot_type=?').get(gid, type) || {}).n || 0;

const seenCount = (gid, uid, cat) =>
  db.prepare('SELECT COUNT(*) n FROM dex_seen WHERE guild_id=? AND user_id=? AND cat=?').get(gid, uid, cat).n;

// 預設稱號。這只是「開箱即有東西可玩」的起手包 ——
// 全部欄位後台都能改，要新增《幸運星》之類的自己加一筆就好，程式不必動。
// [分類, 名稱, emoji, 門檻, 加成1, %, 加成2, %, 說明]
const SEED_TITLES = [
  ['fish', '新手釣客', '🎣', 5, 'fish_price_pct', 1, '', 0, '收集 5 種魚'],
  ['fish', '水域探索者', '🌊', 10, 'fish_rare_pct', 1, 'fish_price_pct', 1, '收集 10 種魚'],
  ['fish', '海洋之主', '🔱', 15, 'fish_rare_pct', 2, 'fish_price_pct', 3, '魚類全圖鑑'],
  ['mine', '礦工學徒', '⛏️', 5, 'mine_rare_pct', 1, '', 0, '收集 5 種礦石'],
  ['mine', '礦坑之王', '💎', 13, 'mine_rare_pct', 2, 'sell_pct', 2, '礦石全圖鑑'],
  ['crop', '見習農夫', '🌱', 5, 'sell_pct', 1, '', 0, '收集 5 種作物'],
  ['crop', '大地主', '🌾', 11, 'sell_pct', 2, 'speed_pct', 2, '農作全圖鑑'],
  ['greenhouse', '花藝師', '💐', 5, 'gift_pct', 2, '', 0, '收集 5 種花卉'],
  ['greenhouse', '溫室之主', '🌺', 9, 'gift_pct', 3, 'sell_pct', 1, '溫室全圖鑑'],
  ['forage', '山林行者', '🍄', 6, 'luck_pct', 2, '', 0, '收集 6 種採集物'],
  ['forage', '幸運星', '🍀', 13, 'luck_pct', 4, 'quest_pct', 2, '採集全圖鑑'],
  ['hunt', '獵人', '🏹', 6, 'sell_pct', 1, '', 0, '收集 6 種獵物'],
  ['hunt', '荒野霸主', '🐗', 14, 'steal_pct', 3, 'sell_pct', 2, '狩獵全圖鑑'],
  ['cook', '家庭煮夫煮婦', '🍳', 8, 'cook_price_pct', 1, '', 0, '完成 8 道料理'],
  ['cook', '料理職人', '👨‍🍳', 16, 'cook_perfect_pct', 2, 'cook_price_pct', 2, '完成 16 道料理'],
  ['cook', '傳說主廚', '🌟', 24, 'cook_perfect_pct', 3, 'gift_pct', 3, '料理全圖鑑'],
  ['pet', '愛心飼主', '🐾', 5, 'energy_pct', 2, '', 0, '收集 5 種寵物'],
  ['pet', '萬獸之友', '🦄', 15, 'luck_pct', 3, 'energy_pct', 3, '收集 15 種寵物'],
  ['furniture', '室內設計師', '🛋️', 15, 'sell_pct', 1, '', 0, '收集 15 種家具'],
  ['furniture', '生活美學家', '🏛️', 40, 'sell_pct', 2, 'energy_pct', 2, '收集 40 種家具'],
  ['home', '有殼一族', '🏠', 4, 'sell_pct', 1, '', 0, '家園蓋到 Lv.4'],
  ['home', '家的主人', '🏡', 8, 'visit_pct', 3, 'energy_pct', 2, '家園蓋到 Lv.8'],
  ['home', '星耀領主', '🌌', 12, 'sell_pct', 3, 'luck_pct', 3, '家園蓋到頂'],
  ['wealth', '小康之家', '💰', 100000, 'sell_pct', 1, '', 0, '身家 10 萬'],
  ['wealth', '億萬富翁', '🤑', 1000000, 'sell_pct', 2, 'stock_pct', 2, '身家 100 萬'],
  ['wealth', '華爾街之狼', '📈', 5000000, 'stock_pct', 3, 'sell_pct', 2, '身家 500 萬'],
  ['affinity', '戀愛新手', '💗', 3, 'gift_pct', 2, '', 0, '任一角色好感到 Lv.3'],
  ['affinity', '戀愛大師', '💘', 8, 'gift_pct', 3, 'visit_pct', 2, '任一角色好感到 Lv.8'],
  ['role', '收藏家', '💝', 30, 'luck_pct', 2, '', 0, '跟 30 位角色互動過']
];

function seedTitles(gid) {
  try {
    const has = db.prepare('SELECT 1 FROM title_defs WHERE guild_id=? AND name=?');
    const ins = db.prepare(`INSERT INTO title_defs
      (guild_id,cat,name,emoji,need,buff_type,buff_pct,buff2_type,buff2_pct,description,sort)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    db.transaction(() => {
      SEED_TITLES.forEach(([cat, name, emoji, need, b1, p1, b2, p2, desc], idx) => {
        if (has.get(gid, name)) return;
        ins.run(gid, cat, name, emoji, need, b1, p1, b2, p2, desc, idx);
      });
    })();
  } catch (e) { logError(gid, '預設稱號建立失敗：', e.message); }
}

/** 記一筆「見過」。各系統拿到東西時呼叫這支，賣掉也不會消失。 */
function markSeen(gid, uid, cat, key) {
  if (!cat || !key) return;
  try { db.prepare('INSERT OR IGNORE INTO dex_seen (guild_id,user_id,cat,key) VALUES (?,?,?,?)').run(gid, uid, cat, key); } catch {}
}

/**
 * 依目前進度結算應得的稱號。
 * 完全照 title_defs 的資料跑，管理員在後台新增一筆就會自動生效，不必改程式。
 */
function syncTitles(gid, uid, uname) {
  const defs = db.prepare('SELECT * FROM title_defs WHERE guild_id=? AND enabled=1').all(gid);
  if (!defs.length) return [];
  const home = homeOf(gid, uid, uname);
  const coins = (db.prepare('SELECT coins FROM econ_wallets WHERE guild_id=? AND user_id=?').get(gid, uid) || {}).coins || 0;
  const gained = [];
  for (const t of defs) {
    let have = 0;
    if (t.cat === 'wealth') have = coins;
    else if (t.cat === 'home') have = home.level;
    else if (t.cat === 'affinity') have = (db.prepare('SELECT COALESCE(MAX(level),0) n FROM affinity WHERE guild_id=? AND user_id=?').get(gid, uid) || {}).n || 0;
    else have = seenCount(gid, uid, t.cat);
    if (have < t.need) continue;
    const had = db.prepare('SELECT 1 FROM title_owned WHERE guild_id=? AND user_id=? AND title_id=?').get(gid, uid, t.id);
    if (had) continue;
    db.prepare('INSERT OR IGNORE INTO title_owned (guild_id,user_id,title_id,slot) VALUES (?,?,?,-1)').run(gid, uid, t.id);
    gained.push(t);
  }
  return gained;
}

const ownedTitles = (gid, uid) => db.prepare(
  `SELECT o.slot, t.* FROM title_owned o JOIN title_defs t ON t.id=o.title_id
    WHERE o.guild_id=? AND o.user_id=? AND t.enabled=1 ORDER BY o.slot DESC, t.sort, t.id`).all(gid, uid);

/** 裝備／卸下稱號。裝滿時明確告知，不默默替換掉玩家正在用的。 */
function equipTitle(gid, uid, titleId, on) {
  const row = db.prepare('SELECT slot FROM title_owned WHERE guild_id=? AND user_id=? AND title_id=?').get(gid, uid, titleId);
  if (!row) return { error: '你還沒有這個稱號。' };
  if (!on) {
    db.prepare('UPDATE title_owned SET slot=-1 WHERE guild_id=? AND user_id=? AND title_id=?').run(gid, uid, titleId);
    return { ok: '已卸下，該稱號的加成同時失效。' };
  }
  if (row.slot >= 0) return { error: '這個稱號已經裝備中了。' };
  const slots = Math.max(1, hcfg(gid).title_slots ?? 3);
  const used = db.prepare('SELECT COUNT(*) n FROM title_owned WHERE guild_id=? AND user_id=? AND slot>=0').get(gid, uid).n;
  if (used >= slots) return { error: `稱號欄位滿了（${used}/${slots}）。先卸下一個再裝，這是刻意的設計 —— 收集再多稱號，同時也只有 ${slots} 個生效。` };
  // 找一個沒被占用的欄位編號
  const taken = db.prepare('SELECT slot FROM title_owned WHERE guild_id=? AND user_id=? AND slot>=0').all(gid, uid).map(r => r.slot);
  let s = 0; while (taken.includes(s)) s++;
  db.prepare('UPDATE title_owned SET slot=? WHERE guild_id=? AND user_id=? AND title_id=?').run(s, gid, uid, titleId);
  return { ok: '已裝備，加成立即生效！' };
}

const buffText = (t) => [
  t.buff_type && t.buff_pct ? `${BUFF_TYPES[t.buff_type] || t.buff_type} +${t.buff_pct}%` : '',
  t.buff2_type && t.buff2_pct ? `${BUFF_TYPES[t.buff2_type] || t.buff2_type} +${t.buff2_pct}%` : ''
].filter(Boolean).join('　') || '無加成';

// ---- 圖鑑面板：只顯示完成度與它解鎖了什麼能力 ----
function dexPanel(gid, uid, uname) {
  syncTitles(gid, uid, uname);
  const lines = Object.entries(DEX_CATS).map(([key, c]) => {
    const total = c.total(gid);
    const have = seenCount(gid, uid, key);
    const pct = total ? Math.floor(have / total * 100) : 0;
    const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
    return `${c.name}\n　\`${bar}\` **${have} / ${total}**${total && have >= total ? '　🏅 全收集！' : ''}`;
  });
  const embed = new EmbedBuilder().setColor(brandColor()).setTitle('📖 圖鑑')
    .setDescription(lines.join('\n'))
    .setFooter({ text: '圖鑑只給能力、不給物品：收集到門檻會解鎖稱號，稱號才是加成的來源' });
  const rows = [NAV('home'), new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('dexcat').setPlaceholder('看某一類還缺什麼')
      .addOptions(Object.entries(DEX_CATS).map(([k, c]) => ({ label: c.name, value: k }))))];
  return { embeds: [embed], components: rows };
}

// 某一類的明細：已收集的打勾，沒收集的留白（不劇透稀有度）
function dexCatPanel(gid, uid, cat) {
  const c = DEX_CATS[cat];
  const seen = new Set(db.prepare('SELECT key FROM dex_seen WHERE guild_id=? AND user_id=? AND cat=?').all(gid, uid, cat).map(r => r.key));
  let names = [];
  if (['fish', 'mine', 'forage', 'hunt'].includes(cat))
    names = db.prepare('SELECT name FROM gather_items WHERE guild_id=? AND enabled=1 AND kind=? ORDER BY price').all(gid, cat).map(r => r.name);
  else if (cat === 'crop' || cat === 'greenhouse')
    names = db.prepare(
      `SELECT it.name FROM crop_seeds s JOIN gather_items it ON it.id = s.product_item_id
        WHERE s.guild_id=? AND s.enabled=1 AND s.plot_type=? ORDER BY s.sort, s.id`)
      .all(gid, cat === 'crop' ? 'field' : 'greenhouse').map(r => r.name);
  else if (cat === 'cook') names = db.prepare('SELECT name FROM cook_recipes WHERE guild_id=? AND enabled=1 ORDER BY sort').all(gid).map(r => r.name);
  else if (cat === 'pet') names = db.prepare('SELECT name FROM pet_defs WHERE guild_id=? AND enabled=1 ORDER BY sort').all(gid).map(r => r.name);
  else if (cat === 'furniture') names = db.prepare('SELECT name FROM home_furniture WHERE guild_id=? AND enabled=1 ORDER BY sort').all(gid).map(r => r.name);
  else if (cat === 'role') names = db.prepare('SELECT name FROM wheel_roles WHERE guild_id=? AND enabled=1 ORDER BY id').all(gid).map(r => r.name);

  const body = names.map(n => seen.has(n) ? `✅ ${n}` : `▫️ ???`).join('　') || '這一類還沒有內容。';
  const embed = new EmbedBuilder().setColor(brandColor()).setTitle(c ? c.name : '圖鑑')
    .setDescription(body.slice(0, 4000))
    .setFooter({ text: `${seen.size} / ${names.length}　沒收集到的不會顯示名字` });
  return { embeds: [embed], components: [NAV('home')] };
}

// ---- 稱號面板 ----
function titlePanel(gid, uid, uname) {
  const gained = syncTitles(gid, uid, uname);
  const list = ownedTitles(gid, uid);
  const slots = Math.max(1, hcfg(gid).title_slots ?? 3);
  const used = list.filter(t => t.slot >= 0);
  const embed = new EmbedBuilder().setColor(brandColor()).setTitle('🏅 稱號')
    .setDescription(list.length
      ? `你擁有 **${list.length}** 個稱號，同時可裝備 **${used.length} / ${slots}** 個。\n收集再多也只有裝備中的生效 —— 想賺錢就換賺錢的，想攻略角色就換戀愛的。`
      : '你還沒有任何稱號。\n把圖鑑收集到門檻、把家園蓋高、把角色好感度養起來，都會解鎖稱號。')
    .setFooter({ text: '稱號由管理員在後台自由增減，這裡顯示的都是後台設定的內容' });
  if (used.length) embed.addFields({ name: '⭐ 裝備中', value: used.map(t => `${t.emoji || ''}**${t.name}**　${buffText(t)}`).join('\n') });
  const idle = list.filter(t => t.slot < 0);
  if (idle.length) embed.addFields({ name: '📦 未裝備', value: idle.map(t => `${t.emoji || ''}${t.name}　${buffText(t)}`).join('\n').slice(0, 1024) });

  const rows = [NAV('home')];
  if (list.length) rows.push(new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('titleeq').setPlaceholder('裝備／卸下稱號')
      .addOptions(list.slice(0, 25).map(t => ({
        label: `${t.slot >= 0 ? '⭐ ' : ''}${t.emoji || ''}${t.name}`.slice(0, 100),
        description: `${buffText(t)}　→ ${t.slot >= 0 ? '點一下卸下' : '點一下裝備'}`.slice(0, 100),
        value: `${t.id}:${t.slot >= 0 ? 'off' : 'on'}`
      })))));
  return { embeds: [embed], components: rows, gained };
}

function init(client) {
  for (const [gid] of client.guilds.cache) { try { seedHome(gid); seedTitles(gid); } catch {} }
  client.on('interactionCreate', async (i) => {
    try {
      if (!i.guildId) return;
      const gid = i.guildId, uid = i.user.id, uname = i.user.username;
      const eph = { flags: MessageFlags.Ephemeral };

      if (i.isStringSelectMenu() && i.customId === 'dexcat')
        return i.update(dexCatPanel(gid, uid, i.values[0])).catch(() => {});
      if (i.isStringSelectMenu() && i.customId === 'titleeq') {
        const [tid, act] = i.values[0].split(':');
        const out = equipTitle(gid, uid, parseInt(tid, 10), act === 'on');
        if (out.error) return i.reply({ content: out.error, ...eph }).catch(() => {});
        const p = titlePanel(gid, uid, uname);
        await i.update({ embeds: p.embeds, components: p.components }).catch(() => {});
        return i.followUp({ content: out.ok, ...eph }).catch(() => {});
      }
      if (i.isChatInputCommand() && i.commandName === '圖鑑2')
        return i.reply({ ...dexPanel(gid, uid, uname), ...eph }).catch(() => {});
      if (i.isChatInputCommand() && i.commandName === '稱號') {
        const p = titlePanel(gid, uid, uname);
        await i.reply({ embeds: p.embeds, components: p.components, ...eph }).catch(() => {});
        if (p.gained.length) await i.followUp({
          content: `🎉 你解鎖了新稱號：\n${p.gained.map(t => `${t.emoji || ''}**${t.name}**　${buffText(t)}`).join('\n')}\n記得裝備才會生效。`,
          ...eph
        }).catch(() => {});
        return;
      }
    } catch (e) {
      logError(i.guildId, '圖鑑稱號指令失敗：', e.message);
      const msg = { content: '執行失敗，管理員可到後台的系統錯誤紀錄查看原因。', flags: MessageFlags.Ephemeral };
      if (i.replied || i.deferred) await i.followUp(msg).catch(() => {}); else await i.reply(msg).catch(() => {});
    }
  });
  console.log('  ↳ 圖鑑／稱號模組已載入（10 類圖鑑，稱號全後台可編輯）');
}

module.exports = { init, seedTitles, markSeen, syncTitles, dexPanel, titlePanel, DEX_CATS, buffText };
