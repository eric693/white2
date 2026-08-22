// 角色好感度／約會。
//
// 角色不另外建檔 —— 直接沿用轉盤的 wheel_roles（你們已經有數百位角色，含頭像、台詞、作者）。
// 玩家用名字搜尋邀請（自動完成），送禮消耗農產／魚／料理／寶石，好感度升級解鎖稱號。
//
// 這是整條經濟鏈的終點：以前農產品唯一的用途是「賣掉換錢」，現在有了送禮才真的有意義。
const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { db, guildConfig, logError } = require('../../db');
const { bump: bumpAch } = require('../../util/achievements');
const { brandColor } = require('../../util/brand');
const { absUrl } = require('../../util/url');
const { localToday } = require('../../util/time');
const { buffPct } = require('../../util/buffs');
const { seedHome, homeOf, levelDef, NAV } = require('./home');
const { markSeen } = require('./dex');
const { QUALITY } = require('./kitchen');

const hcfg = (gid) => guildConfig('home_config', gid);
const gcfg = (gid) => guildConfig('gather_config', gid);

// 好感度階級（管理員可在後台改名稱與門檻）
const SEED_LEVELS = [
  [1, '點頭之交', 100, ''],
  [2, '有點熟', 300, ''],
  [3, '朋友', 700, ''],
  [4, '好朋友', 1400, ''],
  [5, '知己', 2500, ''],
  [6, '曖昧', 4200, ''],
  [7, '心動', 6500, ''],
  [8, '戀人', 10000, ''],
  [9, '深愛', 15000, ''],
  [10, '此生唯一', 25000, '']
];

function seedAffinity(gid) {
  try {
    if (db.prepare('SELECT 1 FROM affinity_levels WHERE guild_id=? LIMIT 1').get(gid)) return;
    const ins = db.prepare('INSERT INTO affinity_levels (guild_id,level,name,need,reward) VALUES (?,?,?,?,?)');
    db.transaction(() => { for (const [lv, name, need, reward] of SEED_LEVELS) ins.run(gid, lv, name, need, reward); })();
  } catch (e) { logError(gid, '好感度階級建立失敗：', e.message); }
}


// 工藝禮物的預設喜好：木雕與花束是「專門做來送人的東西」，所以每位角色都特別喜歡。
// 走逐筆補齊（新角色加進轉盤後也會自動有），管理員之後想單獨調某個角色照樣蓋得過去。
const CRAFT_GIFTS = [
  ['木雕小鹿', 200], ['櫻花木梳', 220], ['檜木香盒', 240],
  ['四季花束', 260], ['星光花冠', 300], ['神木護符', 300]
];
function seedGiftPrefs(gid) {
  try {
    const roles = db.prepare('SELECT id FROM wheel_roles WHERE guild_id=? AND enabled=1').all(gid);
    if (!roles.length) return;
    const has = db.prepare('SELECT 1 FROM affinity_prefs WHERE guild_id=? AND role_id=? AND item=?');
    const ins = db.prepare('INSERT INTO affinity_prefs (guild_id,role_id,item,weight) VALUES (?,?,?,?)');
    db.transaction(() => {
      for (const r of roles) {
        for (const [item, weight] of CRAFT_GIFTS) {
          if (has.get(gid, r.id, item)) continue;
          ins.run(gid, r.id, item, weight);
        }
      }
    })();
  } catch (e) { logError(gid, '禮物喜好建立失敗：', e.message); }
}

const levelsOf = (gid) => db.prepare('SELECT * FROM affinity_levels WHERE guild_id=? ORDER BY level').all(gid);
const levelName = (gid, lv) => (db.prepare('SELECT name FROM affinity_levels WHERE guild_id=? AND level=?').get(gid, lv) || {}).name || '陌生人';
const roleOf = (gid, rid) => db.prepare('SELECT * FROM wheel_roles WHERE guild_id=? AND id=? AND enabled=1').get(gid, rid);
const affOf = (gid, uid, rid) => db.prepare('SELECT * FROM affinity WHERE guild_id=? AND user_id=? AND role_id=?').get(gid, uid, rid)
  || { points: 0, level: 0, visits: 0, gift_day: '', gift_count: 0 };

