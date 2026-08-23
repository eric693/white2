// 家園與成就後台 API（房屋階級／家具／廚房／料理／寵物／成就／好感度）
//
// 這一套原本完全沒有後台，所有數值都埋在程式的預設清單裡，管理員要調一個家具的加成
// 就得改程式重啟。這裡把它們全部開成 CRUD，權限 key＝home，可以單獨交給某個管理員。
const express = require('express');
const { db, audit, guildConfig } = require('../db');
const { requireAuth, guardModule } = require('../auth');
const { BUFF_TYPES } = require('../util/buffs');
const { METRICS } = require('../util/achievements');

const router = express.Router();
router.use(requireAuth(), guardModule('home'));

const int = (v, d = 0, min = -1e12) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(min, n) : d; };
const str = (v, d = '') => (v === undefined || v === null) ? d : String(v);
// 材料統一存成 [{item:"木材",count:80}]，用名稱比對 gather_items（改名不會斷，改錯才會）
const mats = (v) => {
  let a = v;
  if (typeof v === 'string') { try { a = JSON.parse(v); } catch { a = []; } }
  if (!Array.isArray(a)) a = [];
  return JSON.stringify(a
    .filter(x => x && x.item)
    .map(x => ({ item: String(x.item), count: Math.max(1, int(x.count, 1, 1)) })));
};
const buff = (v) => (v && BUFF_TYPES[v]) ? v : '';
// 好感階段數值：[{lv,min,max}]，由低到高。lv＝好感度階級門檻。
const tiers = (v) => {
  let a = v;
  if (typeof v === 'string') { try { a = JSON.parse(v); } catch { a = []; } }
  if (!Array.isArray(a)) a = [];
  return JSON.stringify(a
    .filter(x => x && x.lv !== undefined && x.lv !== null && x.lv !== '')
    .map(x => ({ lv: int(x.lv, 0, 0), min: int(x.min, 0, 0), max: int(x.max, 0, 0) }))
    .sort((p, q) => p.lv - q.lv));
};

// ---------- 給前端的選項清單 ----------
router.get('/home-meta', (req, res) => {
  res.json({
    buff_types: Object.entries(BUFF_TYPES).map(([key, label]) => ({ key, label })),
    metrics: Object.entries(METRICS).map(([key, m]) => ({ key, label: m.name, unit: m.unit || '', derived: !!m.derived })),
    items: db.prepare('SELECT name, emoji, kind FROM gather_items WHERE guild_id=? AND enabled=1 ORDER BY kind, price').all(req.guildId),
    titles: db.prepare('SELECT id, name, emoji FROM title_defs WHERE guild_id=? ORDER BY sort, id').all(req.guildId),
    // 同居能力：程式支援的 18 種行為（後台只能從這裡挑 code，新增能力要同時實作）
    abilities: (() => {
      const { ABILITIES, KIND_LABEL } = require('../bot/features/partnerskills');
      return Object.entries(ABILITIES).map(([code, a]) => ({
        code, name: a.name, kind: a.kind, kind_label: KIND_LABEL[a.kind] || a.kind,
        unit: a.unit, passive: a.passive || '', desc: a.desc
      }));
    })()
  });
});

// ---------- 總設定 ----------
router.get('/home-config', (req, res) => res.json(guildConfig('home_config', req.guildId)));

