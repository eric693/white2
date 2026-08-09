// yt-dlp 音源引擎：搜尋、取 metadata、開音訊串流
// YouTube 對機房 IP 常要求登入驗證，將 cookie 檔路徑填入 .env 的 YT_COOKIES 即可繞過。
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const BIN = process.env.YTDLP_PATH || path.join(__dirname, '..', '..', 'bin', 'yt-dlp');
const COOKIES = process.env.YT_COOKIES || '';
// YouTube 需要 JS runtime 解 n-challenge，否則只拿得到圖片格式
const DENO = process.env.DENO_PATH || '/root/.deno/bin/deno';

function baseArgs() {
  const args = [];
  if (COOKIES && fs.existsSync(COOKIES)) args.push('--cookies', COOKIES);
  if (fs.existsSync(DENO)) args.push('--js-runtimes', `deno:${DENO}`);
  return args;
}
// 舊名稱相容
function cookieArgs() { return baseArgs(); }

// 執行 yt-dlp 並收集 stdout（JSON 或直連網址）
function run(args, { timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(BIN, [...baseArgs(), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('yt-dlp 逾時')); }, timeout);
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('error', e => { clearTimeout(t); reject(e); });
    p.on('close', code => {
      clearTimeout(t);
      if (code === 0) return resolve(out.trim());
      // 把 YouTube 反機器人訊息轉成看得懂的中文
      if (/Sign in to confirm|not a bot/i.test(err)) {
        return reject(new Error('此來源要求登入驗證，已跳過（請改用 SoundCloud 搜尋或貼 SoundCloud 連結）'));
      }
      reject(new Error((err.split('\n').find(l => l.startsWith('ERROR')) || 'yt-dlp 失敗').slice(0, 150)));
    });
  });
}

// 搜尋音源前綴：SoundCloud 不需 cookie、不被機房 IP 封鎖，作為預設搜尋來源
// 可用 .env 的 MUSIC_SEARCH 改（scsearch=SoundCloud、ytsearch=YouTube）
const SEARCH_PREFIX = process.env.MUSIC_SEARCH || 'scsearch';

// 搜尋結果相符度評分：越像使用者要的原曲分數越高（避免點 A 跳到翻唱/Remix/鋼琴版）
function scoreMatch(query, title) {
  const q = String(query).toLowerCase().trim();
  const t = String(title).toLowerCase();
  let score = 0;
  if (t.includes(q)) score += 100;                       // 完整包含歌名
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length) score += words.filter(w => t.includes(w)).length / words.length * 60; // 逐字命中比例
  // 非原曲/加工版本關鍵字大幅扣分
  if (/remix|cover|piano|instrumental|karaoke|伴奏|翻唱|純音樂|sped ?up|slowed|nightcore|8 ?d|bass ?boost|acoustic|\.mp3|mp3[_-]|earrape|reverb|mashup|\bdj\b|電音|电子|重低音|kalimba|music ?box/i.test(t)) score -= 55;
  if (t.length > q.length + 45) score -= 12;             // 過長的亂上傳略扣
  return score;
}

// yt-dlp entry → 歌曲物件
function mkSong(e, requestedBy) {
  return {
    url: e.webpage_url || e.url || (e.id ? `https://www.youtube.com/watch?v=${e.id}` : ''),
    title: e.title || '未知標題',
    duration: e.duration || 0,
    thumb: (e.thumbnails && e.thumbnails.length ? e.thumbnails[e.thumbnails.length - 1].url : e.thumbnail) || null,
    requestedBy
  };
}

// 搜尋 → 回傳「多筆候選」（依相符度排序），供 DC 上讓使用者自己選要哪一首。
async function searchCandidates(query, requestedBy, n = 5) {
  const raw = await run(['-J', '--no-warnings', '--flat-playlist', `${SEARCH_PREFIX}${Math.max(n, 8)}:${query}`], { timeout: 45000 });
  let data; try { data = JSON.parse(raw); } catch { return []; }
  if (!data.entries || !Array.isArray(data.entries)) return [];
  const songs = data.entries.filter(Boolean).map(e => mkSong(e, requestedBy)).filter(s => s.url);
  songs.sort((a, b) => scoreMatch(query, b.title) - scoreMatch(query, a.title));
  return songs.slice(0, n);
}

