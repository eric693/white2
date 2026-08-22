// 釣魚 / 挖礦掛機系統 API（設定、掉落物、道具、玩家資料）
const express = require('express');
const { db, audit, guildConfig } = require('../db');
const { requireAuth, requireModule, guardModule } = require('../auth');
const bot = require('../bot');
const { PermissionsBitField } = require('discord.js');

const router = express.Router();
router.use(requireAuth(), guardModule('gather'));

const KINDS = ['fish', 'mine', 'wood', 'forage', 'hunt'];
const RARITY = ['N', 'R', 'SR', 'SSR'];
const csvField = (v) => Array.isArray(v) ? v.join(',') : String(v || '');
const kindOf = (v) => KINDS.includes(v) ? v : 'fish';
const rarityOf = (v) => RARITY.includes(String(v).toUpperCase()) ? String(v).toUpperCase() : 'N';
const int = (v, d = 0, min = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(min, n) : d; };

// ---- 設定 ----
router.get('/gather', (req, res) => {
  res.json(guildConfig('gather_config', req.guildId));
});

router.put('/gather', (req, res) => {
  const b = req.body || {};
  guildConfig('gather_config', req.guildId);   // 確保該伺服器有一筆設定
  db.prepare(
    `UPDATE gather_config SET enabled=@enabled, channels=@channels, currency_name=@currency_name,
       currency_emoji=@currency_emoji, fish_cooldown=@fish_cooldown, mine_cooldown=@mine_cooldown,
       daily_limit=@daily_limit, daily_points=@daily_points, start_coins=@start_coins, announce_rare=@announce_rare,
       other_cooldown=@other_cooldown, require_tool=@require_tool, transfer_enabled=@transfer_enabled,
       transfer_fee_pct=@transfer_fee_pct, transfer_min=@transfer_min, transfer_daily_max=@transfer_daily_max
     WHERE guild_id=@guild_id`
  ).run({
    enabled: b.enabled ? 1 : 0,
    channels: csvField(b.channels),
    currency_name: b.currency_name || '星幣',
    currency_emoji: b.currency_emoji || '🪙',
    fish_cooldown: int(b.fish_cooldown, 300, 1),
    mine_cooldown: int(b.mine_cooldown, 300, 1),
    other_cooldown: int(b.other_cooldown, 300, 1),
    require_tool: b.require_tool ? 1 : 0,
    transfer_enabled: b.transfer_enabled ? 1 : 0,
    transfer_fee_pct: Math.min(50, int(b.transfer_fee_pct, 5)),
    transfer_min: int(b.transfer_min, 10),
    transfer_daily_max: int(b.transfer_daily_max, 5000),
    daily_limit: int(b.daily_limit, 0),
    daily_points: int(b.daily_points, 0),
    start_coins: int(b.start_coins, 0),
    // 空字串＝不廣播；其餘只接受合法稀有度，避免寫進奇怪的值讓機器人比對不到
    announce_rare: RARITY.includes(b.announce_rare) ? b.announce_rare : '',
    guild_id: req.guildId
  });
  audit(req.user.name, '修改釣魚挖礦設定');
  res.json({ ok: true });
});

// ---- 掉落物 ----
router.get('/gather-items', (req, res) => {
  res.json(db.prepare('SELECT * FROM gather_items WHERE guild_id=? ORDER BY kind, rarity, price').all(req.guildId));
});

function itemFields(b) {
  return {
    kind: kindOf(b.kind), name: b.name || '', emoji: b.emoji || '', image_url: b.image_url || '',
    rarity: rarityOf(b.rarity), weight: int(b.weight, 100, 0), price: int(b.price, 10, 0),
    description: b.description || '', enabled: b.enabled ? 1 : 0
  };
}

router.post('/gather-items', (req, res) => {
  const f = itemFields(req.body || {});
  if (!f.name) return res.status(400).json({ error: '請填寫物品名稱' });
  const info = db.prepare(
    `INSERT INTO gather_items (guild_id,kind,name,emoji,image_url,rarity,weight,price,description,enabled)
     VALUES (@guild_id,@kind,@name,@emoji,@image_url,@rarity,@weight,@price,@description,@enabled)`
  ).run({ ...f, guild_id: req.guildId });
  audit(req.user.name, `新增掉落物：${f.name}`);
  res.json({ id: info.lastInsertRowid });
});

router.put('/gather-items/:id', (req, res) => {
  const f = itemFields(req.body || {});
  if (!f.name) return res.status(400).json({ error: '請填寫物品名稱' });
  db.prepare(
    `UPDATE gather_items SET kind=@kind, name=@name, emoji=@emoji, image_url=@image_url, rarity=@rarity,
       weight=@weight, price=@price, description=@description, enabled=@enabled
     WHERE id=@id AND guild_id=@guild_id`
  ).run({ ...f, id: req.params.id, guild_id: req.guildId });
  audit(req.user.name, `修改掉落物 #${req.params.id}`);
  res.json({ ok: true });
});

