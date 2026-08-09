// 設施商店：用星幣買農地／溫室／牧場／孵化室的「等級」。
// 等級的意思跟工具一樣 —— 買高階會取代低階，總格數以最高階為準（不是一階一階累加）。
// 跟 /製作 的「蓋牧場」「開闢農地」並存：兩邊的格數會相加，沒錢的人照樣能靠材料慢慢開。
const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, MessageFlags } = require('discord.js');
const { db, guildConfig, logError } = require('../../db');
const { brandColor } = require('../../util/brand');
const { wallet, menuResult } = require('./gather');

const gcfg = (gid) => guildConfig('gather_config', gid);
const csv = (s) => String(s || '').split(/[\n,]/).map(x => x.trim()).filter(Boolean);
const money = (c, n) => `${c.currency_emoji || '🪙'} ${Number(n).toLocaleString('en-US')} ${c.currency_name || '星幣'}`;

// 四種設施：type → [顯示名, emoji, 對應的指令說明]
const TYPES = {
  field:      { name: '農地',   emoji: '🌾', hint: '種蔬果，用 `/農地` 查看、`/種植` 下種' },
  greenhouse: { name: '溫室',   emoji: '🏡', hint: '種花卉，用 `/溫室` 查看、`/種植` 下種' },
  ranch:      { name: '牧場',   emoji: '🐔', hint: '養動物，用 `/畜牧商店` 買、`/牧場` 查看' },
  hatch:      { name: '孵化室', emoji: '🥚', hint: '孵蛋成動物，用 `/孵化` 放蛋、`/孵化室` 領取' },
  aquarium:   { name: '魚缸',   emoji: '🐠', hint: '養 SSR 魚生星幣，用 `/水族商店` 買魚、`/魚缸` 查看' }
};
const TYPE_KEYS = Object.keys(TYPES);
// 每種設施一個顏色，跟一般商店的分類色系一致
const TYPE_COLOR = { field: 0xf1c40f, greenhouse: 0x1abc9c, ranch: 0xe91e63, hatch: 0x9b59b6, aquarium: 0x3498db };

// 預設階級：[type, tier, 名稱, emoji, 售價, 總格數, 說明, 加速%, 防竊%]
// 加速＝作物成熟／動物產出／孵蛋的時間縮短 %；防竊只有牧場用得到。
const SEED_FACILITIES = [
  ['field', 1, '小塊農地', '🌱', 4000, 2, '入門的兩畦田', 0, 0],
  ['field', 2, '農莊田地', '🌾', 16000, 4, '擴成四畦，作物成熟快 10%', 10, 0],
  ['field', 3, '豐收莊園', '🚜', 50000, 8, '八畦大田，作物成熟快 25%', 25, 0],
  ['greenhouse', 1, '簡易溫室', '🪴', 7000, 2, '兩格花房，開始種花卉', 0, 0],
  ['greenhouse', 2, '玻璃溫室', '🏡', 24000, 4, '四格花房，花卉成熟快 10%', 10, 0],
  ['greenhouse', 3, '植物園', '🌺', 65000, 8, '八格花房，花卉成熟快 25%', 25, 0],
  ['ranch', 1, '小牧場', '🏕️', 5000, 2, '兩格畜舍', 0, 0],
  ['ranch', 2, '家庭牧場', '🏠', 18000, 4, '四格畜舍，產出快 10%、被偷成功率 -10%', 10, 10],
  ['ranch', 3, '大牧場', '🏰', 55000, 8, '八格畜舍，產出快 25%、被偷成功率 -25%', 25, 25],
  ['hatch', 1, '小孵化箱', '🧺', 3500, 1, '一次孵一顆蛋', 0, 0],
  ['hatch', 2, '孵化室', '🥚', 13000, 2, '同時孵兩顆，孵化快 10%', 10, 0],
  ['hatch', 3, '育種中心', '🐣', 40000, 4, '同時孵四顆，孵化快 25%', 25, 0],
  // 魚缸：價格與格數比照農地；resist＝被偷魚成功率下降
  ['aquarium', 1, '小魚缸', '🐟', 4000, 2, '兩格魚缸，開始養 SSR 魚', 0, 0],
  ['aquarium', 2, '玻璃水族箱', '🐠', 16000, 4, '四格，被偷魚成功率 -10%', 0, 10],
  ['aquarium', 3, '大型水族館', '🐋', 50000, 8, '八格，被偷魚成功率 -25%', 0, 25]
];

