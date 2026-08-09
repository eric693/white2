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

// 累進計算：每一級只對「落在該級距內的那一段餘額」課稅（跟真的所得稅一樣，不是整筆跳級）
function incomeTax(balance, free, bs) {
  if (balance <= free) return 0;
  let tax = 0;
  for (let i = 0; i < bs.length; i++) {
    const lo = Math.max(bs[i].over, free);
    const hi = i + 1 < bs.length ? bs[i + 1].over : Infinity;
    if (balance > lo) tax += (Math.min(balance, hi) - lo) * bs[i].pct / 100;
  }
  return Math.floor(tax);
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

  // 免稅額度先抵便宜的那一項（農地→溫室、動物→魚），對玩家有利
  let freeLeft = Math.max(0, c.land_free || 0);
  const fieldTaxed = Math.max(0, field - freeLeft); freeLeft = Math.max(0, freeLeft - field);
  const greenTaxed = Math.max(0, green - freeLeft);
  let bFree = Math.max(0, c.breed_free || 0);
  const animalTaxed = Math.max(0, animals - bFree); bFree = Math.max(0, bFree - animals);
  const fishTaxed = Math.max(0, fish - bFree);

  const land = c.land_enabled ? fieldTaxed * (c.land_field || 0) + greenTaxed * (c.land_greenhouse || 0) : 0;
  const breed = c.breed_enabled ? animalTaxed * (c.breed_animal || 0) + fishTaxed * (c.breed_fish || 0) : 0;
  let income = c.income_enabled ? incomeTax(w.coins, c.income_free || 0, brackets(c)) : 0;
  // 單次上限：三稅合計不超過餘額的 income_max_pct %，避免一次被抄家
  const cap = Math.floor(w.coins * Math.max(0, Math.min(100, c.income_max_pct ?? 50)) / 100);
  let total = income + land + breed;
  if (cap > 0 && total > cap) {
    // 超過上限時先砍所得稅（農地/養殖是固定規費，該繳還是要繳）
    income = Math.max(0, cap - land - breed);
    total = income + land + breed;
  }
  return {
    wallet: w, balance: w.coins, income, land, breed, total,
    counts: { field, green, animals, fish, fieldTaxed, greenTaxed, animalTaxed, fishTaxed }
  };
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
  const bills = [];
  for (const { user_id } of wallets) {
    const a = assess(gid, user_id);
    if (!a || a.total < Math.max(1, c.min_total || 1)) continue;
    bills.push({ userId: user_id, ...a });
  }

  if (!dryRun) {
    const pay = db.transaction(() => {
      for (const b of bills) {
        const paid = Math.min(b.total, Math.max(0, b.balance));   // 不扣成負數，缺的記在稅單上
        db.prepare("UPDATE econ_wallets SET coins = coins - ?, updated_at = datetime('now','localtime') WHERE guild_id=? AND user_id=?")
          .run(paid, gid, b.userId);
        db.prepare(
          `INSERT INTO tax_records (guild_id, period, user_id, username, balance, income_tax, land_tax, breed_tax, total, paid, detail)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`
        ).run(gid, period, b.userId, b.wallet.username || '', b.balance, b.income, b.land, b.breed, b.total, paid,
          JSON.stringify(b.counts));
        b.paid = paid;
      }
      db.prepare('UPDATE tax_config SET last_period=? WHERE guild_id=?').run(period, gid);
    });
    pay();
    await announce(client, gid, period, bills).catch(() => {});
  }
  return { period, bills, sum: bills.reduce((s, b) => s + (b.paid ?? b.total), 0) };
}

// 公告本期稅收＋納稅大戶，並（可選）私訊每個人自己的稅單
async function announce(client, gid, period, bills) {
  const c = cfg(gid);
  if (!bills.length) return;
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
        .setFooter({ text: '所得稅對餘額累進課徵／農地稅算種著的格數／養殖稅算動物與魚。用 /稅單 查自己的明細。' })
        .setColor(brandColor());
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
  const emb = new EmbedBuilder()
    .setTitle('🧾 你的稅單')
    .setDescription(lines.join('\n') || '本期免稅 🎉')
    .addFields({ name: '合計', value: money(gid, b.total), inline: true })
    .setColor(brandColor());
  if (period) emb.setFooter({ text: `期間 ${period}` });
  if (b.paid !== undefined && b.paid < b.total) {
    emb.addFields({ name: '⚠️ 欠繳', value: `餘額不足，還差 ${money(gid, b.total - b.paid)}（已扣光錢包）`, inline: true });
  }
  return emb;
}

function init(client) {
  client.on('interactionCreate', async (i) => {
    if (!i.isChatInputCommand() || i.commandName !== '稅單') return;
    try {
      const gid = i.guildId, c = cfg(gid);
      if (!c.enabled) {
        return i.reply({ content: '這個伺服器目前沒有開徵稅金。', flags: MessageFlags.Ephemeral });
      }
      const target = i.options.getUser('玩家') || i.user;
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
  console.log('  ↳ 稅金模組已載入（農地稅／養殖稅／所得稅，每分鐘檢查結算時間）');
}

const DOW = ['日', '一', '二', '三', '四', '五', '六'];
function nextRunText(c) {
  if (c.period === 'day') return `每日 ${c.run_time}`;
  if (c.period === 'month') return `每月 ${c.dom} 號 ${c.run_time}`;
  return `每週${DOW[c.dow ?? 1]} ${c.run_time}`;
}

module.exports = { init, assess, runGuild, incomeTax, DEFAULT_BRACKETS, nextRunText };