router.put('/home-config', (req, res) => {
  const b = req.body || {};
  guildConfig('home_config', req.guildId);
  db.prepare(
    `UPDATE home_config SET enabled=@enabled, title_slots=@title_slots, visit_enabled=@visit_enabled,
       gift_daily_limit=@gift_daily_limit, visit_daily_limit=@visit_daily_limit, buff_cap_pct=@buff_cap_pct,
       checkin_enabled=@checkin_enabled, checkin_base=@checkin_base, checkin_streak=@checkin_streak,
       checkin_max=@checkin_max, checkin_week=@checkin_week, checkin_home_pct=@checkin_home_pct,
       buy_mats_enabled=@buy_mats_enabled, buy_mats_mult=@buy_mats_mult,
       stroll_enabled=@stroll_enabled, stroll_stamina=@stroll_stamina, stroll_cost=@stroll_cost,
       stroll_points=@stroll_points,
       partner_enabled=@partner_enabled, partner_slots=@partner_slots, partner_level=@partner_level,
       partner_lv2=@partner_lv2, partner_lv3=@partner_lv3,
       pet_food_enabled=@pet_food_enabled, pet_food_price=@pet_food_price, pet_food_cost=@pet_food_cost
     WHERE guild_id=@guild_id`
  ).run({
    enabled: b.enabled ? 1 : 0,
    title_slots: int(b.title_slots, 3, 1),
    visit_enabled: b.visit_enabled ? 1 : 0,
    gift_daily_limit: int(b.gift_daily_limit, 5, 0),
    visit_daily_limit: int(b.visit_daily_limit, 3, 0),
    buff_cap_pct: int(b.buff_cap_pct, 30, 0),
    checkin_enabled: b.checkin_enabled ? 1 : 0,
    checkin_base: int(b.checkin_base, 500, 0),
    checkin_streak: int(b.checkin_streak, 100, 0),
    checkin_max: int(b.checkin_max, 7, 1),
    checkin_week: int(b.checkin_week, 3000, 0),
    checkin_home_pct: int(b.checkin_home_pct, 10, 0),
    buy_mats_enabled: b.buy_mats_enabled ? 1 : 0,
    buy_mats_mult: int(b.buy_mats_mult, 5000, 100),
    stroll_enabled: b.stroll_enabled ? 1 : 0,
    stroll_stamina: int(b.stroll_stamina, 10, 1),
    stroll_cost: int(b.stroll_cost, 1, 1),
    stroll_points: int(b.stroll_points, 3, 0),
    partner_enabled: b.partner_enabled ? 1 : 0,
    partner_slots: int(b.partner_slots, 1, 1),
    partner_level: int(b.partner_level, 6, 0),
    partner_lv2: int(b.partner_lv2, 8, 0),
    partner_lv3: int(b.partner_lv3, 12, 0),
    pet_food_enabled: b.pet_food_enabled ? 1 : 0,
    pet_food_price: int(b.pet_food_price, 500, 1),
    pet_food_cost: int(b.pet_food_cost, 1, 1),
    guild_id: req.guildId
  });
  audit(req.user.name, '更新家園設定');
  res.json({ ok: true });
});

