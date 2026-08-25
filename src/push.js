// Web Push：玩家在 /play App「開啟推播」後，稅單/貸款/魚缸等事件就能推到手機。
// 訂閱資訊存 push_subscriptions（綁 guild+user）；推播失敗且是 404/410 就自動刪掉死訂閱。
const { db } = require('./db');

let webpush = null, ready = false;
try {
  webpush = require('web-push');
  const pub = process.env.VAPID_PUBLIC, pri = process.env.VAPID_PRIVATE;
  if (pub && pri) {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', pub, pri);
    ready = true;
  }
} catch (e) { ready = false; }

db.prepare(`CREATE TABLE IF NOT EXISTS push_subscriptions (
  guild_id TEXT NOT NULL, user_id TEXT NOT NULL, endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL, auth TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (endpoint)
)`).run();

const enabled = () => ready;
const publicKey = () => process.env.VAPID_PUBLIC || '';

function saveSubscription(gid, uid, sub) {
  if (!sub || !sub.endpoint || !sub.keys) return false;
  db.prepare(`INSERT INTO push_subscriptions (guild_id,user_id,endpoint,p256dh,auth) VALUES (?,?,?,?,?)
    ON CONFLICT(endpoint) DO UPDATE SET guild_id=excluded.guild_id, user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth`)
    .run(gid, uid, sub.endpoint, sub.keys.p256dh, sub.keys.auth);
  return true;
}
function removeByEndpoint(endpoint) {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').run(endpoint);
}
function hasSubscription(gid, uid) {
  return !!db.prepare('SELECT 1 FROM push_subscriptions WHERE guild_id=? AND user_id=? LIMIT 1').get(gid, uid);
}

// 推給某位玩家所有裝置。payload：{title, body, url, tag}
async function sendPush(gid, uid, payload) {
  if (!ready) return { sent: 0, skipped: 'push 未設定' };
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE guild_id=? AND user_id=?').all(gid, uid);
  let sent = 0; const tried = subs.length;
  const body = JSON.stringify({
    title: payload.title || '璃白冒險', body: payload.body || '', url: payload.url || '/play', tag: payload.tag || 'white2'
  });
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body);
      sent++;
    } catch (e) {
      if (e && (e.statusCode === 404 || e.statusCode === 410)) removeByEndpoint(s.endpoint);
    }
  }
  return { sent, tried };
}

module.exports = { enabled, publicKey, saveSubscription, removeByEndpoint, hasSubscription, sendPush };
