// 稅金系統：每週（可改每日/每月）自動結算三種稅
//   1. 農地稅：依「種著作物的格數」課，空地不課 → 逼人採收，不要整片田當倉庫
//   2. 養殖稅：依牧場動物數＋魚缸魚數課 → 養越多越要顧
//   3. 所得稅：對「目前餘額」累進課徵 → 專門抽囤在錢包不花的錢
// 設計重點：只從錢包扣，不動背包/資產；扣到 0 為止不會變負數，缺繳的部分記在稅單上。
const { EmbedBuilder, MessageFlags } = require('discord.js');
const cron = require('node-cron');
const { db, guildConfig, activeGuildIds, logError } = require('../../db');
const { brandColor } = require('../../util/brand');
const { parts, localToday } = require('../../util/time');

const cfg = (gid) => guildConfig('tax_config', gid);
const gcfg = (gid) => guildConfig('gather_config', gid);
const money = (gid, n) => {
  const c = gcfg(gid);
  return `${c.currency_emoji || '🪙'} ${Number(n || 0).toLocaleString('en-US')} ${c.currency_name || '星幣'}`;
};

// 預設級距：免稅額以上開始，越有錢抽越兇。後台可自由改。
const DEFAULT_BRACKETS = [
  { over: 100000, pct: 5 },
  { over: 500000, pct: 10 },
  { over: 2000000, pct: 20 },
  { over: 10000000, pct: 35 }
];

function brackets(c) {
  try {
    const b = JSON.parse(c.income_brackets || '[]');
    if (Array.isArray(b) && b.length) {
      return b.map(x => ({ over: Math.max(0, parseInt(x.over, 10) || 0), pct: Math.max(0, parseFloat(x.pct) || 0) }))
        .filter(x => x.pct > 0).sort((a, b2) => a.over - b2.over);
    }
  } catch { /* 壞掉的 JSON 就當沒設定 */ }
  return DEFAULT_BRACKETS;
}

// 兩種算法，後台 income_flat 切換：
//   flat=1（預設）整筆跳級：找出餘額落在哪一級，整個餘額乘那一級的 %（越有錢跳一級就整筆變貴）
//   flat=0 分段累進：每一級只對落在該級距內的那一段課（跟真實所得稅一樣）
function incomeTax(balance, free, bs, flat = true) {
  if (balance <= free) return 0;
  if (flat) {
    let pct = 0;
    for (const b of bs) if (balance > b.over) pct = b.pct;   // bs 已由小到大排序 → 最後一個成立的就是最高級
    return Math.floor(balance * pct / 100);
  }
  let tax = 0;
  for (let i = 0; i < bs.length; i++) {
    const lo = Math.max(bs[i].over, free);
    const hi = i + 1 < bs.length ? bs[i + 1].over : Infinity;
    if (balance > lo) tax += (Math.min(balance, hi) - lo) * bs[i].pct / 100;
  }
  return Math.floor(tax);
}

// 免稅名單：後台指定的 user_id / 身分組完全不課（管理員、活動帳號）
// 用逗號／空白／換行分隔都吃，不預設 ID 一定是純數字（避免把名單默默吃掉）
const csvIds = (s2) => String(s2 || '').split(/[\s,;、]+/).map(x => x.trim()).filter(Boolean);
function isExempt(gid, userId, member) {
  const c = cfg(gid);
  if (csvIds(c.exempt_users).includes(String(userId))) return true;
  const roles = csvIds(c.exempt_roles);
  if (roles.length && member && member.roles && member.roles.cache) {
    return roles.some(r => member.roles.cache.has(r));
  }
  return false;
}