/** 依點數重算階級，回傳有沒有升級 */
function recalcLevel(gid, uid, rid) {
  const a = affOf(gid, uid, rid);
  const lvs = levelsOf(gid);
  let lv = 0;
  for (const l of lvs) if (a.points >= l.need) lv = l.level;
  if (lv !== a.level) {
    db.prepare('UPDATE affinity SET level=? WHERE guild_id=? AND user_id=? AND role_id=?').run(lv, gid, uid, rid);
    return { up: lv > a.level, level: lv };
  }
  return { up: false, level: lv };
}

/**
 * 送禮加多少好感。
 * 有設喜好就吃 affinity_prefs 的權重（300＝最愛、100＝普通、-100＝討厭），
 * 沒設的角色一律用普通權重 —— 這樣管理員可以只幫重點角色設喜好，其他角色照樣能玩。
 */
function giftWeight(gid, rid, itemName) {
  const p = db.prepare('SELECT weight FROM affinity_prefs WHERE guild_id=? AND role_id=? AND item=?').get(gid, rid, itemName);
  return p ? p.weight : 100;
}

/** 送一份背包物品 */
function giftItem(gid, uid, uname, rid, itemId) {
  const role = roleOf(gid, rid);
  if (!role) return { error: '找不到這位角色。' };
  const c = hcfg(gid);
  const today = localToday();
  const a = affOf(gid, uid, rid);
  const used = a.gift_day === today ? a.gift_count : 0;
  if (used >= c.gift_daily_limit) return { error: `你今天送給 **${role.name}** 的禮物已經夠多了（每日 ${c.gift_daily_limit} 次）。明天再來。` };

  const inv = db.prepare(
    `SELECT v.count, it.name, it.emoji, it.price FROM gather_inventory v JOIN gather_items it ON it.id=v.item_id
      WHERE v.guild_id=? AND v.user_id=? AND v.item_id=? AND v.count>0`).get(gid, uid, itemId);
  if (!inv) return { error: '你沒有這個物品。' };

  const weight = giftWeight(gid, rid, inv.name);
  // 好感＝物品價值開根號（避免高價物品直接爆表）× 喜好權重 × 送禮加成
  const base = Math.max(1, Math.round(Math.sqrt(inv.price) * 3));
  const gain = Math.round(base * weight / 100 * (1 + buffPct(gid, uid, 'gift_pct') / 100));

  db.transaction(() => {
    db.prepare('UPDATE gather_inventory SET count = count - 1 WHERE guild_id=? AND user_id=? AND item_id=?').run(gid, uid, itemId);
    db.prepare(`INSERT INTO affinity (guild_id,user_id,role_id,points,level,gift_day,gift_count) VALUES (?,?,?,?,0,?,1)
      ON CONFLICT(guild_id,user_id,role_id) DO UPDATE SET
        points = MAX(0, points + ?), gift_day = ?, gift_count = CASE WHEN gift_day = ? THEN gift_count + 1 ELSE 1 END`)
      .run(gid, uid, rid, Math.max(0, gain), today, gain, today, today);
  })();
  bumpAch(gid, uid, 'gift_count', 1);
  const lv = recalcLevel(gid, uid, rid);
  markSeen(gid, uid, 'role', role.name);
  return { role, item: inv, gain, weight, ...lv };
}

