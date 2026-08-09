// 音樂系統（規格 9.1～9.21）
const {
  joinVoiceChannel, createAudioPlayer, createAudioResource, getVoiceConnection,
  AudioPlayerStatus, VoiceConnectionStatus, entersState, StreamType, NoSubscriberBehavior
} = require('@discordjs/voice');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, MessageFlags} = require('discord.js');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const ytdlp = require('../../util/ytdlp');
const { tempReply } = require('../../util/ephemeral');
const { db, guildConfig, activeGuildIds, logError } = require('../../db');
const { brandColor } = require('../../util/brand');
const { guard } = require('../perm');

const cfg = (gid) => guildConfig('music_config', gid);
const csv = (s) => String(s || '').split(/[\n,]/).map(x => x.trim()).filter(Boolean);

// 點歌搜尋選單的候選暫存：token -> { candidates, guildId, channelId, expires }
const pickCache = new Map();
setInterval(() => { const now = Date.now(); for (const [k, v] of pickCache) if (v.expires < now) pickCache.delete(k); }, 60000);

// guildId -> 佇列狀態
const queues = new Map();
function getQueue(guildId) {
  if (!queues.has(guildId)) {
    const c = cfg(guildId);
    queues.set(guildId, {
      conn: null, player: null, songs: [], history: [], loop: 'off',
      textCh: null, playing: false, paused: false,
      volume: c.default_volume, resource: null, startedAt: 0, pausedAt: 0, skipVotes: new Set()
    });
  }
  return queues.get(guildId);
}

const fmtDur = (sec) => {
  if (!sec || sec < 0) return '直播 / 未知';
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};