router.delete('/gather-items/:id', (req, res) => {
  db.prepare('DELETE FROM gather_items WHERE id=? AND guild_id=?').run(req.params.id, req.guildId);
  // 背包裡的紀錄一起清掉，不然圖鑑會出現查不到名字的空項目
  db.prepare('DELETE FROM gather_inventory WHERE item_id=? AND guild_id=?').run(req.params.id, req.guildId);
  audit(req.user.name, `刪除掉落物 #${req.params.id}`);
  res.json({ ok: true });
});

// ---- 道具（竿子 / 鎬子）----
router.get('/gather-tools', (req, res) => {
  res.json(db.prepare('SELECT * FROM gather_tools WHERE guild_id=? ORDER BY kind, tier').all(req.guildId));
});

function toolFields(b) {
  return {
    kind: kindOf(b.kind), name: b.name || '', emoji: b.emoji || '',
    tier: int(b.tier, 1, 1), price: int(b.price, 100, 0),
    luck: int(b.luck, 0, 0), cooldown_cut: Math.min(90, int(b.cooldown_cut, 0, 0)),
    durability: int(b.durability, 0, 0), repair_cost: int(b.repair_cost, 0, 0),
    description: b.description || '', enabled: b.enabled ? 1 : 0
  };
}

router.post('/gather-tools', (req, res) => {
  const f = toolFields(req.body || {});
  if (!f.name) return res.status(400).json({ error: '請填寫道具名稱' });
  const info = db.prepare(
    `INSERT INTO gather_tools (guild_id,kind,name,emoji,tier,price,luck,cooldown_cut,durability,repair_cost,description,enabled)
     VALUES (@guild_id,@kind,@name,@emoji,@tier,@price,@luck,@cooldown_cut,@durability,@repair_cost,@description,@enabled)`
  ).run({ ...f, guild_id: req.guildId });
  audit(req.user.name, `新增道具：${f.name}`);
  res.json({ id: info.lastInsertRowid });
});

router.put('/gather-tools/:id', (req, res) => {
  const f = toolFields(req.body || {});
  if (!f.name) return res.status(400).json({ error: '請填寫道具名稱' });
  db.prepare(
    `UPDATE gather_tools SET kind=@kind, name=@name, emoji=@emoji, tier=@tier, price=@price,
       luck=@luck, cooldown_cut=@cooldown_cut, durability=@durability, repair_cost=@repair_cost,
       description=@description, enabled=@enabled
     WHERE id=@id AND guild_id=@guild_id`
  ).run({ ...f, id: req.params.id, guild_id: req.guildId });
  audit(req.user.name, `修改道具 #${req.params.id}`);
  res.json({ ok: true });
});

router.delete('/gather-tools/:id', (req, res) => {
  db.prepare('DELETE FROM gather_tools WHERE id=? AND guild_id=?').run(req.params.id, req.guildId);
  db.prepare('DELETE FROM gather_user_tools WHERE tool_id=? AND guild_id=?').run(req.params.id, req.guildId);
  audit(req.user.name, `刪除道具 #${req.params.id}`);
  res.json({ ok: true });
});

// ---- 玩家資料：錢包排行 + 手動增減貨幣 ----
router.get('/gather-players', (req, res) => {
  // 一併帶出每個人的設施等級與規模：管理員要看「誰有幾個農場、誰升到幾階」不必再一個一個查，
  // 土地稅也是照這些等級課的（tax_config.land_tier_pct）。
  const rows = db.prepare(
    `SELECT w.*, (SELECT COUNT(*) FROM gather_inventory v
       WHERE v.guild_id=w.guild_id AND v.user_id=w.user_id AND v.total_caught > 0) AS collected
     FROM econ_wallets w WHERE w.guild_id=? ORDER BY w.coins DESC LIMIT 200`
  ).all(req.guildId);
  const fac = db.prepare('SELECT type, tier, slots FROM facility_owned WHERE guild_id=? AND user_id=?');
  const cnt = (sql) => db.prepare(sql);
  const plots = cnt('SELECT COUNT(*) n FROM crop_plots WHERE guild_id=? AND user_id=? AND plot_type=?');
  const animals = cnt('SELECT COUNT(*) n FROM ranch_slots WHERE guild_id=? AND user_id=?');
  const fish = cnt('SELECT COUNT(*) n FROM aquarium_slots WHERE guild_id=? AND user_id=?');
  const home = cnt('SELECT level, kitchen_level FROM home_users WHERE guild_id=? AND user_id=?');
  const shares = cnt('SELECT COALESCE(SUM(shares),0) n FROM stock_holdings WHERE guild_id=? AND user_id=?');
  const limits = db.prepare('SELECT stamina_bonus, note FROM player_limits WHERE guild_id=? AND user_id=?');
  const partners = cnt('SELECT COUNT(*) n FROM home_partners WHERE guild_id=? AND user_id=?');
  res.json(rows.map(w => {
    const f = {};
    for (const r of fac.all(req.guildId, w.user_id)) f[r.type] = { tier: r.tier, slots: r.slots };
    const h = home.get(req.guildId, w.user_id) || {};
    return {
      ...w,
      facilities: f,
      field_plots: plots.get(req.guildId, w.user_id, 'field').n,
      greenhouse_plots: plots.get(req.guildId, w.user_id, 'greenhouse').n,
      animals: animals.get(req.guildId, w.user_id).n,
      fish: fish.get(req.guildId, w.user_id).n,
      home_level: h.level || 0,
      kitchen_level: h.kitchen_level || 0,
      shares: shares.get(req.guildId, w.user_id).n,
      stamina_bonus: (limits.get(req.guildId, w.user_id) || {}).stamina_bonus || 0,
      stamina_note: (limits.get(req.guildId, w.user_id) || {}).note || '',
      partners: partners.get(req.guildId, w.user_id).n
    };
  }));
});

