// 寵物：跟牧場動物刻意分開 —— 牧場是「工廠」（生蛋生奶），寵物是「夥伴」（給加成、要餵、有親密度）。
// 所以寵物一律不產物，能養幾隻由房屋階級決定，技能加成按親密度比例給（不餵就沒效果）。
const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { db, guildConfig, logError } = require('../../db');
const { bump: bumpAch } = require('../../util/achievements');
const { brandColor } = require('../../util/brand');
const { wallet, addCoins } = require('./gather');
const { BUFF_TYPES } = require('../../util/buffs');
const { seedHome, homeOf, levelDef, bagCount, parseMats, takeItems, NAV } = require('./home');
const { markSeen } = require('./dex');

const gcfg = (gid) => guildConfig('gather_config', gid);
const money = (c, n) => `${c.currency_emoji || '🪙'} ${Number(n).toLocaleString('en-US')} ${c.currency_name || '星幣'}`;

// 個性只影響對話語氣與親密度成長速度，不給數值優勢（避免洗個性）
const PERSONALITIES = ['黏人', '高冷', '貪吃', '愛玩', '膽小', '傲嬌', '穩重', '好奇'];
const RARITY = { N: '⚪', R: '🟢', SR: '🔵', SSR: '🟣', UR: '🟠' };