/** 送一份料理（料理的好感吃品質倍率，這是烹飪最主要的價值） */
function giftDish(gid, uid, uname, rid, recipeId, quality) {
  const role = roleOf(gid, rid);
  if (!role) return { error: '找不到這位角色。' };
  const c = hcfg(gid);
  const today = localToday();
  const a = affOf(gid, uid, rid);
  const used = a.gift_day === today ? a.gift_count : 0;
  if (used >= c.gift_daily_limit) return { error: `你今天送給 **${role.name}** 的禮物已經夠多了（每日 ${c.gift_daily_limit} 次）。` };

  const row = db.prepare('SELECT count FROM cook_inventory WHERE guild_id=? AND user_id=? AND recipe_id=? AND quality=?').get(gid, uid, recipeId, quality);
  if (!row || row.count <= 0) return { error: '你沒有這份料理。' };
  const r = db.prepare('SELECT * FROM cook_recipes WHERE guild_id=? AND id=?').get(gid, recipeId);
  const weight = giftWeight(gid, rid, r.name);
  const gain = Math.round(r.affinity_base * QUALITY[quality].aff * weight / 100 * (1 + buffPct(gid, uid, 'gift_pct') / 100));

  db.transaction(() => {
    db.prepare('UPDATE cook_inventory SET count = count - 1 WHERE guild_id=? AND user_id=? AND recipe_id=? AND quality=?').run(gid, uid, recipeId, quality);
    db.prepare(`INSERT INTO affinity (guild_id,user_id,role_id,points,level,gift_day,gift_count) VALUES (?,?,?,?,0,?,1)
      ON CONFLICT(guild_id,user_id,role_id) DO UPDATE SET
        points = MAX(0, points + ?), gift_day = ?, gift_count = CASE WHEN gift_day = ? THEN gift_count + 1 ELSE 1 END`)
      .run(gid, uid, rid, Math.max(0, gain), today, gain, today, today);
  })();
  const lv = recalcLevel(gid, uid, rid);
  markSeen(gid, uid, 'role', role.name);
  return { role, dish: r, quality, gain, weight, ...lv };
}

/** 邀請角色來家裡（需要房屋 Lv.6，成功率受家園加成影響） */
function inviteRole(gid, uid, uname, rid) {
  const role = roleOf(gid, rid);
  if (!role) return { error: '找不到這位角色。' };
  const c = hcfg(gid);
  if (!c.visit_enabled) return { error: '目前沒有開放邀請角色來訪。' };
  const home = homeOf(gid, uid, uname);
  const def = levelDef(gid, home.level);
  if (!def || !def.visit_ok) return { error: `你的家還太簡陋，角色不好意思來。需要家園 **Lv.6 花園別墅**（你現在 Lv.${home.level}）。` };
  const a = affOf(gid, uid, rid);
  const today = localToday();
  if (a.last_visit === today) return { error: `**${role.name}** 今天已經來過你家了。` };

  // 成功率：好感度階級越高越願意來，再加上家園的 visit_pct 加成
  const chance = Math.min(95, 25 + a.level * 7 + buffPct(gid, uid, 'visit_pct'));
  const ok = Math.random() * 100 < chance;
  db.prepare(`INSERT INTO affinity (guild_id,user_id,role_id,points,level,visits,last_visit) VALUES (?,?,?,0,0,?,?)
    ON CONFLICT(guild_id,user_id,role_id) DO UPDATE SET visits = visits + ?, last_visit = ?`)
    .run(gid, uid, rid, ok ? 1 : 0, today, ok ? 1 : 0, today);
  if (!ok) return { role, refused: true, chance };

  // 來訪本身也給好感（比送禮少，但穩定）
  const gain = 20 + a.level * 5;
  db.prepare('UPDATE affinity SET points = points + ? WHERE guild_id=? AND user_id=? AND role_id=?').run(gain, gid, uid, rid);
  const lv = recalcLevel(gid, uid, rid);
  markSeen(gid, uid, 'role', role.name);
  return { role, gain, chance, ...lv };
}

// ---- 面板 ----
function lovePanel(gid, uid, uname) {
  const home = homeOf(gid, uid, uname);
  const def = levelDef(gid, home.level);
  const list = db.prepare(
    `SELECT a.*, r.name, r.author FROM affinity a JOIN wheel_roles r ON r.id=a.role_id
      WHERE a.guild_id=? AND a.user_id=? AND a.points>0 ORDER BY a.points DESC LIMIT 15`).all(gid, uid);
  const total = db.prepare('SELECT COUNT(*) n FROM wheel_roles WHERE guild_id=? AND enabled=1').get(gid).n;
  const embed = new EmbedBuilder().setColor(0xeb459e).setTitle('💕 好感度')
    .setDescription(
      `這個伺服器有 **${total}** 位角色可以攻略。用 \`/送禮\` 送東西、\`/邀請\` 請他來家裡。\n` +
      (def && def.visit_ok ? '你的家已經夠體面，角色願意來作客了。' : `角色來訪需要家園 **Lv.6 花園別墅**（你現在 Lv.${home.level}）。`))
    .setFooter({ text: '送禮好感受角色喜好影響；料理的品質越高，好感加得越多' });
  if (list.length) embed.addFields({
    name: '你的好感度',
    value: list.map(a => `**${a.name}**　${levelName(gid, a.level)}（Lv.${a.level}）　${a.points.toLocaleString('en-US')} 點${a.visits ? `　來訪 ${a.visits} 次` : ''}`).join('\n').slice(0, 1024)
  });
  else embed.addFields({ name: '你還沒有跟任何角色互動', value: '用 `/送禮 角色:名字` 開始 —— 打幾個字就會跳出候選名單。' });
  return {
    embeds: [embed],
    components: [NAV('love'), new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('strollpanel').setLabel('🛍️ 逛街（隨機遇到角色）').setStyle(ButtonStyle.Success))]
  };
}