// ---------- 通用 CRUD ----------
// 每張表列出「可以改哪些欄位、怎麼清洗」，其餘欄位一律不接受前端傳進來。
const TABLES = {
  'home-levels': {
    table: 'home_levels', order: 'level',
    fields: (b) => ({
      level: int(b.level, 1, 1), name: str(b.name), emoji: str(b.emoji), unlocks: str(b.unlocks),
      coins: int(b.coins, 0, 0), materials: mats(b.materials),
      furniture_cap: int(b.furniture_cap, 5, 0), pet_cap: int(b.pet_cap, 0, 0),
      kitchen_ok: b.kitchen_ok ? 1 : 0, visit_ok: b.visit_ok ? 1 : 0,
      home_buff_pct: int(b.home_buff_pct, 0, 0)
    })
  },
  'home-furniture': {
    table: 'home_furniture', order: 'sort, id',
    fields: (b) => ({
      category: ['living', 'bedroom', 'kitchen', 'garden', 'collection', 'special'].includes(b.category) ? b.category : 'living',
      name: str(b.name), emoji: str(b.emoji), price: int(b.price, 0, 0), materials: mats(b.materials),
      min_level: int(b.min_level, 1, 1), buff_type: buff(b.buff_type), buff_pct: int(b.buff_pct, 0, 0),
      description: str(b.description), sort: int(b.sort, 0, 0), enabled: b.enabled ? 1 : 0
    })
  },
  'home-pets': {
    table: 'pet_defs', order: 'sort, id',
    fields: (b) => ({
      name: str(b.name), emoji: str(b.emoji),
      rarity: ['N', 'R', 'SR', 'SSR', 'UR'].includes(b.rarity) ? b.rarity : 'N',
      min_level: int(b.min_level, 1, 1), price: int(b.price, 0, 0), materials: mats(b.materials),
      skill_name: str(b.skill_name), buff_type: buff(b.buff_type), buff_pct: int(b.buff_pct, 0, 0),
      // 能力分類；material 類要指定是哪一種素材（碎石＋X%），不能只寫「素材提升」
      category: ['guard', 'material', 'stock', 'sell', 'rare', 'speed', 'resist', 'affinity'].includes(b.category) ? b.category : '',
      target_item: str(b.target_item),
      feed_hours: int(b.feed_hours, 24, 1), description: str(b.description),
      sort: int(b.sort, 0, 0), enabled: b.enabled ? 1 : 0
    })
  },
  'home-achievements': {
    table: 'title_defs', order: 'sort, id',
    fields: (b) => ({
      cat: str(b.cat), name: str(b.name), emoji: str(b.emoji),
      // metric 有填＝任務式成就（挖礦幾次…）；留空＝沿用舊的收集型判定（用 cat 決定）
      metric: (b.metric && METRICS[b.metric]) ? b.metric : '',
      need: int(b.need, 0, 0),
      buff_type: buff(b.buff_type), buff_pct: int(b.buff_pct, 0, 0),
      buff2_type: buff(b.buff2_type), buff2_pct: int(b.buff2_pct, 0, 0),
      reward_coins: int(b.reward_coins, 0, 0), hint: str(b.hint), description: str(b.description || b.hint),
      sort: int(b.sort, 0, 0), enabled: b.enabled ? 1 : 0
    })
  },
  'home-kitchen-levels': {
    table: 'kitchen_levels', order: 'level',
    fields: (b) => ({
      level: int(b.level, 1, 1), name: str(b.name), emoji: str(b.emoji),
      coins: int(b.coins, 0, 0), materials: mats(b.materials),
      perfect_pct: int(b.perfect_pct, 0, 0), description: str(b.description)
    })
  },
  'home-recipes': {
    table: 'cook_recipes', order: 'sort, id',
    fields: (b) => ({
      name: str(b.name), emoji: str(b.emoji), min_kitchen: int(b.min_kitchen, 1, 1), materials: mats(b.materials),
      cook_minutes: int(b.cook_minutes, 30, 1), base_price: int(b.base_price, 0, 0),
      affinity_base: int(b.affinity_base, 0, 0), buff_type: buff(b.buff_type), buff_pct: int(b.buff_pct, 0, 0),
      buff_minutes: int(b.buff_minutes, 0, 0), description: str(b.description),
      sort: int(b.sort, 0, 0), enabled: b.enabled ? 1 : 0
    })
  },
  // 同居角色的能力池：勾選要開哪些、調 % 與被抽中的權重
  'home-partner-skills': {
    table: 'partner_skills', order: 'sort, id',
    fields: (b) => {
      const { ABILITIES } = require('../bot/features/partnerskills');
      const a = ABILITIES[str(b.code)] || null;
      return {
        name: str(b.name), code: a ? str(b.code) : '',
        // kind 與 buff_type 一律由 code 決定，避免後台改出程式看不懂的組合
        kind: a ? a.kind : 'buff', buff_type: a ? (a.passive || '') : buff(b.buff_type),
        val_min: int(b.val_min, 0, 0), val_max: int(b.val_max, 0, 0),
        tiers: tiers(b.tiers), description: str(b.description),
        skill: '', base_pct: 0, weight: int(b.weight, 10, 1),
        sort: int(b.sort, 0, 0), enabled: b.enabled ? 1 : 0
      };
    }
  },
  'home-affinity-levels': {
    table: 'affinity_levels', order: 'level',
    fields: (b) => ({
      level: int(b.level, 1, 1), name: str(b.name), need: int(b.need, 0, 0),
      reward: str(b.reward), title_id: int(b.title_id, 0, 0)
    })
  }
};