function logMusic(guildId, user, action, song, status = 'ok', error = '', channelId = '') {
  db.prepare(
    `INSERT INTO music_logs (guild_id, user_id, username, action, title, url, channel_id, status, error)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(guildId || '', user ? user.id : '', user ? user.username : '', action,
    song ? song.title : '', song ? song.url : '', channelId, status, error);
}

// ---- 9.21 權限判斷 ----
function hasRole(member, ids) {
  if (!ids.length) return true;                       // 未設定=全體
  return member.roles.cache.some(r => ids.includes(r.id));
}
function canRequest(member) { return hasRole(member, csv(cfg(member.guild.id).request_role_ids)); }
function canControl(member) {
  const c = cfg(member.guild.id);
  if (member.permissions.has('Administrator')) return true;
  const dj = csv(c.dj_role_ids);
  if (!dj.length) return true;
  return member.roles.cache.some(r => dj.includes(r.id));
}
// 9.2 只有管理員可讓機器人加入/退出語音
function canMoveBot(member) {
  const c = cfg(member.guild.id);
  if (member.permissions.has('Administrator') || member.permissions.has('ManageGuild')) return true;
  return member.roles.cache.some(r => csv(c.admin_role_ids).includes(r.id));
}

// 確認這首真的取得到音源；取不到就依序試備選 → 換平台重搜。
// 找到可播的就「就地取代」song 的欄位（佇列與稍後的嵌入訊息都會顯示實際播的那首）。
async function resolvePlayable(song) {
  // 報錯時要回報「原本那首歌」的失敗原因；備選來源的錯誤（例如 YouTube 要求登入）
  // 對點歌的人沒有意義，還會誤導他以為是自己貼錯連結。
  let firstErr, lastErr;
  const adopt = (s) => {
    console.log(`音源改用備選：「${song.title}」→「${s.title}」`);
    song.url = s.url; song.title = s.title;
    song.duration = s.duration; song.thumb = s.thumb;
    song.alts = [];
  };
  try { await ytdlp.getAudioUrl(song.url); return; } catch (e) { firstErr = lastErr = e; }

  for (const alt of (Array.isArray(song.alts) ? song.alts : [])) {
    if (!alt || !alt.url) continue;
    try { await ytdlp.getAudioUrl(alt.url); adopt(alt); return; } catch (e) { lastErr = e; }
  }

  // 同平台備選都不行 → 換另一個平台重搜（原本是關鍵字點歌才有 query，貼網址的就用標題找）
  // 歌單展開出來的曲目常常沒有標題，這種就別用「未知標題」去亂搜，直接讓它跳過。
  const query = song.query || (song.title && song.title !== '未知標題' ? song.title : '');
  if (query) {
    try {
      for (const s of await ytdlp.resolveFallback(query, song.requestedBy)) {
        try { await ytdlp.getAudioUrl(s.url); adopt(s); return; } catch (e) { lastErr = e; }
      }
    } catch (e) { lastErr = e; }
  }
  throw firstErr || lastErr || new Error('取不到音源網址');
}

// ---- 歌單存檔（重啟後可以接回去）----
// 歌單本來只存在記憶體，pm2 重啟、當機自動重啟、主機重開都會整個消失。
// 這裡把「目前這首＋待播清單＋循環模式＋音量＋所在頻道」寫進資料庫，開機時再接回來。
const saveState = (guildId) => {
  try {
    const q = queues.get(guildId);
    if (!q) return;
    // 只存必要欄位，thumb/alts 這些可以重新取得的就不佔空間
    const songs = q.songs.slice(0, 200).map(s => ({
      url: s.url, title: s.title, duration: s.duration, thumb: s.thumb || '',
      requestedBy: s.requestedBy || '', query: s.query || ''
    }));
    db.prepare(
      `INSERT INTO music_state (guild_id, voice_channel_id, text_channel_id, songs, loop, volume, updated_at)
       VALUES (@g, @v, @t, @s, @l, @vol, datetime('now','localtime'))
       ON CONFLICT(guild_id) DO UPDATE SET voice_channel_id=@v, text_channel_id=@t, songs=@s,
         loop=@l, volume=@vol, updated_at=datetime('now','localtime')`
    ).run({
      g: guildId,
      v: (q.conn && q.conn.joinConfig && q.conn.joinConfig.channelId) || '',
      t: (q.textCh && q.textCh.id) || '',
      s: JSON.stringify(songs), l: q.loop || 'off', vol: q.volume || 100
    });
  } catch {}
};

// 開機還原：把上次的歌單接回來並從第一首開始播（不會從中間續播，重新播該首）
async function restoreQueues(client) {
  const rows = db.prepare("SELECT * FROM music_state WHERE songs != '[]' AND songs != ''").all();
  for (const row of rows) {
    let songs = [];
    try { songs = JSON.parse(row.songs); } catch {}
    if (!Array.isArray(songs) || !songs.length) continue;
    if (!row.voice_channel_id) continue;

    const vch = client.channels.cache.get(row.voice_channel_id)
      || await client.channels.fetch(row.voice_channel_id).catch(() => null);
    if (!vch || !vch.guild) continue;

    const q = getQueue(row.guild_id);
    q.songs = songs;
    q.loop = row.loop || 'off';
    q.volume = row.volume || q.volume;
    if (row.text_channel_id) {
      q.textCh = client.channels.cache.get(row.text_channel_id)
        || await client.channels.fetch(row.text_channel_id).catch(() => null);
    }
    connect(vch.guild, vch.id);
    try { await entersState(q.conn, VoiceConnectionStatus.Ready, 15000); } catch { continue; }
    console.log(`  ↳ 已接回上次的播放清單（${songs.length} 首）：${vch.name}`);
    if (q.textCh) {
      q.textCh.send(`🔄 機器人重新啟動，已自動接回上次的播放清單（共 ${songs.length} 首），繼續播放。`).catch(() => {});
    }
    playNext(row.guild_id).catch(() => {});
  }
}

// ---- 播放核心 ----
// 連續失敗保護：整份清單都抓不到音源時（例如整批 SoundCloud 曲目被 DRM 鎖），
// 舊版會用遞迴在幾秒內把整個佇列跳完，錯誤紀錄和頻道都被洗版。
// 這裡改成連錯 MAX_FAILS 首就停下來報告一次，剩下的留在清單裡讓人自己決定。
const MAX_FAILS = 5;

async function playNext(guildId, failed = 0) {
  const q = getQueue(guildId);
  // 開始新的一首之前，先確定上一首的 yt-dlp / ffmpeg 真的收掉了。
  // 少了這行，播放失敗或重連時殘留的子程序會一直累積吃記憶體。
  killProcs(q);
  if (!q.songs.length) {
    q.playing = false; q.resource = null;
    saveState(guildId);
    updatePanel(guildId).catch(() => {});
    return;
  }
  if (!q.player || !q.conn || q.conn.state.status === VoiceConnectionStatus.Destroyed) {
    // 還沒連上語音就沒東西可播；硬播會被 catch 當成「播放失敗」而連鎖跳歌
    q.playing = false;
    return;
  }
  const song = q.songs[0];
  try {
    // 先驗證音源可取得（cookie/失效問題會在此立即拋出清楚的錯誤，不會卡住）
    // 失敗時不直接放棄：搜尋結果常有 DRM 保護／失效曲目，改用備選（同平台次相符）再試，
    // 全部用完才換另一個平台重搜（SoundCloud ⇄ YouTube）。換到的歌會就地取代佇列第一首。
    await resolvePlayable(song, q);
    // yt-dlp 抓串流（能正確處理 SoundCloud 的 HLS 分段）→ 管線餵給 ffmpeg 轉 48kHz PCM
    const dl = ytdlp.stream(song.url);
    const ff = spawn(ffmpegPath, [
      '-analyzeduration', '0', '-loglevel', '0',
      '-i', 'pipe:0', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'
    ], { stdio: ['pipe', 'pipe', 'ignore'] });
    dl.on('error', () => {});
    ff.on('error', () => {});
    ff.stdin.on('error', () => {});
    dl.pipe(ff.stdin);
    q._ff = ff; q._dl = dl;
    const resource = createAudioResource(ff.stdout, { inputType: StreamType.Raw, inlineVolume: true });
    resource.volume.setVolume(q.volume / 100);
    q.resource = resource;
    q.player.play(resource);
    q.playing = true; q.paused = false;
    q.startedAt = Date.now();
    q.skipVotes = new Set();
    saveState(guildId);

    if (q.textCh) {
      const embed = new EmbedBuilder().setColor(brandColor()).setTitle('正在播放')
        .setDescription(`[${song.title}](${song.url})`)
        .addFields(
          { name: '長度', value: fmtDur(song.duration), inline: true },
          { name: '點歌者', value: song.requestedBy, inline: true }
        );
      if (song.thumb) embed.setThumbnail(song.thumb);
      q.textCh.send({ embeds: [embed] }).catch(() => {});
    }
    updatePanel(guildId).catch(() => {});
  } catch (e) {
    // 9.19 播放失敗 → 顯示原因並自動跳下一首
    killProcs(q);
    logError(guildId, '播放失敗：', e.message);
    logMusic(guildId, null, 'fail', song, 'fail', e.message);
    const c = cfg(guildId);
    const ch = c.log_channel
      ? (q.textCh && q.textCh.client.channels.cache.get(c.log_channel)) || q.textCh
      : q.textCh;
    q.songs.shift();

    if (failed + 1 >= MAX_FAILS) {
      q.playing = false; q.resource = null;
      saveState(guildId);
      updatePanel(guildId).catch(() => {});
      if (ch) {
        ch.send(`⚠️ 連續 ${MAX_FAILS} 首都取不到音源（最後一次：${e.message}），已停止自動跳過。\n` +
          `待播清單還有 ${q.songs.length} 首，用 \`/skip\` 或 \`/play\` 繼續，或 \`/clear\` 清空。`).catch(() => {});
      }
      return;
    }
    if (ch) ch.send(`**${song.title}** 播放失敗（${e.message}），已自動跳過。`).catch(() => {});
    return playNext(guildId, failed + 1);
  }
}