// 直接發素材給玩家：測試新內容、活動補償、修正誤扣都用得到。
// 走這支才有操作紀錄（audit），比直接改資料庫安全。
router.post('/gather-players/:userId/items', (req, res) => {
  const b = req.body || {};
  const gid = req.guildId;
  const itemId = int(b.item_id, 0, 0);
  const count = Math.max(-100000, Math.min(100000, parseInt(b.count, 10) || 0));
  if (!itemId || !count) return res.status(400).json({ error: '請選擇素材並填數量' });
  const it = db.prepare('SELECT * FROM gather_items WHERE id=? AND guild_id=?').get(itemId, gid);
  if (!it) return res.status(404).json({ error: '找不到這個素材' });
  db.prepare(`INSERT INTO gather_inventory (guild_id,user_id,item_id,count) VALUES (?,?,?,?)
    ON CONFLICT(guild_id,user_id,item_id) DO UPDATE SET count = MAX(0, count + ?)`)
    .run(gid, req.params.userId, itemId, Math.max(0, count), count);
  const now = (db.prepare('SELECT count FROM gather_inventory WHERE guild_id=? AND user_id=? AND item_id=?')
    .get(gid, req.params.userId, itemId) || {}).count || 0;
  audit(req.user.name, `發素材給 ${req.params.userId}：${it.name} ${count > 0 ? '+' : ''}${count}（現有 ${now}）`, 'gather');
  res.json({ ok: true, name: it.name, count: now });
});

// 一次發一整組（例如「基礎素材包」）—— 測試新玩法時最常用
router.post('/gather-players/:userId/items-bulk', (req, res) => {
  const b = req.body || {};
  const gid = req.guildId;
  const list = Array.isArray(b.items) ? b.items : [];
  if (!list.length) return res.status(400).json({ error: '請至少選一個素材' });
  const ins = db.prepare(`INSERT INTO gather_inventory (guild_id,user_id,item_id,count) VALUES (?,?,?,?)
    ON CONFLICT(guild_id,user_id,item_id) DO UPDATE SET count = MAX(0, count + ?)`);
  let n = 0;
  db.transaction(() => {
    for (const x of list) {
      const id = int(x.item_id, 0, 0), c = Math.max(-100000, Math.min(100000, parseInt(x.count, 10) || 0));
      if (!id || !c) continue;
      ins.run(gid, req.params.userId, id, Math.max(0, c), c);
      n++;
    }
  })();
  audit(req.user.name, `批次發素材給 ${req.params.userId}：${n} 種`, 'gather');
  res.json({ ok: true, kinds: n });
});

// 素材清單（發放用的下拉）
router.get('/gather-item-list', (req, res) => {
  res.json(db.prepare(
    'SELECT id, name, emoji, kind, rarity, price FROM gather_items WHERE guild_id=? AND enabled=1 ORDER BY kind, price').all(req.guildId));
});

// 個別玩家的每日體力上限（+N，永久）。有些玩家在別的活動達標，管理員給他多一點行動額度。
router.post('/gather-players/:userId/stamina', (req, res) => {
  const b = req.body || {};
  const bonus = Math.max(-999, Math.min(999, parseInt(b.stamina_bonus, 10) || 0));
  db.prepare(
    `INSERT INTO player_limits (guild_id,user_id,stamina_bonus,note) VALUES (?,?,?,?)
     ON CONFLICT(guild_id,user_id) DO UPDATE SET stamina_bonus=excluded.stamina_bonus,
       note=excluded.note, updated_at=datetime('now','localtime')`
  ).run(req.guildId, req.params.userId, bonus, String(b.note || '').slice(0, 100));
  audit(req.user.name, `調整玩家 ${req.params.userId} 的每日體力上限 ${bonus >= 0 ? '+' : ''}${bonus}`, 'gather');
  res.json({ ok: true, stamina_bonus: bonus });
});