function seedFacilities(gid) {
  try {
    const has = db.prepare('SELECT 1 FROM facility_defs WHERE guild_id=? AND type=? AND tier=?');
    const ins = db.prepare(
      'INSERT INTO facility_defs (guild_id,type,tier,name,emoji,price,slots,description,sort,speed_pct,resist_pct) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    const tx = db.transaction(() => {
      SEED_FACILITIES.forEach((f, idx) => {
        const [type, tier, name, emoji, price, slots, desc, speed = 0, resist = 0] = f;
        if (has.get(gid, type, tier)) return;
        ins.run(gid, type, tier, name, emoji, price, slots, desc, idx, speed, resist);
      });
    });
    tx();
  } catch (e) { logError(gid, '設施預設建立失敗：', e.message); }
}

// 玩家買到的設施格數（沒買回 0）。牧場/農地/溫室/孵化室的容量計算都會加上這個。
function facilitySlots(gid, uid, type) {
  const row = db.prepare('SELECT slots FROM facility_owned WHERE guild_id=? AND user_id=? AND type=?').get(gid, uid, type);
  return row ? row.slots : 0;
}
// 玩家目前設施提供的加成：{ speed, resist }（沒買回 0）
function facilityBonus(gid, uid, type) {
  const row = db.prepare('SELECT speed_pct, resist_pct FROM facility_owned WHERE guild_id=? AND user_id=? AND type=?').get(gid, uid, type);
  return { speed: row ? row.speed_pct : 0, resist: row ? row.resist_pct : 0 };
}
// 把一段時間套上加速％（最多縮到 10%，避免設成 100% 直接變 0 秒）
const applySpeed = (ms, speedPct) => Math.max(Math.round(ms * 0.1), Math.round(ms * (1 - Math.min(90, Math.max(0, speedPct)) / 100)));

const ownedTier = (gid, uid, type) =>
  (db.prepare('SELECT tier FROM facility_owned WHERE guild_id=? AND user_id=? AND type=?').get(gid, uid, type) || {}).tier || 0;
const defsOf = (gid, type) =>
  db.prepare('SELECT * FROM facility_defs WHERE guild_id=? AND type=? AND enabled=1 ORDER BY tier').all(gid, type);

function shopEmbeds(gid, uid, gc) {
  const w = wallet(gid, uid, '');
  const embeds = [new EmbedBuilder().setColor(brandColor()).setTitle('🏗️ 設施商店')
    .setDescription('買**等級**來擴充格數。買高階會直接取代低階（總格數以最高階為準，不是疊加），所以想省錢可以一次攻頂。\n' +
      '`/製作` 蓋出來的格子會**另外相加**，兩條路並行。\n' +
      `你的餘額：**${w.coins.toLocaleString('en-US')} ${gc.currency_name}**`)];
  for (const type of TYPE_KEYS) {
    const defs = defsOf(gid, type);
    if (!defs.length) continue;
    const cur = ownedTier(gid, uid, type);
    const t = TYPES[type];
    const lines = defs.map(d => {
      const buffs = [];
      if (d.speed_pct) buffs.push(`⏩ 時間 -${d.speed_pct}%`);
      if (d.resist_pct) buffs.push(`🛡️ 被偷成功率 -${d.resist_pct}%`);
      return `${d.tier <= cur ? '✅' : '　'} ${d.emoji || ''}**${d.name}**（${d.tier} 階）　${money(gc, d.price)}　→ 共 ${d.slots} 格` +
        `${buffs.length ? `　${buffs.join('　')}` : ''}${d.description ? `\n　　${d.description}` : ''}`;
    });
    embeds.push(new EmbedBuilder().setColor(TYPE_COLOR[type] || brandColor())
      .setTitle(`${t.emoji} ${t.name}${cur ? `（目前 ${cur} 階）` : '（尚未擁有）'}`)
      .setDescription(lines.join('\n').slice(0, 4000)));
  }
  return embeds;
}

function shopMenu(gid, uid, gc) {
  const opts = [];
  for (const type of TYPE_KEYS) {
    const cur = ownedTier(gid, uid, type);
    for (const d of defsOf(gid, type)) {
      if (d.tier <= cur) continue;                     // 已擁有同階或更高階就不再列出
      opts.push({
        label: `${TYPES[type].name}：${d.name}（${d.tier} 階，共 ${d.slots} 格）`.slice(0, 100),
        description: `${d.price.toLocaleString('en-US')} ${gc.currency_name}`.slice(0, 100),
        value: String(d.id),
        emoji: d.emoji || TYPES[type].emoji
      });
    }
  }
  if (!opts.length) return null;
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('facbuy').setPlaceholder('選擇要購買的設施等級').addOptions(opts.slice(0, 25)));
}