// 收掉目前歌曲的 yt-dlp / ffmpeg 子程序
function killProcs(q) {
  try { if (q._dl && q._dl.proc) q._dl.proc.kill('SIGKILL'); } catch {}
  try { if (q._dl) q._dl.destroy(); } catch {}
  try { if (q._ff) q._ff.kill('SIGKILL'); } catch {}
  q._dl = null; q._ff = null;
}

// 同一首因為串流中斷而重試的次數（避免壞掉的音源無限重播）
const retried = new Map();
const RETRY_KEY = (gid, url) => `${gid}|${url}`;

function onIdle(guildId) {
  const q = getQueue(guildId);
  killProcs(q);
  const finished = q.songs[0];

  // 串流被切斷和歌正常播完，對播放器來說都只是「Idle」，分不出來就會被當成播完而跳下一首。
  // 這裡用「實際播了多久 vs 歌曲長度」判斷：明顯提早結束就是中斷。
  if (finished && q.playing && finished.duration > 0) {
    const played = Math.floor((Date.now() - q.startedAt) / 1000);
    if (played < finished.duration - 10) {
      const key = RETRY_KEY(guildId, finished.url);
      const n = retried.get(key) || 0;
      logMusic(guildId, null, 'cut', finished, 'fail',
        `串流提早結束：播了 ${played}s / 全長 ${finished.duration}s`);
      // 剛開始就斷掉（多半是抓串流失敗）→ 重試一次，從頭播對聽眾影響不大。
      // 播到一半才斷 → 不重播（整首重來更擾民），記錄下來就好。
      if (played < 15 && n < 1) {
        retried.set(key, n + 1);
        logError(guildId, '串流中斷，重試一次：', `${finished.title}（${played}s）`);
        return void playNext(guildId);
      }
    }
    retried.delete(RETRY_KEY(guildId, finished.url));
  }
  if (q.loop === 'track' && finished) {
    // 單曲循環：保持第一首
  } else if (q.loop === 'queue' && finished) {
    q.history.push(finished);
    q.songs.push(q.songs.shift());
  } else {
    if (finished) q.history.push(finished);
    q.songs.shift();
  }
  saveState(guildId);
  if (q.songs.length) playNext(guildId);
  else { q.playing = false; q.resource = null; updatePanel(guildId).catch(() => {}); }
}

// 建立/取得語音連線
// 播放器每個伺服器只建立一次並重複使用。
// 以前每次 connect() 都 new 一個 AudioPlayer，斷線重連時舊的播放器還掛著 Idle 監聽，
// 一旦它送出 Idle 就會讓 onIdle 把佇列往前推 → 表現出來就是「歌一直被跳掉」，
// 而且監聽器會隨著每次重連一直累積。
function ensurePlayer(guild) {
  const q = getQueue(guild.id);
  if (q.player) return q.player;
  q.player = createAudioPlayer({
    behaviors: {
      // 沒有訂閱者時繼續播（連線瞬斷不暫停），並容忍最多 ~10 秒的緩衝空檔再判定結束，
      // 避免 SoundCloud HLS 抓下一段的短暫延遲被誤判成「歌播完」而突然斷掉。
      noSubscriber: NoSubscriberBehavior.Play,
      maxMissedFrames: Math.round(10000 / 20)
    }
  });
  q.player.on(AudioPlayerStatus.Idle, () => onIdle(guild.id));
  q.player.on('error', e => { logError(guild.id, '播放器錯誤：', e.message); onIdle(guild.id); });
  return q.player;
}