router.post('/gather-players/:userId/coins', (req, res) => {
  const delta = parseInt((req.body || {}).delta, 10);
  if (!Number.isFinite(delta) || delta === 0) return res.status(400).json({ error: '請填寫要增減的數量' });
  const uid = req.params.userId;
  const w = db.prepare('SELECT * FROM econ_wallets WHERE guild_id=? AND user_id=?').get(req.guildId, uid);
  if (!w) return res.status(404).json({ error: '找不到這位玩家的錢包' });
  // 不讓餘額變成負數，否則商店的「餘額不足」判斷會出現負數餘額的怪狀況
  const next = Math.max(0, w.coins + delta);
  db.prepare("UPDATE econ_wallets SET coins=?, updated_at=datetime('now','localtime') WHERE guild_id=? AND user_id=?")
    .run(next, req.guildId, uid);
  audit(req.user.name, `調整 ${w.username || uid} 的貨幣 ${delta > 0 ? '+' : ''}${delta}`);
  res.json({ ok: true, coins: next });
});


// ---- 設施商店（農地／溫室／牧場／孵化室的等級）----
const FAC_TYPES = ['field', 'greenhouse', 'ranch', 'hatch'];
router.get('/facilities', (req, res) => {
  res.json(db.prepare('SELECT * FROM facility_defs WHERE guild_id=? ORDER BY type, tier, id').all(req.guildId));
});
function facFields(b) {
  return {
    type: FAC_TYPES.includes(b.type) ? b.type : 'field',
    tier: int(b.tier, 1, 1), name: b.name || '', emoji: b.emoji || '',
    price: int(b.price, 0), slots: int(b.slots, 1, 0),
    speed_pct: Math.min(90, int(b.speed_pct, 0)), resist_pct: Math.min(100, int(b.resist_pct, 0)),
    description: b.description || '', sort: int(b.sort, 0), enabled: b.enabled ? 1 : 0
  };
}
router.post('/facilities', (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: '請填寫設施名稱' });
  const f = facFields(b);
  const dup = db.prepare('SELECT 1 FROM facility_defs WHERE guild_id=? AND type=? AND tier=?').get(req.guildId, f.type, f.tier);
  if (dup) return res.status(400).json({ error: '這個設施的這一階已經存在了，請改階級' });
  const r = db.prepare(
    `INSERT INTO facility_defs (guild_id,type,tier,name,emoji,price,slots,description,sort,enabled,speed_pct,resist_pct)
     VALUES (@guild_id,@type,@tier,@name,@emoji,@price,@slots,@description,@sort,@enabled,@speed_pct,@resist_pct)`
  ).run({ ...f, guild_id: req.guildId });
  audit(req.user.name, `新增設施：${b.name}`, 'gather');
  res.json({ id: r.lastInsertRowid });
});
router.put('/facilities/:id', (req, res) => {
  const f = facFields(req.body || {});
  db.prepare(
    `UPDATE facility_defs SET type=@type, tier=@tier, name=@name, emoji=@emoji, price=@price,
       slots=@slots, description=@description, sort=@sort, enabled=@enabled,
       speed_pct=@speed_pct, resist_pct=@resist_pct
     WHERE id=@id AND guild_id=@guild_id`
  ).run({ ...f, id: req.params.id, guild_id: req.guildId });
  audit(req.user.name, `修改設施 #${req.params.id}`, 'gather');
  res.json({ ok: true });
});
router.delete('/facilities/:id', (req, res) => {
  db.prepare('DELETE FROM facility_defs WHERE id=? AND guild_id=?').run(req.params.id, req.guildId);
  audit(req.user.name, `刪除設施 #${req.params.id}`, 'gather');
  res.json({ ok: true });
});

// ---- 一鍵清空玩家資料 ----
// 只清「玩家累積出來的東西」（錢包/背包/牧場/農地/進度…），
// 管理員設定好的內容（掉落物、道具、動物、地圖、獎池、商店、配方、任務定義）一律保留。
const PLAYER_TABLES = [
  'econ_wallets', 'gather_inventory', 'gather_user_tools', 'gather_cooldowns',
  'gather_user_map', 'gather_points', 'quest_progress', 'econ_transfers',
  'lottery_draws', 'luck_buffs', 'trades',
  'ranch_slots', 'ranch_steal', 'ranch_incubator', 'ranch_unlocks',
  'crop_plots', 'crop_unlocks', 'special_redeems', 'facility_owned',
  'aquarium_slots', 'aquarium_steal'
];
// 分區重置：管理員勾選要清哪幾塊（整個系統重來 vs 只把股市砍掉重練，需求完全不同）
const RESET_GROUPS = {
  wallet:    { label: '錢包與轉帳', tables: ['econ_wallets', 'econ_transfers'] },
  bag:       { label: '背包與工具', tables: ['gather_inventory', 'gather_user_tools', 'gather_cooldowns', 'gather_user_map', 'gather_points'] },
  quest:     { label: '任務與抽籤', tables: ['quest_progress', 'lottery_draws', 'luck_buffs'] },
  trade:     { label: '以物易物', tables: ['trades'] },
  ranch:     { label: '牧場與孵化室', tables: ['ranch_slots', 'ranch_steal', 'ranch_incubator', 'ranch_unlocks'] },
  crop:      { label: '農地與溫室', tables: ['crop_plots', 'crop_unlocks'] },
  aquarium:  { label: '魚缸', tables: ['aquarium_slots', 'aquarium_steal'] },
  facility:  { label: '設施等級', tables: ['facility_owned'] },
  shop:      { label: '兌換紀錄', tables: ['special_redeems'] },
  home:      { label: '家園／廚房／家具／寵物', tables: ['home_users', 'home_furniture_owned', 'pet_owned', 'cook_inventory', 'cook_queue', 'home_buffs', 'home_checkin'] },
  ach:       { label: '成就與圖鑑', tables: ['title_owned', 'dex_seen', 'ach_stats'] },
  affinity:  { label: '好感度與逛街體力', tables: ['affinity', 'stroll_stamina'] },
  stock:     { label: '股票持股與成交', tables: ['stock_holdings', 'stock_trades', 'stock_user_state', 'stock_violations'] },
  tax:       { label: '稅單與普發紀錄', tables: ['tax_records', 'tax_reliefs', 'tax_liquidations'] },
  loan:      { label: '貸款', tables: ['loans', 'loan_collaterals'] },
  charity:   { label: '捐款紀錄', tables: ['charity_donations'] },
  auction:   { label: '拍賣出價紀錄', tables: ['auction_bids'] },
  contest:   { label: '大賽分數', tables: ['contest_scores'] }
};

