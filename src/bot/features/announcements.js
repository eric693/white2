// 公告系統（規格 7.1～7.12）
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const cron = require('node-cron');
const { db, logError } = require('../../db');
const { absUrl } = require('../../util/url');
const { brandColor, brandEmbed } = require('../../util/brand');
const { localNowMinute, parts } = require('../../util/time');
const { buildButtonRows } = require('../../util/components');
const { postToChannel } = require('../../util/post');
const reactionRoles = require('./reactionroles');

const csv = (s) => String(s || '').split(/[\n,]/).map(x => x.trim()).filter(Boolean);

// Discord 的 Embed 只接受完整的 http(s) 網址，塞進相對路徑或打錯的網址會直接拋錯、
// 導致整則公告發不出去（排程公告還會每分鐘重試一次）。這裡先過濾掉不合法的。
function safeUrl(u) {
  const v = absUrl(u);
  if (!v) return null;
  try { const p = new URL(v); return (p.protocol === 'http:' || p.protocol === 'https:') ? v : null; }
  catch { return null; }
}

// 公告要發送的頻道清單（7.5 多頻道，相容舊的單一 channel_id）
function targetChannels(ann) {
  const list = csv(ann.channels);
  if (!list.length && ann.channel_id) list.push(ann.channel_id);
  return list;
}

// 組出訊息內容（7.2 / 7.6）
function buildPayload(ann, channelId) {
  // 有設「頻道 ↔ 標記身分組」對應時，該頻道就只 @ 對應的身分組，
  // 沒對應到的頻道才退回公告本身的標記設定。
  let map = {};
  try { map = JSON.parse(ann.channel_mentions || '{}'); } catch {}
  const perChannel = channelId && map && typeof map === 'object' ? map[channelId] : undefined;
  const mentions = [];
  const roleIds = perChannel !== undefined ? csv(perChannel) : csv(ann.mention_role_ids);
  if (ann.mention_everyone) mentions.push('@everyone');
  if (ann.mention_here) mentions.push('@here');
  mentions.push(...roleIds.map(id => `<@&${id}>`));

  const payload = {
    allowedMentions: {
      parse: [
        ...(ann.mention_everyone || ann.mention_here ? ['everyone'] : [])
      ],
      roles: roleIds
    }
  };

  // 多張圖：第一張放主 embed，其餘用共用網址的額外 embed 組成圖庫（Discord 最多 10 個 embed）
  let imgs = [];
  try { imgs = JSON.parse(ann.images || '[]'); } catch {}
  if (!Array.isArray(imgs)) imgs = [];
  if (!imgs.length && ann.image_url) imgs = [ann.image_url];
  imgs = imgs.map(safeUrl).filter(Boolean);

  const extras = [ann.link_url, ann.video_url].filter(Boolean);
  if (ann.use_embed) {
    const GALLERY_URL = 'https://white.crownai.ink/';
    const main = brandEmbed();
    if (ann.title) main.setTitle(ann.title);
    if (ann.content) main.setDescription(ann.content);
    if (ann.link_url) main.addFields({ name: '連結', value: ann.link_url });
    // 單篇公告可自訂頁尾文字／縮圖，覆蓋 brandEmbed 的全站預設
    if (ann.footer) main.setFooter({ text: ann.footer });
    const thumb = safeUrl(ann.thumb);
    if (thumb) main.setThumbnail(thumb);
    // Discord 的規則：多個 embed 共用同一個 url 才會併成圖庫。但只要 embed 有 url，
    // 標題就會被畫成藍色超連結。所以多圖時不把 url 掛在主 embed 上，改成讓「圖片專用的
    // 附屬 embed」彼此共用 url —— 圖庫照樣成立，主 embed 的標題維持純文字。
    payload.embeds = [main];
    if (imgs.length === 1) {
      main.setImage(imgs[0]);
    } else if (imgs.length > 1) {
      // 前 4 張排成圖庫格狀，第 5 張以後依序堆疊；Discord 一則訊息最多 10 個 embed
      for (const url of imgs.slice(0, 9)) {
        payload.embeds.push(new EmbedBuilder().setURL(GALLERY_URL).setImage(url));
      }
    }
    payload.content = [mentions.join(' '), ann.video_url].filter(Boolean).join('\n') || undefined;
  } else {
    payload.content = [mentions.join(' '), ann.title ? `**${ann.title}**` : '', ann.content, ...imgs, ...extras]
      .filter(Boolean).join('\n') || '（無內容）';
  }

  // 7.2 多個連結按鈕（圖標＋文字），最多 25 個
  const rows = buildButtonRows(ann.buttons, { label: ann.btn_label, url: ann.btn_url });
  if (rows.length) payload.components = rows;
  return payload;
}