// ================== 逛街：隨機遇到角色 ==================
//
// 你們有兩百多位角色，用「選單挑一位」永遠只會挑到那幾個熟面孔。
// 逛街改成消耗體力的隨機遇見：花 1 點體力出門，隨機碰到一位角色，
// 他會講自己的台詞（後台每位角色可設三句，隨機挑一句），並自動加一點好感度。
// 已經熟的角色權重會降低一點，讓沒見過的角色更容易冒出來 —— 這樣兩百多隻才真的都會出場。
const staminaRow = (gid, uid) => {
  const today = localToday();
  let row = db.prepare('SELECT * FROM stroll_stamina WHERE guild_id=? AND user_id=?').get(gid, uid);
  if (!row) {
    db.prepare('INSERT INTO stroll_stamina (guild_id,user_id,day,used,met) VALUES (?,?,?,0,0)').run(gid, uid, today);
    row = { guild_id: gid, user_id: uid, day: today, used: 0, met: 0 };
  }
  if (row.day !== today) {   // 跨日自動回滿
    db.prepare('UPDATE stroll_stamina SET day=?, used=0, met=0 WHERE guild_id=? AND user_id=?').run(today, gid, uid);
    row = { ...row, day: today, used: 0, met: 0 };
  }
  return row;
};

/** 今日體力上限：基礎值 ＋ 家具／寵物的「體力恢復」加成（終於讓 energy_pct 有實際用途） */
function staminaMax(gid, uid) {
  const c = hcfg(gid);
  const base = Math.max(1, c.stroll_stamina || 10);
  return base + Math.floor(base * buffPct(gid, uid, 'energy_pct') / 100);
}

/** 隨機挑一位角色：見過越多次的權重越低，讓沒遇過的優先出場 */
function pickRole(gid, uid) {
  const roles = db.prepare('SELECT id, name, image_url, intro, author, ad_line, ad_line2, ad_line3 FROM wheel_roles WHERE guild_id=? AND enabled=1').all(gid);
  if (!roles.length) return null;
  const met = new Map(db.prepare('SELECT role_id, points FROM affinity WHERE guild_id=? AND user_id=?').all(gid, uid)
    .map(r => [r.role_id, r.points]));
  const weighted = roles.map(r => {
    const p = met.get(r.id) || 0;
    // 沒遇過＝權重 10；已經很熟的降到 1（不會完全遇不到，只是機率低）
    const w = p <= 0 ? 10 : Math.max(1, 10 - Math.floor(Math.log10(p + 1) * 3));
    return { r, w };
  });
  const total = weighted.reduce((a, x) => a + x.w, 0);
  let n = Math.random() * total;
  for (const x of weighted) { n -= x.w; if (n <= 0) return x.r; }
  return weighted[weighted.length - 1].r;
}

const adLine = (r) => {
  const lines = [r.ad_line, r.ad_line2, r.ad_line3].filter(x => x && x.trim());
  if (!lines.length) return '';
  return lines[Math.floor(Math.random() * lines.length)];
};