// 算一個人這期該繳多少（不扣款，/稅單 的預估也走這支）
function assess(gid, userId) {
  const c = cfg(gid);
  const w = db.prepare('SELECT * FROM econ_wallets WHERE guild_id=? AND user_id=?').get(gid, userId);
  if (!w) return null;

  const plots = db.prepare(
    'SELECT plot_type, COUNT(*) n FROM crop_plots WHERE guild_id=? AND user_id=? GROUP BY plot_type'
  ).all(gid, userId);
  let field = 0, green = 0;
  for (const p of plots) { if (p.plot_type === 'greenhouse') green = p.n; else field += p.n; }
  const animals = db.prepare('SELECT COUNT(*) n FROM ranch_slots WHERE guild_id=? AND user_id=?').get(gid, userId).n;
  const fish = db.prepare('SELECT COUNT(*) n FROM aquarium_slots WHERE guild_id=? AND user_id=?').get(gid, userId).n;
  // 持股市值：只算「現價為正」的股票，負價股不會反過來變成退稅
  const stockVal = db.prepare(
    `SELECT COALESCE(SUM(h.shares * s.price),0) v FROM stock_holdings h JOIN stock_symbols s ON s.id=h.symbol_id
      WHERE h.guild_id=? AND h.user_id=? AND h.shares>0 AND s.price>0`
  ).get(gid, userId).v;

  // 免稅額度先抵便宜的那一項（農地→溫室、動物→魚），對玩家有利
  let freeLeft = Math.max(0, c.land_free || 0);
  const fieldTaxed = Math.max(0, field - freeLeft); freeLeft = Math.max(0, freeLeft - field);
  const greenTaxed = Math.max(0, green - freeLeft);
  let bFree = Math.max(0, c.breed_free || 0);
  const animalTaxed = Math.max(0, animals - bFree); bFree = Math.max(0, bFree - animals);
  const fishTaxed = Math.max(0, fish - bFree);

  const land = c.land_enabled ? fieldTaxed * (c.land_field || 0) + greenTaxed * (c.land_greenhouse || 0) : 0;
  const breed = c.breed_enabled ? animalTaxed * (c.breed_animal || 0) + fishTaxed * (c.breed_fish || 0) : 0;
  // 證券稅：持股市值扣掉免稅額後，乘上稅率
  const stockTaxed = Math.max(0, stockVal - (c.stock_free || 0));
  const stock = c.stock_enabled ? Math.floor(stockTaxed * (c.stock_pct || 0) / 100) : 0;
  let income = c.income_enabled ? incomeTax(w.coins, c.income_free || 0, brackets(c), !!c.income_flat) : 0;
  // 單次上限：三稅合計不超過餘額的 income_max_pct %，避免一次被抄家
  const cap = Math.floor(w.coins * Math.max(0, Math.min(100, c.income_max_pct ?? 50)) / 100);
  let total = income + land + breed + stock;
  if (cap > 0 && total > cap) {
    // 超過上限時先砍所得稅（農地/養殖/證券是固定規費，該繳還是要繳）
    income = Math.max(0, cap - land - breed - stock);
    total = income + land + breed + stock;
  }
  return {
    wallet: w, balance: w.coins, income, land, breed, stock, total,
    counts: { field, green, animals, fish, fieldTaxed, greenTaxed, animalTaxed, fishTaxed, stockVal, stockTaxed }
  };
}

// 普發（救濟金）：課完稅之後跑。條件是「餘額低於 relief_below」，
//   floor 模式＝補到 relief_floor（負債的人會先被填平）
//   fixed 模式＝每人固定發 relief_amount
// relief_from_tax=1 時，總發放不會超過本期實收稅金，超過就等比例縮減（國庫不會憑空印錢）。
// after：{user_id: 課稅後餘額}。試算模式錢包還沒被扣，一定要靠這份對照表才算得準。
function planRelief(gid, taxSum, client, after = new Map()) {
  const c = cfg(gid);
  if (!c.relief_enabled) return [];
  const guild = client && client.guilds ? client.guilds.cache.get(gid) : null;
  const below = c.relief_below || 0;
  const all = db.prepare('SELECT user_id, username, coins FROM econ_wallets WHERE guild_id=?').all(gid);
  const rows = all
    .map(w => ({ ...w, coins: after.has(w.user_id) ? after.get(w.user_id) : w.coins }))
    .filter(w => w.coins < below);
  let list = [];
  for (const w of rows) {
    if (isExempt(gid, w.user_id, guild && guild.members.cache.get(w.user_id))) continue;   // 管理員不領普發
    let amt = c.relief_mode === 'fixed'
      ? Math.max(0, c.relief_amount || 0)
      : Math.max(0, (c.relief_floor || 0) - w.coins);
    if (c.relief_max > 0) amt = Math.min(amt, c.relief_max);
    if (amt > 0) list.push({ userId: w.user_id, username: w.username || '', before: w.coins, amount: Math.floor(amt) });
  }
  // 預算控管：發不出這麼多就等比例縮減（至少留 1 塊，免得縮成 0 還記一筆）
  if (c.relief_from_tax) {
    const budget = Math.max(0, taxSum);
    const want = list.reduce((a, b) => a + b.amount, 0);
    if (want > budget) {
      const ratio = budget / want;
      list = list.map(x => ({ ...x, amount: Math.floor(x.amount * ratio) })).filter(x => x.amount > 0);
    }
  }
  return list;
}

