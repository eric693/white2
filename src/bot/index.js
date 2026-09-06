const { Client, GatewayIntentBits, Partials, MessageFlags } = require('discord.js');
const path = require('path');
const fs = require('fs');
const { getSetting, setSetting, ensureGuild, db, claimBotJobs, finishBotJob } = require('../db');
const { botRole, roleLabel, featuresFor, commandsFor, commandFeature, componentFeature, isButlerComponent } = require('./roles');
const { hasFeature, lockedMessage } = require('../subscription');
const { absUrl } = require('../util/url');
// 後台填的 emoji 只要有一顆 Discord 不認得，整個面板就送不出去（見 util/menu.js）——
// 啟動時先把過濾裝到 discord.js 的建構器上，所有選單與按鈕一律套用。
require('../util/menu').installEmojiGuard();

// 頭像存的是 /uploads/xxx 相對路徑；setAvatar 需要「本機檔路徑」或「完整網址」。
// 本機檔優先（不必連外），找不到才退回公開網址。
const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');
function resolveAvatar(v) {
  if (!v) return v;
  if (v.startsWith('/uploads/')) {
    const p = path.join(UPLOADS_DIR, path.basename(v));
    return fs.existsSync(p) ? p : absUrl(v);
  }
  return v;
}

// 指令即時註冊到某台伺服器：伺服器指令會「立刻」生效（全域指令要等最多 1 小時）。
// 訂閱付費牆（第一層）：方案沒包含的功能，指令直接不註冊到那台伺服器
// —— 玩家看不到、也點不到，比「點了才說要付費」乾淨。
// 到期／續費／後台改方案後，呼叫 refreshGuildCommands() 重新註冊即可生效。
function allowedCommands(guildId) {
  const role = botRole();
  return commandsFor(role).filter(c => {
    const key = commandFeature(c.name);
    return !key || hasFeature(guildId, role, key);
  });
}

async function registerGuildCommands(guildId, guildName) {
  try {
    const cmds = allowedCommands(guildId);
    await client.application.commands.set(cmds, guildId);
    console.log(`  ↳ 已即時註冊 ${cmds.length} 個指令到 ${guildName || guildId}`);
  } catch (e) { console.error(`註冊指令到 ${guildName || guildId} 失敗：`, e.message); }
}