function wipeGroups(gid, groups, userId) {
  const picked = (Array.isArray(groups) ? groups : []).filter(g => RESET_GROUPS[g]);
  let cleared = 0;
  const detail = {};
  db.transaction(() => {
    for (const g of picked) {
      let n = 0;
      for (const t of RESET_GROUPS[g].tables) {
        try {
          n += userId
            ? db.prepare(`DELETE FROM ${t} WHERE guild_id=? AND user_id=?`).run(gid, userId).changes
            : db.prepare(`DELETE FROM ${t} WHERE guild_id=?`).run(gid).changes;
        } catch {
          // 有些表的欄位不是 user_id（trades 用 from_id/to_id、auction_bids 沒有 guild 專屬清法）
          try {
            n += userId
              ? db.prepare(`DELETE FROM ${t} WHERE guild_id=? AND (from_id=? OR to_id=?)`).run(gid, userId, userId).changes
              : db.prepare(`DELETE FROM ${t} WHERE guild_id=?`).run(gid).changes;
          } catch { /* 這張表沒有 guild_id 就跳過 */ }
        }
      }
      detail[RESET_GROUPS[g].label] = n;
      cleared += n;
    }
  })();
  return { cleared, detail, groups: picked };
}

function wipePlayers(gid, userId) {
  let cleared = 0;
  const tx = db.transaction(() => {
    for (const t of PLAYER_TABLES) {
      try {
        const r = userId
          ? db.prepare(`DELETE FROM ${t} WHERE guild_id=? AND user_id=?`).run(gid, userId)
          : db.prepare(`DELETE FROM ${t} WHERE guild_id=?`).run(gid);
        cleared += r.changes;
      } catch { /* 該表沒有 user_id（例如 trades 用 from_id/to_id）時略過 */ }
    }
    // trades 的欄位是 from_id/to_id，單人清除要另外處理
    if (userId) {
      try { cleared += db.prepare('DELETE FROM trades WHERE guild_id=? AND (from_id=? OR to_id=?)').run(gid, userId, userId).changes; } catch {}
      try { cleared += db.prepare('DELETE FROM econ_transfers WHERE guild_id=? AND (from_id=? OR to_id=?)').run(gid, userId, userId).changes; } catch {}
    }
  });
  tx();
  return cleared;
}

// 可勾選的重置項目清單（給前端畫勾選框）
router.get('/gather-reset-groups', (req, res) => {
  res.json(Object.entries(RESET_GROUPS).map(([key, g]) => ({ key, label: g.label, tables: g.tables.length })));
});

router.post('/gather-players/reset', (req, res) => {
  const b = req.body || {};
  // 有勾選就只清勾的；沒帶 groups＝維持舊行為（全部清空）
  if (Array.isArray(b.groups) && b.groups.length) {
    const r = wipeGroups(req.guildId, b.groups, b.user_id || null);
    audit(req.user.name, `分區重置${b.user_id ? `（玩家 ${b.user_id}）` : ''}：${r.groups.join('、')}（清除 ${r.cleared} 筆）`, 'gather');
    return res.json({ ok: true, cleared: r.cleared, detail: r.detail });
  }
  const cleared = wipePlayers(req.guildId, null);
  audit(req.user.name, `清空全部玩家資料（清除 ${cleared} 筆）`, 'gather');
  res.json({ ok: true, cleared });
});

router.delete('/gather-players/:userId', (req, res) => {
  const cleared = wipePlayers(req.guildId, req.params.userId);
  audit(req.user.name, `清空玩家 ${req.params.userId} 的資料（清除 ${cleared} 筆）`, 'gather');
  res.json({ ok: true, cleared });
});

