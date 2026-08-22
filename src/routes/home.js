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

// ---------- 給前端的選項清單 ----------
router.get('/home-meta', (req, res) => {
  res.json({
    buff_types: Object.entries(BUFF_TYPES).map(([key, label]) => ({ key, label })),
    metrics: Object.entries(METRICS).map(([key, m]) => ({ key, label: m.name, unit: m.unit || '', derived: !!m.derived })),
    items: db.prepare('SELECT name, emoji, kind FROM gather_items WHERE guild_id=? AND enabled=1 ORDER BY kind, price').all(req.guildId),
    titles: db.prepare('SELECT id, name, emoji FROM title_defs WHERE guild_id=? ORDER BY sort, id').all(req.guildId)
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
       partner_enabled=@partner_enabled, partner_slots=@partner_slots, partner_level=@partner_level
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
    fields: (b) => ({
      name: str(b.name), skill: b.skill === 'harvest' ? 'harvest' : '',
      buff_type: buff(b.buff_type), base_pct: int(b.base_pct, 0, 0),
      weight: int(b.weight, 10, 1), sort: int(b.sort, 0, 0), enabled: b.enabled ? 1 : 0
    })
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
router.post('/home-partner-skills/seed', (req, res) => {
  const gid = req.guildId;
  const { DEFAULT_PARTNER_SKILLS } = require('../bot/features/affinity');
  const has = db.prepare('SELECT COUNT(*) n FROM partner_skills WHERE guild_id=?').get(gid).n;
  if (has) return res.status(400).json({ error: '已經有能力設定了，請直接編輯（或先刪光再匯入）。' });
  const ins = db.prepare(
    'INSERT INTO partner_skills (guild_id,name,skill,buff_type,base_pct,weight,sort) VALUES (?,?,?,?,?,?,?)');
  db.transaction(() => {
    (DEFAULT_PARTNER_SKILLS || []).forEach((x, idx) =>
      ins.run(gid, x.name, x.skill || '', x.buff_type || '', x.base || 0, x.weight || 10, idx));
  })();
  audit(req.user.name, '匯入同居能力預設池');
  res.json({ ok: true, count: (DEFAULT_PARTNER_SKILLS || []).length });
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

module.exports = router;