// 訂閱狀態變動（續費、升降級、到期）後重新整理指令清單。
// 不傳 guildId ＝ 全部伺服器都重整（每日到期檢查用）。
async function refreshGuildCommands(guildId) {
  if (!client.application) return;
  const targets = guildId
    ? [client.guilds.cache.get(guildId)].filter(Boolean)
    : [...client.guilds.cache.values()];
  for (const g of targets) await registerGuildCommands(g.id, g.name);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

// 14 個功能模組各自監聽同一批事件，預設上限 10 會誤報記憶體洩漏警告
client.setMaxListeners(50);

let ready = false;

// 要載入的功能模組（每個匯出 init(client)）。
// 依 BOT_ROLE 只載入自己那一半：秘書＝功能型、管家＝遊戲型（見 roles.js）
const FEATURES = featuresFor();

client.once('clientReady', async () => {
  ready = true;
  console.log(`✅ Discord 機器人已上線：${client.user.tag}（角色：${roleLabel()}）`);
  // 多伺服器：把目前所在的每個伺服器登錄並初始化設定
  for (const [, g] of client.guilds.cache) {
    try { ensureGuild(g.id, g.name, g.iconURL() || ''); } catch (e) { console.error('登錄伺服器失敗：', e.message); }
  }
  console.log(`  ↳ 服務中的伺服器：${client.guilds.cache.size} 個`);
  for (const f of FEATURES) {
    try { require(`./features/${f}`).init(client); }
    catch (e) { console.error(`載入功能 ${f} 失敗：`, e.message); }
  }
  // 指令即時註冊：清掉全域那份（避免與伺服器指令重複顯示），改對每台所在伺服器直接註冊 → 立即生效
  try { await client.application.commands.set([]); } catch (e) { console.error('清除全域指令失敗：', e.message); }
  for (const [, g] of client.guilds.cache) await registerGuildCommands(g.id, g.name);
  applyAppearance().catch(() => {});
  startExpiryWatch();
  startJobWatch();
});

// ---- 跨行程工作佇列：後台（跑在另一隻的行程裡）交代給我做的事 ----
// 例：發布神秘商店面板。面板的下拉選單只有「發訊息的那個應用程式」收得到互動，
// 所以一定要由管家自己發，後台不能拿秘書的 client 代發。
// 功能模組用 client._jobHandlers[kind] = fn(payload) 登記自己接哪種工作。
function startJobWatch() {
  const role = botRole();
  setInterval(() => {
    let jobs;
    try { jobs = claimBotJobs(role); } catch { return; }
    for (const job of jobs) {
      const fn = client._jobHandlers && client._jobHandlers[job.kind];
      if (!fn) { finishBotJob(job.id, `這隻機器人不認得的工作：${job.kind}`); continue; }
      Promise.resolve().then(() => fn(job.payload))
        .then(out => finishBotJob(job.id, null, out))
        .catch(e => finishBotJob(job.id, e.message || String(e)));
    }
  }, 1500).unref?.();
}

// 訂閱到期自動限制：每天凌晨重新整理各伺服器的指令清單。
// 到期當下不需要做任何資料處理（判定端一律看 expires_at），這裡只是把
// 「已經不能用的付費指令」從 Discord 的指令列表拿掉，玩家才不會點了才被擋。
function startExpiryWatch() {
  const cron = require('node-cron');
  cron.schedule('5 0 * * *', () => {
    refreshGuildCommands().catch(e => console.error('到期重整指令失敗：', e.message));
  }, { timezone: process.env.TZ || 'Asia/Taipei' });
}

// 每一次「被邀請進伺服器」都記一筆：次數、時間、是哪一隻被邀的。
// 白名單擋下的那幾次也算——「有多少人邀請過」要看得出來，不能只留下核准的。
function recordInvite(g) {
  const { botRole } = require('./roles');
  const role = botRole() === 'both' ? 'butler' : botRole();
  const now = new Date().toLocaleString('sv-SE', { timeZone: process.env.TZ || 'Asia/Taipei' }).replace('T', ' ');
  db.prepare(`INSERT INTO guilds (guild_id, name, icon, active, approved, owner_id, invite_count, last_invite_at, invited_roles)
              VALUES (?, ?, ?, 0, 0, ?, 1, ?, ?)
              ON CONFLICT(guild_id) DO UPDATE SET
                name = excluded.name, icon = excluded.icon,
                owner_id = CASE WHEN excluded.owner_id != '' THEN excluded.owner_id ELSE guilds.owner_id END,
                invite_count = guilds.invite_count + 1,
                last_invite_at = excluded.last_invite_at`)
    .run(g.id, g.name, g.iconURL() || '', g.ownerId || '', now, role);
  // invited_roles 是逗號分隔的集合，同一隻重複邀不會重複記
  const cur = (db.prepare('SELECT invited_roles FROM guilds WHERE guild_id=?').get(g.id) || {}).invited_roles || '';
  const set = new Set(cur.split(',').filter(Boolean));
  if (!set.has(role)) {
    set.add(role);
    db.prepare('UPDATE guilds SET invited_roles=? WHERE guild_id=?').run([...set].join(','), g.id);
  }
}

// 被邀請進新伺服器 → 檢查白名單，未核准就自動退出（只給朋友使用）
client.on('guildCreate', async (g) => {
  try {
    const row = db.prepare('SELECT approved FROM guilds WHERE guild_id = ?').get(g.id);
    const openMode = getSetting('allow_any_guild', '0') === '1';   // 後台可切換為開放加入
    recordInvite(g);   // 先記一筆邀請（不論後面有沒有被擋下）

    if (!row && !openMode) {
      // 全新且未預先核准 → 記錄待審核，只通知「你自己的」管理頻道，不在對方伺服器留言。
      // （在別人伺服器「發訊息後立刻離開」會被 Discord 反濫發系統判定成廣告/濫發，導致機器人被標記）
      await notifyPendingGuild(g);
      await g.leave().catch(() => {});
      console.log(`⛔ 未授權的伺服器已自動退出（未留言）：${g.name}（${g.id}）— 可到後台核准後重新邀請`);
      return;
    }
    if (row && !row.approved && !openMode) {
      await notifyPendingGuild(g);
      await g.leave().catch(() => {});
      console.log(`⛔ 尚未核准的伺服器已自動退出（未留言）：${g.name}（${g.id}）`);
      return;
    }
    ensureGuild(g.id, g.name, g.iconURL() || '');
    db.prepare('UPDATE guilds SET owner_id = ?, approved = 1 WHERE guild_id = ?').run(g.ownerId || '', g.id);
    console.log(`➕ 加入新伺服器：${g.name}（${g.id}）`);
    await registerGuildCommands(g.id, g.name);   // 立即註冊指令，進伺服器馬上可用
  } catch (e) { console.error('初始化新伺服器失敗：', e.message); }
});

// 在「邀請機器人的那個伺服器」裡找一個機器人能發言的文字頻道
function firstSendableChannel(g) {
  const me = g.members.me;
  if (!me) return null;
  const can = (c) => c && c.isTextBased && c.isTextBased() && c.permissionsFor(me)?.has('SendMessages') && c.permissionsFor(me)?.has('ViewChannel');
  if (can(g.systemChannel)) return g.systemChannel;
  return g.channels.cache.filter(can).sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0)).first() || null;
}