// ---- 配方（製作 / 鍛造）----
const RKINDS = ['craft', 'forge'];
function recipeFields(b) {
  let mats = b.materials;
  if (typeof mats !== 'string') mats = JSON.stringify(mats || []);
  return {
    kind: RKINDS.includes(b.kind) ? b.kind : 'craft',
    name: b.name || '', emoji: b.emoji || '',
    result_type: ['tool', 'plot_field', 'plot_greenhouse', 'plot_ranch', 'plot_hatch', 'plot_aquarium'].includes(b.result_type) ? b.result_type : 'item',
    result_id: int(b.result_id, 0), result_count: int(b.result_count, 1, 1),
    materials: mats || '[]', cost: int(b.cost, 0),
    success_rate: Math.min(100, int(b.success_rate, 100)),
    fail_keep: b.fail_keep ? 1 : 0,
    description: b.description || '', enabled: b.enabled ? 1 : 0
  };
}
router.get('/gather-recipes', (req, res) => {
  res.json(db.prepare('SELECT * FROM gather_recipes WHERE guild_id=? ORDER BY kind, id').all(req.guildId));
});
router.post('/gather-recipes', (req, res) => {
  const f = recipeFields(req.body || {});
  if (!f.name) return res.status(400).json({ error: '請填寫配方名稱' });
  // 農地/溫室不需要產出目標物品
  if (f.result_type === 'item' || f.result_type === 'tool') { if (!f.result_id) return res.status(400).json({ error: '請選擇產出物品' }); }
  const info = db.prepare(
    `INSERT INTO gather_recipes (guild_id,kind,name,emoji,result_type,result_id,result_count,materials,cost,success_rate,fail_keep,description,enabled)
     VALUES (@guild_id,@kind,@name,@emoji,@result_type,@result_id,@result_count,@materials,@cost,@success_rate,@fail_keep,@description,@enabled)`
  ).run({ ...f, guild_id: req.guildId });
  audit(req.user.name, `新增配方：${f.name}`);
  res.json({ id: info.lastInsertRowid });
});
router.put('/gather-recipes/:id', (req, res) => {
  const f = recipeFields(req.body || {});
  if (!f.name) return res.status(400).json({ error: '請填寫配方名稱' });
  db.prepare(
    `UPDATE gather_recipes SET kind=@kind, name=@name, emoji=@emoji, result_type=@result_type, result_id=@result_id,
       result_count=@result_count, materials=@materials, cost=@cost, success_rate=@success_rate,
       fail_keep=@fail_keep, description=@description, enabled=@enabled WHERE id=@id AND guild_id=@guild_id`
  ).run({ ...f, id: req.params.id, guild_id: req.guildId });
  audit(req.user.name, `修改配方 #${req.params.id}`);
  res.json({ ok: true });
});
router.delete('/gather-recipes/:id', (req, res) => {
  db.prepare('DELETE FROM gather_recipes WHERE id=? AND guild_id=?').run(req.params.id, req.guildId);
  audit(req.user.name, `刪除配方 #${req.params.id}`);
  res.json({ ok: true });
});

// ---- 任務 ----
const PERIODS = ['daily', 'weekly', 'once'];
const GOALS = ['gather', 'rarity', 'item', 'sell', 'craft'];
function questFields(b) {
  return {
    name: b.name || '', description: b.description || '',
    period: PERIODS.includes(b.period) ? b.period : 'daily',
    goal_type: GOALS.includes(b.goal_type) ? b.goal_type : 'gather',
    goal_kind: KINDS.includes(b.goal_kind) ? b.goal_kind : '',
    goal_item: int(b.goal_item, 0),
    goal_rarity: RARITY.includes(b.goal_rarity) ? b.goal_rarity : '',
    goal_count: int(b.goal_count, 10, 1),
    reward_coins: int(b.reward_coins, 0),
    reward_item: int(b.reward_item, 0), reward_item_count: int(b.reward_item_count, 1, 1),
    reward_role: b.reward_role || '', daily_slots: int(b.daily_slots, 0),
    enabled: b.enabled ? 1 : 0
  };
}
router.get('/quests', (req, res) => {
  res.json(db.prepare('SELECT * FROM quests WHERE guild_id=? ORDER BY period, id').all(req.guildId));
});
router.post('/quests', (req, res) => {
  const f = questFields(req.body || {});
  if (!f.name) return res.status(400).json({ error: '請填寫任務名稱' });
  const info = db.prepare(
    `INSERT INTO quests (guild_id,name,description,period,goal_type,goal_kind,goal_item,goal_rarity,goal_count,
       reward_coins,reward_item,reward_item_count,reward_role,daily_slots,enabled)
     VALUES (@guild_id,@name,@description,@period,@goal_type,@goal_kind,@goal_item,@goal_rarity,@goal_count,
       @reward_coins,@reward_item,@reward_item_count,@reward_role,@daily_slots,@enabled)`
  ).run({ ...f, guild_id: req.guildId });
  audit(req.user.name, `新增任務：${f.name}`);
  res.json({ id: info.lastInsertRowid });
});
router.put('/quests/:id', (req, res) => {
  const f = questFields(req.body || {});
  if (!f.name) return res.status(400).json({ error: '請填寫任務名稱' });
  db.prepare(
    `UPDATE quests SET name=@name, description=@description, period=@period, goal_type=@goal_type,
       goal_kind=@goal_kind, goal_item=@goal_item, goal_rarity=@goal_rarity, goal_count=@goal_count,
       reward_coins=@reward_coins, reward_item=@reward_item, reward_item_count=@reward_item_count,
       reward_role=@reward_role, daily_slots=@daily_slots, enabled=@enabled WHERE id=@id AND guild_id=@guild_id`
  ).run({ ...f, id: req.params.id, guild_id: req.guildId });
  audit(req.user.name, `修改任務 #${req.params.id}`);
  res.json({ ok: true });
});
router.delete('/quests/:id', (req, res) => {
  db.prepare('DELETE FROM quests WHERE id=? AND guild_id=?').run(req.params.id, req.guildId);
  db.prepare('DELETE FROM quest_progress WHERE quest_id=? AND guild_id=?').run(req.params.id, req.guildId);
  audit(req.user.name, `刪除任務 #${req.params.id}`);
  res.json({ ok: true });
});

