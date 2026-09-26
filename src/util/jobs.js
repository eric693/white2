// ---- 排程工作的事件迴圈讓步 ----
//
// better-sqlite3 是同步的：排程一次把幾百位玩家的結算跑完，這段期間整個 event loop
// 完全停住 —— Discord 的心跳送不出去（會斷線重連），玩家剛按下的按鈕也排不進來。
// 超過 Discord 的 3 秒回應期限，那個互動的 token 就失效了，玩家看到的是
// 「應用程式沒有回應」（錯誤記錄裡的 Unknown interaction），而且完全不知道為什麼。
//
// 解法不是把查詢變快（單筆查詢本來就只有零點幾毫秒），而是「不要一口氣跑完」：
// 每做滿 SLICE_MS 就讓出一次 event loop，讓 Discord 的事件插得進來，做完再繼續。
// 總時間幾乎不變（讓步本身只花微秒），但最長一次連續阻塞從幾百毫秒降到一個切片。
//
// 為什麼是 setImmediate 而不是 setTimeout(0)：setImmediate 排在 I/O 回呼之後，
// 剛好讓已經到達的 Discord 封包先被處理完，再回來做下一段。
const SLICE_MS = 40;
// 單一項目做超過這個時間就記一筆：切片只能在項目之間讓步，項目本身太大就是元凶
const SLOW_ITEM_MS = 400;

const yieldToLoop = () => new Promise(resolve => setImmediate(resolve));

/**
 * 把一個大迴圈拆成小段跑。fn 可以是同步或非同步。
 * 每累積超過 slice 毫秒就讓出一次 event loop。
 */
async function eachSlice(items, fn, { slice = SLICE_MS, label = '', describe = null } = {}) {
  let since = Date.now();
  for (const item of items) {
    const started = Date.now();
    await fn(item);
    // 一個項目就做超過 SLOW_ITEM_MS 的話，切片救不了它（讓步只發生在項目之間）——
    // 記一筆才查得出是哪個玩家、哪個區域把機器人卡住。
    const spent = Date.now() - started;
    if (spent >= SLOW_ITEM_MS) {
      try {
        const what = describe ? describe(item) : (typeof item === 'object' ? JSON.stringify(item).slice(0, 120) : String(item));
        require('../db').logError('', '排程單項過久：', `${label || '排程'}｜${what}｜${spent}ms`);
      } catch {}
    }
    if (Date.now() - since >= slice) {
      await yieldToLoop();
      since = Date.now();
    }
  }
}

// ---- 目前正在跑的排程工作 ----
// 卡頓偵測本來只記「停了幾毫秒」與「當下有哪些互動在處理中」，但那些互動是
// 「被卡住的受害者」，不是元凶 —— 記錄看起來像是 /種植 很慢，其實是別的排程
// 在同一時間佔住迴圈。這裡記下當下在跑哪個排程，卡頓時就直接指名。
let current = null;

/**
 * 包住一個排程工作：標記名稱 → 執行 → 清掉。
 *
 * 這裡吞掉例外是刻意的：node-cron 不會 await 回呼，所以排程裡漏出來的例外會變成
 * unhandledRejection（在別的地方以無頭錯誤的樣子出現，看不出是哪個排程）。
 * 排程工作該有的行為本來就是「這輪失敗就記一筆，下一輪再來」，
 * 所以在這裡記下是哪個工作出事並往下走，不要讓它炸到外面。
 * 各排程內部原本的 try/catch 仍然是主要路徑，這只是最後一道網。
 */
async function runJob(name, fn) {
  const prev = current;
  current = { name, at: Date.now() };
  try {
    return await fn();
  } catch (e) {
    try { require('../db').logError('', '排程工作失敗：', `${name} —— ${e && e.message ? e.message : e}`); } catch {}
    return undefined;
  } finally {
    current = prev;
  }
}

/** 卡頓偵測用：現在在跑哪個排程工作（沒有就回 null） */
function currentJob() {
  return current ? `${current.name}（已跑 ${Date.now() - current.at}ms）` : null;
}

module.exports = { eachSlice, yieldToLoop, runJob, currentJob, SLICE_MS, SLOW_ITEM_MS };