// 有人邀請未授權的機器人 → 在對方伺服器留一則「請聯繫作者開通」訊息（內容可後台自訂）
async function notifyInvitingServer(g) {
  const ch = firstSendableChannel(g);
  if (!ch) return;
  const botName = (client.user && client.user.username) || '本機器人';
  const contact = getSetting('invite_contact')
    || '本機器人採邀請制，需先由作者開通後才能使用。請聯繫作者開通後再重新邀請，謝謝！';
  await ch.send(
    `👋 感謝邀請 **${botName}**！\n\n` +
    `⚠️ ${contact}\n\n` +
    `（未開通前機器人無法使用，將先自動離開；開通後重新邀請即可正常運作。）`
  ).catch(() => {});
}

// 有人邀請未授權的機器人 → 通知你的管理頻道
async function notifyPendingGuild(g) {
  const chId = getSetting('admin_channel');
  if (!chId) return;
  const ch = client.channels.cache.get(chId) || await client.channels.fetch(chId).catch(() => null);
  if (!ch) return;
  await ch.send(
    `🔔 **有人把機器人邀請到未授權的伺服器**\n` +
    `伺服器：**${g.name}**（\`${g.id}\`）\n` +
    `擁有者：<@${g.ownerId}>\n` +
    `成員數：${g.memberCount}\n` +
    `累計邀請次數：${(db.prepare('SELECT invite_count FROM guilds WHERE guild_id=?').get(g.id) || {}).invite_count || 1} 次\n\n` +
    `機器人已自動退出。若要允許，請到後台「伺服器管理」核准後再請對方重新邀請。`
  ).catch(() => {});
}
// 被移出伺服器 → 標記為停用（保留資料）
client.on('guildDelete', (g) => {
  try { db.prepare('UPDATE guilds SET active = 0 WHERE guild_id = ?').run(g.id); console.log(`➖ 已離開伺服器：${g.name}`); }
  catch {}
});

// 14.1 機器人名稱、頭像、狀態與活動
async function applyAppearance() {
  if (!client.user) return;
  // 兩隻機器人要能各自取名字、換頭像、設不同狀態，所以先讀角色專屬的設定；
  // 沒設定才退回舊的共用那組（單機器人時代留下來的值不會突然消失）。
  const role = botRole();
  const roleSetting = (key) => getSetting(`${key}_${role}`) || getSetting(key);

  const name = roleSetting('bot_name');
  if (name && client.user.username !== name) {
    try { await client.user.setUsername(name); } catch { console.warn('設定機器人名稱失敗（Discord 每小時限 2 次）'); }
  }
  // 頭像只在「設定值真的變了」才推上去。
  // 以前是每次啟動都無條件 setAvatar()，造成兩個問題：
  //   ① 直接在 Developer Portal 換的頭像，下次重啟就被這裡蓋回舊值
  //      （角色欄位空白時還會退回單機器人時代的共用那張，更容易誤會「換了又變回去」）
  //   ② 每次重啟都打一次 API，白白消耗 Discord 的頻率限制
  // 記住上次實際套用的值，一樣就跳過；想重推一次就把設定改一下再改回來。
  const avatar = roleSetting('bot_avatar');
  const appliedKey = `bot_avatar_applied_${role}`;
  if (avatar && getSetting(appliedKey) !== avatar) {
    try {
      await client.user.setAvatar(resolveAvatar(avatar));
      setSetting(appliedKey, avatar);
      console.log(`  ↳ 已更新 ${roleLabel(role)} 的頭像`);
    } catch (e) { console.warn('設定頭像失敗（Discord 有頻率限制，稍後會自動重試）：', e.message); }
  }

  const status = roleSetting('bot_status') || 'online';       // online | idle | dnd | invisible
  const text = roleSetting('bot_activity_text');
  const typeName = roleSetting('bot_activity_type') || 'Playing';
  const TYPES = { Playing: 0, Streaming: 1, Listening: 2, Watching: 3, Competing: 5 };
  try {
    client.user.setPresence({
      status,
      activities: text ? [{ name: text, type: TYPES[typeName] ?? 0 }] : []
    });
  } catch (e) { console.warn('設定機器人狀態失敗：', e.message); }
}

