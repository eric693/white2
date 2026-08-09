// 管理員後台：系統狀態、操作紀錄、功能權限（規格 11.4、11.5、12.1～12.5）
const express = require('express');
const { db, audit } = require('../db');
const { requireAuth, requireModule } = require('../auth');
const { FEATURES } = require('../bot/perm');
const bot = require('../bot');

const router = express.Router();
router.use(requireAuth());

const csvField = (v) => Array.isArray(v) ? v.join(',') : String(v || '');

// ---- 11.5 系統狀態監控 ----
router.get('/system/status', requireModule('system'), (req, res) => {
  const guild = bot.mainGuild(req.guildId);
  // 只統計「目前這台伺服器」的資料
  const count = (t) => { try { return db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE guild_id = ?`).get(req.guildId).n; } catch { return 0; } };
  res.json({
    bot: {
      online: bot.isReady(),
      guild: guild ? guild.name : '',
      guild_id: req.guildId || '',
      members: guild ? guild.memberCount : 0,
      uptime_seconds: Math.floor(process.uptime())
    },
    features: {
      keywords: count('keywords'),
      alert_rules: count('alert_rules'),
      announcements: count('announcements'),
      polls: count('polls'),
      giveaways: count('giveaways'),
      wheels: count('role_wheels'),
      wheel_roles: count('wheel_roles'),
      reminders: count('reminders'),
      birthdays: count('birthdays')
    },
    activity: {
      keyword_logs: count('keyword_logs'),
      alert_logs: count('alert_logs'),
      warnings: count('warnings'),
      mutes: count('mutes'),
      wheel_draws: count('wheel_draws'),
      music_logs: count('music_logs'),
      member_events: count('member_events')
    },
    // 本伺服器的錯誤 + 全站層級的錯誤（guild_id 空字串，如登入失敗、連線中斷）
    errors_24h: db.prepare(
      `SELECT COUNT(*) n FROM error_logs
        WHERE created_at > datetime('now','localtime','-1 day') AND (guild_id = ? OR guild_id = '')`
    ).get(req.guildId).n
  });
});

router.get('/system/errors', requireModule('system'), (req, res) => {
  // 本伺服器的錯誤 + 全站層級的錯誤（guild_id 空字串代表無法歸屬到單一伺服器）
  res.json(db.prepare(
    "SELECT * FROM error_logs WHERE guild_id = ? OR guild_id = '' ORDER BY id DESC LIMIT 200"
  ).all(req.guildId));
});

// ---- 11.4 操作紀錄 ----
router.get('/system/audit', requireModule('system'), (req, res) => {
  const kw = String(req.query.q || '').trim();
  const stmt = db.prepare(
    `SELECT * FROM audit_log WHERE guild_id = @g ${kw ? 'AND (actor LIKE @k OR action LIKE @k OR module LIKE @k)' : ''}
      ORDER BY id DESC LIMIT 300`
  );
  res.json(kw ? stmt.all({ g: req.guildId, k: `%${kw}%` }) : stmt.all({ g: req.guildId }));
});

// ---- 12.1～12.5 功能權限 ----
router.get('/perms', requireModule('perms'), (req, res) => {
  const rows = db.prepare('SELECT * FROM feature_perms WHERE guild_id = ?').all(req.guildId);
  res.json(FEATURES.map(f => {
    const r = rows.find(x => x.feature === f.key) || {};
    return {
      feature: f.key, label: f.label,
      role_ids: r.role_ids || '', channel_ids: r.channel_ids || '',
      except_user_ids: r.except_user_ids || '', except_role_ids: r.except_role_ids || '',
      enabled: r.enabled === undefined ? 1 : r.enabled
    };
  }));
});

router.put('/perms/:feature', requireModule('perms'), (req, res) => {
  const b = req.body || {};
  db.prepare(
    `INSERT INTO feature_perms (guild_id, feature, role_ids, channel_ids, except_user_ids, except_role_ids, enabled)
     VALUES (@guild_id,@feature,@role_ids,@channel_ids,@except_user_ids,@except_role_ids,@enabled)
     ON CONFLICT(guild_id, feature) DO UPDATE SET role_ids=excluded.role_ids, channel_ids=excluded.channel_ids,
       except_user_ids=excluded.except_user_ids, except_role_ids=excluded.except_role_ids,
       enabled=excluded.enabled`
  ).run({
    guild_id: req.guildId,
    feature: req.params.feature,
    role_ids: csvField(b.role_ids), channel_ids: csvField(b.channel_ids),
    except_user_ids: csvField(b.except_user_ids), except_role_ids: csvField(b.except_role_ids),
    enabled: b.enabled ? 1 : 0
  });
  audit(req.user.name, `更新「${req.params.feature}」功能權限`, 'perms', JSON.stringify(b));
  res.json({ ok: true });
});

module.exports = router;