// [名稱, emoji, 稀有度, 需要房屋階, 售價(0=不販售), 材料, 技能名, 加成類型, 滿親密加成%, 餵食間隔時, 說明]
const SEED_PETS = [
  // ---- 一般寵物：給生產／經濟加成 ----
  ['橘貓', '🐈', 'N', 3, 8000, [['小魚', 10]], '慵懶陪伴', 'energy_pct', 3, 24, '整天都在睡，但你回家牠會來蹭'],
  ['白兔', '🐇', 'N', 3, 7000, [['紅蘿蔔', 15]], '幸運腳掌', 'luck_pct', 3, 24, '據說摸了會帶來好運'],
  ['黃金鼠', '🐹', 'N', 3, 5000, [['小麥', 20]], '囤積本能', 'sell_pct', 2, 24, '什麼都往頰囊裡塞'],
  ['虎皮鸚鵡', '🦜', 'N', 3, 9000, [['莓果', 15]], '學舌報信', 'quest_pct', 3, 24, '會學你講話，有時候很尷尬'],
  ['布偶貓', '🐈‍⬛', 'R', 4, 30000, [['章魚', 8], ['牛奶', 20]], '招財肉球', 'sell_pct', 4, 24, '毛長得像雲，抱起來會融化'],
  ['垂耳兔', '🐰', 'R', 4, 28000, [['草莓', 20]], '四葉祝福', 'luck_pct', 5, 24, '耳朵垂下來的時候最可愛'],
  ['赤狐', '🦊', 'SR', 5, 90000, [['野鴨', 15], ['莓果', 30]], '狡黠嗅覺', 'mine_rare_pct', 5, 20, '聰明得有點過頭'],
  ['貓頭鷹', '🦉', 'SR', 5, 95000, [['野鳥蛋', 12]], '夜行智慧', 'xp_pct', 5, 20, '整夜盯著你工作'],
  ['水獺', '🦦', 'SR', 6, 110000, [['吳郭魚', 25], ['螃蟹', 8]], '摸魚高手', 'fish_rare_pct', 5, 20, '會幫你抓魚，也會偷吃'],
  ['浣熊', '🦝', 'SR', 6, 105000, [['蘑菇', 30]], '翻箱倒櫃', 'steal_pct', 5, 20, '你的東西牠都當作牠的'],
  ['梅花鹿', '🦌', 'SSR', 7, 300000, [['鹿', 3], ['藥草', 40]], '森之祝福', 'speed_pct', 6, 18, '眼睛濕潤得讓人說不出話'],
  ['錦鯉', '🐟', 'SSR', 7, 280000, [['龍蝦', 5], ['水晶', 10]], '流水生財', 'fish_price_pct', 6, 24, '養在庭院池塘裡的富貴象徵'],
  ['黑豹', '🐆', 'SSR', 8, 450000, [['黑豹', 2], ['山羌', 10]], '暗影狩獵', 'steal_pct', 8, 18, '走路完全沒有聲音'],

  // ---- 守衛寵物：取代牧場的看門動物，不再佔生產格子 ----
  // 分得很細：只擋牧場的、只擋魚缸的、兩邊都擋的，還有專門反咬小偷的。
  ['看門鵝', '🪿', 'N', 3, 12000, [['小麥', 25]], '嘎嘎警報', 'ranch_resist_pct', 8, 24, '吵得要命，但小偷真的怕牠'],
  ['牧羊犬', '🐕', 'R', 3, 35000, [['野兔', 12], ['牛奶', 15]], '牧場守望', 'ranch_resist_pct', 15, 24, '整天繞著牧場巡邏'],
  ['虎斑貓', '🐅', 'R', 4, 38000, [['小魚', 30]], '魚缸看守', 'aqua_resist_pct', 15, 24, '趴在魚缸邊，誰都別想動'],
  ['蒼鷺', '🪶', 'SR', 5, 120000, [['鰻魚', 10], ['河豚', 5]], '水域哨兵', 'aqua_resist_pct', 22, 20, '站在池邊一動也不動，眼睛沒離開過水面'],
  ['杜賓犬', '🐕‍🦺', 'SR', 6, 150000, [['山雞', 20], ['野豬', 5]], '兇猛看門', 'ranch_resist_pct', 22, 20, '不叫也不動，但你知道牠在看著'],
  ['獴', '🦡', 'SR', 6, 130000, [['蘑菇', 25], ['莓果', 25]], '反擊本能', 'guard_bite_pct', 25, 20, '被惹到會直接咬回去，小偷會掉錢'],
  ['雪狼', '🐺', 'SSR', 8, 420000, [['白狼', 2], ['棕熊', 3]], '狼群威嚇', 'steal_resist_pct', 18, 18, '牧場魚缸一起顧，全域防竊'],
  ['守護石像鬼', '🗿', 'SSR', 9, 600000, [['黑曜石', 40], ['碎石', 100]], '不眠守衛', 'steal_resist_pct', 25, 999, '不用餵，牠本來就不會餓'],

  // ---- 傳說級 ----
  ['幼龍', '🐉', 'UR', 10, 1500000, [['幼龍', 1], ['硫磺', 50], ['黑曜石', 30]], '龍息鍛造', 'mine_rare_pct', 10, 12, '會噴一點點火，燒過你三次窗簾'],
  ['鳳凰雛', '🦅', 'UR', 10, 1600000, [['鳳凰羽', 1], ['靈芝', 20]], '不死祝福', 'energy_pct', 10, 12, '據說牠死了還會再回來'],
  ['獨角獸幼駒', '🦄', 'UR', 11, 2500000, [['獨角獸', 1], ['月光花', 20], ['星辰花', 5]], '純潔之光', 'luck_pct', 10, 12, '只親近心地乾淨的人'],
  ['三頭犬', '🐕‍🦺', 'UR', 11, 2800000, [['白狼', 5], ['黑豹', 5], ['幼龍', 1]], '地獄門衛', 'steal_resist_pct', 30, 12, '三顆頭輪班，從來沒有空隙'],
  ['星靈貓', '🌟', 'UR', 12, 4000000, [['隕石', 3], ['星辰礦', 20], ['月光木', 30]], '星辰眷顧', 'luck_pct', 12, 12, '傳說牠是從隕石裡走出來的']
];