// ---- 訂閱付費牆（第二層）：執行時攔截 ----
// 為什麼還要這層：指令清單有 Discord 端快取，到期後玩家的舊清單可能還點得到；
// 面板按鈕／下拉選單更是發出去就一直留在頻道裡，不會因為退訂而消失。
//
// 這個 listener 在功能模組之前註冊（模組是 clientReady 後才 init），而 discord.js
// 的 emit 是同步的 —— 所以在這裡把 isChatInputCommand()/isButton() 就地改成回 false，
// 後面每個功能模組的 handler 都會直接略過這筆互動，不會出現「兩邊都回應」的錯誤。
function interactionFeature(i) {
  if (i.isChatInputCommand?.()) return commandFeature(i.commandName);
  return componentFeature(i.customId);
}

client.on('interactionCreate', (i) => {
  try {
    if (!i.guildId) return;                       // 私訊不擋
    if (!i.isChatInputCommand?.() && !i.isButton?.() && !i.isStringSelectMenu?.()) return;
    const key = interactionFeature(i);
    if (!key) return;                             // 沒對應到功能鍵＝基本功能，一律放行
    const role = botRole();
    if (hasFeature(i.guildId, role, key)) return;

    // 讓後面的功能模組完全略過這筆互動。
    // 用 defineProperty 而不是直接賦值：面板的「常用捷徑」會做一個 Object.create 分身，
    // 分身上的 isButton 若被定義成唯讀，直接賦值在非嚴格模式下會靜默失敗，
    // 下游模組就會照常處理已經被擋下的互動（重複回應）。
    for (const fn of ['isChatInputCommand', 'isButton', 'isStringSelectMenu', 'isAutocomplete']) {
      try { Object.defineProperty(i, fn, { value: () => false, writable: true, configurable: true }); }
      catch { i[fn] = () => false; }
    }
    i.reply({ content: lockedMessage(i.guildId, role, key), flags: MessageFlags.Ephemeral }).catch(() => {});
  } catch (e) { console.error('訂閱檢查失敗：', e.message); }
});