/** 出門逛街一次 */
function stroll(gid, uid, uname) {
  const c = hcfg(gid);
  if (!c.stroll_enabled) return { error: '現在沒有開放逛街。' };
  const row = staminaRow(gid, uid);
  const max = staminaMax(gid, uid);
  const cost = Math.max(1, c.stroll_cost || 1);
  if (row.used + cost > max) {
    return { error: `體力不夠了（今天 ${row.used}/${max}）。明天就會回滿 —— 想要更多體力可以擺「體力恢復」的家具、養對應的寵物。` };
  }
  const role = pickRole(gid, uid);
  if (!role) return { error: '這個伺服器還沒有任何角色。' };

  const gain = Math.max(0, c.stroll_points || 3);
  const bonus = Math.floor(gain * buffPct(gid, uid, 'gift_pct') / 100);   // 送禮加成也吃在偶遇上
  const points = gain + bonus;
  const today = localToday();
  db.transaction(() => {
    db.prepare('UPDATE stroll_stamina SET used=used+?, met=met+1, day=? WHERE guild_id=? AND user_id=?')
      .run(cost, today, gid, uid);
    db.prepare(`INSERT INTO affinity (guild_id,user_id,role_id,points,level) VALUES (?,?,?,?,0)
      ON CONFLICT(guild_id,user_id,role_id) DO UPDATE SET points = points + ?`).run(gid, uid, role.id, points, points);
  })();
  const lv = recalcLevel(gid, uid, role.id);
  markSeen(gid, uid, 'role', role.name);
  bumpAch(gid, uid, 'stroll_count', 1);

  const after = staminaRow(gid, uid);
  return { role, points, lv, used: after.used, max, met: after.met, line: adLine(role) };
}

function strollEmbed(gid, uid, out) {
  const a = db.prepare('SELECT points, level FROM affinity WHERE guild_id=? AND user_id=? AND role_id=?').get(gid, uid, out.role.id) || { points: 0, level: 0 };
  const e = new EmbedBuilder().setColor(0xeb459e)
    .setTitle(`🛍️ 你在街上遇到了 ${out.role.name}`)
    .setDescription((out.line ? `💬 **「${out.line}」**\n\n` : '')
      + (out.role.intro ? `${String(out.role.intro).slice(0, 300)}\n\n` : '')
      + `好感度 **+${out.points}** → 目前 ${a.points.toLocaleString('en-US')} 點（${levelName(gid, a.level)}）`)
    .setFooter({ text: `體力 ${out.used}/${out.max}｜今天遇到 ${out.met} 位｜想加深關係就用 /送禮` });
  if (out.role.image_url) e.setThumbnail(absUrl(out.role.image_url));
  return e;
}

/** 逛街面板：一顆按鈕連續逛，體力用完為止 */
function strollPanel(gid, uid, uname) {
  const row = staminaRow(gid, uid);
  const max = staminaMax(gid, uid);
  const total = db.prepare('SELECT COUNT(*) n FROM wheel_roles WHERE guild_id=? AND enabled=1').get(gid).n;
  const seen = db.prepare('SELECT COUNT(*) n FROM affinity WHERE guild_id=? AND user_id=? AND points>0').get(gid, uid).n;
  const e = new EmbedBuilder().setColor(0xeb459e).setTitle('🛍️ 逛街')
    .setDescription(`出門走走，**隨機**遇到街上的角色 —— 遇到誰不能挑，這就是逛街的意義。\n`
      + `每次消耗 **${Math.max(1, hcfg(gid).stroll_cost || 1)}** 點體力，遇到就自動加好感度。`)
    .addFields(
      { name: '今日體力', value: `${max - row.used} / ${max}`, inline: true },
      { name: '今天遇到', value: `${row.met} 位`, inline: true },
      { name: '你認識的角色', value: `${seen} / ${total} 位`, inline: true })
    .setFooter({ text: '體力每天回滿；擺「體力恢復」家具或養對應寵物可以提高上限' });
  return {
    embeds: [e],
    components: [NAV('love'), new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('strollgo').setLabel('🛍️ 出門逛街').setStyle(ButtonStyle.Success)
        .setDisabled(row.used >= max))]
  };
}