// 逐隻檢查補齊（不是「有資料就整批跳過」）——
// 這樣之後新增品種時，既有伺服器也會自動補上，不必手動塞資料庫。
function seedPets(gid) {
  try {
    const has = db.prepare('SELECT 1 FROM pet_defs WHERE guild_id=? AND name=?');
    const ins = db.prepare(`INSERT INTO pet_defs
      (guild_id,name,emoji,rarity,min_level,price,materials,skill_name,buff_type,buff_pct,feed_hours,description,sort)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    db.transaction(() => {
      SEED_PETS.forEach(([name, emoji, rar, lv, price, mats, skill, bt, bp, fh, desc], idx) => {
        if (has.get(gid, name)) return;
        ins.run(gid, name, emoji, rar, lv, price, JSON.stringify(mats.map(([item, count]) => ({ item, count }))), skill, bt, bp, fh, desc, idx);
      });
    })();
  } catch (e) { logError(gid, '寵物預設建立失敗：', e.message); }
}

const petsOf = (gid, uid) => db.prepare(
  `SELECT o.*, p.name, p.emoji, p.rarity, p.skill_name, p.buff_type, p.buff_pct, p.feed_hours
     FROM pet_owned o JOIN pet_defs p ON p.id=o.pet_id
    WHERE o.guild_id=? AND o.user_id=? ORDER BY o.id`).all(gid, uid);
const petCap = (gid, uid, uname) => {
  const def = levelDef(gid, homeOf(gid, uid, uname).level);
  return def ? def.pet_cap : 0;
};
// 幾顆心（0~5），純顯示用
const hearts = (n) => '❤️'.repeat(Math.floor(n / 20)) + '🤍'.repeat(5 - Math.floor(n / 20));
// 餓了沒：超過餵食間隔就開始掉親密度
function decay(gid, uid) {
  const now = Date.now();
  for (const p of petsOf(gid, uid)) {
    if (!p.fed_ms) continue;
    const hrs = (now - p.fed_ms) / 3600000;
    const over = hrs - p.feed_hours;
    if (over <= 0) continue;
    // 每超過一個餵食週期掉 5 點親密度，最多掉到 0
    const lose = Math.floor(over / p.feed_hours) * 5;
    if (lose > 0) db.prepare('UPDATE pet_owned SET intimacy = MAX(0, intimacy - ?), fed_ms = ? WHERE id=?')
      .run(lose, now - p.feed_hours * 3600000, p.id);
  }
}

function adoptPet(gid, uid, uname, petId) {
  const p = db.prepare('SELECT * FROM pet_defs WHERE guild_id=? AND id=? AND enabled=1').get(gid, petId);
  if (!p) return { error: '找不到這隻寵物。' };
  const home = homeOf(gid, uid, uname);
  if (home.level < p.min_level) return { error: `${p.name} 需要家園 **Lv.${p.min_level}**（你現在 Lv.${home.level}）才養得起。` };
  const cap = petCap(gid, uid, uname);
  const have = petsOf(gid, uid).length;
  if (have >= cap) return { error: cap <= 0
    ? '你的房子還不能養寵物，需要家園 **Lv.3 鄉間住宅**。'
    : `你的家最多養 ${cap} 隻（已經有 ${have} 隻）。小屋塞不下那麼多寵物 —— 想多養就去 \`/升級家園\`。` };
  if (!p.price) return { error: `${p.name} 不販售，要靠特殊管道才能取得。` };
  const gc = gcfg(gid);
  const coins = wallet(gid, uid, uname).coins;
  const mats = parseMats(p.materials);
  const missing = [];
  if (coins < p.price) missing.push(`${money(gc, p.price)}（你有 ${coins.toLocaleString('en-US')}）`);
  for (const m of mats) { const h = bagCount(gid, uid, m.item); if (h < m.count) missing.push(`${m.item} ×${m.count}（你有 ${h}）`); }
  if (missing.length) return { error: `還差：\n🔴 ${missing.join('\n🔴 ')}` };
  const personality = PERSONALITIES[Math.floor(Math.random() * PERSONALITIES.length)];
  db.transaction(() => {
    addCoins(gid, uid, uname, -p.price);
    takeItems(gid, uid, mats);
    db.prepare('INSERT INTO pet_owned (guild_id,user_id,pet_id,nickname,level,exp,intimacy,personality,fed_ms) VALUES (?,?,?,?,1,0,20,?,?)')
      .run(gid, uid, p.id, '', personality, Date.now());
  })();
  markSeen(gid, uid, 'pet', p.name);
  return { adopted: p, personality };
}

/** 餵食：親密度 +，等級經驗 +。餵過就要等一個週期，不能狂點。 */
function feedPet(gid, uid, ownedId) {
  const p = db.prepare(
    `SELECT o.*, d.name, d.emoji, d.feed_hours FROM pet_owned o JOIN pet_defs d ON d.id=o.pet_id
      WHERE o.guild_id=? AND o.user_id=? AND o.id=?`).get(gid, uid, ownedId);
  if (!p) return { error: '找不到這隻寵物。' };
  const now = Date.now();
  const wait = p.fed_ms + p.feed_hours * 3600000 / 2;   // 半個週期就能再餵一次
  if (now < wait) return { error: `${p.emoji || ''}${p.nickname || p.name} 現在還不餓，${Math.ceil((wait - now) / 60000)} 分鐘後再來。` };
  const gain = 8 + Math.floor(Math.random() * 5);
  const exp = p.exp + 10;
  const lvUp = exp >= p.level * 100;
  bumpAch(gid, uid, 'feed_count', 1);
  db.prepare('UPDATE pet_owned SET intimacy = MIN(100, intimacy + ?), exp = ?, level = ?, fed_ms = ? WHERE id=?')
    .run(gain, lvUp ? 0 : exp, lvUp ? p.level + 1 : p.level, now, p.id);
  return { fed: p, gain, lvUp };
}

function renamePet(gid, uid, ownedId, nickname) {
  const p = db.prepare('SELECT * FROM pet_owned WHERE guild_id=? AND user_id=? AND id=?').get(gid, uid, ownedId);
  if (!p) return { error: '找不到這隻寵物。' };
  db.prepare('UPDATE pet_owned SET nickname=? WHERE id=?').run(String(nickname).slice(0, 20), p.id);
  return { ok: true };
}

function petPanel(gid, uid, uname) {
  decay(gid, uid);
  const list = petsOf(gid, uid);
  const cap = petCap(gid, uid, uname);
  const home = homeOf(gid, uid, uname);
  const embed = new EmbedBuilder().setColor(brandColor()).setTitle('🐾 寵物')
    .setDescription(cap <= 0
      ? '你的房子還不能養寵物，需要家園 **Lv.3 鄉間住宅**。'
      : `可養 **${list.length} / ${cap}** 隻（由房屋階級決定）。\n寵物**不會生蛋生奶** —— 牠給的是技能加成，而且加成按親密度比例給，不餵就沒效果。`)
    .setFooter({ text: '房屋越大養越多隻；親密度掉到 0 技能就完全失效' });
  for (const p of list.slice(0, 8)) {
    const pct = Math.floor(p.buff_pct * p.intimacy / 100);
    embed.addFields({
      name: `${RARITY[p.rarity] || ''}${p.emoji || ''}${p.nickname || p.name}　Lv.${p.level}`,
      value: `${hearts(p.intimacy)} ${p.intimacy}/100　個性：${p.personality}\n技能「${p.skill_name}」→ ${BUFF_TYPES[p.buff_type] || ''} **+${pct}%**（滿親密 ${p.buff_pct}%）`,
      inline: false
    });
  }
  const rows = [NAV('pet')];
  if (list.length) rows.push(new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('petfeed').setPlaceholder('餵食一隻寵物')
      .addOptions(list.slice(0, 25).map(p => ({
        label: `${p.emoji || ''}${p.nickname || p.name}`.slice(0, 100),
        description: `親密度 ${p.intimacy}/100　Lv.${p.level}`.slice(0, 100),
        value: String(p.id)
      })))));
  const shop = db.prepare('SELECT * FROM pet_defs WHERE guild_id=? AND enabled=1 AND price>0 AND min_level<=? ORDER BY sort').all(gid, home.level);
  if (shop.length && list.length < cap) rows.push(new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('petadopt').setPlaceholder('領養一隻新寵物')
      .addOptions(shop.slice(0, 25).map(p => ({
        label: `${RARITY[p.rarity] || ''}${p.emoji || ''}${p.name}`.slice(0, 100),
        description: `${p.price.toLocaleString('en-US')}｜${p.skill_name}　${BUFF_TYPES[p.buff_type] || ''}+${p.buff_pct}%`.slice(0, 100),
        value: String(p.id)
      })))));
  return { embeds: [embed], components: rows };
}