function connect(guild, channelId) {
  const q = getQueue(guild.id);
  const player = ensurePlayer(guild);
  if (q.conn && q.conn.state.status !== VoiceConnectionStatus.Destroyed) {
    q.conn.subscribe(player);
    return q;
  }
  q.conn = joinVoiceChannel({
    channelId, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true
  });
  q.conn.subscribe(player);

  // 9.18 斷線自動重連
  q.conn.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(q.conn, VoiceConnectionStatus.Signalling, 5000),
        entersState(q.conn, VoiceConnectionStatus.Connecting, 5000)
      ]);
    } catch {
      const c = cfg(guild.id);
      const wasPlaying = q.playing;
      try { q.conn.destroy(); } catch {}
      q.conn = null;
      // 斷線後串流已經沒有出口，子程序留著只會一直吃記憶體（累積到 pm2 的 500MB 上限就整個重啟）
      killProcs(q);
      q.playing = false;
      if (c.stay_24_7 && c.voice_channel) {
        setTimeout(() => {
          try {
            connect(guild, c.voice_channel);
            // 重連後要把中斷的那首接回去播，否則會安靜地停在那裡
            if (wasPlaying && q.songs.length) playNext(guild.id).catch(() => {});
          } catch (e) { logError(guild.id, '語音重連失敗：', e.message); }
        }, 3000);
      }
    }
  });
  return q;
}

// ---- 9.17 固定控制面板 ----
function panelPayload(guildId) {
  const q = getQueue(guildId);
  const c = cfg(guildId);
  const song = q.songs[0];
  const embed = new EmbedBuilder().setColor(brandColor()).setTitle('音樂控制面板');

  if (song && q.playing) {
    const elapsed = Math.floor(((q.paused ? q.pausedAt : Date.now()) - q.startedAt) / 1000);
    const total = song.duration || 0;
    const ratio = total ? Math.min(1, elapsed / total) : 0;
    const bar = '▬'.repeat(Math.round(ratio * 14)) + '●' + '▬'.repeat(14 - Math.round(ratio * 14));
    embed.setDescription(`**[${song.title}](${song.url})**\n\`${bar}\`\n\`${fmtDur(elapsed)} / ${fmtDur(total)}\``)
      .addFields(
        { name: '點歌者', value: song.requestedBy, inline: true },
        { name: '音量', value: `${q.volume}%`, inline: true },
        { name: '循環', value: { off: '關閉', track: '單曲', queue: '整列' }[q.loop], inline: true }
      );
    if (song.thumb) embed.setThumbnail(song.thumb);
  } else {
    embed.setDescription('目前沒有播放中的歌曲。使用 `/play 歌名` 開始點歌（音源：SoundCloud）。')
      .addFields({ name: '音量', value: `${q.volume}%`, inline: true },
        { name: '循環', value: { off: '關閉', track: '單曲', queue: '整列' }[q.loop], inline: true });
  }
  const upcoming = q.songs.slice(1, 6).map((s, n) => `${n + 1}. ${s.title}`).join('\n');
  embed.addFields({ name: `待播清單（${Math.max(0, q.songs.length - 1)}）`, value: upcoming || '（空）' });
  if (c.stay_24_7) embed.setFooter({ text: '常駐模式已開啟' });

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('m:prev').setLabel('上一首').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('m:pause').setLabel(q.paused ? '繼續' : '暫停').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('m:skip').setLabel('下一首').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('m:stop').setLabel('停止').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('m:loop').setLabel('循環').setStyle(ButtonStyle.Secondary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('m:shuffle').setLabel('隨機').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('m:queue').setLabel('清單').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('m:voldown').setLabel('音量 −').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('m:volup').setLabel('音量 ＋').setStyle(ButtonStyle.Secondary)
  );
  return { embeds: [embed], components: [row1, row2] };
}

let clientRef = null;
async function updatePanel(guildId) {
  const c = cfg(guildId);
  if (!clientRef || !c.panel_channel || !c.panel_message) return;
  const ch = clientRef.channels.cache.get(c.panel_channel) || await clientRef.channels.fetch(c.panel_channel).catch(() => null);
  if (!ch) return;
  const msg = await ch.messages.fetch(c.panel_message).catch(() => null);
  if (!msg) return;
  await msg.edit(panelPayload(guildId)).catch(() => {});
}