// ---- 指令權限與顯示範圍 ----
router.get('/gather-cmd-perms', (req, res) => {
  res.json(db.prepare('SELECT * FROM gather_cmd_perms WHERE guild_id=? ORDER BY rowid').all(req.guildId));
});
router.put('/gather-cmd-perms', (req, res) => {
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
  const up = db.prepare(
    `INSERT INTO gather_cmd_perms (guild_id,cmd,enabled,roles,private,admin_only) VALUES (?,?,?,?,?,?)
     ON CONFLICT(guild_id,cmd) DO UPDATE SET enabled=excluded.enabled, roles=excluded.roles,
       private=excluded.private, admin_only=excluded.admin_only`);
  const tx = db.transaction(() => {
    for (const r of rows) {
      if (!r || !r.cmd) continue;
      up.run(req.guildId, String(r.cmd), r.enabled ? 1 : 0, csvField(r.roles), r.private ? 1 : 0, r.admin_only ? 1 : 0);
    }
  });
  tx();
  audit(req.user.name, '修改遊戲指令權限');
  res.json({ ok: true });
});

// ---- 頻道開放：把「看得到頻道 + 能發言 + 能用 slash 指令」一次開給某個身分組 ----
// 玩家回報「遊戲不能玩」最常見的原因就是頻道少了「使用應用程式指令」權限，
// 這個權限沒開的話 slash 指令根本不會出現在輸入框，光看頻道權限很難察覺。
const F = PermissionsBitField.Flags;
const ACCESS_BITS = F.ViewChannel | F.SendMessages | F.ReadMessageHistory | F.UseApplicationCommands;

router.get('/gather-channel-access', async (req, res) => {
  const guild = bot.mainGuild(req.guildId);
  if (!guild) return res.json([]);
  const ids = String(guildConfig('gather_config', req.guildId).channels || '')
    .split(',').map(x => x.trim()).filter(Boolean);
  const out = [];
  for (const id of ids) {
    const ch = guild.channels.cache.get(id) || await guild.channels.fetch(id).catch(() => null);
    if (!ch) { out.push({ id, name: '（找不到頻道）', roles: [] }); continue; }
    const roles = [];
    for (const [rid, ow] of ch.permissionOverwrites.cache) {
      if (ow.type !== 0) continue;                       // 只看身分組的覆寫
      const role = guild.roles.cache.get(rid);
      const ok = (ow.allow.bitfield & ACCESS_BITS) === ACCESS_BITS;
      if (ok) roles.push({ id: rid, name: role ? role.name : rid });
    }
    out.push({ id, name: ch.name, roles });
  }
  res.json(out);
});

router.post('/gather-channel-access', async (req, res) => {
  const { channel_id, role_id, allow } = req.body || {};
  if (!channel_id || !role_id) return res.status(400).json({ error: '請選擇頻道與身分組' });
  const guild = bot.mainGuild(req.guildId);
  if (!guild) return res.status(503).json({ error: '機器人尚未上線' });
  const ch = guild.channels.cache.get(channel_id) || await guild.channels.fetch(channel_id).catch(() => null);
  if (!ch) return res.status(404).json({ error: '找不到頻道' });
  try {
    if (allow === false) {
      await ch.permissionOverwrites.delete(role_id, '後台移除遊戲頻道開放');
    } else {
      await ch.permissionOverwrites.edit(role_id, {
        ViewChannel: true, SendMessages: true, ReadMessageHistory: true, UseApplicationCommands: true
      }, { reason: '後台開放遊戲頻道給身分組' });
    }
    audit(req.user.name, `${allow === false ? '移除' : '開放'}頻道 #${ch.name} 給身分組 ${role_id}`);
    res.json({ ok: true });
  } catch (e) {
    // 最常見是機器人身分組位階不夠，或缺少「管理頻道」權限
    res.status(500).json({ error: e.message });
  }
});

// ---- 轉帳紀錄（稽核用）----
router.get('/econ-transfers', (req, res) => {
  res.json(db.prepare('SELECT * FROM econ_transfers WHERE guild_id=? ORDER BY id DESC LIMIT 200').all(req.guildId));
});