for (const [path, def] of Object.entries(TABLES)) {
  router.get('/' + path, (req, res) => {
    res.json(db.prepare(`SELECT * FROM ${def.table} WHERE guild_id=? ORDER BY ${def.order}`).all(req.guildId));
  });

  router.post('/' + path, (req, res) => {
    const f = def.fields(req.body || {});
    if ('name' in f && !f.name) return res.status(400).json({ error: '請填名稱' });
    const keys = Object.keys(f);
    const r = db.prepare(
      `INSERT INTO ${def.table} (guild_id, ${keys.join(',')}) VALUES (?, ${keys.map(() => '?').join(',')})`
    ).run(req.guildId, ...keys.map(k => f[k]));
    audit(req.user.name, `新增 ${path}：${f.name || f.level || r.lastInsertRowid}`);
    res.json({ id: r.lastInsertRowid });
  });

  router.put('/' + path + '/:id', (req, res) => {
    const f = def.fields(req.body || {});
    if ('name' in f && !f.name) return res.status(400).json({ error: '請填名稱' });
    const keys = Object.keys(f);
    const r = db.prepare(
      `UPDATE ${def.table} SET ${keys.map(k => `${k}=?`).join(',')} WHERE id=? AND guild_id=?`
    ).run(...keys.map(k => f[k]), req.params.id, req.guildId);
    if (!r.changes) return res.status(404).json({ error: '找不到這一筆' });
    audit(req.user.name, `修改 ${path}：${f.name || f.level || req.params.id}`);
    res.json({ ok: true });
  });

  router.delete('/' + path + '/:id', (req, res) => {
    const r = db.prepare(`DELETE FROM ${def.table} WHERE id=? AND guild_id=?`).run(req.params.id, req.guildId);
    if (!r.changes) return res.status(404).json({ error: '找不到這一筆' });
    audit(req.user.name, `刪除 ${path} #${req.params.id}`);
    res.json({ ok: true });
  });
}

// 把程式內建的預設能力池寫進資料庫（讓管理員可以在上面增刪改）
// 已經有同 code 的會跳過，不會覆蓋管理員調過的數值 —— 所以可以重複按（之後新增能力也靠它補進來）。
router.post('/home-partner-skills/seed', (req, res) => {
  const gid = req.guildId;
  const { seedSkills, DEFAULT_SKILLS } = require('../bot/features/partnerskills');
  const before = db.prepare('SELECT COUNT(*) n FROM partner_skills WHERE guild_id=?').get(gid).n;
  seedSkills(gid);
  const after = db.prepare('SELECT COUNT(*) n FROM partner_skills WHERE guild_id=?').get(gid).n;
  audit(req.user.name, `匯入同居能力預設池（新增 ${after - before} 種）`);
  res.json({ ok: true, count: after - before, total: DEFAULT_SKILLS.length });
});

// ---------- 角色 × 能力（後台勾選）----------
// 每位角色可以勾多個「候選能力」，玩家同居後只能從中選 1 個啟用。
// 一位角色一個都沒勾＝所有啟用中的能力都可選（新角色不必先設定就能用）。
router.get('/role-skills', (req, res) => {
  const gid = req.guildId;
  res.json({
    roles: db.prepare(
      'SELECT id, name, author, enabled FROM wheel_roles WHERE guild_id=? ORDER BY author, name').all(gid),
    skills: db.prepare(
      'SELECT id, name, code, kind, enabled FROM partner_skills WHERE guild_id=? ORDER BY sort, id').all(gid),
    picked: db.prepare('SELECT role_id, skill_id FROM role_skills WHERE guild_id=?').all(gid)
  });
});

// 設定某位角色的候選能力（整份覆蓋）。也可以帶 role_ids 一次套用到多位角色。
router.post('/role-skills', (req, res) => {
  const gid = req.guildId, b = req.body || {};
  const roleIds = (Array.isArray(b.role_ids) && b.role_ids.length ? b.role_ids : [b.role_id])
    .map(x => int(x, 0, 0)).filter(Boolean);
  if (!roleIds.length) return res.status(400).json({ error: '請指定角色' });
  const skillIds = (Array.isArray(b.skill_ids) ? b.skill_ids : []).map(x => int(x, 0, 0)).filter(Boolean);
  const del = db.prepare('DELETE FROM role_skills WHERE guild_id=? AND role_id=?');
  const ins = db.prepare('INSERT OR IGNORE INTO role_skills (guild_id,role_id,skill_id) VALUES (?,?,?)');
  db.transaction(() => {
    for (const rid of roleIds) { del.run(gid, rid); for (const sid of skillIds) ins.run(gid, rid, sid); }
  })();
  audit(req.user.name, `設定角色可用能力：${roleIds.length} 位角色 × ${skillIds.length} 種能力`);
  res.json({ ok: true, roles: roleIds.length, skills: skillIds.length });
});