// 後台呼叫：在指定頻道建立（或重建）唯一的控制面板
async function postPanel(client, channelId) {
  const ch = client.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
  if (!ch) throw new Error('找不到頻道');
  const guildId = ch.guild.id;
  const c = cfg(guildId);
  // 該伺服器只保留一則：先刪掉舊的
  if (c.panel_channel && c.panel_message) {
    const oldCh = client.channels.cache.get(c.panel_channel) || await client.channels.fetch(c.panel_channel).catch(() => null);
    if (oldCh) {
      const old = await oldCh.messages.fetch(c.panel_message).catch(() => null);
      if (old) await old.delete().catch(() => {});
    }
  }
  const msg = await ch.send(panelPayload(guildId));
  db.prepare('UPDATE music_config SET panel_channel=?, panel_message=? WHERE guild_id=?').run(channelId, msg.id, guildId);
  return msg.id;
}

// 9.18 啟動時回到常駐語音頻道（遍歷所有伺服器）
async function ensureResident(client) {
  for (const gid of activeGuildIds()) {
    const c = cfg(gid);
    if (!c.stay_24_7 || !c.voice_channel) continue;
    const ch = client.channels.cache.get(c.voice_channel) || await client.channels.fetch(c.voice_channel).catch(() => null);
    if (!ch || !ch.guild) continue;
    const existing = getVoiceConnection(ch.guild.id);
    if (existing && existing.state.status !== VoiceConnectionStatus.Destroyed) continue;
    connect(ch.guild, ch.id);
    console.log('  ↳ 已返回常駐語音頻道：' + ch.name);
  }
}

// ---- 搜尋 / 解析歌曲（9.1、9.4）由 yt-dlp 處理 ----
async function resolveSongs(query, requestedBy) {
  return ytdlp.resolve(query, requestedBy);
}

// 把歌加入佇列並在需要時開始播放，回傳給使用者看的訊息文字（URL 直接播、選單選歌都用這個）
async function addAndPlay(guildId, user, channelId, songs, playlist) {
  const q = getQueue(guildId), c = cfg(guildId);
  let added = songs;
  if (!c.allow_duplicate) {
    const exist = new Set(q.songs.map(s => s.url));
    added = songs.filter(s => !exist.has(s.url));
    if (!added.length) return '這首歌已在播放清單中，管理員已停用重複點歌。';
  }
  q.songs.push(...added);
  saveState(guildId);
  added.forEach(s => logMusic(guildId, user, 'play', s, 'ok', '', channelId));
  let text;
  if (!q.playing) {
    await playNext(guildId);
    if (!q.playing && !q.songs.length) {
      text = `無法播放：**${added[0].title}**。可能音源失效、DRM 保護，或 YouTube 要求登入。`;
    } else {
      text = playlist
        ? `▶ 已載入歌單 **${playlist}**，共 ${added.length} 首，開始播放。`
        : `▶ 開始播放：**${added[0].title}**　\`${fmtDur(added[0].duration)}\``;
    }
  } else {
    text = playlist
      ? `已加入歌單 **${playlist}**，共 ${added.length} 首（目前清單 ${q.songs.length - 1} 首待播）。`
      : `已加入清單：**${added[0].title}**　\`${fmtDur(added[0].duration)}\`　排隊第 ${q.songs.length - 1} 位`;
  }
  updatePanel(guildId).catch(() => {});
  return text;
}

function queueEmbed(q, page = 0) {
  const perPage = 10;
  const list = q.songs.slice(1);
  const pages = Math.max(1, Math.ceil(list.length / perPage));
  page = Math.min(Math.max(0, page), pages - 1);
  const slice = list.slice(page * perPage, page * perPage + perPage);
  const embed = new EmbedBuilder().setColor(brandColor()).setTitle('播放清單');
  const now = q.songs[0];
  embed.setDescription(
    (now ? `**正在播放**\n▶ [${now.title}](${now.url})　\`${fmtDur(now.duration)}\`　點歌：${now.requestedBy}\n\n` : '') +
    (slice.length
      ? slice.map((s, n) => `\`${page * perPage + n + 1}.\` ${s.title}　\`${fmtDur(s.duration)}\`　${s.requestedBy}`).join('\n')
      : '（後面沒有排隊歌曲）')
  );
  const totalSec = list.reduce((s, x) => s + (x.duration || 0), 0);
  embed.setFooter({ text: `第 ${page + 1}/${pages} 頁　共 ${list.length} 首　總長 ${fmtDur(totalSec)}　循環：${{ off: '關', track: '單曲', queue: '整列' }[q.loop]}` });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`mq:${page - 1}`).setLabel('上一頁').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
    new ButtonBuilder().setCustomId(`mq:${page + 1}`).setLabel('下一頁').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1)
  );
  return { embeds: [embed], components: [row] };
}