// ---- 互動回應診斷（INTERACTION_TRACE=1 開啟）----
// 症狀：玩家看到「應用程式沒有回應」，但 event loop 沒卡頓、Discord 也沒限流。
// 日誌裡同時出現 Unknown interaction 與 Interaction has already been acknowledged，
// 後者代表有兩處回應了同一筆互動 —— 但看不出是哪兩處。
//
// 這裡把每筆互動的 reply/update/defer/editReply 都包一層，記下呼叫來源（stack 上
// 第一個 features/*.js），第二次以後的回應就把「先前是誰回的、現在是誰要回」一起
// 寫進錯誤紀錄。查完把環境變數拿掉即可，平常完全不執行。
if (process.env.INTERACTION_TRACE === '1') {
  const RESPOND = ['reply', 'update', 'deferReply', 'deferUpdate', 'editReply', 'followUp', 'showModal'];
  const whoCalled = () => {
    const st = (new Error().stack || '').split('\n').slice(2);
    const hit = st.find(l => l.includes('/features/')) || st.find(l => l.includes('/bot/')) || st[0] || '';
    return hit.trim().replace(/^at\s+/, '').slice(0, 120);
  };
  // 送達延遲：互動由 Discord 建立（snowflake 時間）到這裡收到差多久。
  // 這是關鍵指標 —— 如果這個數字就已經接近 3 秒，那不管處理多快都來不及回應，
  // 問題在 gateway 送達，不在程式。
  const deliver = [];
  setInterval(() => {
    if (!deliver.length) return;
    deliver.sort((x, y) => x - y);
    const p50 = deliver[Math.floor(deliver.length / 2)];
    const p95 = deliver[Math.floor(deliver.length * 0.95)];
    const over = deliver.filter(x => x > 2500).length;
    require('../db').logError('', '互動送達延遲：',
      `${deliver.length} 筆｜中位 ${p50}ms｜p95 ${p95}ms｜最大 ${deliver[deliver.length - 1]}ms｜超過 2.5 秒 ${over} 筆`);
    deliver.length = 0;
  }, 60000).unref?.();

  client.on('interactionCreate', (i) => {
    if (i.__traced) return;                       // 面板的 Object.create 分身會繼承這個旗標
    try { Object.defineProperty(i, '__traced', { value: true, configurable: true }); } catch { return; }
    try { deliver.push(Math.max(0, Date.now() - i.createdTimestamp)); } catch {}
    const recvAt = Date.now();
    const calls = [];
    for (const fn of RESPOND) {
      const orig = typeof i[fn] === 'function' ? i[fn].bind(i) : null;
      if (!orig) continue;
      try {
        Object.defineProperty(i, fn, {
          value: async (...args) => {
            const from = whoCalled();
            calls.push(`${fn}@${from}`);
            // 從「收到互動」到「開始回應」花了多久：這段是我們自己的處理時間
            const since = Date.now() - recvAt;
            const what = i.isChatInputCommand?.() ? '/' + i.commandName : i.customId;
            if (calls.length === 1) {
              const t0 = Date.now();
              try {
                const out = await orig(...args);
                const spent = Date.now() - t0;
                if (since > 1500 || spent > 1500) {
                  require('../db').logError(i.guildId || '', '互動回應偏慢：',
                    `${what}｜收到→開始回應 ${since}ms｜回應呼叫耗時 ${spent}ms｜來源 ${from}`);
                }
                return out;
              } catch (err) {
                require('../db').logError(i.guildId || '', '互動回應失敗：',
                  `${what}｜收到→開始回應 ${since}ms｜呼叫耗時 ${Date.now() - t0}ms｜`
                  + `錯誤 ${err && err.code ? err.code : ''} ${err && err.message}｜來源 ${from}`);
                throw err;
              }
            }
            if (calls.length > 1) {
              require('../db').logError(i.guildId || '', '互動重複回應：',
                `${i.isChatInputCommand?.() ? '/' + i.commandName : i.customId}｜第 ${calls.length} 次：${calls.join('  ←  ')}`);
            }
            return orig(...args);
          },
          writable: true, configurable: true
        });
      } catch { /* 屬性鎖住就跳過這個方法 */ }
    }
  });
  console.log('  ↳ ⚠️  互動回應診斷已開啟（INTERACTION_TRACE=1），查完記得關掉');
}

// ---- 過期互動直接丟掉 ----
// Discord 的互動 token 只有 3 秒可以做第一次回應。斷線重連（RESUME）時，Gateway 會把
// 中斷期間的事件「補送」過來 —— 那些互動早就過期了，任何模組去回應都必然吃到
// 10062 Unknown interaction，玩家端也早就顯示「應用程式沒有回應」，我們回什麼都到不了。
//
// 以前這些過期互動照樣送進所有模組，於是每一則都變成一串錯誤紀錄（回應失敗、重複回應、
// 互動無回應），把真正的問題埋掉。這裡在事件分派之前就攔掉，只留一行彙總紀錄。
//
// 為什麼是攔 client.emit 而不是加一個 listener：listener 攔不住其他 listener，
// 二十幾個模組還是會各自跑一次。從 emit 這一層擋掉才是真的不分派。
const STALE_MS = 2500;               // 距離 token 到期只剩 0.5 秒才動手，已經來不及了
let staleCount = 0, staleWorst = 0;
// 機器人的時鐘可能跟 Discord 差幾百毫秒（甚至更多）。直接拿「現在 − 互動建立時間」當年齡，
// 時鐘一旦快了幾秒就會把**全部**互動判成過期，整隻機器人形同停擺。
// 所以用「最近看過的最小年齡」當基準線（正常送達只要幾十毫秒，那個最小值≈時鐘偏差），
// 只有比基準線再慢 STALE_MS 以上的才算真的過期。基準線每 5 分鐘重新量一次。
let baseAge = Infinity, baseAt = Date.now();
const origEmit = client.emit.bind(client);
client.emit = (name, ...args) => {
  if (name === 'interactionCreate') {
    const i = args[0];
    const born = i && i.createdTimestamp;
    const age = born ? Date.now() - born : 0;
    if (Date.now() - baseAt > 300000) { baseAge = Infinity; baseAt = Date.now(); }   // 定期重新量
    if (age < baseAge) baseAge = age;
    const lag = age - (Number.isFinite(baseAge) ? baseAge : 0);
    if (lag > STALE_MS) {
      staleCount++;
      if (lag > staleWorst) staleWorst = lag;
      return false;
    }
  }
  return origEmit(name, ...args);
};
// 丟掉的數量每分鐘彙總一次（有丟才記）——平常應該是 0，一直有就代表連線在抖
setInterval(() => {
  if (!staleCount) return;
  try {
    require('../db').logError('', '已丟棄過期互動：',
      `${staleCount} 筆（最慢的比正常送達晚了 ${Math.round(staleWorst / 1000)} 秒，多半是斷線重連時 Discord 補送的舊事件；`
      + '這些互動的 token 已失效，回應也送不到玩家端）');
  } catch {}
  staleCount = 0; staleWorst = 0;
}, 60000).unref?.();