/** 名字搜尋：這就是「上百隻角色可以挑名字邀請」的實作 */
function searchRoles(gid, q) {
  const kw = String(q || '').trim();
  const rows = kw
    ? db.prepare(`SELECT id, name, author FROM wheel_roles WHERE guild_id=? AND enabled=1 AND name LIKE ? ORDER BY draw_count DESC LIMIT 25`).all(gid, `%${kw}%`)
    : db.prepare(`SELECT id, name, author FROM wheel_roles WHERE guild_id=? AND enabled=1 ORDER BY draw_count DESC LIMIT 25`).all(gid);
  return rows.map(r => ({ name: `${r.name}${r.author ? `（${r.author}）` : ''}`.slice(0, 100), value: String(r.id) }));
}

function roleCard(gid, uid, role, extra) {
  const a = affOf(gid, uid, role.id);
  const lvs = levelsOf(gid);
  const next = lvs.find(l => l.level === a.level + 1);
  const embed = new EmbedBuilder().setColor(0xeb459e).setTitle(`💕 ${role.name}`)
    .setDescription(role.intro || ' ')
    .addFields(
      { name: '好感度', value: `${levelName(gid, a.level)}（Lv.${a.level}）`, inline: true },
      { name: '累積點數', value: a.points.toLocaleString('en-US'), inline: true },
      { name: '下一階', value: next ? `還差 ${(next.need - a.points).toLocaleString('en-US')} 點` : '已滿', inline: true });
  if (role.image_url) embed.setThumbnail(absUrl(role.image_url));
  if (extra) embed.addFields({ name: '　', value: extra });
  return embed;
}