// 貼圖（sticker）：Discord 一則訊息最多 3 張，而且不能跟 Embed 放在同一則。
// 開了 Embed 的公告就把貼圖拆成緊接著的第二則訊息送出。
function stickerIds(ann) {
  let ids = [];
  try { ids = JSON.parse(ann.stickers || '[]'); } catch {}
  return (Array.isArray(ids) ? ids : []).map(String).filter(Boolean).slice(0, 3);
}

async function sendAnnouncement(client, ann) {
  const chans = targetChannels(ann);
  if (!chans.length) throw new Error('尚未指定發送頻道');
  const sent = [], failed = [], msgRefs = [];

  let rrMaps = [];
  try { rrMaps = JSON.parse(ann.reaction_roles || '[]'); } catch {}
  for (const id of chans) {
    const ch = client.channels.cache.get(id) || await client.channels.fetch(id).catch(() => null);
    if (!ch) { failed.push(`${id}（找不到頻道）`); continue; }
    try {
      const payload = buildPayload(ann, id);
      const stickers = stickerIds(ann);
      // 沒開 Embed 就直接夾帶；開了 Embed 只能另外補一則（Discord 不允許同一則訊息兩者並存）
      // 論壇/媒體頻道會自動改成「開一篇貼文」；貼圖補送則發進該貼文
      const msg = await postToChannel(ch, stickers.length && !ann.use_embed ? { ...payload, stickers } : payload, { title: ann.title || ann.note });
      if (stickers.length && ann.use_embed) {
        const target = (msg && msg.channel) ? msg.channel : ch;
        await target.send({ stickers, allowedMentions: { parse: [] } })
          .catch(e => logError(ann.guild_id, '公告貼圖發送失敗：', e.message));
      }
      sent.push(id);
      msgRefs.push({ channel_id: id, message_id: msg.id });
      // 表情身分組：機器人先按上表情，玩家跟著按取得身分組
      if (Array.isArray(rrMaps) && rrMaps.length) await reactionRoles.attach(msg, rrMaps);
    } catch (e) { failed.push(`${id}（${e.message}）`); }
  }

  // 7.10 發送紀錄
  db.prepare(
    `INSERT INTO announcement_logs (guild_id, ann_id, title, channels, status, error, creator)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(ann.guild_id || '', ann.id, ann.title || '', sent.join(','), failed.length ? 'fail' : 'ok', failed.join('；'), ann.creator || '');

  // 記下這次發出去的訊息位置，後台才能事後編輯（循環公告記最新一次）
  if (msgRefs.length) {
    db.prepare('UPDATE announcements SET sent_msgs=? WHERE id=?').run(JSON.stringify(msgRefs), ann.id);
  }

  // 循環公告發送後維持 repeating，只更新 last_run。
  // 但「已停止」的循環公告即使被手動發送一次，也要留在停止狀態，不能自己復活。
  if (ann.repeat_freq && ann.repeat_freq !== 'none') {
    db.prepare(
      `UPDATE announcements
          SET status = CASE WHEN status = 'stopped' THEN 'stopped' ELSE 'repeating' END,
              sent_at = datetime('now','localtime'), last_run = ?
        WHERE id = ?`
    ).run(localNowMinute(), ann.id);
  } else {
    db.prepare("UPDATE announcements SET status='sent', sent_at=datetime('now','localtime') WHERE id=?").run(ann.id);
  }

  if (!sent.length) throw new Error('全部頻道發送失敗：' + failed.join('；'));
  return { sent, failed };
}

// 編輯已發送的公告訊息。Discord 的提及通知只在送出那一刻推播，
// 編輯內容不會再標記一次 @everyone，所以改錯字不用重發、也不會再吵到大家。
async function editAnnouncement(client, ann) {
  let refs = [];
  try { refs = JSON.parse(ann.sent_msgs || '[]'); } catch {}
  if (!Array.isArray(refs) || !refs.length) {
    throw new Error('這則公告沒有可編輯的訊息紀錄（可能是舊版發送的，請重新發送一次後才能事後編輯）');
  }
  const edited = [], failed = [];
  for (const ref of refs) {
    const ch = client.channels.cache.get(ref.channel_id) || await client.channels.fetch(ref.channel_id).catch(() => null);
    if (!ch) { failed.push(`${ref.channel_id}（找不到頻道）`); continue; }
    try {
      const payload = buildPayload(ann, ref.channel_id);
      // 編輯時不要重新解析提及，避免 Discord 把它當成新的標記
      payload.allowedMentions = { parse: [], roles: [], users: [] };
      if (payload.components === undefined) payload.components = [];   // 舊按鈕要能被清掉
      if (payload.embeds === undefined) payload.embeds = [];
      // discord.js 遇到 undefined 會「保持原樣」，取消標記後舊的 @everyone 文字會殘留，
      // 所以明確給空字串讓它真的被清掉。
      if (payload.content === undefined) payload.content = '';
      const msg = await ch.messages.fetch(ref.message_id);
      await msg.edit(payload);
      edited.push(ref.channel_id);
    } catch (e) { failed.push(`${ref.channel_id}（${e.message}）`); }
  }

  db.prepare(
    `INSERT INTO announcement_logs (guild_id, ann_id, title, channels, status, error, creator)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(ann.guild_id || '', ann.id, `（編輯）${ann.title || ''}`, edited.join(','),
    failed.length ? 'fail' : 'ok', failed.join('；'), ann.creator || '');

  if (!edited.length) throw new Error('全部訊息編輯失敗：' + failed.join('；'));
  return { edited, failed };
}

// 7.4 這則循環公告現在是否該發送
function repeatDue(ann, now) {
  if (!ann.repeat_freq || ann.repeat_freq === 'none') return false;
  const nowMin = `${String(now.hh)}:${String(now.mm)}`;
  if (nowMin !== (ann.repeat_time || '09:00')) return false;
  if (ann.last_run === localNowMinute()) return false;   // 同一分鐘不重複發

  if (ann.repeat_freq === 'daily') return true;
  if (ann.repeat_freq === 'weekly') return now.dow === ann.repeat_dow;
  if (ann.repeat_freq === 'monthly') return now.d === ann.repeat_dom;
  if (ann.repeat_freq === 'custom') {
    const days = Math.max(1, ann.repeat_days || 1);
    if (!ann.last_run) return true;
    const last = new Date(ann.last_run.replace('T', ' ') + ':00+08:00').getTime();
    return (Date.now() - last) >= days * 86400000 - 60000;
  }
  return false;
}

// 正在發送中的公告 id。發送流程（多頻道＋掛表情身分組）可能超過一分鐘，
// 而排程 cron 每分鐘都會跑，沒有這道鎖就會在前一次還沒寫回狀態時又撿同一則來發，
// 造成同一則公告連續重複發送。
const sending = new Set();

// 一次性排程公告連續失敗的次數（例如頻道被刪、機器人被移除權限）。
// 沒有上限的話 cron 會每分鐘重試並寫一筆錯誤紀錄，洗版又看不出問題。
const failCount = new Map();
const MAX_FAIL = 3;

async function sendOnce(client, ann, label, giveUpAfterFail = false) {
  if (sending.has(ann.id)) return;          // 上一次還在發，這次跳過
  sending.add(ann.id);
  try {
    await sendAnnouncement(client, ann);
    failCount.delete(ann.id);
  } catch (e) {
    logError(ann.guild_id, label, e.message);
    const n = (failCount.get(ann.id) || 0) + 1;
    failCount.set(ann.id, n);
    // 一次性排程公告連錯 3 次 → 標為已停止，並補一筆發送紀錄讓管理員在後台看得到原因
    if (giveUpAfterFail && n >= MAX_FAIL) {
      db.prepare("UPDATE announcements SET status='stopped' WHERE id=?").run(ann.id);
      db.prepare(
        `INSERT INTO announcement_logs (guild_id, ann_id, title, channels, status, error, creator)
         VALUES (?, ?, ?, '', 'fail', ?, ?)`
      ).run(ann.guild_id || '', ann.id, ann.title || '',
        `連續 ${MAX_FAIL} 次發送失敗，已自動停止：${e.message}`, ann.creator || '');
      failCount.delete(ann.id);
    }
  } finally { sending.delete(ann.id); }
}

function init(client) {
  cron.schedule('* * * * *', async () => {
    const nowMinute = localNowMinute();
    const now = parts();

    // 7.3 一次性排程公告
    const due = db.prepare(
      "SELECT * FROM announcements WHERE status='scheduled' AND scheduled_at != '' AND scheduled_at <= ?"
    ).all(nowMinute);
    for (const ann of due) await sendOnce(client, ann, '排程公告發送失敗：', true);

    // 7.4 循環公告
    const repeating = db.prepare("SELECT * FROM announcements WHERE status='repeating'").all();
    for (const ann of repeating) {
      if (!repeatDue(ann, now)) continue;
      await sendOnce(client, ann, '循環公告發送失敗：');
    }
  });

  client._sendAnnouncement = (ann) => sendAnnouncement(client, ann);
  client._editAnnouncement = (ann) => editAnnouncement(client, ann);
  console.log('  ↳ 公告模組已載入（多頻道/標記/排程/循環/紀錄）');
}

module.exports = { init, sendAnnouncement, editAnnouncement, buildPayload, targetChannels };