// 解析查詢 → 歌曲清單（單曲或歌單）。requestedBy 為點歌者名稱。
async function resolve(query, requestedBy) {
  const isUrl = /^https?:\/\//.test(query);
  // 非網址 → 搜尋抓多筆再挑最相符的；網址則直接解析（支援 SoundCloud / YouTube 連結）
  const target = isUrl ? query : `${SEARCH_PREFIX}8:${query}`;
  // 只有「真正的歌單頁」才展開：SoundCloud /sets/、YouTube 的 /playlist 頁。
  // 一般 watch?v=… 連結（即使後面掛 &list=RD… 自動電台）都只播那一首，
  // 避免被展開成 Mix/推薦電台（動輒數百首）。
  const isRealPlaylist = isUrl && (/\/sets\//.test(query) || /youtube\.com\/playlist/.test(query));
  const args = ['-J', '--no-warnings', '--flat-playlist'];
  if (isUrl && !isRealPlaylist) args.push('--no-playlist');
  const raw = await run([...args, target], { timeout: 45000 });
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error('無法解析搜尋結果'); }

  if (data.entries && Array.isArray(data.entries)) {
    let songs = data.entries.filter(Boolean).map(e => mkSong(e, requestedBy)).filter(s => s.url);
    if (!songs.length) throw new Error('找不到歌曲');
    // 搜尋 → 依相符度排序，只回「最相符的那一首」（避免一次塞多首、也避免跳錯歌）
    // 但把後幾名掛在 .alts 上：第一首若是 DRM 保護／失效曲目，播放端可自動換備選，不用直接報錯
    if (!isUrl) {
      songs = [...songs].sort((a, b) => scoreMatch(query, b.title) - scoreMatch(query, a.title));
      const top = songs[0];
      top.alts = songs.slice(1, 6);
      top.query = query;
      return { songs: [top] };
    }
    // 真正的歌單網址才算歌單
    return { songs, playlist: (data.title && data.entries.length > 1) ? data.title : null };
  }
  return { songs: [mkSong(data, requestedBy)] };
}

// 換一個音源平台重搜（預設 scsearch → 改用 ytsearch，反之亦然）。
// 用途：SoundCloud 那邊整批候選都是 DRM 保護時，最後一道退路。
async function resolveFallback(query, requestedBy, n = 3) {
  const other = SEARCH_PREFIX === 'ytsearch' ? 'scsearch' : 'ytsearch';
  const raw = await run(['-J', '--no-warnings', '--flat-playlist', `${other}${n}:${query}`], { timeout: 45000 });
  let data; try { data = JSON.parse(raw); } catch { return []; }
  if (!data.entries || !Array.isArray(data.entries)) return [];
  const songs = data.entries.filter(Boolean).map(e => mkSong(e, requestedBy)).filter(s => s.url);
  songs.sort((a, b) => scoreMatch(query, b.title) - scoreMatch(query, a.title));
  return songs.slice(0, n);
}

// 取得直連音訊網址（-g）。失敗（含 cookie 問題）會立即 throw，供播放前偵測。
async function getAudioUrl(url) {
  const out = await run(['-f', 'bestaudio/best', '--no-playlist', '--no-warnings', '-g', url], { timeout: 45000 });
  const first = out.split('\n').map(s => s.trim()).filter(Boolean)[0];
  if (!first) throw new Error('取不到音源網址');
  return first;
}

// 開啟音訊串流（回傳可讀 stream）。用 bestaudio 直接輸出到 stdout。
// 由 yt-dlp 負責抓串流，能正確處理 SoundCloud 的 HLS 分段（FFmpeg 直接抓 m3u8 在靜態 build 下不穩）。
// 回傳的 stream 上掛 .proc = 子行程，方便呼叫端在停止/跳過時確實 kill。
function stream(url) {
  const p = spawn(BIN, [
    ...baseArgs(),
    '-f', 'bestaudio/best',
    '--no-playlist', '--no-warnings',
    // 韌性：HLS 分段/網路偶爾失敗時重試，避免串流中途中斷讓歌「突然斷掉」
    '--retries', 'infinite',
    '--fragment-retries', 'infinite',
    '--file-access-retries', '5',
    '--socket-timeout', '15',
    '-o', '-', url
  ], { stdio: ['ignore', 'pipe', 'ignore'] });
  p.on('error', () => {});
  p.stdout.proc = p;
  return p.stdout;
}

function available() {
  return fs.existsSync(BIN);
}

module.exports = { resolve, resolveFallback, searchCandidates, stream, getAudioUrl, available, hasRuntime: () => fs.existsSync(DENO), hasCookies: () => !!(COOKIES && fs.existsSync(COOKIES)) };