function init(client) {
  for (const [gid] of client.guilds.cache) {
    try { seedHome(gid); seedPets(gid); } catch (e) { logError(gid, '寵物初始化失敗：', e.message); }
  }
  client.on('interactionCreate', async (i) => {
    try {
      if (!i.guildId) return;
      const gid = i.guildId, uid = i.user.id, uname = i.user.username;
      const eph = { flags: MessageFlags.Ephemeral };
      if (i.isStringSelectMenu() && i.customId === 'petadopt') {
        const out = adoptPet(gid, uid, uname, parseInt(i.values[0], 10));
        if (out.error) return i.reply({ content: out.error, ...eph }).catch(() => {});
        await i.update(petPanel(gid, uid, uname)).catch(() => {});
        return i.followUp({ content: `🎉 ${out.adopted.emoji || ''}**${out.adopted.name}** 住進你家了！個性是「${out.personality}」。\n用 \`/寵物改名\` 幫牠取個名字，記得常餵 —— 親密度掉了技能就沒效果。`, ...eph }).catch(() => {});
      }
      if (i.isStringSelectMenu() && i.customId === 'petfeed') {
        const out = feedPet(gid, uid, parseInt(i.values[0], 10));
        if (out.error) return i.reply({ content: out.error, ...eph }).catch(() => {});
        await i.update(petPanel(gid, uid, uname)).catch(() => {});
        return i.followUp({ content: `🍖 你餵了 ${out.fed.emoji || ''}**${out.fed.nickname || out.fed.name}**，親密度 +${out.gain}${out.lvUp ? `\n🎉 而且升級了！` : ''}`, ...eph }).catch(() => {});
      }
      if (i.isChatInputCommand() && i.commandName === '寵物') {
        seedPets(gid);
        return i.reply({ ...petPanel(gid, uid, uname), ...eph }).catch(() => {});
      }
      if (i.isChatInputCommand() && i.commandName === '寵物改名') {
        const list = petsOf(gid, uid);
        if (!list.length) return i.reply({ content: '你還沒有寵物。', ...eph }).catch(() => {});
        const nick = i.options.getString('名字');
        const target = list.find(p => (p.nickname || p.name) === i.options.getString('寵物')) || list[0];
        renamePet(gid, uid, target.id, nick);
        return i.reply({ content: `✅ 牠現在叫做 **${nick}** 了。`, ...eph }).catch(() => {});
      }
    } catch (e) {
      logError(i.guildId, '寵物指令失敗：', e.message);
      const msg = { content: '執行失敗，管理員可到後台的系統錯誤紀錄查看原因。', flags: MessageFlags.Ephemeral };
      if (i.replied || i.deferred) await i.followUp(msg).catch(() => {}); else await i.reply(msg).catch(() => {});
    }
  });
  console.log('  ↳ 寵物模組已載入（20 種寵物／親密度／技能加成）');
}

module.exports = { init, seedPets, petPanel, petsOf };