function buy(gid, uid, uname, defId) {
  const d = db.prepare('SELECT * FROM facility_defs WHERE guild_id=? AND id=? AND enabled=1').get(gid, defId);
  if (!d) return { error: '這個設施已經不存在了。' };
  const cur = ownedTier(gid, uid, d.type);
  if (d.tier <= cur) return { error: `你已經有 ${cur} 階的${TYPES[d.type].name}了，只能往上升級。` };
  const w = wallet(gid, uid, uname);
  const gc = gcfg(gid);
  if (w.coins < d.price) {
    return { error: `${gc.currency_name}不夠：需要 ${d.price.toLocaleString('en-US')}，你只有 ${w.coins.toLocaleString('en-US')}。` };
  }
  const tx = db.transaction(() => {
    db.prepare('UPDATE econ_wallets SET coins = coins - ? WHERE guild_id=? AND user_id=?').run(d.price, gid, uid);
    db.prepare(
      `INSERT INTO facility_owned (guild_id,user_id,type,tier,slots,speed_pct,resist_pct) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(guild_id,user_id,type) DO UPDATE SET tier=excluded.tier, slots=excluded.slots,
         speed_pct=excluded.speed_pct, resist_pct=excluded.resist_pct, bought_at=datetime('now','localtime')`
    ).run(gid, uid, d.type, d.tier, d.slots, d.speed_pct, d.resist_pct);
  });
  tx();
  return { def: d, prevTier: cur, coins: wallet(gid, uid, uname).coins };
}

function init(client) {
  for (const [gid] of client.guilds.cache) {
    try { seedFacilities(gid); } catch (e) { logError(gid, '設施初始化失敗：', e.message); }
  }

  client.on('interactionCreate', async (i) => {
    const isBtn = i.isButton() && i.customId === 'adv:facility';
    const isMenu = i.isStringSelectMenu() && i.customId === 'facbuy';
    const isCmd = i.isChatInputCommand() && i.commandName === '設施商店';
    if (!isBtn && !isMenu && !isCmd) return;
    const gid = i.guildId;
    if (!gid) return i.reply({ content: '這個指令只能在伺服器裡使用。', flags: MessageFlags.Ephemeral });
    try {
      seedFacilities(gid);
      const gc = gcfg(gid);
      if (!gc.enabled) return i.reply({ content: '冒險系統目前停用中。', flags: MessageFlags.Ephemeral });
      // 沿用冒險區的頻道限制
      const allowed = csv(gc.channels);
      if (allowed.length && !allowed.includes(i.channelId)) {
        return i.reply({ content: `這個指令只能在 ${allowed.map(id => `<#${id}>`).join('、')} 使用。`, flags: MessageFlags.Ephemeral });
      }
      const uid = i.user.id, uname = i.user.username;

      if (isMenu) {
        const r = buy(gid, uid, uname, parseInt(i.values[0], 10));
        if (!r.error) {
          const t = TYPES[r.def.type];
          r.embed = new EmbedBuilder().setColor(brandColor()).setTitle('🏗️ 擴建完成！')
            .setDescription(`${r.def.emoji || t.emoji} **${r.def.name}**（${r.def.tier} 階）蓋好了！\n` +
              `${t.emoji} ${t.name}現在共 **${r.def.slots} 格**${r.prevTier ? `（原本 ${r.prevTier} 階）` : ''}。` +
              `${r.def.speed_pct ? `\n⏩ ${r.def.type === 'hatch' ? '孵化' : r.def.type === 'ranch' ? '產出' : '成熟'}時間 **-${r.def.speed_pct}%**` : ''}` +
              `${r.def.resist_pct ? `\n🛡️ 別人來偷你的成功率 **-${r.def.resist_pct}%**` : ''}\n${t.hint}`)
            .setFooter({ text: `餘額 ${r.coins.toLocaleString('en-US')} ${gc.currency_name}` });
        }
        return menuResult(i, r);
      }

      const embeds = shopEmbeds(gid, uid, gc);
      const row = shopMenu(gid, uid, gc);
      return i.reply({
        embeds: embeds.slice(0, 10),
        components: row ? [row] : [],
        content: row ? undefined : '你已經買到每一種設施的最高階了，沒有東西可以再升級。',
        flags: MessageFlags.Ephemeral
      });
    } catch (e) {
      logError(gid, '設施商店失敗：', e.message);
      if (!i.replied && !i.deferred) {
        await i.reply({ content: '執行失敗，管理員可到後台的系統錯誤紀錄查看原因。', flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  });
  console.log('  ↳ 設施商店已載入（農地/溫室/牧場/孵化室 分階購買）');
}

module.exports = { init, facilitySlots, facilityBonus, applySpeed, buy, defsOf, TYPE_KEYS, seedFacilities, TYPES };