// ---- 卡頓偵測 ----
// 「互動無回應」常常不是那個功能壞掉，而是整個 event loop 被別的同步工作卡住幾秒
// （SQLite 是同步的，結算／稅務／股市跑大批資料時會這樣）。這裡每 200ms 量一次延遲，
// 卡超過 1 秒就記一筆，並記下當下正在處理哪些互動——下次玩家喊「指令沒反應」就查得到元凶。
const LAG_TICK = 200, LAG_WARN = 1000;
let lastTick = Date.now(), peakLag = 0;
const inFlight = new Map();   // 互動 id → { what, user, at }
setInterval(() => {
  const now = Date.now();
  const lag = now - lastTick - LAG_TICK;
  lastTick = now;
  if (lag > peakLag) peakLag = lag;
  if (lag >= LAG_WARN) {
    const busy = [...inFlight.values()].map(x => x.what).slice(0, 5).join('、') || '（沒有進行中的互動，可能是排程工作）';
    try {
      require('../db').logError('', '機器人卡頓：', `event loop 停了 ${lag}ms，當下處理中的互動：${busy}`);
    } catch {}
  }
}, LAG_TICK).unref?.();

// ---- 舊面板轉接（拆成兩隻之後的遺留問題）----
// 拆分之前，遊戲面板是「舊的那一隻」發的 —— 那隻現在是秘書。那些訊息還留在
// 頻道裡，按鈕帶著 pan:／adv:／plantpick: 這類管家的元件 ID。玩家按下去時
// 互動送到秘書，但秘書沒載入遊戲模組，於是沒有任何 handler 回應，玩家要等
// 3 秒才看到「應用程式沒有回應」，而且完全不知道該怎麼辦。
//
// 這裡直接把這種互動接下來，明確告訴玩家舊面板已經換手、改用哪個指令。
// 只在秘書身上生效：管家本人當然要正常處理自己的按鈕。
client.on('interactionCreate', async (i) => {
  if (botRole() !== 'secretary') return;
  if (!i.isButton() && !i.isStringSelectMenu()) return;
  if (!isButlerComponent(i.customId)) return;
  // 神秘商店的面板是常駐在頻道裡的公開訊息，玩家自己重開沒有意義 —— 要請管理員到後台重新發布
  const shopPanel = ['sredeem', 'sqty'].includes(String(i.customId).split(':')[0]);
  try {
    await i.reply({
      content: shopPanel
        ? '🔄 **這個商店面板是舊版的，已經不能用了。**\n\n'
          + '神秘商店已經交給 **璃白Yu光管家** 負責，這則面板是舊機器人發的，選單接不到新的系統。\n'
          + '請改輸入 `/特殊商店` 直接兌換；也請管理員到後台把商店面板**重新發布**一次。'
        : '🔄 **這個面板是舊版的，已經不能用了。**\n\n'
        + '冒險遊戲已經交給 **璃白Yu光管家** 負責，這則訊息是舊機器人發的，按鈕接不到新的系統。\n'
        + '請改輸入 `/冒險面板` 重新開一個（面板是私人的，只有你看得到）。\n\n'
        + '－ 如果找不到指令，代表管家還沒被邀請進這個伺服器，請告訴管理員。',
      flags: MessageFlags.Ephemeral
    });
  } catch { /* 互動可能已逾時，略過 */ }
});