function init(client) {
  clientRef = client;
  // 先回常駐頻道，再把上次的歌單接回來
  ensureResident(client)
    .then(() => restoreQueues(client))
    .catch((e) => logError(null, '還原播放清單失敗：', e.message));
  // 面板每 10 秒同步一次播放進度，順便把歌單存檔
  // （移除、移動順序、循環模式、音量、清空等操作不必各自呼叫，這裡統一涵蓋）
  setInterval(() => {
    for (const [gid, q] of queues) {
      saveState(gid);
      if (q.playing) updatePanel(gid).catch(() => {});
    }
  }, 10000);

  client.on('interactionCreate', async (i) => {
    // ---- 點歌選單：使用者從搜尋結果選一首 ----
    if (i.isStringSelectMenu() && i.customId.startsWith('musicpick:')) {
      const entry = pickCache.get(i.customId.split(':')[1]);
      if (!entry) return i.update({ content: '這個點歌選單已過期，請重新 /play。', components: [] }).catch(() => {});
      pickCache.delete(i.customId.split(':')[1]);
      const song = entry.candidates[parseInt(i.values[0], 10)];
      if (!song) return i.update({ content: '選擇無效，請重新 /play。', components: [] }).catch(() => {});
      await i.update({ content: `已選擇：**${song.title}**，處理中…`, components: [] }).catch(() => {});
      try {
        const text = await addAndPlay(entry.guildId, i.user, entry.channelId, [song], null);
        await i.editReply({ content: text, components: [] }).catch(() => {});
      } catch (e) {
        await i.editReply({ content: '播放失敗：' + e.message, components: [] }).catch(() => {});
      }
      return;
    }

    // ---- 控制面板按鈕 ----
    if (i.isButton() && (i.customId.startsWith('m:') || i.customId.startsWith('mq:'))) {
      const q = getQueue(i.guildId);
      const act = i.customId.split(':')[1];

      if (i.customId.startsWith('mq:')) {
        return i.update(queueEmbed(q, parseInt(act, 10))).catch(() => {});
      }
      if (act === 'queue') return tempReply(i, { ...queueEmbed(q, 0) }, 15);

      if (!canControl(i.member)) {
        return tempReply(i, '你沒有控制播放的權限。', 6);
      }
      try {
        if (act === 'pause') {
          if (q.paused) { q.player.unpause(); q.paused = false; q.startedAt += Date.now() - q.pausedAt; }
          else { q.player.pause(); q.paused = true; q.pausedAt = Date.now(); }
        } else if (act === 'skip') {
          logMusic(i.guildId, i.user, 'skip', q.songs[0]); q.player.stop();
        } else if (act === 'prev') {
          const prev = q.history.pop();
          if (!prev) return tempReply(i, '沒有上一首歌曲。', 6);
          q.songs.unshift(prev); q.player.stop();
        } else if (act === 'stop') {
          q.songs = []; q.history = [];
          if (q.player) q.player.stop();
          logMusic(i.guildId, i.user, 'stop', null);
          const c = cfg(i.guildId);
          if (!c.stay_24_7 && q.conn) { q.conn.destroy(); q.conn = null; }
          q.playing = false;
        } else if (act === 'loop') {
          q.loop = { off: 'track', track: 'queue', queue: 'off' }[q.loop];
        } else if (act === 'shuffle') {
          // 9.11 只打亂尚未播放的部分
          const rest = q.songs.slice(1);
          for (let n = rest.length - 1; n > 0; n--) {
            const j = Math.floor(Math.random() * (n + 1));
            [rest[n], rest[j]] = [rest[j], rest[n]];
          }
          q.songs = [q.songs[0], ...rest].filter(Boolean);
        } else if (act === 'volup' || act === 'voldown') {
          const c = cfg(i.guildId);
          const step = act === 'volup' ? 10 : -10;
          q.volume = Math.min(c.max_volume, Math.max(0, q.volume + step));
          if (q.resource && q.resource.volume) q.resource.volume.setVolume(q.volume / 100);
        }
        await i.deferUpdate().catch(() => {});
        await updatePanel(i.guildId);
      } catch (e) {
        tempReply(i, '' + e.message, 6).catch(() => {});
      }
      return;
    }

    if (!i.isChatInputCommand()) return;
    const name = i.commandName;
    const MUSIC = ['play', 'skip', 'pause', 'resume', 'stop', 'loop', 'queue', 'np',
      'join', 'leave', 'volume', 'shuffle', 'remove', 'move', 'prev', 'clear'];
    if (!MUSIC.includes(name)) return;
    // 12.1～12.5 功能權限 / 頻道限制 / 黑名單
    if (!await guard('music', i)) return;
    const q = getQueue(i.guildId);
    const c = cfg(i.guildId);

    try {
      // ---- 9.2 管理員手動加入 / 退出語音 ----
      if (name === 'join') {
        if (!canMoveBot(i.member)) return tempReply(i, '僅管理員可讓機器人加入語音頻道。', 6);
        const vc = i.options.getChannel('頻道') || i.member.voice.channel;
        if (!vc) return tempReply(i, '請先加入語音頻道，或指定一個頻道。', 6);
        connect(i.guild, vc.id);
        q.textCh = i.channel;
        return i.reply(`已加入語音頻道 **${vc.name}**。`);
      }
      if (name === 'leave') {
        if (!canMoveBot(i.member)) return tempReply(i, '僅管理員可讓機器人退出語音頻道。', 6);
        if (q.conn) { q.conn.destroy(); q.conn = null; }
        q.songs = []; q.playing = false;
        return i.reply('已離開語音頻道。');
      }

      // ---- 9.1 / 9.3 / 9.4 點歌 ----
      if (name === 'play') {
        if (!canRequest(i.member)) return tempReply(i, '你沒有點歌權限。', 6);
        const query = i.options.getString('歌曲', true);
        await i.deferReply();

        // 機器人不在語音時：優先進「常駐頻道」，否則進點歌者所在的語音頻道（任何人都能點歌）
        if (!q.conn || q.conn.state.status === VoiceConnectionStatus.Destroyed) {
          const target = c.voice_channel || (i.member.voice.channel ? i.member.voice.channel.id : '');
          if (!target) return i.editReply('請先加入一個語音頻道再點歌，或請管理員在後台設定常駐語音頻道。');
          connect(i.guild, target);
        }
        q.textCh = i.channel;

        // 打歌名（非網址）→ 列出候選讓使用者自己選，避免點 A 跳 B
        if (!/^https?:\/\//.test(query)) {
          const candidates = await ytdlp.searchCandidates(query, i.user.username, 5);
          if (!candidates.length) return i.editReply('找不到這首歌，換個關鍵字，或直接貼 SoundCloud 連結。');
          const token = Math.random().toString(36).slice(2, 10);
          pickCache.set(token, { candidates, guildId: i.guildId, channelId: i.channelId, expires: Date.now() + 120000 });
          const menu = new StringSelectMenuBuilder()
            .setCustomId(`musicpick:${token}`)
            .setPlaceholder('選擇要播放的歌曲…')
            .addOptions(candidates.map((s, idx) => ({
              label: (s.title || '未知').slice(0, 95),
              description: fmtDur(s.duration),
              value: String(idx)
            })));
          return i.editReply({ content: `🔎 「${query}」找到這些，選一首播放：`, components: [new ActionRowBuilder().addComponents(menu)] });
        }

        // 網址 / 歌單 → 直接解析播放
        const { songs, playlist } = await resolveSongs(query, i.user.username);
        const text = await addAndPlay(i.guildId, i.user, i.channelId, songs, playlist);
        return i.editReply(text);
      }

      // 以下皆為控制類指令
      if (['skip', 'pause', 'resume', 'stop', 'loop', 'volume', 'shuffle', 'remove', 'move', 'prev', 'clear'].includes(name)
        && !canControl(i.member)) {
        // 9.7 未授權者：若開放投票跳過，skip 走投票流程
        if (!(name === 'skip' && c.vote_skip)) {
          return tempReply(i, '你沒有此音樂功能的權限。', 6);
        }
        const vc = i.member.voice.channel;
        const need = vc ? Math.ceil((vc.members.filter(m => !m.user.bot).size) / 2) : 1;
        q.skipVotes.add(i.user.id);
        if (q.skipVotes.size < need) {
          return i.reply(`投票跳過：${q.skipVotes.size}/${need} 票。`);
        }
        if (q.player) q.player.stop();
        return i.reply('投票通過，已跳過。');
      }

      if (name === 'skip') {
        if (!q.playing) return tempReply(i, '目前沒有播放中的歌曲。', 6);
        logMusic(i.guildId, i.user, 'skip', q.songs[0]);
        q.player.stop();
        await updatePanel(i.guildId);
        return i.reply('已跳過。');
      }
      // 9.8 上一首
      if (name === 'prev') {
        const prev = q.history.pop();
        if (!prev) return tempReply(i, '沒有上一首歌曲。', 6);
        q.songs.unshift(prev);
        if (q.playing) q.player.stop(); else await playNext(i.guildId);
        await updatePanel(i.guildId);
        return i.reply(`回到上一首：**${prev.title}**`);
      }
      // 9.6 暫停 / 繼續（保留進度）
      if (name === 'pause') {
        if (!q.playing || q.paused) return tempReply(i, '目前沒有正在播放的歌曲。', 6);
        q.player.pause(); q.paused = true; q.pausedAt = Date.now();
        await updatePanel(i.guildId);
        return i.reply('已暫停（進度保留）。');
      }
      if (name === 'resume') {
        if (!q.paused) return tempReply(i, '目前沒有暫停中的歌曲。', 6);
        q.player.unpause(); q.paused = false; q.startedAt += Date.now() - q.pausedAt;
        await updatePanel(i.guildId);
        return i.reply('▶ 已繼續播放。');
      }
      // 9.9 停止並清空
      if (name === 'stop') {
        q.songs = []; q.history = [];
        if (q.player) q.player.stop();
        q.playing = false;
        logMusic(i.guildId, i.user, 'stop', null);
        if (!c.stay_24_7 && q.conn) { q.conn.destroy(); q.conn = null; }
        await updatePanel(i.guildId);
        return i.reply(c.stay_24_7 ? '已停止並清空清單（常駐模式，留在語音頻道）。' : '已停止並離開語音頻道。');
      }
      // 9.10 循環
      if (name === 'loop') {
        q.loop = i.options.getString('模式', true);
        await updatePanel(i.guildId);
        return i.reply(`循環模式：**${{ off: '關閉', track: '單曲循環', queue: '整列循環' }[q.loop]}**`);
      }
      // 9.11 隨機
      if (name === 'shuffle') {
        const rest = q.songs.slice(1);
        for (let n = rest.length - 1; n > 0; n--) {
          const j = Math.floor(Math.random() * (n + 1));
          [rest[n], rest[j]] = [rest[j], rest[n]];
        }
        q.songs = [q.songs[0], ...rest].filter(Boolean);
        await updatePanel(i.guildId);
        return i.reply(`已隨機排列後續 ${rest.length} 首歌曲（不影響正在播放的歌）。`);
      }
      // 9.12 移除
      if (name === 'remove') {
        const pos = i.options.getInteger('順位');
        const user = i.options.getUser('玩家');
        if (user) {
          const before = q.songs.length;
          q.songs = q.songs.filter((s, idx) => idx === 0 || s.requestedBy !== user.username);
          await updatePanel(i.guildId);
          return i.reply(`已移除 ${user.username} 加入的 ${before - q.songs.length} 首歌曲。`);
        }
        if (!pos || pos < 1 || pos >= q.songs.length) return tempReply(i, '請提供有效的排隊順位。', 6);
        const [removed] = q.songs.splice(pos, 1);
        await updatePanel(i.guildId);
        return i.reply(`已移除第 ${pos} 首：**${removed.title}**`);
      }
      if (name === 'clear') {
        const n = Math.max(0, q.songs.length - 1);
        q.songs = q.songs.slice(0, 1);
        await updatePanel(i.guildId);
        return i.reply(`已清空待播清單（${n} 首）。`);
      }
      // 9.13 調整順序
      if (name === 'move') {
        const from = i.options.getInteger('從', true);
        const to = i.options.getInteger('到', true);
        if (from < 1 || from >= q.songs.length || to < 1 || to >= q.songs.length) {
          return tempReply(i, '順位超出範圍。', 6);
        }
        const [s] = q.songs.splice(from, 1);
        q.songs.splice(to, 0, s);
        await updatePanel(i.guildId);
        return i.reply(`↕ 已將 **${s.title}** 從第 ${from} 移到第 ${to} 位。`);
      }
      // 9.15 音量
      if (name === 'volume') {
        const v = i.options.getInteger('音量', true);
        if (v < 0 || v > c.max_volume) return tempReply(i, `音量需介於 0 ～ ${c.max_volume}。`, 6);
        q.volume = v;
        if (q.resource && q.resource.volume) q.resource.volume.setVolume(v / 100);
        await updatePanel(i.guildId);
        return i.reply(`音量已設為 **${v}%**`);
      }
      // 9.5 播放清單（分頁）
      if (name === 'queue') {
        if (!q.songs.length) return tempReply(i, '播放清單是空的。', 6);
        return i.reply(queueEmbed(q, 0));
      }
      // 9.14 目前播放資訊
      if (name === 'np') {
        const song = q.songs[0];
        if (!q.playing || !song) return tempReply(i, '目前沒有播放中的歌曲。', 6);
        const elapsed = Math.floor(((q.paused ? q.pausedAt : Date.now()) - q.startedAt) / 1000);
        const embed = new EmbedBuilder().setColor(brandColor()).setTitle('正在播放')
          .setDescription(`[${song.title}](${song.url})`)
          .addFields(
            { name: '進度', value: `${fmtDur(elapsed)} / ${fmtDur(song.duration)}`, inline: true },
            { name: '點歌者', value: song.requestedBy, inline: true },
            { name: '音量', value: `${q.volume}%`, inline: true },
            { name: '循環', value: { off: '關閉', track: '單曲', queue: '整列' }[q.loop], inline: true }
          );
        if (song.thumb) embed.setThumbnail(song.thumb);
        return i.reply({ embeds: [embed] });
      }
    } catch (e) {
      const msg = '' + e.message;
      logMusic(i.guildId, i.user, name, null, 'fail', e.message, i.channelId);
      if (i.deferred || i.replied) i.editReply(msg).catch(() => {});
      else tempReply(i, msg, 6).catch(() => {});
    }
  });

  client._postMusicPanel = (chId) => postPanel(client, chId);
  client._musicResident = () => ensureResident(client);
  console.log('  ↳ 音樂模組已載入（歌單/面板/音量/常駐/權限/紀錄）');
}

module.exports = { init, postPanel };