function init(client) {
  for (const [gid] of client.guilds.cache) { try { seedGiftPrefs(gid); } catch {} }
  for (const [gid] of client.guilds.cache) {
    try { seedHome(gid); seedAffinity(gid); } catch (e) { logError(gid, '好感度初始化失敗：', e.message); }
  }
  client.on('interactionCreate', async (i) => {
    try {
      if (!i.guildId) return;
      const gid = i.guildId, uid = i.user.id, uname = i.user.username;
      const eph = { flags: MessageFlags.Ephemeral };

      // 角色名字自動完成（打字就跳候選，不用記 ID）
      if (i.isAutocomplete() && ['送禮', '邀請', '好感度'].includes(i.commandName)) {
        return i.respond(searchRoles(gid, i.options.getFocused())).catch(() => {});
      }
      if (!i.isChatInputCommand()) {
        // 逛街：面板與「出門」按鈕（隨機遇到角色，消耗體力）
        if (i.isButton() && (i.customId === 'strollpanel' || i.customId === 'adv:stroll')) {
          seedAffinity(gid);
          return i.reply({ ...strollPanel(gid, uid, uname), ...eph }).catch(() => {});
        }
        if (i.isButton() && i.customId === 'strollgo') {
          const out = stroll(gid, uid, uname);
          if (out.error) return i.reply({ content: out.error, ...eph }).catch(() => {});
          // 更新面板（體力／遇到人數），再把這次遇到誰單獨貼出來
          await i.update(strollPanel(gid, uid, uname)).catch(() => {});
          return i.followUp({
            embeds: [strollEmbed(gid, uid, out)],
            content: out.lv && out.lv.up ? `🎉 **${out.role.name}** 的好感度升到 **${levelName(gid, out.lv.level)}**！` : '',
            ...eph
          }).catch(() => {});
        }
        // 送禮的物品選單
        if (i.isStringSelectMenu() && i.customId.startsWith('giftpick:')) {
          const rid = parseInt(i.customId.split(':')[1], 10);
          const [kind, a1, a2] = i.values[0].split(':');
          const out = kind === 'dish'
            ? giftDish(gid, uid, uname, rid, Number(a1), Number(a2))
            : giftItem(gid, uid, uname, rid, Number(a1));
          if (out.error) return i.update({ content: out.error, embeds: [], components: [] }).catch(() => {});
          const react = out.weight >= 250 ? '眼睛都亮了' : out.weight >= 150 ? '看起來很開心' : out.weight < 0 ? '……表情有點微妙' : '收下了';
          const what = out.dish ? `${QUALITY[out.quality].emoji}${out.dish.name}` : `${out.item.emoji || ''}${out.item.name}`;
          return i.update({
            content: out.up ? `🎉 **${out.role.name}** 的好感度升到 **${levelName(gid, out.level)}**！` : '',
            embeds: [roleCard(gid, uid, out.role, `你送出 **${what}**，${out.role.name} ${react}。\n好感度 **+${out.gain}**`)],
            components: []
          }).catch(() => {});
        }
        return;
      }
      if (!['送禮', '邀請', '好感度'].includes(i.commandName)) return;
      seedAffinity(gid);

      const rid = parseInt(i.options.getString('角色'), 10);
      const role = roleOf(gid, rid);
      if (!role) return i.reply({ content: '找不到這位角色，請從自動完成的清單裡選。', ...eph }).catch(() => {});

      if (i.commandName === '好感度') return i.reply({ embeds: [roleCard(gid, uid, role)], ...eph }).catch(() => {});

      if (i.commandName === '邀請') {
        const out = inviteRole(gid, uid, uname, rid);
        if (out.error) return i.reply({ content: out.error, ...eph }).catch(() => {});
        if (out.refused) return i.reply({
          embeds: [roleCard(gid, uid, out.role, `你邀請了 **${out.role.name}**，但他今天有事來不了。\n（成功率 ${out.chance}% —— 好感度越高、家園越好，他越願意來）`)], ...eph
        }).catch(() => {});
        return i.reply({
          content: out.up ? `🎉 **${out.role.name}** 的好感度升到 **${levelName(gid, out.level)}**！` : '',
          embeds: [roleCard(gid, uid, out.role, `🏡 **${out.role.name}** 來你家作客了！\n好感度 **+${out.gain}**`)], ...eph
        }).catch(() => {});
      }

      // 送禮：列出背包物品與做好的料理讓玩家挑
      const items = db.prepare(
        `SELECT v.item_id, v.count, it.name, it.emoji, it.price FROM gather_inventory v JOIN gather_items it ON it.id=v.item_id
          WHERE v.guild_id=? AND v.user_id=? AND v.count>0 ORDER BY it.price DESC LIMIT 20`).all(gid, uid);
      const dishes = db.prepare(
        `SELECT c.recipe_id, c.quality, c.count, r.name, r.emoji FROM cook_inventory c JOIN cook_recipes r ON r.id=c.recipe_id
          WHERE c.guild_id=? AND c.user_id=? AND c.count>0 ORDER BY c.quality DESC LIMIT 5`).all(gid, uid);
      if (!items.length && !dishes.length)
        return i.reply({ content: '你的背包是空的，先去採集、種田或做點料理再來送禮。', ...eph }).catch(() => {});

      const opts = [
        ...dishes.map(d => ({
          label: `${QUALITY[d.quality].emoji}${d.emoji || ''}${d.name}`.slice(0, 100),
          description: `料理（品質越高好感越多）　持有 ${d.count}`.slice(0, 100),
          value: `dish:${d.recipe_id}:${d.quality}`
        })),
        ...items.map(it => ({
          label: `${it.emoji || ''}${it.name}`.slice(0, 100),
          description: `持有 ${it.count}　價值 ${it.price}`.slice(0, 100),
          value: `item:${it.item_id}:0`
        }))
      ].slice(0, 25);

      return i.reply({
        embeds: [roleCard(gid, uid, role, `要送什麼給 **${role.name}**？\n每個角色喜好不同，送對東西好感加得多。`)],
        components: [new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder().setCustomId(`giftpick:${rid}`).setPlaceholder('選一樣禮物').addOptions(opts))],
        ...eph
      }).catch(() => {});
    } catch (e) {
      logError(i.guildId, '好感度指令失敗：', e.message);
      const msg = { content: '執行失敗，管理員可到後台的系統錯誤紀錄查看原因。', flags: MessageFlags.Ephemeral };
      if (i.replied || i.deferred) await i.followUp(msg).catch(() => {}); else if (i.isRepliable()) await i.reply(msg).catch(() => {});
    }
  });
  console.log('  ↳ 好感度模組已載入（接轉盤角色／名字搜尋邀請）');
}

module.exports = { init, seedAffinity, seedGiftPrefs, lovePanel, strollPanel, stroll, strollEmbed, searchRoles };