// ---- 互動看門狗：3 秒內沒有任何模組回應就記一筆，避免玩家只看到「應用程式沒有回應」卻查不到原因 ----
client.on('interactionCreate', (i) => {
  const what = i.isChatInputCommand() ? `/${i.commandName}`
    : (i.isButton() || i.isStringSelectMenu()) ? `元件 ${i.customId}` : null;
  if (!what) return;
  inFlight.set(i.id, { what, user: i.user?.username || i.user?.id, at: Date.now() });
  // 回應完就從「處理中」拿掉；沒回應的也在 5 秒後清掉，避免一直累積
  setTimeout(() => inFlight.delete(i.id), 5000);
  setTimeout(() => {
    if (i.replied || i.deferred) return;
    const { logError } = require('../db');
    logError(i.guildId || '', '互動無回應：',
      `${what}（使用者 ${i.user?.username || i.user?.id}，頻道 ${i.channelId}）｜同時卡住的互動 ${inFlight.size} 個，近期最大延遲 ${peakLag}ms`);
    peakLag = 0;
  }, 2800);
});

// ---- 穩定性防護：任何未捕捉的錯誤都不讓機器人整個掛掉 ----
process.on('unhandledRejection', (err) => {
  console.error('未處理的 Promise 錯誤：', err && err.stack ? err.stack : err);
  try { require('../db').logError('', '未處理的 Promise 錯誤：', (err && err.stack) ? err.stack.slice(0, 1500) : String(err)); } catch {}
});
process.on('uncaughtException', (err) => {
  console.error('未捕捉的例外：', err && err.stack ? err.stack : err);
  // 不 exit，交給 pm2 監控；嚴重錯誤 pm2 會自動重啟
});

// Discord 連線狀態監控
//
// 2026-09-01 事故：閘道連續回 503，discord.js 內部以每秒約 2 次的頻率重連且不退避，
// 機器人整整卡住兩分多鐘（玩家看到「未及時回應」），log 也被洗掉上萬行。
// 這裡加兩層防護：
//   ① 記錄節流：同樣的連線錯誤 30 秒內只印一次，並附上期間累積次數
//   ② 看門狗：持續連不上超過 3 分鐘就主動結束程序，讓 pm2 重啟
//      （實測手動重啟可立即恢復，所以自動化這個動作）
let lastConnLog = 0, connErrCount = 0;
let lastOnlineMs = Date.now();   // 最後一次確認連線正常的時間

function logConnIssue(kind, msg) {
  connErrCount++;
  const now = Date.now();
  if (now - lastConnLog < 30000) return;          // 30 秒內只印一次
  const extra = connErrCount > 1 ? `（30 秒內共 ${connErrCount} 次）` : '';
  console.error(`${kind}：${msg}${extra}`);
  lastConnLog = now; connErrCount = 0;
}

client.on('error', (e) => logConnIssue('Discord 連線錯誤', e.message));
client.on('shardError', (e) => logConnIssue('Discord shard 錯誤', e.message));
client.on('shardDisconnect', (ev, id) => logConnIssue('Discord 連線中斷', `shard ${id}，代碼 ${ev && ev.code}，將自動重連`));
client.on('shardReconnecting', (id) => logConnIssue('Discord 重新連線中', `shard ${id}`));
client.on('shardResume', (id, n) => {
  lastOnlineMs = Date.now(); lastConnLog = 0; connErrCount = 0;
  console.log(`✅ Discord 連線已恢復（shard ${id}，補回 ${n} 個事件）`);
});
client.on('shardReady', (id) => { lastOnlineMs = Date.now(); lastConnLog = 0; connErrCount = 0; });