// ---- 地圖 ----
router.get('/gather-maps', (req, res) => {
  res.json(db.prepare('SELECT * FROM gather_maps WHERE guild_id=? ORDER BY sort, id').all(req.guildId));
});
function mapFields(b) {
  return {
    name: b.name || '', emoji: b.emoji || '', daily_limit: int(b.daily_limit, 10, 1), cost: int(b.cost, 1, 1),
    luck_bonus: Math.min(500, int(b.luck_bonus, 0)), is_default: b.is_default ? 1 : 0,
    sort: int(b.sort, 0), description: b.description || '', enabled: b.enabled ? 1 : 0
  };
}
// 只允許一張預設地圖
function clearDefault(gid, exceptId) {
  db.prepare('UPDATE gather_maps SET is_default=0 WHERE guild_id=? AND id<>?').run(gid, exceptId || 0);
}
router.post('/gather-maps', (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: '請填寫地圖名稱' });
  const f = mapFields(b);
  const r = db.prepare(
    `INSERT INTO gather_maps (guild_id,name,emoji,daily_limit,luck_bonus,is_default,sort,description,enabled,cost)
     VALUES (@guild_id,@name,@emoji,@daily_limit,@luck_bonus,@is_default,@sort,@description,@enabled,@cost)`
  ).run({ ...f, guild_id: req.guildId });
  if (f.is_default) clearDefault(req.guildId, r.lastInsertRowid);
  audit(req.user.name, `新增地圖：${b.name}`);
  res.json({ id: r.lastInsertRowid });
});
router.put('/gather-maps/:id', (req, res) => {
  const f = mapFields(req.body || {});
  db.prepare(
    `UPDATE gather_maps SET name=@name, emoji=@emoji, daily_limit=@daily_limit, cost=@cost, luck_bonus=@luck_bonus,
       is_default=@is_default, sort=@sort, description=@description, enabled=@enabled
     WHERE id=@id AND guild_id=@guild_id`
  ).run({ ...f, id: req.params.id, guild_id: req.guildId });
  if (f.is_default) clearDefault(req.guildId, req.params.id);
  audit(req.user.name, `修改地圖 #${req.params.id}`);
  res.json({ ok: true });
});
router.delete('/gather-maps/:id', (req, res) => {
  db.prepare('DELETE FROM gather_maps WHERE id=? AND guild_id=?').run(req.params.id, req.guildId);
  db.prepare('DELETE FROM gather_user_map WHERE guild_id=? AND map_id=?').run(req.guildId, req.params.id);
  audit(req.user.name, `刪除地圖 #${req.params.id}`);
  res.json({ ok: true });
});

// ---- 每日抽籤獎池 ----
const PRIZE_TYPES = ['coin', 'luck', 'jackpot'];
router.get('/lottery-prizes', (req, res) => {
  res.json(db.prepare('SELECT * FROM lottery_prizes WHERE guild_id=? ORDER BY sort, id').all(req.guildId));
});
function prizeFields(b) {
  const type = PRIZE_TYPES.includes(b.type) ? b.type : 'coin';
  return {
    name: b.name || '', emoji: b.emoji || '', type,
    // 用不到的欄位歸零，後台列表才不會顯示「幸運符還會給星幣」這種誤導資訊
    amount: type === 'luck' ? 0 : int(b.amount, 0),
    pct: type === 'coin' ? 0 : Math.min(500, int(b.pct, 0)),
    weight: int(b.weight, 10), sort: int(b.sort, 0), enabled: b.enabled ? 1 : 0
  };
}
router.post('/lottery-prizes', (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: '請填寫獎項名稱' });
  const r = db.prepare(
    `INSERT INTO lottery_prizes (guild_id,name,emoji,type,amount,pct,weight,sort,enabled)
     VALUES (@guild_id,@name,@emoji,@type,@amount,@pct,@weight,@sort,@enabled)`
  ).run({ ...prizeFields(b), guild_id: req.guildId });
  audit(req.user.name, `新增抽籤獎項：${b.name}`);
  res.json({ id: r.lastInsertRowid });
});
router.put('/lottery-prizes/:id', (req, res) => {
  db.prepare(
    `UPDATE lottery_prizes SET name=@name, emoji=@emoji, type=@type, amount=@amount,
       pct=@pct, weight=@weight, sort=@sort, enabled=@enabled
     WHERE id=@id AND guild_id=@guild_id`
  ).run({ ...prizeFields(req.body || {}), id: req.params.id, guild_id: req.guildId });
  audit(req.user.name, `修改抽籤獎項 #${req.params.id}`);
  res.json({ ok: true });
});
router.delete('/lottery-prizes/:id', (req, res) => {
  db.prepare('DELETE FROM lottery_prizes WHERE id=? AND guild_id=?').run(req.params.id, req.guildId);
  audit(req.user.name, `刪除抽籤獎項 #${req.params.id}`);
  res.json({ ok: true });
});

module.exports = router;