// ---------- 逛街角色名單 ----------
// 轉盤裡不是「角色」的項目（模擬器、活動介紹）或不想出場的作者，可以整批排除。
router.get('/stroll-roles', (req, res) => {
  res.json(db.prepare(
    'SELECT id, name, author, enabled, stroll_ok FROM wheel_roles WHERE guild_id=? ORDER BY author, name').all(req.guildId));
});

router.post('/stroll-roles', (req, res) => {
  const b = req.body || {};
  const on = b.stroll_ok ? 1 : 0;
  let changed = 0;
  if (Array.isArray(b.ids) && b.ids.length) {
    const upd = db.prepare('UPDATE wheel_roles SET stroll_ok=? WHERE guild_id=? AND id=?');
    db.transaction(() => { for (const id of b.ids) changed += upd.run(on, req.guildId, int(id, 0, 0)).changes; })();
  } else if (b.author !== undefined && b.author !== null) {
    changed = db.prepare('UPDATE wheel_roles SET stroll_ok=? WHERE guild_id=? AND trim(author)=trim(?)')
      .run(on, req.guildId, String(b.author)).changes;
  } else if (b.all) {
    changed = db.prepare('UPDATE wheel_roles SET stroll_ok=? WHERE guild_id=?').run(on, req.guildId).changes;
  }
  audit(req.user.name, `${on ? '開放' : '排除'}逛街角色 ${changed} 位`);
  res.json({ ok: true, changed });
});

// 調整單一玩家的家園／廚房等級（例如把用便宜價硬升上去的退回來）
router.post('/home-players/:userId/level', (req, res) => {
  const b = req.body || {};
  const gid = req.guildId;
  const cur = db.prepare('SELECT * FROM home_users WHERE guild_id=? AND user_id=?').get(gid, req.params.userId);
  if (!cur) return res.status(404).json({ error: '這位玩家還沒有家園資料' });
  const maxLv = (db.prepare('SELECT MAX(level) m FROM home_levels WHERE guild_id=?').get(gid) || {}).m || 1;
  const maxK = (db.prepare('SELECT MAX(level) m FROM kitchen_levels WHERE guild_id=?').get(gid) || {}).m || 1;
  const level = Math.max(1, Math.min(maxLv, int(b.level, cur.level, 1)));
  const kitchen = Math.max(0, Math.min(maxK, int(b.kitchen_level, cur.kitchen_level, 0)));
  db.prepare('UPDATE home_users SET level=?, kitchen_level=?, kitchen_built=? WHERE guild_id=? AND user_id=?')
    .run(level, kitchen, kitchen > 0 ? 1 : 0, gid, req.params.userId);
  // 退款（可選）：退回玩家當初花的錢
  const refund = int(b.refund, 0, 0);
  if (refund > 0) {
    db.prepare("UPDATE econ_wallets SET coins = coins + ?, updated_at=datetime('now','localtime') WHERE guild_id=? AND user_id=?")
      .run(refund, gid, req.params.userId);
  }
  audit(req.user.name, `調整 ${req.params.userId} 的家園 Lv.${cur.level}→${level}、廚房 Lv.${cur.kitchen_level}→${kitchen}${refund ? `，退款 ${refund}` : ''}`);
  res.json({ ok: true, level, kitchen_level: kitchen, refund });
});

// ---------- 玩家現況（看得到誰在玩、誰帶了什麼成就）----------
router.get('/home-players', (req, res) => {
  const gid = req.guildId;
  res.json(db.prepare(
    `SELECT h.user_id, h.username, h.level, h.kitchen_level,
            (SELECT COUNT(*) FROM pet_owned p WHERE p.guild_id=h.guild_id AND p.user_id=h.user_id) pets,
            (SELECT COALESCE(SUM(placed),0) FROM home_furniture_owned f WHERE f.guild_id=h.guild_id AND f.user_id=h.user_id) furniture,
            (SELECT COUNT(*) FROM title_owned t WHERE t.guild_id=h.guild_id AND t.user_id=h.user_id) achievements,
            (SELECT COALESCE(total,0) FROM home_checkin c WHERE c.guild_id=h.guild_id AND c.user_id=h.user_id) checkins
       FROM home_users h WHERE h.guild_id=? ORDER BY h.level DESC, achievements DESC LIMIT 200`).all(gid));
});