// 看門狗：連不上超過 3 分鐘就重啟自己（pm2 會拉起來）
//
// ⚠️ 只有「真的嘗試過登入」之後才看門。沒設 Token 時 start() 會直接跳過登入，
// 這時 ws.status 永遠不是 READY —— 沒有這個判斷的話，行程會每 3 分鐘自殺一次，
// pm2 再把它拉起來，變成無限重啟迴圈。拆成兩隻機器人之後特別容易踩到：
// 先把管家的行程開起來、Token 還沒填好，就會一直重啟。
const STUCK_MS = 3 * 60 * 1000;
let loginAttempted = false;
setInterval(() => {
  if (!loginAttempted) return;
  if (!client.ws) return;
  // ws.status 0 = READY；其餘代表連線中／斷線中
  if (client.ws.status === 0) { lastOnlineMs = Date.now(); return; }
  if (Date.now() - lastOnlineMs > STUCK_MS) {
    console.error(`⛔ Discord 已連不上超過 ${STUCK_MS / 60000} 分鐘，主動重啟讓 pm2 重新拉起。`);
    process.exit(1);
  }
}, 30000).unref();

// 各角色自己的 token。優先序：後台設定 → 角色專屬環境變數 → 舊的 DISCORD_TOKEN。
// 後台優先是刻意的：改 token 不必再 SSH 上機器改 .env。
function roleToken() {
  const role = botRole();
  if (role === 'both') return getSetting('bot_token_butler') || process.env.DISCORD_TOKEN;
  const fromDb = getSetting(`bot_token_${role}`);
  if (fromDb) return fromDb;
  const envKey = role === 'secretary' ? 'DISCORD_TOKEN_SECRETARY' : 'DISCORD_TOKEN_BUTLER';
  return process.env[envKey] || process.env.DISCORD_TOKEN;
}

// OAuth 用的 Client ID / Secret 也照同一條優先序（/play 登入、後台邀請連結會用）
function roleClientId(role = botRole()) {
  return getSetting(`bot_client_id_${role === 'both' ? 'butler' : role}`) || process.env.DISCORD_CLIENT_ID || '';
}
function roleClientSecret(role = botRole()) {
  return getSetting(`bot_client_secret_${role === 'both' ? 'butler' : role}`) || process.env.DISCORD_CLIENT_SECRET || '';
}

function start() {
  const token = roleToken();
  if (!token || token === '你的機器人Token') {
    console.warn(`⚠️  尚未設定 ${roleLabel()} 的 Token，機器人未啟動（後台網站仍可使用）。請填好 .env 後重啟。`);
    return;
  }
  loginAttempted = true;
  client.login(token).catch(err => console.error('❌ 機器人登入失敗：', err.message));
}

function isReady() { return ready; }
// 指定 guildId 時回該伺服器，否則回主伺服器（相容舊呼叫）
// 傳空字串＝「這個帳號沒有任何可管理的伺服器」，必須回 null。
// 以前空字串會被 || 吃掉、退回 .env 的主伺服器，害客戶的後台顯示作者自己的伺服器名稱與人數。
// 只有完全沒傳參數（undefined/null）時才用主伺服器當預設。
function mainGuild(guildId) {
  const id = (guildId === undefined || guildId === null) ? process.env.GUILD_ID : guildId;
  return id ? client.guilds.cache.get(id) : null;
}
// 機器人目前所在的伺服器清單（供後台切換）
function guildList() {
  return [...client.guilds.cache.values()].map(g => ({
    id: g.id, name: g.name, icon: g.iconURL() || '', members: g.memberCount
  }));
}

// 取頻道物件（供各功能發送訊息）
async function fetchChannel(id) {
  if (!id) return null;
  try { return client.channels.cache.get(id) || await client.channels.fetch(id); }
  catch { return null; }
}

// 上傳自訂圖示為 Application Emoji，回傳可用於按鈕的 markup（<:name:id>）
async function uploadAppEmoji(buffer, rawName) {
  if (!client.application) throw new Error('機器人尚未上線');
  // emoji 名稱只能英數與底線，2~32 字
  let name = String(rawName || 'icon').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 28) || 'icon';
  name = 'w' + name + Date.now().toString(36).slice(-4); // 保證唯一
  const emoji = await client.application.emojis.create({ attachment: buffer, name });
  return { id: emoji.id, name: emoji.name, markup: `<:${emoji.name}:${emoji.id}>`, url: emoji.imageURL() };
}
async function deleteAppEmoji(emojiId) {
  if (!client.application) return;
  await client.application.emojis.delete(emojiId).catch(() => {});
}

module.exports = { client, start, isReady, mainGuild, refreshGuildCommands, roleClientId, roleClientSecret, guildList, applyAppearance, fetchChannel, uploadAppEmoji, deleteAppEmoji };