function payRelief(gid, period, list) {
  if (!list.length) return 0;
  db.transaction(() => {
    for (const r of list) {
      db.prepare("UPDATE econ_wallets SET coins = coins + ?, updated_at = datetime('now','localtime') WHERE guild_id=? AND user_id=?")
        .run(r.amount, gid, r.userId);
      db.prepare('INSERT INTO tax_reliefs (guild_id,period,user_id,username,before_coins,amount) VALUES (?,?,?,?,?,?)')
        .run(gid, period, r.userId, r.username, r.before, r.amount);
    }
  })();
  return list.reduce((a, b) => a + b.amount, 0);
}

// 期間代碼：同一期只課一次（用結算日的日期字串當代碼）
function periodCode() { return localToday(); }

// 這一刻是否輪到這台伺服器課稅
function isDue(c) {
  const p = parts();
  if (`${p.hh}:${p.mm}` !== (c.run_time || '09:00')) return false;
  if (c.period === 'day') return true;
  if (c.period === 'month') return p.d === (c.dom || 1);
  return p.dow === (c.dow ?? 1);
}

// 對一台伺服器結算。force=true 給後台「立即試算/課徵」用，會略過時間與去重檢查。
async function runGuild(client, gid, { force = false, dryRun = false } = {}) {
  const c = cfg(gid);
  if (!c.enabled && !force) return null;
  if (!force) {
    if (!isDue(c)) return null;
    if (c.last_period === periodCode()) return null;   // 同一期已經課過
  }
  const period = periodCode();
  const wallets = db.prepare('SELECT user_id FROM econ_wallets WHERE guild_id=?').all(gid);
  const guild = client && client.guilds ? client.guilds.cache.get(gid) : null;
  const bills = [];
  for (const { user_id } of wallets) {
    if (isExempt(gid, user_id, guild && guild.members.cache.get(user_id))) continue;   // 免稅名單直接跳過
    const a = assess(gid, user_id);
    if (!a || a.total < Math.max(1, c.min_total || 1)) continue;
    bills.push({ userId: user_id, ...a });
  }

  if (!dryRun) {
    const pay = db.transaction(() => {
      for (const b of bills) {
        const paid = b.total;   // 全額課徵：錢不夠就欠稅，餘額會變成負數
        db.prepare("UPDATE econ_wallets SET coins = coins - ?, updated_at = datetime('now','localtime') WHERE guild_id=? AND user_id=?")
          .run(paid, gid, b.userId);
        db.prepare(
          `INSERT INTO tax_records (guild_id, period, user_id, username, balance, income_tax, land_tax, breed_tax, stock_tax, total, paid, detail)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
        ).run(gid, period, b.userId, b.wallet.username || '', b.balance, b.income, b.land, b.breed, b.stock || 0, b.total, paid,
          JSON.stringify(b.counts));
        b.paid = paid;
      }
      db.prepare('UPDATE tax_config SET last_period=? WHERE guild_id=?').run(period, gid);
    });
    pay();
  }
  const sum = bills.reduce((s, b) => s + (b.paid ?? b.total), 0);
  const after = new Map(bills.map(b => [b.userId, b.balance - (b.paid ?? b.total)]));
  const relief = planRelief(gid, sum, client, after);
  const reliefSum = dryRun ? relief.reduce((a, b) => a + b.amount, 0) : payRelief(gid, period, relief);
  if (!dryRun) await announce(client, gid, period, bills, relief, reliefSum).catch(() => {});
  return { period, bills, sum, relief, reliefSum };
}

// 公告本期稅收＋納稅大戶，並（可選）私訊每個人自己的稅單
async function announce(client, gid, period, bills, relief = [], reliefSum = 0) {
  const c = cfg(gid);
  if (!bills.length && !relief.length) return;
  const sum = bills.reduce((s, b) => s + b.paid, 0);
  if (c.channel) {
    const ch = await client.channels.fetch(c.channel).catch(() => null);
    if (ch) {
      const top = [...bills].sort((a, b) => b.paid - a.paid).slice(0, 10);
      const emb = new EmbedBuilder()
        .setTitle('🧾 本期稅金結算')
        .setDescription(`期間代碼：\`${period}\`\n共 **${bills.length}** 人繳稅，總稅收 ${money(gid, sum)}`)
        .addFields({
          name: '納稅大戶',
          value: top.map((b, i) => `${['🥇', '🥈', '🥉'][i] || `${i + 1}.`} <@${b.userId}> — ${money(gid, b.paid)}`).join('\n') || '—'
        })
        .setFooter({ text: '所得稅算錢包餘額／證券稅算持股市值／農地稅算種著的格數／養殖稅算動物與魚。用 /稅單 查自己的明細。' })
        .setColor(brandColor());
      if (relief.length) {
        const topR = [...relief].sort((a, b) => b.amount - a.amount).slice(0, 10);
        emb.addFields({
          name: `🤝 本期普發　共 ${relief.length} 人領到 ${money(gid, reliefSum)}`,
          value: topR.map(r => `<@${r.userId}> — ${money(gid, r.amount)}`).join('\n').slice(0, 1024)
        });
      }
      await ch.send({ embeds: [emb] }).catch(() => {});
    }
  }
  if (!c.dm_bill) return;
  for (const b of bills) {
    const u = await client.users.fetch(b.userId).catch(() => null);
    if (!u) continue;
    await u.send({ embeds: [billEmbed(gid, b, period)] }).catch(() => {});
  }
}

function billEmbed(gid, b, period) {
  const lines = [];
  if (b.income) lines.push(`💰 所得稅　${money(gid, b.income)}（餘額 ${b.balance.toLocaleString('en-US')}）`);
  if (b.land) lines.push(`🌾 農地稅　${money(gid, b.land)}（農地 ${b.counts.fieldTaxed} 格／溫室 ${b.counts.greenTaxed} 格）`);
  if (b.breed) lines.push(`🐄 養殖稅　${money(gid, b.breed)}（動物 ${b.counts.animalTaxed} 隻／魚 ${b.counts.fishTaxed} 條）`);
  if (b.stock) lines.push(`📈 證券稅　${money(gid, b.stock)}（持股市值 ${Number(b.counts.stockVal || 0).toLocaleString('en-US')}）`);
  const emb = new EmbedBuilder()
    .setTitle('🧾 你的稅單')
    .setDescription(lines.join('\n') || '本期免稅 🎉')
    .addFields({ name: '合計', value: money(gid, b.total), inline: true })
    .setColor(brandColor());
  if (period) emb.setFooter({ text: `期間 ${period}` });
  if (b.paid !== undefined && b.balance !== undefined && b.balance - b.paid < 0) {
    emb.addFields({
      name: '⚠️ 欠稅',
      value: `餘額不足，繳完後變成 ${money(gid, b.balance - b.paid)}（負債），要先賺回來才會回到正數。`,
      inline: true
    });
  }
  return emb;
}

// 冒險面板的 🧾稅務：一次講清楚「課什麼、怎麼算、何時收」，再附上自己的預估稅單
function infoEmbed(gid, userId, username) {
  const c = cfg(gid);
  const emb = new EmbedBuilder().setColor(brandColor()).setTitle('🧾 稅務資訊');
  if (!c.enabled) {
    return emb.setDescription('這個伺服器目前**沒有開徵稅金**，錢包不會被扣。\n開徵後這裡會顯示稅率、結算時間與你自己的預估稅單。');
  }
  if (isExempt(gid, userId)) {
    return emb.setDescription(`✅ 你在**免稅名單**內，這個伺服器的稅金不會扣到你。`);
  }
  const lines = [];
  if (c.income_enabled) {
    const bs = brackets(c);
    lines.push(c.income_flat
      ? `💰 **所得稅**　**整筆跳級**：看餘額落在哪一級，就用那一級的 % 課**整個餘額**（免稅額 ${money(gid, c.income_free || 0)}）\n` +
        bs.map(b => `　・餘額超過 ${Number(b.over).toLocaleString('en-US')}　→　整筆課 ${b.pct}%`).join('\n')
      : `💰 **所得稅**　對**錢包餘額**分段累進，免稅額 ${money(gid, c.income_free || 0)}\n` +
        bs.map(b => `　・超過 ${Number(b.over).toLocaleString('en-US')} 的部分：${b.pct}%`).join('\n'));
  }
  if (c.land_enabled) {
    lines.push(`🌾 **農地稅**　只算**種著作物**的格數（空地不課）\n` +
      `　・農地 ${money(gid, c.land_field || 0)} ／格　・溫室 ${money(gid, c.land_greenhouse || 0)} ／格` +
      (c.land_free ? `　（前 ${c.land_free} 格免稅）` : ''));
  }
  if (c.breed_enabled) {
    lines.push(`🐄 **養殖稅**　算牧場動物與魚缸的魚\n` +
      `　・動物 ${money(gid, c.breed_animal || 0)} ／隻　・魚 ${money(gid, c.breed_fish || 0)} ／條` +
      (c.breed_free ? `　（前 ${c.breed_free} 隻免稅）` : ''));
  }
  if (c.stock_enabled) {
    lines.push(`📈 **證券稅**　按**持股市值**課 ${c.stock_pct || 0}%` +
      ((c.stock_free || 0) > 0 ? `（市值 ${money(gid, c.stock_free)} 以內免稅）` : '') +
      `\n　現價是負數的股票不計入市值，也不會退稅。`);
  }
  if (!lines.length) lines.push('目前三種稅都沒有開啟。');
  emb.setDescription(lines.join('\n\n'));

  const a = assess(gid, userId);
  if (a) {
    const detail = [];
    if (a.income) detail.push(`💰 所得稅 ${money(gid, a.income)}`);
    if (a.land) detail.push(`🌾 農地稅 ${money(gid, a.land)}（農地 ${a.counts.fieldTaxed}／溫室 ${a.counts.greenTaxed} 格）`);
    if (a.breed) detail.push(`🐄 養殖稅 ${money(gid, a.breed)}（動物 ${a.counts.animalTaxed}／魚 ${a.counts.fishTaxed}）`);
    if (a.stock) detail.push(`📈 證券稅 ${money(gid, a.stock)}（持股市值 ${Number(a.counts.stockVal || 0).toLocaleString('en-US')}）`);
    emb.addFields({
      name: '你這期預估要繳',
      value: (detail.length ? detail.join('\n') + `\n**合計 ${money(gid, a.total)}**` : '本期免稅 🎉') +
        `\n（目前餘額 ${money(gid, a.balance)}）`
    });
  }
  if (c.relief_enabled) {
    emb.addFields({
      name: '🤝 普發（救濟金）',
      value: (c.relief_mode === 'fixed'
        ? `結算後，餘額低於 ${money(gid, c.relief_below || 0)} 的人每人發 ${money(gid, c.relief_amount || 0)}`
        : `結算後，餘額低於 ${money(gid, c.relief_below || 0)} 的人會被**補到 ${money(gid, c.relief_floor || 0)}**`) +
        (c.relief_max > 0 ? `（每人單期上限 ${money(gid, c.relief_max)}）` : '') +
        (c.relief_from_tax ? '\n財源是本期稅收，不夠時所有人等比例縮減。' : '')
    });
  }
  const lastR = db.prepare('SELECT * FROM tax_reliefs WHERE guild_id=? AND user_id=? ORDER BY id DESC LIMIT 1').get(gid, userId);
  if (lastR) {
    emb.addFields({ name: `上一期普發（${lastR.period}）你領到`, value: `**${money(gid, lastR.amount)}**（發放前餘額 ${money(gid, lastR.before_coins)}）` });
  }
  const last = db.prepare('SELECT * FROM tax_records WHERE guild_id=? AND user_id=? ORDER BY id DESC LIMIT 1').get(gid, userId);
  if (last) {
    const parts2 = [];
    if (last.income_tax) parts2.push(`所得 ${money(gid, last.income_tax)}`);
    if (last.land_tax) parts2.push(`農地 ${money(gid, last.land_tax)}`);
    if (last.breed_tax) parts2.push(`養殖 ${money(gid, last.breed_tax)}`);
    if (last.stock_tax) parts2.push(`證券 ${money(gid, last.stock_tax)}`);
    emb.addFields({
      name: `上一期（${last.period}）你繳了`,
      value: `**${money(gid, last.paid)}**` + (parts2.length ? `\n　${parts2.join('　')}` : '') +
        `\n（當時餘額 ${money(gid, last.balance)}）`
    });
  }
  const guildLast = db.prepare(
    'SELECT period, COUNT(*) n, COALESCE(SUM(paid),0) s FROM tax_records WHERE guild_id=? GROUP BY period ORDER BY period DESC LIMIT 1'
  ).get(gid);
  if (guildLast) {
    const gr = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(amount),0) s FROM tax_reliefs WHERE guild_id=? AND period=?').get(gid, guildLast.period);
    emb.addFields({
      name: `上一期全服（${guildLast.period}）`,
      value: `🧾 ${guildLast.n} 人繳稅，總稅收 ${money(gid, guildLast.s)}` +
        (gr && gr.n ? `\n🤝 ${gr.n} 人領普發，共 ${money(gid, gr.s)}` : '')
    });
  }
  emb.addFields({
    name: '結算方式',
    value: `${nextRunText(c)}` + ((c.income_max_pct ?? 50) > 0 ? `　·　單期最多課走餘額的 ${c.income_max_pct}%` : '') + '\n' +
      `只從**錢包**扣（背包與資產不會被動），但**錢不夠會欠稅、餘額變成負數**，要賺回來才會回正。`
  });
  return emb.setFooter({ text: '用 /稅單 可以隨時查自己的明細' });
}

function init(client) {
  // 冒險面板的 🧾稅務按鈕
  client.on('interactionCreate', async (i) => {
    if (!i.isButton() || i.customId !== 'adv:tax') return;
    try {
      return await i.reply({ embeds: [infoEmbed(i.guildId, i.user.id, i.user.username)], flags: MessageFlags.Ephemeral });
    } catch (e) {
      logError(i.guildId, '稅務面板失敗：', e && e.stack ? e.stack : e);
      if (!i.replied && !i.deferred) i.reply({ content: '查詢稅務資訊時發生錯誤。', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  });

  client.on('interactionCreate', async (i) => {
    if (!i.isChatInputCommand() || i.commandName !== '稅單') return;
    try {
      const gid = i.guildId, c = cfg(gid);
      if (!c.enabled) {
        return i.reply({ content: '這個伺服器目前沒有開徵稅金。', flags: MessageFlags.Ephemeral });
      }
      const target = i.options.getUser('玩家') || i.user;
      if (isExempt(gid, target.id, i.guild && i.guild.members.cache.get(target.id))) {
        return i.reply({ content: `✅ ${target.username} 在免稅名單內，不會被課稅。`, flags: MessageFlags.Ephemeral });
      }
      const a = assess(gid, target.id);
      if (!a) return i.reply({ content: '找不到錢包資料（先玩一下再來看稅單吧）。', flags: MessageFlags.Ephemeral });
      const last = db.prepare(
        'SELECT * FROM tax_records WHERE guild_id=? AND user_id=? ORDER BY id DESC LIMIT 1'
      ).get(gid, target.id);
      const emb = billEmbed(gid, a, null)
        .setTitle(`🧾 ${target.username} 的稅單預估`)
        .setFooter({
          text: last
            ? `上期（${last.period}）實繳 ${last.paid.toLocaleString('en-US')}　·　下次結算：${nextRunText(c)}`
            : `下次結算：${nextRunText(c)}`
        });
      return i.reply({ embeds: [emb], flags: MessageFlags.Ephemeral });
    } catch (e) {
      logError(i.guildId, '稅單查詢失敗：', e && e.stack ? e.stack : e);
      if (!i.replied && !i.deferred) i.reply({ content: '查詢稅單時發生錯誤。', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  });

  // 每分鐘檢查一次，由各伺服器自己的 period/dow/run_time 決定要不要課（多伺服器各自獨立）
  cron.schedule('* * * * *', async () => {
    for (const gid of activeGuildIds()) {
      try { await runGuild(client, gid); }
      catch (e) { logError(gid, '稅金結算失敗：', e && e.stack ? e.stack : e); }
    }
  }, { timezone: 'Asia/Taipei' });

  client._runTax = (gid, opts) => runGuild(client, gid, opts);
  console.log('  ↳ 稅金模組已載入（農地稅／養殖稅／所得稅，每分鐘檢查結算時間；面板 🧾稅務）');
}

const DOW = ['日', '一', '二', '三', '四', '五', '六'];
function nextRunText(c) {
  if (c.period === 'day') return `每日 ${c.run_time}`;
  if (c.period === 'month') return `每月 ${c.dom} 號 ${c.run_time}`;
  return `每週${DOW[c.dow ?? 1]} ${c.run_time}`;
}

module.exports = { init, assess, runGuild, incomeTax, DEFAULT_BRACKETS, nextRunText, infoEmbed, isExempt, planRelief };