// ---------- 角色禮物喜好 ----------
//
// affinity_prefs（角色 × 物品 → 權重）以前完全沒有後台，只能吃程式裡的預設值，
// 管理員看不到「這位角色喜歡什麼」，也沒辦法幫新角色調。權重就是送禮的倍率：
// 200＝💖最喜歡(×2)、150＝💕喜歡(×1.5)、100＝🤍普通、50＝💔討厭(×0.5)。
const PREF_LEVELS = [
  { weight: 200, label: '💖 最喜歡（×2）' },
  { weight: 150, label: '💕 喜歡（×1.5）' },
  { weight: 100, label: '🤍 普通（×1）' },
  { weight: 50, label: '💔 討厭（×0.5）' }
];

router.get('/gift-prefs', (req, res) => {
  const gid = req.guildId;
  const roles = db.prepare(
    'SELECT id, name, author FROM wheel_roles WHERE guild_id=? AND enabled=1 ORDER BY name').all(gid);
  // 可以送的東西＝有基礎好感的物品（禮物、手工禮物）
  const items = db.prepare(
    'SELECT name, emoji, gift_aff FROM gather_items WHERE guild_id=? AND gift_aff>0 ORDER BY gift_aff').all(gid);
  const prefs = db.prepare('SELECT role_id, item, weight FROM affinity_prefs WHERE guild_id=?').all(gid);
  res.json({ roles, items, prefs, levels: PREF_LEVELS });
});

// 存某一位角色的整份喜好（沒送到的品項＝普通，直接刪掉不留列）
router.post('/gift-prefs', (req, res) => {
  const gid = req.guildId;
  const roleId = int((req.body || {}).role_id, 0, 0);
  if (!roleId) return res.status(400).json({ error: '缺少角色' });
  const list = Array.isArray((req.body || {}).prefs) ? req.body.prefs : [];
  db.transaction(() => {
    db.prepare('DELETE FROM affinity_prefs WHERE guild_id=? AND role_id=?').run(gid, roleId);
    const ins = db.prepare('INSERT INTO affinity_prefs (guild_id,role_id,item,weight) VALUES (?,?,?,?)');
    for (const p of list) {
      const item = str(p && p.item).trim();
      const w = int(p && p.weight, 100, 0);
      if (!item || w === 100) continue;         // 普通就不用存
      ins.run(gid, roleId, item, Math.min(500, w));
    }
  })();
  const role = db.prepare('SELECT name FROM wheel_roles WHERE id=?').get(roleId);
  audit(req.user.name, `設定 ${role ? role.name : '#' + roleId} 的禮物喜好`, 'home', '', gid);
  res.json({ ok: true });
});

// 一鍵隨機：每位角色抽 3 個最喜歡、3 個喜歡、2 個討厭（手冊上寫的規格）
router.post('/gift-prefs/randomize', (req, res) => {
  const gid = req.guildId;
  const onlyEmpty = !!(req.body || {}).only_empty;
  const roles = db.prepare('SELECT id FROM wheel_roles WHERE guild_id=? AND enabled=1').all(gid);
  const items = db.prepare('SELECT name FROM gather_items WHERE guild_id=? AND gift_aff>0').all(gid).map(r => r.name);
  if (items.length < 8) return res.status(400).json({ error: '可送的禮物種類太少（至少要 8 種）' });
  const has = db.prepare('SELECT COUNT(*) n FROM affinity_prefs WHERE guild_id=? AND role_id=?');
  const del = db.prepare('DELETE FROM affinity_prefs WHERE guild_id=? AND role_id=?');
  const ins = db.prepare('INSERT INTO affinity_prefs (guild_id,role_id,item,weight) VALUES (?,?,?,?)');
  let done = 0;
  db.transaction(() => {
    for (const r of roles) {
      if (onlyEmpty && has.get(gid, r.id).n > 0) continue;
      const pool = items.slice().sort(() => Math.random() - 0.5);
      del.run(gid, r.id);
      pool.slice(0, 3).forEach(it => ins.run(gid, r.id, it, 200));
      pool.slice(3, 6).forEach(it => ins.run(gid, r.id, it, 150));
      pool.slice(6, 8).forEach(it => ins.run(gid, r.id, it, 50));
      done++;
    }
  })();
  audit(req.user.name, `隨機產生 ${done} 位角色的禮物喜好`, 'home', '', gid);
  res.json({ ok: true, roles: done });
});

module.exports = router;
