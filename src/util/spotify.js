// Spotify 連結支援（只讀歌曲資料，不從 Spotify 播音訊）
//
// Spotify 的 API 從來不提供完整音訊串流，任何機器人都拿不到 —— 市面上所有「支援
// Spotify」的音樂機器人做的都是同一件事：把 Spotify 連結轉成「歌名＋演出者」，
// 再去 SoundCloud／YouTube 找同一首播。這支檔案就是前半段。
//
// 資料來源用的是公開的 embed 頁（就是網頁上那個可嵌入的小播放器），裡面的
// __NEXT_DATA__ 帶了歌名、演出者與歌單曲目，不需要申請 API 金鑰、不需要登入。
// Spotify 改版時這裡會失效 —— 失效就回 null，呼叫端照原本的關鍵字搜尋走。

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const TIMEOUT_MS = 12000;
const MAX_TRACKS = 100;          // 一次最多載入幾首（歌單很長時避免灌爆佇列）

/** 是不是 Spotify 的網址 */
const isSpotifyUrl = (s) => /^https?:\/\/(open\.)?spotify\.com\//i.test(String(s || '').trim())
  || /^spotify:(track|album|playlist):/i.test(String(s || '').trim());

/** 從網址或 URI 取出種類與 ID */
function parseRef(input) {
  const s = String(input || '').trim();
  let m = s.match(/^spotify:(track|album|playlist):([A-Za-z0-9]+)/i);
  if (m) return { kind: m[1].toLowerCase(), id: m[2] };
  m = s.match(/spotify\.com\/(?:intl-[a-z-]+\/)?(track|album|playlist)\/([A-Za-z0-9]+)/i);
  if (m) return { kind: m[1].toLowerCase(), id: m[2] };
  return null;
}

async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8' }, signal: ctrl.signal });
    if (!res.ok) return '';
    return await res.text();
  } catch { return ''; }
  finally { clearTimeout(timer); }
}

/** 把 embed 頁裡的 __NEXT_DATA__ 挖出來 */
function nextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

// 「歌名 演出者」＝ 拿去別的平台搜尋的關鍵字。
// 演出者可能是 "A, B, C"，只取第一位就夠了 —— 帶太多人名反而找不到。
const searchQuery = (title, artist) => [String(title || '').trim(), String(artist || '').split(/[,、]/)[0].trim()]
  .filter(Boolean).join(' ');

/**
 * 解析一個 Spotify 連結。
 * 回傳 { kind, name, tracks: [{ title, artist, query }] }；解析不出來回 null。
 */
async function resolve(input) {
  const ref = parseRef(input);
  if (!ref) return null;
  const data = nextData(await fetchText(`https://open.spotify.com/embed/${ref.kind}/${ref.id}`));
  const entity = data && data.props && data.props.pageProps && data.props.pageProps.state
    && data.props.pageProps.state.data && data.props.pageProps.state.data.entity;
  if (!entity) return null;

  const name = entity.name || entity.title || '';
  // 單曲：entity 本身就是那首歌；歌單／專輯：曲目在 trackList
  const list = Array.isArray(entity.trackList) && entity.trackList.length
    ? entity.trackList
    : [{ title: entity.title || entity.name, subtitle: (entity.artists || []).map(a => a.name).join(', ') }];

  const tracks = [];
  for (const t of list.slice(0, MAX_TRACKS)) {
    const title = String(t.title || '').trim();
    const artist = String(t.subtitle || '').trim();
    if (!title) continue;
    tracks.push({ title, artist, query: searchQuery(title, artist) });
  }
  if (!tracks.length) return null;
  return { kind: ref.kind, name: name || tracks[0].title, tracks };
}

module.exports = { isSpotifyUrl, resolve, parseRef, MAX_TRACKS };
